import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_AUTO_DURATION_SECONDS,
  DEFAULT_AUTO_SCENE_BUDGET_COUNT,
  DEFAULT_HUME_TTS_WORDS_PER_SECOND,
  DEFAULT_ELEVENLABS_TTS_WORDS_PER_SECOND,
  DEFAULT_TTS_WORDS_PER_SECOND,
  ENV,
  MAX_HUME_PLANNING_WORDS_PER_SECOND,
  MAX_TTS_WORDS_PER_SECOND,
  MIN_TTS_WORDS_PER_SECOND,
  NARRATION_MAX_FACTOR,
  NARRATION_MIN_FACTOR,
  OUTPUT_DIR,
} from "./config.js";
import type { ProjectContext } from "./context.js";
import { creativeIntentBrief, inferCreativeIntent } from "./creativeDecision.js";
import { magicHourCapabilityBrief } from "./magicHourCapabilities.js";
import { probeMediaDurationSync } from "./mediaSync.js";
import { readProjectState, artifactPath } from "./renderState.js";
import type { JsonDict } from "./renderState.js";
import type {
  CreateProjectRequest,
  GenerationConstraints,
  SceneConstraintMode,
  SpeechBudget,
  YouTubeClipSection,
  YouTubeScriptPlan,
} from "./schemas.js";

export const WORD_PATTERN = /[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)?/g;
const FISH_AUDIO_BRACKET_CUE_PATTERN = /\[([^\[\]\n]{1,80})\]/g;
const FISH_AUDIO_LEGACY_PAREN_CUE_PATTERN = /\(([a-z][a-z -]{0,32})\)/g;
const PROMPT_DURATION_UNDER_PATTERN = /\b(?:keep\s+it\s+)?under\s+(\d{1,2})\s*(?:s|secs?|seconds?)\b/i;
const PROMPT_DURATION_PATTERN = /\b(\d{1,2})(?:\s*-\s*|\s*)?(?:s|secs?|seconds?)\b/i;
const PROMPT_NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};
const PROMPT_COUNT_TOKEN = "\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten";
const PROMPT_EXACT_SCENE_PATTERNS = [
  new RegExp(`\\bexactly\\s+(?<count>${PROMPT_COUNT_TOKEN})\\s+(?:distinct\\s+|unique\\s+)?(?:scenes?|stages?)\\b`, "i"),
  new RegExp(`\\buse\\s+(?<count>${PROMPT_COUNT_TOKEN})\\s+(?:distinct\\s+|unique\\s+)?(?:scenes?|stages?)\\b`, "i"),
  new RegExp(`\\binclude\\s+(?<count>${PROMPT_COUNT_TOKEN})\\s+(?:distinct\\s+|unique\\s+)?(?:scenes?|stages?)\\b`, "i"),
];
const PROMPT_MIN_SCENE_PATTERN = new RegExp(
  `\\bat\\s+least\\s+(?<count>${PROMPT_COUNT_TOKEN})\\s+(?:distinct\\s+|unique\\s+)?(?:scenes?|stages?)\\b`,
  "i",
);
const PROMPT_AGENT_DECIDES_SCENE_PATTERNS = [
  /\b(?:you\s+(?:must\s+)?)?(?:decide|determine|choose)\b.{0,100}\b(?:number\s+of\s+scenes|how\s+many\s+scenes|scene\s+count)\b/i,
  /\b(?:number\s+of\s+scenes|how\s+many\s+scenes|scene\s+count)\b.{0,100}\b(?:you\s+)?(?:decide|determine|choose)\b/i,
];
const NO_DEAD_AIR_PROMPT_PATTERN =
  /\b(?:no|without)\s+(?:silent|silence|blank|empty|dead)[ -]?(?:filler|padding|time|space|air|ending|tail)?\b|\bno\s+(?:silent|frozen)\s+(?:or\s+(?:silent|frozen)\s+)?filler\b|\b(?:avoid|or)\s+(?:a\s+)?silent\s+(?:ending|tail)\b/i;
const FACTUAL_YOUTUBE_PROMPT_PATTERN =
  /\b(latest|today|tonight|current|breaking|news|shooting|election|war|attack|trial|lawsuit|earnings|weather|emergency|press conference)\b/i;
const HISTORICAL_YOUTUBE_PROMPT_PATTERN =
  /\b(19\d{2}|20\d{2}|season|career|history|historic|classic|highlights?|recap|documentary|throwback)\b/i;
const GENERIC_YOUTUBE_BROLL_PATTERN =
  /\b(vertical|shorts?|stock(?:\s+(?:video|footage))?|b[-\s]?roll|generic|watermark(?:ed)?|police lights|street scene)\b/gi;
const YOUTUBE_CREATION_PREFIX_PATTERN = new RegExp(
  "^\\s*(?:(?:make|create|generate|build)\\s+(?:an?\\s+)?)?" +
    "(?:(?:under\\s+\\d{1,2}\\s+seconds?|\\d{1,2}(?:\\s+|-)?seconds?)\\s+)?" +
    "(?:(?:youtube\\s+clips?|yt\\s+clips?)\\s+)?" +
    "(?:short|video|clip|reel)\\s+(?:on|about|of)\\s+",
  "i",
);
const YOUTUBE_SOURCE_FILLER_PATTERN = /\b(?:using|real|clips?|from|videos?|footage|coverage|and|or)\b/gi;
const YOUTUBE_DUPLICATE_HINT_SUFFIXES = [
  "official update",
  "announcement",
  "product demo",
  "press briefing",
  "launch news",
  "developer update",
] as const;
const YOUTUBE_PRODUCT_DUPLICATE_HINT_SUFFIXES = ["launch", "introducing", "announcement", "developer update"] as const;
const OPENAI_PRODUCT_TERM_PATTERN =
  /\b(Codex|ChatGPT(?:\s+Atlas)?|GPT-(?:\d(?:\.\d+)?|4o|[A-Za-z][A-Za-z0-9-]*)|O3|O4(?:[-\s]?mini)?|O1(?:[-\s]?(?:pro|mini))?|Sora|AgentKit|DALL-E)\b/gi;
const SPELLED_OPENAI_MODEL_HINT_PATTERN =
  /\bGPT\s+(?:one|two|three|four|five|six|seven|eight|nine|ten)(?:\s+point\s+(?:zero|one|two|three|four|five|six|seven|eight|nine|ten))?\b/i;
const FACTUAL_SUBJECT_STOPWORDS = new Set([
  "about",
  "actual",
  "clip",
  "clips",
  "coverage",
  "from",
  "into",
  "latest",
  "make",
  "news",
  "official",
  "real",
  "reputable",
  "short",
  "today",
  "tonight",
  "using",
  "video",
  "videos",
  "with",
  "youtube",
]);

function findAll(pattern: RegExp, text: string): string[] {
  const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
  return [...text.matchAll(new RegExp(pattern.source, flags))].map((match) => match[1] ?? match[0]);
}

export function countSpokenWords(text: string): number {
  return findAll(WORD_PATTERN, stripFishAudioExpressionCues(text)).length;
}

export function fishAudioExpressionCues(text: string): string[] {
  return [...text.matchAll(FISH_AUDIO_BRACKET_CUE_PATTERN)].map((match) => match[1]!);
}

export function stripFishAudioExpressionCues(text: string): string {
  const withoutBracketCues = text.replace(FISH_AUDIO_BRACKET_CUE_PATTERN, " ");
  return withoutBracketCues.replace(FISH_AUDIO_LEGACY_PAREN_CUE_PATTERN, " ");
}

export function compactSpokenSentences(text: string, maxWords: number): string {
  const cleaned = text.split(/\s+/).filter(Boolean).join(" ");
  if (countSpokenWords(cleaned) <= maxWords) return cleaned;

  const sentences = [...cleaned.matchAll(/([^.!?]+)([.!?]+|$)/g)]
    .map((match) => ({
      text: `${match[1]?.trim() ?? ""}${match[2] ?? ""}`.trim(),
      complete: Boolean(match[2]),
    }))
    .filter((sentence) => sentence.text);

  const kept: string[] = [];
  let words = 0;
  for (const sentence of sentences) {
    if (!sentence.complete) break;
    const nextWords = countSpokenWords(sentence.text);
    if (nextWords === 0) continue;
    if (words + nextWords > maxWords) break;
    kept.push(sentence.text);
    words += nextWords;
  }

  // If no complete sentence fits, leave the line intact and let plan validation
  // ask the agent to rewrite it. Cutting arbitrary words creates broken audio.
  return kept.length > 0 ? kept.join(" ") : cleaned;
}

export function clampedFloat(value: number, lower: number, upper: number): number {
  return Math.max(lower, Math.min(value, upper));
}

export function configuredTtsWordsPerSecond(audioProvider: string | null = null): number | null {
  const raw =
    audioProvider === "hume"
      ? ENV.HUME_TTS_WORDS_PER_SECOND || ENV.TTS_WORDS_PER_SECOND
      : audioProvider === "elevenlabs"
        ? ENV.ELEVENLABS_TTS_WORDS_PER_SECOND || ENV.TTS_WORDS_PER_SECOND
      : ENV.FISH_AUDIO_WORDS_PER_SECOND || ENV.TTS_WORDS_PER_SECOND;
  if (!raw) return null;
  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed)) {
    console.warn(`Ignoring invalid TTS words-per-second override: ${raw}`);
    return null;
  }
  return clampedFloat(parsed, MIN_TTS_WORDS_PER_SECOND, MAX_TTS_WORDS_PER_SECOND);
}

const ttsWordsPerSecondCache = new Map<string, number>();

export function estimateTtsWordsPerSecond(
  audioModel: string,
  outputDir: string | null = null,
  audioProvider: string | null = null,
  voiceKey: string | null = null,
): number {
  const providerMax =
    audioProvider === "hume"
      ? Math.min(MAX_TTS_WORDS_PER_SECOND, MAX_HUME_PLANNING_WORDS_PER_SECOND)
      : MAX_TTS_WORDS_PER_SECOND;
  const configured = configuredTtsWordsPerSecond(audioProvider);
  if (configured !== null) return Math.round(clampedFloat(configured, MIN_TTS_WORDS_PER_SECOND, providerMax) * 100) / 100;

  const samples: number[] = [];
  const root = outputDir ?? OUTPUT_DIR;
  const normalizedVoiceKey = String(voiceKey ?? "").trim().toLowerCase();
  const cacheKey = `${audioProvider ?? ""}|${audioModel}|${normalizedVoiceKey}|${root}`;
  const cached = ttsWordsPerSecondCache.get(cacheKey);
  if (cached !== undefined) return cached;
  if (existsSync(root)) {
    for (const entry of readdirSync(root)) {
      const manifestPath = path.join(root, entry, "manifest.json");
      if (!existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        if (manifest.audio_model !== audioModel) continue;
        const manifestProvider = String(manifest.audio_provider ?? manifest.voiceover?.provider ?? "").toLowerCase();
        if (audioProvider && manifestProvider && manifestProvider !== audioProvider.toLowerCase()) continue;
        const manifestVoice = String(manifest.plan?.voice ?? "").trim().toLowerCase();
        if (normalizedVoiceKey && manifestVoice !== normalizedVoiceKey) continue;
        const narration = String((manifest.plan ?? {}).narration || manifest.narration || "");
        const wordCount = countSpokenWords(narration);
        if (wordCount < 10) continue;
        const voiceoverPath = (manifest.voiceover ?? {}).path;
        if (!voiceoverPath) continue;
        let voiceoverFile = String(voiceoverPath);
        if (!path.isAbsolute(voiceoverFile)) {
          voiceoverFile = path.join(path.dirname(manifestPath), voiceoverFile);
        }
        if (!existsSync(voiceoverFile)) continue;
        const duration = probeMediaDurationSync(voiceoverFile);
        if (duration < 3) continue;
        const recordedSpeed = Number(manifest.voiceover?.audio_performance?.speed ?? 1);
        const safeSpeed = Number.isFinite(recordedSpeed) ? clampedFloat(recordedSpeed, 0.75, 1.2) : 1;
        samples.push((wordCount / duration) / safeSpeed);
      } catch {
        // skip unreadable calibration samples
      }
    }
  }

  if (samples.length === 0) {
    const fallback = Number.parseFloat(
      audioProvider === "hume"
        ? ENV.HUME_DEFAULT_WORDS_PER_SECOND ?? String(DEFAULT_HUME_TTS_WORDS_PER_SECOND)
        : audioProvider === "elevenlabs"
          ? ENV.ELEVENLABS_DEFAULT_WORDS_PER_SECOND ?? String(DEFAULT_ELEVENLABS_TTS_WORDS_PER_SECOND)
        : ENV.FISH_AUDIO_DEFAULT_WORDS_PER_SECOND ?? String(DEFAULT_TTS_WORDS_PER_SECOND),
    );
    const value = Math.round(clampedFloat(fallback, MIN_TTS_WORDS_PER_SECOND, providerMax) * 100) / 100;
    ttsWordsPerSecondCache.set(cacheKey, value);
    return value;
  }

  samples.sort((a, b) => a - b);
  const sampledStatistic =
    audioProvider === "elevenlabs"
      ? samples[Math.floor((samples.length - 1) * 0.75)]!
      : samples.length % 2
        ? samples[Math.floor(samples.length / 2)]!
        : (samples[samples.length / 2 - 1]! + samples[samples.length / 2]!) / 2;
  // Completed ElevenLabs artifacts may already be duration-conformed, so their
  // apparent pace is not a clean synthesis measurement. Use the provider
  // baseline for first-pass planning; measured rejected takes still produce a
  // stricter repair target in the workflow.
  const statistic =
    audioProvider === "elevenlabs"
      ? DEFAULT_ELEVENLABS_TTS_WORDS_PER_SECOND
      : sampledStatistic;
  const value = Math.round(clampedFloat(statistic, MIN_TTS_WORDS_PER_SECOND, providerMax) * 100) / 100;
  ttsWordsPerSecondCache.set(cacheKey, value);
  return value;
}

export function estimateTtsWordsPerSecondForContext(ctx: ProjectContext, voiceKey?: string | null): number {
  return estimateTtsWordsPerSecond(ctx.audio_model, null, ctx.audio_provider, voiceKey ?? null);
}

export function promptNumberValue(value: string): number | null {
  if (/^\d+$/.test(value)) return Number.parseInt(value, 10);
  return PROMPT_NUMBER_WORDS[value.toLowerCase()] ?? null;
}

export function boundedPromptCount(value: number | null): number | null {
  if (value === null || value < 1 || value > 10) return null;
  return value;
}

export function extractPromptDuration(prompt: string): [number, boolean] | null {
  const underMatch = prompt.match(PROMPT_DURATION_UNDER_PATTERN);
  if (underMatch) {
    const duration = Number.parseInt(underMatch[1]!, 10);
    if (duration >= 1 && duration <= 60) return [duration, true];
  }

  const durationMatch = prompt.match(PROMPT_DURATION_PATTERN);
  if (!durationMatch) return null;
  const duration = Number.parseInt(durationMatch[1]!, 10);
  if (duration >= 1 && duration <= 60) return [duration, false];
  return null;
}

export function extractPromptSceneConstraint(prompt: string): [SceneConstraintMode, number | null] | null {
  for (const pattern of PROMPT_EXACT_SCENE_PATTERNS) {
    const exactMatch = prompt.match(pattern);
    if (exactMatch) {
      const count = boundedPromptCount(promptNumberValue(exactMatch.groups!.count!));
      if (count !== null) return ["exact", count];
    }
  }

  const minimumMatch = prompt.match(PROMPT_MIN_SCENE_PATTERN);
  if (minimumMatch) {
    const count = boundedPromptCount(promptNumberValue(minimumMatch.groups!.count!));
    if (count !== null) return ["minimum", count];
  }

  if (PROMPT_AGENT_DECIDES_SCENE_PATTERNS.some((pattern) => pattern.test(prompt))) {
    return ["agent_decides", null];
  }

  return null;
}

export function resolveGenerationConstraints(request: CreateProjectRequest): GenerationConstraints {
  let durationSeconds: number;
  let durationIsUpperBound: boolean;
  let durationSource: "prompt" | "request" | "auto";
  const promptDuration = extractPromptDuration(request.prompt);
  if (promptDuration !== null) {
    [durationSeconds, durationIsUpperBound] = promptDuration;
    durationSource = "prompt";
  } else if (request.duration_seconds != null) {
    durationSeconds = request.duration_seconds;
    durationIsUpperBound = false;
    durationSource = "request";
  } else {
    durationSeconds = DEFAULT_AUTO_DURATION_SECONDS;
    durationIsUpperBound = false;
    durationSource = "auto";
  }

  let sceneMode: SceneConstraintMode;
  let sceneCount: number | null;
  let sceneSource: "prompt" | "request" | "auto";
  const promptSceneConstraint = extractPromptSceneConstraint(request.prompt);
  if (promptSceneConstraint !== null) {
    [sceneMode, sceneCount] = promptSceneConstraint;
    sceneSource = "prompt";
  } else if (request.scene_count != null) {
    sceneMode = "exact";
    sceneCount = request.scene_count;
    sceneSource = "request";
  } else {
    sceneMode = "agent_decides";
    sceneCount = null;
    sceneSource = "auto";
  }

  const sceneBudgetCount = sceneCount !== null ? sceneCount : DEFAULT_AUTO_SCENE_BUDGET_COUNT;
  return {
    duration_seconds: durationSeconds,
    duration_source: durationSource,
    duration_is_upper_bound: durationIsUpperBound,
    scene_mode: sceneMode,
    scene_count: sceneCount,
    scene_source: sceneSource,
    scene_budget_count: sceneBudgetCount,
  };
}

export function speechBudgetForRequest(request: CreateProjectRequest, ctx: ProjectContext): SpeechBudget {
  const constraints = resolveGenerationConstraints(request);
  const providerWordsPerSecond = estimateTtsWordsPerSecondForContext(ctx);
  const intent = inferCreativeIntent(request, ctx);
  const deliverySpeed =
    ctx.audio_provider === "hume" || ctx.audio_provider === "elevenlabs"
      ? intent.goal === "story" || intent.suggested_vibe === "cinematic_commercial"
        ? 0.92
        : intent.format === "testimonial" || intent.format === "ugc"
          ? 0.96
          : 1
      : 1;
  const wordsPerSecond = providerWordsPerSecond * deliverySpeed;
  const rawSceneDuration = constraints.duration_seconds;
  const minimumFactor = requestForbidsDeadAir(request)
    ? Math.max(NARRATION_MIN_FACTOR, 0.97)
    : NARRATION_MIN_FACTOR;
  const minWords = Math.max(4, Math.ceil(constraints.duration_seconds * wordsPerSecond * minimumFactor));
  const maxWords = Math.max(minWords + 1, Math.ceil(constraints.duration_seconds * wordsPerSecond * NARRATION_MAX_FACTOR));
  return {
    words_per_second: wordsPerSecond,
    min_words: minWords,
    max_words: maxWords,
    scene_duration_total_seconds: rawSceneDuration,
    final_duration_seconds: constraints.duration_seconds,
  };
}

export function requestForbidsDeadAir(request: CreateProjectRequest | null): boolean {
  return NO_DEAD_AIR_PROMPT_PATTERN.test(String(request?.prompt ?? ""));
}

export function explicitTargetFinalDurationSeconds(request: CreateProjectRequest | null): number | null {
  if (request === null) return null;
  const constraints = resolveGenerationConstraints(request);
  if (constraints.duration_source === "auto") return null;
  return constraints.duration_seconds;
}

export function magicHourModelCatalogForAgent(): string {
  return [
    "Magic Hour image models:",
    "- seedream-v4: detailed cinematic keyframes with strong descriptive prompt adherence at 640px/1k/2k/4k.",
    "- default: Magic Hour recommended image model; do not use unless the user explicitly asks for Magic Hour's default.",
    "- flux-schnell: low-cost fast drafts at 640px/1k/2k.",
    "- z-image-turbo: low-cost fast drafts at 640px/1k/2k.",
    "- nano-banana: higher-cost image model for polished creative output at 640px/1k.",
    "- nano-banana-2-lite: default for this app; fast, lower-cost Nano Banana 2 model for 640px/1k generation and editing.",
    "- nano-banana-2: higher-cost model with broader image counts and up to 4k.",
    "- nano-banana-pro: highest-cost professional image model at 1k/2k/4k.",
    "Magic Hour image-to-video models:",
    "- minimax-h3: default for this app; reference-driven video with optional native audio, supports 1-10/15/20/25/30 second clips and 480p/720p/1080p. It accepts a starting image but not an ending image. Enable native audio only for native_scene_audio scenes; keep it off when ElevenLabs voiceover or AI talking photo owns speech.",
    "- ltx-2.3: fast iteration for b-roll cutaway scenes; supports 1-10/15/20/25/30 second clips and 480p/720p/1080p.",
    "- ltx-2: older fast-iteration LTX option with the same I2V duration and resolution set.",
    "- default: Magic Hour recommended video model; do not use unless the user explicitly asks for Magic Hour's default.",
    "- wan-2.2: fast strong visuals/effects, supports 3-10/15 second clips and 480p/720p/1080p.",
    "- seedance: fast iteration, supports 2-12 second clips and 480p/720p/1080p.",
    "- seedance-2.0: quality and consistency, supports 4-15 second clips and 480p/720p.",
    "- kling-2.5: motion/action/camera control, supports 5 or 10 second clips and 720p/1080p.",
    "- kling-3.0: cinematic multi-shot storytelling, supports 3-15 second clips and 720p/1080p.",
    "- sora-2: story-first creativity, supports 4/8/12/24/36/48/60 second clips and 720p.",
    "- veo3.1: realistic visuals and prompt adherence, supports 4/6/8/16/24/32/40/48/56 second clips and 720p/1080p.",
    "- veo3.1-lite: faster affordable high-quality video, supports 8/16/24/32/40/48/56 second clips and 720p/1080p.",
    "Supported I2V durations and resolutions are model-specific; choose scene durations and tool parameters that match the selected video model.",
  ].join("\n");
}

export function durationConstraintLine(constraints: GenerationConstraints): string {
  if (constraints.duration_source === "prompt") {
    if (constraints.duration_is_upper_bound) {
      return `Prompt duration constraint: under ${constraints.duration_seconds} seconds. Treat this as a hard upper bound.`;
    }
    return `Prompt duration constraint: ${constraints.duration_seconds} seconds. This overrides UI/default duration controls.`;
  }
  if (constraints.duration_source === "request") {
    return `User-selected duration constraint: ${constraints.duration_seconds} seconds.`;
  }
  return `Duration constraint: agent decides. Use a compact ${constraints.duration_seconds}-second budget unless the prompt demands different pacing.`;
}

export function imageModelPolicyLine(request: CreateProjectRequest, ctx: ProjectContext): string {
  if (request.image_model) {
    return `User-selected image model: ${request.image_model}.`;
  }
  return `Default image model: ${ctx.image_model}. Use another image model only if the user explicitly asks or the prompt clearly needs that model-specific capability.`;
}

export function videoModelPolicyLine(request: CreateProjectRequest, ctx: ProjectContext): string {
  if (request.video_model) {
    return `User-selected image-to-video model: ${request.video_model}.`;
  }
  return `Default image-to-video model: ${ctx.video_model}. Use another model only if the user explicitly asks or the prompt clearly needs that model-specific capability.`;
}

export function sceneConstraintLine(constraints: GenerationConstraints): string {
  if (constraints.scene_mode === "exact" && constraints.scene_count !== null) {
    return `Scene count constraint: exactly ${constraints.scene_count} scenes.`;
  }
  if (constraints.scene_mode === "minimum" && constraints.scene_count !== null) {
    return `Scene count constraint: at least ${constraints.scene_count} scenes or stages.`;
  }
  return "Scene count constraint: agent decides. Choose the count needed for clarity, usually 3-5 scenes.";
}

export function buildGenerationBrief(request: CreateProjectRequest, ctx: ProjectContext): string {
  const constraints = resolveGenerationConstraints(request);
  const budget = speechBudgetForRequest(request, ctx);
  const intent = inferCreativeIntent(request, ctx);
  // Word counts from planning models are approximate. Give strict no-dead-air
  // requests a small drafting cushion; measured provider audio remains the gate.
  const planningWordCushion = requestForbidsDeadAir(request) ? 6 : 0;
  const planningMinWords = budget.min_words + planningWordCushion;
  const planningMaxWords = budget.max_words + planningWordCushion;
  const tenSecondMinWords = Math.ceil(10 * budget.words_per_second * 0.94);
  const tenSecondMaxWords = Math.ceil(10 * budget.words_per_second);
  return [
    `Prompt: ${request.prompt}`,
    request.input_media.length > 0
      ? `Uploaded inputs:\n${request.input_media
          .map((media) => `- ${media.id}: ${media.kind} "${media.name}" (${media.mime_type})`)
          .join("\n")}`
      : "Uploaded inputs: none.",
    request.input_media.some((media) => media.kind === "image")
      ? "Reference-image rule: assign each uploaded image only to contextually relevant scenes using reference_media_ids. Preserve recognizable product/person identity, but do not turn an input into an unrelated first frame or force it into every scene."
      : "Reference-image rule: no uploaded image references are available.",
    request.input_media.some((media) => media.kind === "audio")
      ? "User-audio rule: the attached audio is the authoritative full-video voiceover. Plan visuals and scene timing around it, keep on_camera=false unless the prompt explicitly requests lip-sync, and do not generate replacement TTS."
      : "User-audio rule: no attached voiceover was supplied; generate speech only when the prompt calls for narration or dialogue.",
    `Aspect ratio: ${request.aspect_ratio}`,
    `Resolution: ${request.resolution}`,
    imageModelPolicyLine(request, ctx),
    `User-selected image resolution: ${request.image_resolution ?? "agent chooses"}.`,
    videoModelPolicyLine(request, ctx),
    `User-selected video resolution: ${request.video_resolution ?? request.resolution}.`,
    durationConstraintLine(constraints),
    sceneConstraintLine(constraints),
    magicHourCapabilityBrief(request),
    creativeIntentBrief(intent),
    "Prompt constraints are authoritative: preserve exact counts, minimum stages, prohibitions, metaphors, start/end anchors, and lighting requirements from the prompt.",
    `Target final runtime: ${budget.final_duration_seconds} seconds with hard cuts only.`,
    `Scene duration total: ${budget.scene_duration_total_seconds.toFixed(1)} seconds; scene durations should directly sum to the target.`,
    `Estimated TTS pace: ${budget.words_per_second.toFixed(2)} words/second.`,
    `Narration planning target: ${planningMinWords}-${planningMaxWords} spoken words. This includes a small drafting cushion when the user forbids dead air; measured provider audio is still validated against the requested runtime.`,
    `Hard narration word-count check: before calling draft_video_plan, count the actual spoken words across scene narrations. For a narrated video, the submitted payload MUST contain at least ${planningMinWords} and at most ${planningMaxWords} actual spoken words; do not estimate by sentence count, do not report a reasoning-only count, and do not submit below the floor.`,
    `Per-scene narration budget: after choosing scene durations, distribute the ${planningMinWords}-${planningMaxWords} planning target across the timeline in proportion to each narrated scene's duration. A 10-second narrated scene should usually carry about ${tenSecondMinWords}-${tenSecondMaxWords} spoken words. The per-scene allocations must add back up to the total planning target; do not fix low total coverage by overloading one short scene, and do not leave a long narrated scene with only a tiny line.`,
    ctx.audio_provider === "hume"
      ? "Hume timing rule: short sentence fragments and punctuation add real pauses. Keep spoken copy concise, avoid stacked fragments, and make each scene line fit its own duration before TTS."
      : "TTS timing rule: keep spoken copy concise enough to fit the requested runtime naturally before provider calls.",
    "Natural speech transition rule: the backend adds a subtle 0.5s micro-pause only when adjacent scenes truly change topics. Do not manually write [pause] tokens for ordinary scene changes.",
    "Narration is spoken voiceover copy for the selected TTS provider. Tell a compact story with character intention, " +
      "obstacle, change, and payoff. Do not write narration as image prompt prose, not camera direction, " +
      "and not a production note; keep visual inventory in image_prompt instead.",
    "Spoken-script sanity rule: narration must be words a person or narrator would actually say. Never say meta planning " +
      "phrases like 'the proof matters,' 'the ending should feel,' 'this scene shows,' 'benefit is easy to understand,' " +
      "or 'the product feels useful.' Rewrite those as concrete human experience.",
    "First-run production decision contract: decide the format intent before drafting scenes " +
      "(UGC, product demo, problem-solution, testimonial, founder story, comparison, tutorial, cinematic story, explicitly requested music video, YouTube clips, or general video). " +
      "The scene grammar must match that inferred intent; do not force UGC hook/proof/CTA structure onto non-UGC prompts.",
    "Format-specific beat rule: UGC/testimonial/founder prompts need a human creator or reaction beat when the prompt calls for a person. " +
      "Product-demo/problem-solution/comparison prompts need visible proof/demo/closeup and a practical result/payoff. " +
      "Tutorial prompts need ordered process proof. Cinematic/general videos need coherent story progression and payoff without forced creator dialogue. " +
      "Do this inside the first draft, not as a post-render fix.",
    "Scene progression rule: adjacent scenes must be causally different. Do not restate the same product action, reminder, app/progress proof, creator reaction, payoff, or spoken line in consecutive scenes.",
    "Causal narration alignment: when a narrated scene shows a person, child, animal, or product performing the scene's central fall, catch, arrival, handoff, impact, or result action, that active subject and action must be stated naturally in that scene's spoken line. Never move an action or subject between scenes without updating both the narration and visual continuity ledger.",
    "Quality-first scene pacing: for videos over 30 seconds, prefer fewer stronger 7-13 second scenes over many tiny " +
      "clips. Avoid multiple sub-5 second scenes unless the user explicitly requests a fast montage.",
    "For 45s+ UGC/talking ads, the spoken script must carry most of the requested runtime. Do not draft sparse " +
      "dialogue that forces the final video to pad the back half with silence.",
    "For 40-60s UGC/product ads, the sum of per-scene narration usually needs to be around 95-140 spoken words, " +
      "with longer b-roll proof beats using fuller VO rather than one tiny sentence.",
    "Voice identity contract: for every narrated single-speaker video, choose one plan-level voice that fits the visible speaker or narrator identity, genre, energy, and emotional tone. Do not reuse one generic default across unrelated projects. Keep the selected provider voice identity stable across every clip inside that video, and vary emotion with audio_mode/audio_note rather than changing speakers. Only change voices when the user explicitly requests multiple speakers, characters, or narrator roles.",
    "Scene audio ownership contract: set audio_source independently from audio_mode. Use voiceover for ElevenLabs narration over non-speaking footage, speech_driven only for explicitly visible speech/lip-sync, and native_scene_audio for movie-like, action, dialogue, ambience, foley, or music scenes that should keep MiniMax H3's own sound. Never assign two owners to one scene. native_scene_audio must have empty narration and a specific native_audio_prompt; voiceover/speech_driven must keep native_audio_prompt null.",
    "Editable storyboard contract: treat the saved plan, scene images, scene videos, scene voiceovers, timeline clips, and final stitch as separate artifacts. Keep each scene's final attributes independent so a later edit can regenerate or replace one scene without rewriting unrelated scenes.",
    "Run isolation contract: this run may use only the current project's prompt, provider settings, project_state, and artifacts. Never borrow scene text, media paths, voices, or user preferences from another project id or queued generation.",
    "Provider-cost policy: get the plan right before any provider calls. Do not rely on automatic retries, duplicate " +
      "scene renders, or post-render subjective QA to make the video good.",
    "Voiceover expression cues: include bracketed natural-language cues at sentence starts only for pure b-roll voiceover, " +
      "such as [whispers softly], [speaks calmly], [curious], [tense], [laughs quietly], or [emphasis]. " +
      "These cue tokens are not spoken words; keep the spoken words within budget.",
    "Transition rule: use hard cuts only for now. Do not plan dissolves, fades, wipes, match cuts, or transition effects.",
    "Set scene durations as integers that total as close as possible to the target runtime.",
    "Each image_prompt should be concrete: subject, setting, light, composition, style, mood, and important visual details.",
    "For recurring characters, every image_prompt must repeat the full identity and outfit details; do not rely on relative wording like 'same woman' because each still image is generated independently.",
    "Put the complete recurring character identity in visual_bible so provider prompts can carry it into every independent image generation.",
    "Each video_prompt must describe only camera or subject motion that can happen in the current still image.",
    "Keep image_prompt under 75 words and video_prompt under 35 words.",
    "",
    magicHourModelCatalogForAgent(),
  ].join("\n");
}

export const YOUTUBE_SCRIPT_SYSTEM_PROMPT = `
You are a professional scriptwriter for an automated YouTube clip assembly pipeline.

Write a production-ready short-form script where every section can be matched to real YouTube footage.
The downstream tool only needs section dialogue, duration_seconds, and search_hint.

Section timing rules:
- If the user asks for a scene count, use exactly that many sections.
- Otherwise, duration less than or equal to eighteen seconds: two equal sections.
- Nineteen to twenty-four seconds: three equal sections.
- Twenty-five to twenty-eight seconds: four equal sections.
- Twenty-nine seconds: five sections at about five point eight seconds each.
- Thirty seconds: exactly five six-second sections.
- Thirty-one to forty seconds: five or six sections at about six to seven seconds each.
- More than forty seconds: use about one section per six point five seconds.
- Keep section durations contiguous in spirit and make the total close to the requested runtime.

Dialogue rules:
- Keep dialogue natural, neutral, informative, and creator-like.
- Open with a strong hook and speak directly to "you" only when it fits the subject.
- Mix punchy one-liners with slightly longer lines.
- End with one concrete payoff or next step.
- Write all numbers as words in dialogue.
- Do not write camera direction, production notes, or visual descriptions as dialogue.

Search hint rules:
- Write concise, human-like YouTube search queries in six to eight words or fewer when possible.
- Use literal visual nouns for generic scene-setting footage; never add stock, stock video, stock footage, watermark, or preview-source terms.
- Prefer genuine YouTube videos from creators, official channels, news outlets, institutions, or documentary-style uploads over source-library preview clips.
- For specific people, brands, events, logos, games, keynotes, or real-world moments, keep the query literal and do not add a stock suffix.
- Match each search hint closely to its dialogue and the requested visual beat.
- Target concrete action or real footage of the subject; avoid query terms like "intro", "title sequence", "trailer", "outro", "subscribe", "reaction", or "compilation intro" that surface title cards, end-screens, or subscribe CTAs instead of usable footage. Prefer raw, official, or broadcast footage.
- Do not put duration, aspect ratio, scene-count instructions, or "make/create/use scenes" in search_hint.

Search targeting rules (per section, all optional — set them only when they sharpen retrieval):
- These fields map directly to YouTube Data API search parameters; use them instead of stuffing qualifiers into search_hint.
- search_order: "date" for breaking or recent coverage, "viewCount" for iconic widely-seen moments, "relevance" otherwise. Leave unset when unsure.
- published_after / published_before (YYYY-MM-DD): bound the upload window for time-anchored events, for example a product launch, a game, or a news cycle. Use both to pin a historical event to its era and avoid modern retrospectives.
- video_duration: "short" (under four minutes) for clips and highlights, "medium" (four to twenty minutes) for typical coverage, "long" for keynotes, full games, or documentaries.
- video_category: set when the subject clearly belongs to one category, for example news_politics for current events, sports for game footage, science_technology for tech launches, education for explainers.
- require_captions: set true when the scene depends on spoken content being findable in the transcript; leave false for visual b-roll where captions do not matter.
- channel_hint: name the channel or outlet whose footage is wanted when the source matters, for example "OpenAI" for official product demos, "NFL" for game action, "Apple" for keynote footage. The backend folds it into search and prefers matching channels.
- candidate_video_urls: optional direct YouTube URLs only when the user gives a specific source URL, or when WebSearchTool was already needed for factual currentness and a strong direct YouTube result appears naturally. Do not use web search just to find routine b-roll; the backend will search YouTube Data API from search_hint.

Currentness rules:
- Decide whether the prompt depends on information that may have changed after model training.
- If it asks for latest, today, current, breaking, news, recent products, model releases, public figures, sports, prices, laws, safety guidance, or other time-sensitive facts, use WebSearchTool before naming a specific current product, event, date, or claim.
- For stable historical, fictional, evergreen educational, or purely visual prompts, do not use web search.
- If the prompt only asks to prioritize recent/timely source clips, do not use web search for that alone; set search_order/date targeting fields for YouTube Data API instead.
- If no verified current detail is available, keep the dialogue source-oriented and make search hints target official or reputable current-source footage rather than inventing a product name.
`.trim();

export function buildYoutubeScriptPrompt(request: CreateProjectRequest, ctx: ProjectContext): string {
  const constraints = resolveGenerationConstraints(request);
  const budget = speechBudgetForRequest(request, ctx);
  const sceneCount =
    constraints.scene_count !== null && constraints.scene_mode === "exact"
      ? String(constraints.scene_count)
      : "planner chooses by timing rules";
  return [
    YOUTUBE_SCRIPT_SYSTEM_PROMPT,
    "",
    `Current date: ${new Date().toISOString().slice(0, 10)}`,
    `Prompt: ${request.prompt}`,
    `Target runtime seconds: ${budget.final_duration_seconds}`,
    `Requested scene count: ${sceneCount}`,
    `Aspect ratio: ${request.aspect_ratio}`,
    `Resolution: ${request.resolution}`,
    `Spoken narration budget: ${budget.min_words}-${budget.max_words} words total across all section dialogue.`,
    "Return a concise title, web_search_needed, web_search_reason, and ordered sections only.",
  ].join("\n");
}

export function normalizeYoutubeScriptPlan(plan: YouTubeScriptPlan): YouTubeScriptPlan {
  const normalizedDate = (value: string | null | undefined): string | null => {
    const text = String(value ?? "").trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
  };
  const sections = plan.sections.map((section, index) => ({
    ...section,
    section: index + 1,
    dialogue: section.dialogue.replace(/\s+/g, " ").trim(),
    search_hint: compactSearchQuery(section.search_hint),
    published_after: normalizedDate(section.published_after),
    published_before: normalizedDate(section.published_before),
    duration_seconds: Math.max(1, Math.min(30, Math.round(section.duration_seconds))),
  }));
  const title = plan.title.replace(/\s+/g, " ").trim() || "YouTube Short";
  return {
    title: title.slice(0, 120),
    web_search_needed: plan.web_search_needed,
    web_search_reason: plan.web_search_reason.slice(0, 300),
    sections,
  };
}

export function youtubeScriptNarration(plan: YouTubeScriptPlan): string {
  return plan.sections
    .map((section) => section.dialogue.trim())
    .filter(Boolean)
    .join(" ");
}

export function isFactualYoutubePrompt(prompt: string): boolean {
  if (!FACTUAL_YOUTUBE_PROMPT_PATTERN.test(prompt)) return false;
  if (HISTORICAL_YOUTUBE_PROMPT_PATTERN.test(prompt) && !/\b(latest|today|tonight|current|breaking|news)\b/i.test(prompt)) {
    return false;
  }
  return true;
}

export function importantFactualSubjectTokens(prompt: string): Set<string> {
  return new Set(
    findAll(WORD_PATTERN, prompt)
      .filter((token) => token.length >= 3 && !FACTUAL_SUBJECT_STOPWORDS.has(token.toLowerCase()))
      .map((token) => token.toLowerCase()),
  );
}

// Words that may appear capitalized at the start of a clause / sentence and are
// NOT, on their own, evidence of a proper-noun subject. Kept deliberately broad:
// false negatives (returning null) fall back to today's behavior, while false
// positives would wrongly constrain unrelated prompts.
const DOMINANT_SUBJECT_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "about",
  "build",
  "create",
  "generate",
  "i",
  "in",
  "make",
  "me",
  "of",
  "on",
  "or",
  "real",
  "short",
  "shorts",
  "the",
  "this",
  "use",
  "using",
  "video",
  "videos",
  "with",
  "youtube",
  "yt",
]);
// Lowercase connector words allowed *inside* a multi-word proper-noun span
// (e.g. "Lord of the Rings", "Kansas City Chiefs" has none, but proper place
// names can). They never start or end a span.
const DOMINANT_SUBJECT_CONNECTORS = new Set(["of", "the", "and", "for", "de", "del", "la", "le"]);
const QUOTED_NAME_PATTERN = /["“”']([^"“”']{2,60})["“”']/g;
const CAPITALIZED_TOKEN_PATTERN = /^[A-Z][A-Za-z0-9'’.&-]*$/;

function dominantSubjectTokenizeSpan(span: string): string[] {
  return findAll(WORD_PATTERN, span)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 3 && !DOMINANT_SUBJECT_CONNECTORS.has(token));
}

/**
 * Returns a confident dominant proper-noun subject for a source prompt, or null
 * when there is no confident subject (abstract / lowercase prompts). Conservative
 * by design: precision over recall. Recognizes multi-word capitalized proper-noun
 * spans and quoted names. Single capitalized words are accepted only when they are
 * not sentence-start / instruction stopwords AND appear after the opening word
 * (so a leading "Make"/"A" sentence-start cannot masquerade as a subject).
 */
export function extractDominantSubject(sourcePrompt: string): { tokens: string[]; phrase: string } | null {
  if (!sourcePrompt || !sourcePrompt.trim()) return null;
  const candidates: { phrase: string; tokens: string[] }[] = [];

  // 1) Quoted names are an explicit, high-confidence subject signal.
  for (const match of sourcePrompt.matchAll(QUOTED_NAME_PATTERN)) {
    const phrase = match[1]!.replace(/\s+/g, " ").trim();
    const tokens = dominantSubjectTokenizeSpan(phrase);
    if (tokens.length > 0) candidates.push({ phrase, tokens });
  }

  // 2) Capitalized proper-noun spans. Tokenize while tracking which words begin
  // a sentence (after . ! ? or at position 0), because a sentence-leading
  // capital is ambiguous (e.g. "Make ...") and is never treated as a stand-alone
  // single-word subject.
  const words: string[] = [];
  const isSentenceStart: boolean[] = [];
  let nextStartsSentence = true;
  for (const match of sourcePrompt.matchAll(/[A-Za-z0-9'’.&-]+|[.!?]+/g)) {
    const piece = match[0]!;
    if (/^[.!?]+$/.test(piece)) {
      nextStartsSentence = true;
      continue;
    }
    words.push(piece);
    isSentenceStart.push(nextStartsSentence);
    nextStartsSentence = false;
  }
  let runStart = -1;
  const flushRun = (endExclusive: number) => {
    if (runStart < 0) return;
    const start = runStart;
    runStart = -1;
    // Trim trailing connectors.
    let end = endExclusive;
    while (end - 1 > start && DOMINANT_SUBJECT_CONNECTORS.has(words[end - 1]!.toLowerCase())) {
      end -= 1;
    }
    const spanWords = words.slice(start, end);
    if (spanWords.length === 0) return;
    const capitalizedCount = spanWords.filter((word) => CAPITALIZED_TOKEN_PATTERN.test(word)).length;
    const meaningful = spanWords.filter((word) => {
      const lower = word.toLowerCase();
      return word.length >= 3 && !DOMINANT_SUBJECT_STOPWORDS.has(lower);
    });
    if (meaningful.length === 0) return;
    // Multi-word capitalized spans are confident. A lone capitalized word is
    // confident ONLY when it does not begin its sentence (so a leading
    // "Make"/"A" cannot masquerade as a subject) and is not an instruction
    // stopword.
    const isSingleWord = capitalizedCount < 2;
    if (isSingleWord) {
      if (spanWords.length !== 1) return;
      if (isSentenceStart[start]) return;
      const lone = spanWords[0]!;
      if (lone.length < 4) return;
      if (DOMINANT_SUBJECT_STOPWORDS.has(lone.toLowerCase())) return;
    }
    const phrase = spanWords.join(" ").replace(/[.\s]+$/, "").trim();
    const tokens = dominantSubjectTokenizeSpan(phrase).filter(
      (token) => !DOMINANT_SUBJECT_STOPWORDS.has(token),
    );
    if (tokens.length > 0) candidates.push({ phrase, tokens });
  };
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    const lower = word.toLowerCase();
    const isCapital = CAPITALIZED_TOKEN_PATTERN.test(word);
    const isConnector = DOMINANT_SUBJECT_CONNECTORS.has(lower);
    if (isCapital || (isConnector && runStart >= 0)) {
      if (runStart < 0) runStart = i;
    } else {
      flushRun(i);
    }
  }
  flushRun(words.length);

  if (candidates.length === 0) return null;
  // Pick the candidate with the most subject tokens (longest confident span),
  // breaking ties toward the earliest occurrence.
  let best = candidates[0]!;
  for (const candidate of candidates.slice(1)) {
    if (candidate.tokens.length > best.tokens.length) best = candidate;
  }
  // Dedupe tokens, preserve order.
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const token of best.tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  if (tokens.length === 0) return null;
  return { tokens, phrase: best.phrase };
}

export function compactSearchQuery(query: string, maxLength = 120): string {
  const cleaned = query.replace(/\s+/g, " ").replace(/^[ ,;-]+|[ ,;-]+$/g, "");
  if (cleaned.length <= maxLength) return cleaned;
  const clippedRaw = cleaned.slice(0, maxLength);
  const lastSpace = clippedRaw.lastIndexOf(" ");
  const clipped = (lastSpace > 0 ? clippedRaw.slice(0, lastSpace) : clippedRaw).replace(/^[ ,;-]+|[ ,;-]+$/g, "");
  return clipped || cleaned.slice(0, maxLength).trim();
}

export function dedupeQueryWords(query: string): string {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const word of findAll(WORD_PATTERN, query)) {
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    words.push(word);
  }
  return words.join(" ");
}

export function extractOpenaiProductTerms(text: string): string[] {
  const terms: string[] = [];
  for (const match of text.matchAll(OPENAI_PRODUCT_TERM_PATTERN)) {
    const term = match[1]!.replace(/\s+/g, " ").trim();
    const key = term.toLowerCase();
    if (!terms.some((existing) => existing.toLowerCase() === key)) {
      terms.push(term);
    }
  }
  return terms;
}

export function hasOpenaiProductTerm(text: string): boolean {
  return new RegExp(OPENAI_PRODUCT_TERM_PATTERN.source, "i").test(text);
}

export function isOpenaiYoutubePrompt(prompt: string): boolean {
  return prompt.toLowerCase().includes("openai") || hasOpenaiProductTerm(prompt);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function enrichOpenaiProductQuery(query: string, productTerms: string[]): string {
  let enriched = query;
  for (const term of productTerms.slice(0, 2)) {
    if (new RegExp(`\\b${escapeRegex(term)}\\b`, "i").test(enriched)) continue;
    if (/\bOpenAI\b/i.test(enriched)) {
      enriched = enriched.replace(/\bOpenAI\b/i, `OpenAI ${term}`);
    } else {
      enriched = `OpenAI ${term} ${enriched}`;
    }
  }
  return compactSearchQuery(dedupeQueryWords(enriched));
}

export function compactOpenaiProductHint(sourcePrompt: string, hint: string): string {
  let compacted = videoFriendlyOpenaiSearchHint(hint);
  if (sourcePrompt.toLowerCase().includes("openai") && !/\bOpenAI\b/i.test(compacted)) {
    compacted = `OpenAI ${compacted}`;
  }
  const allowsReputableSources = openaiPromptAllowsReputableSources(sourcePrompt);
  if (
    /\b(?:official|reputable)\b/i.test(sourcePrompt) &&
    !/\b(?:official|reuters|cnbc|associated press|ap news|the verge|techcrunch)\b/i.test(compacted)
  ) {
    compacted = `${compacted} ${allowsReputableSources ? "news" : "official"}`;
  }
  return compactSearchQuery(dedupeQueryWords(compacted));
}

export function openaiPromptAllowsReputableSources(sourcePrompt: string): boolean {
  return /\bofficial\s+or\s+reputable\b|\breputable\s+(?:sources?|coverage)\b/i.test(sourcePrompt);
}

export function isCurrentOpenaiSourcePrompt(sourcePrompt: string): boolean {
  return (
    sourcePrompt.toLowerCase().includes("openai") &&
    /\b(?:latest|today|tonight|current|breaking|recent|news|new)\b/i.test(sourcePrompt)
  );
}

export function preserveCurrentOpenaiFreshness(sourcePrompt: string, query: string): string {
  const cleaned = compactSearchQuery(query);
  if (!isCurrentOpenaiSourcePrompt(sourcePrompt)) return cleaned;
  if (/\b(?:latest|today|tonight|current|breaking|recent)\b/i.test(cleaned)) return cleaned;
  return compactSearchQuery(dedupeQueryWords(`latest ${cleaned}`));
}

export function videoFriendlyOpenaiSearchHint(hint: string): string {
  let cleaned = compactSearchQuery(hint);
  if (SPELLED_OPENAI_MODEL_HINT_PATTERN.test(cleaned) && !hasOpenaiProductTerm(cleaned)) {
    cleaned = cleaned.replace(SPELLED_OPENAI_MODEL_HINT_PATTERN, "OpenAI latest product news");
  }
  cleaned = cleaned.replace(/\brelease\s+notes?\b/gi, "update");
  cleaned = cleaned.replace(/\b(?:newsroom|homepage|scroll(?:ing)?)\b/gi, " ");
  cleaned = compactSearchQuery(dedupeQueryWords(cleaned));
  if (["openai", "chatgpt", "openai chatgpt"].includes(cleaned.toLowerCase())) {
    cleaned = compactSearchQuery(`${cleaned} latest product news`);
  }
  return cleaned;
}

export function conciseYoutubeSearchQuery(text: string): string {
  let cleaned = compactSearchQuery(text);
  cleaned = cleaned.split(/\.\s+/, 1)[0]!;
  cleaned = cleaned.replace(/\bUse\s+(?:exactly\s+)?(?:\d{1,2}|one|two|three|four|five)\s+scenes?\b.*$/i, "");
  cleaned = cleaned.replace(/\bThe\s+narration\s+should\b.*$/i, "");
  let sourceClause = "";
  const usingMatch = cleaned.match(/\busing\b/i);
  if (usingMatch && usingMatch.index !== undefined) {
    sourceClause = cleaned.slice(usingMatch.index);
    cleaned = cleaned.slice(0, usingMatch.index);
  }
  cleaned = cleaned.replace(YOUTUBE_CREATION_PREFIX_PATTERN, "").replace(/^[ ,;-]+|[ ,;-]+$/g, "");
  cleaned = cleaned.replace(GENERIC_YOUTUBE_BROLL_PATTERN, " ").replace(/^[ ,;-]+|[ ,;-]+$/g, "");
  sourceClause = sourceClause.replace(YOUTUBE_SOURCE_FILLER_PATTERN, " ").replace(/^[ ,;-]+|[ ,;-]+$/g, "");
  let combined = compactSearchQuery(`${cleaned} ${sourceClause}`);
  if (
    /\bofficial\b/i.test(sourceClause) &&
    /\bproduct\b/i.test(combined) &&
    !/\b(?:demo|announcement)\b/i.test(combined)
  ) {
    combined = compactSearchQuery(`${combined} demo`);
  }
  return compactSearchQuery(dedupeQueryWords(combined));
}

export function looksLikeYoutubeCreationInstruction(hint: string): boolean {
  return (
    /\b(?:make|create|generate|build)\b/i.test(hint) &&
    /\b(?:youtube|clips?|short|video|reel|seconds?|scenes?)\b/i.test(hint)
  );
}

export function cleanSectionSearchHint(section: YouTubeClipSection): string {
  let hint = section.search_hint;
  if (looksLikeYoutubeCreationInstruction(hint)) {
    const cleanedInstruction = conciseYoutubeSearchQuery(hint);
    if (cleanedInstruction) return cleanedInstruction;
    hint = section.dialogue;
  }
  const cleaned = conciseYoutubeSearchQuery(hint);
  return cleaned || compactSearchQuery(section.dialogue);
}

export function carrySourceSubjectTerms(sourcePrompt: string, searchHint: string): string {
  const hint = compactSearchQuery(searchHint);
  const promptLower = sourcePrompt.toLowerCase();
  const hintLower = hint.toLowerCase();
  if (/\bancient coins?\b/.test(promptLower) && /\bcoins?\b/.test(hintLower) && !hintLower.includes("ancient")) {
    return compactSearchQuery(hint.replace(/\bcoins?\b/i, "ancient coin"));
  }
  if (
    promptLower.includes("deep sea") &&
    !hintLower.includes("deep sea") &&
    /\b(?:ocean|marine|underwater|submersible|rov|squid|jellyfish|researchers?|footage)\b/.test(hintLower)
  ) {
    return compactSearchQuery(`deep sea ${hint}`);
  }
  if (
    promptLower.includes("saquon barkley") &&
    !/\b(?:saquon|barkley)\b/.test(hintLower) &&
    /\b(?:eagles|rams|jaguars|packers|touchdowns?|hurdle|season|highlights?)\b/.test(hintLower)
  ) {
    return compactSearchQuery(`Saquon Barkley ${hint}`);
  }
  if (
    promptLower.includes("steve jobs") &&
    !/\b(?:steve|jobs)\b/.test(hintLower) &&
    /\b(?:iphone|ipod|macworld|keynote|phone|internet communicator)\b/.test(hintLower)
  ) {
    return compactSearchQuery(`Steve Jobs ${hint}`);
  }
  if (isOpenaiYoutubePrompt(sourcePrompt) && /\b(?:openai|chatgpt|gpt|codex)\b/i.test(hint)) {
    return preserveCurrentOpenaiFreshness(sourcePrompt, compactOpenaiProductHint(sourcePrompt, hint));
  }
  return hint;
}

export function uniqueYoutubeSearchHint(baseHint: string, duplicateIndex: number): string {
  if (duplicateIndex <= 0) return baseHint;
  const suffixes = /\b(?:openai|product)\b/i.test(baseHint)
    ? YOUTUBE_PRODUCT_DUPLICATE_HINT_SUFFIXES
    : YOUTUBE_DUPLICATE_HINT_SUFFIXES;
  const suffix = suffixes[(duplicateIndex - 1) % suffixes.length]!;
  return compactSearchQuery(dedupeQueryWords(`${baseHint} ${suffix}`));
}

export function dedupeYoutubeSectionHints(sections: YouTubeClipSection[]): YouTubeClipSection[] {
  const seen = new Map<string, number>();
  return sections.map((section) => {
    const key = section.search_hint.toLowerCase();
    const duplicateIndex = seen.get(key) ?? 0;
    seen.set(key, duplicateIndex + 1);
    return { ...section, search_hint: uniqueYoutubeSearchHint(section.search_hint, duplicateIndex) };
  });
}

const MONTH_OR_YEAR_PATTERN =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|20\d{2})\b/i;

export function factualYoutubeSearchHint(sourcePrompt: string, hint: string, productTerms: string[] | null = null): string {
  let prompt = conciseYoutubeSearchQuery(sourcePrompt);
  let cleanedHint = conciseYoutubeSearchQuery(hint) || prompt;
  if (sourcePrompt.toLowerCase().includes("openai")) {
    cleanedHint = videoFriendlyOpenaiSearchHint(cleanedHint);
  }
  if (sourcePrompt.toLowerCase().includes("openai") && hasOpenaiProductTerm(cleanedHint)) {
    return preserveCurrentOpenaiFreshness(sourcePrompt, compactOpenaiProductHint(sourcePrompt, cleanedHint));
  }
  const shouldEnrichOpenaiProducts = Boolean(productTerms && productTerms.length > 0) && !MONTH_OR_YEAR_PATTERN.test(cleanedHint);
  if (sourcePrompt.toLowerCase().includes("openai") && shouldEnrichOpenaiProducts) {
    prompt = enrichOpenaiProductQuery(prompt, productTerms!);
    cleanedHint = enrichOpenaiProductQuery(cleanedHint, productTerms!);
    if (hasOpenaiProductTerm(cleanedHint)) {
      if (
        openaiPromptAllowsReputableSources(sourcePrompt) &&
        !/\b(news|official|press|update|briefing|local)\b/i.test(cleanedHint)
      ) {
        cleanedHint = compactSearchQuery(`${cleanedHint} news`);
      }
      return preserveCurrentOpenaiFreshness(sourcePrompt, cleanedHint);
    }
  }
  const subjectTokens = importantFactualSubjectTokens(prompt);
  const hintTokens = new Set(findAll(WORD_PATTERN, cleanedHint).map((token) => token.toLowerCase()));
  const isSubset = [...subjectTokens].every((token) => hintTokens.has(token));
  if (subjectTokens.size > 0 && !isSubset) {
    if (!(sourcePrompt.toLowerCase().includes("openai") && MONTH_OR_YEAR_PATTERN.test(cleanedHint))) {
      cleanedHint = compactSearchQuery(`${prompt} ${cleanedHint}`);
    }
  }
  if (!/\b(news|official|press|update|briefing|local)\b/i.test(cleanedHint)) {
    cleanedHint = compactSearchQuery(`${cleanedHint} news`);
  }
  return preserveCurrentOpenaiFreshness(sourcePrompt, cleanedHint);
}

/**
 * Prepend a confident dominant subject phrase to a search hint when the hint
 * mentions none of the subject tokens, so the retrieved clip is constrained to
 * the prompt's subject. No-op when there is no confident subject.
 */
export function applyDominantSubjectToHint(
  subject: { tokens: string[]; phrase: string } | null,
  hint: string,
): string {
  if (!subject || subject.tokens.length === 0) return hint;
  const hintTokens = new Set(findAll(WORD_PATTERN, hint).map((token) => token.toLowerCase()));
  if (subject.tokens.some((token) => hintTokens.has(token))) return hint;
  return compactSearchQuery(`${subject.phrase} ${hint}`);
}

export function normalizeYoutubeSectionsForProject(
  ctx: ProjectContext,
  sections: YouTubeClipSection[],
): YouTubeClipSection[] {
  const state = readProjectState(ctx);
  const sourcePrompt = String((state.user_preferences ?? {}).prompt || "");
  // Confident proper-noun subject (e.g. "Patrick Mahomes", "Steve Jobs"). Null
  // for abstract/lowercase prompts, in which case behavior is unchanged.
  const subject = extractDominantSubject(sourcePrompt);
  // Per-section hint cleanup differs by branch (factual vs. evergreen), but the
  // generic subject enforcement (hint injection + subject_tokens attachment) is
  // applied uniformly afterward so it covers BOTH branches.
  const attachSubject = (section: YouTubeClipSection, cleanedHint: string): YouTubeClipSection => {
    const search_hint = applyDominantSubjectToHint(subject, cleanedHint);
    if (!subject || subject.tokens.length === 0) return { ...section, search_hint };
    return { ...section, search_hint, subject_tokens: subject.tokens };
  };

  if (!sourcePrompt || !isFactualYoutubePrompt(sourcePrompt)) {
    const cleanedSections = sections.map((section) =>
      attachSubject(section, carrySourceSubjectTerms(sourcePrompt, cleanSectionSearchHint(section))),
    );
    return dedupeYoutubeSectionHints(cleanedSections);
  }
  let productTerms: string[] = [];
  if (sourcePrompt.toLowerCase().includes("openai")) {
    for (const section of sections) {
      productTerms.push(...extractOpenaiProductTerms(section.dialogue));
    }
    productTerms = [...new Set(productTerms)];
  }
  const normalized = sections.map((section) =>
    attachSubject(section, factualYoutubeSearchHint(sourcePrompt, cleanSectionSearchHint(section), productTerms)),
  );
  return dedupeYoutubeSectionHints(normalized);
}

export function buildYoutubeWorkflowBrief(request: CreateProjectRequest, ctx: ProjectContext): string {
  const constraints = resolveGenerationConstraints(request);
  const budget = speechBudgetForRequest(request, ctx);
  const lines = [
    "Workflow: youtube_clips.",
    "Create a short assembled from searched YouTube clips, current-project TTS voiceover, and ffmpeg stitching.",
    "You must call create_youtube_short_from_prompt exactly once. After it returns a manifest, stop and respond with a brief completion summary.",
    "Do not draft title, narration, or section JSON yourself; the YouTube tool contains the notebook-style script planner.",
    "Do not call create_youtube_short, draft_video_plan, generate_scene_images, animate_scene_videos, or stitch_final_video for this workflow.",
    `Prompt: ${request.prompt}`,
    `Aspect ratio: ${request.aspect_ratio}`,
    `Resolution: ${request.resolution}`,
    "YouTube search provider: youtube_data_api. All clip search goes through the YouTube Data API.",
    durationConstraintLine(constraints),
    sceneConstraintLine(constraints),
    `Target final runtime: ${budget.final_duration_seconds} seconds with hard cuts only.`,
    `Spoken narration budget: ${budget.min_words}-${budget.max_words} words total across all section dialogue. This is a hard cap.`,
    "Scene duration formula: section seconds should directly sum to the target runtime; use hard cuts only.",
  ];
  if (isFactualYoutubePrompt(request.prompt)) {
    lines.push(
      "Factual/current-event YouTube mode is required.",
      "Use WebSearchTool first inside the prompt-based YouTube script planner before naming current products, events, dates, or claims.",
      "The generated search hints must preserve the factual subject from the user's prompt and verified current-event terms.",
      "Do not use generic b-roll terms like stock, vertical, shorts, police lights, or street scene unless they are part of a specific factual source query.",
    );
  } else {
    lines.push(
      "The prompt-based YouTube script planner will make literal search hints for real people/events/brands and genuine YouTube footage hints without stock or watermark terms.",
    );
  }
  lines.push(
    "The YouTube tool will draft the script, search hints, and section durations from the current project request.",
    "The tool will download clips, generate one TTS voiceover, save project_state.json artifacts, and write manifest.json.",
  );
  return lines.join("\n");
}

export function buildProjectRunBrief(request: CreateProjectRequest, ctx: ProjectContext): string {
  if (request.workflow === "youtube_clips") {
    return buildYoutubeWorkflowBrief(request, ctx);
  }
  return buildGenerationBrief(request, ctx);
}

export function compactProjectStatusForAgent(status: JsonDict | null): JsonDict {
  if (!status) return {};
  const compact: JsonDict = {};
  for (const [key, value] of Object.entries(status)) {
    if (key !== "project_state") compact[key] = value;
  }
  return compact;
}

export function buildProjectMessageBrief(
  message: string,
  ctx: ProjectContext,
  status: JsonDict | null,
): string {
  const snapshot = {
    project_state: readProjectState(ctx),
    status: compactProjectStatusForAgent(status),
  };
  return [
    "A user sent a follow-up message for an existing video project.",
    "Keep the frontend separate; this is a backend agent turn over persisted project state.",
    "Do not start from scratch unless the user explicitly requests a new render.",
    "Inspect the saved project state and artifacts before deciding what to patch.",
    "Use revision tools for narrow changes, then restitch_video when the final edit changes.",
    `Default image model: ${ctx.image_model}. Use another image model only if the user explicitly asks or the prompt clearly needs that model-specific capability.`,
    `Default image-to-video model: ${ctx.video_model}. Use another model only if the user explicitly asks or the prompt clearly needs that model-specific capability.`,
    `Project directory: ${ctx.project_dir}`,
    `Project state file: ${artifactPath(ctx, "project_state")}`,
    "",
    magicHourModelCatalogForAgent(),
    "",
    "User message:",
    message,
    "",
    "Current project snapshot JSON:",
    JSON.stringify(snapshot, null, 2),
  ].join("\n");
}

export function agentResponseContent(value: unknown): string {
  if (value === null || value === undefined) return "Agent turn completed.";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

export const INSTRUCTIONS = `
You are a cinematic art director and autonomous video production agent.
Infer missing style details and make taste decisions when the user gave enough
minimum information to choose the right output and Magic Hour capability. If the
prompt does not specify enough to decide image vs video vs edit/source-media
workflow, or lacks the subject/source media needed by the chosen capability,
call request_clarification before any paid provider tool.

Use the video_studio tools as a bounded production loop:
1. Choose the output capability first. For image-only requests, call
   generate_magic_hour_images and stop after the image manifest is written. For
   underspecified requests, call request_clarification and stop. For video
   requests, continue with the video planning loop below.
2. Call draft_video_plan with the complete title, visual bible, and scene list.
   The ordered per-scene narration fields are the canonical spoken script.
   The backend joins them into the full voiceover; do not create or count a
   separate summary. Count only the actual scene narration strings submitted
   in the tool payload.
   If draft_video_plan returns validation_failed=true, fix only the listed
   objective planning issues and call draft_video_plan one more time before any
   provider tools. Treat every "max N words" narration issue as a hard cap and
   every "N+ words" or minimum-word issue as a hard floor. Count the revised
   spoken words before the second tool call; never resubmit below the stated floor.
   Preserve the accepted scene count, durations, and valid spoken sentences
   during repair. Patch only the fields named by validation; never replace a
   complete script with a shorter rewrite.
   remove visual/schema words from spoken narration, and use only supported
   b-roll durations for the selected video model. If the user already provided
   product/subject, runtime, and output type, do not call request_clarification
   after a draft validation failure; repair the draft instead. Do not call
   provider tools until the plan is accepted.
3. Call generate_voiceover immediately after the plan is saved. If
   generate_voiceover returns validation_failed=true, redraft a shorter natural
   script with draft_video_plan before any image or video generation. Never
   solve a long voiceover by letting the final edit cut off the audio.
4. Call generate_scene_images only after voiceover is accepted or skipped for
   a per-scene audio/talking plan.
5. Call animate_scene_videos after images exist. For a first full render, render
   every planned scene; selected scene ids are only for explicit user edit/retry
   requests.
6. Call inspect_render_status whenever an asset step is incomplete or unclear.
7. Call retry_scene for failed or missing scene assets before final stitching.
   If a failure includes a provider_job_id, call stitch_final_video first so the
   existing Magic Hour job can be recovered before spending on retry_scene.
   Only retry or regenerate scenes that actually FAILED and are not recoverable
   from an existing provider job — never re-render a scene that already succeeded,
   even after a transient error elsewhere.
8. Call stitch_final_video only once every planned scene has a completed scene
   video and a voiceover, or when inspect_render_status shows recoverable
   provider failures that stitch_final_video can recover from existing job ids.
9. Call record_project_decision for important creative choices, retry choices,
   or user-preference interpretations that should persist in project_state.json.
10. After inspecting a result, use revision tools for narrow patches:
   regenerate_scene for one bad scene, revise_narration for script edits,
   replace_voiceover for stale audio, and restitch_video to verify the patched
   edit. For on-camera (talking) videos, do NOT call replace_voiceover or add a
   global voiceover — each talking scene already carries its own synced dialogue
   audio. replace_voiceover is for b-roll/voiceover videos only.

When the brief says Workflow: youtube_clips, use
youtube_short.create_youtube_short_from_prompt instead of the Magic Hour
image/video tools. The YouTube tool owns notebook-style script planning, search
hints, clip download, voiceover, stitching, project state, and manifest creation.

Quality rules:
- First-run quality matters most. Make the strongest plan before provider calls;
  do not depend on automatic rerenders, broad retries, or post-render subjective
  QA to make a mediocre draft acceptable.
- Decide the creative format explicitly in your planning: day-in-life,
  problem-solution, product-demo, testimonial, founder-story, comparison,
  cinematic story, or explicitly requested music video. Never infer music-video
  grammar merely from uploaded audio or a request for background music. Use scene
  order, pacing, and proof beats that fit the selected format.
- Choose a creative_vibe explicitly from the VideoPlan schema and make every
  image_prompt and video_prompt fit it. The vibe controls lighting, camera
  energy, realism level, production polish, and creator/product framing.
- Default to on_camera=false. Use on_camera=true only when the user explicitly
  asks for a visible person/character/avatar/founder to speak, talk, say a line,
  lip-sync, or be a talking photo. A request for UGC, TikTok style, a normal
  person filming, testimonial tone, or creator-native pacing is NOT enough by
  itself to require lip-sync; it can be voiceover over creator/product visuals.
- For product demos, cinematic stories, tutorials, YouTube/source-footage edits,
  mostly visual requests, and ordinary UGC/product ads, set on_camera=false and
  let narration play as voiceover over b-roll/product/demo footage unless the
  visible-speaker request is explicit.
- Set audio_source per scene. Use voiceover when one stable ElevenLabs narrator
  speaks over non-speaking footage. Use speech_driven only with on_camera=true
  when external TTS must drive visible speech/lip-sync. Use native_scene_audio
  for movie-like, action, character-dialogue, or atmospheric scenes where
  MiniMax H3 should generate the dialogue, ambience, foley, and music itself.
- A scene has exactly one audio owner. For native_scene_audio, leave narration
  empty and write a precise native_audio_prompt naming audible dialogue,
  ambience, foley, and music. For voiceover or speech_driven, keep
  native_audio_prompt null so H3 audio cannot compete with external speech.
- For 45-70s UGC/product ads without explicit visible speech, use about 5-7
  non-lip-synced scenes with product/demo/result/creator-reaction visuals and
  one consistent voiceover. If the user explicitly asks for on-camera speaking,
  use only the few talking scenes needed and keep them short.
- Write a specific, natural script with tension, intention, and payoff. No
  hype filler, no "this video".
- Spoken narration must never sound like a storyboard note, creative brief, or
  plan rationale. Do not say "the proof matters," "the ending should feel,"
  "this scene shows," "benefit is easy to understand," or "the product feels
  useful." Say the human moment instead: what the speaker noticed, did, felt,
  or would recommend.
- For UGC/social/testimonial/founder speech, write like a normal creator
  talking into their phone, not a brand announcer. Use first person, contractions,
  short sentences, everyday specifics, and light imperfections. Avoid polished
  ad phrases like "introducing," "experience the," "say goodbye to,"
  "revolutionary," "seamless," "elevate," "unlock," "game-changer," or
  "in today's fast-paced world." Do not force slang; use it only when it would
  genuinely fit the character.
- Do not put bracketed performance cues in UGC/on-camera narration. The spoken
  line should be exactly what the person would say aloud.
- For UGC/social/testimonial/founder prompts, the plan must contain a
  creator/reaction beat. For product/commercial prompts, the plan must contain
  a visible product proof/demo/closeup/result beat and a payoff or
  creator-native CTA near the end.
- For 45s+ UGC/product ads, write enough natural spoken copy to carry most of
  the requested runtime. Do not leave the back half dependent on silent padding.
- The requested duration is a hard final-runtime cap. The spoken script must
  fit naturally before provider calls; never rely on trimming, fading, or
  cutting off generated audio at the cap.
- Let the story determine scene count inside a nonlinear pacing band: usually
  3-5 scenes at 15s or less, 4-8 scenes at 16-30s, 5-10 scenes at 31-60s, and
  6-10 scenes above 60s. These are guardrails, not a fixed formula.
- Image prompts should be concrete: subject, setting, light, composition,
  style, mood, and continuity details.
- For on_camera=true scenes, make image_prompt a clear, front-facing, well-lit
  portrait of the speaker; this still image is animated into the talking clip
  by the AI Talking Photo pass, and the video_prompt is NOT used to render
  talking scenes.
- Treat each image prompt as the stable cinematic keyframe that the video model
  will animate. It must describe what is visible in one frame, not a sequence.
- Every image_prompt must be one full-frame image from one camera viewpoint.
  Never ask for split-screen, storyboard panels, collage, contact sheet, grid,
  vertical/horizontal stacked panels, or before/after layouts inside one still.
  If the story needs a comparison or sequence, make it separate scenes.
- Product keyframes should have one clear primary product instance or one
  natural paired product when appropriate, such as a pair of shoes. Do not ask
  for multiple duplicate bottles, jars, tubes, packages, variants, rows, or
  product lineups unless the user explicitly requested a lineup/comparison shot.
- Video prompts should describe camera motion and subject motion only. They
  govern b-roll cutaway scenes; do not write speech or talking action into a
  video_prompt.
- Video prompts should animate only what already exists in that keyframe: one
  camera move, at most one subject motion, no cuts, no scene changes, and no
  new objects.
- Use hard cuts between scenes for now. Do not plan fades, dissolves, wipes,
  match cuts, or transition effects.
- Choose Magic Hour image and image-to-video models yourself when the user does
  not specify them. Use model-specific strengths and constraints from the user
  brief and tool parameter descriptions.
- Keep motion realistic and easy for image-to-video to follow.
- Avoid text, logos, captions, distorted hands, and impossible camera moves.
  Never ask the image model to make a sign, flyer, label, screen, or poster read
  specific generated words, dates, or years; convey that information through
  narration and visible environmental change.
- Use enough cuts to keep the story moving while preserving readable action.
  A 30s video may use up to 8 purposeful scenes. Avoid repeated sub-3s flashes,
  but do not stretch one beat into a long static clip merely to reduce cuts.
- Make the total close to the requested duration.
- Fill each scene's continuity ledger before writing provider prompts. Track
  character/object identity, physical position, possession, direction of travel,
  setting, time, weather, palette, and style. The next opening_state must inherit
  the prior closing_state unless its story_beat explicitly describes the bridge.
- Build the visual_bible as a global world map before drafting individual scenes:
  recurring identities and wardrobe, important object appearance, fixed geography,
  time progression, visual medium, palette, lighting, and camera language. Do not
  truncate it into a fragment or replace it with mood adjectives alone.
- Plan all scene ledgers as one chronological state machine. For every physical
  event, describe where each subject begins, its direction and path through space,
  any contact or handoff, and where it ends. A fall must name the elevated origin,
  downward trajectory, and destination below; a catch must place the catcher under
  that path. Do not depict a gravity-driven fall as a horizontal throw. Give a
  complete fall-and-contact event at least 8 seconds and keep the origin, full
  trajectory, contact, and secured outcome visible in one wide or gently tracking
  view; never use a whip pan or reframe that can hide the result.
- Any person, animal, or object named in narration as physically present must be
  listed in required_subjects and visibly described in image_prompt. Symbolic
  stand-ins such as empty clothing, toys, photos, shoes, or props do not satisfy
  narration about the actual subject.
- For non-graphic historical rescue scenes involving children, preserve the event
  with provider-safe imagery: show a fully clothed or bundled child gently
  descending into waiting arms, with no injury, distress, exposed body, or impact.
  Keep the child visible rather than replacing the child with an empty prop.
- Image prompts should be detailed enough to regenerate the same world: normally
  55-120 words with exact subject identities, positions, foreground/background,
  location/time, style, light, lens/framing, and the single frozen action moment.
- Never use title cards, black/blank frames, text-only frames, or emoji-only
  scenes. Convey elapsed time and chapter changes through active footage.
- If the user's requested scene count conflicts with quality, choose the scene
  count that makes the best final video and explain that choice in the title or
  narration only if needed.
`.trim();
