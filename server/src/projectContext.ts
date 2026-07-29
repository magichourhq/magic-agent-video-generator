import { existsSync } from "node:fs";
import path from "node:path";
import { execa } from "execa";
import {
  DEFAULT_AGENT_MAX_TURNS,
  DEFAULT_ELEVENLABS_AUDIO_MODEL,
  DEFAULT_ELEVENLABS_VOICE_NAME,
  DEFAULT_MAGIC_HOUR_IMAGE_MODEL,
  DEFAULT_MAGIC_HOUR_VIDEO_MODEL,
  ENV,
} from "./config.js";
import type { ProjectContext } from "./context.js";
import { projectDirFor } from "./projects.js";
import { initializeProjectState as writeInitialProjectState, readProjectState, artifactPath } from "./renderState.js";
import type { JsonDict } from "./renderState.js";
import { resolveAgentRuntime } from "./agentRuntime.js";
import { projectRuntimeCredentials, runtimeCredentialsFromRequest, runtimeCredentialStatus } from "./runtimeCredentials.js";
import type { AspectRatio, AudioProvider, CreateProjectRequest, MagicImageResolution } from "./schemas.js";
import { CreateProjectRequestSchema, MAGIC_IMAGE_MODEL_RESOLUTIONS } from "./schemas.js";

export function defaultImageResolution(videoResolution: string): MagicImageResolution {
  return ({ "480p": "640px", "720p": "1k", "1080p": "2k" } as Record<string, MagicImageResolution>)[videoResolution] ?? "1k";
}

export function defaultImageResolutionForModel(
  videoResolution: string,
  imageModel: string,
): MagicImageResolution {
  const preferred = defaultImageResolution(videoResolution);
  const supported = MAGIC_IMAGE_MODEL_RESOLUTIONS[imageModel];
  if (!supported || supported.has(preferred)) return preferred;
  return supported.has("1k") ? "1k" : ([...supported][0] as MagicImageResolution);
}

export function explicitMagicHourDefault(value: string | undefined, fallback: string): string {
  const configured = (value ?? "").trim();
  if (!configured || configured === "default") return fallback;
  return configured;
}

export function defaultMagicHourImageModel(): string {
  return explicitMagicHourDefault(ENV.MAGIC_HOUR_IMAGE_MODEL, DEFAULT_MAGIC_HOUR_IMAGE_MODEL);
}

export function defaultMagicHourVideoModel(): string {
  return explicitMagicHourDefault(ENV.MAGIC_HOUR_VIDEO_MODEL, DEFAULT_MAGIC_HOUR_VIDEO_MODEL);
}

export function configuredAgentMaxTurns(): number {
  const raw = ENV.OPENAI_AGENT_MAX_TURNS;
  if (!raw) return DEFAULT_AGENT_MAX_TURNS;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    console.warn(`Ignoring invalid OPENAI_AGENT_MAX_TURNS override: ${raw}`);
    return DEFAULT_AGENT_MAX_TURNS;
  }
  return Math.max(11, Math.min(parsed, 80));
}

const TRUTHY = new Set(["1", "true", "yes"]);

function envBool(value: string | undefined): boolean {
  return TRUTHY.has((value ?? "false").toLowerCase());
}

function audioProviderFromValue(value: unknown): AudioProvider {
  const raw = String(value || "hume").trim().toLowerCase();
  if (raw === "elevenlabs" || raw === "eleven_labs" || raw === "eleven-labs") return "elevenlabs";
  return raw === "fish" ? "fish" : "hume";
}

function audioProviderForRequest(request: CreateProjectRequest): AudioProvider {
  return audioProviderFromValue(request.audio_provider || ENV.AUDIO_PROVIDER || "hume");
}

function audioModelForProvider(provider: AudioProvider, saved?: unknown): string {
  if (saved) return String(saved);
  if (provider === "hume") return ENV.HUME_AUDIO_MODEL || ENV.HUME_OCTAVE_VERSION || "octave-1";
  if (provider === "elevenlabs") return ENV.ELEVENLABS_AUDIO_MODEL || DEFAULT_ELEVENLABS_AUDIO_MODEL;
  return ENV.FISH_AUDIO_MODEL ?? "s2.1-pro";
}

export function boolSetting(value: unknown, options: { default: boolean }): boolean {
  if (value === null || value === undefined) return options.default;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  return Boolean(value);
}

export function context(projectId: string, request: CreateProjectRequest): ProjectContext {
  const agentRuntime = resolveAgentRuntime(request);
  const credentials = runtimeCredentialsFromRequest(request);
  const audioProvider = audioProviderForRequest(request);
  const imageModel = request.image_model ?? defaultMagicHourImageModel();
  return {
    project_id: projectId,
    project_dir: projectDirFor(projectId),
    aspect_ratio: request.aspect_ratio,
    resolution: request.video_resolution ?? request.resolution,
    openai_api_key: credentials.openai_api_key ?? "",
    magic_hour_api_key: credentials.magic_hour_api_key ?? ENV.MAGIC_HOUR_API_KEY ?? "",
    fish_audio_api_key: credentials.fish_audio_api_key ?? ENV.FISH_AUDIO_API_KEY ?? "",
    fish_audio_reference_id: credentials.fish_audio_reference_id ?? ENV.FISH_AUDIO_REFERENCE_ID ?? "",
    hume_api_key: credentials.hume_api_key ?? ENV.HUME_API_KEY ?? "",
    elevenlabs_api_key: credentials.elevenlabs_api_key ?? ENV.ELEVENLABS_API_KEY ?? "",
    elevenlabs_voice_id: request.elevenlabs_voice_id ?? "",
    elevenlabs_voice_name: request.elevenlabs_voice_name ?? "",
    agent_provider: agentRuntime.provider,
    agent_model: agentRuntime.model,
    agent_intensity: agentRuntime.intensity,
    openrouter_api_key: credentials.openrouter_api_key ?? undefined,
    image_model: imageModel,
    image_resolution:
      request.image_resolution ??
      ENV.MAGIC_HOUR_IMAGE_RESOLUTION ??
      defaultImageResolutionForModel(request.resolution, imageModel),
    image_style_tool: ENV.MAGIC_HOUR_IMAGE_STYLE_TOOL ?? "general",
    video_model: request.video_model ?? defaultMagicHourVideoModel(),
    video_audio: envBool(ENV.MAGIC_HOUR_VIDEO_AUDIO),
    audio_provider: audioProvider,
    audio_model: audioModelForProvider(audioProvider),
    audio_format: ENV.FISH_AUDIO_FORMAT ?? "mp3",
    hume_voice_description: request.hume_voice_description ?? ENV.HUME_VOICE_DESCRIPTION ?? "",
    hume_voice_id: request.hume_voice_id ?? ENV.HUME_VOICE_ID ?? "",
    hume_voice_name: request.hume_voice_name ?? ENV.HUME_VOICE_NAME ?? "",
    hume_voice_provider: ENV.HUME_VOICE_PROVIDER ?? "HUME_AI",
  };
}

export function contextForExistingProject(projectId: string): ProjectContext {
  const projectDir = projectDirFor(projectId);
  const stateCtx: ProjectContext = {
    project_id: projectId,
    project_dir: projectDir,
    aspect_ratio: "",
    resolution: "",
    magic_hour_api_key: "",
    fish_audio_api_key: "",
    fish_audio_reference_id: "",
    hume_api_key: "",
    elevenlabs_api_key: "",
    elevenlabs_voice_id: "",
    elevenlabs_voice_name: "",
    agent_provider: "openai",
    agent_model: "gpt-5.4",
    agent_intensity: "standard",
    image_model: "seedream-v4",
    image_resolution: "1k",
    image_style_tool: "general",
    video_model: "ltx-2.3",
    video_audio: false,
    audio_provider: "hume",
    audio_model: "octave-1",
    audio_format: "mp3",
    hume_voice_description: "",
    hume_voice_id: "",
    hume_voice_name: "",
    hume_voice_provider: "HUME_AI",
  };
  const state = readProjectState(stateCtx);
  const preferences = state.user_preferences ?? {};
  const providers = state.provider_settings ?? {};
  const credentials = projectRuntimeCredentials(projectId);
  const resolution = String(providers.resolution || preferences.resolution || "720p");
  const audioProvider = audioProviderFromValue(providers.audio_provider || ENV.AUDIO_PROVIDER || "hume");
  const imageModel = String(providers.image_model || defaultMagicHourImageModel());
  return {
    project_id: projectId,
    project_dir: projectDir,
    aspect_ratio: String(providers.aspect_ratio || preferences.aspect_ratio || "9:16"),
    resolution,
    openai_api_key: credentials.openai_api_key ?? "",
    magic_hour_api_key: credentials.magic_hour_api_key ?? ENV.MAGIC_HOUR_API_KEY ?? "",
    fish_audio_api_key: credentials.fish_audio_api_key ?? ENV.FISH_AUDIO_API_KEY ?? "",
    fish_audio_reference_id: credentials.fish_audio_reference_id ?? ENV.FISH_AUDIO_REFERENCE_ID ?? "",
    hume_api_key: credentials.hume_api_key ?? ENV.HUME_API_KEY ?? "",
    elevenlabs_api_key: credentials.elevenlabs_api_key ?? ENV.ELEVENLABS_API_KEY ?? "",
    elevenlabs_voice_id: String(
      providers.elevenlabs_voice_id || preferences.elevenlabs_voice_id || credentials.elevenlabs_voice_id || ENV.ELEVENLABS_VOICE_ID || "",
    ),
    elevenlabs_voice_name: String(
      providers.elevenlabs_voice_name ||
        preferences.elevenlabs_voice_name ||
        credentials.elevenlabs_voice_name ||
        ENV.ELEVENLABS_VOICE_NAME ||
        DEFAULT_ELEVENLABS_VOICE_NAME,
    ),
    agent_provider: String(providers.agent_provider || preferences.agent_provider || ENV.AGENT_MODEL_PROVIDER || "openai"),
    agent_model: String(providers.agent_model || preferences.agent_model || ENV.OPENAI_MODEL || "gpt-5.4"),
    agent_intensity: String(providers.agent_intensity || preferences.agent_intensity || ENV.AGENT_MODEL_INTENSITY || "standard"),
    openrouter_api_key: credentials.openrouter_api_key ?? undefined,
    image_model: imageModel,
    image_resolution: String(
      providers.image_resolution ||
        ENV.MAGIC_HOUR_IMAGE_RESOLUTION ||
        defaultImageResolutionForModel(resolution, imageModel),
    ),
    image_style_tool: String(providers.image_style_tool || ENV.MAGIC_HOUR_IMAGE_STYLE_TOOL || "general"),
    video_model: String(providers.video_model || defaultMagicHourVideoModel()),
    video_audio: Boolean(providers.video_audio || envBool(ENV.MAGIC_HOUR_VIDEO_AUDIO)),
    audio_provider: audioProvider,
    audio_model: audioModelForProvider(audioProvider, providers.audio_model),
    audio_format: String(providers.audio_format || ENV.FISH_AUDIO_FORMAT || "mp3"),
    hume_voice_description: String(providers.hume_voice_description || preferences.hume_voice_description || ENV.HUME_VOICE_DESCRIPTION || ""),
    hume_voice_id: String(providers.hume_voice_id || preferences.hume_voice_id || ENV.HUME_VOICE_ID || ""),
    hume_voice_name: String(providers.hume_voice_name || preferences.hume_voice_name || ENV.HUME_VOICE_NAME || ""),
    hume_voice_provider: String(providers.hume_voice_provider || ENV.HUME_VOICE_PROVIDER || "HUME_AI"),
  };
}

export function userPreferencesForRequest(request: CreateProjectRequest): JsonDict {
  const { openrouter_api_key: _openrouterApiKey, runtime_credentials: _runtimeCredentials, ...safeRequest } = request;
  return { ...safeRequest };
}

export function providerSettingsForContext(ctx: ProjectContext): JsonDict {
  return {
    image_model: ctx.image_model,
    image_resolution: ctx.image_resolution,
    image_style_tool: ctx.image_style_tool,
    video_model: ctx.video_model,
    video_resolution: ctx.resolution,
    video_audio: ctx.video_audio,
    audio_provider: ctx.audio_provider,
    audio_model: ctx.audio_model,
    audio_format: ctx.audio_format,
    hume_voice_description: ctx.hume_voice_description,
    hume_voice_id: ctx.hume_voice_id,
    hume_voice_name: ctx.hume_voice_name,
    hume_voice_provider: ctx.hume_voice_provider,
    elevenlabs_voice_id: ctx.elevenlabs_voice_id,
    elevenlabs_voice_name: ctx.elevenlabs_voice_name,
    agent_provider: ctx.agent_provider,
    agent_model: ctx.agent_model,
    agent_intensity: ctx.agent_intensity,
    runtime_credentials: runtimeCredentialStatus({
      openai_api_key: ctx.openai_api_key || ENV.OPENAI_API_KEY || null,
      openrouter_api_key: ctx.openrouter_api_key || ENV.OPENROUTER_API_KEY || null,
      magic_hour_api_key: ctx.magic_hour_api_key || ENV.MAGIC_HOUR_API_KEY || null,
      fish_audio_api_key: ctx.fish_audio_api_key || ENV.FISH_AUDIO_API_KEY || null,
      fish_audio_reference_id: ctx.fish_audio_reference_id || ENV.FISH_AUDIO_REFERENCE_ID || null,
      hume_api_key: ctx.hume_api_key || ENV.HUME_API_KEY || null,
      elevenlabs_api_key: ctx.elevenlabs_api_key || ENV.ELEVENLABS_API_KEY || null,
      elevenlabs_voice_id: ctx.elevenlabs_voice_id || ENV.ELEVENLABS_VOICE_ID || null,
      elevenlabs_voice_name: ctx.elevenlabs_voice_name || ENV.ELEVENLABS_VOICE_NAME || null,
    }),
    aspect_ratio: ctx.aspect_ratio,
    resolution: ctx.resolution,
  };
}

export function initializeProjectState(ctx: ProjectContext, request: CreateProjectRequest): JsonDict {
  return writeInitialProjectState(ctx, {
    user_preferences: userPreferencesForRequest(request),
    provider_settings: {
      ...providerSettingsForContext(ctx),
      workflow: request.workflow,
      youtube_search_provider: request.youtube_search_provider,
      youtube_allow_provider_fallback: request.youtube_allow_provider_fallback,
    },
  });
}

export function ensureProjectState(ctx: ProjectContext, request: CreateProjectRequest): JsonDict {
  if (existsSync(artifactPath(ctx, "project_state"))) {
    return readProjectState(ctx);
  }
  return initializeProjectState(ctx, request);
}

export function requestFromProjectState(ctx: ProjectContext): CreateProjectRequest | null {
  const preferences = readProjectState(ctx).user_preferences ?? {};
  if (Object.keys(preferences).length === 0) return null;
  const parsed = CreateProjectRequestSchema.safeParse(preferences);
  if (!parsed.success) {
    console.warn(`Ignoring invalid saved request preferences for ${ctx.project_id}`);
    return null;
  }
  return parsed.data;
}

function positiveInt(value: unknown): number | null {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) return null;
  return parsed > 0 ? parsed : null;
}

async function probeVideoDimensions(videoPath: string): Promise<[number, number] | null> {
  if (!existsSync(videoPath)) return null;
  let stdout: string;
  try {
    const result = await execa(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", videoPath],
      { reject: false, timeout: 10_000 },
    );
    if (result.exitCode !== 0) return null;
    stdout = result.stdout;
  } catch {
    return null;
  }
  let payload: any;
  try {
    payload = JSON.parse(stdout || "{}");
  } catch {
    return null;
  }
  const streams = payload.streams;
  if (!Array.isArray(streams) || streams.length === 0) return null;
  const stream = typeof streams[0] === "object" && streams[0] !== null ? streams[0] : {};
  const width = positiveInt(stream.width);
  const height = positiveInt(stream.height);
  if (width === null || height === null) return null;
  return [width, height];
}

async function videoAssetDimensions(video: JsonDict): Promise<[number, number] | null> {
  const width = positiveInt(video.source_width ?? video.width);
  const height = positiveInt(video.source_height ?? video.height);
  if (width !== null && height !== null) return [width, height];
  const videoPath = video.path;
  if (!videoPath) return null;
  return probeVideoDimensions(String(videoPath));
}

function aspectRatioForDimensions(width: number, height: number): AspectRatio {
  if (Math.abs(width - height) <= Math.max(width, height) * 0.05) return "1:1";
  if (height > width) return "9:16";
  return "16:9";
}

export async function inferYoutubeOutputAspectRatio(
  videos: JsonDict[],
  options: { default_aspect_ratio: string },
): Promise<string> {
  const votes: Record<AspectRatio, number> = { "9:16": 0, "16:9": 0, "1:1": 0 };
  let firstDetected: AspectRatio | null = null;
  for (const video of videos) {
    const dimensions = await videoAssetDimensions(video);
    if (dimensions === null) continue;
    const aspectRatio = aspectRatioForDimensions(dimensions[0], dimensions[1]);
    if (firstDetected === null) firstDetected = aspectRatio;
    votes[aspectRatio] += 1;
  }
  if (firstDetected === null) return options.default_aspect_ratio;
  const maxVotes = Math.max(...Object.values(votes));
  const winners = (Object.entries(votes) as Array<[AspectRatio, number]>)
    .filter(([, count]) => count === maxVotes)
    .map(([aspectRatio]) => aspectRatio);
  if (winners.length === 1) return winners[0]!;
  return firstDetected;
}
