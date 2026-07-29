import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ENV, MH_AGENT_YT_CLIPS_DIR, OUTPUT_DIR, REQUIRED_ENV_KEYS, REQUIRED_SYSTEM_COMMANDS, YOUTUBE_REVIEW_PROMPT_SET_PATH } from "./config.js";
import type { ProjectContext } from "./context.js";
import { PROJECT_CONTEXT_DEFAULTS } from "./context.js";
import { resolveAgentRuntime, runtimeFromContext } from "./agentRuntime.js";
import { projectEvents } from "./events.js";
import { readProjectState, updateProjectState } from "./renderState.js";
import type { JsonDict } from "./renderState.js";
import { runtimeCredentialsFromRequest } from "./runtimeCredentials.js";
import {
  type CreateProjectRequest,
  type ProjectStatus,
  type YouTubeReviewProvider,
  type YouTubeReviewSessionRequest,
  YouTubeReviewSessionRequestSchema,
} from "./schemas.js";
import { execaSync } from "execa";

export const PROJECT_ID_PATTERN = /^[a-f0-9]{32}$/;
export const PROJECTS: Map<string, JsonDict> = new Map();
export const YOUTUBE_REVIEW_PROVIDERS_ACTIVE: readonly YouTubeReviewProvider[] = ["youtube_data_api"];
export const RUNNING_YOUTUBE_REVIEW_BATCHES = new Set<string>();

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    public detail: unknown,
  ) {
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
}

export function missingConfiguration(request: CreateProjectRequest | null = null): string[] {
  const runtime = resolveAgentRuntime(request);
  const credentials = runtimeCredentialsFromRequest(request);
  const audioProviderRaw = String(request?.audio_provider || ENV.AUDIO_PROVIDER || "hume").trim().toLowerCase();
  const audioProvider =
    audioProviderRaw === "fish"
      ? "fish"
      : audioProviderRaw === "elevenlabs" || audioProviderRaw === "eleven_labs" || audioProviderRaw === "eleven-labs"
        ? "elevenlabs"
        : "hume";
  const missing = REQUIRED_ENV_KEYS.filter((key) => {
    if (key === "OPENAI_API_KEY" && runtime?.provider === "openrouter" && runtime.has_api_key) return false;
    if (key === "OPENAI_API_KEY" && credentials.openai_api_key) return false;
    if (key === "MAGIC_HOUR_API_KEY" && credentials.magic_hour_api_key) return false;
    if (audioProvider !== "fish" && (key === "FISH_AUDIO_API_KEY" || key === "FISH_AUDIO_REFERENCE_ID")) return false;
    if (audioProvider !== "hume" && key === "HUME_API_KEY") return false;
    if (key === "HUME_API_KEY" && credentials.hume_api_key) return false;
    if (key === "FISH_AUDIO_API_KEY" && credentials.fish_audio_api_key) return false;
    if (key === "FISH_AUDIO_REFERENCE_ID" && credentials.fish_audio_reference_id) return false;
    return !ENV[key];
  });
  if (audioProvider === "elevenlabs" && !credentials.elevenlabs_api_key && !ENV.ELEVENLABS_API_KEY) {
    missing.push("ELEVENLABS_API_KEY" as any);
  }
  return missing;
}

export function missingContextConfiguration(ctx: ProjectContext): string[] {
  const missing: string[] = [];
  if (ctx.agent_provider === "openrouter") {
    if (!ctx.openrouter_api_key && !ENV.OPENROUTER_API_KEY) missing.push("OPENROUTER_API_KEY");
  } else if (!ctx.openai_api_key && !ENV.OPENAI_API_KEY) {
    missing.push("OPENAI_API_KEY");
  }
  if (!ctx.magic_hour_api_key && !ENV.MAGIC_HOUR_API_KEY) missing.push("MAGIC_HOUR_API_KEY");
  if (ctx.audio_provider === "hume") {
    if (!ctx.hume_api_key && !ENV.HUME_API_KEY) missing.push("HUME_API_KEY");
  } else if (ctx.audio_provider === "elevenlabs") {
    if (!ctx.elevenlabs_api_key && !ENV.ELEVENLABS_API_KEY) missing.push("ELEVENLABS_API_KEY");
  } else {
    if (!ctx.fish_audio_api_key && !ENV.FISH_AUDIO_API_KEY) missing.push("FISH_AUDIO_API_KEY");
    if (!ctx.fish_audio_reference_id && !ENV.FISH_AUDIO_REFERENCE_ID) missing.push("FISH_AUDIO_REFERENCE_ID");
  }
  return missing;
}

function commandExists(command: string): boolean {
  try {
    const result = execaSync("which", [command], { reject: false });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export function missingSystemDependencies(): string[] {
  return REQUIRED_SYSTEM_COMMANDS.filter((command) => !commandExists(command));
}

export function assertRuntimeReady(request: CreateProjectRequest | null = null): void {
  const missingConfig = missingConfiguration(request);
  if (request) {
    const runtime = resolveAgentRuntime(request);
    if (!runtime.has_api_key) {
      missingConfig.push(runtime.provider === "openrouter" ? "OPENROUTER_API_KEY" : "OPENAI_API_KEY");
    }
  }
  const missingDependencies = missingSystemDependencies();
  if (missingConfig.length > 0 || missingDependencies.length > 0) {
    throw new HttpError(503, {
      message: "Project is not ready to render locally.",
      missing_config: [...new Set(missingConfig)],
      missing_dependencies: missingDependencies,
    });
  }
}

export function assertProjectContextReady(ctx: ProjectContext): void {
  const missingConfig = missingContextConfiguration(ctx);
  const runtime = runtimeFromContext(ctx);
  if (!runtime.has_api_key) {
    missingConfig.push(runtime.provider === "openrouter" ? "OPENROUTER_API_KEY" : "OPENAI_API_KEY");
  }
  const missingDependencies = missingSystemDependencies();
  if (missingConfig.length > 0 || missingDependencies.length > 0) {
    throw new HttpError(503, {
      message: "Project is not ready to render locally.",
      missing_config: [...new Set(missingConfig)],
      missing_dependencies: missingDependencies,
    });
  }
}

export function projectDirFor(projectId: string): string {
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw new Error(`Invalid project id: ${projectId}`);
  }
  return path.resolve(OUTPUT_DIR, projectId);
}

export function publicMediaPath(mediaPath: string): string {
  const resolved = path.resolve(mediaPath);
  const relative = path.relative(path.resolve(OUTPUT_DIR), resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Media path is outside output directory: ${resolved}`);
  }
  return `/media/${relative.split(path.sep).join("/")}`;
}

export function slugifyFilename(value: string, options: { fallback?: string; maxLength?: number } = {}): string {
  const { fallback = "youtube-short", maxLength = 80 } = options;
  let slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  if (!slug) return fallback;
  if (slug.length <= maxLength) return slug;
  const clipped = slug.slice(0, maxLength);
  const lastDash = clipped.lastIndexOf("-");
  const trimmed = (lastDash > 0 ? clipped.slice(0, lastDash) : clipped).replace(/^-+|-+$/g, "");
  return trimmed || clipped.replace(/^-+|-+$/g, "") || fallback;
}

export function exportYoutubeFinalVideo(ctx: ProjectContext, manifest: JsonDict): JsonDict {
  if (manifest.workflow !== "youtube_clips") return manifest;
  const finalVideoPath = manifest.final_video_path;
  if (!finalVideoPath) return manifest;
  const source = path.resolve(String(finalVideoPath));
  if (!existsSync(source) || !statSync(source).isFile()) return manifest;

  const state = readProjectState(ctx);
  const prompt = String((state.user_preferences ?? {}).prompt || manifest.title || "");
  const filename = `${slugifyFilename(prompt)}__${ctx.project_id.slice(0, 8)}.mp4`;
  const destination = path.join(MH_AGENT_YT_CLIPS_DIR, filename);
  mkdirSync(MH_AGENT_YT_CLIPS_DIR, { recursive: true });
  if (source !== destination) copyFileSync(source, destination);

  return { ...manifest, exported_final_video_path: destination };
}

export function withMediaUrl(asset: JsonDict): JsonDict {
  const payload = { ...asset };
  if (payload.path) payload.url = publicMediaPath(String(payload.path));
  return payload;
}

export function statusFileFor(projectId: string): string {
  return path.join(projectDirFor(projectId), "status.json");
}

function bareContext(projectId: string, projectDir: string): ProjectContext {
  return {
    project_id: projectId,
    project_dir: projectDir,
    aspect_ratio: "",
    resolution: "",
    ...PROJECT_CONTEXT_DEFAULTS,
  };
}

export interface UpdateProjectStatusOptions {
  status: ProjectStatus;
  stage: string;
  progress: number;
  message: string;
  manifest?: JsonDict | null;
  error?: string | null;
}

export async function updateProjectStatus(projectId: string, options: UpdateProjectStatusOptions): Promise<JsonDict> {
  const payload: JsonDict = {
    project_id: projectId,
    status: options.status,
    stage: options.stage,
    progress: Math.max(0, Math.min(options.progress, 100)),
    message: options.message,
    updated_at: new Date().toISOString(),
    status_url: `/api/projects/${projectId}`,
  };
  if (options.manifest != null) payload.manifest = options.manifest;
  if (options.error != null) payload.error = options.error;

  PROJECTS.set(projectId, payload);
  const statusPath = statusFileFor(projectId);
  mkdirSync(path.dirname(statusPath), { recursive: true });
  writeFileSync(statusPath, JSON.stringify(payload, null, 2), "utf-8");
  const statePath = path.join(path.dirname(statusPath), "project_state.json");
  if (existsSync(statePath)) {
    updateProjectState(bareContext(projectId, path.dirname(statusPath)), {
      status: {
        status: options.status,
        stage: options.stage,
        progress: payload.progress,
        message: options.message,
        ...(options.error != null ? { error: options.error } : {}),
      },
    });
  }
  projectEvents.emitProjectEvent(projectId, {
    type: "status",
    status: payload.status,
    stage: payload.stage,
    progress: payload.progress,
    message: payload.message,
    ...(options.error != null ? { error: options.error } : {}),
  });
  return payload;
}

export function terminalYoutubeStatusFromManifest(projectId: string, manifest: JsonDict): JsonDict | null {
  if (manifest.workflow !== "youtube_clips") return null;
  if (!["complete", "partial"].includes(manifest.render_status)) return null;
  if (!manifest.videos || manifest.videos.length === 0) return null;
  const finalVideoPath = manifest.final_video_path;
  const finalVideoUrl = manifest.final_video_url;
  if (finalVideoPath) {
    if (!existsSync(String(finalVideoPath)) || !statSync(String(finalVideoPath)).isFile()) return null;
  } else if (!finalVideoUrl) {
    return null;
  }

  const failedCount = Number(manifest.failed_scene_count ?? 0);
  return {
    project_id: projectId,
    status: "succeeded",
    stage: "complete",
    progress: 100,
    message: failedCount === 0 ? "Video is ready." : `Partial video is ready with ${failedCount} failed scene(s).`,
    updated_at: new Date().toISOString(),
    status_url: `/api/projects/${projectId}`,
    manifest,
  };
}

function repairRunningStatusFromTerminalYoutubeManifest(
  projectId: string,
  payload: JsonDict,
  state: JsonDict | null,
): JsonDict {
  if (["succeeded", "failed"].includes(payload.status)) {
    if (state !== null) return { ...payload, project_state: state };
    return payload;
  }

  const projectDir = projectDirFor(projectId);
  let manifest = payload.manifest;
  const manifestPath = path.join(projectDir, "manifest.json");
  if ((typeof manifest !== "object" || manifest === null) && existsSync(manifestPath)) {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  }
  if (typeof manifest !== "object" || manifest === null) {
    if (state !== null) return { ...payload, project_state: state };
    return payload;
  }

  const repaired = terminalYoutubeStatusFromManifest(projectId, manifest as JsonDict);
  if (repaired === null) {
    if (state !== null) return { ...payload, project_state: state };
    return payload;
  }

  PROJECTS.set(projectId, repaired);
  const statusPath = statusFileFor(projectId);
  mkdirSync(path.dirname(statusPath), { recursive: true });
  writeFileSync(statusPath, JSON.stringify(repaired, null, 2), "utf-8");

  let nextState = state;
  const statePath = path.join(projectDir, "project_state.json");
  if (existsSync(statePath)) {
    const stateCtx = bareContext(projectId, projectDir);
    updateProjectState(stateCtx, {
      status: { status: "succeeded", stage: "complete", progress: 100, message: repaired.message },
    });
    nextState = readProjectState(stateCtx);
  }

  const result = { ...repaired };
  if (nextState !== null) result.project_state = nextState;
  return result;
}

export function readProjectStatus(projectId: string): JsonDict | null {
  const projectDir = projectDirFor(projectId);
  const stateCtx = bareContext(projectId, projectDir);
  const state = existsSync(path.join(projectDir, "project_state.json")) ? readProjectState(stateCtx) : null;
  const inMemory = PROJECTS.get(projectId);
  if (inMemory) {
    return repairRunningStatusFromTerminalYoutubeManifest(projectId, { ...inMemory }, state);
  }

  const statusPath = path.join(projectDir, "status.json");
  if (existsSync(statusPath)) {
    const payload = JSON.parse(readFileSync(statusPath, "utf-8"));
    return repairRunningStatusFromTerminalYoutubeManifest(projectId, payload, state);
  }

  const manifestPath = path.join(projectDir, "manifest.json");
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    const payload = terminalYoutubeStatusFromManifest(projectId, manifest) ?? {
      project_id: projectId,
      status: "succeeded",
      stage: "complete",
      progress: 100,
      message: "Video is ready.",
      updated_at: new Date().toISOString(),
      status_url: `/api/projects/${projectId}`,
      manifest,
    };
    if (state !== null) payload.project_state = state;
    return payload;
  }

  return null;
}

export function listProjectStatuses(options: { limit?: number } = {}): JsonDict[] {
  const limit = Math.max(1, Math.min(500, Math.trunc(Number(options.limit ?? 100)) || 100));
  const byId = new Map<string, JsonDict>();

  for (const projectId of PROJECTS.keys()) {
    if (!PROJECT_ID_PATTERN.test(projectId)) continue;
    const status = readProjectStatus(projectId);
    if (status) byId.set(projectId, status);
  }

  if (existsSync(OUTPUT_DIR)) {
    for (const entry of readdirSync(OUTPUT_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() || !PROJECT_ID_PATTERN.test(entry.name) || byId.has(entry.name)) continue;
      const status = readProjectStatus(entry.name);
      if (status) byId.set(entry.name, status);
    }
  }

  return [...byId.values()]
    .sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")))
    .slice(0, limit);
}

export function reviewDirFor(reviewId: string): string {
  if (!PROJECT_ID_PATTERN.test(reviewId)) {
    throw new Error(`Invalid review id: ${reviewId}`);
  }
  return path.resolve(OUTPUT_DIR, "reviews", reviewId);
}

export function reviewFileFor(reviewId: string): string {
  return path.join(reviewDirFor(reviewId), "review.json");
}

export function reviewBatchDirFor(batchId: string): string {
  if (!PROJECT_ID_PATTERN.test(batchId)) {
    throw new Error(`Invalid review batch id: ${batchId}`);
  }
  return path.resolve(OUTPUT_DIR, "reviews", "batches", batchId);
}

export function reviewBatchFileFor(batchId: string): string {
  return path.join(reviewBatchDirFor(batchId), "batch.json");
}

export function readYoutubeReviewSession(reviewId: string): JsonDict | null {
  const reviewPath = reviewFileFor(reviewId);
  if (!existsSync(reviewPath)) return null;
  return JSON.parse(readFileSync(reviewPath, "utf-8"));
}

export function writeYoutubeReviewSession(payload: JsonDict): JsonDict {
  const reviewPath = reviewFileFor(String(payload.review_id));
  mkdirSync(path.dirname(reviewPath), { recursive: true });
  writeFileSync(reviewPath, JSON.stringify(payload, null, 2), "utf-8");
  return payload;
}

export function readYoutubeReviewBatch(batchId: string): JsonDict | null {
  const batchPath = reviewBatchFileFor(batchId);
  if (!existsSync(batchPath)) return null;
  return JSON.parse(readFileSync(batchPath, "utf-8"));
}

export function writeYoutubeReviewBatch(payload: JsonDict): JsonDict {
  const batchPath = reviewBatchFileFor(String(payload.batch_id));
  mkdirSync(path.dirname(batchPath), { recursive: true });
  writeFileSync(batchPath, JSON.stringify(payload, null, 2), "utf-8");
  return payload;
}

export function latestYoutubeReviewBatch(): JsonDict | null {
  const batchesDir = path.join(OUTPUT_DIR, "reviews", "batches");
  if (!existsSync(batchesDir)) return null;
  const batchFiles: Array<{ file: string; mtime: number }> = [];
  for (const entry of readdirSync(batchesDir)) {
    const file = path.join(batchesDir, entry, "batch.json");
    if (existsSync(file) && statSync(file).isFile()) {
      batchFiles.push({ file, mtime: statSync(file).mtimeMs });
    }
  }
  if (batchFiles.length === 0) return null;
  batchFiles.sort((a, b) => b.mtime - a.mtime);
  return JSON.parse(readFileSync(batchFiles[0]!.file, "utf-8"));
}

export interface ReviewPromptEntry {
  prompt_id: string;
  name: string;
  category: string;
  request: YouTubeReviewSessionRequest;
}

export function loadYoutubeReviewPromptSet(promptSetPath: string = YOUTUBE_REVIEW_PROMPT_SET_PATH): ReviewPromptEntry[] {
  const prompts: ReviewPromptEntry[] = [];
  const lines = readFileSync(promptSetPath, "utf-8").split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    const lineNumber = index + 1;
    const raw = JSON.parse(line);
    const settings = raw.settings ?? {};
    const request = YouTubeReviewSessionRequestSchema.parse({
      prompt: String(raw.prompt),
      duration_seconds: settings.duration_seconds ?? null,
      scene_count: settings.scene_count ?? null,
      aspect_ratio: settings.aspect_ratio ?? "9:16",
      resolution: settings.resolution ?? "720p",
    });
    prompts.push({
      prompt_id: String(raw.id ?? `prompt-${String(lineNumber).padStart(3, "0")}`),
      name: String(raw.name ?? raw.id ?? `Prompt ${lineNumber}`),
      category: String(raw.category ?? "uncategorized"),
      request,
    });
  });
  if (prompts.length === 0) {
    throw new Error(`No review prompts found in ${promptSetPath}`);
  }
  return prompts;
}

export function parseIsoDatetime(value: unknown): Date | null {
  if (!value) return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function projectLatencySeconds(startedAt: unknown, status: JsonDict | null): number | null {
  const started = parseIsoDatetime(startedAt);
  if (started === null) return null;
  const isTerminal = status !== null && ["succeeded", "failed"].includes(status.status);
  const finished = isTerminal && status !== null ? parseIsoDatetime(status.updated_at) : null;
  const ended = finished ?? new Date();
  return Math.round(Math.max(0, (ended.getTime() - started.getTime()) / 1000) * 100) / 100;
}

export function youtubeReviewProjectRequest(
  request: YouTubeReviewSessionRequest,
  provider: YouTubeReviewProvider,
): CreateProjectRequest {
  return {
    prompt: request.prompt,
    workflow: "youtube_clips",
    youtube_search_provider: provider,
    youtube_allow_provider_fallback: false,
    duration_seconds: request.duration_seconds ?? null,
    scene_count: request.scene_count ?? null,
    aspect_ratio: request.aspect_ratio,
    resolution: request.resolution,
    image_model: null,
    video_model: null,
    image_resolution: null,
    video_resolution: null,
    agent_provider: null,
    agent_model: null,
    agent_intensity: "standard",
    audio_provider: null,
    hume_voice_description: null,
    hume_voice_id: null,
    hume_voice_name: null,
    elevenlabs_voice_id: null,
    elevenlabs_voice_name: null,
    input_media: [],
    runtime_credentials: null,
    openrouter_api_key: null,
  };
}

export function youtubeReviewSessionResponse(payload: JsonDict): JsonDict {
  const providers: JsonDict = {};
  for (const [provider, providerPayload] of Object.entries((payload.providers ?? {}) as JsonDict)) {
    const projectId = String((providerPayload as JsonDict).project_id);
    const status = readProjectStatus(projectId);
    let manifest = status && typeof status === "object" ? status.manifest : null;
    manifest = manifest && typeof manifest === "object" ? manifest : {};
    if (Object.keys(manifest).length === 0) {
      const manifestPath = path.join(projectDirFor(projectId), "manifest.json");
      if (existsSync(manifestPath)) {
        manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      }
    }
    providers[provider] = {
      ...(providerPayload as JsonDict),
      status,
      latency_seconds: projectLatencySeconds((providerPayload as JsonDict).started_at, status),
      render_status: manifest.render_status,
      completed_scene_count: manifest.completed_scene_count,
      failed_scene_count: manifest.failed_scene_count,
      final_video_path: manifest.final_video_path,
      final_video_url: manifest.final_video_url,
    };
  }

  return {
    review_id: payload.review_id,
    prompt: payload.prompt,
    created_at: payload.created_at,
    updated_at: payload.updated_at,
    settings: payload.settings,
    metadata: payload.metadata ?? {},
    providers,
  };
}

export function youtubeReviewBatchResponse(payload: JsonDict): JsonDict {
  const items: JsonDict[] = [];
  for (const item of (payload.items ?? []) as JsonDict[]) {
    const reviewPayload = readYoutubeReviewSession(String(item.review_id));
    items.push({
      ...item,
      review: reviewPayload !== null ? youtubeReviewSessionResponse(reviewPayload) : null,
    });
  }
  return {
    batch_id: payload.batch_id,
    prompt_set_path: payload.prompt_set_path,
    created_at: payload.created_at,
    updated_at: payload.updated_at,
    items,
  };
}
