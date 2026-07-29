import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ENV } from "./config.js";
import {
  audioPerformanceForGeneration,
  audioPerformanceIssues,
  audioPerformanceSequenceForPlan,
  defaultAudioModeForScene,
  stableAudioPerformanceForPlan,
  type AudioPerformanceSettings,
} from "./audioPerformance.js";
import type { ProjectContext } from "./context.js";
import {
  explicitQuotedSpeechLines,
  inferCreativeIntent,
  META_NARRATION_DIRECTION,
  validatePlanForCreativeIntent,
  VIDEO_VIBE_RULES,
} from "./creativeDecision.js";
import { classifyMagicHourRequest } from "./magicHourCapabilities.js";
import {
  anyEmbeddedAudio,
  generateImageAsset,
  generateImageFallbackVideoAsset,
  generateStandaloneImageAssets,
  generateSceneVoiceovers,
  generateSectionVoiceovers,
  generateTalkingClip,
  generateVideoAsset,
  generateVideoAssetsBatch,
  generateVoiceoverAsset,
  combineSectionVoiceovers,
  providerErrorMessage,
  providerJobFailureMetadata,
  probeMediaDuration,
  probeMediaStreamDurations,
  recoverVideoAssetFromProviderJob,
  stitchAssets,
  stitchMixedAssets,
  stitchTimelineAssets,
  stitchAssetsPerSection,
  type PerSectionScene,
  type RecoverVideoAssetJob,
  type SectionVoiceover,
  type VideoAsset,
} from "./media.js";
import { inputMediaPath } from "./inputMedia.js";
import { boolSetting, inferYoutubeOutputAspectRatio, requestFromProjectState } from "./projectContext.js";
import { exportYoutubeFinalVideo, PROJECT_ID_PATTERN, publicMediaPath, updateProjectStatus, withMediaUrl } from "./projects.js";
import {
  countSpokenWords,
  compactSpokenSentences,
  explicitTargetFinalDurationSeconds,
  estimateTtsWordsPerSecondForContext,
  fishAudioExpressionCues,
  normalizeYoutubeSectionsForProject,
  requestForbidsDeadAir,
} from "./prompts.js";
import {
  appendProjectDecision,
  artifactPath,
  clearSceneFailures,
  orderedSceneAssets,
  readJsonArtifact,
  readProjectState,
  recordSceneFailures,
  removeJsonArtifact,
  updateProjectState,
  upsertSceneAssets,
  writeJsonArtifact,
} from "./renderState.js";
import {
  causalGeometryGuidance,
  causalMotionInstruction,
  causalOpeningKeyframeGuidance,
  identityReferenceSceneIndex,
  realWorldStagingGuidance,
  scenePhysicsContext,
  shouldChainPreviousKeyframe,
  validateSceneContinuity,
} from "./sceneContinuity.js";
import type { JsonDict } from "./renderState.js";
import {
  MAGIC_IMAGE_MODELS,
  MAGIC_IMAGE_MODEL_RESOLUTIONS,
  MAGIC_IMAGE_RESOLUTIONS,
  MAGIC_IMAGE_STYLE_TOOLS,
  MAGIC_VIDEO_MODELS,
  MAGIC_VIDEO_MODEL_DURATIONS,
  MAGIC_VIDEO_MODEL_RESOLUTIONS,
  VideoPlanSchema,
  type CreateProjectRequest,
  type Scene,
  type SceneNarrationRevision,
  type VideoVibe,
  type VideoPlan,
  type YouTubeClipSection,
} from "./schemas.js";
import {
  buildTimelineFromProjectState,
  inspectTimeline,
  moveClip,
  normalizeTimeline,
  setFinalHold,
  timelineSummary,
  trimClip,
  type TimelineArtifact,
  type TimelineClip,
} from "./timeline.js";
import { readTimingEvents, summarizeTimingEvents, withTiming } from "./timings.js";
import { pendingTokenOutputForContext } from "./usageCost.js";
import {
  elevenLabsVoiceNameForPlan,
  humeVoiceDescriptionForPlan,
  normalizePlanVoice,
  resolvePlanVoiceKey,
  resolveVoiceReferenceId,
  voiceContinuityIssues,
} from "./voices.js";
import { downloadYoutubeClipAssets } from "./youtubeShort.js";

function voiceContextForPlan(ctx: ProjectContext, plan: VideoPlan): ProjectContext {
  if (ctx.audio_provider === "hume") {
    return {
      ...ctx,
      hume_voice_description: humeVoiceDescriptionForPlan(plan, ctx.hume_voice_description),
    };
  }
  if (ctx.audio_provider === "elevenlabs" && !ctx.elevenlabs_voice_id) {
    return { ...ctx, elevenlabs_voice_name: elevenLabsVoiceNameForPlan(plan) };
  }
  return ctx;
}

export function normalizePlan(plan: VideoPlan): VideoPlan {
  const visualBible = plan.visual_bible.split(/\s+/).filter(Boolean).join(" ");
  const scenes = plan.scenes.map((scene, index) => {
    const requiredSubjects = scene.continuity.required_subjects.map((subject) =>
      subject.split(/\s+/).filter(Boolean).join(" "),
    );
    const imagePrompt = scene.image_prompt
      .split(/\s+/)
      .filter(Boolean)
      .join(" ")
      .replace(/\s+Required visible subjects in this single keyframe:[^.]*\.\s*$/i, "")
      .trim();
    return {
      ...scene,
      id: `scene_${index + 1}`,
      narration: scene.narration.replace(/^\s*(?:\[[^\]]+\]\s*)+/, "").split(/\s+/).filter(Boolean).join(" "),
      image_prompt:
        requiredSubjects.length > 0
          ? `${imagePrompt} Required visible subjects in this single keyframe: ${requiredSubjects.join("; ")}.`
          : imagePrompt,
      video_prompt: scene.video_prompt.split(/\s+/).filter(Boolean).join(" "),
      continuity: {
        ...scene.continuity,
        story_beat: scene.continuity.story_beat.split(/\s+/).filter(Boolean).join(" "),
        required_subjects: requiredSubjects,
        opening_state: scene.continuity.opening_state.split(/\s+/).filter(Boolean).join(" "),
        closing_state: scene.continuity.closing_state.split(/\s+/).filter(Boolean).join(" "),
        setting: scene.continuity.setting.split(/\s+/).filter(Boolean).join(" "),
      },
      audio_mode: defaultAudioModeForScene(scene, plan, index),
    };
  });
  return normalizePlanVoice({ ...plan, visual_bible: visualBible, scenes, narration: narrationFromScenes(scenes, plan.narration) });
}

function narrationFromScenes(scenes: Scene[], fallback = ""): string {
  const fromScenes = scenes
    .map((scene) => scene.narration.replace(/^\s*(?:\[[^\]]+\]\s*)+/, "").split(/\s+/).filter(Boolean).join(" "))
    .filter(Boolean)
    .join("\n\n");
  if (fromScenes) return fromScenes;
  return fallback.replace(/^\s*(?:\[[^\]]+\]\s*)+/, "").split(/\s+/).filter(Boolean).join(" ");
}

function preserveExplicitOpeningSpeech(plan: VideoPlan, request: CreateProjectRequest | null): VideoPlan {
  if (!request || !/\b(?:open|start|begin)\b[\s\S]{0,180}\b(?:say|says|narration|voiceover|spoken line)\b/i.test(request.prompt)) {
    return plan;
  }
  const required = explicitQuotedSpeechLines(request.prompt)[0];
  const first = plan.scenes[0];
  if (!required || !first) return plan;
  const normalize = (value: string) =>
    value.toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, " ").replace(/\s+/g, " ").trim();
  if (normalize(plan.narration).includes(normalize(required))) return plan;
  const scenes = plan.scenes.map((scene, index) =>
    index === 0 ? { ...scene, narration: required } : scene,
  );
  return { ...plan, scenes, narration: narrationFromScenes(scenes, plan.narration) };
}

const VISUAL_LEAK_IN_NARRATION =
  /\b(camera|wide shot|close[- ]?up|b[- ]?roll|subtitle|caption|text overlay|scene shows|image prompt|video prompt|cut to)\b/i;
const UNGROUNDED_MOTION_PROMPT =
  /\b(cut to|suddenly|new scene|new location|transforms?|appears|disappears|subtitle|caption|text overlay|logo appears)\b/i;
const MULTI_PANEL_VISUAL_PROMPT =
  /\b(split[- ]?screen|multi[- ]?(?:panel|frame|view|shot)|multiple (?:panels|frames|views|shots|images|photos)|two[- ]?(?:panel|part)|three[- ]?(?:panel|part)|triptych|diptych|collage|storyboard|comic strip|contact sheet|grid layout|side[- ]?by[- ]?side|before[- ]?and[- ]?after|sequence of (?:shots|images|frames)|stacked (?:frames|photos|images|panels)|vertical panels?|horizontal panels?)\b/i;
const MULTI_PRODUCT_VISUAL_PROMPT =
  /\b(?:(?:multiple|several|many|three|four|five|different|various)\s+(?:products?|bottles?|tubes?|jars?|serums?|lamps?|shoes?|pans?|devices?|packages?|boxes?|variants?)|(?:row|lineup|array|assortment|collection)\b.{0,80}\b(?:products?|bottles?|tubes?|jars?|serums?|lamps?|shoes?|pans?|devices?|packages?|boxes?|variants?))\b/i;
const PRODUCT_OR_COMMERCIAL_PLAN =
  /\b(ad|commercial|product|demo|launch|app|tool|bottle|lamp|brand)\b/i;
const CREATOR_STYLE_PLAN =
  /\b(ugc|tiktok|reel|testimonial|founder|day[- ]?in[- ]?life|normal person|talking to camera)\b/i;
const EXPLICIT_VISIBLE_SPEECH_REQUEST =
  /\b(talking photo|lip[- ]?sync|lipsync|talking head|talk(?:ing)? to camera|speak(?:ing)? to camera|speaks? directly)\b|\b(?:creator|person|founder|avatar|character|speaker|man|woman|guy|girl|he|she|they|someone)\b.{0,64}\b(?:say|says|saying|speak|speaks|speaking|talk|talks|talking|narrate|narrates|deliver(?:s)? (?:the )?line)\b|\b(?:say|saying|speak|speaking|talking)\s+["“]/i;
const FIRST_PERSON_CREATOR_NARRATION =
  /\b(i|i'm|i’ve|i'd|my|me|we|our|you|you're|you’ve|your|honestly|okay|wait|realized|forgot|kept|needed|tried|try|actually|literally|here'?s)\b/i;
const COMPARISON_PLAN =
  /\b(compare|comparison|versus|vs\.?|before and after|old way|new way|instead of|stiff shoes?|lighter|more flexible)\b/i;
const EXPLICIT_TALKING_THROUGHOUT =
  /\b(all|every|whole|entire|full).{0,24}(talking|speaking|talk to camera|talking to camera)|\b(talking head|single speaker|avatar)\b/i;
const PROOF_BEAT =
  /\b(product|close[- ]?up|demo|use|using|apply|applying|applied|shows?|proof|result|before|after|setting|feature|screen|desk|bottle|lamp|app|tool|serum|dropper|skin|texture|glow|shoe|sole|flex|stride|pan|cooking|meal|light mode)\b/i;
const PAYOFF_BEAT =
  /\b(payoff|result|reveal|final|final video|hero shot|hero reveal|rides? into|open road|aspirational|adventure|finish(?:ed)?|focus(?:ed)?|productive|productivity|refreshed|energized|empty|cta|try|download|buy|visit|switch|start|today|now|grab|shop|order|get one|get yours|link in bio|bio link|tap the link|ending|end|better|easier|done|ready|on track|stay(?:ing)? on track|back on track|back to work|keeps? working|hydrated|hydration|hydrate|reminder|reminds?|afternoon crash|all day|routine|saved|save time|win|cozy|calm|useful|usable|desk reveal|want to be|comes together|put(?:ting)? .* together|sorted|less stress|without the stress|worth it|actually helps?|keep using|would use|fits my|fits into|morning feels|desk feels|dinner|meal)\b/i;
const GENERIC_AD_PHRASE =
  /\b(?:the whole [a-z ]{0,32}transforms?|changed everything|game[- ]?changer|say goodbye|experience the|revolutionary|seamless|elevate|unlock|best part i didn'?t expect|one thing [a-z ]{0,32}changed everything)\b/gi;
const LONG_UGC_MIN_WORDS_PER_SECOND = 1.9;
const HUME_30_TO_70_WORDS_PER_SECOND = 3.18;
const NARRATED_VIDEO_MIN_VOICE_COVERAGE_RATIO = 0.9;
const NARRATED_VIDEO_MAX_VISUAL_ROOM_SECONDS = 2.5;
const MAX_ESTIMATED_VOICEOVER_OVERRUN_RATIO = 1.06;
const MAX_ESTIMATED_VOICEOVER_OVERRUN_SECONDS = 2.0;
const SCENE_AUDIO_OVERRUN_RATIO = 1.15;
const SCENE_AUDIO_OVERRUN_SECONDS = 2.25;
const SCENE_AUDIO_ESTIMATE_EPSILON_SECONDS = 0.75;
const PLAN_AUDIO_MIN_COVERAGE_EPSILON_SECONDS = 1.5;
const MIN_BROLL_SPEECH_COVERAGE_RATIO = 0.55;
const MIN_BROLL_SPEECH_SECONDS = 4.5;
const MAX_SHORT_BROLL_SILENCE_SECONDS = 2.0;
const MIN_RUNTIME_COVERAGE_RATIO = 0.95;
const RUNTIME_COVERAGE_EPSILON_SECONDS = 1;
const MAX_DRAFT_VIDEO_PLAN_REPAIR_FAILURES = 1;
const MAX_REPAIR_INTRODUCED_REGRESSION_FAILURES = 2;

function planIssueFamily(issue: string): string {
  if (/under-scripted|spoken words|narration|voiceover|speech/i.test(issue)) return "spoken_script";
  if (/opening state|closing state|continuity|geometry|fall|catch|landing|collision|screen direction/i.test(issue)) {
    return "physical_continuity";
  }
  if (/duration|runtime|seconds/i.test(issue)) return "runtime";
  if (/image|keyframe|visual|subject|object|split|collage/i.test(issue)) return "visual_prompt";
  return issue.toLowerCase().replace(/\bscene_\d+\b/g, "scene").split(/[.:;]/, 1)[0]!.trim();
}

export function repairIntroducedOnlyNewIssueFamilies(
  previousIssues: string[],
  currentIssues: string[],
): boolean {
  if (previousIssues.length === 0 || currentIssues.length === 0) return false;
  const previousFamilies = new Set(previousIssues.map(planIssueFamily));
  const currentFamilies = new Set(currentIssues.map(planIssueFamily));
  return currentFamilies.size <= 2 && [...currentFamilies].every((family) => !previousFamilies.has(family));
}
const HUME_SENTENCE_PAUSE_SECONDS = 0.38;
const HUME_COMMA_PAUSE_SECONDS = 0.12;
const HUME_LONG_PAUSE_SECONDS = 0.65;
const PRODUCT_DEMO_ACTION =
  /\b(use|using|demo|demonstrat|proof|result|before|after|remind|reminder|glow|alert|notification|sip|drink|hydrate|pick(?:s|ing)? up|tap|open|adjust|charge|charging|brightness|setting|screen|workflow|fix(?:es|ing)?|apply|applying|studying|working|typing|tracking)\b/i;
const STATIC_PRODUCT_SHOWCASE =
  /\b(showcas(?:e|ing)|beauty shot|hero shot|logo|design details?|sleek and stylish|glimmer(?:s|ing)?|glisten(?:s|ing)?|product sitting|product on (?:the )?(?:desk|table|counter))\b/i;
const NON_NARRATED_REQUEST =
  /\b(no voiceover|no narration|without narration|music only|mostly visual|visual only|ambient only|silent (?:video|film|edit))\b/i;
const NARRATED_REQUEST =
  /\b(narrat(?:e|ed|ion|or)?|voice[- ]?over|script|say|talk(?:ing)?|speak(?:ing)?|ugc|tik ?tok|reel|ad|commercial|product video|testimonial|founder story|tutorial|explainer|story)\b/i;
function normalizeOnCameraSceneChoices(plan: VideoPlan): VideoPlan {
  const scenes = plan.scenes.map((scene) => {
    if (scene.on_camera !== true) return scene;
    const words = countSpokenWords(scene.narration);
    if (words >= 4 && FIRST_PERSON_CREATOR_NARRATION.test(scene.narration)) return scene;
    return { ...scene, on_camera: false };
  });
  return { ...plan, scenes };
}

function explicitlyRequestsVisibleSpeech(request: CreateProjectRequest | null): boolean {
  if (!request) return true;
  return EXPLICIT_VISIBLE_SPEECH_REQUEST.test(String(request.prompt ?? ""));
}

function normalizeOnCameraIntent(plan: VideoPlan, request: CreateProjectRequest | null): VideoPlan {
  if (explicitlyRequestsVisibleSpeech(request)) return plan;
  if (!plan.scenes.some((scene) => scene.on_camera === true)) return plan;
  const scenes = plan.scenes.map((scene) =>
    scene.on_camera === true
      ? {
          ...scene,
          on_camera: false,
          video_prompt:
            scene.video_prompt && !/talking photo|none/i.test(scene.video_prompt)
              ? scene.video_prompt
              : "Subtle handheld phone movement while the creator naturally reacts near the product; no speaking or lip-sync.",
        }
      : scene,
  );
  return { ...plan, scenes };
}

function normalizeDenseSceneNarration(plan: VideoPlan, ctx: ProjectContext): VideoPlan {
  let changed = false;
  const wordsPerSecond = estimateTtsWordsPerSecondForContext(ctx, plan.voice);
  const scenes = plan.scenes.map((scene) => {
    const words = countSpokenWords(scene.narration);
    if (words === 0) return scene;
    const densityCap = Math.max(7, Math.floor(scene.duration_seconds * 3.4));
    const speechCap = Math.max(
      7,
      Math.floor(Math.max(1, maxAllowedSceneSpeechSeconds(scene.duration_seconds) - SCENE_AUDIO_ESTIMATE_EPSILON_SECONDS) * wordsPerSecond * 0.82),
    );
    const maxWords = Math.min(densityCap, speechCap);
    if (words <= maxWords + 2) return scene;
    changed = true;
    return { ...scene, narration: compactSpokenSentences(scene.narration, maxWords) };
  });
  if (!changed) return plan;
  return {
    ...plan,
    scenes,
    narration: scenes.map((scene) => scene.narration.trim()).filter(Boolean).join("\n\n"),
  };
}

function isBlockingPlanIssue(issue: string): boolean {
  return !(
    /^creative_vibe .* (?:does not fit|is not reflected)/i.test(issue) ||
    /on-camera narration should sound first-person and creator-native/i.test(issue)
  );
}

function sentenceFragments(text: string): string[] {
  return text
    .split(/[.!?]+/)
    .map((part) => part.replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase())
    .filter(Boolean);
}

function endsWithBrokenSpokenFragment(text: string): boolean {
  const cleaned = text.replace(/[.!?]+$/g, "").trim().toLowerCase();
  if (!cleaned) return false;
  const lastSentence = cleaned.split(/[.!?]+/).map((part) => part.trim()).filter(Boolean).pop() ?? cleaned;
  const words = lastSentence.split(/\s+/).filter(Boolean);
  const lastWord = words.at(-1) ?? "";
  if (
    new Set([
      "a",
      "an",
      "the",
      "and",
      "or",
      "but",
      "so",
      "because",
      "with",
      "without",
      "to",
      "for",
      "from",
      "of",
      "in",
      "on",
      "at",
      "by",
      "your",
      "youre",
      "you're",
      "im",
      "i'm",
      "ive",
      "i've",
    ]).has(lastWord)
  ) {
    return true;
  }
  return false;
}

function humePauseBudgetSeconds(text: string): number {
  const sentenceBreaks = text.match(/[.!?](?=\s|$)/g)?.length ?? 0;
  const commas = text.match(/[,;:](?=\s|$)/g)?.length ?? 0;
  const longPauses = text.match(/\[(?:long\s+)?pause\]/gi)?.length ?? 0;
  const spokenBreaks = Math.max(0, sentenceBreaks - 1);
  return (
    spokenBreaks * HUME_SENTENCE_PAUSE_SECONDS +
    commas * HUME_COMMA_PAUSE_SECONDS +
    longPauses * HUME_LONG_PAUSE_SECONDS
  );
}

function maxAllowedVoiceoverSeconds(targetSeconds: number): number {
  return round3(Math.max(targetSeconds * MAX_ESTIMATED_VOICEOVER_OVERRUN_RATIO, targetSeconds + MAX_ESTIMATED_VOICEOVER_OVERRUN_SECONDS));
}

function maxAllowedSceneSpeechSeconds(sceneSeconds: number): number {
  return round3(Math.max(sceneSeconds * SCENE_AUDIO_OVERRUN_RATIO, sceneSeconds + SCENE_AUDIO_OVERRUN_SECONDS));
}

function minBrollSpeechSeconds(sceneSeconds: number): number {
  return round3(Math.max(MIN_BROLL_SPEECH_SECONDS, sceneSeconds * MIN_BROLL_SPEECH_COVERAGE_RATIO));
}

function measuredRejectedVoicePace(ctx: ProjectContext): number | null {
  const state = readProjectState(ctx);
  const measuredFailure = [...(state.decisions ?? [])].reverse().find(
    (decision: JsonDict) =>
      decision.tool === "generate_voiceover" &&
      decision.metadata?.validation_failed === true &&
      Number(decision.metadata?.word_count) > 0 &&
      Number(decision.metadata?.duration_seconds) > 0,
  );
  if (measuredFailure) {
    const measured = Number(measuredFailure.metadata.word_count) / Number(measuredFailure.metadata.duration_seconds);
    if (Number.isFinite(measured) && measured >= 1.6 && measured <= 3.6) return measured;
  }
  return null;
}

function coverageWordsPerSecond(ctx: ProjectContext): number {
  const measured = measuredRejectedVoicePace(ctx);
  if (measured !== null) return measured;
  if (ctx.audio_provider === "hume") return HUME_30_TO_70_WORDS_PER_SECOND;
  return estimateTtsWordsPerSecondForContext(ctx);
}

function coverageWordsPerSecondForPlan(ctx: ProjectContext, plan: VideoPlan): number {
  const measured = measuredRejectedVoicePace(ctx);
  if (measured !== null) return measured;
  const base = coverageWordsPerSecond(ctx);
  if (
    (ctx.audio_provider === "hume" || ctx.audio_provider === "elevenlabs") &&
    !plan.scenes.some((scene) => scene.on_camera === true)
  ) {
    return base * stableAudioPerformanceForPlan(plan).speed;
  }
  return base;
}

function minimumNarratedSpeechSeconds(targetSeconds: number): number {
  return round3(
    Math.max(
      targetSeconds * NARRATED_VIDEO_MIN_VOICE_COVERAGE_RATIO,
      targetSeconds - NARRATED_VIDEO_MAX_VISUAL_ROOM_SECONDS,
    ),
  );
}

function minimumNarratedSpeechSecondsForRequest(
  targetSeconds: number,
  request: CreateProjectRequest | null,
): number {
  if (!requestForbidsDeadAir(request)) {
    return minimumNarratedSpeechSeconds(targetSeconds);
  }
  return round3(Math.max(targetSeconds * 0.97, targetSeconds - 1));
}

function minimumNarratedSpokenWords(
  targetSeconds: number,
  ctx: ProjectContext,
  request: CreateProjectRequest | null = null,
  plan: VideoPlan | null = null,
): number {
  const wordsPerSecond = plan
    ? coverageWordsPerSecondForPlan(ctx, plan)
    : coverageWordsPerSecond(ctx);
  return Math.ceil(minimumNarratedSpeechSecondsForRequest(targetSeconds, request) * wordsPerSecond);
}

function expectsNarratedVideoCoverage(plan: VideoPlan, request: CreateProjectRequest | null): boolean {
  const requestText = String(request?.prompt ?? "");
  const planText = [requestText, plan.title, plan.creative_vibe, plan.visual_bible, plan.narration].join(" ");
  if (NON_NARRATED_REQUEST.test(planText)) return false;
  const narratedScenes = plan.scenes.filter((scene) => countSpokenWords(scene.narration) > 0).length;
  if (narratedScenes === 0) return false;
  if (NARRATED_REQUEST.test(planText)) return true;
  return countSpokenWords(plan.narration) >= 20 && narratedScenes >= Math.ceil(plan.scenes.length / 2);
}

export function estimateSceneSpeechSeconds(scene: Scene, plan: VideoPlan, ctx: ProjectContext): number {
  const words = countSpokenWords(scene.narration);
  if (words === 0) return 0;
  const sceneIndex = plan.scenes.findIndex((item) => item.id === scene.id);
  const sequencePerformance =
    (ctx.audio_provider === "hume" || ctx.audio_provider === "elevenlabs") && sceneIndex >= 0
      ? audioPerformanceSequenceForPlan(plan.scenes, plan)[sceneIndex]
      : null;
  return estimateSceneSpeechSecondsWithPerformance(scene, plan, ctx, sequencePerformance ?? undefined);
}

function estimateSceneSpeechSecondsWithPerformance(
  scene: Scene,
  plan: VideoPlan,
  ctx: ProjectContext,
  performanceOverride?: AudioPerformanceSettings,
  includeTrailingSilence = true,
): number {
  const words = countSpokenWords(scene.narration);
  if (words === 0) return 0;
  const baseWordsPerSecond = estimateTtsWordsPerSecondForContext(ctx, plan.voice);
  const performance = performanceOverride ?? audioPerformanceForGeneration(scene, plan);
  const speedMultiplier = ctx.audio_provider === "hume" || ctx.audio_provider === "elevenlabs" ? performance.speed : 1;
  const effectiveWordsPerSecond = Math.max(1.05, baseWordsPerSecond * speedMultiplier);
  const pauseBudget = ctx.audio_provider === "hume" ? humePauseBudgetSeconds(scene.narration) : 0;
  const trailingSilence = includeTrailingSilence && ctx.audio_provider === "hume" ? performance.trailing_silence : 0;
  return round3(words / effectiveWordsPerSecond + pauseBudget + trailingSilence);
}

function estimateSceneSpokenContentSeconds(scene: Scene, plan: VideoPlan, ctx: ProjectContext): number {
  const sceneIndex = plan.scenes.findIndex((item) => item.id === scene.id);
  const sequencePerformance =
    (ctx.audio_provider === "hume" || ctx.audio_provider === "elevenlabs") && sceneIndex >= 0
      ? audioPerformanceSequenceForPlan(plan.scenes, plan)[sceneIndex]
      : null;
  return estimateSceneSpeechSecondsWithPerformance(scene, plan, ctx, sequencePerformance ?? undefined, false);
}

export function estimatePlanSpeechSeconds(
  plan: VideoPlan,
  ctx: ProjectContext,
  targetSpeechSeconds?: number,
): number {
  const measuredPace = measuredRejectedVoicePace(ctx);
  if (measuredPace !== null) {
    return round3(countSpokenWords(plan.narration) / measuredPace);
  }
  if (ctx.audio_provider === "hume" || ctx.audio_provider === "elevenlabs") {
    if (!plan.scenes.some((scene) => scene.on_camera === true)) {
      const performance = stableAudioPerformanceForPlan(plan);
      const effectiveWordsPerSecond = Math.max(
        1.05,
        estimateTtsWordsPerSecondForContext(ctx, plan.voice) * performance.speed,
      );
      return round3(countSpokenWords(plan.narration) / effectiveWordsPerSecond);
    }
    const performances = audioPerformanceSequenceForPlan(plan.scenes, plan, {
      targetSpeechSeconds,
      wordsPerSecond: estimateTtsWordsPerSecondForContext(ctx, plan.voice),
    });
    return round3(
      plan.scenes.reduce(
        (sum, scene, index) => sum + estimateSceneSpeechSecondsWithPerformance(scene, plan, ctx, performances[index]),
        0,
      ),
    );
  }
  const words = countSpokenWords(plan.narration);
  const wordsPerSecond = estimateTtsWordsPerSecondForContext(ctx, plan.voice);
  return round3(words / Math.max(1.05, wordsPerSecond));
}

function genericAdPhraseCount(text: string): number {
  return [...text.matchAll(GENERIC_AD_PHRASE)].length;
}

export function validatePlanAudioDurationFit(
  plan: VideoPlan,
  request: CreateProjectRequest,
  ctx: ProjectContext,
): string[] {
  const target = explicitTargetFinalDurationSeconds(request);
  if (target === null) return [];
  const issues: string[] = [];
  const allowedTotal = maxAllowedVoiceoverSeconds(target);
  const expectedCoverage = expectsNarratedVideoCoverage(plan, request);
  const minimumSpeech = expectedCoverage ? minimumNarratedSpeechSecondsForRequest(target, request) : undefined;
  const estimatedTotal = estimatePlanSpeechSeconds(plan, ctx, minimumSpeech);
  if (estimatedTotal > allowedTotal) {
    const rateTarget = Math.floor(allowedTotal * coverageWordsPerSecondForPlan(ctx, plan) * 0.97);
    const currentWords = countSpokenWords(plan.narration);
    const measuredEstimateTarget = Math.floor(currentWords * (allowedTotal / estimatedTotal) * 0.97);
    const safeWordTarget = Math.max(8, Math.min(rateTarget, measuredEstimateTarget));
    issues.push(
      `Estimated ${ctx.audio_provider} voiceover is ${estimatedTotal.toFixed(1)}s for a ${target}s target ` +
        `(max ${allowedTotal.toFixed(1)}s). Condense the spoken script to about ${safeWordTarget} words, ` +
        "merge choppy sentence fragments, or move detail into silent visual proof before provider calls.",
    );
  }

  if (expectedCoverage && minimumSpeech !== undefined) {
    const minWords = minimumNarratedSpokenWords(target, ctx, request, plan);
    const spokenWords = countSpokenWords(plan.narration);
    const missesEstimatedDuration =
      estimatedTotal + PLAN_AUDIO_MIN_COVERAGE_EPSILON_SECONDS < minimumSpeech;
    if (missesEstimatedDuration) {
      issues.push(
        `Narrated ${ctx.audio_provider} plan is under-scripted for ${target}s: estimated speech is ` +
          `${estimatedTotal.toFixed(1)}s, minimum ${minimumSpeech.toFixed(1)}s. ` +
          `Current script has ${spokenWords} words; write about ${minWords}+ natural spoken words or shorten the requested runtime before provider calls.`,
      );
    }
  }

  for (const scene of plan.scenes) {
    const estimatedScene = estimateSceneSpeechSeconds(scene, plan, ctx);
    const allowedScene = maxAllowedSceneSpeechSeconds(scene.duration_seconds);
    if (estimatedScene > allowedScene + SCENE_AUDIO_ESTIMATE_EPSILON_SECONDS) {
      const maxWords = Math.max(
        4,
        Math.floor(countSpokenWords(scene.narration) * (allowedScene / estimatedScene) * 0.95),
      );
      issues.push(
        `${scene.id} narration is estimated at ${estimatedScene.toFixed(1)}s but the scene is ` +
          `${scene.duration_seconds}s (max ${allowedScene.toFixed(1)}s and about ${maxWords} words). ` +
          `Shorten this scene to at most ${maxWords} spoken words, redistribute its extra detail into another scene, ` +
          "or increase that scene duration without changing the requested total runtime.",
      );
    }
  }

  const phraseCount = genericAdPhraseCount(plan.narration);
  if (phraseCount >= 2) {
    issues.push("Narration uses too many generic ad phrases; rewrite with concrete product moments and human specifics.");
  }
  const fragments = sentenceFragments(plan.narration);
  for (let index = 1; index < fragments.length; index++) {
    if (fragments[index] === fragments[index - 1]) {
      issues.push("Narration repeats the same sentence consecutively; remove the duplicate before rendering.");
      break;
    }
  }
  return issues;
}

export function validateSceneSpeechAndVisualCoverage(
  plan: VideoPlan,
  request: CreateProjectRequest,
  ctx: ProjectContext,
): string[] {
  const target = explicitTargetFinalDurationSeconds(request);
  const planText = [
    request.prompt,
    plan.title,
    plan.narration,
    plan.visual_bible,
    plan.creative_vibe,
  ].join(" ");
  const mixedPerSceneAudio = plan.scenes.some((scene) => scene.on_camera === true);
  const needsTightProductCoverage =
    mixedPerSceneAudio && (target ?? planDurationSeconds(plan)) >= 30 && PRODUCT_OR_COMMERCIAL_PLAN.test(planText);
  if (!needsTightProductCoverage) return [];

  const issues: string[] = [];
  for (const scene of plan.scenes) {
    const words = countSpokenWords(scene.narration);
    const scenePrompt = `${scene.narration} ${scene.image_prompt} ${scene.video_prompt}`;
    if (scene.on_camera === true) {
      const estimatedSpeech = estimateSceneSpeechSeconds(scene, plan, ctx);
      const minimumSpeech = Math.max(2.5, scene.duration_seconds * 0.82);
      if (words > 0 && scene.duration_seconds >= 5 && estimatedSpeech + SCENE_AUDIO_ESTIMATE_EPSILON_SECONDS < minimumSpeech) {
        const wordsPerSecond = estimateTtsWordsPerSecondForContext(ctx, plan.voice);
        const minWords = Math.max(words + 3, Math.ceil(minimumSpeech * wordsPerSecond * 0.95));
        const maxWords = Math.max(
          minWords + 2,
          Math.floor(maxAllowedSceneSpeechSeconds(scene.duration_seconds) * wordsPerSecond * 0.88),
        );
        const shorterDuration = Math.max(5, Math.ceil(estimatedSpeech + 0.9));
        issues.push(
          `${scene.id} has only about ${estimatedSpeech.toFixed(1)}s of voice for a ${scene.duration_seconds}s on-camera scene. ` +
            `Usually shorten that talking scene to about ${shorterDuration}s, or rewrite the line to about ${minWords}-${maxWords} complete natural spoken words before rendering.`,
        );
      }
      continue;
    }
    if (words > 0 && scene.duration_seconds >= 10) {
      const estimatedSpeech = estimateSceneSpeechSeconds(scene, plan, ctx);
      const minimumSpeech = minBrollSpeechSeconds(scene.duration_seconds);
      if (estimatedSpeech + SCENE_AUDIO_ESTIMATE_EPSILON_SECONDS < minimumSpeech) {
        const wordsPerSecond = estimateTtsWordsPerSecondForContext(ctx, plan.voice);
        const minWords = Math.max(words + 3, Math.ceil(minimumSpeech * wordsPerSecond * 0.95));
        const maxWords = Math.max(
          minWords + 2,
          Math.floor(maxAllowedSceneSpeechSeconds(scene.duration_seconds) * wordsPerSecond * 0.9),
        );
        issues.push(
          `${scene.id} has only about ${estimatedSpeech.toFixed(1)}s of voice for a ${scene.duration_seconds}s b-roll scene. ` +
            `Rewrite that b-roll narration to about ${minWords}-${maxWords} natural spoken words tied to the visual proof, ` +
            "split it into shorter proof beats, or shorten the scene before rendering; do not leave long silent padding after the line.",
        );
      }
    }
    if (
      scene.duration_seconds >= 10 &&
      STATIC_PRODUCT_SHOWCASE.test(scenePrompt) &&
      !PRODUCT_DEMO_ACTION.test(scenePrompt)
    ) {
      issues.push(
        `${scene.id} is a static product showcase instead of a story/proof beat; make the image/video prompts show visible use, reminder, result, or product action tied to the narration.`,
      );
    }
  }
  return issues;
}

export function validateProductionVideoPlan(plan: VideoPlan, request: CreateProjectRequest | null = null): string[] {
  const issues: string[] = [];
  const totalDuration = planDurationSeconds(plan);
  const requestedDuration = request ? explicitTargetFinalDurationSeconds(request) : null;
  const planningDuration = requestedDuration ?? totalDuration;
  const scenes = plan.scenes;
  const planText = [plan.title, plan.narration, plan.visual_bible, ...scenes.flatMap((scene) => [
    scene.narration,
    scene.image_prompt,
    scene.video_prompt,
  ])].join(" ");
  const requestText = String(request?.prompt ?? "");
  const isNonCommercialStoryRequest =
    /\b(story|historical|history|documentary|narrative|short film|movie)\b/i.test(requestText) &&
    !/\b(ad|advert|commercial|product|service|brand|campaign|sell|conversion|cta)\b/i.test(requestText);

  scenes.forEach((scene) => {
    const words = countSpokenWords(scene.narration);
    const maxWords = Math.max(7, Math.floor(scene.duration_seconds * 3.4));
    if (words > maxWords + 4) {
      issues.push(
        `${scene.id} narration is too dense for ${scene.duration_seconds}s (${words} words, max ${maxWords}).`,
      );
    }
    if (VISUAL_LEAK_IN_NARRATION.test(scene.narration)) {
      issues.push(`${scene.id} narration contains visual/camera instructions; move those to image_prompt or video_prompt.`);
    }
    if (META_NARRATION_DIRECTION.test(scene.narration)) {
      issues.push(`${scene.id} narration contains meta planning language; rewrite it as words a real person would say aloud.`);
    }
    if (endsWithBrokenSpokenFragment(scene.narration)) {
      issues.push(`${scene.id} narration appears to end mid-thought; rewrite it as complete spoken sentence(s).`);
    }
    if (UNGROUNDED_MOTION_PROMPT.test(scene.video_prompt)) {
      issues.push(`${scene.id} video_prompt asks for cuts, new objects, text, or ungrounded motion.`);
    }
    if (MULTI_PANEL_VISUAL_PROMPT.test(scene.image_prompt)) {
      issues.push(
        `${scene.id} image_prompt asks for a split-screen, collage, storyboard, or multiple views; use one full-frame keyframe and move comparisons or sequences into separate scenes.`,
      );
    }
    if (MULTI_PRODUCT_VISUAL_PROMPT.test(scene.image_prompt)) {
      issues.push(
        `${scene.id} image_prompt asks for multiple competing product instances; use one primary product instance unless the user explicitly requested a product lineup.`,
      );
    }
  });

  if (scenes.filter((scene) => scene.duration_seconds < 3).length > 1) {
    issues.push("Use at most one sub-3s scene; the remaining beats need enough time to read clearly.");
  }
  if (planningDuration >= 16 && planningDuration <= 30 && scenes.length > 8) {
    issues.push("A 16-30s video may use at most 8 purposeful scenes; let story complexity choose below that limit.");
  }

  if (totalDuration >= 20 && PRODUCT_OR_COMMERCIAL_PLAN.test(planText) && !isNonCommercialStoryRequest) {
    if (
      request &&
      explicitlyRequestsVisibleSpeech(request) &&
      CREATOR_STYLE_PLAN.test(planText) &&
      !scenes.some((scene) => scene.on_camera === true)
    ) {
      issues.push("Visible-speaker UGC/testimonial plans need at least one on-camera talking beat.");
    }
    if (!scenes.some((scene) => PROOF_BEAT.test(`${scene.image_prompt} ${scene.video_prompt}`))) {
      issues.push("Product/commercial plans need visible proof, demo, closeup, before/after, screen, or result action.");
    }
    const endingText = scenes
      .slice(Math.max(0, scenes.length - 2))
      .map((scene) => `${scene.narration} ${scene.image_prompt} ${scene.video_prompt}`)
      .join(" ");
    if (!PAYOFF_BEAT.test(endingText)) {
      issues.push("Product/commercial plans need a clear result, reveal, payoff, or creator-native CTA in the ending.");
    }
    if (planningDuration >= 45 && CREATOR_STYLE_PLAN.test(planText) && !COMPARISON_PLAN.test(planText)) {
      const spokenWords = scenes.reduce((sum, scene) => sum + countSpokenWords(scene.narration), 0);
      const minSpokenWords = Math.floor(planningDuration * LONG_UGC_MIN_WORDS_PER_SECOND);
      const toleratedMinSpokenWords = Math.max(0, minSpokenWords - Math.max(6, Math.floor(minSpokenWords * 0.06)));
      if (spokenWords < toleratedMinSpokenWords) {
        issues.push(
          `Long UGC/product plans are under-scripted for ${planningDuration}s (${spokenWords} spoken words, min ${minSpokenWords}). Add more natural dialogue or shorten the target runtime before rendering.`,
        );
      }
    }
    if (totalDuration >= 30 && CREATOR_STYLE_PLAN.test(planText) && !EXPLICIT_TALKING_THROUGHOUT.test(planText)) {
      const talkingScenes = scenes.filter((scene) => scene.on_camera === true);
      const maxTalkingScenes = totalDuration >= 45 ? 2 : 3;
      if (talkingScenes.length > maxTalkingScenes) {
        issues.push(
          `UGC/product plans should use at most ${maxTalkingScenes} on-camera Talking Photo scenes unless the user explicitly asks for talking throughout; ` +
            `move middle proof/demo beats to b-roll voiceover to improve speed and reliability.`,
        );
      }
    }
  }

  return issues;
}

export function validatePlanRuntimeCoverage(
  plan: VideoPlan,
  request: CreateProjectRequest,
  ctx: ProjectContext,
): string[] {
  const stats = runtimeCoverageStats(plan, request, ctx);
  if (stats === null) return [];
  const { target, estimatedContentSeconds, minContentSeconds } = stats;
  const totalSceneSeconds = planDurationSeconds(plan);
  const issues: string[] = [];
  if (totalSceneSeconds < target - 1) {
    issues.push(
      `Plan scene durations total ${totalSceneSeconds}s for a ${target}s request. Add real scene time until the plan reaches the requested runtime.`,
    );
  }
  if (estimatedContentSeconds < minContentSeconds) {
    issues.push(
      `Plan is likely to render too short for ${target}s: estimated spoken/video content is ` +
        `${estimatedContentSeconds.toFixed(1)}s, minimum ${minContentSeconds.toFixed(1)}s. ` +
        "Add more natural on-camera dialogue, add product/demo b-roll, or shorten the requested runtime before provider calls.",
    );
  }
  return issues;
}

export function normalizePlanRuntimeToTarget(plan: VideoPlan, request: CreateProjectRequest, ctx: ProjectContext): VideoPlan {
  const target = explicitTargetFinalDurationSeconds(request);
  const supported = MAGIC_VIDEO_MODEL_DURATIONS[ctx.video_model];
  if (target === null || !supported || supported.size === 0) return plan;

  const planText = [request.prompt, plan.title, plan.narration, plan.creative_vibe].join(" ");
  const limitAutoBrollExpansion = PRODUCT_OR_COMMERCIAL_PLAN.test(planText);
  const maxAutoBrollDuration = limitAutoBrollExpansion ? 15 : Number.POSITIVE_INFINITY;
  const supportedDurations = [...supported].sort((a, b) => a - b);
  const preferredBrollDurations = supportedDurations.filter((duration) => duration === 5 || duration % 5 === 0);
  const brollDurationSteps = preferredBrollDurations.length > 0 ? preferredBrollDurations : supportedDurations;
  const nextSupportedAtLeast = (seconds: number) =>
    supportedDurations.find((duration) => duration >= seconds) ?? supportedDurations[supportedDurations.length - 1]!;
  const nextSupportedAbove = (seconds: number, maxDuration = Number.POSITIVE_INFINITY) =>
    supportedDurations.find((duration) => duration > seconds && duration <= maxDuration) ?? seconds;
  const speechSupportedBrollDuration = (scene: Scene, durationLimit = Number.POSITIVE_INFINITY): number => {
    if (scene.on_camera === true || countSpokenWords(scene.narration) === 0) return durationLimit;
    const estimatedSpeech = estimateSceneSpokenContentSeconds(scene, plan, ctx);
    const currentLimit = Math.min(scene.duration_seconds, durationLimit);
    const candidates = brollDurationSteps
      .filter((duration) => duration <= currentLimit)
      .filter((duration) =>
        duration < 10
          ? duration <= 5 || estimatedSpeech + MAX_SHORT_BROLL_SILENCE_SECONDS >= duration
          : estimatedSpeech + SCENE_AUDIO_ESTIMATE_EPSILON_SECONDS >= minBrollSpeechSeconds(duration),
      );
    return candidates[candidates.length - 1] ?? brollDurationSteps.find((duration) => duration <= currentLimit) ?? scene.duration_seconds;
  };
  const scenes = plan.scenes.map((scene) => ({ ...scene }));
  let mixedPerSceneAudio = scenes.some((scene) => scene.on_camera === true);

  if (limitAutoBrollExpansion && mixedPerSceneAudio && !EXPLICIT_TALKING_THROUGHOUT.test(planText)) {
    const onCameraIndexes = scenes
      .map((scene, index) => ({ scene, index }))
      .filter(({ scene }) => scene.on_camera === true)
      .map(({ index }) => index);
    const maxTalkingScenes = target >= 45 ? 2 : 3;
    if (onCameraIndexes.length > maxTalkingScenes) {
      const keep = new Set<number>();
      keep.add(onCameraIndexes[0]!);
      if (maxTalkingScenes > 1) keep.add(onCameraIndexes[onCameraIndexes.length - 1]!);
      for (const index of onCameraIndexes) {
        if (keep.size < maxTalkingScenes) keep.add(index);
      }
      for (const index of onCameraIndexes) {
        if (!keep.has(index)) scenes[index]!.on_camera = false;
      }
      mixedPerSceneAudio = scenes.some((scene) => scene.on_camera === true);
    }
  }

  for (const scene of scenes) {
    if (scene.on_camera === true || supported.has(scene.duration_seconds)) continue;
    scene.duration_seconds = nextSupportedAtLeast(scene.duration_seconds);
  }

  if (limitAutoBrollExpansion && mixedPerSceneAudio) {
    for (const scene of scenes) {
      if (scene.on_camera === true || countSpokenWords(scene.narration) === 0 || scene.duration_seconds < 10) continue;
      const maxSpeechBackedDuration = speechSupportedBrollDuration(scene);
      if (maxSpeechBackedDuration < scene.duration_seconds) scene.duration_seconds = maxSpeechBackedDuration;
    }
    if (!EXPLICIT_TALKING_THROUGHOUT.test(planText)) {
      for (const scene of scenes) {
        if (scene.on_camera !== true || countSpokenWords(scene.narration) === 0 || scene.duration_seconds <= 5) continue;
        const estimatedSpeech = estimateSceneSpokenContentSeconds(scene, { ...plan, scenes }, ctx);
        const minimumSpeech = Math.max(2.5, scene.duration_seconds * 0.82);
        if (estimatedSpeech + SCENE_AUDIO_ESTIMATE_EPSILON_SECONDS >= minimumSpeech) continue;
        const minTalkingSceneDuration = target >= 40 ? 7 : 5;
        const speechBackedDuration = Math.max(minTalkingSceneDuration, Math.ceil(estimatedSpeech + 0.9));
        if (speechBackedDuration < scene.duration_seconds) scene.duration_seconds = speechBackedDuration;
      }
    }
  }

  let total = scenes.reduce((sum, scene) => sum + scene.duration_seconds, 0);
  while (total < target - 1) {
    const index = [...scenes].reverse().findIndex(
      (scene) =>
        scene.on_camera !== true &&
        nextSupportedAbove(scene.duration_seconds, speechSupportedBrollDuration(scene, maxAutoBrollDuration)) >
          scene.duration_seconds,
    );
    if (index < 0) break;
    const scene = scenes[scenes.length - 1 - index]!;
    const next = nextSupportedAbove(scene.duration_seconds, speechSupportedBrollDuration(scene, maxAutoBrollDuration));
    if (next <= scene.duration_seconds) break;
    total += next - scene.duration_seconds;
    scene.duration_seconds = next;
  }

  const talkingShortfall = scenes.reduce((sum, scene) => {
    if (scene.on_camera !== true) return sum;
    return sum + Math.max(0, scene.duration_seconds - estimateSceneSpokenContentSeconds(scene, { ...plan, scenes }, ctx));
  }, 0);
  const maxTotal = target + Math.min(30, Math.max(10, talkingShortfall + 5));
  let coveragePlan: VideoPlan = { ...plan, scenes };
  for (let guard = 0; guard < scenes.length * supportedDurations.length; guard += 1) {
    const stats = runtimeCoverageStats(coveragePlan, request, ctx);
    if (!stats || stats.missingSeconds <= 0) break;
    const candidates = scenes
      .map((scene, index) => ({ scene, index }))
      .filter(({ scene }) =>
        scene.on_camera !== true &&
        nextSupportedAbove(scene.duration_seconds, speechSupportedBrollDuration(scene, maxAutoBrollDuration)) > scene.duration_seconds &&
        total + nextSupportedAbove(scene.duration_seconds, speechSupportedBrollDuration(scene, maxAutoBrollDuration)) - scene.duration_seconds <= maxTotal,
      )
      .sort((a, b) => a.scene.duration_seconds - b.scene.duration_seconds || a.index - b.index);
    const candidateIndex = candidates[0]?.index ?? -1;
    if (candidateIndex < 0) break;
    const scene = scenes[candidateIndex]!;
    const next = nextSupportedAbove(scene.duration_seconds, speechSupportedBrollDuration(scene, maxAutoBrollDuration));
    total += next - scene.duration_seconds;
    scene.duration_seconds = next;
    coveragePlan = { ...plan, scenes };
  }

  return { ...plan, scenes };
}

function fallbackProductName(prompt: string): string {
  const called = prompt.match(/\bcalled\s+([A-Z][A-Za-z0-9 -]{1,40})(?:[?.!,]|$)/);
  if (called?.[1]) return called[1].trim();
  const forA = prompt.match(/\bfor (?:a|an|the)\s+([A-Za-z0-9 -]{2,48})(?:\s+(?:called|named)|[?.!,]|$)/i);
  if (forA?.[1]) return forA[1].trim();
  return "the product";
}

function fallbackBrollDurations(totalSeconds: number): number[] {
  const durations: number[] = [];
  let remaining = Math.max(0, Math.trunc(totalSeconds));
  while (remaining > 0) {
    const next = remaining <= 10 ? remaining : 10;
    durations.push(next);
    remaining -= next;
  }
  return durations;
}

type FallbackPlanKind = "hydration" | "desk_lamp" | "saas_video_tool" | "generic_product";

const FALLBACK_BROLL_DETAIL_SENTENCES = [
  "which made the next step easier to follow",
  "and I noticed the difference during normal use",
  "without interrupting what I was already doing",
  "so the result felt clear without being overdone",
  "and it kept the routine moving without extra effort",
  "which made the final result feel genuinely useful",
] as const;

function fallbackBrollNarration(script: string, index: number): string {
  const base = script.trim().replace(/[.!?]+$/, "");
  return `${base}, ${FALLBACK_BROLL_DETAIL_SENTENCES[index % FALLBACK_BROLL_DETAIL_SENTENCES.length]}.`;
}

function fallbackPlanKind(prompt: string): FallbackPlanKind {
  if (/\b(water|bottle|hydration|hydrate|drink|sip)\b/i.test(prompt)) return "hydration";
  if (/\b(lamp|lighting|brightness|warm|cool|charging|desk setup|study)\b/i.test(prompt)) return "desk_lamp";
  if (/\b(saas|software|app|ai video|video tool|clip|clips|editing|edits|workflow|shot planning|retries)\b/i.test(prompt)) {
    return "saas_video_tool";
  }
  return "generic_product";
}

function fallbackCopyForKind(kind: FallbackPlanKind, product: string) {
  if (kind === "desk_lamp") {
    return {
      title: `${product} Cozy Desk Demo`,
      creativeVibe: "cozy_lifestyle" as VideoVibe,
      hook: "Trying to work in bad lighting makes the whole desk feel harder than it should.",
      payoff: `${product} makes the desk feel calmer, brighter, and worth sitting at.`,
      visualBible: `Same young adult creator at a real study desk, cozy evening apartment lighting, practical phone-shot product demo. ${product} stays visually consistent as a slim modern desk lamp with clear closeups, no readable UI text, no split-screen, and no fake overlays.`,
      brollScripts: [
        `I put ${product} on the desk and the first difference was how much softer everything looked.`,
        "The controls made it easy to dial the brightness and switch between warm study light and a cooler reading look.",
        "Then I set my phone on the base, and it kept charging while the notes stayed lit.",
        "By the end, the whole setup felt cleaner, brighter, and way easier to sit down at.",
        "It feels useful because every feature is something you notice during a normal study session.",
        "That is the difference: the desk stops feeling harsh and starts feeling like a place I want to stay.",
      ],
      imagePrompts: [
        `Vertical phone-shot before scene of a real desk in poor lighting with ${product} nearby, laptop and notebook visible, cozy apartment context.`,
        `Close product keyframe of ${product} lighting the desk, hand adjusting brightness, warm realistic glow, no readable text.`,
        `Desk demo keyframe showing ${product}'s touch controls for brightness plus warm and cool light modes, natural UGC framing, no readable text.`,
        `Closeup of a phone resting on ${product}'s charging base while the lamp lights a notebook and keyboard.`,
        `Clean final desk reveal with ${product} centered, laptop, notes, and warm organized workspace, creator slightly in background.`,
        `Creator studying comfortably at the improved desk setup with ${product} visible in foreground, cozy useful real-life feel.`,
        `Final vertical phone-shot of the creator closing the laptop beside ${product}, desk calm and bright, product clearly visible, no text overlays.`,
      ],
      videoPrompts: [
        "Small handheld drift across the dim desk before the lamp becomes the focus.",
        "Gentle push-in as the creator turns the lamp on once.",
        "Slow pan across the controls as the light changes from warm to cooler study light.",
        "Subtle handheld slide from the charging phone to the lit workspace.",
        "Slow reveal of the cleaned-up desk with the lamp glowing steadily.",
        "Soft handheld move from the creator working back to the lamp in the foreground.",
        "Gentle final push-in on the calm desk and lamp after the study session settles.",
      ],
    };
  }
  if (kind === "saas_video_tool") {
    return {
      title: `${product} Natural Workflow Demo`,
      creativeVibe: "polished_ugc" as VideoVibe,
      hook: "Making one short video should not mean bouncing between five different tools.",
      payoff: `${product} keeps the whole video workflow in one calmer place.`,
      visualBible: `Same young adult creator in a realistic creator workspace, laptop, notes, phone, and abstract editing timelines shown as non-readable interface shapes. ${product} is represented as a clean AI video tool workflow with no readable UI text, no fake app screenshots, no split-screen, and no logos added.`,
      brollScripts: [
        `Before ${product}, I would write ideas in one place, edit in another, and redo clips until the whole thing felt messy and hard to track.`,
        `${product} starts by turning the idea into a shot plan, so the video has a direction before clips are made or credits are spent.`,
        "Then the clips are generated around that plan, instead of feeling like random pieces I have to force together in the right order.",
        "When something looks off, the fix feels specific, like replacing one weak beat without redoing everything else.",
        "The final assembly feels cleaner because the shots, audio, and pacing are all working toward the same point from start to finish.",
        "It still feels natural, just without the endless switching, exporting, and guessing between tools every single time.",
      ],
      imagePrompts: [
        "Vertical phone-shot keyframe of a creator overwhelmed at a laptop with scattered notes and abstract editing cards, no readable text.",
        `Clean workspace keyframe with ${product} represented by organized abstract shot cards on a laptop, creator leaning in with relief, no readable UI.`,
        "Close creator desk keyframe with generated clip thumbnails shown as simple visual blocks, phone and notebook nearby, natural light.",
        "Keyframe of the creator reviewing one weak clip beat and selecting a cleaner replacement, abstract interface shapes only.",
        "Organized final timeline keyframe with video pieces aligned visually on a laptop, creator satisfied, no readable text.",
        `Final UGC-style creator workspace reveal with ${product} workflow implied on the laptop, calm polished but natural finish.`,
        `Closing creator POV keyframe with laptop, phone, and finished video preview represented by clean non-readable shapes, ${product} workflow complete.`,
      ],
      videoPrompts: [
        "Small handheld drift over scattered notes and laptop tabs, ending on the creator's frustrated reaction.",
        "Gentle push-in toward organized shot cards on the laptop as the creator nods.",
        "Slow handheld slide across clip thumbnail shapes and the creator's hands at the keyboard.",
        "Short controlled pan from the weak clip card to a cleaner replacement card.",
        "Smooth handheld tilt across the organized final timeline shapes.",
        "Soft push-in on the finished workspace and creator's relieved reaction.",
        "Small final handheld drift from the completed abstract timeline to the creator's relieved reaction.",
      ],
    };
  }
  if (kind === "generic_product") {
    return {
      title: `${product} Practical Product Demo`,
      creativeVibe: "practical_product_demo" as VideoVibe,
      hook: `I did not expect ${product} to become part of the routine this quickly.`,
      payoff: `${product} is simple enough that I would actually keep using it.`,
      visualBible: `Same young adult creator in a real everyday setting, practical product demo, natural light, clear product closeups. ${product} stays visually consistent, no readable text, no split-screen, no duplicate product lineup, and no fake overlays.`,
      brollScripts: [
        `The first thing I noticed was that ${product} solved a real little friction point instead of just looking nice.`,
        "The closeup is where it makes sense: the useful part is visible without needing a big explanation.",
        "Using it once in the middle of a normal day made the benefit feel much more obvious.",
        "The before and after is subtle, but the whole setup feels easier once it is actually in use.",
        "It feels like one of those products that works because it fits into what you already do.",
        "That is the part I would show someone first, because the proof is in the regular moment.",
      ],
      imagePrompts: [
        `Vertical phone-shot hook keyframe with the creator noticing ${product} in a realistic everyday setting.`,
        `Close product proof keyframe of ${product} in practical use, hands visible, clean natural light.`,
        `Real-life demo keyframe of the creator using ${product} during a normal routine, product clear in frame.`,
        `Before-and-after feeling keyframe showing the setup improved after ${product} is used, no text overlays.`,
        `Final practical reveal with ${product} centered and the creator satisfied in the background.`,
        `Creator naturally reaching for ${product} again, clear product continuity, candid handheld framing.`,
        `Closing phone-shot keyframe with ${product} placed in its everyday spot after use, creator relaxed, practical payoff visible.`,
      ],
      videoPrompts: [
        "Small handheld drift toward the product as the creator notices it.",
        "Gentle close push-in during one clear product action.",
        "Slow handheld pan following the creator using the product once.",
        "Subtle slide showing the improved setup after use.",
        "Slow reveal of the final practical product setup.",
        "Small handheld move as the creator reaches for the product again.",
        "Gentle final push-in on the product in its everyday spot after use.",
      ],
    };
  }
  return {
    title: `${product} Workday UGC Ad`,
    creativeVibe: "raw_ugc" as VideoVibe,
    hook: "Okay, be honest, when work gets busy, water is the first thing you completely forget about.",
    payoff: `${product} is the desk reminder I would actually keep using every day.`,
    visualBible: `Same young adult creator in a realistic everyday workspace, phone-shot vertical UGC, natural daylight, casual clothes, clear face, consistent appearance across scenes. ${product} is the one clearly visible product, shown as a real item in use with no text overlays, no captions, no logos added, no split-screen, and no duplicate product lineup.`,
    brollScripts: [
      `I kept ${product} right next to my laptop, so it was in my line of sight while I was typing.`,
      "A little nudge caught me before another long task, so I picked it up and took a sip.",
      "The useful part is how obvious it feels in real life: it is right there while I am working.",
      "By lunch, I had already had more water than usual, mostly because the bottle kept interrupting my autopilot before I forgot again.",
      "The best part is how low-friction it feels: quick sip, back to work, no extra habit tracker to manage.",
      "That is why it stays on the desk, because the habit is simple enough that I actually follow through.",
    ],
    imagePrompts: [
      `Vertical phone-shot hook keyframe of a busy creator at a laptop with ${product} sitting untouched beside a notebook, realistic desk clutter, natural light, product idle on the desk.`,
      `Vertical closeup of ${product} beside a laptop and notebook during a busy workday, realistic desk clutter, natural window light, phone-shot UGC realism.`,
      `Over-the-shoulder work scene with the same creator reaching for ${product} beside the keyboard, laptop open, notebook nearby, candid practical product use, handheld UGC feel.`,
      `Late-afternoon desk scene with ${product} still in reach while the creator works with better focus, realistic workspace, warm natural light, visible product proof moment.`,
      `Clean ending desk reveal with ${product} foregrounded and the same creator in the background looking satisfied, practical everyday setup, warm phone-shot finish.`,
      `Creator naturally lifting ${product} for another sip during work, product centered, realistic office-home environment, casual handheld framing, no text on screen.`,
      `Final creator POV keyframe with ${product} back on the desk after a completed work block, water level visibly lower, creator relaxed in the background, no text.`,
    ],
    videoPrompts: [
      "Small handheld push-in across the busy desk as the creator stays focused on work.",
      "Gentle close handheld drift across the product beside the laptop.",
      "Slow handheld pan from the laptop to the product as the creator reaches for one sip.",
      "Subtle handheld slide across the desk while the product remains the clear focal point.",
      "Slow handheld tilt from the product to the creator's satisfied reaction.",
      "Small handheld move as the creator picks up the product and takes one natural sip.",
      "Gentle final push-in on the bottle resting on the desk after the habit sticks.",
    ],
  };
}

function fallbackUgcProductPlan(request: CreateProjectRequest): {
  title: string;
  narration: string;
  scenes: Scene[];
  visualBible: string;
  creativeVibe: VideoVibe;
  voice: VideoPlan["voice"];
} {
  const target = explicitTargetFinalDurationSeconds(request) ?? 60;
  const product = fallbackProductName(request.prompt);
  const copy = fallbackCopyForKind(fallbackPlanKind(request.prompt), product);
  const hookSeconds = 5;
  const payoffSeconds = 5;
  const brollDurations = fallbackBrollDurations(Math.max(10, target - hookSeconds - payoffSeconds));
  const scenes: Scene[] = [
    {
      id: "scene_1",
      narration: copy.hook,
      image_prompt: copy.imagePrompts[0]!,
      video_prompt: copy.videoPrompts[0]!,
      duration_seconds: hookSeconds,
      on_camera: false,
      audio_mode: "ugc_hook",
      audio_note: null,
      reference_media_ids: [],
      continuity: {
        story_beat: "The creator is absorbed in work and has forgotten the product beside the laptop.",
        required_subjects: ["creator", product],
        opening_state: `The creator works at the desk while ${product} sits untouched beside the laptop.`,
        closing_state: `The creator remains at the same desk and notices ${product} beside the laptop.`,
        setting: "The same realistic home workspace during the workday.",
        screen_direction: "stationary",
      },
    },
    ...brollDurations.map((duration, index) => ({
      id: `scene_${index + 2}`,
      narration: fallbackBrollNarration(copy.brollScripts[index % copy.brollScripts.length]!, index),
      image_prompt: copy.imagePrompts[(index + 1) % copy.imagePrompts.length]!,
      video_prompt: copy.videoPrompts[(index + 1) % copy.videoPrompts.length]!,
      duration_seconds: duration,
      on_camera: false,
      audio_mode: "product_proof" as const,
      audio_note: null,
      reference_media_ids: [],
      continuity: {
        story_beat: copy.brollScripts[index % copy.brollScripts.length]!,
        required_subjects: ["creator", product],
        opening_state: `The creator and ${product} remain at the same desk after the prior workday beat.`,
        closing_state: `The creator completes one new use of ${product} and returns it within reach on the desk.`,
        setting: "The same realistic home workspace later in the same workday.",
        screen_direction: "stationary" as const,
      },
    })),
    {
      id: `scene_${brollDurations.length + 2}`,
      narration: copy.payoff,
      image_prompt: copy.imagePrompts[copy.imagePrompts.length - 1]!,
      video_prompt: copy.videoPrompts[copy.videoPrompts.length - 1]!,
      duration_seconds: payoffSeconds,
      on_camera: false,
      audio_mode: "testimonial",
      audio_note: null,
      reference_media_ids: [],
      continuity: {
        story_beat: "The creator finishes the work block and leaves the product ready for continued use.",
        required_subjects: ["creator", product],
        opening_state: `The creator and ${product} remain at the same desk after the final proof beat.`,
        closing_state: `The creator is relaxed and ${product} rests visibly on the desk after the habit succeeds.`,
        setting: "The same realistic home workspace at the end of the work block.",
        screen_direction: "stationary",
      },
    },
  ];
  return {
    title: copy.title,
    creativeVibe: copy.creativeVibe,
    visualBible: copy.visualBible,
    scenes,
    narration: scenes.map((scene) => scene.narration).join("\n\n"),
    voice: null,
  };
}

export async function draftFallbackVideoPlanImpl(ctx: ProjectContext): Promise<JsonDict> {
  const request = requestFromProjectState(ctx);
  if (!request) throw new Error("Cannot draft fallback video plan without request context.");
  const intent = inferCreativeIntent(request, ctx);
  if (!["ugc", "product_demo", "problem_solution", "testimonial", "founder_story"].includes(intent.format)) {
    throw new Error(`The deterministic UGC/product fallback does not support ${intent.format} videos.`);
  }
  const fallback = fallbackUgcProductPlan(request);
  updateProjectState(ctx, {
    decision: {
      tool: "draft_video_plan",
      decision: "Using conservative deterministic fallback plan after repeated objective draft validation failures.",
      metadata: {
        fallback: "ugc_product_first_run",
        scene_count: fallback.scenes.length,
        duration_seconds: fallback.scenes.reduce((sum, scene) => sum + scene.duration_seconds, 0),
      },
    },
  });
  return draftVideoPlanImpl(
    ctx,
    fallback.title,
    fallback.narration,
    fallback.scenes,
    fallback.visualBible,
    fallback.creativeVibe,
    true,
    fallback.voice,
  );
}

function runtimeCoverageStats(
  plan: VideoPlan,
  request: CreateProjectRequest,
  ctx: ProjectContext,
): { target: number; estimatedContentSeconds: number; minContentSeconds: number; missingSeconds: number } | null {
  const target = explicitTargetFinalDurationSeconds(request);
  if (target === null || target < 30) return null;
  const estimatedContentSeconds = plan.scenes.reduce((sum, scene) => {
    if (scene.on_camera === true) return sum + estimateSceneSpeechSeconds(scene, plan, ctx);
    return sum + scene.duration_seconds;
  }, 0);
  const minContentSeconds = Math.max(0, target * MIN_RUNTIME_COVERAGE_RATIO - RUNTIME_COVERAGE_EPSILON_SECONDS);
  return {
    target,
    estimatedContentSeconds: round3(estimatedContentSeconds),
    minContentSeconds: round3(minContentSeconds),
    missingSeconds: round3(Math.max(0, minContentSeconds - estimatedContentSeconds)),
  };
}

function runtimeRepairInstruction(plan: VideoPlan, request: CreateProjectRequest | null, ctx: ProjectContext): string | null {
  if (!request) return null;
  const stats = runtimeCoverageStats(plan, request, ctx);
  if (!stats || stats.missingSeconds <= 0) return null;
  const brollDurations = [...(MAGIC_VIDEO_MODEL_DURATIONS[ctx.video_model] ?? new Set<number>())]
    .filter((duration) => duration >= 10 && duration <= 15)
    .sort((a, b) => a - b);
  const preferredBroll = brollDurations.includes(10) ? 10 : (brollDurations[0] ?? 10);
  const neededBrollScenes = Math.max(1, Math.ceil(stats.missingSeconds / preferredBroll));
  const totalSceneSeconds = plan.scenes.reduce((sum, scene) => sum + scene.duration_seconds, 0);
  const spokenWordTarget = Math.max(20, Math.floor(stats.minContentSeconds * estimateTtsWordsPerSecondForContext(ctx, plan.voice) * 0.82));
  return [
    `Runtime repair target: cover at least ${stats.minContentSeconds.toFixed(1)}s of a ${stats.target}s request; this draft only covers ${stats.estimatedContentSeconds.toFixed(1)}s.`,
    `Add about ${stats.missingSeconds.toFixed(1)}s of real content. Usually that means ${neededBrollScenes} more ${preferredBroll}s product/demo/result b-roll scene${neededBrollScenes === 1 ? "" : "s"} with duration-backed narration, or enough natural creator dialogue to actually speak that time.`,
    `For this runtime, aim for roughly ${spokenWordTarget}+ spoken words across per-scene narrations unless the user explicitly asked for a mostly visual edit.`,
    `The scene duration total is ${totalSceneSeconds}s; do not lower it below ${stats.target}s unless the user asked for a shorter edit.`,
  ].join("\n");
}

function focusedPlanRepairRules(issues: string[]): string[] {
  const issueText = issues.join(" ");
  const rules = [
    "- Fix only the reported issues. Preserve every field and story fact that already passed validation.",
    "- Recount the actual scene narration payload before resubmitting; reasoning-only counts do not count.",
  ];
  if (/under-scripted|minimum|spoken words|voiceover is .*short/i.test(issueText)) {
    rules.push(
      "- This draft is under-scripted: do not delete, condense, or paraphrase away valid narration. Add complete, relevant spoken sentences until the reported minimum is exceeded by at least 3 words, distributed in proportion to scene duration.",
    );
  }
  if (/too long|overrun|max \d+ words|voiceover is .*long/i.test(issueText)) {
    rules.push(
      "- This draft is over-scripted: shorten only the affected narration, keep complete sentences, and preserve every explicit user fact and quoted line.",
    );
  }
  if (/ending claim|quoted user speech/i.test(issueText)) {
    rules.push(
      "- Preserve the requested spoken wording in the required scene. Add it without dropping another required fact or exact quoted line.",
    );
  }
  if (/duration|runtime|seconds|supported/i.test(issueText)) {
    rules.push(
      "- Make scene durations use supported model values and sum to the requested runtime; never rely on final-frame freezing or audio truncation.",
    );
  }
  if (/opening state|closing state|continuity|geometry|fall|catch|landing|collision|screen direction|handoff|transfer/i.test(issueText)) {
    rules.push(
      "- Update narration, story_beat, opening_state, closing_state, image_prompt, and video_prompt together for the affected physical event. Keep each event atomic and preserve inherited positions, identity, object count, and screen direction.",
    );
  }
  if (/image|keyframe|visual|subject|object|split|collage|text-only|title card/i.test(issueText)) {
    rules.push(
      "- Keep each image prompt to one full-frame moment with every required subject visibly grounded; no panels, text cards, duplicate products, symbolic stand-ins, or invented subjects.",
    );
  }
  if (/narration contains|schema|meta planning|camera directions|visual directions/i.test(issueText)) {
    rules.push(
      "- Spoken narration may contain only words a person would naturally say. Move production, camera, schema, and visual instructions into the appropriate non-spoken fields.",
    );
  }
  return rules;
}

export function providerImagePrompt(plan: VideoPlan, scene: Scene): string {
  let prompt = scene.image_prompt.split(/\s+/).filter(Boolean).join(" ");
  const visualBible = plan.visual_bible.split(/\s+/).filter(Boolean).join(" ");
  const vibe = VIDEO_VIBE_RULES[plan.creative_vibe];
  const vibeLine = `Video vibe: ${vibe.label}. ${vibe.cue}.`;
  const visibleHumanText = `${prompt} ${scene.narration} ${scene.continuity.required_subjects.join(" ")}`;
  const hasMinorSubject = /\b(baby|babies|infant|child|children|boy|girl)\b/i.test(visibleHumanText);
  const hasMinorCausalAction = hasMinorSubject && Boolean(causalOpeningKeyframeGuidance(scene));
  const providerVisualBible = hasMinorCausalAction
    ? visualBible
        .split(/(?<=[.!?])\s+/)
        .filter(
          (sentence) =>
            !/\b(baby|babies|infant|child|children|boy|girl)\b/i.test(sentence) &&
            !/\b(?:fall|falls|falling|fell|plummet|plummets|descend|descends|descending)\b/i.test(sentence),
        )
        .join(" ")
    : visualBible;
  if (hasMinorSubject) {
    prompt = prompt
      .replace(/\b(?:in\s+)?a\s+(?:cloth\s+)?diapers?\b/gi, "wearing a period-appropriate outfit")
      .replace(/\b(?:cloth\s+)?diapers?\b/gi, "period-appropriate clothing")
      .replace(/\b(plummets?|hurtl(?:e|es|ing))\b/gi, "descends through the air");
  }
  const humanSubjectGuard = hasMinorCausalAction
    ? "The receiving adult is an actual living human with natural anatomy; never depict a doll, toy, stuffed animal, mannequin, statue, photograph, poster, or symbolic substitute. The airborne element is one securely wrapped infant-sized cloth rescue bundle, never an exposed or distressed child."
    : /\b(baby|babies|infant|child|children|boy|girl|woman|man|person|people|human)\b/i.test(visibleHumanText)
      ? "Every requested human subject is an actual living human with natural anatomy and an unmistakably human face, hands, skin, and clothing; never depict a doll, toy, stuffed animal, mannequin, statue, photograph, poster, or symbolic substitute."
      : "";
  const minorSafetyGuard = hasMinorCausalAction
    ? "Present a safe, non-graphic historical rescue reenactment. The rescue bundle is fully wrapped with no visible face, skin, injury, or distress."
    : hasMinorSubject
      ? "Every minor is fully clothed in a period-appropriate outfit. Present the moment as a safe, non-graphic historical reenactment with no nudity, exposed underclothing, blood, injury, or visible distress."
    : "";
  const singleFrameGuard =
    "Single unbroken photorealistic keyframe: one camera viewpoint, one moment in time, full-frame image only. One primary focal subject/product only; no duplicate product variants, extra unrelated products, product lineup, rows of packages, split-screen, collage, storyboard, grid, stacked panels, before/after layout, captions, UI, logos, or multiple frames.";
  const geometryGuidance = causalGeometryGuidance(scene);
  const openingKeyframeGuidance = causalOpeningKeyframeGuidance(scene, {
    providerSafeMinor: hasMinorCausalAction,
  });
  const physicsContext = scenePhysicsContext(plan, scene, {
    openingKeyframeOnly: Boolean(openingKeyframeGuidance),
    providerSafeMinor: hasMinorCausalAction,
    globalWorldAnchors: providerVisualBible,
  });
  const contextLine =
    `Scene physics packet: ${physicsContext}. ` +
    "Compose only the current scene's single frozen moment. Preserve the stated spatial relationships and entry state; " +
    "the previous exit is continuity history, while the closing state is the destination for later animation, not a second moment to combine into the still.";
  const realWorldStaging = realWorldStagingGuidance(scene);
  const sceneKeyframe = openingKeyframeGuidance || `Scene keyframe: ${prompt}`;
  if (!providerVisualBible) {
    return `${singleFrameGuard} ${humanSubjectGuard} ${minorSafetyGuard} ${vibeLine} ${contextLine} ${realWorldStaging} ${geometryGuidance} ${sceneKeyframe}`.trim();
  }
  if (prompt.toLowerCase().includes(providerVisualBible.toLowerCase())) {
    return `${singleFrameGuard} ${humanSubjectGuard} ${minorSafetyGuard} ${vibeLine} ${contextLine} ${realWorldStaging} ${geometryGuidance} ${sceneKeyframe}`.trim();
  }
  return `${singleFrameGuard} ${humanSubjectGuard} ${minorSafetyGuard} ${vibeLine} ${contextLine} ${realWorldStaging} ${geometryGuidance} ${sceneKeyframe}`.trim();
}

export function providerVideoPrompt(plan: VideoPlan, scene: Scene): string {
  const physicsContext = scenePhysicsContext(plan, scene);
  const geometryGuidance = causalGeometryGuidance(scene);
  return [
    "Animate the supplied keyframe as one physically continuous shot with no cuts or scene changes.",
    `Scene physics packet: ${physicsContext}.`,
    realWorldStagingGuidance(scene),
    geometryGuidance,
    "Begin from the declared current entry and finish at the declared closing state. Preserve identity, object count, possession, gravity, contact, scale, screen direction, and environmental layout. Do not teleport, duplicate, replace, or introduce subjects.",
    `Motion instruction: ${causalMotionInstruction(scene)}`,
  ].filter(Boolean).join(" ");
}

export function narrationStats(plan: VideoPlan, voiceover: JsonDict): JsonDict {
  const words = countSpokenWords(plan.narration);
  const cues = fishAudioExpressionCues(plan.narration);
  const duration = Number(voiceover.duration_seconds ?? 0);
  return {
    word_count: words,
    expression_cue_count: cues.length,
    expression_cues: cues,
    voiceover_duration_seconds: duration,
    words_per_second: duration > 0 ? Math.round((words / duration) * 1000) / 1000 : null,
  };
}

async function ensureSceneVoiceovers(
  ctx: ProjectContext,
  scenes: Scene[],
  referenceId?: string,
  plan?: VideoPlan,
): Promise<Array<{ scene_id: string; path: string; duration_seconds: number }>> {
  const existing: Array<{ scene_id: string; path: string; duration_seconds: number }> = [];
  const missing: Scene[] = [];
  for (const scene of scenes) {
    const cached = await existingSceneVoiceover(ctx, scene.id);
    if (cached) existing.push(cached);
    else missing.push(scene);
  }
  const generated = missing.length > 0 ? await generateSceneVoiceovers(ctx, missing, referenceId, plan) : [];
  return [...existing, ...generated];
}

function voiceoverDurationIssues(
  voiceover: JsonDict,
  request: CreateProjectRequest | null,
  ctx: ProjectContext,
  plan: VideoPlan | null = null,
): string[] {
  const target = explicitTargetFinalDurationSeconds(request);
  if (target === null) return [];
  const duration = Number(voiceover.duration_seconds ?? 0);
  if (!Number.isFinite(duration) || duration <= 0) return ["Voiceover duration could not be measured."];
  const allowed = maxAllowedVoiceoverSeconds(target);
  if (duration > allowed) {
    const measuredWords = plan ? countSpokenWords(plan.narration) : 0;
    const targetWords =
      measuredWords > 0
        ? Math.max(4, Math.floor((measuredWords * Math.min(target + 0.5, allowed)) / duration))
        : null;
    return [
      `Generated voiceover is ${duration.toFixed(1)}s for a ${target}s target (max ${allowed.toFixed(1)}s). ` +
        (targetWords
          ? `Redraft to about ${targetWords} or fewer natural spoken words before generating images or videos; `
          : "Redraft shorter, more natural narration before generating images or videos; ") +
        "do not cut the audio at the cap.",
    ];
  }
  if (plan && request && expectsNarratedVideoCoverage(plan, request)) {
    const minimumSpeech = minimumNarratedSpeechSecondsForRequest(target, request);
    if (duration + SCENE_AUDIO_ESTIMATE_EPSILON_SECONDS < minimumSpeech) {
      const measuredWords = countSpokenWords(plan.narration);
      const measuredPace = measuredWords / duration;
      const minWords = Math.max(
        minimumNarratedSpokenWords(target, ctx, request, plan),
        Math.ceil(minimumSpeech * measuredPace) + 2,
      );
      return [
        `Generated voiceover is only ${duration.toFixed(1)}s for a ${target}s narrated video ` +
          `(minimum ${minimumSpeech.toFixed(1)}s). Redraft to about ${minWords}+ natural spoken words; do not freeze-pad the final frame.`,
      ];
    }
  }
  return [];
}

function actualMixedVoiceoverCoverageIssues(
  plan: VideoPlan,
  sceneVoiceovers: Array<{ scene_id: string; duration_seconds: number }>,
  request: CreateProjectRequest | null,
): string[] {
  const target = explicitTargetFinalDurationSeconds(request);
  if (target === null) return [];
  const byScene = new Map(sceneVoiceovers.map((voiceover) => [voiceover.scene_id, Number(voiceover.duration_seconds)]));
  const issues: string[] = [];
  let expectedContentSeconds = 0;

  for (const scene of plan.scenes) {
    const sceneDuration = Number(scene.duration_seconds ?? 0);
    const hasNarration = countSpokenWords(scene.narration) > 0;
    const measuredSpeech = byScene.get(scene.id);

    if (scene.on_camera === true) {
      if (!Number.isFinite(measuredSpeech) || Number(measuredSpeech) <= 0) {
        issues.push(`${scene.id} is an on-camera scene but has no measured voiceover take.`);
        continue;
      }
      expectedContentSeconds += Number(measuredSpeech);
      if (sceneDuration >= 4 && Number(measuredSpeech) + SCENE_AUDIO_ESTIMATE_EPSILON_SECONDS < sceneDuration) {
        issues.push(
          `${scene.id} is planned as ${sceneDuration}s on-camera but the measured speech is only ` +
            `${Number(measuredSpeech).toFixed(1)}s. Shorten that scene or add natural dialogue before rendering.`,
        );
      }
      continue;
    }

    expectedContentSeconds += sceneDuration;
    if (hasNarration && Number.isFinite(measuredSpeech) && sceneDuration >= 10) {
      const minimumSpeech = minBrollSpeechSeconds(sceneDuration);
      if (Number(measuredSpeech) + SCENE_AUDIO_ESTIMATE_EPSILON_SECONDS < minimumSpeech) {
        issues.push(
          `${scene.id} has ${Number(measuredSpeech).toFixed(1)}s of measured voice for a ${sceneDuration}s b-roll section. ` +
            "Add more visual-proof narration or shorten the section so it does not end with dead air.",
        );
      }
    }
  }

  const minimum = Math.max(0, target * MIN_RUNTIME_COVERAGE_RATIO - RUNTIME_COVERAGE_EPSILON_SECONDS);
  if (expectedContentSeconds < minimum) {
    issues.push(
      `Measured scene coverage is ${expectedContentSeconds.toFixed(1)}s for a ${target}s target ` +
        `(minimum ${minimum.toFixed(1)}s). Redraft with more real scene/audio coverage; do not freeze-pad the final frame.`,
    );
  }
  return issues;
}

const MEASURED_SCENE_MIN_SECONDS = 3;
const MEASURED_CAUSAL_SCENE_MIN_SECONDS = 8;
const MEASURED_CAUSAL_EVENT =
  /\b(?:fall|falls|falling|tumble|tumbles|descend|descends|catch|catches|land|lands|collide|collides|impact|impacts|handoff|hands? over)\b/i;

export function alignPlanToMeasuredVoiceover(plan: VideoPlan, voiceover: JsonDict): VideoPlan {
  const target = Math.round(planDurationSeconds(plan));
  const timings = Array.isArray(voiceover.scene_timings) ? voiceover.scene_timings : [];
  if (plan.scenes.length < 2 || timings.length !== plan.scenes.length || target <= 0) return plan;
  const byId = new Map(timings.map((timing: JsonDict) => [String(timing.scene_id), timing]));
  if (plan.scenes.some((scene) => !byId.has(scene.id))) return plan;

  const minimums = plan.scenes.map((scene) =>
    MEASURED_CAUSAL_EVENT.test(`${scene.continuity.story_beat} ${scene.video_prompt}`)
      ? MEASURED_CAUSAL_SCENE_MIN_SECONDS
      : MEASURED_SCENE_MIN_SECONDS,
  );
  if (minimums.reduce((sum, value) => sum + value, 0) > target) return plan;

  const boundaries = [0];
  for (let index = 1; index < plan.scenes.length; index += 1) {
    const desired = Math.round(Number(byId.get(plan.scenes[index]!.id)?.start_seconds));
    if (!Number.isFinite(desired)) return plan;
    const lower = boundaries[index - 1]! + minimums[index - 1]!;
    const futureMinimum = minimums.slice(index).reduce((sum, value) => sum + value, 0);
    const upper = target - futureMinimum;
    boundaries.push(Math.max(lower, Math.min(upper, desired)));
  }
  boundaries.push(target);

  const scenes = plan.scenes.map((scene, index) => ({
    ...scene,
    duration_seconds: boundaries[index + 1]! - boundaries[index]!,
  }));
  return VideoPlanSchema.parse({ ...plan, scenes, narration: narrationFromScenes(scenes, plan.narration) });
}

export function mergeTokenOutputIntoManifest(ctx: ProjectContext, tokenOutput: JsonDict): JsonDict {
  const manifestPath = path.join(ctx.project_dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    const state = readProjectState(ctx);
    const error = (state.status ?? {}).error;
    if (error) throw new Error(String(error));
    throw new Error("Agent finished without producing a video manifest.");
  }
  let manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  manifest.token_output = tokenOutput;
  manifest.token_output_path = tokenOutput.token_output_path;
  manifest.gpt_cost_usd = tokenOutput.cost.total_usd;
  if (manifest.final_video_path && !manifest.final_video_url) {
    manifest.final_video_url = publicMediaPath(manifest.final_video_path);
  }
  manifest = exportYoutubeFinalVideo(ctx, manifest);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  updateProjectState(ctx, { manifest });
  return manifest;
}

export function loadVideoPlan(ctx: ProjectContext): VideoPlan {
  const payload = readJsonArtifact(ctx, "plan");
  if (!payload) {
    throw new Error("No video plan found. Call draft_video_plan before rendering assets.");
  }
  return VideoPlanSchema.parse(payload);
}

export function planDurationSeconds(plan: VideoPlan): number {
  return plan.scenes.reduce((sum, scene) => sum + scene.duration_seconds, 0);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function timelineFromProjectState(state: JsonDict): TimelineArtifact {
  return state.timeline ? normalizeTimeline(state.timeline) : buildTimelineFromProjectState(state);
}

export function currentProjectTimeline(ctx: ProjectContext): TimelineArtifact {
  return timelineFromProjectState(readProjectState(ctx));
}

function providerCallsBlockedByState(
  ctx: ProjectContext,
  operation: "voiceover" | "visual" = "visual",
): string | null {
  const state = readProjectState(ctx);
  const status = state.status ?? {};
  const decisions = Array.isArray(state.decisions) ? state.decisions : [];
  const latestVoiceIndex = decisions.findLastIndex((entry: JsonDict) => entry.tool === "generate_voiceover");
  const latestVoiceDecision = latestVoiceIndex >= 0 ? decisions[latestVoiceIndex] : null;
  const latestAcceptedPlanIndex = decisions.findLastIndex(
    (entry: JsonDict) => entry.tool === "draft_video_plan" && entry.metadata?.validation_failed !== true,
  );
  const voiceDecisionText = String(latestVoiceDecision?.decision ?? "").toLowerCase();
  const latestVoiceFailed =
    latestVoiceDecision != null &&
    (latestVoiceDecision.metadata?.validation_failed === true ||
      voiceDecisionText.includes("failed") ||
      voiceDecisionText.includes("rejected"));
  const statusFailed = ["voiceover_validation_failed", "voiceover_failed"].includes(String(status.stage));

  if (!latestVoiceFailed && !statusFailed) return null;
  if (operation === "voiceover" && latestAcceptedPlanIndex > latestVoiceIndex) return null;

  const decisionError = latestVoiceDecision?.metadata?.error;
  const decisionIssues = latestVoiceDecision?.metadata?.issues;
  return String(
    status.error ||
      decisionError ||
      (Array.isArray(decisionIssues) ? decisionIssues.join(" ") : "") ||
      "Voiceover generation did not complete. Fix the narration or audio-provider configuration before any paid scene-media calls.",
  );
}

function assertProviderCallsAllowed(
  ctx: ProjectContext,
  operation: "voiceover" | "visual" = "visual",
): void {
  const blocked = providerCallsBlockedByState(ctx, operation);
  if (blocked) throw new Error(blocked);
}

function timelineTargetDurationSeconds(timeline: TimelineArtifact, explicitTarget: number | null | undefined): number | null {
  const timelineDuration = Number(timeline.duration_seconds ?? 0);
  const requested = Number(explicitTarget ?? 0);
  const target = Number.isFinite(requested) && requested > 0 ? requested : Number.isFinite(timelineDuration) ? timelineDuration : 0;
  return target > 0 ? round3(target) : null;
}

function mixedTargetDurationSeconds(
  timeline: TimelineArtifact,
  explicitTarget: number | null | undefined,
): number | null {
  return timelineTargetDurationSeconds(timeline, explicitTarget);
}

async function assertFinalDurationCloseToExplicitTarget(ctx: ProjectContext, finalVideo: string): Promise<void> {
  const target = explicitTargetFinalDurationSeconds(requestFromProjectState(ctx));
  if (target === null) return;
  const durations = await probeMediaStreamDurations(finalVideo);
  const actual = Number(durations.format_duration_seconds ?? durations.video_duration_seconds ?? 0);
  if (!Number.isFinite(actual) || actual <= 0) {
    throw new Error("Final video duration could not be measured after stitching.");
  }
  const minimum = Math.max(0, target * MIN_RUNTIME_COVERAGE_RATIO - RUNTIME_COVERAGE_EPSILON_SECONDS);
  if (actual + 0.5 < minimum) {
    throw new Error(
      `Final video rendered ${actual.toFixed(1)}s for a ${target}s target. ` +
        "Redraft with more spoken content or longer visual proof sections before marking the project complete.",
    );
  }
}

function keepEndingGuardAtTimelineEnd(timeline: TimelineArtifact): TimelineArtifact {
  return setFinalHold(timeline, timeline.ending?.hold_seconds ?? 0, timeline.ending?.reason ?? "Adjusted final hold.");
}

function timelineVideoClipsForStitch(timeline: TimelineArtifact): TimelineClip[] {
  return timeline.tracks
    .find((track) => track.kind === "video")
    ?.clips.filter((clip) => clip.source_path)
    .sort((a, b) => a.timeline_start - b.timeline_start) ?? [];
}

function missingPlannedVideoSceneIds(plan: VideoPlan, videos: JsonDict[]): string[] {
  const rendered = new Set(videos.map((video) => String(video.scene_id ?? "")));
  return plan.scenes.map((scene) => scene.id).filter((sceneId) => !rendered.has(sceneId));
}

async function attachTimelineRenderVerification(
  ctx: ProjectContext,
  timeline: TimelineArtifact,
  finalVideoPath: string,
): Promise<TimelineArtifact> {
  const streams = await probeMediaStreamDurations(finalVideoPath);
  const videoDuration = streams.video_duration_seconds ?? streams.format_duration_seconds;
  const audioDuration = streams.audio_duration_seconds ?? streams.format_duration_seconds;
  const delta = videoDuration != null && audioDuration != null ? round3(videoDuration - audioDuration) : null;
  return normalizeTimeline({
    ...timeline,
    ending: {
      ...timeline.ending,
      intentional: (timeline.ending?.hold_seconds ?? 0) > 0,
      verification: {
        checked_at: new Date().toISOString(),
        checked_with: "ffprobe",
        final_video_path: finalVideoPath,
        format_duration_seconds: round3(streams.format_duration_seconds),
        video_duration_seconds: videoDuration != null ? round3(videoDuration) : null,
        audio_duration_seconds: audioDuration != null ? round3(audioDuration) : null,
        audio_video_delta_seconds: delta,
        aligned: delta === null ? null : Math.abs(delta) <= 0.25,
        project_id: ctx.project_id,
      },
    },
  });
}

async function stitchFromTimelineOrFallback(
  ctx: ProjectContext,
  videos: JsonDict[],
  voiceover: JsonDict,
  timeline: TimelineArtifact,
): Promise<string> {
  const targetDuration = timelineTargetDurationSeconds(
    timeline,
    explicitTargetFinalDurationSeconds(requestFromProjectState(ctx)),
  );
  const clips = timelineVideoClipsForStitch(timeline);
  if (clips.length > 0) {
    return stitchTimelineAssets(
      ctx,
      clips.map((clip) => ({
        id: clip.id,
        path: String(clip.source_path),
        source_start: clip.source_start,
        source_end: clip.source_end,
        timeline_start: clip.timeline_start,
        timeline_end: clip.timeline_end,
        duration: clip.duration,
        scene_id: clip.scene_id,
      })),
      voiceover,
      { target_duration_seconds: targetDuration },
    );
  }
  return stitchAssets(ctx, videos, voiceover, { target_duration_seconds: targetDuration });
}

async function persistRenderedTimeline(
  ctx: ProjectContext,
  timeline: TimelineArtifact,
  finalVideoPath: string,
  tool = "timeline",
): Promise<TimelineArtifact> {
  const verified = await attachTimelineRenderVerification(ctx, timeline, finalVideoPath);
  updateProjectState(ctx, {
    timeline: verified,
    decision: {
      tool,
      decision: "Recorded timeline and verified final audio/video duration alignment.",
      metadata: {
        summary: timelineSummary(verified),
        ending: verified.ending,
      },
    },
  });
  return verified;
}

export function sceneIdsFor(plan: VideoPlan, sceneIds: string[] | null = null): Set<string> {
  if (!sceneIds || sceneIds.length === 0) {
    return new Set(plan.scenes.map((scene) => scene.id));
  }
  const known = new Set(plan.scenes.map((scene) => scene.id));
  const requested = new Set(sceneIds);
  const unknown = [...requested].filter((id) => !known.has(id)).sort();
  if (unknown.length > 0) {
    throw new Error(`Unknown scene id(s): ${unknown.join(", ")}`);
  }
  return requested;
}

export function saveVideoPlan(ctx: ProjectContext, plan: VideoPlan): VideoPlan {
  writeJsonArtifact(ctx, "plan", plan);
  updateProjectState(ctx, { current_plan: plan });
  return plan;
}

export function patchSceneInPlan(
  plan: VideoPlan,
  sceneId: string,
  updates: {
    narration?: string | null;
    image_prompt?: string | null;
    video_prompt?: string | null;
    duration_seconds?: number | null;
  },
): [VideoPlan, Scene] {
  let patchedScene: Scene | null = null;
  const patchedScenes = plan.scenes.map((scene) => {
    if (scene.id !== sceneId) return scene;
    const next: Scene = { ...scene };
    if (updates.narration != null) next.narration = updates.narration;
    if (updates.image_prompt != null) next.image_prompt = updates.image_prompt.split(/\s+/).filter(Boolean).join(" ");
    if (updates.video_prompt != null) next.video_prompt = updates.video_prompt.split(/\s+/).filter(Boolean).join(" ");
    if (updates.duration_seconds != null) next.duration_seconds = updates.duration_seconds;
    patchedScene = next;
    return next;
  });
  if (patchedScene === null) {
    throw new Error(`Unknown scene id: ${sceneId}`);
  }
  return [{ ...plan, scenes: patchedScenes }, patchedScene];
}

export function reviseSceneNarrations(plan: VideoPlan, revisions: SceneNarrationRevision[]): VideoPlan {
  if (revisions.length === 0) return plan;
  const revisionByScene = new Map(revisions.map((revision) => [revision.scene_id, revision.narration]));
  const known = new Set(plan.scenes.map((scene) => scene.id));
  const unknown = [...revisionByScene.keys()].filter((id) => !known.has(id)).sort();
  if (unknown.length > 0) {
    throw new Error(`Unknown scene id(s): ${unknown.join(", ")}`);
  }
  return {
    ...plan,
    scenes: plan.scenes.map((scene) =>
      revisionByScene.has(scene.id) ? { ...scene, narration: revisionByScene.get(scene.id)! } : scene,
    ),
  };
}

export function invalidateFinalArtifacts(ctx: ProjectContext, options: { voiceover?: boolean } = {}): void {
  removeJsonArtifact(ctx, "manifest");
  if (options.voiceover) removeJsonArtifact(ctx, "voiceover");
  updateProjectState(ctx, {
    final_video_path: null,
    manifest_path: null,
    ...(options.voiceover ? { voiceover: null } : {}),
  });
}

export function clearRenderOutputs(ctx: ProjectContext): void {
  for (const artifact of ["voiceover", "images", "videos", "failed_scenes", "manifest"]) {
    removeJsonArtifact(ctx, artifact);
  }
  for (const directory of ["voiceover", "images", "videos", "youtube_clips"]) {
    rmSync(path.join(ctx.project_dir, directory), { recursive: true, force: true });
  }
  for (const filename of ["final.mp4", "merged.mp4", "merged_timed.mp4"]) {
    try {
      unlinkSync(path.join(ctx.project_dir, filename));
    } catch {
      // missing file is fine
    }
  }
}

function assertNoCompletedManifest(ctx: ProjectContext, toolName: string): void {
  const manifest = readJsonArtifact<JsonDict>(ctx, "manifest", null);
  const finalVideoPath = typeof manifest?.final_video_path === "string" ? manifest.final_video_path : "";
  if (finalVideoPath && existsSync(finalVideoPath)) {
    throw new Error(
      `${toolName} refused to start because this project already has a completed final video. ` +
        "Use an explicit edit tool to invalidate and regenerate scenes.",
    );
  }
}

function paidMediaGenerationStarted(ctx: ProjectContext): boolean {
  return ["voiceover", "images", "videos"].some((artifact) => existsSync(artifactPath(ctx, artifact)));
}

function assertCanStartFreshPlan(ctx: ProjectContext): void {
  if (!paidMediaGenerationStarted(ctx)) return;
  throw new Error(
    "draft_video_plan refused to replace the plan because paid media artifacts already exist. " +
      "Inspect the render status, stitch/recover existing provider jobs, or use an explicit edit tool after the user asks for changes.",
  );
}

export function ensureSupportedImageOptions(model: string, resolution: string): void {
  if (!(MAGIC_IMAGE_MODELS as readonly string[]).includes(model)) {
    throw new Error(`Unsupported Magic Hour image model: ${model}`);
  }
  if (!(MAGIC_IMAGE_RESOLUTIONS as readonly string[]).includes(resolution)) {
    throw new Error(`Unsupported Magic Hour image resolution: ${resolution}`);
  }
  const supported = MAGIC_IMAGE_MODEL_RESOLUTIONS[model];
  if (supported !== undefined && !supported.has(resolution)) {
    throw new Error(`${model} supports image resolutions ${[...supported].sort()}, not ${resolution}.`);
  }
}

export function ensureSupportedVideoOptions(model: string, resolution: string, scenes: Scene[]): void {
  if (!(MAGIC_VIDEO_MODELS as readonly string[]).includes(model)) {
    throw new Error(`Unsupported Magic Hour image-to-video model: ${model}`);
  }
  const supportedResolutions = MAGIC_VIDEO_MODEL_RESOLUTIONS[model];
  if (supportedResolutions !== undefined && !supportedResolutions.has(resolution)) {
    throw new Error(`${model} supports video resolutions ${[...supportedResolutions].sort()}, not ${resolution}.`);
  }
  const supportedDurations = MAGIC_VIDEO_MODEL_DURATIONS[model];
  if (supportedDurations === undefined) return;
  const unsupported = scenes
    .filter((scene) => scene.on_camera !== true)
    .map((scene) => scene.duration_seconds)
    .filter((duration) => !supportedDurations.has(duration));
  if (unsupported.length > 0) {
    throw new Error(
      `${model} does not support scene duration(s) ${[...new Set(unsupported)].sort((a, b) => a - b)}. ` +
        `Supported I2V durations: ${[...supportedDurations].sort((a, b) => a - b)}.`,
    );
  }
}

export function contextWithMagicImageSettings(
  ctx: ProjectContext,
  options: { model: string; image_resolution: string; image_style_tool: string },
): ProjectContext {
  ensureSupportedImageOptions(options.model, options.image_resolution);
  if (!(MAGIC_IMAGE_STYLE_TOOLS as readonly string[]).includes(options.image_style_tool)) {
    throw new Error(`Unsupported Magic Hour image style tool: ${options.image_style_tool}`);
  }
  return {
    ...ctx,
    image_model: options.model,
    image_resolution: options.image_resolution,
    image_style_tool: options.image_style_tool,
  };
}

export function contextWithMagicVideoSettings(
  ctx: ProjectContext,
  options: { model: string; resolution: string; audio: boolean; scenes: Scene[] },
): ProjectContext {
  ensureSupportedVideoOptions(options.model, options.resolution, options.scenes);
  return { ...ctx, video_model: options.model, resolution: options.resolution, video_audio: options.audio };
}

export function buildVideoManifest(
  plan: VideoPlan,
  ctx: ProjectContext,
  options: {
    images: JsonDict[];
    videos: JsonDict[];
    voiceover: JsonDict;
    failed_scenes: JsonDict[];
    token_output: JsonDict;
    final_video: string;
  },
): JsonDict {
  const planPayload: JsonDict = { ...plan, aspect_ratio: ctx.aspect_ratio, resolution: ctx.resolution };
  const providerSettings = readProjectState(ctx).provider_settings ?? {};
  const timingEvents = readTimingEvents(ctx);

  const manifest: JsonDict = {
    project_id: ctx.project_id,
    title: plan.title,
    created_at: new Date().toISOString(),
    workflow: providerSettings.workflow ?? "generated",
    aspect_ratio: ctx.aspect_ratio,
    resolution: ctx.resolution,
    image_model: providerSettings.image_model ?? ctx.image_model,
    image_resolution: providerSettings.image_resolution ?? ctx.image_resolution,
    image_style_tool: providerSettings.image_style_tool ?? ctx.image_style_tool,
    video_model: providerSettings.video_model ?? ctx.video_model,
    video_resolution: providerSettings.video_resolution ?? ctx.resolution,
    video_audio: providerSettings.video_audio ?? ctx.video_audio,
    audio_provider: ctx.audio_provider,
    audio_model: ctx.audio_model,
    render_status: options.failed_scenes.length > 0 ? "partial" : "complete",
    completed_scene_count: options.videos.length,
    failed_scene_count: options.failed_scenes.length,
    failed_scenes: options.failed_scenes,
    plan: planPayload,
    images: options.images.map((image) => withMediaUrl(image)),
    videos: options.videos.map((video) => withMediaUrl(video)),
    voiceover: withMediaUrl(options.voiceover),
    narration_stats: narrationStats(plan, options.voiceover),
    token_output: options.token_output,
    token_output_path: options.token_output.token_output_path,
    gpt_cost_usd: options.token_output.cost.total_usd,
    timings_path: artifactPath(ctx, "timings"),
    timings_summary: summarizeTimingEvents(timingEvents),
    final_video_path: options.final_video,
    final_video_url: publicMediaPath(options.final_video),
    manifest_path: path.join(ctx.project_dir, "manifest.json"),
  };
  writeJsonArtifact(ctx, "manifest", manifest);
  updateProjectState(ctx, {
    manifest,
    failures: options.failed_scenes,
    final_video_path: options.final_video,
    manifest_path: manifest.manifest_path,
  });
  return manifest;
}

export async function draftVideoPlanImpl(
  ctx: ProjectContext,
  title: string,
  narration: string,
  scenes: Scene[],
  visualBible = "",
  creativeVibe: VideoVibe = "polished_ugc",
  normalizeSceneIds = true,
  voice: VideoPlan["voice"] = null,
): Promise<JsonDict> {
  return withTiming(ctx, "workflow.draft_video_plan", {
    scene_count: scenes.length,
    normalize_scene_ids: normalizeSceneIds,
    creative_vibe: creativeVibe,
  }, async () => {
  let plan: VideoPlan = VideoPlanSchema.parse({
    title,
    creative_vibe: creativeVibe,
    narration,
    visual_bible: visualBible,
    scenes,
    voice,
  });
  if (normalizeSceneIds) plan = normalizePlan(plan);
  if (normalizeSceneIds) plan = normalizeOnCameraSceneChoices(plan);
  const request = requestFromProjectState(ctx);
  if (normalizeSceneIds) plan = preserveExplicitOpeningSpeech(plan, request);
  if (normalizeSceneIds) plan = normalizeOnCameraIntent(plan, request);
  if (normalizeSceneIds) plan = normalizeDenseSceneNarration(plan, ctx);
  if (normalizeSceneIds && request) plan = normalizePlanRuntimeToTarget(plan, request, ctx);
  if (normalizeSceneIds) plan = normalizeDenseSceneNarration(plan, ctx);
  if (normalizeSceneIds && request) plan = normalizePlanRuntimeToTarget(plan, request, ctx);
  if (normalizeSceneIds) plan = { ...plan, narration: narrationFromScenes(plan.scenes, plan.narration) };
  const creativeIntent = request ? inferCreativeIntent(request, ctx) : null;
  if (normalizeSceneIds) {
    const uploadedImageIds = new Set(
      (request?.input_media ?? []).filter((media) => media.kind === "image").map((media) => media.id),
    );
    const referencedImageIds = new Set(plan.scenes.flatMap((scene) => scene.reference_media_ids));
    const inputMediaIssues = [
      ...[...referencedImageIds]
        .filter((id) => !uploadedImageIds.has(id))
        .map((id) => `Scene plan references unknown uploaded image id ${id}.`),
      ...(uploadedImageIds.size > 0 && ![...referencedImageIds].some((id) => uploadedImageIds.has(id))
        ? ["Uploaded image inputs were ignored. Assign each contextually relevant image to at least one scene using reference_media_ids."]
        : []),
    ];
    const allQualityIssues = [
      ...validateProductionVideoPlan(plan, request ?? null),
      ...validateSceneContinuity(plan, { requireLedger: true }),
      ...(request ? validatePlanRuntimeCoverage(plan, request, ctx) : []),
      ...(request ? validatePlanAudioDurationFit(plan, request, ctx) : []),
      ...(request ? validateSceneSpeechAndVisualCoverage(plan, request, ctx) : []),
      ...audioPerformanceIssues(plan),
      ...voiceContinuityIssues(plan),
      ...inputMediaIssues,
      ...(request && creativeIntent ? validatePlanForCreativeIntent(plan, creativeIntent, request) : []),
    ];
    const qualityIssues = allQualityIssues.filter(isBlockingPlanIssue);
    const qualityWarnings = allQualityIssues.filter((issue) => !isBlockingPlanIssue(issue));
    if (qualityIssues.length > 0) {
      const state = readProjectState(ctx);
      const previousFailureDecisions = (state.decisions ?? []).filter(
        (decision: JsonDict) => decision.tool === "draft_video_plan" && decision.metadata?.validation_failed === true,
      );
      const previousFailures = previousFailureDecisions.length;
      const previousIssues = Array.isArray(previousFailureDecisions.at(-1)?.metadata?.issues)
        ? previousFailureDecisions.at(-1)!.metadata!.issues.map((issue: unknown) => String(issue))
        : [];
      const repairFailureLimit =
        previousFailures === 1 && repairIntroducedOnlyNewIssueFamilies(previousIssues, qualityIssues)
          ? MAX_REPAIR_INTRODUCED_REGRESSION_FAILURES
          : MAX_DRAFT_VIDEO_PLAN_REPAIR_FAILURES;
      updateProjectState(ctx, {
        status: {
          status: "running",
          stage: "plan_validation_failed",
          progress: 12,
          message: "Creative plan needs a pre-provider repair.",
        },
        decision: {
          tool: "draft_video_plan",
          decision: "Rejected draft plan before provider calls.",
          metadata: {
            validation_failed: true,
            repair_attempt: previousFailures + 1,
            issues: qualityIssues,
            warnings: qualityWarnings,
            creative_intent: creativeIntent,
            creative_vibe: plan.creative_vibe,
          },
        },
      });
      if (PROJECT_ID_PATTERN.test(ctx.project_id)) {
        await updateProjectStatus(ctx.project_id, {
          status: "running",
          stage: "plan_validation_failed",
          progress: 12,
          message: "Creative plan needs a pre-provider repair.",
        });
      }
      const message =
        "Draft plan failed first-run production quality checks before provider calls: " + qualityIssues.join(" ");
      const runtimeRepair = runtimeRepairInstruction(plan, request, ctx);
      if (previousFailures >= repairFailureLimit) {
        throw new Error(`Draft plan repair budget exhausted. ${message}`);
      }
      return {
        project_id: ctx.project_id,
        stage: "plan_validation_failed",
        validation_failed: true,
        issues: qualityIssues,
        creative_intent: creativeIntent,
        creative_vibe: plan.creative_vibe,
        message: [
          "Revise the plan to fix only these objective issues, then call draft_video_plan again before any provider calls.",
          "Focused repair rules:",
          ...focusedPlanRepairRules(qualityIssues),
          runtimeRepair,
        ].join("\n"),
        next_tools: ["draft_video_plan"],
      };
    }
  }
  mkdirSync(ctx.project_dir, { recursive: true });
  assertCanStartFreshPlan(ctx);
  clearRenderOutputs(ctx);
  writeJsonArtifact(ctx, "plan", plan);
  writeJsonArtifact(ctx, "failed_scenes", []);
  updateProjectState(ctx, {
    current_plan: plan,
    voiceover: null,
    images: [],
    videos: [],
    failures: [],
    final_video_path: null,
    manifest_path: null,
    status: { stage: "plan_drafted", progress: 15, message: "Creative plan drafted." },
    decision: {
      tool: "draft_video_plan",
      decision: `Drafted plan '${plan.title}' with ${plan.scenes.length} scene(s).`,
      metadata: { scene_ids: plan.scenes.map((scene) => scene.id), creative_intent: creativeIntent, creative_vibe: plan.creative_vibe },
    },
  });
  return {
    project_id: ctx.project_id,
    stage: "plan_drafted",
    plan,
    next_tools: ["generate_voiceover"],
  };
  });
}

export async function generateVoiceoverImpl(ctx: ProjectContext): Promise<JsonDict> {
  return withTiming(ctx, "workflow.generate_voiceover", null, async () => {
  try {
  assertProviderCallsAllowed(ctx, "voiceover");
  assertNoCompletedManifest(ctx, "generate_voiceover");
  const plan = loadVideoPlan(ctx);
  const request = requestFromProjectState(ctx);
  const existingVoiceover = readJsonArtifact<JsonDict>(ctx, "voiceover", null);
  if (existingVoiceover?.path && existsSync(String(existingVoiceover.path))) {
    updateProjectState(ctx, {
      status: { stage: "voiceover_generated", progress: 30, message: "Voiceover already generated." },
      decision: {
        tool: "generate_voiceover",
        decision: "Reused the voiceover already generated for the accepted plan.",
        metadata: { provider_rerendered: false },
      },
    });
    return {
      project_id: ctx.project_id,
      stage: "voiceover_generated",
      voiceover: withMediaUrl(existingVoiceover),
      reused: true,
      next_tools: ["generate_scene_images", "animate_scene_videos"],
    };
  }
  const suppliedAudio = request?.input_media.find((media) => media.kind === "audio") ?? null;
  if (suppliedAudio) {
    const sourcePath = inputMediaPath(suppliedAudio);
    const extension = path.extname(sourcePath) || ".audio";
    const outputDir = path.join(ctx.project_dir, "voiceover");
    const outputPath = path.join(outputDir, `uploaded${extension}`);
    mkdirSync(outputDir, { recursive: true });
    copyFileSync(sourcePath, outputPath);
    const duration = await probeMediaDuration(outputPath);
    const voiceover = {
      path: outputPath,
      model: "user-supplied",
      provider: "user",
      duration_seconds: duration,
      target_duration_seconds: planDurationSeconds(plan),
      source_media_id: suppliedAudio.id,
    };
    const durationIssues = voiceoverDurationIssues(voiceover, request, ctx, plan);
    if (durationIssues.length > 0) {
      throw new Error(`Uploaded voiceover does not fit the planned video naturally. ${durationIssues.join(" ")}`);
    }
    writeJsonArtifact(ctx, "voiceover", voiceover);
    updateProjectState(ctx, {
      voiceover,
      status: { stage: "voiceover_generated", progress: 30, message: "Uploaded voiceover is ready." },
      decision: {
        tool: "generate_voiceover",
        decision: "Used the user's attached audio as the authoritative full-video voiceover.",
        metadata: { source_media_id: suppliedAudio.id, duration_seconds: duration },
      },
    });
    return {
      project_id: ctx.project_id,
      stage: "voiceover_generated",
      voiceover: withMediaUrl(voiceover),
      next_tools: ["generate_scene_images", "animate_scene_videos"],
    };
  }
  if (plan.scenes.some((s) => s.on_camera === true)) {
    // Talking-photo and mixed UGC renders use per-scene audio: on-camera clips
    // need lip-sync audio, and b-roll gets its own per-scene VO for stitching.
    // The single global narration mp3 would be unused dead weight. Skip rendering
    // and persisting the `voiceover` artifact, but synthesize all scene audio
    // now so TTS/auth/credit failures happen before paid image/video calls.
    const voiceCtx = voiceContextForPlan(ctx, plan);
    const voiceReferenceId = resolveVoiceReferenceId(plan, voiceCtx);
    const voicedScenes = plan.scenes.filter((scene) => String(scene.narration ?? "").trim());
    const sceneVoiceovers = await ensureSceneVoiceovers(voiceCtx, voicedScenes, voiceReferenceId, plan);
    const coverageIssues = actualMixedVoiceoverCoverageIssues(plan, sceneVoiceovers, requestFromProjectState(ctx));
    if (coverageIssues.length > 0) {
      for (const voiceover of sceneVoiceovers) {
        try {
          rmSync(String(voiceover.path), { force: true });
        } catch {
          // best-effort cleanup; rejected takes should not be reused by a repaired plan.
        }
      }
      const state = readProjectState(ctx);
      const previousFailures = (state.decisions ?? []).filter(
        (decision: JsonDict) => decision.tool === "generate_voiceover" && decision.metadata?.validation_failed === true,
      ).length;
      updateProjectState(ctx, {
        status: {
          stage: "voiceover_validation_failed",
          progress: 32,
          message: "Scene voiceovers do not cover the requested runtime naturally.",
          error: coverageIssues.join(" "),
        },
        decision: {
          tool: "generate_voiceover",
          decision: "Rejected measured per-scene voiceover coverage before Magic Hour image/video calls.",
          metadata: {
            validation_failed: true,
            repair_attempt: previousFailures + 1,
            issues: coverageIssues,
            scene_voiceovers: sceneVoiceovers.map((voiceover) => ({
              scene_id: voiceover.scene_id,
              duration_seconds: voiceover.duration_seconds,
            })),
          },
        },
      });
      if (previousFailures >= 1) {
        throw new Error("Scene voiceover coverage still does not fit after one repair attempt. " + coverageIssues.join(" "));
      }
      return {
        project_id: ctx.project_id,
        stage: "voiceover_validation_failed",
        validation_failed: true,
        issues: coverageIssues,
        message:
          "Redraft the video plan with scene durations that match the measured speech. Do not continue to image or video generation until draft_video_plan passes again.",
        next_tools: ["draft_video_plan"],
      };
    }
    updateProjectState(ctx, {
      status: { stage: "voiceover_generated", progress: 30, message: "Voiceover skipped (per-scene audio plan)." },
      decision: {
        tool: "generate_voiceover",
        decision: "Generated per-scene voiceover audio and skipped unused global voiceover.",
        metadata: {
          skipped: true,
          reason: "per_scene_audio",
          scene_voiceover_count: sceneVoiceovers.length,
          scene_ids: sceneVoiceovers.map((voiceover) => voiceover.scene_id),
        },
      },
    });
    return {
      project_id: ctx.project_id,
      stage: "voiceover_generated",
      voiceover: null,
      voiceover_skipped: true,
      scene_voiceovers: sceneVoiceovers.map((voiceover) => withMediaUrl(voiceover)),
      next_tools: ["generate_scene_images", "animate_scene_videos"],
    };
  }
  const voiceCtx = voiceContextForPlan(ctx, plan);
  const voiceReferenceId = resolveVoiceReferenceId(plan, voiceCtx);
  const voiceover = await generateVoiceoverAsset(voiceCtx, plan.narration, planDurationSeconds(plan), voiceReferenceId, plan);
  const durationIssues = voiceoverDurationIssues(voiceover, requestFromProjectState(ctx), ctx, plan);
  if (durationIssues.length > 0) {
    const voiceoverTooShort = durationIssues.some((issue) => issue.includes("voiceover is only"));
    const repairMessage = voiceoverTooShort
      ? "Redraft the video plan with enough natural spoken narration to meet the stated minimum. Do not continue to image or video generation until draft_video_plan passes again."
      : "Redraft the video plan with shorter, cleaner spoken narration. Do not continue to image or video generation until draft_video_plan passes again.";
    try {
      rmSync(String(voiceover.path), { force: true });
    } catch {
      // best-effort cleanup; the artifact is not persisted.
    }
    const state = readProjectState(ctx);
    const previousFailures = (state.decisions ?? []).filter(
      (decision: JsonDict) => decision.tool === "generate_voiceover" && decision.metadata?.validation_failed === true,
    ).length;
    updateProjectState(ctx, {
      voiceover: null,
      status: {
        stage: "voiceover_validation_failed",
        progress: 32,
        message: voiceoverTooShort
          ? "Voiceover needs more natural spoken coverage before rendering."
          : "Voiceover needs a shorter natural script before rendering.",
        error: durationIssues.join(" "),
      },
      decision: {
        tool: "generate_voiceover",
        decision: "Rejected generated voiceover before Magic Hour image/video calls.",
        metadata: {
          validation_failed: true,
          repair_attempt: previousFailures + 1,
          issues: durationIssues,
          duration_seconds: voiceover.duration_seconds,
          target_duration_seconds: voiceover.target_duration_seconds,
          word_count: countSpokenWords(plan.narration),
        },
      },
    });
    if (previousFailures >= 1) {
      throw new Error("Voiceover duration still does not fit after one repair attempt. " + durationIssues.join(" "));
    }
    return {
      project_id: ctx.project_id,
      stage: "voiceover_validation_failed",
      validation_failed: true,
      issues: durationIssues,
      message: repairMessage,
      next_tools: ["draft_video_plan"],
    };
  }
  const alignedPlan = alignPlanToMeasuredVoiceover(plan, voiceover);
  const timingAdjusted = alignedPlan.scenes.some(
    (scene, index) => scene.duration_seconds !== plan.scenes[index]?.duration_seconds,
  );
  if (timingAdjusted) {
    writeJsonArtifact(ctx, "plan", alignedPlan);
  }
  writeJsonArtifact(ctx, "voiceover", voiceover);
  updateProjectState(ctx, {
    ...(timingAdjusted ? { current_plan: alignedPlan } : {}),
    voiceover,
    status: { stage: "voiceover_generated", progress: 30, message: "Voiceover generated." },
    decision: {
      tool: "generate_voiceover",
      decision: timingAdjusted
        ? "Generated voiceover and aligned scene cut durations to measured speech boundaries."
        : "Generated voiceover for the saved narration.",
      metadata: {
        target_duration_seconds: voiceover.target_duration_seconds,
        speech_end_margin_seconds: voiceover.speech_end_margin_seconds ?? null,
        scene_timing_aligned: timingAdjusted,
        ...(timingAdjusted
          ? {
              previous_scene_durations: plan.scenes.map((scene) => scene.duration_seconds),
              aligned_scene_durations: alignedPlan.scenes.map((scene) => scene.duration_seconds),
            }
          : {}),
      },
    },
  });
  return {
    project_id: ctx.project_id,
    stage: "voiceover_generated",
    voiceover: withMediaUrl(voiceover),
    ...(timingAdjusted ? { plan: alignedPlan } : {}),
    next_tools: ["generate_scene_images", "animate_scene_videos"],
  };
  } catch (err) {
    const state = readProjectState(ctx);
    if (state.status?.stage !== "voiceover_validation_failed") {
      updateProjectState(ctx, {
        status: {
          stage: "voiceover_failed",
          progress: 30,
          message: "Voiceover generation failed before Magic Hour image/video calls.",
          error: providerErrorMessage(err),
        },
        decision: {
          tool: "generate_voiceover",
          decision: "Voiceover provider failed before paid Magic Hour image/video calls.",
          metadata: {
            error: providerErrorMessage(err),
            audio_provider: ctx.audio_provider,
            audio_model: ctx.audio_model,
          },
        },
      });
    }
    throw err;
  }
  });
}

export async function generateSceneImagesImpl(
  ctx: ProjectContext,
  sceneIds: string[] | null = null,
  options: { model?: string | null; image_resolution?: string | null; image_style_tool?: string | null } = {},
): Promise<JsonDict> {
  assertProviderCallsAllowed(ctx);
  assertNoCompletedManifest(ctx, "generate_scene_images");
  const plan = loadVideoPlan(ctx);
  const request = requestFromProjectState(ctx);
  const uploadedImages = new Map(
    (request?.input_media ?? [])
      .filter((media) => media.kind === "image")
      .map((media) => [media.id, inputMediaPath(media)] as const),
  );
  const selectedIds = sceneIdsFor(plan, sceneIds);
  const existingImages = readJsonArtifact<JsonDict[]>(ctx, "images", []) ?? [];
  const existingImageIds = new Set(existingImages.map((image) => String(image.scene_id ?? "")));
  const existingFailures = readJsonArtifact<JsonDict[]>(ctx, "failed_scenes", []) ?? [];
  const blockedRetryIds = new Set(
    existingFailures
      .filter((failure) => String(failure.stage ?? "") === "image_generation")
      .map((failure) => String(failure.scene_id ?? ""))
      .filter((sceneId) => selectedIds.has(sceneId) && !existingImageIds.has(sceneId)),
  );
  if (blockedRetryIds.size > 0) {
    const blocked = [...blockedRetryIds].sort();
    updateProjectState(ctx, {
      images: existingImages,
      failures: existingFailures,
      status: {
        stage: "image_generation_failed",
        progress: 45,
        message: "Scene image generation failed without automatic paid retries.",
        error: `Blocked repeated image submissions for: ${blocked.join(", ")}.`,
      },
      decision: {
        tool: "generate_scene_images",
        decision: "Blocked automatic paid image retry after a provider failure.",
        metadata: { blocked_scene_ids: blocked },
      },
    });
    throw new Error(
      `Image generation already failed for ${blocked.join(", ")} in this first run. ` +
      "Automatic paid retries are disabled; use an explicit scene edit/regeneration request after correcting the prompt.",
    );
  }
  const scenes = plan.scenes
    .filter((scene) => selectedIds.has(scene.id))
    .filter((scene) => !existingImageIds.has(scene.id))
    .map((scene) => ({ ...scene, image_prompt: providerImagePrompt(plan, scene) }));
  if (scenes.length === 0) {
    updateProjectState(ctx, {
      images: existingImages,
      failures: existingFailures,
      status: { stage: "images_generated", progress: 45, message: "Scene images already exist; reusing them." },
      decision: {
        tool: "generate_scene_images",
        decision: "Reused existing scene images; skipped duplicate Magic Hour image generation.",
        metadata: { requested_scene_ids: [...selectedIds], reused_scene_ids: [...existingImageIds].filter((id) => selectedIds.has(id)) },
      },
    });
    return {
      project_id: ctx.project_id,
      stage: "images_generated",
      images: existingImages.map((image) => withMediaUrl(image)),
      failed_scenes: existingFailures,
      next_tools: ["animate_scene_videos"],
    };
  }
  const imageCtx = contextWithMagicImageSettings(ctx, {
    model: request?.image_model ? ctx.image_model : options.model || ctx.image_model,
    image_resolution: options.image_resolution || ctx.image_resolution,
    image_style_tool: options.image_style_tool || ctx.image_style_tool,
  });
  const imageResults = await withTiming(ctx, "workflow.generate_scene_images", {
    scene_count: scenes.length,
    scene_ids: scenes.map((scene) => scene.id),
    model: imageCtx.image_model,
    resolution: imageCtx.image_resolution,
  }, async () => {
    const existingImageByScene = new Map(existingImages.map((image) => [String(image.scene_id), image]));
    const pendingImageByScene = new Map<string, Promise<JsonDict>>();
    const pending = scenes.map((scene) => {
      const sceneIndex = plan.scenes.findIndex((item) => item.id === scene.id);
      const previous = sceneIndex > 0 ? plan.scenes[sceneIndex - 1] : null;
      const useContinuityReference = Boolean(previous && shouldChainPreviousKeyframe(plan, sceneIndex));
      const referenceSceneIndex = useContinuityReference
        ? sceneIndex - 1
        : identityReferenceSceneIndex(plan, sceneIndex);
      const referenceScene = referenceSceneIndex === null ? null : plan.scenes[referenceSceneIndex] ?? null;
      const referencePending = referenceScene ? pendingImageByScene.get(referenceScene.id) : null;
      const referenceExisting = referenceScene ? existingImageByScene.get(referenceScene.id) : null;
      const referenceImage = referenceScene
        ? referencePending
          ? referencePending.catch(() => null)
          : Promise.resolve(referenceExisting ?? null)
        : Promise.resolve(null);
      const generation = referenceImage.then(async (prior) => {
        const uploadedReferences = scene.reference_media_ids
          .map((id) => uploadedImages.get(id))
          .filter((item): item is string => Boolean(item));
        const continuityReference = typeof prior?.path === "string" ? String(prior.path) : null;
        const references = [
          ...(continuityReference ? [continuityReference] : []),
          ...uploadedReferences,
        ].slice(0, 10);
        const sceneForGeneration =
          continuityReference && !useContinuityReference
            ? {
                ...scene,
                image_prompt:
                  `${scene.image_prompt} Reference-use rule: preserve only the recurring subject's exact identity, face, body, wardrobe, and visual style from the reference. ` +
                  "Rebuild the current scene's stated location, time, pose, action, framing, and object arrangement; do not copy the reference background or prior event.",
              }
            : scene;
        const image = await generateImageAsset(imageCtx, sceneForGeneration, references);
        return {
          ...image,
          continuity_reference_scene_id: continuityReference ? referenceScene?.id ?? null : null,
          continuity_reference_mode: continuityReference
            ? useContinuityReference
              ? "scene_continuation"
              : "identity_only"
            : null,
        };
      });
      pendingImageByScene.set(scene.id, generation);
      return generation;
    });
    return Promise.allSettled(pending);
  });
  const images: JsonDict[] = [];
  const failures: JsonDict[] = [];

  scenes.forEach((scene, index) => {
    const result = imageResults[index]!;
    if (result.status === "rejected") {
      console.warn(`Scene image generation failed for ${scene.id}`, result.reason);
      failures.push({ scene_id: scene.id, stage: "image_generation", error: String(result.reason?.message ?? result.reason) });
    } else {
      images.push(result.value);
    }
  });

  const mergedImages = orderedSceneAssets(plan, upsertSceneAssets(existingImages, images));
  const failureFreeImages = new Set(images.map((image) => String(image.scene_id)));
  let updatedFailures = clearSceneFailures(existingFailures, failureFreeImages, new Set(["image_generation"]));
  updatedFailures = recordSceneFailures(updatedFailures, failures);
  writeJsonArtifact(ctx, "images", mergedImages);
  writeJsonArtifact(ctx, "failed_scenes", updatedFailures);
  updateProjectState(ctx, {
    provider_settings: {
      image_model: imageCtx.image_model,
      image_resolution: imageCtx.image_resolution,
      image_style_tool: imageCtx.image_style_tool,
    },
    images: mergedImages,
    failures: updatedFailures,
    status: { stage: "images_generated", progress: 45, message: "Scene images generated." },
    decision: {
      tool: "generate_scene_images",
      decision: `Generated ${images.length} scene image(s).`,
      metadata: {
        requested_scene_ids: scenes.map((scene) => scene.id),
        failed_scene_ids: failures.map((failure) => failure.scene_id),
      },
    },
  });
  return {
    project_id: ctx.project_id,
    stage: "images_generated",
    images: mergedImages.map((image) => withMediaUrl(image)),
    failed_scenes: updatedFailures,
    next_tools: ["animate_scene_videos"],
  };
}

export async function generateStandaloneImagesImpl(
  ctx: ProjectContext,
  prompt: string,
  options: {
    image_count?: number | null;
    model?: string | null;
    image_resolution?: string | null;
    image_style_tool?: string | null;
  } = {},
): Promise<JsonDict> {
  const request = requestFromProjectState(ctx);
  if (!request || classifyMagicHourRequest(request).capability_id !== "standalone_image") {
    throw new Error("generate_magic_hour_images is only for image-only projects; use the video planning and scene tools for video requests.");
  }
  const existingPlan = readJsonArtifact(ctx, "plan");
  if (existingPlan !== null) {
    throw new Error("generate_magic_hour_images is only for image-only projects; use generate_scene_images for video scenes.");
  }
  const imageCtx = contextWithMagicImageSettings(ctx, {
    model: request.image_model ? ctx.image_model : options.model || ctx.image_model,
    image_resolution: options.image_resolution || ctx.image_resolution,
    image_style_tool: options.image_style_tool || ctx.image_style_tool,
  });
  const images = await withTiming(ctx, "workflow.generate_standalone_images", {
    image_count: options.image_count ?? 1,
    model: imageCtx.image_model,
    resolution: imageCtx.image_resolution,
  }, () =>
    generateStandaloneImageAssets(imageCtx, prompt, {
      image_count: options.image_count ?? 1,
      name: `${ctx.project_id}-standalone-image`,
    }),
  );
  const payload = images.map((image) => withMediaUrl(image));
  const manifest: JsonDict = {
    project_id: ctx.project_id,
    title: "Magic Hour image generation",
    created_at: new Date().toISOString(),
    workflow: "standalone_image",
    prompt,
    provider_settings: {
      image_model: imageCtx.image_model,
      image_resolution: imageCtx.image_resolution,
      image_style_tool: imageCtx.image_style_tool,
    },
    images: payload,
    final_image_path: images[0]?.path ?? null,
    final_image_url: images[0] ? publicMediaPath(images[0].path) : null,
    manifest_path: path.join(ctx.project_dir, "manifest.json"),
  };
  writeJsonArtifact(ctx, "images", images);
  writeJsonArtifact(ctx, "manifest", manifest);
  updateProjectState(ctx, {
    provider_settings: manifest.provider_settings,
    images,
    manifest,
    manifest_path: manifest.manifest_path,
    final_image_path: manifest.final_image_path,
    status: { stage: "image_generated", progress: 100, message: "Image is ready." },
    decision: {
      tool: "generate_magic_hour_images",
      decision: `Generated ${images.length} standalone image(s).`,
      metadata: { prompt, image_count: images.length },
    },
  });
  return {
    project_id: ctx.project_id,
    stage: "image_generated",
    images: payload,
    manifest,
  };
}

export function requestClarificationImpl(ctx: ProjectContext, questions: string[], reason = ""): JsonDict {
  const state = readProjectState(ctx);
  if (state.current_plan) {
    const existingError = String(state.status?.error ?? "").trim();
    throw new Error(
      "request_clarification refused because a video plan already exists. " +
        "Continue the render, repair the saved plan, or report the provider failure instead of asking for missing prompt details." +
        (existingError ? ` Existing error: ${existingError}` : ""),
    );
  }
  if (paidMediaGenerationStarted(ctx)) {
    throw new Error(
      "request_clarification refused because paid media generation has already started. " +
        "Use inspect_render_status, provider recovery, stitching, or an explicit user-requested edit path instead.",
    );
  }
  const cleaned = questions.map((question) => question.trim()).filter(Boolean).slice(0, 4);
  const manifest: JsonDict = {
    project_id: ctx.project_id,
    title: "Magic Agent needs input",
    created_at: new Date().toISOString(),
    workflow: "clarification",
    render_status: "needs_input",
    reason,
    questions: cleaned,
    manifest_path: path.join(ctx.project_dir, "manifest.json"),
  };
  writeJsonArtifact(ctx, "manifest", manifest);
  updateProjectState(ctx, {
    manifest,
    manifest_path: manifest.manifest_path,
    status: { stage: "needs_input", progress: 0, message: cleaned[0] ?? "Magic Agent needs more information." },
    decision: {
      tool: "request_clarification",
      decision: "Asked the user for missing generation details before provider calls.",
      metadata: { reason, questions: cleaned },
    },
  });
  return { project_id: ctx.project_id, stage: "needs_input", questions: cleaned, reason, manifest };
}

// Render the on-camera (UGC) talking scenes. Each pair feeds its KEYFRAME IMAGE +
// per-scene audio into AI Talking Photo (one submitted provider job). A talking
// failure is recorded with its provider job id when available; stitch then tries
// to recover that same job before any user-triggered retry spends more credits.
//
// All failures are recorded INLINE here with distinct stages, so the caller must NOT
// re-record them — it only pushes the non-null VideoAssets into `videos`.
async function renderTalkingPairs(
  videoCtx: ProjectContext,
  talkingPairs: Array<[Scene, any]>,
  sceneAudioPromise: Promise<Array<{ scene_id: string; path: string; duration_seconds: number }>>,
  failures: JsonDict[],
): Promise<Array<VideoAsset | null>> {
  const sceneAudios = await sceneAudioPromise;
  const audioByScene = new Map(sceneAudios.map((audio) => [audio.scene_id, audio]));
  return Promise.all(
    talkingPairs.map(async ([scene, image]): Promise<VideoAsset | null> => {
      const audio = audioByScene.get(scene.id);
      if (!audio) {
        failures.push({
          scene_id: scene.id,
          stage: "talking",
          error: `No scene audio for talking scene ${scene.id}`,
        });
        return null;
      }
      const allowedScene = maxAllowedSceneSpeechSeconds(scene.duration_seconds);
      if (audio.duration_seconds > allowedScene) {
        failures.push({
          scene_id: scene.id,
          stage: "voiceover_validation",
          error:
            `Scene voiceover is ${audio.duration_seconds.toFixed(1)}s for ${scene.duration_seconds}s scene ` +
            `(max ${allowedScene.toFixed(1)}s). Redraft shorter narration before AI Talking Photo.`,
        });
        return null;
      }
      try {
        return await generateTalkingClip(videoCtx, scene, String(image.path), audio.path, audio.duration_seconds);
      } catch (err) {
        console.warn(`AI Talking Photo failed for ${scene.id}; preserving recoverable job metadata`, err);
        const providerMetadata = providerJobFailureMetadata(err);
        if (!providerMetadata) {
          try {
            return await generateVideoAsset(videoCtx, scene, image as any);
          } catch (fallbackErr) {
            failures.push({
              scene_id: scene.id,
              stage: "video_generation",
              error: `Talking Photo failed without a recoverable job id, and I2V fallback also failed: ${providerErrorMessage(fallbackErr)}`,
            });
            return null;
          }
        }
        failures.push({
          scene_id: scene.id,
          stage: "talking",
          error: providerErrorMessage(err),
          ...providerMetadata,
        });
        return null;
      }
    }),
  );
}

// Re-render a SINGLE scene's video through the same mechanism the scene was
// authored with, so the agent's recovery tools (retry/regenerate) don't destroy
// the talking treatment. On-camera scenes go through AI Talking Photo (keyframe
// image + a per-scene voiceover rendered with the plan's resolved voice). A HARD
// talking-render failure falls back to a silent imageToVideo clip in this explicit
// recovery path so the user-requested edit still produces something. B-roll scenes
// always use silent imageToVideo.
//
// NOTE: unlike `renderTalkingPairs` (batch path, which records soft "talking"
// failures inline and returns null), this helper records NOTHING. A hard
// double-failure (talking AND the silent fallback both throw) propagates to the
// caller, because the recovery tools (retry/regenerate) own their own failure
// bookkeeping and should surface the error to the agent.
async function renderSingleSceneVideo(
  videoCtx: ProjectContext,
  plan: VideoPlan,
  scene: Scene,
  image: JsonDict,
): Promise<VideoAsset> {
  if (scene.on_camera === true) {
    const voiceCtx = voiceContextForPlan(videoCtx, plan);
    const voiceReferenceId = resolveVoiceReferenceId(plan, voiceCtx);
    const [vo] = await generateSceneVoiceovers(voiceCtx, [scene], voiceReferenceId, plan);
    if (!vo) throw new Error(`No scene voiceover generated for ${scene.id}`);
    const allowedScene = maxAllowedSceneSpeechSeconds(scene.duration_seconds);
    if (vo.duration_seconds > allowedScene) {
      throw new Error(
        `Scene voiceover is ${vo.duration_seconds.toFixed(1)}s for ${scene.duration_seconds}s scene ` +
          `(max ${allowedScene.toFixed(1)}s). Redraft shorter narration before AI Talking Photo.`,
      );
    }
    try {
      return await generateTalkingClip(videoCtx, scene, String(image.path), vo.path, vo.duration_seconds);
    } catch (err) {
      console.warn(`Talking re-render failed for ${scene.id}; falling back to silent clip`, err);
      return await generateVideoAsset(videoCtx, scene, image as any);
    }
  }
  return await generateVideoAsset(videoCtx, scene, image as any);
}

export async function animateSceneVideosImpl(
  ctx: ProjectContext,
  sceneIds: string[] | null = null,
  options: { model?: string | null; resolution?: string | null; audio?: boolean | null } = {},
): Promise<JsonDict> {
  assertProviderCallsAllowed(ctx);
  assertNoCompletedManifest(ctx, "animate_scene_videos");
  const plan = loadVideoPlan(ctx);
  const existingVideos = readJsonArtifact<JsonDict[]>(ctx, "videos", []) ?? [];
  const existingVideoIds = new Set(existingVideos.map((video) => String(video.scene_id ?? "")));
  const isFirstFullRender = existingVideos.length === 0 && !existsSync(artifactPath(ctx, "manifest"));
  const selectedIds = sceneIdsFor(plan, isFirstFullRender ? null : sceneIds);
  const selectedScenes = plan.scenes.filter((scene) => selectedIds.has(scene.id) && !existingVideoIds.has(scene.id));
  const existingFailures = readJsonArtifact<JsonDict[]>(ctx, "failed_scenes", []) ?? [];
  if (selectedScenes.length === 0) {
    updateProjectState(ctx, {
      videos: existingVideos,
      failures: existingFailures,
      status: { stage: "videos_animated", progress: 70, message: "Scene videos already exist; reusing them." },
      decision: {
        tool: "animate_scene_videos",
        decision: "Reused existing scene videos; skipped duplicate Magic Hour video generation.",
        metadata: { requested_scene_ids: [...selectedIds], reused_scene_ids: [...existingVideoIds].filter((id) => selectedIds.has(id)) },
      },
    });
    return {
      project_id: ctx.project_id,
      stage: "videos_animated",
      videos: existingVideos.map((video) => withMediaUrl(video)),
      failed_scenes: existingFailures,
      next_tools: ["stitch_final_video"],
    };
  }
  const blockedRecoverableRerenders = !existsSync(artifactPath(ctx, "manifest"))
    ? existingFailures.filter(
        (failure) =>
          selectedIds.has(String(failure.scene_id ?? "")) &&
          providerJobFailureMetadata(failure),
      )
    : [];
  if (blockedRecoverableRerenders.length > 0) {
    throw new Error(
      "Refusing to submit duplicate provider render(s) for recoverable scene job(s): " +
        blockedRecoverableRerenders.map((failure) => String(failure.scene_id)).join(", ") +
        ". Call stitch_final_video to recover existing job ids, or wait for an explicit user edit before regenerating.",
    );
  }
  const videoCtx = contextWithMagicVideoSettings(ctx, {
    model: requestFromProjectState(ctx)?.video_model ? ctx.video_model : options.model || ctx.video_model,
    resolution: options.resolution || ctx.resolution,
    audio: options.audio == null ? ctx.video_audio : options.audio,
    scenes: selectedScenes,
  });
  const existingImages = readJsonArtifact<JsonDict[]>(ctx, "images", []) ?? [];
  const imageByScene = new Map(existingImages.map((image) => [String(image.scene_id), image]));
  const videoScenePairs = selectedScenes
    .filter((scene) => imageByScene.has(scene.id))
    .map((scene) => [
      { ...scene, video_prompt: providerVideoPrompt(plan, scene) },
      imageByScene.get(scene.id)!,
    ] as [Scene, JsonDict]);
  const missingImageFailures = selectedScenes
    .filter((scene) => !imageByScene.has(scene.id))
    .map((scene) => ({
      scene_id: scene.id,
      stage: "video_generation",
      error: "No image asset exists for this scene.",
    }));
  if (videoScenePairs.length === 0) {
    const existingFailures = readJsonArtifact<JsonDict[]>(ctx, "failed_scenes", []) ?? [];
    const updatedFailures = recordSceneFailures(existingFailures, missingImageFailures);
    writeJsonArtifact(ctx, "failed_scenes", updatedFailures);
    updateProjectState(ctx, {
      failures: updatedFailures,
      status: { stage: "video_generation_blocked", progress: 65, message: "No scene images are ready for animation." },
    });
    throw new Error("No scene images completed, so no videos can be animated.");
  }

  const videos: JsonDict[] = [];
  const failures: JsonDict[] = [...missingImageFailures];

  // Partition by render mechanism. On-camera (UGC) talking scenes feed their
  // KEYFRAME IMAGE + per-scene audio straight into AI Talking Photo (one submitted job,
  // NO silent imageToVideo pass — that's the latency win). B-roll cutaways still
  // render a silent imageToVideo clip and get their own VO at stitch time.
  const talkingPairs = videoScenePairs.filter(([scene]) => scene.on_camera === true);
  const brollPairs = videoScenePairs.filter(([scene]) => scene.on_camera !== true);

  // Per-scene TTS only needs the plan/script, not any rendered clip, so kick it
  // off CONCURRENTLY with both render batches (overlapping latency) and await it
  // inside the talking branch.
  const voiceCtx = voiceContextForPlan(videoCtx, plan);
  const voiceReferenceId = resolveVoiceReferenceId(plan, voiceCtx);
  const sceneAudioPromise: Promise<Array<{ scene_id: string; path: string; duration_seconds: number }>> =
    talkingPairs.length > 0
      ? ensureSceneVoiceovers(voiceCtx, talkingPairs.map(([scene]) => scene), voiceReferenceId, plan)
      : Promise.resolve([]);

  const [brollResults, talkingResults] = await withTiming(ctx, "workflow.animate_scene_videos", {
    selected_scene_count: videoScenePairs.length,
    broll_scene_ids: brollPairs.map(([scene]) => scene.id),
    talking_scene_ids: talkingPairs.map(([scene]) => scene.id),
    video_model: videoCtx.video_model,
    resolution: videoCtx.resolution,
  }, () =>
    Promise.all([
      generateVideoAssetsBatch(videoCtx, brollPairs as Array<[Scene, any]>),
      renderTalkingPairs(videoCtx, talkingPairs as Array<[Scene, any]>, sceneAudioPromise, failures),
    ]),
  );

  brollPairs.forEach(([scene], index) => {
    const result = brollResults[index]!;
    if (result instanceof Error) {
      console.warn(`Scene video generation failed for ${scene.id}`, result);
      failures.push({
        scene_id: scene.id,
        stage: "video_generation",
        error: result.message,
        ...providerJobFailureMetadata(result),
      });
    } else {
      videos.push(result);
    }
  });
  // renderTalkingPairs records all of its own failures inline (with distinct stages),
  // so we only collect the produced clips here. null = scene produced no clip.
  talkingResults.forEach((result) => {
    if (result) videos.push(result);
  });

  const mergedVideos = orderedSceneAssets(plan, upsertSceneAssets(existingVideos, videos));
  const successfulVideoIds = new Set(videos.map((video) => String(video.scene_id)));
  let updatedFailures = clearSceneFailures(existingFailures, successfulVideoIds, new Set(["video_generation", "talking"]));
  updatedFailures = recordSceneFailures(updatedFailures, failures);
  const recoverableFailures = updatedFailures.filter((failure) => providerJobFailureMetadata(failure));
  writeJsonArtifact(ctx, "videos", mergedVideos);
  writeJsonArtifact(ctx, "failed_scenes", updatedFailures);
  updateProjectState(ctx, {
    provider_settings: {
      video_model: videoCtx.video_model,
      video_resolution: videoCtx.resolution,
      video_audio: videoCtx.video_audio,
    },
    videos: mergedVideos,
    failures: updatedFailures,
    status: {
      stage: recoverableFailures.length > 0 ? "videos_provider_recoverable" : "videos_animated",
      progress: 70,
      message:
        recoverableFailures.length > 0
          ? "Some provider jobs are still recoverable; stitching will check those job ids before regenerating."
          : "Scene videos animated.",
    },
    decision: {
      tool: "animate_scene_videos",
      decision: `Animated ${videos.length} scene video(s).`,
      metadata: {
        requested_scene_ids: videoScenePairs.map(([scene]) => scene.id),
        failed_scene_ids: failures.map((failure) => failure.scene_id),
      },
    },
  });
  return {
    project_id: ctx.project_id,
    stage: recoverableFailures.length > 0 ? "videos_provider_recoverable" : "videos_animated",
    videos: mergedVideos.map((video) => withMediaUrl(video)),
    failed_scenes: updatedFailures,
    next_tools: ["stitch_final_video", "retry_scene"],
  };
}

async function recoverProviderFailuresBeforeStitch(
  ctx: ProjectContext,
  plan: VideoPlan,
  images: JsonDict[],
  videos: JsonDict[],
  failedScenes: JsonDict[],
): Promise<{
  videos: JsonDict[];
  failedScenes: JsonDict[];
  recovered: VideoAsset[];
  attempted: number;
}> {
  const videoIds = new Set(videos.map((video) => String(video.scene_id)));
  const sceneById = new Map(plan.scenes.map((scene) => [scene.id, scene]));
  const imageBySceneId = new Map(images.map((image) => [String(image.scene_id), image]));
  const recovered: VideoAsset[] = [];
  const remainingFailures: JsonDict[] = [];
  let attempted = 0;

  for (const failure of failedScenes) {
    const sceneId = String(failure.scene_id ?? "");
    if (videoIds.has(sceneId)) continue;
    const metadata = providerJobFailureMetadata(failure);
    const scene = sceneById.get(sceneId);
    if (!metadata || !scene) {
      remainingFailures.push(failure);
      continue;
    }
    if (failure.recovery_checked_at || failure.recovery_error) {
      remainingFailures.push(failure);
      continue;
    }

    const image = metadata.provider_kind === "i2v" ? imageBySceneId.get(sceneId) : null;
    const timedOutI2v =
      metadata.provider_kind === "i2v" && /\btimed out\b/i.test(String(failure.error ?? ""));
    if (timedOutI2v && image?.path) {
      try {
        const fallback = await generateImageFallbackVideoAsset(
          ctx,
          scene,
          image as any,
          `provider job timed out: ${String(failure.error ?? "unknown provider timeout")}`,
          metadata.provider_job_id,
        );
        recovered.push(fallback);
        videoIds.add(fallback.scene_id);
        continue;
      } catch (fallbackErr) {
        remainingFailures.push({
          ...failure,
          fallback_error: providerErrorMessage(fallbackErr),
          recovery_checked_at: new Date().toISOString(),
        });
        continue;
      }
    }

    attempted += 1;
    try {
      const asset = await recoverVideoAssetFromProviderJob(ctx, { ...metadata, scene } as RecoverVideoAssetJob);
      recovered.push(asset);
      videoIds.add(asset.scene_id);
    } catch (err) {
      if (image?.path) {
        try {
          const fallback = await generateImageFallbackVideoAsset(
            ctx,
            scene,
            image as any,
            `provider job stalled: ${providerErrorMessage(err)}`,
            metadata.provider_job_id,
          );
          recovered.push(fallback);
          videoIds.add(fallback.scene_id);
          continue;
        } catch (fallbackErr) {
          remainingFailures.push({
            ...failure,
            recovery_error: providerErrorMessage(err),
            fallback_error: providerErrorMessage(fallbackErr),
            recovery_checked_at: new Date().toISOString(),
          });
          continue;
        }
      }
      remainingFailures.push({
        ...failure,
        recovery_error: providerErrorMessage(err),
        recovery_checked_at: new Date().toISOString(),
      });
    }
  }

  const mergedVideos = orderedSceneAssets(plan, upsertSceneAssets(videos, recovered));
  return { videos: mergedVideos, failedScenes: remainingFailures, recovered, attempted };
}

async function existingSceneVoiceover(
  ctx: ProjectContext,
  sceneId: string,
): Promise<{ scene_id: string; path: string; duration_seconds: number } | null> {
  const audioPath = path.join(ctx.project_dir, "voiceover", "scenes", `${sceneId}.${ctx.audio_format}`);
  if (!existsSync(audioPath)) return null;
  const durations = await probeMediaStreamDurations(audioPath);
  const duration = durations.audio_duration_seconds ?? durations.format_duration_seconds;
  if (!Number.isFinite(Number(duration)) || Number(duration) <= 0) return null;
  return { scene_id: sceneId, path: audioPath, duration_seconds: round3(Number(duration)) };
}

/**
 * Build the per-scene stitch inputs for the audio-preserving assembler.
 *
 * Talking scenes (on-camera / embedded audio) reuse their own lip-sync mp3 that
 * Task 5 attached to the video entry. B-roll cutaways carry no audio, so each
 * gets a per-scene VO take generated on demand so the section is never silent.
 */
async function buildPerSceneStitchInputs(
  ctx: ProjectContext,
  plan: VideoPlan,
  videos: JsonDict[],
): Promise<PerSectionScene[]> {
  const result: PerSectionScene[] = [];
  const voiceCtx = voiceContextForPlan(ctx, plan);
  const voiceReferenceId = resolveVoiceReferenceId(plan, voiceCtx);
  const sceneById = new Map(plan.scenes.map((scene) => [scene.id, scene]));
  const brollScenes = videos
    .filter((video) => video.on_camera !== true && video.has_embedded_audio !== true)
    .map((video) => {
      const scene = sceneById.get(String(video.scene_id));
      if (!scene) {
        throw new Error(`No plan scene matched video entry ${String(video.scene_id)} while building stitch inputs.`);
      }
      return scene;
    });
  const brollVoiceovers = new Map<string, { scene_id: string; path: string; duration_seconds: number }>();
  for (const vo of await ensureSceneVoiceovers(voiceCtx, brollScenes, voiceReferenceId, plan)) {
    brollVoiceovers.set(vo.scene_id, vo);
  }

  for (const v of videos) {
    if (v.on_camera === true || v.has_embedded_audio === true) {
      const scene = sceneById.get(String(v.scene_id));
      const persistedAudio =
        typeof v.audio_path === "string" && existsSync(v.audio_path) ? v.audio_path : null;
      const duration = Number(v.audio_duration_seconds ?? v.duration_seconds);
      result.push({
        video_path: String(v.path),
        audio_path: persistedAudio ?? String(v.path),
        audio_duration_seconds: Number.isFinite(duration) && duration > 0 ? duration : Number(v.duration_seconds),
        target_duration_seconds: scene?.on_camera === true ? null : scene?.duration_seconds ?? null,
      });
    } else {
      const scene = sceneById.get(String(v.scene_id));
      if (!scene) {
        throw new Error(`No plan scene matched video entry ${String(v.scene_id)} while building stitch inputs.`);
      }
      const vo = brollVoiceovers.get(String(v.scene_id));
      if (!vo) {
        throw new Error(`Per-scene voiceover generation returned no take for scene ${String(v.scene_id)}.`);
      }
      const allowedScene = maxAllowedSceneSpeechSeconds(scene.duration_seconds);
      if (vo.duration_seconds > allowedScene) {
        throw new Error(
          `Scene voiceover is ${vo.duration_seconds.toFixed(1)}s for ${scene.duration_seconds}s b-roll scene ` +
            `(max ${allowedScene.toFixed(1)}s). Redraft shorter narration before stitching.`,
        );
      }
      result.push({
        video_path: String(v.path),
        audio_path: vo.path,
        audio_duration_seconds: vo.duration_seconds,
        target_duration_seconds: scene.duration_seconds,
      });
    }
  }
  return result;
}

export async function stitchFinalVideoImpl(ctx: ProjectContext, tokenOutput: JsonDict | null = null): Promise<JsonDict> {
  const plan = loadVideoPlan(ctx);
  const images = orderedSceneAssets(plan, readJsonArtifact<JsonDict[]>(ctx, "images", []) ?? []);
  let videos = orderedSceneAssets(plan, readJsonArtifact<JsonDict[]>(ctx, "videos", []) ?? []);
  const voiceover = readJsonArtifact<JsonDict>(ctx, "voiceover");
  let failedScenes = readJsonArtifact<JsonDict[]>(ctx, "failed_scenes", []) ?? [];
  const recovery = await withTiming(ctx, "workflow.provider_recovery_before_stitch", {
    failed_scene_count: failedScenes.length,
    video_count: videos.length,
  }, () => recoverProviderFailuresBeforeStitch(ctx, plan, images, videos, failedScenes));
  const staleFailuresCleared = recovery.failedScenes.length !== failedScenes.length;
  if (recovery.attempted > 0 || staleFailuresCleared) {
    videos = recovery.videos;
    failedScenes = recovery.failedScenes;
    writeJsonArtifact(ctx, "videos", videos);
    writeJsonArtifact(ctx, "failed_scenes", failedScenes);
    updateProjectState(ctx, {
      videos,
      failures: failedScenes,
      status: {
        stage:
          recovery.recovered.length > 0
            ? failedScenes.length > 0
              ? "provider_recovery_partial"
              : "provider_recovered"
            : "provider_stalled",
        progress: 82,
        message:
          recovery.recovered.length > 0
            ? `Recovered ${recovery.recovered.length} provider job(s) before stitching.`
            : "Provider recovery checked existing job ids but no new scene video was ready.",
      },
      decision: {
        tool: "stitch_final_video",
        decision:
          recovery.attempted > 0
            ? `Checked ${recovery.attempted} recoverable provider job(s) before stitching.`
            : "Cleared stale provider failures for scenes that already have completed videos.",
        metadata: {
          recovered_scene_ids: recovery.recovered.map((asset) => asset.scene_id),
          remaining_failed_scene_ids: failedScenes.map((failure) => failure.scene_id),
        },
      },
    });
  }
  const missingSceneIds = missingPlannedVideoSceneIds(plan, videos);
  if (missingSceneIds.length > 0) {
    const failuresText = failedScenes
      .map((failure) => `${failure.scene_id} ${failure.stage}: ${failure.error}`)
      .join("; ");
    const detail = failuresText ? ` Remaining failures: ${failuresText}` : "";
    throw new Error(
      `Cannot stitch final MP4 until every planned scene has a rendered video. Missing scene videos: ${missingSceneIds.join(", ")}.${detail}`,
    );
  }
  if (videos.length === 0) {
    const failuresText = failedScenes
      .map((failure) => `${failure.scene_id} ${failure.stage}: ${failure.error}`)
      .join("; ");
    const detail = failuresText ? ` Failures: ${failuresText}` : "";
    throw new Error(`No scene videos completed, so no final MP4 can be stitched.${detail}`);
  }
  const hasTalking = anyEmbeddedAudio(videos as any[]);
  // Talking projects carry per-scene audio, so a global voiceover is optional;
  // pure b-roll projects still require one.
  if (!voiceover && !hasTalking) {
    throw new Error("No voiceover asset found. Call generate_voiceover before stitching.");
  }

  const stateForTimeline = readProjectState(ctx);
  const timeline = stateForTimeline.timeline
    ? normalizeTimeline(stateForTimeline.timeline)
    : buildTimelineFromProjectState({
        ...stateForTimeline,
        current_plan: plan,
        scene_assets: { ...(stateForTimeline.scene_assets ?? {}), videos, voiceover },
      });

  let finalVideo: string;
  if (hasTalking) {
    const perScene = await buildPerSceneStitchInputs(ctx, plan, videos);
    const target = mixedTargetDurationSeconds(
      timeline,
      explicitTargetFinalDurationSeconds(requestFromProjectState(ctx)),
    );
    finalVideo = await withTiming(ctx, "workflow.stitch_final_video.mixed", {
      scene_count: perScene.length,
      target_duration_seconds: target,
    }, () => stitchMixedAssets(ctx, perScene, { target_duration_seconds: target }));
  } else {
    finalVideo = await withTiming(ctx, "workflow.stitch_final_video.timeline", {
      video_count: videos.length,
      has_timeline: Boolean(timeline),
    }, () => stitchFromTimelineOrFallback(ctx, videos, voiceover!, timeline));
  }
  await withTiming(ctx, "workflow.final_duration_guard", { final_video: finalVideo }, () =>
    assertFinalDurationCloseToExplicitTarget(ctx, finalVideo),
  );
  const manifest = buildVideoManifest(plan, ctx, {
    images,
    videos,
    voiceover: voiceover ?? {},
    failed_scenes: failedScenes,
    token_output: tokenOutput ?? pendingTokenOutputForContext(ctx),
    final_video: finalVideo,
  });
  const verifiedTimeline = await persistRenderedTimeline(ctx, timeline, finalVideo, "stitch_final_video");
  const finalVerification = verifiedTimeline.ending.verification ?? {};
  const finalDuration = Number(finalVerification.format_duration_seconds);
  const videoDuration = Number(finalVerification.video_duration_seconds);
  const audioDuration = Number(finalVerification.audio_duration_seconds);
  if (Number.isFinite(finalDuration) && finalDuration > 0) manifest.duration_seconds = round3(finalDuration);
  if (Number.isFinite(videoDuration) && videoDuration > 0) manifest.video_duration_seconds = round3(videoDuration);
  if (Number.isFinite(audioDuration) && audioDuration > 0) manifest.audio_duration_seconds = round3(audioDuration);
  manifest.timeline = verifiedTimeline;
  writeJsonArtifact(ctx, "manifest", manifest);
  updateProjectState(ctx, { manifest, timeline: verifiedTimeline });
  return manifest;
}

export function youtubeSectionsToVideoPlan(title: string, narration: string, sections: YouTubeClipSection[]): VideoPlan {
  const scenes: Scene[] = sections.map((section) => ({
    id: `scene_${section.section}`,
    narration: section.dialogue,
    image_prompt: section.search_hint,
    video_prompt: `YouTube clip search: ${section.search_hint}`,
    duration_seconds: section.duration_seconds,
    on_camera: false,
    audio_mode: "tutorial_clear",
    audio_note: null,
    reference_media_ids: [],
    continuity: {
      story_beat: `Source-footage section ${section.section}: ${section.search_hint}`,
      required_subjects: [],
      opening_state: `The sourced footage opens on ${section.search_hint}.`,
      closing_state: `The sourced footage completes the section about ${section.search_hint}.`,
      setting: "Real sourced footage appropriate to the section.",
      screen_direction: "not_applicable",
    },
  }));
  return normalizePlan(
    VideoPlanSchema.parse({
      title,
      creative_vibe: "editorial_documentary",
      narration,
      visual_bible: "YouTube-sourced b-roll and real footage.",
      scenes,
    }),
  );
}

export function existingYoutubeManifest(ctx: ProjectContext): JsonDict | null {
  const manifest = readJsonArtifact<JsonDict>(ctx, "manifest", null);
  if (typeof manifest !== "object" || manifest === null || manifest.workflow !== "youtube_clips") return null;
  const finalPath = manifest.final_video_path;
  if (!finalPath || !existsSync(String(finalPath))) return null;
  if (!manifest.videos || manifest.videos.length === 0) return null;
  return manifest;
}

export function shouldReuseExistingYoutubeManifest(
  options: { reuse_existing_manifest?: boolean } = {},
): boolean {
  return options.reuse_existing_manifest === true;
}

export async function createYoutubeShortImpl(
  ctx: ProjectContext,
  title: string,
  narration: string,
  sections: YouTubeClipSection[],
  options: { token_output?: JsonDict | null; proxy_url?: string | null; reuse_existing_manifest?: boolean } = {},
): Promise<JsonDict> {
  if (sections.length === 0) {
    throw new Error("At least one YouTube clip section is required.");
  }

  if (shouldReuseExistingYoutubeManifest(options)) {
    const existingManifest = existingYoutubeManifest(ctx);
    if (existingManifest !== null) {
      updateProjectState(ctx, {
        decision: {
          tool: "create_youtube_short",
          decision: "Reused existing YouTube short manifest; skipped duplicate generation and downloads.",
          metadata: { manifest_path: existingManifest.manifest_path },
        },
      });
      return existingManifest;
    }
  }

  let normalizedSections = normalizeYoutubeSectionsForProject(ctx, sections);
  const state = readProjectState(ctx);
  const providerSettings = state.provider_settings ?? {};
  const userPreferences = state.user_preferences ?? {};
  const youtubeSearchProvider = String(
    providerSettings.youtube_search_provider || userPreferences.youtube_search_provider || "youtube_data_api",
  );
  const youtubeAllowProviderFallback = boolSetting(
    providerSettings.youtube_allow_provider_fallback ?? userPreferences.youtube_allow_provider_fallback ?? false,
    { default: false },
  );
  let plan = youtubeSectionsToVideoPlan(title, narration, normalizedSections);
  await draftVideoPlanImpl(ctx, plan.title, plan.narration, plan.scenes, plan.visual_bible, "editorial_documentary", false);

  updateProjectState(ctx, {
    provider_settings: {
      workflow: "youtube_clips",
      image_model: "none",
      image_resolution: "none",
      image_style_tool: "none",
      video_model: "youtube-clips",
      video_resolution: ctx.resolution,
      video_audio: false,
      youtube_search_provider: youtubeSearchProvider,
      youtube_allow_provider_fallback: youtubeAllowProviderFallback,
    },
    decision: {
      tool: "create_youtube_short",
      decision: `Using YouTube clip workflow with ${normalizedSections.length} section(s).`,
      metadata: {
        search_hints: normalizedSections.map((section) => section.search_hint),
        youtube_search_provider: youtubeSearchProvider,
        youtube_allow_provider_fallback: youtubeAllowProviderFallback,
      },
    },
    status: {
      stage: "youtube_script_ready",
      progress: 30,
      message: "YouTube script ready; finding source clips before voiceover.",
    },
  });

  const clipResults = await downloadYoutubeClipAssets(ctx, normalizedSections, {
    proxy_url: options.proxy_url ?? null,
    search_provider: youtubeSearchProvider,
  });
  let videos: JsonDict[] = [];
  let failures: JsonDict[] = [];
  normalizedSections.forEach((section, index) => {
    const result = clipResults[index]!;
    const sceneId = `scene_${section.section}`;
    if (result instanceof Error) {
      failures.push({ scene_id: sceneId, stage: "youtube_clip_download", error: result.message });
    } else {
      videos.push({
        ...result,
        // downloadSectionClip ffprobes the real downloaded clip and records its true length
        // on source_duration_seconds. Keep that probed value (it is what timeline.ts reads to
        // decide cut vs freeze); only fall back to the planned estimate if it is absent.
        source_duration_seconds: result.source_duration_seconds ?? result.duration_seconds,
      });
    }
  });

  videos = orderedSceneAssets(plan, videos);
  writeJsonArtifact(ctx, "videos", videos);
  writeJsonArtifact(ctx, "images", []);
  writeJsonArtifact(ctx, "failed_scenes", failures);
  updateProjectState(ctx, {
    images: [],
    videos,
    failures,
    status: { stage: "youtube_clips_downloaded", progress: 70, message: "YouTube clips downloaded." },
  });
  if (videos.length === 0) {
    const detail = failures.map((failure) => `${failure.scene_id}: ${failure.error}`).join("; ");
    const error = `No YouTube clips downloaded, so no final MP4 can be stitched. ${detail}`.trim();
    updateProjectState(ctx, {
      failures,
      status: { stage: "youtube_short_failed", progress: 70, message: "YouTube clip sourcing failed.", error },
    });
    throw new Error(error);
  }

  // Generate narration after clip selection so failed/dirty candidates do not
  // consume TTS and the final plan can align to the clips that actually exist.
  const sectionByScene = new Map(normalizedSections.map((section) => [`scene_${section.section}`, section]));
  const sectionsForVoiceover = videos.map((video) => sectionByScene.get(String(video.scene_id))).filter(Boolean) as YouTubeClipSection[];
  let sectionVoiceovers: SectionVoiceover[];
  let voByScene: Map<string, SectionVoiceover>;
  try {
    sectionVoiceovers = await generateSectionVoiceovers(ctx, sectionsForVoiceover);
    voByScene = new Map(sectionVoiceovers.map((item) => [String(item.scene_id), item]));
  } catch (exc: any) {
    const error = `Failed to generate per-section voiceovers after clip selection: ${exc?.message ?? exc}`;
    const audioFailure = { scene_id: "final", stage: "voiceover_sections", error };
    failures = [...failures, audioFailure];
    writeJsonArtifact(ctx, "failed_scenes", failures);
    updateProjectState(ctx, {
      failures,
      status: { stage: "youtube_short_failed", progress: 70, message: "YouTube short voiceover failed.", error },
    });
    throw new Error(error);
  }
  writeJsonArtifact(ctx, "section_voiceovers", sectionVoiceovers);
  normalizedSections = normalizedSections.map((section) => {
    const voiceover = voByScene.get(`scene_${section.section}`);
    if (!voiceover) return section;
    return {
      ...section,
      duration_seconds: Math.max(1, Math.min(30, Math.round(Number(voiceover.duration_seconds)))),
    };
  });
  plan = saveVideoPlan(ctx, youtubeSectionsToVideoPlan(title, narration, normalizedSections));
  videos = orderedSceneAssets(
    plan,
    videos.map((video) => {
      const audioDuration = voByScene.get(String(video.scene_id))?.duration_seconds ?? video.duration_seconds;
      return {
        ...video,
        audio_duration_seconds: audioDuration,
        duration_seconds: audioDuration,
      };
    }),
  );
  writeJsonArtifact(ctx, "videos", videos);
  updateProjectState(ctx, {
    current_plan: plan,
    videos,
    status: {
      stage: "youtube_voiceover_generated",
      progress: 78,
      message: "Per-section voiceovers generated for selected YouTube clips.",
    },
  });

  const youtubeOutputAspectRatio = await inferYoutubeOutputAspectRatio(videos, {
    default_aspect_ratio: ctx.aspect_ratio,
  });
  const renderCtx: ProjectContext = { ...ctx, aspect_ratio: youtubeOutputAspectRatio };
  updateProjectState(ctx, {
    provider_settings: {
      aspect_ratio: renderCtx.aspect_ratio,
      resolution: renderCtx.resolution,
    },
    decision: {
      tool: "create_youtube_short",
      decision: `Using ${renderCtx.aspect_ratio} output aspect from downloaded YouTube clips.`,
      metadata: {
        requested_aspect_ratio: ctx.aspect_ratio,
        output_aspect_ratio: renderCtx.aspect_ratio,
      },
    },
  });

  // Combine only the surviving sections' audio so the manifest voiceover
  // matches the final video. The per-section files remain the alignment
  // source of truth; dropping a failed scene cannot desync the survivors.
  const orderedSectionVo = videos
    .filter((video) => voByScene.has(String(video.scene_id)))
    .map((video) => voByScene.get(String(video.scene_id))!);
  const missingAudio = orderedSectionVo.filter((item) => !existsSync(String(item.path))).map((item) => item.path);
  if (missingAudio.length > 0) {
    const detail = missingAudio.join("; ");
    const error = `Per-section voiceover files missing before combine: ${detail}`;
    const audioFailure = { scene_id: "final", stage: "voiceover_combine", error };
    failures = [...failures, audioFailure];
    writeJsonArtifact(ctx, "failed_scenes", failures);
    updateProjectState(ctx, {
      failures,
      status: { stage: "youtube_short_failed", progress: 70, message: "YouTube short voiceover combine failed.", error },
    });
    throw new Error(error);
  }
  let voiceover: JsonDict;
  try {
    voiceover = await combineSectionVoiceovers(ctx, orderedSectionVo);
  } catch (exc: any) {
    const audioPaths = orderedSectionVo.map((item) => String(item.path ?? ""));
    const error = `Failed to combine per-section voiceovers: ${exc?.message ?? exc}. Section audio paths: ${JSON.stringify(audioPaths)}`;
    const audioFailure = { scene_id: "final", stage: "voiceover_combine", error };
    failures = [...failures, audioFailure];
    writeJsonArtifact(ctx, "failed_scenes", failures);
    updateProjectState(ctx, {
      failures,
      status: { stage: "youtube_short_failed", progress: 70, message: "YouTube short voiceover combine failed.", error },
    });
    throw new Error(error);
  }
  writeJsonArtifact(ctx, "voiceover", voiceover);
  updateProjectState(ctx, { voiceover });

  const scenesForStitch = videos
    .filter((video) => voByScene.has(String(video.scene_id)))
    .map((video) => ({
      video_path: String(video.path),
      audio_path: voByScene.get(String(video.scene_id))!.path,
      audio_duration_seconds: voByScene.get(String(video.scene_id))!.duration_seconds,
    }));
  const stateForTimeline = readProjectState(ctx);
  const timeline = stateForTimeline.timeline
    ? normalizeTimeline(stateForTimeline.timeline)
    : buildTimelineFromProjectState(
        {
          ...stateForTimeline,
          current_plan: plan,
          scene_assets: { ...(stateForTimeline.scene_assets ?? {}), videos, voiceover },
        },
        // Scope a short static end-hold to the YouTube clips path only; other workflows keep
        // the global DEFAULT_FINAL_HOLD_SECONDS (1.5s). 0.25s avoids both an abrupt cutoff and
        // the long frozen tail.
        { final_hold_seconds: 0.25 },
      );

  let finalVideo: string;
  try {
    if (timelineVideoClipsForStitch(timeline).length > 0) {
      finalVideo = await stitchFromTimelineOrFallback(renderCtx, videos, voiceover, timeline);
    } else {
      finalVideo = await stitchAssetsPerSection(renderCtx, scenesForStitch, {
        target_duration_seconds: timelineTargetDurationSeconds(
          timeline,
          explicitTargetFinalDurationSeconds(requestFromProjectState(ctx)),
        ),
      });
    }
  } catch (exc: any) {
    const stitchFailure = { scene_id: "final", stage: "stitching", error: String(exc?.message ?? exc) };
    failures = [...failures, stitchFailure];
    writeJsonArtifact(ctx, "failed_scenes", failures);
    updateProjectState(ctx, {
      failures,
      status: {
        stage: "youtube_short_failed",
        progress: 70,
        message: "YouTube short stitching failed.",
        error: String(exc?.message ?? exc),
      },
    });
    throw exc;
  }

  const manifest = buildVideoManifest(plan, renderCtx, {
    images: [],
    videos,
    voiceover,
    failed_scenes: failures,
    token_output: options.token_output ?? pendingTokenOutputForContext(ctx),
    final_video: finalVideo,
  });
  manifest.workflow = "youtube_clips";
  manifest.image_model = "none";
  manifest.video_model = "youtube-clips";
  manifest.youtube_search_provider = youtubeSearchProvider;
  manifest.youtube_allow_provider_fallback = youtubeAllowProviderFallback;
  writeJsonArtifact(ctx, "manifest", manifest);
  updateProjectState(ctx, {
    manifest,
    final_video_path: finalVideo,
    manifest_path: manifest.manifest_path,
    status: { stage: "youtube_short_stitched", progress: 95, message: "YouTube short stitched." },
  });
  const verifiedTimeline = await persistRenderedTimeline(ctx, timeline, finalVideo, "create_youtube_short");
  manifest.timeline = verifiedTimeline;
  writeJsonArtifact(ctx, "manifest", manifest);
  updateProjectState(ctx, { manifest, timeline: verifiedTimeline });
  return manifest;
}

export async function inspectRenderStatusImpl(ctx: ProjectContext): Promise<JsonDict> {
  const artifacts: Record<string, boolean> = {};
  for (const name of ["plan", "voiceover", "images", "videos", "manifest"]) {
    artifacts[name] = existsSync(artifactPath(ctx, name));
  }
  const planPayload = readJsonArtifact(ctx, "plan");
  const images = readJsonArtifact<JsonDict[]>(ctx, "images", []) ?? [];
  const videos = readJsonArtifact<JsonDict[]>(ctx, "videos", []) ?? [];
  const failedScenes = readJsonArtifact<JsonDict[]>(ctx, "failed_scenes", []) ?? [];
  const recoverableFailedScenes = failedScenes.filter((failure) => providerJobFailureMetadata(failure));
  let sceneIds: string[] = [];
  let missingImages: string[] = [];
  let missingVideos: string[] = [];

  if (planPayload) {
    const plan = VideoPlanSchema.parse(planPayload);
    sceneIds = plan.scenes.map((scene) => scene.id);
    const imageIds = new Set(images.map((image) => String(image.scene_id)));
    const videoIds = new Set(videos.map((video) => String(video.scene_id)));
    missingImages = sceneIds.filter((sceneId) => !imageIds.has(sceneId));
    missingVideos = sceneIds.filter((sceneId) => !videoIds.has(sceneId));
  }

  const nextTools: string[] = [];
  if (!artifacts.plan) {
    nextTools.push("draft_video_plan");
  } else {
    const plan = VideoPlanSchema.parse(planPayload);
    const hasTalking = anyEmbeddedAudio(videos);
    const needsGlobalVoiceover = !plan.scenes.some((scene) => scene.on_camera === true);
    if (!artifacts.voiceover && needsGlobalVoiceover) nextTools.push("generate_voiceover");
    if (missingImages.length > 0) nextTools.push("generate_scene_images");
    if (recoverableFailedScenes.length > 0 && !artifacts.manifest) nextTools.push("stitch_final_video");
    if (missingVideos.length > 0 && missingImages.length === 0 && recoverableFailedScenes.length === 0) {
      nextTools.push("animate_scene_videos");
    }
    if (videos.length > 0 && (artifacts.voiceover || hasTalking) && !artifacts.manifest) nextTools.push("stitch_final_video");
    if (failedScenes.length > 0) nextTools.push("retry_scene");
  }

  return {
    project_id: ctx.project_id,
    project_state: readProjectState(ctx),
    artifacts,
    scene_ids: sceneIds,
    completed_scene_count: videos.length,
    failed_scene_count: failedScenes.length,
    recoverable_failed_scene_count: recoverableFailedScenes.length,
    missing_images: missingImages,
    missing_videos: missingVideos,
    failed_scenes: failedScenes,
    recoverable_failed_scenes: recoverableFailedScenes,
    next_tools: [...new Set(nextTools)],
  };
}

export async function retrySceneWithModelsImpl(
  ctx: ProjectContext,
  sceneId: string,
  stage: string = "video",
  options: {
    image_model?: string | null;
    image_resolution?: string | null;
    image_style_tool?: string | null;
    video_model?: string | null;
    video_resolution?: string | null;
    video_audio?: boolean | null;
  } = {},
): Promise<JsonDict> {
  if (!["image", "video", "all"].includes(stage)) {
    throw new Error("stage must be one of: image, video, all");
  }
  const plan = loadVideoPlan(ctx);
  const scene = plan.scenes.find((candidate) => candidate.id === sceneId);
  if (!scene) {
    throw new Error(`Unknown scene id: ${sceneId}`);
  }
  const imageCtx = contextWithMagicImageSettings(ctx, {
    model: options.image_model || ctx.image_model,
    image_resolution: options.image_resolution || ctx.image_resolution,
    image_style_tool: options.image_style_tool || ctx.image_style_tool,
  });
  const videoCtx = contextWithMagicVideoSettings(ctx, {
    model: options.video_model || ctx.video_model,
    resolution: options.video_resolution || ctx.resolution,
    audio: options.video_audio == null ? ctx.video_audio : options.video_audio,
    scenes: [scene],
  });

  const images = readJsonArtifact<JsonDict[]>(ctx, "images", []) ?? [];
  const videos = readJsonArtifact<JsonDict[]>(ctx, "videos", []) ?? [];
  let failures = readJsonArtifact<JsonDict[]>(ctx, "failed_scenes", []) ?? [];
  const imageByScene = new Map(images.map((image) => [String(image.scene_id), image]));
  const newImages: JsonDict[] = [];
  const newVideos: JsonDict[] = [];

  if (["image", "all"].includes(stage) || !imageByScene.has(sceneId)) {
    const image = await generateImageAsset(imageCtx, scene);
    newImages.push(image);
    imageByScene.set(sceneId, image);
    failures = clearSceneFailures(failures, new Set([sceneId]), new Set(["image_generation"]));
  }

  if (["video", "all"].includes(stage)) {
    const image = imageByScene.get(sceneId);
    if (!image) {
      throw new Error(`No image asset exists for ${sceneId}; retry with stage='all'.`);
    }
    const video = await renderSingleSceneVideo(videoCtx, plan, scene, image);
    newVideos.push(video);
    // Also clear any stale "talking" failure recorded by an earlier render
    // (renderTalkingPairs), so a now-successful re-render leaves no phantom failure.
    failures = clearSceneFailures(failures, new Set([sceneId]), new Set(["video_generation", "talking"]));
  }

  const mergedImages = orderedSceneAssets(plan, upsertSceneAssets(images, newImages));
  const mergedVideos = orderedSceneAssets(plan, upsertSceneAssets(videos, newVideos));
  writeJsonArtifact(ctx, "images", mergedImages);
  writeJsonArtifact(ctx, "videos", mergedVideos);
  writeJsonArtifact(ctx, "failed_scenes", failures);
  updateProjectState(ctx, {
    provider_settings: {
      image_model: imageCtx.image_model,
      image_resolution: imageCtx.image_resolution,
      image_style_tool: imageCtx.image_style_tool,
      video_model: videoCtx.video_model,
      video_resolution: videoCtx.resolution,
      video_audio: videoCtx.video_audio,
    },
    images: mergedImages,
    videos: mergedVideos,
    failures,
    status: { stage: "scene_retried", progress: 75, message: `Retried ${sceneId}.` },
    decision: {
      tool: "retry_scene",
      decision: `Retried ${stage} asset(s) for ${sceneId}.`,
      scene_id: sceneId,
    },
  });
  return {
    project_id: ctx.project_id,
    stage: "scene_retried",
    retried_scene_id: sceneId,
    images: mergedImages.map((image) => withMediaUrl(image)),
    videos: mergedVideos.map((video) => withMediaUrl(video)),
    failed_scenes: failures,
    next_tools: ["stitch_final_video", "inspect_render_status"],
  };
}

export async function recordProjectDecisionImpl(
  ctx: ProjectContext,
  decision: string,
  rationale = "",
  sceneId: string | null = null,
): Promise<JsonDict> {
  const entry = appendProjectDecision(ctx, {
    decision,
    rationale,
    scene_id: sceneId,
    tool: "record_project_decision",
  });
  return {
    project_id: ctx.project_id,
    stage: "decision_recorded",
    decision: entry,
    decision_count: readProjectState(ctx).decisions.length,
  };
}

export async function regenerateSceneImpl(
  ctx: ProjectContext,
  sceneId: string,
  options: {
    narration?: string | null;
    image_prompt?: string | null;
    video_prompt?: string | null;
    duration_seconds?: number | null;
    regenerate_image?: boolean;
    image_model?: string | null;
    image_resolution?: string | null;
    image_style_tool?: string | null;
    video_model?: string | null;
    video_resolution?: string | null;
    video_audio?: boolean | null;
  } = {},
): Promise<JsonDict> {
  const regenerateImage = options.regenerate_image ?? true;
  let plan = loadVideoPlan(ctx);
  let scene: Scene;
  [plan, scene] = patchSceneInPlan(plan, sceneId, {
    narration: options.narration,
    image_prompt: options.image_prompt,
    video_prompt: options.video_prompt,
    duration_seconds: options.duration_seconds,
  });
  saveVideoPlan(ctx, plan);
  invalidateFinalArtifacts(ctx);

  const images = readJsonArtifact<JsonDict[]>(ctx, "images", []) ?? [];
  const videos = readJsonArtifact<JsonDict[]>(ctx, "videos", []) ?? [];
  let failures = readJsonArtifact<JsonDict[]>(ctx, "failed_scenes", []) ?? [];
  const imageByScene = new Map(images.map((image) => [String(image.scene_id), image]));
  const imageCtx = contextWithMagicImageSettings(ctx, {
    model: options.image_model || ctx.image_model,
    image_resolution: options.image_resolution || ctx.image_resolution,
    image_style_tool: options.image_style_tool || ctx.image_style_tool,
  });
  const videoCtx = contextWithMagicVideoSettings(ctx, {
    model: options.video_model || ctx.video_model,
    resolution: options.video_resolution || ctx.resolution,
    audio: options.video_audio == null ? ctx.video_audio : options.video_audio,
    scenes: [scene],
  });
  const providerScene: Scene = {
    ...scene,
    image_prompt: providerImagePrompt(plan, scene),
    video_prompt: providerVideoPrompt(plan, scene),
  };

  let image: JsonDict;
  if (regenerateImage || !imageByScene.has(sceneId)) {
    image = await generateImageAsset(imageCtx, providerScene);
  } else {
    image = imageByScene.get(sceneId)!;
  }
  const video = await renderSingleSceneVideo(videoCtx, plan, providerScene, image);

  const mergedImages = orderedSceneAssets(plan, upsertSceneAssets(images, [image]));
  const mergedVideos = orderedSceneAssets(plan, upsertSceneAssets(videos, [video]));
  // Include "talking" so a stale soft talking failure from an earlier render
  // (renderTalkingPairs) doesn't survive a now-successful regenerate.
  failures = clearSceneFailures(failures, new Set([sceneId]), new Set(["image_generation", "video_generation", "talking"]));
  writeJsonArtifact(ctx, "images", mergedImages);
  writeJsonArtifact(ctx, "videos", mergedVideos);
  writeJsonArtifact(ctx, "failed_scenes", failures);
  updateProjectState(ctx, {
    current_plan: plan,
    provider_settings: {
      image_model: imageCtx.image_model,
      image_resolution: imageCtx.image_resolution,
      image_style_tool: imageCtx.image_style_tool,
      video_model: videoCtx.video_model,
      video_resolution: videoCtx.resolution,
      video_audio: videoCtx.video_audio,
    },
    images: mergedImages,
    videos: mergedVideos,
    failures,
    final_video_path: null,
    manifest_path: null,
    status: { stage: "scene_regenerated", progress: 78, message: `Regenerated ${sceneId}.` },
    decision: {
      tool: "regenerate_scene",
      decision: `Regenerated assets for ${sceneId}.`,
      scene_id: sceneId,
      metadata: {
        regenerated_image: regenerateImage || !imageByScene.has(sceneId),
        patched_fields: Object.entries({
          narration: options.narration,
          image_prompt: options.image_prompt,
          video_prompt: options.video_prompt,
          duration_seconds: options.duration_seconds,
        })
          .filter(([, value]) => value != null)
          .map(([field]) => field),
      },
    },
  });
  return {
    project_id: ctx.project_id,
    stage: "scene_regenerated",
    scene,
    images: mergedImages.map((asset) => withMediaUrl(asset)),
    videos: mergedVideos.map((asset) => withMediaUrl(asset)),
    failed_scenes: failures,
    next_tools: ["inspect_render_status", "restitch_video"],
  };
}

export async function reviseNarrationImpl(
  ctx: ProjectContext,
  narration: string,
  sceneNarrationUpdates: SceneNarrationRevision[] | null = null,
): Promise<JsonDict> {
  let plan = loadVideoPlan(ctx);
  plan = { ...plan, narration };
  plan = reviseSceneNarrations(plan, sceneNarrationUpdates ?? []);
  saveVideoPlan(ctx, plan);
  invalidateFinalArtifacts(ctx, { voiceover: true });
  updateProjectState(ctx, {
    current_plan: plan,
    status: { stage: "narration_revised", progress: 35, message: "Narration revised; voiceover is stale." },
    decision: {
      tool: "revise_narration",
      decision: "Revised narration and invalidated the previous voiceover.",
      metadata: { scene_ids: (sceneNarrationUpdates ?? []).map((revision) => revision.scene_id) },
    },
  });
  return {
    project_id: ctx.project_id,
    stage: "narration_revised",
    plan,
    next_tools: ["replace_voiceover", "restitch_video"],
  };
}

export async function replaceVoiceoverImpl(ctx: ProjectContext, narration: string | null = null): Promise<JsonDict> {
  let plan = loadVideoPlan(ctx);
  if (narration !== null) {
    plan = { ...plan, narration };
    saveVideoPlan(ctx, plan);
  }
  invalidateFinalArtifacts(ctx, { voiceover: true });
  const voiceCtx = voiceContextForPlan(ctx, plan);
  const voiceover = await generateVoiceoverAsset(
    voiceCtx,
    plan.narration,
    planDurationSeconds(plan),
    resolveVoiceReferenceId(plan, voiceCtx),
    plan,
  );
  writeJsonArtifact(ctx, "voiceover", voiceover);
  updateProjectState(ctx, {
    current_plan: plan,
    voiceover,
    final_video_path: null,
    manifest_path: null,
    status: { stage: "voiceover_replaced", progress: 55, message: "Voiceover replaced." },
    decision: {
      tool: "replace_voiceover",
      decision: "Replaced the voiceover audio from the current narration.",
      metadata: { target_duration_seconds: voiceover.target_duration_seconds },
    },
  });
  return {
    project_id: ctx.project_id,
    stage: "voiceover_replaced",
    voiceover: withMediaUrl(voiceover),
    next_tools: ["restitch_video"],
  };
}

export function inspectTimelineImpl(ctx: ProjectContext): JsonDict {
  const timeline = currentProjectTimeline(ctx);
  updateProjectState(ctx, { timeline });
  return inspectTimeline(timeline);
}

export function trimTimelineClipImpl(
  ctx: ProjectContext,
  clipId: string,
  trim: { source_start?: number | null; source_end?: number | null },
): JsonDict {
  const timeline = currentProjectTimeline(ctx);
  const updated = keepEndingGuardAtTimelineEnd(
    trimClip(timeline, clipId, {
      ...(trim.source_start != null ? { source_start: trim.source_start } : {}),
      ...(trim.source_end != null ? { source_end: trim.source_end } : {}),
    }),
  );
  updateProjectState(ctx, {
    timeline: updated,
    decision: {
      tool: "trim_clip",
      decision: `Trimmed timeline clip ${clipId}.`,
      metadata: { clip_id: clipId, source_start: trim.source_start ?? null, source_end: trim.source_end ?? null },
    },
  });
  return inspectTimeline(updated);
}

export function moveTimelineClipImpl(ctx: ProjectContext, clipId: string, timelineStart: number): JsonDict {
  const timeline = currentProjectTimeline(ctx);
  const updated = keepEndingGuardAtTimelineEnd(moveClip(timeline, clipId, timelineStart));
  updateProjectState(ctx, {
    timeline: updated,
    decision: {
      tool: "move_clip",
      decision: `Moved timeline clip ${clipId}.`,
      metadata: { clip_id: clipId, timeline_start: timelineStart },
    },
  });
  return inspectTimeline(updated);
}

export function setFinalHoldImpl(ctx: ProjectContext, holdSeconds: number, reason = "Adjusted final hold."): JsonDict {
  const timeline = currentProjectTimeline(ctx);
  const updated = setFinalHold(timeline, holdSeconds, reason);
  updateProjectState(ctx, {
    timeline: updated,
    decision: {
      tool: "set_final_hold",
      decision: `Set final timeline hold to ${updated.ending.hold_seconds}s.`,
      rationale: reason,
      metadata: { hold_seconds: updated.ending.hold_seconds },
    },
  });
  return inspectTimeline(updated);
}

export async function restitchVideoImpl(
  ctx: ProjectContext,
  tokenOutput: JsonDict | null = null,
  reason = "",
): Promise<JsonDict> {
  const manifest = await stitchFinalVideoImpl(ctx, tokenOutput);
  updateProjectState(ctx, {
    status: { stage: "video_restitched", progress: 95, message: "Final video restitched." },
    decision: {
      tool: "restitch_video",
      decision: "Restitched the final video from current scene videos and voiceover.",
      ...(reason ? { rationale: reason } : {}),
    },
  });
  return manifest;
}

export async function restitchTimelineImpl(
  ctx: ProjectContext,
  tokenOutput: JsonDict | null = null,
  reason = "Restitched after timeline edits.",
): Promise<JsonDict> {
  const manifest = await restitchVideoImpl(ctx, tokenOutput, reason);
  updateProjectState(ctx, {
    decision: {
      tool: "restitch_timeline",
      decision: "Restitched the final video from the saved timeline.",
      ...(reason ? { rationale: reason } : {}),
    },
  });
  return manifest;
}
