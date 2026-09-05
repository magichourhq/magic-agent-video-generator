import { Agent, tool, toolNamespace, toolSearchTool, webSearchTool } from "@openai/agents";
import { z } from "zod";
import { DEFAULT_MAGIC_HOUR_IMAGE_MODEL, DEFAULT_MAGIC_HOUR_VIDEO_MODEL, ENV } from "./config.js";
import type { ProjectContext } from "./context.js";
import {
  DEFAULT_OPENAI_AGENT_MODEL,
  assertAgentRuntimeReady,
  cloneAgentForRuntime,
  resolveAgentRuntime,
  runnerForRuntime,
  runtimeFromContext,
} from "./agentRuntime.js";
import { configuredAgentMaxTurns, requestFromProjectState } from "./projectContext.js";
import { updateProjectStatus } from "./projects.js";
import {
  buildYoutubeScriptPrompt,
  normalizeYoutubeScriptPlan,
  youtubeScriptNarration,
} from "./prompts.js";
import { readProjectState, updateProjectState, writeJsonArtifact } from "./renderState.js";
import type { JsonDict } from "./renderState.js";
import {
  MAGIC_IMAGE_MODELS,
  MAGIC_IMAGE_RESOLUTIONS,
  MAGIC_IMAGE_STYLE_TOOLS,
  MAGIC_VIDEO_MODELS,
  RESOLUTIONS,
  SceneSchema,
  SceneNarrationRevisionSchema,
  VIDEO_VIBES,
  YouTubeScriptPlanSchema,
  type CreateProjectRequest,
  type YouTubeScriptPlan,
} from "./schemas.js";
import { INSTRUCTIONS } from "./prompts.js";
import { pendingTokenOutputForContext } from "./usageCost.js";
import { VOICE_KEYS } from "./voices.js";
import { reviewYoutubeScriptWithSubagent, youtubeSubagentModel } from "./youtubeSubagents.js";
import { classifyMagicHourRequest } from "./magicHourCapabilities.js";
import {
  animateSceneVideosImpl,
  createYoutubeShortImpl,
  draftVideoPlanImpl,
  generateSceneImagesImpl,
  generateStandaloneImagesImpl,
  generateVoiceoverImpl,
  inspectTimelineImpl,
  inspectRenderStatusImpl,
  moveTimelineClipImpl,
  recordProjectDecisionImpl,
  requestClarificationImpl,
  regenerateSceneImpl,
  replaceVoiceoverImpl,
  restitchTimelineImpl,
  restitchVideoImpl,
  retrySceneWithModelsImpl,
  reviseNarrationImpl,
  setFinalHoldImpl,
  stitchFinalVideoImpl,
  trimTimelineClipImpl,
} from "./workflows.js";

const IMAGE_PROMPT_FIELD_DESCRIPTION =
  "Optional replacement still-image prompt. Write a stable keyframe for image-to-video: concrete visible subject, " +
  "action pose, foreground/background, lighting, lens/framing, palette, and continuity. Do not include text/logos/UI " +
  "or anything that must be invented later.";
const VIDEO_PROMPT_FIELD_DESCRIPTION =
  "Optional replacement image-to-video motion prompt. Use one camera move and at most one subject motion; only " +
  "animate what already exists in the still image. No cuts, new objects, scene changes, transformations, or " +
  "ungrounded events.";

export const draftVideoPlan = tool({
  name: "draft_video_plan",
  description:
    "Persist the complete creative plan before making provider calls. " +
    "title: concise title for the finished video. creative_vibe: the overall visual/story vibe every scene must follow. " +
    "The backend derives the full voiceover by joining the ordered scene narration fields; do not create a separate summary or alternate script. " +
    "Obey the brief's exact spoken-word range, count the actual scene narration words before this call, and never submit below a stated minimum. " +
    "visual_bible: the global world map for recurring identity, wardrobe, objects, fixed geography, time progression, palette, lens language, and environment; keep it at or below 2400 characters and compact repeated prose before this call. " +
    "voice: optional catalog voice key for the whole plan; use one stable voice for single-speaker UGC unless the user asks for multiple speakers. " +
    "scenes: ordered scene plan with the canonical spoken narration split across scenes, image prompts, motion prompts, durations, a continuity ledger, and an explicit " +
    "story progression. Each scene must advance a distinct beat; adjacent scenes cannot restate the same feature, product action, proof/result, or spoken line. " +
    "When uploaded images are listed in the brief, reference_media_ids must assign only the image IDs that should guide that scene; do not ignore relevant inputs or force every input into every scene. " +
    "For every scene, continuity.story_beat names the unique chronological event; required_subjects lists every concrete person/object that must be visibly present; " +
    "opening_state must inherit the prior closing_state or explicitly describe the bridge; opening/closing states record exact positions, orientation, possession, contact, and motion. " +
    "Before writing provider prompts, block the scene as if filming it in real life: state what supports each body/object, what is within reach, where each person looks, who holds what, what triggers the action, and the single observable result. " +
    "The image prompt is one credible pre-action instant; the video prompt advances cause, primary action, contact, and reaction in that order without teleportation, duplication, impossible balance, or objects appearing in hands. " +
    "Each scene narration is a timing and visual-evidence contract for that same scene: every spoken fall, catch, arrival, departure, handoff, use, opening, or reveal must be literally visible in its story_beat, keyframe state, and motion prompt before the next hard cut. " +
    "If the user explicitly says the ending narration or voiceover must explain a fact or claim, preserve that claim in the final scene narration. " +
    "For gravity, collision, entry, or handoff events, name the physical origin, path, contact point, and destination so the subject cannot teleport or move from an implausible direction. " +
    "Treat each fall, collision, catch, landing, handoff, or reveal as one atomic causal event: the same scene that starts it must visibly complete its contact/outcome and record that result in closing_state; never split one physical event across adjacent scenes. " +
    "Give a complete fall-and-contact event at least 8 seconds; with LTX 2.3 use a supported 10-second scene, never a 5-second scene. Use one continuous wide or gently tracking view that visibly completes contact; no whip pan or camera reframe that can hide the result. " +
    "closing_state records exact positions/conditions for the next cut; " +
    "setting records location/time/weather/style; screen_direction preserves a continuing subject's travel direction unless the scene visibly turns them around. " +
    "on_camera choice. Set on_camera:true when a creator or character should speak first-person dialogue " +
    "in a talking video. Set on_camera:false for product proof, screen, cinematic, tutorial, or other " +
    "b-roll/demo footage whose narration plays as voiceover. Set audio_mode to the compact delivery preset; " +
    "use audio_note only for rare short voice direction, never raw Hume settings.",
  parameters: z.object({
    title: z.string(),
    creative_vibe: z.enum(VIDEO_VIBES),
    scenes: z.array(SceneSchema),
    visual_bible: z.string().default(""),
    voice: z.enum(VOICE_KEYS).nullable().default(null),
  }),
  deferLoading: true,
  execute: async (input, runContext) => {
    const ctx = runContext!.context as ProjectContext;
    await updateProjectStatus(ctx.project_id, {
      status: "running",
      stage: "planning",
      progress: 15,
      message: "Creative plan drafted by the agent.",
    });
    const narration = input.scenes.map((scene) => scene.narration.trim()).filter(Boolean).join("\n\n");
    return draftVideoPlanImpl(ctx, input.title, narration, input.scenes, input.visual_bible, input.creative_vibe, true, input.voice);
  },
});

export const generateVoiceover = tool({
  name: "generate_voiceover",
  description: "Generate the voiceover audio for the current saved plan.",
  parameters: z.object({}),
  deferLoading: true,
  execute: async (_input, runContext) => {
    const ctx = runContext!.context as ProjectContext;
    await updateProjectStatus(ctx.project_id, {
      status: "running",
      stage: "voiceover",
      progress: 30,
      message: "Generating the voiceover.",
    });
    return generateVoiceoverImpl(ctx);
  },
});

export const requestClarification = tool({
  name: "request_clarification",
  description:
    "Ask the user for missing generation details before any paid provider call. Use this when the prompt does not " +
    "make the desired output type, subject, source media, or runtime clear enough to choose the right Magic Hour capability.",
  parameters: z.object({
    questions: z.array(z.string().min(1)).min(1).max(4),
    reason: z.string().default("The request is missing minimum generation details."),
  }),
  deferLoading: true,
  execute: async (input, runContext) => {
    const ctx = runContext!.context as ProjectContext;
    const state = readProjectState(ctx);
    const hasDraftValidationFailure = (state.decisions ?? []).some(
      (decision: JsonDict) => decision.tool === "draft_video_plan" && decision.metadata?.validation_failed === true,
    );
    if (hasDraftValidationFailure) {
      return {
        project_id: ctx.project_id,
        stage: "clarification_rejected",
        clarification_rejected: true,
        message:
          "Do not ask the user for clarification after draft_video_plan failed objective validation. " +
          "The user already gave enough generation detail; repair the plan and call draft_video_plan again.",
        next_tools: ["draft_video_plan"],
      };
    }
    if (state.current_plan) {
      throw new Error(
        "request_clarification refused because a video plan already exists. " +
          "Continue the render, repair the saved plan, or report the provider failure instead of asking for missing prompt details.",
      );
    }
    await updateProjectStatus(ctx.project_id, {
      status: "running",
      stage: "needs_input",
      progress: 5,
      message: input.questions[0] ?? "Magic Agent needs more information.",
    });
    return requestClarificationImpl(ctx, input.questions, input.reason);
  },
});

export const generateMagicHourImages = tool({
  name: "generate_magic_hour_images",
  description:
    "Generate one or more standalone images with Magic Hour AI Image Generator. Use this for image-only requests " +
    "such as photos, posters, product mockups, illustrations, thumbnails, or concept art. Do not use this for " +
    "multi-scene videos.",
  parameters: z.object({
    prompt: z.string().min(3).max(1200),
    image_count: z.number().int().min(1).max(4).default(1),
    model: z.enum(MAGIC_IMAGE_MODELS).default(DEFAULT_MAGIC_HOUR_IMAGE_MODEL as any),
    image_resolution: z.enum(MAGIC_IMAGE_RESOLUTIONS).default("1k"),
    image_style_tool: z.enum(MAGIC_IMAGE_STYLE_TOOLS).default("general"),
  }),
  deferLoading: true,
  execute: async (input, runContext) => {
    const ctx = runContext!.context as ProjectContext;
    await updateProjectStatus(ctx.project_id, {
      status: "running",
      stage: "image_generation",
      progress: 45,
      message: `Generating ${input.image_count} image${input.image_count === 1 ? "" : "s"} with ${input.model}.`,
    });
    return generateStandaloneImagesImpl(ctx, input.prompt, {
      image_count: input.image_count,
      model: input.model,
      image_resolution: input.image_resolution,
      image_style_tool: input.image_style_tool,
    });
  },
});

export const generateSceneImages = tool({
  name: "generate_scene_images",
  description:
    "Generate still images for all scenes, or for selected scene ids. " +
    "model: Magic Hour image model. Default to seedream-v4 unless the user explicitly selected a different model or " +
    "the prompt clearly needs a model-specific capability. Do not use Magic Hour's default model unless the user " +
    "explicitly asks for it. image_resolution: Magic Hour image resolution supported by the selected image model: " +
    "640px, 1k, 2k, or 4k. image_style_tool: Magic Hour image style category. Use general unless a specific image " +
    "domain such as ai-photo-generator, ai-character-generator, ai-landscape-generator, or movie-poster-generator " +
    "clearly fits. scene_ids: optional scene ids to generate; pass null to generate every scene in the saved plan.",
  parameters: z.object({
    model: z.enum(MAGIC_IMAGE_MODELS).default(DEFAULT_MAGIC_HOUR_IMAGE_MODEL as any),
    image_resolution: z.enum(MAGIC_IMAGE_RESOLUTIONS).default("1k"),
    image_style_tool: z.enum(MAGIC_IMAGE_STYLE_TOOLS).default("general"),
    scene_ids: z.array(z.string()).nullable().default(null),
  }),
  deferLoading: true,
  execute: async (input, runContext) => {
    const ctx = runContext!.context as ProjectContext;
    await updateProjectStatus(ctx.project_id, {
      status: "running",
      stage: "image_generation",
      progress: 45,
      message: `Generating scene images with ${input.model}.`,
    });
    return generateSceneImagesImpl(ctx, input.scene_ids, {
      model: input.model,
      image_resolution: input.image_resolution,
      image_style_tool: input.image_style_tool,
    });
  },
});

export const animateSceneVideos = tool({
  name: "animate_scene_videos",
  description:
    "Animate scene videos from generated images. " +
    "model: Magic Hour image-to-video model. Default to minimax-h3 unless the user explicitly selected a different " +
    "model or the prompt clearly needs a model-specific capability. Use seedance-2.0 for consistency, kling-2.5 for " +
    "motion/camera control, kling-3.0 for cinematic storytelling, veo3.1 for realism/prompt adherence, or sora-2 for " +
    "story-first creative motion only when that tradeoff is intentional. MiniMax H3 is the default reference-driven " +
    "model and supports native audio, but keep provider audio disabled when our narration or talking-photo layer owns speech. " +
    "resolution: output video resolution " +
    "supported by the selected video model. audio: whether Magic Hour should generate provider audio; usually false " +
    "because the final edit uses the selected TTS provider voiceover. On-camera (talking) scenes are rendered via AI Talking Photo " +
    "from the scene's keyframe image + a per-scene TTS line (not imageToVideo), so keep audio:false — provider " +
    "audio is not the speech source; b-roll cutaways still use imageToVideo. " +
    "scene_ids: optional scene ids to animate; pass null to animate every scene with an image.",
  parameters: z.object({
    model: z.enum(MAGIC_VIDEO_MODELS).default(DEFAULT_MAGIC_HOUR_VIDEO_MODEL as any),
    resolution: z.enum(RESOLUTIONS).default("720p"),
    audio: z.boolean().default(false),
    scene_ids: z.array(z.string()).nullable().default(null),
  }),
  deferLoading: true,
  execute: async (input, runContext) => {
    const ctx = runContext!.context as ProjectContext;
    await updateProjectStatus(ctx.project_id, {
      status: "running",
      stage: "video_generation",
      progress: 70,
      message: `Animating scene videos with ${input.model}.`,
    });
    return animateSceneVideosImpl(ctx, input.scene_ids, {
      model: input.model,
      resolution: input.resolution,
      audio: input.audio,
    });
  },
});

export const stitchFinalVideo = tool({
  name: "stitch_final_video",
  description: "Stitch completed scene videos with the voiceover into the final MP4.",
  parameters: z.object({}),
  deferLoading: true,
  execute: async (_input, runContext) => {
    const ctx = runContext!.context as ProjectContext;
    await updateProjectStatus(ctx.project_id, {
      status: "running",
      stage: "stitching",
      progress: 90,
      message: "Stitching the final edit.",
    });
    return stitchFinalVideoImpl(ctx, pendingTokenOutputForContext(ctx));
  },
});

export const inspectRenderStatus = tool({
  name: "inspect_render_status",
  description: "Inspect saved plan, project_state.json, media artifacts, failures, and recommended next tools.",
  parameters: z.object({}),
  deferLoading: true,
  execute: async (_input, runContext) => {
    return inspectRenderStatusImpl(runContext!.context as ProjectContext);
  },
});

export const recordProjectDecision = tool({
  name: "record_project_decision",
  description:
    "Persist an important creative, retry, or user-preference decision. decision: short statement of the choice " +
    "being made. rationale: optional reason for the choice. scene_id: optional scene id when the decision is " +
    "scene-specific.",
  parameters: z.object({
    decision: z.string(),
    rationale: z.string().default(""),
    scene_id: z.string().nullable().default(null),
  }),
  deferLoading: true,
  execute: async (input, runContext) => {
    return recordProjectDecisionImpl(
      runContext!.context as ProjectContext,
      input.decision,
      input.rationale,
      input.scene_id,
    );
  },
});

export const regenerateScene = tool({
  name: "regenerate_scene",
  description:
    "Patch one scene and regenerate only that scene's media assets. scene_id: saved scene id, such as scene_2. " +
    "narration: optional replacement narration for this scene. duration_seconds: optional replacement scene " +
    "duration. regenerate_image: whether to regenerate the image before animating the scene. image_model / " +
    "image_resolution / image_style_tool: optional Magic Hour image settings for the regenerated keyframe. " +
    "video_model / video_resolution: optional Magic Hour image-to-video settings for the regenerated scene. " +
    "video_audio: optional provider-audio toggle; usually false because final stitching uses the selected TTS provider.",
  parameters: z.object({
    scene_id: z.string(),
    narration: z.string().nullable().default(null),
    image_prompt: z.string().nullable().default(null).describe(IMAGE_PROMPT_FIELD_DESCRIPTION),
    video_prompt: z.string().nullable().default(null).describe(VIDEO_PROMPT_FIELD_DESCRIPTION),
    duration_seconds: z.number().int().min(1).max(30).nullable().default(null),
    regenerate_image: z.boolean().default(true),
    image_model: z.enum(MAGIC_IMAGE_MODELS).nullable().default(null),
    image_resolution: z.enum(MAGIC_IMAGE_RESOLUTIONS).nullable().default(null),
    image_style_tool: z.enum(MAGIC_IMAGE_STYLE_TOOLS).nullable().default(null),
    video_model: z.enum(MAGIC_VIDEO_MODELS).nullable().default(null),
    video_resolution: z.enum(RESOLUTIONS).nullable().default(null),
    video_audio: z.boolean().nullable().default(null),
  }),
  deferLoading: true,
  execute: async (input, runContext) => {
    const ctx = runContext!.context as ProjectContext;
    await updateProjectStatus(ctx.project_id, {
      status: "running",
      stage: "regenerate_scene",
      progress: 78,
      message: `Regenerating ${input.scene_id}.`,
    });
    return regenerateSceneImpl(ctx, input.scene_id, {
      narration: input.narration,
      image_prompt: input.image_prompt,
      video_prompt: input.video_prompt,
      duration_seconds: input.duration_seconds,
      regenerate_image: input.regenerate_image,
      image_model: input.image_model,
      image_resolution: input.image_resolution,
      image_style_tool: input.image_style_tool,
      video_model: input.video_model,
      video_resolution: input.video_resolution,
      video_audio: input.video_audio,
    });
  },
});

export const reviseNarration = tool({
  name: "revise_narration",
  description:
    "Patch the saved narration and invalidate stale voiceover/final video artifacts. narration: replacement full " +
    "voiceover narration. scene_narration_updates: optional per-scene narration replacements.",
  parameters: z.object({
    narration: z.string(),
    scene_narration_updates: z.array(SceneNarrationRevisionSchema).nullable().default(null),
  }),
  deferLoading: true,
  execute: async (input, runContext) => {
    const ctx = runContext!.context as ProjectContext;
    await updateProjectStatus(ctx.project_id, {
      status: "running",
      stage: "revise_narration",
      progress: 35,
      message: "Revising narration.",
    });
    return reviseNarrationImpl(ctx, input.narration, input.scene_narration_updates);
  },
});

export const replaceVoiceover = tool({
  name: "replace_voiceover",
  description:
    "Replace the voiceover audio from the current saved narration or a new narration. narration: optional full " +
    "narration to save before generating audio.",
  parameters: z.object({
    narration: z.string().nullable().default(null),
  }),
  deferLoading: true,
  execute: async (input, runContext) => {
    const ctx = runContext!.context as ProjectContext;
    await updateProjectStatus(ctx.project_id, {
      status: "running",
      stage: "replace_voiceover",
      progress: 55,
      message: "Replacing voiceover.",
    });
    return replaceVoiceoverImpl(ctx, input.narration);
  },
});

export const restitchVideo = tool({
  name: "restitch_video",
  description:
    "Rebuild the final MP4 from the current scene videos and voiceover. reason: optional reason for restitching " +
    "after a revision.",
  parameters: z.object({
    reason: z.string().default(""),
  }),
  deferLoading: true,
  execute: async (input, runContext) => {
    const ctx = runContext!.context as ProjectContext;
    await updateProjectStatus(ctx.project_id, {
      status: "running",
      stage: "restitching",
      progress: 95,
      message: "Restitching the final edit.",
    });
    return restitchVideoImpl(ctx, pendingTokenOutputForContext(ctx), input.reason);
  },
});

export const inspectTimelineTool = tool({
  name: "inspect_timeline",
  description:
    "Inspect the saved editor timeline with video, narration, and ending guard tracks. Use before precise trim, move, " +
    "or ending changes.",
  parameters: z.object({}),
  deferLoading: true,
  execute: async (_input, runContext) => {
    return inspectTimelineImpl(runContext!.context as ProjectContext);
  },
});

export const trimClipTool = tool({
  name: "trim_clip",
  description:
    "Trim one timeline clip by setting exact local source_start/source_end seconds. Use inspect_timeline first to get " +
    "clip ids and current bounds.",
  parameters: z.object({
    clip_id: z.string(),
    source_start: z.number().min(0).nullable().default(null),
    source_end: z.number().min(0).nullable().default(null),
  }),
  deferLoading: true,
  execute: async (input, runContext) => {
    return trimTimelineClipImpl(runContext!.context as ProjectContext, input.clip_id, {
      source_start: input.source_start,
      source_end: input.source_end,
    });
  },
});

export const moveClipTool = tool({
  name: "move_clip",
  description:
    "Move one timeline clip to an exact timeline_start second. Clips are rendered in timeline order on restitch.",
  parameters: z.object({
    clip_id: z.string(),
    timeline_start: z.number().min(0),
  }),
  deferLoading: true,
  execute: async (input, runContext) => {
    return moveTimelineClipImpl(runContext!.context as ProjectContext, input.clip_id, input.timeline_start);
  },
});

export const setFinalHoldTool = tool({
  name: "set_final_hold",
  description:
    "Set the final freeze/hold guard duration in seconds so the rendered video has an intentional ending instead of " +
    "an abrupt cutoff.",
  parameters: z.object({
    hold_seconds: z.number().min(0).max(5).default(1.5),
    reason: z.string().default("Make the ending deliberate."),
  }),
  deferLoading: true,
  execute: async (input, runContext) => {
    return setFinalHoldImpl(runContext!.context as ProjectContext, input.hold_seconds, input.reason);
  },
});

export const restitchTimelineTool = tool({
  name: "restitch_timeline",
  description:
    "Render the final MP4 from the saved timeline after trim, move, or final-hold edits. This also records ffprobe " +
    "audio/video duration verification.",
  parameters: z.object({
    reason: z.string().default("Timeline edits are ready to render."),
  }),
  deferLoading: true,
  execute: async (input, runContext) => {
    const ctx = runContext!.context as ProjectContext;
    await updateProjectStatus(ctx.project_id, {
      status: "running",
      stage: "restitching",
      progress: 95,
      message: "Rendering the saved timeline.",
    });
    return restitchTimelineImpl(ctx, pendingTokenOutputForContext(ctx), input.reason);
  },
});

export const retryScene = tool({
  name: "retry_scene",
  description:
    "Retry one scene without restarting the whole project. scene_id: saved scene id, such as scene_1. stage: retry " +
    "image, video, or all scene assets. image_model / image_resolution / image_style_tool: optional Magic Hour " +
    "image settings when retrying image/all. video_model / video_resolution: optional Magic Hour image-to-video " +
    "settings when retrying video/all. video_audio: optional provider-audio toggle; usually false because final " +
    "stitching uses the selected TTS provider.",
  parameters: z.object({
    scene_id: z.string(),
    stage: z.enum(["image", "video", "all"]).default("video"),
    image_model: z.enum(MAGIC_IMAGE_MODELS).nullable().default(null),
    image_resolution: z.enum(MAGIC_IMAGE_RESOLUTIONS).nullable().default(null),
    image_style_tool: z.enum(MAGIC_IMAGE_STYLE_TOOLS).nullable().default(null),
    video_model: z.enum(MAGIC_VIDEO_MODELS).nullable().default(null),
    video_resolution: z.enum(RESOLUTIONS).nullable().default(null),
    video_audio: z.boolean().nullable().default(null),
  }),
  deferLoading: true,
  execute: async (input, runContext) => {
    const ctx = runContext!.context as ProjectContext;
    await updateProjectStatus(ctx.project_id, {
      status: "running",
      stage: "retry_scene",
      progress: 75,
      message: `Retrying ${input.scene_id}.`,
    });
    return retrySceneWithModelsImpl(ctx, input.scene_id, input.stage, {
      image_model: input.image_model,
      image_resolution: input.image_resolution,
      image_style_tool: input.image_style_tool,
      video_model: input.video_model,
      video_resolution: input.video_resolution,
      video_audio: input.video_audio,
    });
  },
});

export const createYoutubeShortFromPrompt = tool({
  name: "create_youtube_short_from_prompt",
  description:
    "Create a YouTube clip short from the current project prompt. The tool first drafts a notebook-style YouTube " +
    "script plan with ordered section dialogue, duration_seconds, and search_hint values, then reuses the existing " +
    "YouTube clip downloader, per-section TTS voiceover, and stitcher. proxy_url: optional proxy URL for yt-dlp " +
    "downloads when needed.",
  parameters: z.object({
    proxy_url: z.string().nullable().default(null),
  }),
  deferLoading: true,
  execute: async (input, runContext) => {
    const ctx = runContext!.context as ProjectContext;
    await updateProjectStatus(ctx.project_id, {
      status: "running",
      stage: "youtube_script",
      progress: 15,
      message: "Drafting the YouTube script and search hints.",
    });
    return createYoutubeShortFromPromptImpl(ctx, { proxy_url: input.proxy_url });
  },
});

export const VIDEO_STUDIO_TOOLS = toolNamespace({
  name: "video_studio",
  description: "Professional cinematic video generation and post-production tools.",
  tools: [
    requestClarification,
    generateMagicHourImages,
    draftVideoPlan,
    generateVoiceover,
    generateSceneImages,
    animateSceneVideos,
    stitchFinalVideo,
    inspectRenderStatus,
    recordProjectDecision,
    regenerateScene,
    reviseNarration,
    replaceVoiceover,
    restitchVideo,
    inspectTimelineTool,
    trimClipTool,
    moveClipTool,
    setFinalHoldTool,
    restitchTimelineTool,
    retryScene,
  ],
});

export const YOUTUBE_SHORT_TOOLS = toolNamespace({
  name: "youtube_short",
  description: "Create shorts from searched YouTube clips, current-project voiceover, and ffmpeg stitching.",
  tools: [createYoutubeShortFromPrompt],
});

function firstRenderToolsForRequest(request: CreateProjectRequest) {
  if (request.workflow === "youtube_clips") {
    return [createYoutubeShortFromPrompt, inspectRenderStatus, recordProjectDecision];
  }
  const capability = classifyMagicHourRequest(request);
  if (capability.capability_id === "standalone_image") {
    return [requestClarification, generateMagicHourImages, inspectRenderStatus, recordProjectDecision];
  }
  return [
    requestClarification,
    draftVideoPlan,
    generateVoiceover,
    generateSceneImages,
    animateSceneVideos,
    stitchFinalVideo,
    inspectRenderStatus,
    recordProjectDecision,
  ];
}

export function youtubeScriptModel(): string {
  return ENV.YOUTUBE_SCRIPT_MODEL ?? ENV.OPENAI_FAST_MODEL ?? ENV.OPENAI_MODEL ?? "gpt-5.4";
}

export function youtubeScriptInstructionsForRequest(request: CreateProjectRequest | null): string {
  const openRouterMode = request ? resolveAgentRuntime(request).provider === "openrouter" : false;
  const searchGuidance = openRouterMode
    ? [
        "This run uses OpenRouter compatibility mode, so hosted WebSearchTool is not available.",
        "Set web_search_needed=false and put concrete, searchable YouTube phrases in each section's search_hint.",
        "Do not invent dated facts that require live web verification; write evergreen source-clip directions instead.",
      ]
    : [
        "Decide whether WebSearchTool is needed from the user's prompt and current date, not from a fixed topic list.",
        "Use WebSearchTool only when the script needs facts that can drift, such as latest/current/recent news, product releases, public figures, sports, prices, laws, safety guidance, or dated claims.",
        "For stable historical, fictional, evergreen educational, or purely visual prompts, set web_search_needed=false and do not call WebSearchTool.",
        "If web search is needed, call WebSearchTool before naming specific current facts, set web_search_needed=true, and summarize why in web_search_reason.",
        "Never set web_search_needed=true unless you actually called WebSearchTool during this run.",
        "Use quick broad web search, not deep research; prefer fresh reputable or official sources.",
      ];
  return [
    "Draft only the structured YouTube script requested by the prompt.",
    ...searchGuidance,
    "Keep source URLs and citations out of dialogue and search_hint fields.",
  ].join(" ");
}

export function youtubeScriptAgentForRequest(request: CreateProjectRequest | null = null) {
  const openRouterMode = request ? resolveAgentRuntime(request).provider === "openrouter" : false;
  return new Agent<ProjectContext, typeof YouTubeScriptPlanSchema>({
    name: "Notebook-Style YouTube Script Planner",
    model: youtubeScriptModel(),
    instructions: youtubeScriptInstructionsForRequest(request),
    tools: openRouterMode ? [] : [webSearchTool({ searchContextSize: "low" })],
    outputType: YouTubeScriptPlanSchema,
    modelSettings: {
      reasoning: { effort: (ENV.YOUTUBE_SCRIPT_REASONING_EFFORT ?? "low") as any },
      text: { verbosity: (ENV.YOUTUBE_SCRIPT_VERBOSITY ?? "low") as any },
      parallelToolCalls: false,
    },
  });
}

// The production path: the agent owns planning, provider-tool sequencing,
// retries, and stitching. The UI workflow toggle is enforced through the run
// brief, not by swapping to a different orchestrator agent.
export const videoAgentModel = ENV.OPENAI_MODEL ?? DEFAULT_OPENAI_AGENT_MODEL;
export const videoAgent = new Agent<ProjectContext>({
  name: "Autonomous Video Art Director",
  model: videoAgentModel,
  instructions: INSTRUCTIONS,
  tools: [...VIDEO_STUDIO_TOOLS, ...YOUTUBE_SHORT_TOOLS, toolSearchTool()],
  modelSettings: {
    reasoning: { effort: (ENV.OPENAI_REASONING_EFFORT ?? "low") as any },
    text: { verbosity: (ENV.OPENAI_VERBOSITY ?? "low") as any },
    parallelToolCalls: true,
  },
});

function chatCompletionsTool<T>(input: T): T {
  const toolDef: any = input;
  return { ...toolDef, deferLoading: false, namespace: undefined };
}

function firstRenderAgentForRequest(request: CreateProjectRequest) {
  const runtime = resolveAgentRuntime(request);
  assertAgentRuntimeReady(runtime);
  const tools = firstRenderToolsForRequest(request);
  const providerGuidance =
    runtime.provider === "openrouter"
      ? "\n\nOpenRouter compatibility mode: use the available flat function tools directly."
      : "\n\nFirst-render tool mode: use only the available first-render function tools directly.";
  return cloneAgentForRuntime(
    new Agent<ProjectContext>({
      name: "First-Render Video Art Director",
      model: runtime.model,
      instructions:
        INSTRUCTIONS +
        providerGuidance +
        " Produce the first complete requested output only. Do not edit, retry, regenerate, trim, or restitch as a subjective improvement " +
        "during the first run.",
      tools: tools.map(chatCompletionsTool),
      modelSettings: {
        reasoning: { effort: runtime.provider === "openrouter" ? "minimal" : ((ENV.OPENAI_REASONING_EFFORT ?? "low") as any) },
        text: { verbosity: runtime.provider === "openrouter" ? "low" : ((ENV.OPENAI_VERBOSITY ?? "low") as any) },
        parallelToolCalls: false,
      },
    }),
    runtime,
  );
}

function openRouterMessageAgentForContext(ctx: ProjectContext) {
  const runtime = runtimeFromContext(ctx);
  assertAgentRuntimeReady(runtime);
  return cloneAgentForRuntime(
    new Agent<ProjectContext>({
      name: "OpenRouter Video Editor",
      model: runtime.model,
      instructions:
        INSTRUCTIONS +
        "\n\nOpenRouter compatibility mode: use the available flat function tools directly. For follow-up " +
        "messages, inspect the saved render state before deciding whether to regenerate a scene, revise " +
        "narration, trim/move timeline clips, or restitch.",
      tools: [
        draftVideoPlan,
        requestClarification,
        generateMagicHourImages,
        generateVoiceover,
        generateSceneImages,
        animateSceneVideos,
        stitchFinalVideo,
        inspectRenderStatus,
        recordProjectDecision,
        regenerateScene,
        reviseNarration,
        replaceVoiceover,
        restitchVideo,
        inspectTimelineTool,
        trimClipTool,
        moveClipTool,
        setFinalHoldTool,
        restitchTimelineTool,
        retryScene,
      ].map(chatCompletionsTool),
      modelSettings: {
        reasoning: { effort: "minimal" as any },
        text: { verbosity: "low" as any },
        parallelToolCalls: false,
      },
    }),
    runtime,
  );
}

export function projectAgentForRequest(request: CreateProjectRequest) {
  // `workflow` constrains the main orchestrator's brief. `generated` lets it
  // use the normal Magic Hour toolchain; `youtube_clips` forces the YouTube
  // workflow tool first. Auto-routing can be added later as a new workflow
  // mode without introducing a second director.
  return firstRenderAgentForRequest(request);
}

export function projectMessageAgentForContext(ctx: ProjectContext) {
  if (runtimeFromContext(ctx).provider === "openrouter") {
    return openRouterMessageAgentForContext(ctx);
  }
  return videoAgent;
}

export function youtubeScriptResultUsedWebSearch(result: { newItems: any[] }): boolean {
  for (const item of result.newItems ?? []) {
    const rawItem = item?.rawItem;
    let rawType = rawItem?.type ?? "";
    if (rawItem && typeof rawItem === "object" && "type" in rawItem) {
      rawType = rawItem.type ?? rawType;
    }
    const providerData = item?.providerData ?? rawItem?.providerData ?? null;
    const markers = [
      item?.type ?? "",
      item?.name ?? "",
      item?.title ?? "",
      item?.description ?? "",
      rawType,
      rawItem?.name ?? "",
      providerData?.type ?? "",
      providerData?.name ?? "",
      rawItem != null ? rawItem.constructor?.name ?? "" : "",
    ];
    const normalized = markers.map((marker) => String(marker || "").toLowerCase()).join(" ");
    if (normalized.includes("web_search") || normalized.includes("websearch")) {
      return true;
    }
  }
  return false;
}

export async function draftYoutubeScriptImpl(
  ctx: ProjectContext,
  request: CreateProjectRequest,
): Promise<YouTubeScriptPlan> {
  const runtime = resolveAgentRuntime({
    ...request,
    runtime_credentials: {
      ...(request.runtime_credentials ?? {}),
      openai_api_key: request.runtime_credentials?.openai_api_key ?? ctx.openai_api_key ?? null,
      openrouter_api_key: request.runtime_credentials?.openrouter_api_key ?? ctx.openrouter_api_key ?? null,
      magic_hour_api_key: request.runtime_credentials?.magic_hour_api_key ?? ctx.magic_hour_api_key ?? null,
      fish_audio_api_key: request.runtime_credentials?.fish_audio_api_key ?? ctx.fish_audio_api_key ?? null,
      fish_audio_reference_id: request.runtime_credentials?.fish_audio_reference_id ?? ctx.fish_audio_reference_id ?? null,
      hume_api_key: request.runtime_credentials?.hume_api_key ?? ctx.hume_api_key ?? null,
      elevenlabs_api_key: request.runtime_credentials?.elevenlabs_api_key ?? ctx.elevenlabs_api_key ?? null,
      elevenlabs_voice_id: request.runtime_credentials?.elevenlabs_voice_id ?? ctx.elevenlabs_voice_id ?? null,
      elevenlabs_voice_name: request.runtime_credentials?.elevenlabs_voice_name ?? ctx.elevenlabs_voice_name ?? null,
    },
  });
  assertAgentRuntimeReady(runtime);
  const scriptAgent = youtubeScriptAgentForRequest(request);
  const prompt = buildYoutubeScriptPrompt(request, ctx);
  const runner = runnerForRuntime(runtime);
  let result = await runner.run(cloneAgentForRuntime(scriptAgent, runtime), prompt, {
    context: ctx,
    maxTurns: configuredAgentMaxTurns(),
  });
  let plan = YouTubeScriptPlanSchema.parse(result.finalOutput);
  plan = normalizeYoutubeScriptPlan(plan);
  let webSearchUsed = youtubeScriptResultUsedWebSearch(result);
  const webSearchAvailable = runtime.provider !== "openrouter";
  if (webSearchAvailable && plan.web_search_needed && !webSearchUsed) {
    const forcedSearchAgent = scriptAgent.clone({
      modelSettings: {
        ...scriptAgent.modelSettings,
        toolChoice: "web_search",
      },
    });
    result = await runner.run(
      cloneAgentForRuntime(forcedSearchAgent, runtime),
      [
        prompt,
        "",
        "The previous script plan set web_search_needed=true without a recorded web_search call.",
        "Call WebSearchTool now, ground the current facts, then return the structured YouTube script plan.",
      ].join("\n"),
      {
        context: ctx,
        maxTurns: configuredAgentMaxTurns(),
      },
    );
    plan = normalizeYoutubeScriptPlan(YouTubeScriptPlanSchema.parse(result.finalOutput));
    webSearchUsed = youtubeScriptResultUsedWebSearch(result);
    if (plan.web_search_needed && !webSearchUsed) {
      throw new Error(
        "YouTube script planner marked web_search_needed=true but did not call WebSearchTool. " +
          "Regenerate so current facts are grounded before script drafting.",
      );
    }
  }
  if (!webSearchAvailable && plan.web_search_needed) {
    plan = { ...plan, web_search_needed: false, web_search_reason: "" };
    webSearchUsed = false;
  }
  const scriptReview = await reviewYoutubeScriptWithSubagent(ctx, request, plan);
  plan = scriptReview.plan;
  writeJsonArtifact(ctx, "youtube_script_plan", plan);
  updateProjectState(ctx, {
    decision: {
      tool: "draft_youtube_script",
      decision: "Drafted a notebook-style YouTube script plan from the project prompt.",
      metadata: {
        title: plan.title,
        section_count: plan.sections.length,
        search_hints: plan.sections.map((section) => section.search_hint),
        model: runtime.model,
        provider: runtime.provider,
        web_search_available: webSearchAvailable,
        web_search_needed: plan.web_search_needed,
        web_search_used: webSearchUsed,
        web_search_reason: plan.web_search_reason,
        web_search_context_size: "low",
        subagent: scriptReview.review,
        subagent_model: youtubeSubagentModel(),
      },
    },
  });
  return plan;
}

export async function createYoutubeShortFromPromptImpl(
  ctx: ProjectContext,
  options: { proxy_url?: string | null } = {},
): Promise<JsonDict> {
  const request = requestFromProjectState(ctx);
  if (request === null) {
    throw new Error("No project request found. Start a project before creating a YouTube short from prompt.");
  }
  if (request.workflow !== "youtube_clips") {
    throw new Error("create_youtube_short_from_prompt is only available for workflow='youtube_clips'.");
  }
  const script = await draftYoutubeScriptImpl(ctx, request);
  return createYoutubeShortImpl(ctx, script.title, youtubeScriptNarration(script), script.sections, {
    token_output: pendingTokenOutputForContext(ctx),
    proxy_url: options.proxy_url ?? null,
  });
}
