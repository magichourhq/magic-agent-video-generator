import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ProjectContext } from "./context.js";
import type { VideoPlan } from "./schemas.js";
import { normalizeTimeline } from "./timeline.js";

export const PROJECT_STATE_VERSION = 1;
const MISSING = Symbol("missing");

export function utcNow(): string {
  return new Date().toISOString();
}

export type JsonDict = Record<string, any>;

export function artifactPath(ctx: ProjectContext, name: string): string {
  const filename = name === "manifest" ? "manifest.json" : `${name}.json`;
  return path.join(ctx.project_dir, filename);
}

export function readJsonArtifact<T = any>(ctx: ProjectContext, name: string, defaultValue: T | null = null): T | null {
  const file = artifactPath(ctx, name);
  if (!existsSync(file)) return defaultValue;
  return JSON.parse(readFileSync(file, "utf-8")) as T;
}

export function writeJsonArtifact<T>(ctx: ProjectContext, name: string, payload: T): T {
  const file = artifactPath(ctx, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(payload, null, 2), "utf-8");
  return payload;
}

export function removeJsonArtifact(ctx: ProjectContext, name: string): void {
  try {
    unlinkSync(artifactPath(ctx, name));
  } catch {
    // missing artifact is fine
  }
}

export function defaultProjectState(
  ctx: ProjectContext,
  options: { user_preferences?: JsonDict | null; provider_settings?: JsonDict | null } = {},
): JsonDict {
  const now = utcNow();
  return {
    version: PROJECT_STATE_VERSION,
    project_id: ctx.project_id,
    created_at: now,
    updated_at: now,
    status: {
      stage: "initialized",
      progress: 0,
      message: "Project state initialized.",
    },
    user_preferences: options.user_preferences ?? {},
    provider_settings: options.provider_settings ?? {},
    current_plan: null,
    scene_assets: {
      voiceover: null,
      images: [],
      videos: [],
      final_video_path: null,
      final_image_path: null,
      manifest_path: null,
    },
    timeline: null,
    failures: [],
    decisions: [],
    messages: [],
  };
}

export function normalizeProjectState(ctx: ProjectContext, state: JsonDict): JsonDict {
  const defaults = defaultProjectState(ctx);
  const normalized: JsonDict = { ...defaults, ...state };
  normalized.project_id = ctx.project_id;
  normalized.status = { ...defaults.status, ...(state.status ?? {}) };
  normalized.scene_assets = { ...defaults.scene_assets, ...(state.scene_assets ?? {}) };
  normalized.timeline = state.timeline ? normalizeTimeline(state.timeline) : null;
  normalized.user_preferences = { ...(state.user_preferences ?? {}) };
  normalized.provider_settings = { ...(state.provider_settings ?? {}) };
  normalized.failures = [...(state.failures ?? [])];
  normalized.decisions = [...(state.decisions ?? [])];
  normalized.messages = [...(state.messages ?? [])];
  return normalized;
}

export function initializeProjectState(
  ctx: ProjectContext,
  options: { user_preferences?: JsonDict | null; provider_settings?: JsonDict | null } = {},
): JsonDict {
  return writeJsonArtifact(ctx, "project_state", defaultProjectState(ctx, options));
}

export function readProjectState(ctx: ProjectContext): JsonDict {
  const state = readJsonArtifact<JsonDict>(ctx, "project_state");
  if (!state) return defaultProjectState(ctx);
  return normalizeProjectState(ctx, state);
}

export function writeProjectState(ctx: ProjectContext, state: JsonDict): JsonDict {
  const normalized = normalizeProjectState(ctx, state);
  normalized.updated_at = utcNow();
  return writeJsonArtifact(ctx, "project_state", normalized);
}

export interface UpdateProjectStateOptions {
  status?: JsonDict | null;
  user_preferences?: JsonDict | null;
  provider_settings?: JsonDict | null;
  current_plan?: any;
  voiceover?: any;
  images?: any;
  videos?: any;
  failures?: any;
  final_video_path?: any;
  final_image_path?: any;
  manifest_path?: any;
  timeline?: any;
  manifest?: JsonDict | null;
  decision?: JsonDict | null;
}

export function updateProjectState(ctx: ProjectContext, options: UpdateProjectStateOptions = {}): JsonDict {
  const state = readProjectState(ctx);
  const has = (key: keyof UpdateProjectStateOptions) => Object.prototype.hasOwnProperty.call(options, key);

  if (options.status != null) {
    state.status = { ...(state.status ?? {}), ...options.status };
    const recovered =
      options.status.status === "succeeded" ||
      options.status.stage === "complete";
    if (recovered && !Object.prototype.hasOwnProperty.call(options.status, "error")) {
      delete state.status.error;
    }
  }
  if (options.user_preferences != null) {
    state.user_preferences = { ...(state.user_preferences ?? {}), ...options.user_preferences };
  }
  if (options.provider_settings != null) {
    state.provider_settings = { ...(state.provider_settings ?? {}), ...options.provider_settings };
  }
  if (has("current_plan")) state.current_plan = options.current_plan;
  const sceneAssets = state.scene_assets;
  if (has("voiceover")) sceneAssets.voiceover = options.voiceover;
  if (has("images")) sceneAssets.images = options.images;
  if (has("videos")) sceneAssets.videos = options.videos;
  if (has("failures")) state.failures = options.failures;
  if (has("final_video_path")) sceneAssets.final_video_path = options.final_video_path;
  if (has("final_image_path")) sceneAssets.final_image_path = options.final_image_path;
  if (has("manifest_path")) sceneAssets.manifest_path = options.manifest_path;
  if (has("timeline")) state.timeline = options.timeline ? normalizeTimeline(options.timeline) : null;
  if (options.manifest != null) {
    sceneAssets.manifest_path = options.manifest.manifest_path ?? sceneAssets.manifest_path;
    sceneAssets.final_video_path = options.manifest.final_video_path ?? sceneAssets.final_video_path;
    sceneAssets.final_image_path = options.manifest.final_image_path ?? sceneAssets.final_image_path;
    state.failures = options.manifest.failed_scenes ?? state.failures ?? [];
  }
  if (options.decision != null) {
    state.decisions = [...(state.decisions ?? []), { created_at: utcNow(), ...options.decision }];
  }
  return writeProjectState(ctx, state);
}

export function appendProjectDecision(
  ctx: ProjectContext,
  options: {
    decision: string;
    rationale?: string;
    scene_id?: string | null;
    tool?: string | null;
    metadata?: JsonDict | null;
  },
): JsonDict {
  const entry: JsonDict = { decision: options.decision };
  if (options.rationale) entry.rationale = options.rationale;
  if (options.scene_id) entry.scene_id = options.scene_id;
  if (options.tool) entry.tool = options.tool;
  if (options.metadata) entry.metadata = options.metadata;
  const state = updateProjectState(ctx, { decision: entry });
  return state.decisions[state.decisions.length - 1];
}

export function appendProjectMessage(
  ctx: ProjectContext,
  options: { role: string; content: string; metadata?: JsonDict | null },
): JsonDict {
  const entry: JsonDict = {
    created_at: utcNow(),
    role: options.role,
    content: options.content,
  };
  if (options.metadata) entry.metadata = options.metadata;
  const state = readProjectState(ctx);
  state.messages = [...(state.messages ?? []), entry];
  writeProjectState(ctx, state);
  return entry;
}

export function orderedSceneAssets(plan: VideoPlan, assets: JsonDict[]): JsonDict[] {
  const byScene = new Map(assets.map((asset) => [asset.scene_id, asset]));
  return plan.scenes.filter((scene) => byScene.has(scene.id)).map((scene) => byScene.get(scene.id)!);
}

export function upsertSceneAssets(existing: JsonDict[], replacements: JsonDict[]): JsonDict[] {
  const byScene = new Map(existing.map((asset) => [asset.scene_id, asset]));
  for (const asset of replacements) byScene.set(asset.scene_id, asset);
  return [...byScene.values()];
}

export function clearSceneFailures(
  failures: JsonDict[],
  sceneIds: Set<string>,
  stages: Set<string> | null = null,
): JsonDict[] {
  return failures.filter(
    (failure) => !(sceneIds.has(failure.scene_id) && (stages === null || stages.has(failure.stage))),
  );
}

export function recordSceneFailures(existing: JsonDict[], failures: JsonDict[]): JsonDict[] {
  const cleaned = clearSceneFailures(
    existing,
    new Set(failures.map((failure) => failure.scene_id)),
    new Set(failures.map((failure) => failure.stage)),
  );
  return [...cleaned, ...failures];
}
