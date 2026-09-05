export interface CreateProjectPayload {
  prompt: string;
  workflow: WorkflowMode;
  duration_seconds?: number | null;
  scene_count?: number | null;
  aspect_ratio: string;
  resolution: string;
  image_model?: MagicImageModel | null;
  image_resolution?: MagicImageResolution | null;
  video_model?: MagicVideoModel | null;
  video_resolution?: string | null;
  youtube_search_provider?: YouTubeSearchProvider;
  agent_provider?: AgentModelProvider | null;
  agent_model?: string | null;
  agent_intensity?: AgentModelIntensity;
  audio_provider?: AudioProvider | null;
  hume_voice_description?: string | null;
  hume_voice_id?: string | null;
  hume_voice_name?: string | null;
  elevenlabs_voice_id?: string | null;
  elevenlabs_voice_name?: string | null;
  input_media?: InputMedia[];
  runtime_credentials?: RuntimeCredentials | null;
  openrouter_api_key?: string | null;
}

export interface InputMedia {
  id: string;
  kind: "image" | "audio";
  name: string;
  mime_type: string;
  url: string;
}

export type WorkflowMode = "generated" | "youtube_clips";
export type AgentModelProvider = "openai" | "openrouter";
export type AgentModelIntensity = "standard" | "pro" | "max";
export type AudioProvider = "fish" | "hume" | "elevenlabs";
export type YouTubeSearchProvider = "auto" | "youtube_data_api" | "yt_dlp";
export type YouTubeReviewProvider = Exclude<YouTubeSearchProvider, "auto">;

export interface RuntimeCredentials {
  openai_api_key?: string | null;
  openrouter_api_key?: string | null;
  magic_hour_api_key?: string | null;
  fish_audio_api_key?: string | null;
  fish_audio_reference_id?: string | null;
  hume_api_key?: string | null;
  elevenlabs_api_key?: string | null;
  elevenlabs_voice_id?: string | null;
  elevenlabs_voice_name?: string | null;
}

export interface OpenRouterModelInfo {
  id: string;
  name: string;
  context_length?: number | null;
  supported_parameters?: string[];
  pricing?: {
    prompt?: number | null;
    completion?: number | null;
    prompt_per_1m?: number | null;
    completion_per_1m?: number | null;
    source?: string;
  } | null;
}

export type MagicImageModel =
  | "default"
  | "flux-schnell"
  | "z-image-turbo"
  | "seedream-v4"
  | "nano-banana"
  | "nano-banana-2-lite"
  | "nano-banana-2"
  | "nano-banana-pro";

export type MagicImageResolution = "640px" | "1k" | "2k" | "4k";

export type MagicVideoModel =
  | "default"
  | "ltx-2"
  | "ltx-2.3"
  | "minimax-h3"
  | "wan-2.2"
  | "seedance"
  | "seedance-2.0"
  | "kling-2.5"
  | "kling-3.0"
  | "sora-2"
  | "veo3.1"
  | "veo3.1-lite"
  | "kling-1.6";

export interface ProjectMessagePayload {
  message: string;
  runtime_credentials?: RuntimeCredentials | null;
}

export interface YouTubeReviewCommentPayload {
  provider: YouTubeReviewProvider;
  comments: string;
}

export interface SceneSpec {
  id: string;
  narration: string;
  image_prompt: string;
  video_prompt: string;
  duration_seconds: number;
  audio_mode?: string;
  audio_note?: string | null;
}

export interface VideoPlan {
  title: string;
  narration: string;
  aspect_ratio: string;
  resolution: string;
  scenes: SceneSpec[];
}

export interface GeneratedImage {
  scene_id: string;
  path: string;
  url?: string;
  prompt: string;
  model: string;
  provider_job_id?: string | null;
  provider_url?: string | null;
}

export interface GeneratedSegment {
  scene_id: string;
  path: string;
  url?: string;
  prompt: string;
  model: string;
  duration_seconds: number;
  provider_job_id?: string | null;
  provider_url?: string | null;
  youtube_search_provider_requested?: string;
  youtube_search_provider?: string;
  youtube_search_benchmark?: {
    requested_provider?: string;
    used_provider?: string;
    attempts?: Array<{
      provider?: string;
      query?: string;
      limit?: number;
      duration_ms?: number;
      result_count?: number;
      error?: string;
    }>;
  } | null;
}

export interface TokenOutput {
  token_output_path: string;
  provider: string;
  model: string;
  usage: {
    requests: number;
    input_tokens: number;
    cached_input_tokens: number;
    uncached_input_tokens: number;
    output_tokens: number;
    reasoning_tokens: number;
    tool_search_tokens: number;
    total_tokens: number;
  };
  cost: {
    input_usd: number;
    cached_input_usd: number;
    output_usd: number;
    total_usd: number;
  };
}

export interface WorkflowManifest {
  project_id: string;
  title: string;
  created_at: string;
  workflow?: WorkflowMode | string;
  youtube_search_provider?: YouTubeSearchProvider | string;
  aspect_ratio: string;
  resolution: string;
  image_model: string;
  image_resolution?: string;
  image_style_tool?: string;
  video_model: string;
  video_resolution?: string;
  video_audio?: boolean;
  audio_model: string;
  render_status: "complete" | "partial";
  completed_scene_count: number;
  failed_scene_count: number;
  failed_scenes: Array<{
    scene_id: string;
    stage: string;
    error: string;
  }>;
  plan: VideoPlan;
  images: GeneratedImage[];
  videos: GeneratedSegment[];
  voiceover: { path: string; url?: string; model: string; duration_seconds: number };
  token_output: TokenOutput;
  token_output_path: string;
  gpt_cost_usd: number;
  final_video_path: string;
  final_video_url?: string;
  manifest_path: string;
  timeline?: TimelineArtifact;
}

export type TimelineTrackKind = "video" | "narration" | "guard";
export type TimelineEndBehavior = "cut" | "freeze" | "fade";

export interface TimelineClip {
  id: string;
  track: TimelineTrackKind;
  label: string;
  scene_id?: string | null;
  source_path?: string | null;
  source_start: number;
  source_end: number;
  timeline_start: number;
  timeline_end: number;
  duration: number;
  end_behavior: TimelineEndBehavior;
  locked?: boolean;
  metadata?: Record<string, unknown>;
}

export interface TimelineTrack {
  id: string;
  kind: TimelineTrackKind;
  label: string;
  clips: TimelineClip[];
}

export interface TimelineArtifact {
  version: 1;
  duration_seconds: number;
  tracks: TimelineTrack[];
  ending: {
    hold_seconds: number;
    intentional: boolean;
    reason: string;
    guard_clip_id: string | null;
    verification?: Record<string, unknown>;
  };
  updated_at: string;
}

export type TimelineEditPayload =
  | { operation: "inspect" }
  | { operation: "trim_clip"; clip_id: string; source_start?: number | null; source_end?: number | null }
  | { operation: "move_clip"; clip_id: string; timeline_start: number }
  | { operation: "set_final_hold"; hold_seconds: number; reason?: string };

export interface ProjectState {
  version: number;
  project_id: string;
  created_at: string;
  updated_at: string;
  status: Record<string, unknown>;
  user_preferences: Record<string, unknown>;
  provider_settings: Record<string, unknown>;
  current_plan?: Record<string, unknown> | null;
  scene_assets: {
    voiceover?: WorkflowManifest["voiceover"] | null;
    images: GeneratedImage[];
    videos: GeneratedSegment[];
    final_video_path?: string | null;
    manifest_path?: string | null;
  };
  timeline?: TimelineArtifact | null;
  failures: WorkflowManifest["failed_scenes"];
  decisions: Array<{
    created_at: string;
    decision: string;
    rationale?: string;
    scene_id?: string;
    tool?: string;
    metadata?: Record<string, unknown>;
  }>;
  messages: Array<{
    created_at: string;
    role: "user" | "assistant" | string;
    content: string;
    metadata?: Record<string, unknown>;
  }>;
}

export interface CreateProjectResponse {
  project_id: string;
  status: ProjectStatus;
  stage: ProjectStage;
  progress: number;
  message: string;
  updated_at: string;
  status_url: string;
  manifest?: WorkflowManifest;
  project_state?: ProjectState;
  error?: string;
}

export type ProjectStatus = "queued" | "running" | "succeeded" | "failed";

export interface ProjectListResponse {
  projects: ProjectStatusResponse[];
}

export type ProjectStage =
  | "queued"
  | "planning"
  | "regenerate_scene"
  | "replace_voiceover"
  | "restitching"
  | "revise_narration"
  | "voiceover_images"
  | "video_generation"
  | "stitching"
  | "complete"
  | "failed"
  | "image_generation"
  | "message_complete"
  | "message_failed"
  | "message_queued"
  | "message_running"
  | "retry_scene"
  | "voiceover"
  | string;

export type ProjectStatusResponse = CreateProjectResponse;

export interface ProjectActivityEvent {
  id: string;
  type: "status" | "agent_event" | string;
  project_id: string;
  created_at: string;
  event_name?: string;
  item_type?: string;
  tool_name?: string;
  arguments_preview?: string | null;
  output_preview?: string | null;
  text?: string;
  agent_name?: string;
  status?: ProjectStatus;
  stage?: ProjectStage;
  progress?: number;
  message?: string;
  error?: string;
}

export interface YouTubeReviewProviderResult {
  provider: YouTubeReviewProvider;
  project_id: string;
  status_url: string;
  started_at: string;
  comments: string;
  comments_updated_at?: string | null;
  status?: ProjectStatusResponse | null;
  latency_seconds?: number | null;
  render_status?: string | null;
  completed_scene_count?: number | null;
  failed_scene_count?: number | null;
  final_video_path?: string | null;
  final_video_url?: string | null;
}

export interface YouTubeReviewSessionResponse {
  review_id: string;
  prompt: string;
  created_at: string;
  updated_at: string;
  settings: {
    duration_seconds?: number | null;
    scene_count?: number | null;
    aspect_ratio: string;
    resolution: string;
  };
  metadata?: Record<string, unknown>;
  providers: Record<YouTubeReviewProvider, YouTubeReviewProviderResult>;
}

export interface YouTubeReviewBatchItem {
  prompt_id: string;
  name: string;
  category: string;
  prompt: string;
  settings: {
    duration_seconds?: number | null;
    scene_count?: number | null;
    aspect_ratio: string;
    resolution: string;
  };
  review_id: string;
  review?: YouTubeReviewSessionResponse | null;
}

export interface YouTubeReviewBatchResponse {
  batch_id: string;
  prompt_set_path: string;
  created_at: string;
  updated_at: string;
  items: YouTubeReviewBatchItem[];
}
