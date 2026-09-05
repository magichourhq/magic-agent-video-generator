import type { ProjectContext } from "./context.js";
import {
  MAGIC_VIDEO_MODEL_DURATIONS,
  type CreateProjectRequest,
  type VideoVibe,
  type VideoPlan,
} from "./schemas.js";

export type CreativeFormat =
  | "general"
  | "ugc"
  | "product_demo"
  | "problem_solution"
  | "testimonial"
  | "founder_story"
  | "comparison"
  | "cinematic_ad"
  | "music_video"
  | "tutorial"
  | "youtube_clips";
export type CreativePlatform = "tiktok" | "reels" | "shorts" | "web" | "general";
export type CreativeGoal = "awareness" | "conversion" | "education" | "product_proof" | "story" | "edit";
export type CreativeSpeechMode = "quoted_user_speech" | "inferred_creator_dialogue" | "voiceover" | "mostly_visual";
export type RequiredBeat = "hook" | "creator_reaction" | "product_proof" | "broll_demo" | "payoff_cta";

export interface VideoVibeRule {
  label: string;
  cue: string;
  prompt_markers: RegExp;
  avoid: RegExp;
}

export interface CreativeIntent {
  format: CreativeFormat;
  platform: CreativePlatform;
  goal: CreativeGoal;
  speech_mode: CreativeSpeechMode;
  suggested_vibe: VideoVibe;
  required_beats: RequiredBeat[];
  pacing: {
    preferred_scene_count: number;
    min_scene_seconds: number;
    ideal_min_scene_seconds: number;
    ideal_max_scene_seconds: number;
  };
  video_model: string;
  notes: string[];
}

const QUOTED_SPEECH = /["“”'][^"“”'\n]{4,}["“”']/;
const EXPLICIT_QUOTED_SPEECH =
  /\b(?:say|says|saying|narration\s+says?|voiceover\s+says?|dialogue(?:\s+is)?|spoken\s+line(?:\s+is)?)\b[^"“”\n]{0,32}["“]([^"“”\n]{4,})["”]/gi;
const EXPLICIT_ENDING_NARRATION =
  /\b(?:end|finish|close)\b[^.!?\n]{0,220}?\b(?:narration|voice[- ]?over)\s+(?:says?|explains?|states?|notes?|reveals?)\s+(?:that\s+)?([^.!?\n]{4,180})/gi;

export function explicitQuotedSpeechLines(prompt: string): string[] {
  return [...prompt.matchAll(EXPLICIT_QUOTED_SPEECH)]
    .map((match) => String(match[1] ?? "").trim())
    .filter(Boolean);
}

function explicitEndingNarrationLines(prompt: string): string[] {
  return [...prompt.matchAll(EXPLICIT_ENDING_NARRATION)]
    .map((match) => String(match[1] ?? "").trim())
    .filter(Boolean);
}

function normalizeRequiredSpeech(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
const CREATOR_STYLE = /\b(ugc|tiktok|reel|shorts?|testimonial|founder|day[- ]?in[- ]?life|normal person|creator|influencer|selfie|talking to camera)\b/i;
const EXPLICIT_CREATOR_PRESENCE =
  /\b(ugc|testimonial|founder|normal person|creator|influencer|selfie|talking|speaking|someone filming|person filming|filming themselves|on camera)\b/i;
const EXPLICIT_VISIBLE_SPEECH =
  /\b(talking photo|lip[- ]?sync|lipsync|talking head|talk(?:ing)? to camera|speak(?:ing)? to camera|speaks? directly)\b|\b(?:creator|person|founder|avatar|character|speaker|man|woman|guy|girl|he|she|they|someone)\b.{0,64}\b(?:say|says|saying|speak|speaks|speaking|talk|talks|talking|narrate|narrates|deliver(?:s)? (?:the )?line)\b|\b(?:say|saying|speak|speaking|talking)\s+["“]/i;
const EXPLICIT_TALKING_THROUGHOUT =
  /\b(all|every|whole|entire|full).{0,24}(talking|speaking|talk to camera|talking to camera)|\b(talking head|single speaker|avatar)\b/i;
const PRODUCT = /\b(product|demo|ad|commercial|launch|brand|bottle|lamp|app|tool|software|feature|close[- ]?ups?)\b/i;
const PROBLEM_SOLUTION = /\b(problem|annoying|struggle|forget|pain|before|after|then show|helps?|fix(?:es)?|solution|instead)\b/i;
const COMPARISON = /\b(compare|comparison|versus|vs\.?|before and after|instead of|old way|new way)\b/i;
const NON_COMPARATIVE_INSTEAD =
  /\binstead of (?:repeating|reusing|showing|using|adding|creating|forcing|defaulting|making)\b/i;
const EXPLICIT_NO_SPEECH =
  /\b(no|without)\s+(?:narration|voiceover|dialogue|spoken words?|speech)\b|\b(?:music|ambience|ambient sound)\s+only\b/i;
const EXPLICIT_NARRATION = /\b(?:voice[- ]?over|narration|narrator)\b/i;
const TUTORIAL = /\b(tutorial|how to|step[- ]?by[- ]?step|walkthrough|teach|explain how)\b/i;
const FOUNDER = /\b(founder|startup|our story|why we built|behind the scenes)\b/i;
const TESTIMONIAL = /\b(testimonial|review|customer|i tried|my experience|honest take)\b/i;
const CINEMATIC = /\b(cinematic|polished|commercial|story commercial|brand film|dramatic|hero shot)\b/i;
const EXPLICIT_MUSIC_VIDEO =
  /\b(?:music video|song visualizer|music visualizer|performance video (?:for|to) (?:my|this|the) (?:song|track)|video (?:for|to) (?:my|this|the) (?:song|track)|visuals? (?:for|to) (?:my|this|the) (?:song|track))\b/i;
const EXPLICIT_EDIT_REQUEST =
  /(?:\b(?:edit|change|replace|regenerate|trim|speed up|slow down)\b.{0,48}\b(?:video|scene|clip|shot|audio|voiceover|narration)\b)|(?:\b(?:video|scene|clip|shot|audio|voiceover|narration)\b.{0,48}\b(?:edit|change|replace|regenerate|trim|speed up|slow down)\b)/i;
const VISUAL_DIRECTION = /\b(show|include|close[- ]?ups?|caption|captions|subtitles?|b[- ]?roll|camera|scene|shot|visual|reveal)\b/i;
const CTA = /\b(cta|call to action|buy|try|download|visit|sign up|shop|order|grab|get one|get yours|link in bio|bio link|tap the link|today|now)\b/i;
const PROOF =
  /\b(proof|demo|use|using|apply|applying|applied|close[- ]?up|feature|setting|before|after|result|screen|charging|brightness|reminds?|tracks?|workflow|serum|dropper|skin|texture|glow|shoe|sole|flex|stride|pan|cooking|meal|desk|lamp|light mode)\b/i;
const PAYOFF =
  /\b(payoff|result|reveal|ending|final|final video|hero shot|hero reveal|rides? into|open road|aspirational|adventure|better|easier|focus(?:ed)?|productive|productivity|refreshed|energized|empty|solves?|transforms?|finish(?:ed)?|complete|done|ready|strong ending|on track|stay(?:ing)? on track|back on track|back to work|keeps? working|hydrated|hydration|hydrate|reminder|reminds?|afternoon crash|all day|routine|saved|save time|win|cozy|calm|useful|usable|desk reveal|want to be|comes together|put(?:ting)? .* together|sorted|less stress|without the stress|worth it|actually helps?|keep using|would use|fits my|fits into|morning feels|desk feels|dinner|meal)\b/i;
const RISKY_VIDEO_PROMPT = /\b(cut to|new scene|new location|suddenly|transforms?|appears|disappears|caption|subtitle|text overlay|logo appears)\b/i;
const MULTI_PANEL_VISUAL_PROMPT =
  /\b(split[- ]?screen|multi[- ]?(?:panel|frame|view|shot)|multiple (?:panels|frames|views|shots|images|photos)|two[- ]?(?:panel|part)|three[- ]?(?:panel|part)|triptych|diptych|collage|storyboard|comic strip|contact sheet|grid layout|side[- ]?by[- ]?side|before[- ]?and[- ]?after|sequence of (?:shots|images|frames)|stacked (?:frames|photos|images|panels)|vertical panels?|horizontal panels?)\b/i;
const MULTI_PRODUCT_VISUAL_PROMPT =
  /\b(?:(?:multiple|several|many|three|four|five|different|various)\s+(?:products?|bottles?|tubes?|jars?|serums?|lamps?|shoes?|pans?|devices?|packages?|boxes?|variants?)|(?:row|lineup|array|assortment|collection)\b.{0,80}\b(?:products?|bottles?|tubes?|jars?|serums?|lamps?|shoes?|pans?|devices?|packages?|boxes?|variants?))\b/i;
const LEAKY_NARRATION =
  /\b(camera|wide shot|close[- ]?up|b[- ]?roll|subtitle|caption|text overlay|scene shows|image prompt|video prompt|cut to|include|show a|show the)\b/i;
const SCHEMA_LEAK = /\b(scene_\d+|json|schema|visual_bible|image_prompt|video_prompt|duration_seconds|on_camera|required beats?)\b/i;
export const META_NARRATION_DIRECTION =
  /\b(?:the\s+(?:proof|ending|hook|cta|beat|scene|benefit|product)\s+(?:matters|should|needs|feels?|shows?)|this\s+(?:scene|beat|video|ad)\s+(?:shows|should|needs|is about)|(?:should|needs to)\s+feel\s+like|benefit\s+is\s+easy\s+to\s+understand|product\s+feels\s+useful|final\s+product[- ]?in[- ]?use\s+beat|show(?:s|ing)?\s+the\s+habit\s+sticking)\b/i;
const NATURAL_CREATOR_MARKER =
  /\b(i|i'm|i’ve|i'd|my|me|you|you're|you’ve|your|honestly|okay|wait|realized|forgot|kept|needed|tried|try|actually|literally|low[- ]?key|kind of|sort of|not gonna lie|here'?s)\b/i;
const DETACHED_UGC_POINT_OF_VIEW = /\b(?:the creator|the user|users?|they|their)\b/i;
const POLISHED_AD_COPY =
  /\b(introducing|experience the|say goodbye to|revolutionary|seamless|elevate|unlock|game[- ]?changer|designed to|in today'?s fast[- ]?paced world)\b/i;
const BRACKETED_PERFORMANCE_CUE = /^\s*\[[^\]]+\]\s*/;
const CREATOR_REACTION_VISUAL =
  /\b(creator|person|founder|normal person|someone|man|woman|guy|girl|selfie|face|reaction|reacts?|smiles?|notices?|holds?|picks?|uses?|phone[- ]shot|handheld)\b/i;
const LONG_UGC_MIN_WORDS_PER_SECOND = 1.25;
const SPOKEN_SENTENCE_SPLIT = /[.!?]+|\n+/;
const REPEATED_SCENE_BEATS: Array<{ label: string; pattern: RegExp }> = [
  {
    label: "reminder/notification product proof",
    pattern:
      /\b(remind(?:er|s|ing)?|notification|notify|ping(?:s|ing)?|glow(?:s|ing)?|lights?\s+up|sip\s+up|hydration alert|drink water)\b/i,
  },
  {
    label: "app/progress tracking proof",
    pattern: /\b(app|track(?:s|ing)?|progress|dashboard|screen|goal|streak|metric|hydration score)\b/i,
  },
  {
    label: "setting/control proof",
    pattern: /\b(adjust(?:s|ing)?|brightness|warm light|cool light|color temperature|light mode|dimming|control(?:s)?|settings panel)\b/i,
  },
  {
    label: "charging proof",
    pattern: /\b(charge|charging|wireless|phone base|power(?:s|ing)?|dock)\b/i,
  },
];

export const VIDEO_VIBE_RULES: Record<VideoVibe, VideoVibeRule> = {
  raw_ugc: {
    label: "Raw UGC",
    cue: "phone-shot, handheld, creator-led, imperfect, natural room light, normal real-life setting",
    prompt_markers: /\b(phone|selfie|handheld|creator|casual|natural|desk|bedroom|kitchen|workday|real[- ]?life)\b/i,
    avoid: /\b(luxury|epic|studio commercial|grand cinematic|corporate|boardroom)\b/i,
  },
  polished_ugc: {
    label: "Polished UGC",
    cue: "creator-native but cleaner: bright natural light, crisp product closeups, organized everyday space",
    prompt_markers: /\b(creator|ugc|natural|clean|bright|product close[- ]?up|desk|workday|lifestyle)\b/i,
    avoid: /\b(epic|dramatic trailer|boardroom|news documentary)\b/i,
  },
  high_energy_social: {
    label: "High-energy social",
    cue: "scroll-stopping hook, snappy creator energy, fast visual variety, clear product proof",
    prompt_markers: /\b(scroll|snappy|quick|fast|energetic|hook|creator|reaction|tiktok|reel)\b/i,
    avoid: /\b(slow cinematic|quiet documentary|static lecture|corporate)\b/i,
  },
  practical_product_demo: {
    label: "Practical product demo",
    cue: "hands-on product use, clear feature proof, closeups, before/after or problem/solution clarity",
    prompt_markers: /\b(product|demo|feature|close[- ]?up|hands|using|screen|before|after|proof|result)\b/i,
    avoid: /\b(abstract|dreamlike|music video|purely cinematic)\b/i,
  },
  cozy_lifestyle: {
    label: "Cozy lifestyle",
    cue: "warm practical lifestyle, soft light, useful real environment, calm satisfying payoff",
    prompt_markers: /\b(warm|cozy|soft|home|desk|study|ambient|natural|calm|lifestyle)\b/i,
    avoid: /\b(cold corporate|chaotic|glitch|explosive|high contrast nightclub)\b/i,
  },
  cinematic_commercial: {
    label: "Cinematic commercial",
    cue: "controlled cinematic lighting, polished lens language, product hero moments, dramatic payoff",
    prompt_markers: /\b(cinematic|commercial|hero|macro|polished|controlled|dramatic|product reveal|lens)\b/i,
    avoid: /\b(messy selfie|raw phone|unlit bedroom|low effort)\b/i,
  },
  founder_explainer: {
    label: "Founder explainer",
    cue: "human founder POV, clear problem insight, honest build story, product proof without corporate gloss",
    prompt_markers: /\b(founder|startup|behind the scenes|built|problem|honest|desk|prototype|product)\b/i,
    avoid: /\b(fake testimonial|luxury fashion|music video|anonymous narrator)\b/i,
  },
  tutorial_walkthrough: {
    label: "Tutorial walkthrough",
    cue: "clear step-by-step action, visible process, readable product or screen proof, calm instructional pacing",
    prompt_markers: /\b(tutorial|walkthrough|step|process|screen|hands|how to|instruction|demo)\b/i,
    avoid: /\b(vague montage|abstract|pure mood|no product visible)\b/i,
  },
  editorial_documentary: {
    label: "Editorial documentary",
    cue: "observational realism, grounded context, human detail, factual or story-led b-roll",
    prompt_markers: /\b(documentary|observational|realistic|context|street|workplace|interview|editorial|human detail)\b/i,
    avoid: /\b(fake influencer|salesy|neon product launch|overly glossy)\b/i,
  },
};

function uniqueBeats(beats: RequiredBeat[]): RequiredBeat[] {
  return [...new Set(beats)];
}

function textFor(request: CreateProjectRequest): string {
  return request.prompt.toLowerCase();
}

function inferVideoVibe(format: CreativeFormat, platform: CreativePlatform, goal: CreativeGoal, text: string): VideoVibe {
  if (/\b(high energy|fast paced|snappy|scroll[- ]?stopping|viral)\b/i.test(text)) return "high_energy_social";
  if (/\b(cozy|warm|study|desk setup|soft light|calm|useful)\b/i.test(text)) return "cozy_lifestyle";
  if (format === "music_video") return "cinematic_commercial";
  if (format === "founder_story") return "founder_explainer";
  if (format === "tutorial") return "tutorial_walkthrough";
  if (format === "cinematic_ad") return "cinematic_commercial";
  if (format === "product_demo" || format === "comparison" || goal === "product_proof") return "practical_product_demo";
  if (format === "ugc" || format === "testimonial") return platform === "tiktok" || platform === "reels" ? "raw_ugc" : "polished_ugc";
  if (format === "youtube_clips") return "editorial_documentary";
  return goal === "story" ? "cinematic_commercial" : "polished_ugc";
}

export function inferCreativeIntent(request: CreateProjectRequest, ctx: ProjectContext): CreativeIntent {
  const text = textFor(request);
  const workflow = request.workflow;
  const comparisonIntent = COMPARISON.test(text) && !NON_COMPARATIVE_INSTEAD.test(text);
  const explicitlyNoSpeech = EXPLICIT_NO_SPEECH.test(text);
  let format: CreativeFormat = "general";
  if (workflow === "youtube_clips") format = "youtube_clips";
  else if (EXPLICIT_MUSIC_VIDEO.test(text)) format = "music_video";
  else if (FOUNDER.test(text)) format = "founder_story";
  else if (TESTIMONIAL.test(text)) format = "testimonial";
  else if (comparisonIntent) format = "comparison";
  else if (CREATOR_STYLE.test(text)) format = "ugc";
  else if (TUTORIAL.test(text)) format = "tutorial";
  else if (PROBLEM_SOLUTION.test(text) && PRODUCT.test(text)) format = "problem_solution";
  else if (CINEMATIC.test(text) && PRODUCT.test(text) && !CREATOR_STYLE.test(text)) format = "cinematic_ad";
  else if (PRODUCT.test(text) && !CREATOR_STYLE.test(text)) format = "product_demo";

  const platform: CreativePlatform = /\btiktok\b/i.test(text)
    ? "tiktok"
    : /\breels?\b|instagram/i.test(text)
      ? "reels"
      : /\bshorts?|youtube/i.test(text)
        ? "shorts"
        : /\bwebsite|landing page|web\b/i.test(text)
          ? "web"
          : "general";

  const goal: CreativeGoal = EXPLICIT_EDIT_REQUEST.test(text)
    ? "edit"
    : format === "music_video"
      ? "story"
    : CTA.test(text) || /\b(ad|commercial|strong ending)\b/i.test(text)
      ? "conversion"
      : TUTORIAL.test(text)
        ? "education"
        : PRODUCT.test(text) || ["product_demo", "problem_solution", "comparison"].includes(format)
          ? "product_proof"
          : CINEMATIC.test(text)
            ? "story"
            : "awareness";

  const creatorDriven =
    format !== "music_video" &&
    (CREATOR_STYLE.test(text) || ["ugc", "testimonial", "founder_story"].includes(format));
  const wantsSpokenTrack = /\b(ad|commercial|voiceover|narration|narrate|say|voice|talk|speaking)\b/i.test(text);
  const speech_mode: CreativeSpeechMode = format === "music_video" && !EXPLICIT_NARRATION.test(text)
    ? "mostly_visual"
    : QUOTED_SPEECH.test(request.prompt)
    ? "quoted_user_speech"
    : explicitlyNoSpeech
      ? "mostly_visual"
      : creatorDriven
      ? "inferred_creator_dialogue"
      : wantsSpokenTrack
        ? "voiceover"
        : VISUAL_DIRECTION.test(text)
          ? "mostly_visual"
          : ["product_demo", "problem_solution", "comparison", "cinematic_ad", "tutorial"].includes(format)
            ? "voiceover"
            : "mostly_visual";

  const required_beats = uniqueBeats([
    ...(format !== "music_video" && (creatorDriven || platform === "tiktok" || platform === "reels" || platform === "shorts")
      ? (["hook"] as RequiredBeat[])
      : []),
    ...(creatorDriven ? (["creator_reaction"] as RequiredBeat[]) : []),
    ...(format !== "music_video" && (PRODUCT.test(text) || ["product_demo", "problem_solution", "comparison", "cinematic_ad"].includes(format))
      ? (["product_proof", "payoff_cta"] as RequiredBeat[])
      : []),
    ...(format === "problem_solution" || format === "product_demo" || format === "comparison" || format === "tutorial"
      ? (["broll_demo"] as RequiredBeat[])
      : []),
  ]);

  const duration = request.duration_seconds ?? 30;
  const creatorOrProductVideo = creatorDriven || format === "product_demo" || format === "problem_solution" || format === "comparison";
  const preferredSceneCount =
    request.scene_count ??
    (format === "music_video"
      ? Math.ceil(duration / 7)
      : duration >= 30
      ? Math.ceil(duration / (creatorOrProductVideo ? 9 : 12))
      : duration >= 20
        ? 3
        : 2);
  return {
    format,
    platform,
    goal,
    speech_mode,
    suggested_vibe: inferVideoVibe(format, platform, goal, text),
    required_beats,
    pacing: {
      preferred_scene_count: Math.max(1, Math.min(10, preferredSceneCount)),
      min_scene_seconds: duration >= 24 ? 5 : 3,
      ideal_min_scene_seconds: duration >= 30 ? 7 : 5,
      ideal_max_scene_seconds: duration >= 30 ? 13 : 10,
    },
    video_model: ctx.video_model,
    notes: [
      `Use ${ctx.image_model} for stills unless a selected model overrides it.`,
      `Use ${ctx.video_model} duration limits for b-roll I2V scenes.`,
    ],
  };
}

export function creativeIntentBrief(intent: CreativeIntent): string {
  const supportedDurations = MAGIC_VIDEO_MODEL_DURATIONS[intent.video_model];
  const vibe = VIDEO_VIBE_RULES[intent.suggested_vibe];
  const supportedDurationText = supportedDurations
    ? [...supportedDurations].sort((a, b) => a - b).join(", ")
    : "selected-model supported values";
  const speechStyle =
    intent.format === "music_video"
      ? "use the supplied song or track as the master audio; do not convert lyrics into TTS, and add separate narration only when the user explicitly requests it"
      : intent.format === "ugc" || intent.format === "testimonial" || intent.format === "founder_story"
      ? "creator-native: first-person, casual, specific, lightly imperfect, and free of announcer/ad-copy phrases"
      : intent.speech_mode === "voiceover"
        ? "natural voiceover: clear, compact, human, and non-corporate"
        : "minimal spoken copy unless the user clearly wants narration";
  const voiceEmotionTarget =
    intent.format === "music_video"
      ? "follow the explicitly described musical mood and performance arc; use a separate narrator only when explicitly requested"
      : intent.format === "ugc" || intent.format === "testimonial"
      ? "creator-native emotion with a distinct hook, proof emphasis, and satisfied payoff"
      : intent.format === "cinematic_ad"
        ? "polished emotional arc with restraint and no announcer voice"
        : intent.format === "tutorial"
          ? "calm, precise, useful instruction"
          : intent.goal === "product_proof"
            ? "clear confidence and slightly impressed product-proof delivery"
            : "natural delivery that follows each scene's emotional beat";
  const formatGrammar =
    intent.format === "music_video"
      ? "Music-video grammar: use the supplied song or track as the master audio, maintain one coherent performer/world/style bible, and progress through visually distinct performance, narrative, or atmospheric beats that follow only the sections the user explicitly describes. Do not infer lyrics, vocal timing, lip-sync, or instrumental boundaries that have not been analyzed. Do not apply UGC hook/proof/CTA grammar."
      : intent.format === "ugc" || intent.format === "testimonial"
      ? "UGC/testimonial grammar: creator-native opening, visible reaction or lived problem, product proof in action, and a creator-native payoff. Do not make non-UGC formats follow this grammar."
      : intent.format === "founder_story"
        ? "Founder grammar: human problem insight, why-it-exists context, product proof, and grounded founder payoff."
        : intent.format === "product_demo" || intent.format === "problem_solution"
          ? "Product-demo grammar: show the problem or use case, demonstrate the feature clearly, then land the practical result. A creator hook is optional, not required."
          : intent.format === "comparison"
            ? "Comparison grammar: establish old way/new way, prove the difference visually, and end with the clearer choice."
            : intent.format === "tutorial"
              ? "Tutorial grammar: ordered steps, visible process proof, and a useful completion beat. Avoid salesy UGC structure unless the prompt asks for it."
              : intent.format === "cinematic_ad"
                ? "Cinematic grammar: mood, product/world reveal, proof or transformation, and emotional payoff. Do not force a talking creator."
                : intent.format === "youtube_clips"
                  ? "YouTube-clips grammar: factual or source-grounded sections with searchable visual beats and contiguous narration."
                  : "General-video grammar: infer the best story shape from the prompt; do not force UGC, hook/proof/CTA, or product-demo structure unless the prompt calls for it.";
  return [
    "Creative intent profile:",
    `- Format intent: ${intent.format}`,
    `- Platform intent: ${intent.platform}`,
    `- Goal intent: ${intent.goal}`,
    `- Speech interpretation: ${intent.speech_mode}`,
    `- Speech style: ${speechStyle}`,
    `- Voice emotion target: ${voiceEmotionTarget}`,
    `- Suggested video vibe: ${intent.suggested_vibe} (${vibe.label})`,
    `- Vibe prompt cue: ${vibe.cue}`,
    `- Format grammar: ${formatGrammar}`,
    "- Plan schema rule: set creative_vibe to the closest vibe and make every scene image_prompt/video_prompt fit it.",
    `- Required format-specific first-run beats: ${intent.required_beats.join(", ") || "none"}`,
    `- Pacing target: about ${intent.pacing.preferred_scene_count} scene(s), ideally ${intent.pacing.ideal_min_scene_seconds}-${intent.pacing.ideal_max_scene_seconds}s each when constraints allow.`,
    `- Non-talking I2V/b-roll durations must use one of these ${intent.video_model} values: ${supportedDurationText}.`,
    "- Runtime rule: scene durations should cover the requested total, and talking-scene coverage is based on actual spoken length, not the nominal scene duration.",
    "- B-roll speech rule: do not place one short sentence at the start of a long b-roll scene; the voiceover should cover most of the beat, or the scene should be split/shortened before rendering.",
    "- Product proof rule: product b-roll must show use, reminder, feature, result, or reaction, not just logo/design beauty shots.",
    "- Short product-UGC ending rule: if the request is 15 seconds or shorter, the final beat must explicitly show the immediate result of the demonstrated use and the creator's satisfied, surprised, or relieved reaction. A spoken sales CTA is not required unless the user asks for one.",
    "- Scene progression rule: adjacent scenes must advance distinct story beats. Do not repeat the same product action, reminder, app/proof, reaction, or payoff in different words.",
    "- Explicit ending-speech rule: when the request says the ending narration/voiceover must explain a fact or claim, include that claim in the final scene narration; do not replace it with a nearby detail.",
    "- UGC dialogue should be short enough to say naturally; prefer one casual sentence per scene over packed ad copy.",
    "- Default UGC/product ads to non-lip-synced voiceover over creator-reaction/product/demo visuals unless the user explicitly asks for a visible person to speak.",
    "- Voice identity rule: select a project-level voice that fits this video's visible speaker or narrator identity, genre, and emotion; do not reuse one generic voice across unrelated projects. Keep that resolved identity and provider settings across every scene in this video. Change voice only for explicitly requested different speakers, characters, or narrator roles.",
    "- For 40s+ UGC/product ads, do not depend on short talking clips to fill time. Use enough 10s product/demo/result b-roll scenes and natural voiceover to reach the runtime.",
    "- For 45s+ UGC/product ads, write enough natural spoken copy and product/demo b-roll to carry most of the runtime; do not leave the back half dependent on silent padding.",
    "- Provider-cost rule: fix objective plan issues before provider calls; do not depend on post-render subjective reruns.",
  ].join("\n");
}

function planText(plan: VideoPlan): string {
  return [plan.title, plan.narration, plan.visual_bible, ...plan.scenes.flatMap((scene) => [
    scene.narration,
    scene.image_prompt,
    scene.video_prompt,
  ])].join(" ");
}

function normalizedSpokenSentence(text: string): string {
  return text
    .replace(BRACKETED_PERFORMANCE_CUE, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function repeatedSpokenLineIssues(plan: VideoPlan): string[] {
  const seen = new Map<string, string>();
  const issues: string[] = [];
  for (const scene of plan.scenes) {
    for (const raw of scene.narration.split(SPOKEN_SENTENCE_SPLIT)) {
      const sentence = normalizedSpokenSentence(raw);
      if (sentence.split(/\s+/).filter(Boolean).length < 6) continue;
      const previousScene = seen.get(sentence);
      if (previousScene) {
        issues.push(`${previousScene} and ${scene.id} repeat the same spoken line; rewrite one so the story progresses.`);
      } else {
        seen.set(sentence, scene.id);
      }
    }
  }
  return issues;
}

function sceneBeatText(plan: VideoPlan, index: number): string {
  const scene = plan.scenes[index]!;
  return `${scene.narration} ${scene.image_prompt} ${scene.video_prompt}`;
}

function repeatedAdjacentBeatIssues(plan: VideoPlan, intent: CreativeIntent): string[] {
  if (
    !intent.required_beats.some((beat) => beat === "product_proof" || beat === "broll_demo") &&
    !["product_demo", "problem_solution", "comparison"].includes(intent.format)
  ) {
    return [];
  }
  const issues: string[] = [];
  for (let index = 1; index < plan.scenes.length; index++) {
    const previous = sceneBeatText(plan, index - 1);
    const current = sceneBeatText(plan, index);
    for (const beat of REPEATED_SCENE_BEATS) {
      if (beat.pattern.test(previous) && beat.pattern.test(current)) {
        const previousId = plan.scenes[index - 1]!.id;
        const currentId = plan.scenes[index]!.id;
        issues.push(
          `${previousId} and ${currentId} repeat the same ${beat.label}; rewrite one as a distinct next action, result, app/progress beat, or payoff instead of restating the same feature.`,
        );
        break;
      }
    }
  }
  return issues;
}

export function validatePlanForCreativeIntent(
  plan: VideoPlan,
  intent: CreativeIntent,
  request: CreateProjectRequest,
): string[] {
  const issues: string[] = [];
  const combined = planText(plan);
  if (intent.speech_mode === "quoted_user_speech") {
    const plannedSpeech = normalizeRequiredSpeech(plan.scenes.map((scene) => scene.narration).join(" "));
    for (const line of explicitQuotedSpeechLines(request.prompt)) {
      const requiredSpeech = normalizeRequiredSpeech(line);
      if (requiredSpeech && !plannedSpeech.includes(requiredSpeech)) {
        issues.push(`Quoted user speech must remain exact in narration: "${line}".`);
      }
    }
  }
  const endingNarration = normalizeRequiredSpeech(plan.scenes.at(-1)?.narration ?? "");
  for (const line of explicitEndingNarrationLines(request.prompt)) {
    const requiredSpeech = normalizeRequiredSpeech(line);
    if (requiredSpeech && !endingNarration.includes(requiredSpeech)) {
      issues.push(`Final scene narration must preserve the explicitly requested ending claim: "${line}".`);
    }
  }
  const finalSeconds = request.duration_seconds ?? plan.scenes.reduce((sum, scene) => sum + scene.duration_seconds, 0);
  const supportedDurations = MAGIC_VIDEO_MODEL_DURATIONS[intent.video_model];
  const vibe = VIDEO_VIBE_RULES[plan.creative_vibe];
  const vibeAllowedForIntent: Partial<Record<CreativeFormat, VideoVibe[]>> = {
    ugc: ["raw_ugc", "polished_ugc", "high_energy_social"],
    testimonial: ["raw_ugc", "polished_ugc", "high_energy_social"],
    founder_story: ["founder_explainer", "polished_ugc", "raw_ugc"],
    product_demo: ["practical_product_demo", "polished_ugc", "cozy_lifestyle", "high_energy_social"],
    problem_solution: ["practical_product_demo", "polished_ugc", "raw_ugc", "high_energy_social", "cozy_lifestyle"],
    comparison: ["practical_product_demo", "high_energy_social", "polished_ugc", "raw_ugc"],
    tutorial: ["tutorial_walkthrough", "practical_product_demo"],
    cinematic_ad: ["cinematic_commercial", "cozy_lifestyle", "practical_product_demo"],
    youtube_clips: ["editorial_documentary", "tutorial_walkthrough"],
  };

  const allowedVibes = vibeAllowedForIntent[intent.format];
  if (allowedVibes && !allowedVibes.includes(plan.creative_vibe)) {
    issues.push(
      `creative_vibe ${plan.creative_vibe} does not fit inferred ${intent.format} format; use one of ${allowedVibes.join(", ")}.`,
    );
  }
  const visualPromptText = [plan.visual_bible, ...plan.scenes.flatMap((scene) => [scene.image_prompt, scene.video_prompt])].join(" ");
  if (!vibe.prompt_markers.test(visualPromptText)) {
    issues.push(`creative_vibe ${plan.creative_vibe} is not reflected in visual_bible/image_prompt/video_prompt cues.`);
  }
  if (vibe.avoid.test(visualPromptText)) {
    issues.push(`creative_vibe ${plan.creative_vibe} conflicts with visual prompt language.`);
  }

  for (const scene of plan.scenes) {
    if (LEAKY_NARRATION.test(scene.narration) || SCHEMA_LEAK.test(scene.narration)) {
      issues.push(`${scene.id} spoken narration contains visual directions or schema words.`);
    }
    if (META_NARRATION_DIRECTION.test(scene.narration)) {
      issues.push(`${scene.id} spoken narration contains meta planning language instead of words a person would actually say.`);
    }
    if (intent.format === "ugc" || intent.format === "testimonial" || intent.format === "founder_story") {
      if (scene.on_camera === true && (!NATURAL_CREATOR_MARKER.test(scene.narration) || POLISHED_AD_COPY.test(scene.narration))) {
        issues.push(`${scene.id} on-camera narration should sound first-person and creator-native.`);
      }
      if (
        intent.speech_mode !== "quoted_user_speech" &&
        DETACHED_UGC_POINT_OF_VIEW.test(scene.narration) &&
        !NATURAL_CREATOR_MARKER.test(scene.narration)
      ) {
        issues.push(`${scene.id} UGC narration should stay in the creator's point of view, not detached third-person ad copy.`);
      }
      if (BRACKETED_PERFORMANCE_CUE.test(scene.narration)) {
        issues.push(`${scene.id} UGC narration should not include bracketed performance cues in the spoken line.`);
      }
    }
    if (scene.on_camera !== true && supportedDurations && !supportedDurations.has(scene.duration_seconds)) {
      issues.push(`${scene.id} b-roll duration ${scene.duration_seconds}s is not supported by the selected I2V model.`);
    }
    if (RISKY_VIDEO_PROMPT.test(scene.video_prompt)) {
      issues.push(`${scene.id} video prompt asks for cuts, text, new objects, scene changes, or ungrounded motion.`);
    }
    if (MULTI_PANEL_VISUAL_PROMPT.test(scene.image_prompt)) {
      issues.push(`${scene.id} image prompt must be a single full-frame keyframe, not a split-screen, collage, storyboard, or before/after layout.`);
    }
    if (MULTI_PRODUCT_VISUAL_PROMPT.test(scene.image_prompt)) {
      issues.push(`${scene.id} image prompt should use one primary product instance, not multiple competing product variants or a lineup.`);
    }
  }

  if (
    intent.required_beats.includes("creator_reaction") &&
    ["ugc", "testimonial", "founder_story"].includes(intent.format) &&
    EXPLICIT_VISIBLE_SPEECH.test(request.prompt) &&
    !plan.scenes.some((scene) => scene.on_camera === true)
  ) {
    issues.push("The explicit visible-speaker request requires at least one on-camera talking beat.");
  }
  if (
    intent.required_beats.includes("creator_reaction") &&
    ["ugc", "testimonial", "founder_story"].includes(intent.format) &&
    EXPLICIT_CREATOR_PRESENCE.test(request.prompt) &&
    !plan.scenes.some((scene) => CREATOR_REACTION_VISUAL.test(`${scene.image_prompt} ${scene.video_prompt}`))
  ) {
    issues.push("The inferred UGC/testimonial/founder format requires at least one visible creator/reaction beat.");
  }
  if (
    finalSeconds >= 30 &&
    ["ugc", "testimonial", "founder_story"].includes(intent.format) &&
    !EXPLICIT_TALKING_THROUGHOUT.test(combined)
  ) {
    const talkingScenes = plan.scenes.filter((scene) => scene.on_camera === true);
    const maxTalkingScenes = finalSeconds >= 45 ? 2 : 3;
    if (talkingScenes.length > maxTalkingScenes) {
      issues.push(
        `Use at most ${maxTalkingScenes} on-camera Talking Photo scenes for this first-run UGC plan; put middle proof/demo beats in b-roll voiceover for speed and reliability.`,
      );
    }
  }
  if (intent.required_beats.includes("product_proof")) {
    if (!plan.scenes.some((scene) => PROOF.test(`${scene.image_prompt} ${scene.video_prompt}`))) {
      issues.push("The inferred product/commercial goal requires visible product proof, demo, feature, screen, or result action.");
    }
    if (plan.scenes.every((scene) => scene.on_camera === true) && plan.scenes.length >= 3) {
      issues.push("Product-oriented plans need at least one product proof or b-roll/demo scene, not only talking-head scenes.");
    }
  }
  if (intent.required_beats.includes("payoff_cta")) {
    const ending = plan.scenes
      .slice(Math.max(0, plan.scenes.length - 2))
      .map((scene) => `${scene.narration} ${scene.image_prompt} ${scene.video_prompt}`)
      .join(" ");
    if (!PAYOFF.test(ending) && !CTA.test(ending)) {
      issues.push("The inferred product/commercial goal requires a final payoff, result reveal, or CTA. For short product UGC, make the final scene explicitly show the result of the demonstrated use and the creator's satisfied, surprised, or relieved reaction; a spoken sales CTA is optional.");
    }
  }
  if (finalSeconds >= 30 && plan.scenes.length > 1) {
    const average = plan.scenes.reduce((sum, scene) => sum + scene.duration_seconds, 0) / plan.scenes.length;
    if (average < intent.pacing.min_scene_seconds) {
      issues.push("Scene pacing is too fragmented for the requested runtime; use fewer stronger scenes.");
    }
  }
  if (
    finalSeconds >= 45 &&
    ["ugc", "testimonial", "founder_story"].includes(intent.format) &&
    intent.speech_mode !== "mostly_visual"
  ) {
    const spokenWords = plan.scenes.reduce((sum, scene) => sum + scene.narration.split(/\s+/).filter(Boolean).length, 0);
    const minSpokenWords = Math.floor(finalSeconds * LONG_UGC_MIN_WORDS_PER_SECOND);
    if (spokenWords < minSpokenWords) {
      issues.push(
        `Long UGC/product plans are under-scripted for ${finalSeconds}s (${spokenWords} spoken words, min ${minSpokenWords}).`,
      );
    }
  }
  if (intent.speech_mode !== "quoted_user_speech" && SCHEMA_LEAK.test(combined)) {
    issues.push("The plan contains schema or implementation terms that must never reach provider prompts or narration.");
  }
  issues.push(...repeatedSpokenLineIssues(plan), ...repeatedAdjacentBeatIssues(plan, intent));
  return issues;
}
