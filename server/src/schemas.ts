import { z } from "zod";
import { VOICE_KEYS } from "./voices.js";

export const ASPECT_RATIOS = ["9:16", "16:9", "1:1"] as const;
export const RESOLUTIONS = ["480p", "720p", "1080p"] as const;
export const WORKFLOW_MODES = ["generated", "youtube_clips"] as const;
export const YOUTUBE_SEARCH_PROVIDERS = ["auto", "youtube_data_api", "yt_dlp"] as const;
export const YOUTUBE_REVIEW_PROVIDERS = ["youtube_data_api", "yt_dlp"] as const;
export const AGENT_MODEL_PROVIDERS = ["openai", "openrouter"] as const;
export const AGENT_MODEL_INTENSITIES = ["standard", "pro", "max"] as const;
export const AUDIO_PROVIDERS = ["fish", "hume", "elevenlabs"] as const;
export const AUDIO_MODES = [
  "ugc_hook",
  "ugc_casual",
  "product_proof",
  "testimonial",
  "cinematic_narrator",
  "tutorial_clear",
  "calm_lifestyle",
  "urgent_reaction",
  "mostly_visual",
] as const;
export const SCENE_AUDIO_SOURCES = ["voiceover", "speech_driven", "native_scene_audio"] as const;
export const VIDEO_VIBES = [
  "raw_ugc",
  "polished_ugc",
  "high_energy_social",
  "practical_product_demo",
  "cozy_lifestyle",
  "cinematic_commercial",
  "founder_explainer",
  "tutorial_walkthrough",
  "editorial_documentary",
] as const;

export const MAGIC_IMAGE_MODELS = [
  "default",
  "flux-schnell",
  "z-image-turbo",
  "seedream-v4",
  "nano-banana",
  "nano-banana-2-lite",
  "nano-banana-2",
  "nano-banana-pro",
] as const;
export const MAGIC_IMAGE_RESOLUTIONS = ["640px", "1k", "2k", "4k"] as const;
export const MAGIC_IMAGE_STYLE_TOOLS = [
  "general",
  "ai-photo-generator",
  "ai-character-generator",
  "ai-landscape-generator",
  "ai-illustration-generator",
  "ai-art-generator",
  "movie-poster-generator",
  "architecture-generator",
  "ai-background-generator",
] as const;
export const MAGIC_VIDEO_MODELS = [
  "default",
  "ltx-2",
  "ltx-2.3",
  "minimax-h3",
  "wan-2.2",
  "seedance",
  "seedance-2.0",
  "kling-2.5",
  "kling-3.0",
  "sora-2",
  "veo3.1",
  "veo3.1-lite",
  "kling-1.6",
] as const;

export type AspectRatio = (typeof ASPECT_RATIOS)[number];
export type YouTubeReviewProvider = (typeof YOUTUBE_REVIEW_PROVIDERS)[number];
export type AgentModelProvider = (typeof AGENT_MODEL_PROVIDERS)[number];
export type AgentModelIntensity = (typeof AGENT_MODEL_INTENSITIES)[number];
export type AudioProvider = (typeof AUDIO_PROVIDERS)[number];
export type AudioMode = (typeof AUDIO_MODES)[number];
export type SceneAudioSource = (typeof SCENE_AUDIO_SOURCES)[number];
export type VideoVibe = (typeof VIDEO_VIBES)[number];
export type MagicImageResolution = (typeof MAGIC_IMAGE_RESOLUTIONS)[number];
export type ProjectStatus = "queued" | "running" | "succeeded" | "failed";

export const MAGIC_IMAGE_MODEL_RESOLUTIONS: Record<string, Set<string>> = {
  "flux-schnell": new Set(["640px", "1k", "2k"]),
  "z-image-turbo": new Set(["640px", "1k", "2k"]),
  "seedream-v4": new Set(["640px", "1k", "2k", "4k"]),
  "nano-banana": new Set(["640px", "1k"]),
  "nano-banana-2-lite": new Set(["640px", "1k"]),
  "nano-banana-2": new Set(["640px", "1k", "2k", "4k"]),
  "nano-banana-pro": new Set(["1k", "2k", "4k"]),
};
export const MAGIC_VIDEO_MODEL_RESOLUTIONS: Record<string, Set<string>> = {
  "ltx-2": new Set(["480p", "720p", "1080p"]),
  "ltx-2.3": new Set(["480p", "720p", "1080p"]),
  "minimax-h3": new Set(["480p", "720p", "1080p"]),
  "wan-2.2": new Set(["480p", "720p", "1080p"]),
  seedance: new Set(["480p", "720p", "1080p"]),
  "seedance-2.0": new Set(["480p", "720p"]),
  "kling-2.5": new Set(["720p", "1080p"]),
  "kling-3.0": new Set(["720p", "1080p"]),
  "sora-2": new Set(["720p"]),
  "veo3.1": new Set(["720p", "1080p"]),
  "veo3.1-lite": new Set(["720p", "1080p"]),
  "kling-1.6": new Set(["720p", "1080p"]),
};
export const MAGIC_VIDEO_MODEL_DURATIONS: Record<string, Set<number>> = {
  "ltx-2": new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 25, 30]),
  "ltx-2.3": new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 25, 30]),
  "minimax-h3": new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 25, 30]),
  "wan-2.2": new Set([3, 4, 5, 6, 7, 8, 9, 10, 15]),
  seedance: new Set([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
  "seedance-2.0": new Set([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
  "kling-2.5": new Set([5, 10]),
  "kling-3.0": new Set([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
  "sora-2": new Set([4, 8, 12, 24, 36, 48, 60]),
  "veo3.1": new Set([4, 6, 8, 16, 24, 32, 40, 48, 56]),
  "veo3.1-lite": new Set([8, 16, 24, 32, 40, 48, 56]),
  "kling-1.6": new Set([5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60]),
};

export const IMAGE_PROMPT_DESCRIPTION =
  "Provider prompt for the still image. Write a stable cinematic keyframe later to be used for image-to-video generations.: " +
  "describe only what is visible in one frame, including subject identity, action pose, foreground/background, " +
  "lighting, lens/framing, texture, palette, and continuity details. Stage a physically credible pre-action instant: " +
  "support surfaces, reach, gaze, possession, separation, and contact must make sense before motion begins. Avoid text, logos, UI, captions, " +
  "multi-panel layouts, split-screen/storyboard/collage compositions, before/after layouts inside one image, " +
  "duplicate product variants or product lineups unless explicitly requested by the user, and anything the later video prompt must invent.";

export const VIDEO_PROMPT_DESCRIPTION =
  "Provider prompt for animating that exact still image. Use one camera move and at most one subject motion; " +
  "only animate what already exists in the image. Use no cuts. Do not add new objects, locations, cuts, scene changes, " +
  "transformations, text, or events that are not grounded in the keyframe. Describe a natural cause-action-result sequence " +
  "with credible weight, balance, reach, contact, and reaction timing, ending at the declared closing state.";

export const SceneContinuitySchema = z.object({
  story_beat: z.string().trim().max(240).describe(
    "One filmable causal event in chronological order: trigger, primary action, and visible result. For physical action, name the origin, path/contact, and destination.",
  ).default(""),
  required_subjects: z.array(z.string().trim().min(1).max(80)).max(8).describe(
    "Every person, animal, and important object that must be visibly present in this exact scene.",
  ).default([]),
  opening_state: z.string().trim().max(360).describe(
    "One photographable pre-action instant: exact positions, support surfaces, orientation, gaze, reach, possession, separation, and contact before motion.",
  ).default(""),
  closing_state: z.string().trim().max(360).describe(
    "Observable post-action state after contact/reaction, including where every tracked subject/object ends up and what it now holds, touches, or faces.",
  ).default(""),
  setting: z.string().trim().max(240).describe(
    "Physical location, fixed geography, time, weather, and stable visual conditions for this scene.",
  ).default(""),
  screen_direction: z.enum(["left_to_right", "right_to_left", "stationary", "not_applicable"]).default("not_applicable"),
});

// Agent-facing structured output schemas. The Agents SDK uses strict JSON
// schemas, so optional fields are expressed as nullable.
export const SceneSchema = z.object({
  id: z.string(),
  narration: z.string(),
  image_prompt: z.string().describe(IMAGE_PROMPT_DESCRIPTION),
  video_prompt: z.string().describe(VIDEO_PROMPT_DESCRIPTION),
  duration_seconds: z.number().int().min(1).max(30),
  on_camera: z.boolean().describe(
    "Required scene tool choice. Default false. True only when the user explicitly asked for an on-screen creator, person, character, avatar, or founder to speak/say/talk/lip-sync this scene's dialogue. False for ordinary UGC, product proof, screen, cinematic, tutorial, or b-roll/demo footage whose narration plays as voiceover.",
  ),
  audio_source: z.enum(SCENE_AUDIO_SOURCES).nullable().describe(
    "Who owns this scene's sound. voiceover uses the configured TTS voice over non-speaking footage; " +
      "speech_driven uses TTS to drive visible speech/lip-sync; native_scene_audio keeps MiniMax H3's generated dialogue, ambience, foley, and music without external TTS.",
  ).default(null),
  native_audio_prompt: z.string().trim().max(500).nullable().describe(
    "Only for native_scene_audio. Describe the scene's audible dialogue, ambience, foley, and music. " +
      "Do not include camera or visual instructions. Use null for voiceover and speech_driven scenes.",
  ).default(null),
  audio_mode: z.enum(AUDIO_MODES).describe(
    "Compact voice delivery preset. Pick one mode only; the backend maps it to Hume speed, temperature, description, and silence settings.",
  ).nullable().default(null),
  audio_note: z.string().trim().max(80).nullable().describe(
    "Optional special voice delivery note only, such as 'nervous but excited'. Do not include camera, visual, schema, or provider settings.",
  ).default(null),
  reference_media_ids: z.array(z.string().regex(/^[a-f0-9]{32}$/)).max(10).describe(
    "IDs of uploaded image references that must guide this scene's generated keyframe. Use only contextually relevant inputs; leave empty when the scene should not inherit an uploaded image.",
  ).default([]),
  continuity: SceneContinuitySchema.describe(
    "Scene-level story ledger. State the unique beat, every concrete person/object that must visibly appear, " +
    "the exact opening and closing world state, the physical setting/time, and persistent screen direction.",
  ).default({
    story_beat: "",
    required_subjects: [],
    opening_state: "",
    closing_state: "",
    setting: "",
    screen_direction: "not_applicable",
  }),
});
export type Scene = z.infer<typeof SceneSchema>;

export const VideoPlanSchema = z.object({
  title: z.string(),
  creative_vibe: z.enum(VIDEO_VIBES).describe(
    "Required overall visual/story vibe. Pick the closest option and make every scene's image_prompt and video_prompt fit it.",
  ).default("polished_ugc"),
  narration: z.string(),
  visual_bible: z.string().max(2_400).describe(
    "Global world map shared by all scenes: recurring identities and wardrobe, object appearance, fixed geography, time progression, visual style, palette, and camera language.",
  ).default(""),
  scenes: z.array(SceneSchema).min(1).max(10),
  // Character-matched voice key from the local catalog. Fish maps it to a
  // reference_id; Hume uses the selected provider settings instead.
  voice: z.enum(VOICE_KEYS).nullable().default(null),
});
export type VideoPlan = z.infer<typeof VideoPlanSchema>;

export const YOUTUBE_SEARCH_ORDERS = ["relevance", "date", "viewCount", "rating"] as const;
export const YOUTUBE_VIDEO_DURATIONS = ["short", "medium", "long"] as const;
export const YOUTUBE_VIDEO_CATEGORIES = [
  "film_animation",
  "autos_vehicles",
  "music",
  "pets_animals",
  "sports",
  "travel_events",
  "gaming",
  "people_blogs",
  "comedy",
  "entertainment",
  "news_politics",
  "howto_style",
  "education",
  "science_technology",
] as const;
const YOUTUBE_VIDEO_CATEGORY_SET = new Set<string>(YOUTUBE_VIDEO_CATEGORIES);
const YouTubeVideoCategorySchema = z.preprocess((value) => {
  if (value === null || value === undefined || value === "") return null;
  const normalized = String(value).trim().toLowerCase().replace(/[\s-]+/g, "_");
  return YOUTUBE_VIDEO_CATEGORY_SET.has(normalized) ? normalized : null;
}, z.enum(YOUTUBE_VIDEO_CATEGORIES).nullable().default(null));

export const YouTubeClipSectionSchema = z.object({
  section: z.number().int().min(1).max(10),
  dialogue: z.string().min(1).max(600),
  search_hint: z.string().min(2).max(120),
  // Accept fractional seconds: source clip windows and voiceover durations can
  // be fractional, and the Agents SDK hard-rejects the whole plan if this is
  // .int() and the model returns e.g. 7.5. Downstream uses float seconds
  // throughout and rewrites to the actual voiceover length when needed.
  duration_seconds: z.number().min(1).max(30),
  // Optional retrieval-targeting fields mapped directly onto YouTube Data API
  // search.list parameters, so the planner controls recency, category,
  // captions, and clip length per scene instead of backend heuristics.
  search_order: z.enum(YOUTUBE_SEARCH_ORDERS).nullable().default(null),
  published_after: z.string().max(40).nullable().default(null),
  published_before: z.string().max(40).nullable().default(null),
  video_duration: z.enum(YOUTUBE_VIDEO_DURATIONS).nullable().default(null),
  video_category: YouTubeVideoCategorySchema,
  require_captions: z.boolean().default(false),
  channel_hint: z.string().max(80).nullable().default(null),
  // Direct YouTube URLs the planner found via web search; validated and
  // hydrated server-side, they lead the candidate pool ahead of search.
  candidate_video_urls: z.array(z.string()).max(3).default([]),
  // Lowercased dominant-subject tokens attached server-side during
  // normalization (e.g. ["mahomes", "chiefs"]). Drives generic subject-identity
  // enforcement in candidate selection; absent when no confident subject.
  subject_tokens: z.array(z.string()).default([]),
});
export type YouTubeClipSection = z.infer<typeof YouTubeClipSectionSchema>;

export const YouTubeScriptPlanSchema = z.object({
  title: z.string().min(1).max(120),
  web_search_needed: z.boolean().default(false),
  web_search_reason: z.string().max(300).default(""),
  sections: z.array(YouTubeClipSectionSchema).min(1).max(10),
});
export type YouTubeScriptPlan = z.infer<typeof YouTubeScriptPlanSchema>;

export const SceneNarrationRevisionSchema = z.object({
  scene_id: z.string(),
  narration: z.string(),
});
export type SceneNarrationRevision = z.infer<typeof SceneNarrationRevisionSchema>;

export const RuntimeCredentialsSchema = z.object({
  openai_api_key: z.string().trim().max(500).nullish().default(null),
  openrouter_api_key: z.string().trim().max(500).nullish().default(null),
  magic_hour_api_key: z.string().trim().max(500).nullish().default(null),
  fish_audio_api_key: z.string().trim().max(500).nullish().default(null),
  fish_audio_reference_id: z.string().trim().max(500).nullish().default(null),
  hume_api_key: z.string().trim().max(500).nullish().default(null),
  elevenlabs_api_key: z.string().trim().max(500).nullish().default(null),
  elevenlabs_voice_id: z.string().trim().max(500).nullish().default(null),
  elevenlabs_voice_name: z.string().trim().max(200).nullish().default(null),
});
export type RuntimeCredentials = z.infer<typeof RuntimeCredentialsSchema>;

export const InputMediaSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{32}$/),
  kind: z.enum(["image", "audio"]),
  name: z.string().trim().min(1).max(200),
  mime_type: z.string().trim().min(1).max(100),
  url: z.string().trim().min(1).max(500),
});
export type InputMedia = z.infer<typeof InputMediaSchema>;

export const CreateProjectRequestSchema = z.object({
  prompt: z.string().min(3).max(2_000),
  workflow: z.enum(WORKFLOW_MODES).default("generated"),
  youtube_search_provider: z.enum(YOUTUBE_SEARCH_PROVIDERS).default("youtube_data_api"),
  youtube_allow_provider_fallback: z.boolean().default(false),
  duration_seconds: z.number().int().min(1).max(120).nullish().default(null),
  scene_count: z.number().int().min(1).max(10).nullish().default(null),
  aspect_ratio: z.enum(ASPECT_RATIOS).default("9:16"),
  resolution: z.enum(RESOLUTIONS).default("720p"),
  image_model: z.enum(MAGIC_IMAGE_MODELS).nullish().default(null),
  video_model: z.enum(MAGIC_VIDEO_MODELS).nullish().default(null),
  image_resolution: z.enum(MAGIC_IMAGE_RESOLUTIONS).nullish().default(null),
  video_resolution: z.enum(RESOLUTIONS).nullish().default(null),
  agent_provider: z.enum(AGENT_MODEL_PROVIDERS).nullish().default(null),
  agent_model: z.string().trim().min(1).max(200).nullish().default(null),
  agent_intensity: z.enum(AGENT_MODEL_INTENSITIES).default("standard"),
  audio_provider: z.enum(AUDIO_PROVIDERS).nullish().default(null),
  hume_voice_description: z.string().trim().max(1_000).nullish().default(null),
  hume_voice_id: z.string().trim().max(200).nullish().default(null),
  hume_voice_name: z.string().trim().max(200).nullish().default(null),
  elevenlabs_voice_id: z.string().trim().max(500).nullish().default(null),
  elevenlabs_voice_name: z.string().trim().max(200).nullish().default(null),
  input_media: z.array(InputMediaSchema).max(10).default([]),
  runtime_credentials: RuntimeCredentialsSchema.nullish().default(null),
  // Backward-compatible field for the current UI. New callers should use runtime_credentials.openrouter_api_key.
  openrouter_api_key: z.string().trim().max(500).nullish().default(null),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

export const ProjectMessageRequestSchema = z.object({
  message: z.string().min(1).max(4_000),
  runtime_credentials: RuntimeCredentialsSchema.nullish().default(null),
});
export type ProjectMessageRequest = z.infer<typeof ProjectMessageRequestSchema>;

export const ProjectTimelineEditRequestSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("inspect"),
  }),
  z.object({
    operation: z.literal("trim_clip"),
    clip_id: z.string().min(1),
    source_start: z.number().min(0).nullable().default(null),
    source_end: z.number().min(0).nullable().default(null),
  }),
  z.object({
    operation: z.literal("move_clip"),
    clip_id: z.string().min(1),
    timeline_start: z.number().min(0),
  }),
  z.object({
    operation: z.literal("set_final_hold"),
    hold_seconds: z.number().min(0).max(5),
    reason: z.string().max(500).default("Make the ending deliberate."),
  }),
]);
export const YouTubeReviewSessionRequestSchema = z.object({
  prompt: z.string().min(3).max(2_000),
  duration_seconds: z.number().int().min(1).max(60).nullish().default(null),
  scene_count: z.number().int().min(1).max(10).nullish().default(null),
  aspect_ratio: z.enum(ASPECT_RATIOS).default("9:16"),
  resolution: z.enum(RESOLUTIONS).default("720p"),
});
export type YouTubeReviewSessionRequest = z.infer<typeof YouTubeReviewSessionRequestSchema>;

export const YouTubeReviewCommentRequestSchema = z.object({
  provider: z.enum(YOUTUBE_REVIEW_PROVIDERS),
  comments: z.string().max(8_000).default(""),
});
export interface SpeechBudget {
  words_per_second: number;
  min_words: number;
  max_words: number;
  scene_duration_total_seconds: number;
  final_duration_seconds: number;
}

export type SceneConstraintMode = "exact" | "minimum" | "agent_decides";

export interface GenerationConstraints {
  duration_seconds: number;
  duration_source: "prompt" | "request" | "auto";
  duration_is_upper_bound: boolean;
  scene_mode: SceneConstraintMode;
  scene_count: number | null;
  scene_source: "prompt" | "request" | "auto";
  scene_budget_count: number;
}
