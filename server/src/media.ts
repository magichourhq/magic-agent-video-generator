import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { encode as msgpackEncode } from "@msgpack/msgpack";
import { execa } from "execa";
import { Client as MagicHourClient } from "magic-hour";
import { DEFAULT_ELEVENLABS_AUDIO_MODEL, DEFAULT_ELEVENLABS_VOICE_NAME } from "./config.js";
import {
  audioPerformanceSequenceForPlan,
  audioPerformanceForGeneration,
  averagedHumeTemperature,
  sanitizeTextForAudioPerformance,
  stableAudioPerformanceForPlan,
  type AudioPerformanceSettings,
} from "./audioPerformance.js";
import { providerConcurrency } from "./concurrency.js";
import type { ProjectContext } from "./context.js";
import { estimateTtsWordsPerSecondForContext } from "./prompts.js";
import type { Scene, VideoPlan, YouTubeClipSection } from "./schemas.js";
import { nativeAudioVideoPrompt, sceneAudioSource, sceneUsesNativeAudio } from "./sceneAudio.js";
import { recordTimingEvent, withTiming } from "./timings.js";
import { DEFAULT_HUME_UGC_VOICE_DESCRIPTION } from "./voices.js";

export interface ImageAsset {
  scene_id: string;
  path: string;
  prompt: string;
  model: string;
  resolution: string;
  style_tool: string;
  provider_job_id: string | null;
  provider_url: string | null;
  [key: string]: any;
}

export interface VideoAsset {
  scene_id: string;
  path: string;
  prompt: string;
  model: string;
  resolution: string;
  audio: boolean;
  duration_seconds: number;
  provider_job_id: string | null;
  provider_url: string | null;
  provider_status?: string | null;
  [key: string]: any;
}

export interface VoiceoverAsset {
  path: string;
  model: string;
  duration_seconds: number;
  target_duration_seconds: number;
  scene_timings?: VoiceoverSceneTiming[];
  sections?: SectionVoiceover[];
  [key: string]: any;
}

export interface VoiceoverSceneTiming {
  scene_id: string;
  start_seconds: number;
  end_seconds: number;
}

export interface SectionVoiceover {
  section: number;
  scene_id: string;
  path: string;
  provider?: string;
  model?: string;
  duration_seconds: number;
}

export interface SceneVoiceover {
  scene_id: string;
  path: string;
  provider?: string;
  model?: string;
  duration_seconds: number;
  audio_mode?: string;
  audio_note?: string | null;
  tts_speed?: number;
  tts_temperature?: number;
  trailing_silence?: number;
}

interface TtsUtterance {
  text: string;
  performance?: AudioPerformanceSettings | null;
}

interface TtsSynthesisOptions {
  performance?: AudioPerformanceSettings | null;
  utterances?: TtsUtterance[] | null;
  allowProviderFallback?: boolean;
}

interface ElevenLabsAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

export interface VideoAssetJob {
  scene: Scene;
  image: ImageAsset;
  out_dir: string;
  provider_job_id: string;
  prompt: string;
  model: string;
  resolution: string;
  audio: boolean;
  duration_seconds: number;
  submitted_status: string | null;
}

export interface ProviderJobFailureMetadata {
  provider_job_id: string;
  provider_kind: "i2v" | "talking-photo";
  provider_stage: "video_generation" | "talking";
  provider_submitted_status?: string | null;
  provider_model?: string | null;
  provider_resolution?: string | null;
  prompt?: string | null;
  audio?: boolean;
  duration_seconds?: number;
  audio_path?: string;
  audio_duration_seconds?: number;
  on_camera?: boolean;
}

export interface RecoverVideoAssetJob extends ProviderJobFailureMetadata {
  scene: Scene;
}

function magicHourClient(ctx: ProjectContext): MagicHourClient {
  return new MagicHourClient({
    token: ctx.magic_hour_api_key,
    timeout: Math.max(5_000, Number(process.env.MAGIC_HOUR_SUBMIT_TIMEOUT_MS ?? "60000")),
  });
}

function magicHourSubmitOptions(): { timeout: number; retries: { maxRetries: number } } {
  return {
    timeout: Math.max(5_000, Number(process.env.MAGIC_HOUR_SUBMIT_TIMEOUT_MS ?? "60000")),
    retries: { maxRetries: 0 },
  };
}

export function minimaxH3RequestBody(ctx: ProjectContext, scene: Scene, uploadedImagePath: string): Record<string, any> {
  const useNativeAudio = sceneUsesNativeAudio(scene);
  return {
    assets: { image_file_path: uploadedImagePath },
    audio: useNativeAudio,
    end_seconds: scene.duration_seconds,
    model: "minimax-h3",
    name: `${ctx.project_id}-${scene.id}`,
    resolution: ctx.resolution,
    style: { prompt: useNativeAudio ? nativeAudioVideoPrompt(scene) : scene.video_prompt },
  };
}

async function submitMinimaxH3ImageToVideo(
  ctx: ProjectContext,
  scene: Scene,
  imagePath: string,
): Promise<any> {
  const client = magicHourClient(ctx);
  const uploadedImagePath = await client.v1.files.uploadFile(imagePath);
  const timeoutMs = Math.max(5_000, Number(process.env.MAGIC_HOUR_SUBMIT_TIMEOUT_MS ?? "60000"));
  const response = await fetch("https://api.magichour.ai/v1/image-to-video", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ctx.magic_hour_api_key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(minimaxH3RequestBody(ctx, scene, uploadedImagePath)),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1_000);
    throw new Error(`Magic Hour MiniMax H3 submission failed (${response.status}): ${detail || response.statusText}`);
  }
  return response.json();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Is `err` a transient provider failure worth retrying?
 *
 * True for HTTP statuses {408, 425, 429, 500, 502, 503, 504}. The SDK throws an
 * ApiError-like object whose status may live on `err.status` or `err.statusCode`,
 * and/or be embedded in the message (e.g. "502 was returned from ..."). Check the
 * numeric fields first, then fall back to a word-boundary match on the message.
 */
export function isTransientProviderError(err: any): boolean {
  const transient = new Set([408, 425, 429, 500, 502, 503, 504]);
  const status = typeof err?.status === "number" ? err.status : err?.statusCode;
  if (typeof status === "number" && transient.has(status)) return true;
  const text = String(err?.code ?? "") + " " + String(err?.name ?? "") + " " + String(err?.message ?? "");
  return (
    /\b(408|425|429|500|502|503|504)\b/.test(text) ||
    /\b(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|AbortError|TimeoutError)\b/i.test(
      text,
    )
  );
}

export function providerErrorMessage(err: any): string {
  return err instanceof Error ? err.message : String(err);
}

export function attachProviderJobFailureMetadata<T extends Error>(
  err: T,
  metadata: ProviderJobFailureMetadata,
): T {
  Object.assign(err, metadata);
  return err;
}

export function providerJobFailureMetadata(err: any): ProviderJobFailureMetadata | null {
  const providerJobId = err?.provider_job_id;
  const providerKind = err?.provider_kind;
  const providerStage = err?.provider_stage;
  if (typeof providerJobId !== "string" || providerJobId.trim().length === 0) return null;
  if (providerKind !== "i2v" && providerKind !== "talking-photo") return null;
  if (providerStage !== "video_generation" && providerStage !== "talking") return null;
  return {
    provider_job_id: providerJobId,
    provider_kind: providerKind,
    provider_stage: providerStage,
    provider_submitted_status:
      typeof err?.provider_submitted_status === "string" ? err.provider_submitted_status : null,
    provider_model: typeof err?.provider_model === "string" ? err.provider_model : null,
    provider_resolution: typeof err?.provider_resolution === "string" ? err.provider_resolution : null,
    prompt: typeof err?.prompt === "string" ? err.prompt : null,
    audio: typeof err?.audio === "boolean" ? err.audio : undefined,
    duration_seconds: Number.isFinite(Number(err?.duration_seconds)) ? Number(err.duration_seconds) : undefined,
    audio_path: typeof err?.audio_path === "string" ? err.audio_path : undefined,
    audio_duration_seconds: Number.isFinite(Number(err?.audio_duration_seconds))
      ? Number(err.audio_duration_seconds)
      : undefined,
    on_camera: typeof err?.on_camera === "boolean" ? err.on_camera : undefined,
  };
}

export function magicHourPollRequestTimeoutMs(): number {
  return Math.max(5000, Number(process.env.MAGIC_HOUR_POLL_REQUEST_TIMEOUT_MS ?? "30000"));
}

export function magicHourPollRequestAttempts(): number {
  return Math.max(1, Math.trunc(Number(process.env.MAGIC_HOUR_POLL_REQUEST_ATTEMPTS ?? "6")));
}

export function videoPollIntervalSeconds(): number {
  return Math.max(0.5, Number(process.env.MAGIC_HOUR_POLL_INTERVAL ?? "2.0"));
}

export function imagePollTimeoutSeconds(): number {
  return Math.max(30.0, Number(process.env.MAGIC_HOUR_IMAGE_TIMEOUT_SECONDS ?? "600"));
}

export function videoPollTimeoutSeconds(): number {
  return Math.max(30.0, Number(process.env.MAGIC_HOUR_VIDEO_TIMEOUT_SECONDS ?? "1200"));
}

export function talkingPhotoPollTimeoutSeconds(): number {
  return Math.max(30.0, Number(process.env.MAGIC_HOUR_TALKING_PHOTO_TIMEOUT_SECONDS ?? "1200"));
}

export function providerRecoveryPollTimeoutSeconds(): number {
  return Math.max(30.0, Number(process.env.MAGIC_HOUR_PROVIDER_RECOVERY_TIMEOUT_SECONDS ?? "180"));
}

async function withRequestTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          const err: NodeJS.ErrnoException = new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s.`);
          err.code = "ETIMEDOUT";
          reject(err);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function pickDownload(result: any, directory: string): string {
  for (const rawPath of result?.downloadedPaths ?? []) {
    try {
      if (statSync(rawPath).isFile()) return rawPath;
    } catch {
      // skip missing entries
    }
  }
  let diskFiles: string[] = [];
  try {
    diskFiles = readdirSync(directory)
      .map((name) => path.join(directory, name))
      .filter((file) => {
        try {
          return statSync(file).isFile();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    diskFiles = [];
  }
  if (diskFiles.length > 0) return diskFiles[0]!;
  throw new Error(`No downloaded files in ${directory}`);
}

export function firstDownloadUrl(result: any): string | null {
  const downloads = result?.downloads ?? [];
  return downloads.length > 0 ? (downloads[0]?.url ?? null) : null;
}

export async function ensureProviderOutputDownloaded(result: any, directory: string, label: string): Promise<string> {
  try {
    return pickDownload(result, directory);
  } catch {
    // fall through to provider URL download
  }

  const url = firstDownloadUrl(result);
  if (!url) {
    throw new Error(
      `No local file or provider download URL for ${label} output in ${directory}. ` +
        `provider_job_id=${JSON.stringify(result?.id ?? null)} status=${JSON.stringify(result?.status ?? null)} ` +
        `error=${JSON.stringify(result?.error ?? null)}`,
    );
  }

  mkdirSync(directory, { recursive: true });
  const filename = path.basename(new URL(url).pathname) || `${label}-output`;
  const downloadPath = path.join(directory, filename);
  let response: Response | null = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (response.ok) break;
      if (!isTransientProviderError({ status: response.status }) || attempt === 4) {
        throw new Error(`Failed to download ${label} output from provider URL: HTTP ${response.status}`);
      }
    } catch (err) {
      if (attempt === 4 || !isTransientProviderError(err)) throw err;
    }
    await sleep(1000 * attempt);
  }
  if (!response || !response.ok) throw new Error(`Failed to download ${label} output from provider URL.`);
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(downloadPath, buffer);

  if (statSync(downloadPath).size <= 0) {
    throw new Error(`Downloaded empty ${label} output: ${downloadPath}`);
  }
  console.info(`Downloaded ${label} output saved as: ${downloadPath}`);
  return downloadPath;
}

export function resetProviderOutputDir(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
}

async function pollProviderImageProject(ctx: ProjectContext, providerJobId: string, label: string): Promise<any> {
  const client = magicHourClient(ctx);
  const intervalMs = videoPollIntervalSeconds() * 1000;
  const timeoutMs = imagePollTimeoutSeconds() * 1000;
  const requestTimeoutMs = magicHourPollRequestTimeoutMs();
  const maxRequestFailures = magicHourPollRequestAttempts();
  const start = Date.now();
  const spanId = `${providerJobId}:${start}`;
  let requestFailures = 0;
  let lastStatus: string | null = null;

  recordTimingEvent(ctx, {
    phase: "start",
    name: "magic_hour.image.poll",
    span_id: spanId,
    provider_job_id: providerJobId,
    metadata: {
      label,
      timeout_seconds: imagePollTimeoutSeconds(),
      poll_interval_seconds: videoPollIntervalSeconds(),
      request_timeout_ms: requestTimeoutMs,
    },
  });

  for (;;) {
    let result: any;
    try {
      result = await withRequestTimeout(
        client.v1.imageProjects.get({ id: providerJobId }),
        requestTimeoutMs,
        `Magic Hour image status request ${providerJobId}`,
      );
      requestFailures = 0;
    } catch (err) {
      requestFailures += 1;
      if (!isTransientProviderError(err) || requestFailures >= maxRequestFailures || Date.now() - start > timeoutMs) {
        recordTimingEvent(ctx, {
          phase: "error",
          name: "magic_hour.image.poll",
          span_id: spanId,
          provider_job_id: providerJobId,
          duration_ms: Date.now() - start,
          metadata: {
            label,
            request_failures: requestFailures,
            last_status: lastStatus,
            error: providerErrorMessage(err),
          },
        });
        throw new Error(
          `Magic Hour image polling stalled for ${label} (${providerJobId}) ` +
            `after ${requestFailures} failed status request(s): ${providerErrorMessage(err)}`,
        );
      }
      recordTimingEvent(ctx, {
        phase: "event",
        name: "magic_hour.image.poll_transient_error",
        provider_job_id: providerJobId,
        metadata: {
          label,
          request_failures: requestFailures,
          max_request_failures: maxRequestFailures,
          error: providerErrorMessage(err),
        },
      });
      console.warn(
        `Transient Magic Hour image status error for ${label} (${providerJobId}); ` +
          `request ${requestFailures}/${maxRequestFailures}: ${providerErrorMessage(err)}`,
      );
      await sleep(Math.min(intervalMs * requestFailures, 8000));
      continue;
    }

    const status = result?.status;
    const currentStatus = status ? String(status) : null;
    if (currentStatus !== lastStatus) {
      lastStatus = currentStatus;
      recordTimingEvent(ctx, {
        phase: "event",
        name: "magic_hour.image.poll_status",
        provider_job_id: providerJobId,
        metadata: { label, status: lastStatus, elapsed_ms: Date.now() - start },
      });
    }
    if (status === "complete") {
      recordTimingEvent(ctx, {
        phase: "end",
        name: "magic_hour.image.poll",
        span_id: spanId,
        provider_job_id: providerJobId,
        duration_ms: Date.now() - start,
        metadata: { label, final_status: lastStatus },
      });
      return result;
    }
    if (status === "error" || status === "canceled") {
      recordTimingEvent(ctx, {
        phase: "error",
        name: "magic_hour.image.poll",
        span_id: spanId,
        provider_job_id: providerJobId,
        duration_ms: Date.now() - start,
        metadata: { label, final_status: lastStatus, error: videoStatusError(result) },
      });
      throw new Error(`Magic Hour image job failed for ${label}: ${videoStatusError(result)}`);
    }
    if (Date.now() - start > timeoutMs) {
      recordTimingEvent(ctx, {
        phase: "error",
        name: "magic_hour.image.poll",
        span_id: spanId,
        provider_job_id: providerJobId,
        duration_ms: Date.now() - start,
        metadata: { label, last_status: lastStatus, error: "poll_timeout" },
      });
      throw new Error(
        `Timed out waiting for Magic Hour image job ${providerJobId} for ${label} ` +
          `after ${Math.round(timeoutMs / 1000)}s. Last status: ${JSON.stringify(lastStatus)}`,
      );
    }
    await sleep(intervalMs);
  }
}

export async function generateImageAsset(
  ctx: ProjectContext,
  scene: Scene,
  referenceImagePaths: string[] = [],
): Promise<ImageAsset> {
  const outDir = path.join(ctx.project_dir, "images", scene.id);
  resetProviderOutputDir(outDir);
  if (referenceImagePaths.length > 0) {
    const submitted: any = await withTiming(ctx, "magic_hour.image_edit.submit", {
      scene_id: scene.id,
      model: ctx.image_model,
      resolution: ctx.image_resolution,
      reference_count: referenceImagePaths.length,
      wait_for_completion: false,
    }, () =>
      providerConcurrency.magicHourSubmit.run(`image-edit:${ctx.project_id}:${scene.id}`, () =>
        magicHourClient(ctx).v1.aiImageEditor.generate(
          {
            assets: { imageFilePaths: referenceImagePaths.map((item) => path.resolve(item)) },
            imageCount: 1,
            style: { prompt: scene.image_prompt },
            aspectRatio: ctx.aspect_ratio as any,
            model: ctx.image_model as any,
            name: `${ctx.project_id}-${scene.id}-reference`,
            resolution: ctx.image_resolution as any,
          },
          {
            waitForCompletion: false,
            downloadOutputs: false,
            downloadDirectory: outDir,
            ...magicHourSubmitOptions(),
          },
        ),
      ),
    );
    const providerJobId = submitted?.id;
    if (!providerJobId) throw new Error(`Magic Hour did not return an image-editor project id for ${scene.id}.`);
    const result =
      submitted?.status === "complete"
        ? submitted
        : await pollProviderImageProject(ctx, String(providerJobId), `${scene.id}-reference`);
    const downloaded = await ensureProviderOutputDownloaded(result, outDir, "image");
    return {
      scene_id: scene.id,
      path: downloaded,
      prompt: scene.image_prompt,
      model: ctx.image_model,
      resolution: ctx.image_resolution,
      style_tool: "ai-image-editor",
      provider_job_id: result?.id ?? providerJobId,
      provider_url: firstDownloadUrl(result),
      reference_media_count: referenceImagePaths.length,
    };
  }
  const created: any = await withTiming(ctx, "magic_hour.image.submit", {
    scene_id: scene.id,
    model: ctx.image_model,
    resolution: ctx.image_resolution,
    wait_for_completion: false,
  }, () =>
    providerConcurrency.magicHourSubmit.run(`image:${ctx.project_id}:${scene.id}`, () =>
      magicHourClient(ctx).v1.aiImageGenerator.create(
        {
          imageCount: 1,
          style: { prompt: scene.image_prompt, tool: ctx.image_style_tool as any },
          aspectRatio: ctx.aspect_ratio as any,
          model: ctx.image_model as any,
          name: `${ctx.project_id}-${scene.id}`,
          resolution: ctx.image_resolution as any,
        },
        magicHourSubmitOptions(),
      ),
    ),
  );
  const providerJobId = created?.id;
  if (!providerJobId) {
    throw new Error(`Magic Hour did not return an image project id for ${scene.id}.`);
  }
  const result = await pollProviderImageProject(ctx, String(providerJobId), scene.id);
  const downloaded = await withTiming(ctx, "provider.download.image", {
    scene_id: scene.id,
    provider_job_id: result?.id ?? providerJobId,
  }, () => ensureProviderOutputDownloaded(result, outDir, "image"));
  return {
    scene_id: scene.id,
    path: downloaded,
    prompt: scene.image_prompt,
    model: ctx.image_model,
    resolution: ctx.image_resolution,
    style_tool: ctx.image_style_tool,
    provider_job_id: result?.id ?? providerJobId,
    provider_url: firstDownloadUrl(result),
  };
}

export async function generateStandaloneImageAssets(
  ctx: ProjectContext,
  prompt: string,
  options: { image_count?: number; name?: string | null } = {},
): Promise<ImageAsset[]> {
  const imageCount = Math.max(1, Math.min(4, Math.trunc(Number(options.image_count ?? 1))));
  const outDir = path.join(ctx.project_dir, "images", "standalone");
  resetProviderOutputDir(outDir);
  const created: any = await withTiming(ctx, "magic_hour.image.submit", {
    image_count: imageCount,
    model: ctx.image_model,
    resolution: ctx.image_resolution,
    wait_for_completion: false,
  }, () =>
    providerConcurrency.magicHourSubmit.run(`image:${ctx.project_id}:standalone`, () =>
      magicHourClient(ctx).v1.aiImageGenerator.create(
        {
          imageCount,
          style: { prompt, tool: ctx.image_style_tool as any },
          aspectRatio: ctx.aspect_ratio as any,
          model: ctx.image_model as any,
          name: options.name || `${ctx.project_id}-image`,
          resolution: ctx.image_resolution as any,
        },
        magicHourSubmitOptions(),
      ),
    ),
  );
  const providerJobId = created?.id;
  if (!providerJobId) {
    throw new Error("Magic Hour did not return an image project id for standalone image generation.");
  }
  const result = await pollProviderImageProject(ctx, String(providerJobId), "standalone-image");
  const downloads = Array.isArray(result?.downloads) ? result.downloads : [];
  const urls = downloads.map((item: any) => item?.url).filter(Boolean);
  const targets = urls.length > 0 ? urls.slice(0, imageCount) : [firstDownloadUrl(result)].filter(Boolean);
  const images: ImageAsset[] = [];
  for (let index = 0; index < targets.length; index += 1) {
    const directory = imageCount === 1 ? outDir : path.join(outDir, `image_${index + 1}`);
    const downloaded = await withTiming(ctx, "provider.download.image", {
      image_index: index + 1,
      provider_job_id: result?.id ?? null,
    }, () =>
      ensureProviderOutputDownloaded(
        { downloads: [{ url: String(targets[index]) }] },
        directory,
        `image-${index + 1}`,
      ),
    );
    images.push({
      scene_id: `image_${index + 1}`,
      path: downloaded,
      prompt,
      model: ctx.image_model,
      resolution: ctx.image_resolution,
      style_tool: ctx.image_style_tool,
      provider_job_id: result?.id ?? null,
      provider_url: String(targets[index]),
      standalone: true,
    });
  }
  if (images.length === 0) {
    throw new Error("Magic Hour image generation completed without a downloadable image URL.");
  }
  return images;
}

export async function generateVideoAsset(ctx: ProjectContext, scene: Scene, image: ImageAsset): Promise<VideoAsset> {
  const job = await submitVideoAssetJob(ctx, scene, image);
  return pollVideoAssetJob(ctx, job);
}

export async function generateImageFallbackVideoAsset(
  ctx: ProjectContext,
  scene: Scene,
  image: ImageAsset,
  reason: string,
  providerJobId: string | null = null,
): Promise<VideoAsset> {
  const outDir = path.join(ctx.project_dir, "videos", scene.id, "fallback");
  resetProviderOutputDir(outDir);
  const output = path.join(outDir, "output.mp4");
  const [width, height] = targetFrameSize(ctx);
  const duration = Math.max(1, Number(scene.duration_seconds) || 1);
  await runFfmpeg(
    [
      "-y",
      "-loop", "1",
      "-t", formatSeconds(duration),
      "-i", path.resolve(image.path),
      "-vf",
      `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=30,format=yuv420p`,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "20",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-an",
      output,
    ],
    `fallback still-video ffmpeg for ${scene.id}`,
  );
  return {
    scene_id: scene.id,
    path: output,
    prompt: scene.video_prompt,
    model: "local-still-fallback",
    resolution: ctx.resolution,
    audio: false,
    duration_seconds: duration,
    provider_job_id: providerJobId,
    provider_url: null,
    provider_status: "fallback",
    fallback_reason: reason,
  };
}

/**
 * Render a talking clip in one shot via Magic Hour's AI Talking Photo.
 *
 * Feeds the scene KEYFRAME IMAGE + scene audio straight into
 * `v1.aiTalkingPhoto.generate`, producing a talking clip with no intermediate
 * silent video. Synced over the full audio span (`startSeconds=0`,
 * `endSeconds=audioDuration`) in `realistic` mode (best likeness, ≤180s).
 * No resolution/maxResolution is sent. The assets are image+audio (NOT the
 * video+audio pair lip-sync uses).
 *
 * `has_embedded_audio: true` is a LABEL: a later step re-muxes the known mp3
 * onto the result, so callers treat the clip as already carrying its audio.
 */
export async function generateTalkingClip(
  ctx: ProjectContext,
  scene: Scene,
  imageFilePath: string,
  audioPath: string,
  audioDuration: number,
): Promise<
  VideoAsset & { has_embedded_audio: boolean; audio_path: string; audio_duration_seconds: number; on_camera: boolean }
> {
  const outDir = path.join(ctx.project_dir, "videos", scene.id, "talking");
  resetProviderOutputDir(outDir);

  const submitted: any = await withTiming(ctx, "magic_hour.talking_photo.submit", {
    scene_id: scene.id,
    audio_duration_seconds: Math.round(audioDuration * 1000) / 1000,
    wait_for_completion: false,
  }, () =>
    providerConcurrency.magicHourSubmit.run(`talking:${ctx.project_id}:${scene.id}`, () =>
      magicHourClient(ctx).v1.aiTalkingPhoto.generate(
        {
          assets: { audioFilePath: path.resolve(audioPath), imageFilePath: path.resolve(imageFilePath) },
          startSeconds: 0,
          endSeconds: audioDuration,
          name: `${ctx.project_id}-${scene.id}-talking`,
          style: { generationMode: "realistic" },
        },
        {
          waitForCompletion: false,
          downloadOutputs: false,
          downloadDirectory: outDir,
          ...magicHourSubmitOptions(),
        },
      ),
    ),
  );
  const providerJobId = submitted?.id;
  if (!providerJobId) {
    throw new Error(`Magic Hour did not return a talking-photo project id for ${scene.id}.`);
  }
  if (submitted?.status === "error" || submitted?.status === "canceled") {
    throw new Error(`Magic Hour rejected talking-photo job for ${scene.id}: ${videoStatusError(submitted)}`);
  }

  let result: any = submitted;
  if (submitted?.status !== "complete") {
    try {
      result = await pollProviderVideoProject(ctx, String(providerJobId), scene.id, {
        kind: "talking-photo",
        timeoutSeconds: talkingPhotoPollTimeoutSeconds(),
      });
    } catch (err) {
      throw attachProviderJobFailureMetadata(new Error(providerErrorMessage(err)), {
        provider_job_id: String(providerJobId),
        provider_kind: "talking-photo",
        provider_stage: "talking",
        provider_submitted_status: submitted?.status ? String(submitted.status) : null,
        provider_model: "ai-talking-photo",
        provider_resolution: ctx.resolution,
        prompt: scene.video_prompt,
        audio: true,
        duration_seconds: Math.round(audioDuration * 1000) / 1000,
        audio_path: path.resolve(audioPath),
        audio_duration_seconds: Math.round(audioDuration * 1000) / 1000,
        on_camera: true,
      });
    }
  }

  const downloaded = await withTiming(ctx, "provider.download.talking_photo", {
    scene_id: scene.id,
    provider_job_id: result?.id ?? providerJobId,
  }, () => ensureProviderOutputDownloaded(result, outDir, "talking"));
  return {
    scene_id: scene.id,
    path: downloaded,
    prompt: scene.video_prompt,
    model: "ai-talking-photo",
    resolution: ctx.resolution,
    audio: true,
    duration_seconds: Math.round(audioDuration * 1000) / 1000,
    provider_job_id: result?.id ?? null,
    provider_url: firstDownloadUrl(result),
    has_embedded_audio: true,
    audio_path: path.resolve(audioPath),
    audio_duration_seconds: Math.round(audioDuration * 1000) / 1000,
    on_camera: true,
  };
}

function videoStatusError(result: any): string {
  return (
    `provider_job_id=${JSON.stringify(result?.id ?? null)} ` +
    `status=${JSON.stringify(result?.status ?? null)} error=${JSON.stringify(result?.error ?? null)}`
  );
}

/** Upload the scene image and submit an image-to-video job without blocking for completion. */
export async function submitVideoAssetJob(ctx: ProjectContext, scene: Scene, image: ImageAsset): Promise<VideoAssetJob> {
  const outDir = path.join(ctx.project_dir, "videos", scene.id);
  resetProviderOutputDir(outDir);
  const useNativeAudio = ctx.video_model === "minimax-h3" && sceneUsesNativeAudio(scene);
  const providerPrompt = useNativeAudio ? nativeAudioVideoPrompt(scene) : scene.video_prompt;
  const result: any = await withTiming(ctx, "magic_hour.i2v.submit", {
    scene_id: scene.id,
    model: ctx.video_model,
    resolution: ctx.resolution,
    duration_seconds: scene.duration_seconds,
    wait_for_completion: false,
  }, () =>
    providerConcurrency.magicHourSubmit.run(`i2v:${ctx.project_id}:${scene.id}`, () =>
      ctx.video_model === "minimax-h3"
        ? submitMinimaxH3ImageToVideo(ctx, scene, image.path)
        : magicHourClient(ctx).v1.imageToVideo.generate(
            {
              assets: { imageFilePath: image.path },
              endSeconds: scene.duration_seconds,
              model: ctx.video_model as any,
              name: `${ctx.project_id}-${scene.id}`,
              resolution: ctx.resolution as any,
              style: { prompt: providerPrompt },
              audio: false,
            },
            {
              waitForCompletion: false,
              downloadOutputs: false,
              downloadDirectory: outDir,
              ...magicHourSubmitOptions(),
            },
          ),
    ),
  );
  const providerJobId = result?.id;
  if (!providerJobId) {
    throw new Error(`Magic Hour did not return a video project id for ${scene.id}.`);
  }
  const status = result?.status;
  if (status === "error" || status === "canceled") {
    throw new Error(`Magic Hour rejected video job for ${scene.id}: ${videoStatusError(result)}`);
  }
  console.info(`Submitted Magic Hour video job ${providerJobId} for scene ${scene.id} with status ${status}`);
  return {
    scene,
    image,
    out_dir: outDir,
    provider_job_id: String(providerJobId),
    prompt: providerPrompt,
    model: ctx.video_model,
    resolution: ctx.resolution,
    audio: useNativeAudio,
    duration_seconds: scene.duration_seconds,
    submitted_status: status ? String(status) : null,
  };
}

async function pollProviderVideoProject(
  ctx: ProjectContext,
  providerJobId: string,
  sceneId: string,
  options: { kind: string; timeoutSeconds: number },
): Promise<any> {
  const client = magicHourClient(ctx);
  const intervalMs = videoPollIntervalSeconds() * 1000;
  const timeoutMs = options.timeoutSeconds * 1000;
  const requestTimeoutMs = magicHourPollRequestTimeoutMs();
  const maxRequestFailures = magicHourPollRequestAttempts();
  const start = Date.now();
  const pollSpanId = `${providerJobId}:${start}`;
  let requestFailures = 0;
  let lastStatus: string | null = null;
  recordTimingEvent(ctx, {
    phase: "start",
    name: `magic_hour.${options.kind}.poll`,
    span_id: pollSpanId,
    scene_id: sceneId,
    provider_job_id: providerJobId,
    provider_kind: options.kind,
    metadata: {
      timeout_seconds: options.timeoutSeconds,
      poll_interval_seconds: videoPollIntervalSeconds(),
      request_timeout_ms: requestTimeoutMs,
    },
  });

  for (;;) {
    let result: any;
    try {
      result = await withRequestTimeout(
        client.v1.videoProjects.get({ id: providerJobId }),
        requestTimeoutMs,
        `Magic Hour ${options.kind} status request ${providerJobId}`,
      );
      requestFailures = 0;
    } catch (err) {
      requestFailures += 1;
      if (!isTransientProviderError(err) || requestFailures >= maxRequestFailures || Date.now() - start > timeoutMs) {
        recordTimingEvent(ctx, {
          phase: "error",
          name: `magic_hour.${options.kind}.poll`,
          span_id: pollSpanId,
          scene_id: sceneId,
          provider_job_id: providerJobId,
          provider_kind: options.kind,
          duration_ms: Date.now() - start,
          metadata: {
            request_failures: requestFailures,
            last_status: lastStatus,
            error: providerErrorMessage(err),
          },
        });
        throw new Error(
          `Magic Hour ${options.kind} polling stalled for ${sceneId} (${providerJobId}) ` +
            `after ${requestFailures} failed status request(s): ${providerErrorMessage(err)}`,
        );
      }
      recordTimingEvent(ctx, {
        phase: "event",
        name: `magic_hour.${options.kind}.poll_transient_error`,
        scene_id: sceneId,
        provider_job_id: providerJobId,
        provider_kind: options.kind,
        metadata: {
          request_failures: requestFailures,
          max_request_failures: maxRequestFailures,
          error: providerErrorMessage(err),
        },
      });
      console.warn(
        `Transient Magic Hour ${options.kind} status error for ${sceneId} (${providerJobId}); ` +
          `request ${requestFailures}/${maxRequestFailures}: ${providerErrorMessage(err)}`,
      );
      await sleep(intervalMs);
      continue;
    }

    const status = result?.status;
    const currentStatus = status ? String(status) : null;
    if (currentStatus !== lastStatus) {
      lastStatus = currentStatus;
      recordTimingEvent(ctx, {
        phase: "event",
        name: `magic_hour.${options.kind}.poll_status`,
        scene_id: sceneId,
        provider_job_id: providerJobId,
        provider_kind: options.kind,
        metadata: { status: lastStatus, elapsed_ms: Date.now() - start },
      });
    }
    if (status === "complete") {
      recordTimingEvent(ctx, {
        phase: "end",
        name: `magic_hour.${options.kind}.poll`,
        span_id: pollSpanId,
        scene_id: sceneId,
        provider_job_id: providerJobId,
        provider_kind: options.kind,
        duration_ms: Date.now() - start,
        metadata: { final_status: lastStatus },
      });
      return result;
    }
    if (status === "error" || status === "canceled") {
      recordTimingEvent(ctx, {
        phase: "error",
        name: `magic_hour.${options.kind}.poll`,
        span_id: pollSpanId,
        scene_id: sceneId,
        provider_job_id: providerJobId,
        provider_kind: options.kind,
        duration_ms: Date.now() - start,
        metadata: { final_status: lastStatus, error: videoStatusError(result) },
      });
      throw new Error(`Magic Hour ${options.kind} job failed for ${sceneId}: ${videoStatusError(result)}`);
    }
    if (Date.now() - start > timeoutMs) {
      recordTimingEvent(ctx, {
        phase: "error",
        name: `magic_hour.${options.kind}.poll`,
        span_id: pollSpanId,
        scene_id: sceneId,
        provider_job_id: providerJobId,
        provider_kind: options.kind,
        duration_ms: Date.now() - start,
        metadata: { last_status: lastStatus, error: "poll_timeout" },
      });
      throw new Error(
        `Timed out waiting for Magic Hour ${options.kind} job ${providerJobId} for ${sceneId} ` +
          `after ${Math.round(timeoutMs / 1000)}s. Last status: ${JSON.stringify(lastStatus)}`,
      );
    }
    await sleep(intervalMs);
  }
}

/** Poll a submitted image-to-video job and download its provider output. */
export async function pollVideoAssetJob(ctx: ProjectContext, job: VideoAssetJob): Promise<VideoAsset> {
  let result: any;
  try {
    result = await pollProviderVideoProject(ctx, job.provider_job_id, job.scene.id, {
      kind: "image-to-video",
      timeoutSeconds: videoPollTimeoutSeconds(),
    });
  } catch (err) {
    throw attachProviderJobFailureMetadata(new Error(providerErrorMessage(err)), {
      provider_job_id: job.provider_job_id,
      provider_kind: "i2v",
      provider_stage: "video_generation",
      provider_submitted_status: job.submitted_status,
      provider_model: job.model,
      provider_resolution: job.resolution,
      prompt: job.prompt,
      audio: job.audio,
      duration_seconds: job.duration_seconds,
    });
  }

  const downloaded = await withTiming(ctx, "provider.download.i2v", {
    scene_id: job.scene.id,
    provider_job_id: job.provider_job_id,
  }, () => ensureProviderOutputDownloaded(result, job.out_dir, "video"));
  const asset: VideoAsset = {
    scene_id: job.scene.id,
    path: downloaded,
    prompt: job.prompt,
    model: job.model,
    resolution: job.resolution,
    audio: job.audio,
    duration_seconds: job.duration_seconds,
    provider_job_id: job.provider_job_id,
    provider_url: firstDownloadUrl(result),
    provider_status: result?.status ?? null,
    audio_source: sceneAudioSource(job.scene),
  };
  if (job.audio) {
    const streams = await probeMediaStreamDurations(downloaded);
    const audioDuration = Number(streams.audio_duration_seconds ?? 0);
    if (!Number.isFinite(audioDuration) || audioDuration <= 0) {
      throw new Error(`MiniMax H3 completed ${job.scene.id} without the requested native audio stream.`);
    }
    asset.has_embedded_audio = true;
    asset.audio_duration_seconds = audioDuration;
  }
  return asset;
}

export async function recoverVideoAssetFromProviderJob(
  ctx: ProjectContext,
  job: RecoverVideoAssetJob,
): Promise<VideoAsset> {
  const isTalking = job.provider_kind === "talking-photo";
  const outDir = isTalking
    ? path.join(ctx.project_dir, "videos", job.scene.id, "talking")
    : path.join(ctx.project_dir, "videos", job.scene.id);
  mkdirSync(outDir, { recursive: true });
  const result = await pollProviderVideoProject(ctx, job.provider_job_id, job.scene.id, {
    kind: `${job.provider_kind}-recovery`,
    timeoutSeconds: providerRecoveryPollTimeoutSeconds(),
  });
  const downloaded = await withTiming(ctx, isTalking ? "provider.download.talking_photo" : "provider.download.i2v", {
    scene_id: job.scene.id,
    provider_job_id: job.provider_job_id,
    recovery: true,
  }, () => ensureProviderOutputDownloaded(result, outDir, isTalking ? "talking" : "video"));
  const duration = Math.round(Number(job.audio_duration_seconds ?? job.duration_seconds ?? job.scene.duration_seconds) * 1000) / 1000;
  const base: VideoAsset = {
    scene_id: job.scene.id,
    path: downloaded,
    prompt: job.prompt ?? job.scene.video_prompt,
    model: job.provider_model ?? (isTalking ? "ai-talking-photo" : ctx.video_model),
    resolution: job.provider_resolution ?? ctx.resolution,
    audio: isTalking || job.audio === true,
    duration_seconds: duration,
    provider_job_id: job.provider_job_id,
    provider_url: firstDownloadUrl(result),
    provider_status: result?.status ?? null,
  };
  if (!isTalking) {
    if (job.audio === true) {
      const streams = await probeMediaStreamDurations(downloaded);
      const audioDuration = Number(streams.audio_duration_seconds ?? 0);
      if (!Number.isFinite(audioDuration) || audioDuration <= 0) {
        throw new Error(`Recovered H3 scene ${job.scene.id} has no native audio stream.`);
      }
      base.has_embedded_audio = true;
      base.audio_duration_seconds = audioDuration;
      base.audio_source = sceneAudioSource(job.scene);
    }
    return base;
  }
  if (!job.audio_path || !(Number(job.audio_duration_seconds) > 0)) {
    throw new Error(`Recovered talking-photo job ${job.provider_job_id} is missing its scene audio metadata.`);
  }
  return {
    ...base,
    has_embedded_audio: true,
    audio_path: path.resolve(job.audio_path),
    audio_duration_seconds: Math.round(Number(job.audio_duration_seconds) * 1000) / 1000,
    on_camera: true,
  };
}

/** Submit all video jobs first, then poll/download all submitted jobs concurrently. */
export async function generateVideoAssetsBatch(
  ctx: ProjectContext,
  sceneImagePairs: Array<[Scene, ImageAsset]>,
): Promise<Array<VideoAsset | Error>> {
  if (sceneImagePairs.length === 0) return [];

  const submitResults = await Promise.allSettled(
    sceneImagePairs.map(([scene, image]) => submitVideoAssetJob(ctx, scene, image)),
  );
  const results: Array<VideoAsset | Error | null> = submitResults.map(() => null);
  const pollIndexes: number[] = [];
  const pollPromises: Promise<VideoAsset>[] = [];

  submitResults.forEach((submitResult, index) => {
    if (submitResult.status === "rejected") {
      results[index] = submitResult.reason instanceof Error ? submitResult.reason : new Error(String(submitResult.reason));
      return;
    }
    pollIndexes.push(index);
    pollPromises.push(pollVideoAssetJob(ctx, submitResult.value));
  });

  if (pollPromises.length > 0) {
    const pollResults = await Promise.allSettled(pollPromises);
    pollResults.forEach((pollResult, pollIndex) => {
      const index = pollIndexes[pollIndex]!;
      results[index] =
        pollResult.status === "fulfilled"
          ? pollResult.value
          : pollResult.reason instanceof Error
            ? pollResult.reason
            : new Error(String(pollResult.reason));
    });
  }

  return results.map((result) => result ?? new Error("Video job did not produce a result."));
}

/**
 * POST text to Fish Audio TTS, write the audio to `output`, return measured duration.
 * Shared by the single-narration voiceover and the per-section voiceover generators.
 */
async function fishAudioTts(
  ctx: ProjectContext,
  text: string,
  output: string,
  referenceId: string = ctx.fish_audio_reference_id,
): Promise<number> {
  const spokenText = text.replace(/\[(?:long\s+)?pause\]/gi, " ").split(/\s+/).filter(Boolean).join(" ");
  const body = msgpackEncode({
    text: spokenText,
    reference_id: referenceId,
    format: ctx.audio_format,
    chunk_length: 200,
    latency: "normal",
    normalize: true,
  });
  mkdirSync(path.dirname(output), { recursive: true });

  // Parallel per-section requests can trip Fish Audio's rate limit; back off
  // and retry 429s instead of failing the whole generation run.
  const response = await withTiming(ctx, "tts.fish.request", {
    chars: spokenText.length,
    model: ctx.audio_model,
  }, async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const nextResponse = await providerConcurrency.fishTts.run(`fish:${ctx.project_id}:${path.basename(output)}`, () =>
        fetch("https://api.fish.audio/v1/tts", {
          method: "POST",
          headers: {
            authorization: `Bearer ${ctx.fish_audio_api_key}`,
            "content-type": "application/msgpack",
            model: ctx.audio_model,
          },
          body: Buffer.from(body.buffer, body.byteOffset, body.byteLength),
          signal: AbortSignal.timeout(180_000),
        }),
      );
      if (nextResponse.status === 429 && attempt < 3) {
        recordTimingEvent(ctx, {
          phase: "event",
          name: "tts.fish.rate_limited",
          metadata: { attempt: attempt + 1, status: nextResponse.status },
        });
        await sleep(2000 * (attempt + 1));
        continue;
      }
      return nextResponse;
    }
    throw new Error("Fish Audio TTS did not return a response.");
  });
  if (!response.ok) {
    throw new Error(`Fish Audio TTS failed with status ${response.status}`);
  }

  const content = Buffer.from(await response.arrayBuffer());
  if (content.length < 1024) {
    throw new Error(
      `Fish Audio returned suspiciously small response (${content.length} bytes). Status: ${response.status}`,
    );
  }
  writeFileSync(output, content);
  const actualDuration = await probeMediaDuration(output);
  if (actualDuration < 0.5) {
    throw new Error(`Fish Audio returned a voiceover with invalid duration ${actualDuration.toFixed(3)}s.`);
  }
  return actualDuration;
}

function humeVoiceSpec(ctx: ProjectContext): Record<string, string> | null {
  const id = ctx.hume_voice_id.trim();
  if (id) return { id };
  const name = ctx.hume_voice_name.trim();
  if (name) return { name, provider: ctx.hume_voice_provider || "HUME_AI" };
  return null;
}

const HUME_ALIGNMENT_DESCRIPTION =
  "Speak only the provided words with clear diction. Start immediately, end cleanly, add no words, and avoid long pauses.";
const HUME_DESCRIPTION_MAX_CHARS = 1000;

function compactHumeDescription(baseDescription: string): string {
  const base = baseDescription.split(/\s+/).filter(Boolean).join(" ").trim() || DEFAULT_HUME_UGC_VOICE_DESCRIPTION;
  const reserved = HUME_ALIGNMENT_DESCRIPTION.length + 1;
  const available = Math.max(0, HUME_DESCRIPTION_MAX_CHARS - reserved);
  const compactBase =
    base.length <= available
      ? base
      : base.slice(0, available).replace(/\s+\S*$/, "").trim() || base.slice(0, available).trim();
  return `${compactBase} ${HUME_ALIGNMENT_DESCRIPTION}`.trim().slice(0, HUME_DESCRIPTION_MAX_CHARS);
}

function humeVoiceDescription(ctx: ProjectContext, performance?: AudioPerformanceSettings | null): string {
  const base = ctx.hume_voice_description.trim() || DEFAULT_HUME_UGC_VOICE_DESCRIPTION;
  const performanceLine = performance?.description ? ` Delivery: ${performance.description}.` : "";
  return compactHumeDescription(`${base}${performanceLine}`);
}

function humeVersion(ctx: ProjectContext, voice: Record<string, string> | null): string | undefined {
  const raw = ctx.audio_model.toLowerCase();
  if (raw.includes("2")) return voice ? "2" : undefined;
  if (raw.includes("1")) return "1";
  return undefined;
}

async function trimProviderEdgeSilence(
  filePath: string,
  label: string,
  options: { preserveTrailingSilence?: boolean } = {},
): Promise<void> {
  const parsed = path.parse(filePath);
  const tmp = path.join(parsed.dir, `${parsed.name}.trimmed${parsed.ext}`);
  try {
    rmSync(tmp, { force: true });
    const originalDuration = await probeMediaDuration(filePath);
    const filter = options.preserveTrailingSilence
      ? "silenceremove=start_periods=1:start_duration=0.03:start_threshold=-50dB"
      : "silenceremove=start_periods=1:start_duration=0.03:start_threshold=-50dB," +
        "areverse,silenceremove=start_periods=1:start_duration=0.08:start_threshold=-50dB,areverse";
    await execa("ffmpeg", [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      filePath,
      "-af",
      filter,
      tmp,
    ]);
    const trimmedDuration = await probeMediaDuration(tmp);
    if (trimmedDuration >= 0.5 && trimmedDuration <= originalDuration + 0.05) {
      renameSync(tmp, filePath);
    } else {
      rmSync(tmp, { force: true });
    }
  } catch (err) {
    rmSync(tmp, { force: true });
    console.warn(`${label} silence trim skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function humeOctaveTts(ctx: ProjectContext, text: string, output: string, options: TtsSynthesisOptions = {}): Promise<number> {
  if (!ctx.hume_api_key) throw new Error("Hume Octave TTS requested without HUME_API_KEY.");
  const voice = humeVoiceSpec(ctx);
  const sourceUtterances =
    options.utterances && options.utterances.length > 0
      ? options.utterances
      : [{ text, performance: options.performance ?? null }];
  const utterances = sourceUtterances.map((source) => {
    const performance = source.performance ?? null;
    const utterance: Record<string, any> = {
      text: performance ? sanitizeTextForAudioPerformance(source.text, performance) : source.text,
      description: humeVoiceDescription(ctx, performance),
      trailing_silence: performance?.trailing_silence ?? 0,
    };
    if (performance) utterance.speed = performance.speed;
    if (voice) utterance.voice = voice;
    return utterance;
  });
  const version = humeVersion(ctx, voice);
  const body: Record<string, any> = {
    utterances,
    format: { type: ctx.audio_format },
    num_generations: 1,
    split_utterances: true,
  };
  const temperature = averagedHumeTemperature(sourceUtterances.map((item) => item.performance).filter(Boolean) as AudioPerformanceSettings[]);
  if (temperature !== null) body.temperature = temperature;
  if (version) body.version = version;

  mkdirSync(path.dirname(output), { recursive: true });
  const response = await withTiming(ctx, "tts.hume.request", {
    chars: utterances.reduce((sum, item) => sum + String(item.text ?? "").length, 0),
    utterance_count: utterances.length,
    model: ctx.audio_model,
    temperature: body.temperature ?? null,
    voice_configured: Boolean(voice),
  }, () =>
    providerConcurrency.humeTts.run(`hume:${ctx.project_id}:${path.basename(output)}`, () =>
      fetch("https://api.hume.ai/v0/tts", {
        method: "POST",
        headers: {
          "X-Hume-Api-Key": ctx.hume_api_key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      }),
    ),
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Hume Octave TTS failed with status ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
  }
  const payload = (await response.json()) as any;
  const generation = payload?.generations?.[0];
  const audio = generation?.audio;
  if (typeof audio !== "string" || audio.length < 16) {
    throw new Error("Hume Octave returned no audio payload.");
  }
  const content = Buffer.from(audio, "base64");
  if (content.length < 1024) {
    throw new Error(`Hume Octave returned suspiciously small response (${content.length} bytes).`);
  }
  writeFileSync(output, content);
  const preserveTrailingSilence = (sourceUtterances[sourceUtterances.length - 1]?.performance?.trailing_silence ?? 0) > 0;
  await trimProviderEdgeSilence(output, "Hume Octave", { preserveTrailingSilence });
  const actualDuration = await probeMediaDuration(output);
  if (actualDuration < 0.5) {
    throw new Error(`Hume Octave returned a voiceover with invalid duration ${actualDuration.toFixed(3)}s.`);
  }
  return actualDuration;
}

const ELEVENLABS_VOICE_CACHE = new Map<string, string>();
const ELEVENLABS_PRESET_VOICE_IDS: Record<string, string> = {
  adam: "pNInz6obpgDQGcFmaJgB",
  brian: "nPczCjzI2devNBz1zQrb",
  rachel: "21m00Tcm4TlvDq8ikWAM",
};

function normalizedVoiceSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function elevenLabsVoiceSettings(performance?: AudioPerformanceSettings | null): Record<string, number | boolean> {
  const speed = Math.max(0.75, Math.min(1.2, performance?.speed ?? 1));
  const temperature = performance?.temperature ?? 0.78;
  const energetic = temperature >= 0.82;
  return {
    stability: energetic ? 0.38 : 0.48,
    similarity_boost: 0.82,
    style: Math.max(0.18, Math.min(0.55, (temperature - 0.62) * 1.25)),
    use_speaker_boost: true,
    speed,
  };
}

function isTransientElevenLabsTransportError(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  const cause = (error as TypeError & { cause?: { code?: string; message?: string } }).cause;
  return /fetch failed|network|socket|econn|terminated/i.test(
    `${error.message} ${cause?.code ?? ""} ${cause?.message ?? ""}`,
  );
}

async function fetchElevenLabsWithTransportRetry(
  ctx: ProjectContext,
  label: string,
  url: string | URL,
  request: () => RequestInit,
): Promise<Response> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await fetch(url, request());
    } catch (error) {
      if (attempt === 2 || !isTransientElevenLabsTransportError(error)) throw error;
      recordTimingEvent(ctx, {
        phase: "event",
        name: "tts.elevenlabs.transport_retry",
        metadata: { label, attempt, error: error instanceof Error ? error.message : String(error) },
      });
      await sleep(750);
    }
  }
  throw new Error("ElevenLabs transport retry exhausted.");
}

async function resolveElevenLabsVoiceId(ctx: ProjectContext): Promise<string> {
  const explicit = ctx.elevenlabs_voice_id.trim();
  if (explicit) return explicit;
  const requestedName = (ctx.elevenlabs_voice_name || DEFAULT_ELEVENLABS_VOICE_NAME).trim();
  const presetId = ELEVENLABS_PRESET_VOICE_IDS[normalizedVoiceSearchText(requestedName)];
  if (presetId) return presetId;
  const cacheKey = `${ctx.elevenlabs_api_key.slice(0, 8)}:${requestedName.toLowerCase()}`;
  const cached = ELEVENLABS_VOICE_CACHE.get(cacheKey);
  if (cached) return cached;

  const searchUrl = new URL("https://api.elevenlabs.io/v2/voices");
  searchUrl.searchParams.set("search", requestedName);
  searchUrl.searchParams.set("page_size", "100");
  const response = await providerConcurrency.elevenLabsTts.run(`elevenlabs:voices:${ctx.project_id}`, () =>
    fetchElevenLabsWithTransportRetry(ctx, "voice_lookup", searchUrl, () => ({
      method: "GET",
      headers: { "xi-api-key": ctx.elevenlabs_api_key },
      signal: AbortSignal.timeout(60_000),
    })),
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`ElevenLabs voice lookup failed with status ${response.status}${detail ? `: ${detail.slice(0, 240)}` : ""}`);
  }
  const payload = (await response.json()) as any;
  const voices = Array.isArray(payload?.voices) ? payload.voices : [];
  const target = normalizedVoiceSearchText(requestedName);
  const targetTokens = target.split(/\s+/).filter(Boolean);
  const scored = voices
    .map((voice: any) => {
      const name = String(voice?.name ?? "");
      const voiceId = String(voice?.voice_id ?? "");
      const labels = voice?.labels && typeof voice.labels === "object" ? Object.values(voice.labels).join(" ") : "";
      const description = String(voice?.description ?? "");
      const searchable = normalizedVoiceSearchText([name, labels, description].join(" "));
      const exact = normalizedVoiceSearchText(name) === target ? 100 : 0;
      const tokenScore = targetTokens.reduce((sum, token) => sum + (searchable.includes(token) ? 1 : 0), 0);
      return { voiceId, name, score: exact + tokenScore };
    })
    .filter((item: { voiceId: string; score: number }) => item.voiceId && item.score > 0)
    .sort((a: { score: number }, b: { score: number }) => b.score - a.score);
  const match = scored[0];
  if (!match?.voiceId) {
    throw new Error(`ElevenLabs voice "${requestedName}" was not found in the configured account. Set ELEVENLABS_VOICE_ID to use a specific voice.`);
  }
  ELEVENLABS_VOICE_CACHE.set(cacheKey, match.voiceId);
  recordTimingEvent(ctx, {
    phase: "event",
    name: "tts.elevenlabs.voice_resolved",
    metadata: { requested: requestedName, matched_name: match.name },
  });
  return match.voiceId;
}

function validElevenLabsAlignment(value: any): value is ElevenLabsAlignment {
  const size = Array.isArray(value?.characters) ? value.characters.length : 0;
  return (
    size > 0 &&
    Array.isArray(value.character_start_times_seconds) &&
    Array.isArray(value.character_end_times_seconds) &&
    value.character_start_times_seconds.length === size &&
    value.character_end_times_seconds.length === size &&
    value.character_start_times_seconds.every((item: unknown) => Number.isFinite(Number(item))) &&
    value.character_end_times_seconds.every((item: unknown) => Number.isFinite(Number(item)))
  );
}

function elevenLabsAlignmentPath(output: string): string {
  return `${output}.alignment.json`;
}

async function trimElevenLabsAudioToAlignment(
  output: string,
  alignment: ElevenLabsAlignment,
): Promise<ElevenLabsAlignment> {
  const first = alignment.characters.findIndex((character) => character.trim());
  let last = alignment.characters.length - 1;
  while (last >= 0 && !alignment.characters[last]!.trim()) last -= 1;
  if (first < 0 || last < first) return alignment;

  const originalDuration = await probeMediaDuration(output);
  const trimStart = Math.max(0, Number(alignment.character_start_times_seconds[first]) - 0.02);
  const trimEnd = Math.min(originalDuration, Number(alignment.character_end_times_seconds[last]) + 0.08);
  if (!(trimEnd > trimStart + 0.5)) return alignment;

  const parsed = path.parse(output);
  const trimmed = path.join(parsed.dir, `${parsed.name}.aligned${parsed.ext}`);
  rmSync(trimmed, { force: true });
  await runFfmpeg(
    [
      "-y",
      "-i", output,
      "-af", `atrim=start=${formatSeconds(trimStart)}:end=${formatSeconds(trimEnd)},asetpts=PTS-STARTPTS`,
      trimmed,
    ],
    "ElevenLabs alignment edge trim",
  );
  renameSync(trimmed, output);
  return {
    characters: alignment.characters,
    character_start_times_seconds: alignment.character_start_times_seconds.map((time) =>
      Math.max(0, Number(time) - trimStart),
    ),
    character_end_times_seconds: alignment.character_end_times_seconds.map((time) =>
      Math.max(0, Number(time) - trimStart),
    ),
  };
}

async function elevenLabsTts(ctx: ProjectContext, text: string, output: string, options: TtsSynthesisOptions = {}): Promise<number> {
  if (!ctx.elevenlabs_api_key) throw new Error("ElevenLabs TTS requested without ELEVENLABS_API_KEY.");
  const spokenText = text.replace(/\[(?:long\s+)?pause\]/gi, " ").split(/\s+/).filter(Boolean).join(" ");
  const voiceId = await resolveElevenLabsVoiceId(ctx);
  const body = {
    text: spokenText,
    model_id: ctx.audio_model || DEFAULT_ELEVENLABS_AUDIO_MODEL,
    voice_settings: elevenLabsVoiceSettings(options.performance),
    seed: 1107,
  };
  mkdirSync(path.dirname(output), { recursive: true });
  const response = await withTiming(ctx, "tts.elevenlabs.request", {
    chars: spokenText.length,
    model: body.model_id,
    voice_configured: Boolean(ctx.elevenlabs_voice_id || ctx.elevenlabs_voice_name),
  }, () =>
    providerConcurrency.elevenLabsTts.run(`elevenlabs:${ctx.project_id}:${path.basename(output)}`, () =>
      fetchElevenLabsWithTransportRetry(
        ctx,
        "text_to_speech",
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=mp3_44100_128`,
        () => ({
        method: "POST",
        headers: {
          "xi-api-key": ctx.elevenlabs_api_key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
        }),
      ),
    ),
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`ElevenLabs TTS failed with status ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  let alignment: ElevenLabsAlignment | null = null;
  let content: Buffer;
  if (/json/i.test(contentType)) {
    const payload = (await response.json()) as any;
    content = Buffer.from(String(payload?.audio_base64 ?? ""), "base64");
    alignment = validElevenLabsAlignment(payload?.alignment) ? payload.alignment : null;
  } else {
    // Keep compatibility with proxies and test doubles that return raw audio.
    content = Buffer.from(await response.arrayBuffer());
  }
  if (content.length < 1024) {
    throw new Error(`ElevenLabs returned suspiciously small response (${content.length} bytes).`);
  }
  writeFileSync(output, content);
  if (alignment) {
    alignment = await trimElevenLabsAudioToAlignment(output, alignment);
    writeFileSync(elevenLabsAlignmentPath(output), JSON.stringify(alignment), "utf-8");
  } else {
    rmSync(elevenLabsAlignmentPath(output), { force: true });
    await trimProviderEdgeSilence(output, "ElevenLabs");
  }
  const actualDuration = await probeMediaDuration(output);
  if (actualDuration < 0.5) {
    throw new Error(`ElevenLabs returned a voiceover with invalid duration ${actualDuration.toFixed(3)}s.`);
  }
  return actualDuration;
}

async function synthesizeTts(
  ctx: ProjectContext,
  text: string,
  output: string,
  referenceId?: string,
  options: TtsSynthesisOptions = {},
): Promise<number> {
  if (ctx.audio_provider === "elevenlabs") {
    return elevenLabsTts(ctx, text, output, options);
  }
  if (ctx.audio_provider === "hume") {
    try {
      return await humeOctaveTts(ctx, text, output, options);
    } catch (err) {
      if (options.allowProviderFallback === false) throw err;
      const message = err instanceof Error ? err.message : String(err);
      const fishReferenceId = referenceId || ctx.fish_audio_reference_id;
      const canFallbackToFish =
        Boolean(ctx.fish_audio_api_key && fishReferenceId) &&
        /\b(zero_credits|exhausted credit|status 402|status 429|status 5\d\d|timeout|temporar(?:y|ily))\b/i.test(message);
      if (!canFallbackToFish) throw err;
      recordTimingEvent(ctx, {
        phase: "event",
        name: "tts.hume.fallback_to_fish",
        metadata: { reason: message.slice(0, 240), fish_model: "s2.1-pro" },
      });
      const fishCtx: ProjectContext = { ...ctx, audio_provider: "fish", audio_model: "s2.1-pro" };
      return fishAudioTts(fishCtx, text, output, fishReferenceId);
    }
  }
  return fishAudioTts(ctx, text, output, referenceId);
}

/** Generate a voiceover audio file from narration text via the selected TTS provider. */
export async function generateVoiceoverAsset(
  ctx: ProjectContext,
  narration: string,
  durationSeconds: number,
  referenceId?: string,
  plan?: VideoPlan,
): Promise<VoiceoverAsset> {
  const output = path.join(ctx.project_dir, "voiceover", `voiceover.${ctx.audio_format}`);
  console.info(
    `Generating voiceover - provider=${ctx.audio_provider}, narration length ${narration.length} chars, ` +
      `model=${ctx.audio_model}`,
  );
  const ttsNarration =
    plan && (ctx.audio_provider === "hume" || ctx.audio_provider === "elevenlabs")
      ? plan.scenes
          .map((scene) => String(scene.narration ?? "").replace(/^\s*(?:\[[^\]]+\]\s*)+/, "").trim())
          .filter(Boolean)
          .join("\n\n") || narration
      : narration;
  const calibratedGlobalPerformance =
    plan && (ctx.audio_provider === "hume" || ctx.audio_provider === "elevenlabs")
      ? audioPerformanceSequenceForPlan(plan.scenes, plan, {
          targetSpeechSeconds: durationSeconds * 0.97,
          wordsPerSecond: estimateTtsWordsPerSecondForContext(ctx, plan.voice),
        })[0] ?? stableAudioPerformanceForPlan(plan)
      : null;
  const globalPerformance = calibratedGlobalPerformance
    ? { ...calibratedGlobalPerformance, trailing_silence: 0 }
    : null;
  await withTiming(ctx, "voiceover.global_synthesize", {
    provider: ctx.audio_provider,
    model: ctx.audio_model,
    chars: ttsNarration.length,
    target_duration_seconds: durationSeconds,
    scene_utterance_count: 0,
  }, () =>
    synthesizeTts(ctx, ttsNarration, output, referenceId, {
      performance: globalPerformance ?? undefined,
    }),
  );
  const originalDuration = await probeMediaDuration(output);
  const actualDuration = await conformVoiceoverToTarget(ctx, output, durationSeconds);
  const alignmentPath = elevenLabsAlignmentPath(output);
  const alignment =
    ctx.audio_provider === "elevenlabs" && existsSync(alignmentPath)
      ? JSON.parse(readFileSync(alignmentPath, "utf-8")) as ElevenLabsAlignment
      : null;
  const sceneTimings =
    plan && alignment && validElevenLabsAlignment(alignment)
      ? voiceoverSceneTimings(plan, alignment, originalDuration, actualDuration)
      : [];
  console.info(`Voiceover saved: ${output} (${actualDuration.toFixed(2)}s)`);
  return {
    path: output,
    provider: ctx.audio_provider,
    model: ctx.audio_model,
    duration_seconds: Math.round(actualDuration * 1000) / 1000,
    target_duration_seconds: durationSeconds,
    ...(sceneTimings.length === plan?.scenes.length ? { scene_timings: sceneTimings } : {}),
    speech_end_margin_seconds: Math.max(0, Math.round((durationSeconds - actualDuration) * 1000) / 1000),
    ...(globalPerformance
      ? {
          audio_performance: {
            modes: [globalPerformance.audio_mode],
            temperature: averagedHumeTemperature([globalPerformance]),
            speed: globalPerformance.speed,
            global_single_utterance: true,
          },
        }
      : {}),
  };
}

function normalizedElevenLabsText(value: string): string {
  return value.replace(/\[(?:long\s+)?pause\]/gi, " ").split(/\s+/).filter(Boolean).join(" ");
}

function voiceoverSceneTimings(
  plan: VideoPlan,
  alignment: ElevenLabsAlignment,
  originalDuration: number,
  finalDuration: number,
): VoiceoverSceneTiming[] {
  const alignedText = alignment.characters.join("");
  const scale = originalDuration > 0 ? finalDuration / originalDuration : 1;
  const result: VoiceoverSceneTiming[] = [];
  let cursor = 0;
  for (const scene of plan.scenes) {
    const spoken = normalizedElevenLabsText(scene.narration);
    if (!spoken) continue;
    const startIndex = alignedText.indexOf(spoken, cursor);
    if (startIndex < 0) return [];
    const endIndex = startIndex + spoken.length - 1;
    result.push({
      scene_id: scene.id,
      start_seconds: Math.round(Number(alignment.character_start_times_seconds[startIndex]) * scale * 1000) / 1000,
      end_seconds: Math.round(Number(alignment.character_end_times_seconds[endIndex]) * scale * 1000) / 1000,
    });
    cursor = endIndex + 1;
  }
  return result;
}

/**
 * Generate one voiceover per section, concurrently.
 *
 * Per-section audio is the source of truth for video alignment: each scene's
 * video length is later set to its measured audio duration, so a dropped or
 * mis-estimated section can never shift the alignment of the others.
 */
export async function generateSectionVoiceovers(
  ctx: ProjectContext,
  sections: YouTubeClipSection[],
): Promise<SectionVoiceover[]> {
  const voiceoverDir = path.join(ctx.project_dir, "voiceover", "sections");
  resetProviderOutputDir(voiceoverDir);

  return Promise.all(
    sections.map(async (section) => {
      const sectionNum = Math.trunc(section.section);
      const text = String(section.dialogue ?? "").trim();
      if (!text) {
        throw new Error(`No dialogue for section ${sectionNum}; cannot generate voiceover.`);
      }
      const output = path.join(voiceoverDir, `section_${sectionNum}.${ctx.audio_format}`);
      const duration = await withTiming(ctx, "voiceover.section_synthesize", {
        section: sectionNum,
        scene_id: `scene_${sectionNum}`,
        provider: ctx.audio_provider,
        model: ctx.audio_model,
        chars: text.length,
      }, () => synthesizeTts(ctx, text, output));
      return {
        section: sectionNum,
        scene_id: `scene_${sectionNum}`,
        path: path.resolve(output),
        provider: ctx.audio_provider,
        model: ctx.audio_model,
        duration_seconds: Math.round(duration * 1000) / 1000,
      };
    }),
  );
}

/**
 * Generate one voiceover per scene, keyed by the scene's real id.
 *
 * Unlike {@link generateSectionVoiceovers} (which synthesizes a `scene_<N>`
 * key from the section number), this keys each file by `scene.id` so a talking
 * scene's clip can later be lip-synced to its own line. Reuses the single
 * global voice style via {@link synthesizeTts}.
 */
export async function generateSceneVoiceovers(
  ctx: ProjectContext,
  scenes: Scene[],
  referenceId?: string,
  plan?: VideoPlan,
): Promise<SceneVoiceover[]> {
  const dir = path.join(ctx.project_dir, "voiceover", "scenes");
  mkdirSync(dir, { recursive: true });
  const synthesizeBatch = async (
    audioCtx: ProjectContext,
    batchReferenceId: string | undefined,
    allowProviderFallback: boolean,
  ): Promise<SceneVoiceover[]> => {
    const planSequence =
      plan && (audioCtx.audio_provider === "hume" || audioCtx.audio_provider === "elevenlabs")
        ? audioPerformanceSequenceForPlan(plan.scenes, plan, {
            targetSpeechSeconds: plan.scenes.reduce((sum, scene) => sum + scene.duration_seconds, 0) * 0.97,
            wordsPerSecond: estimateTtsWordsPerSecondForContext(audioCtx, plan.voice),
          })
        : [];
    const sequenceBySceneId =
      plan && (audioCtx.audio_provider === "hume" || audioCtx.audio_provider === "elevenlabs")
        ? new Map(plan.scenes.map((scene, index) => [scene.id, planSequence[index]]))
        : new Map<string, AudioPerformanceSettings | undefined>();
    const fallbackSequence =
      !plan && (audioCtx.audio_provider === "hume" || audioCtx.audio_provider === "elevenlabs")
        ? audioPerformanceSequenceForPlan(scenes, null)
        : [];
    const settled = await Promise.allSettled(
      scenes.map(async (scene, index) => {
        const text = String(scene.narration ?? "").trim();
        if (!text) {
          throw new Error(`No narration for scene ${scene.id}; cannot generate scene voiceover.`);
        }
        const output = path.join(dir, `${scene.id}.${ctx.audio_format}`);
        const performance =
          audioCtx.audio_provider === "hume" || audioCtx.audio_provider === "elevenlabs"
            ? (sequenceBySceneId.get(scene.id) ?? fallbackSequence[index] ?? audioPerformanceForGeneration(scene, plan))
            : null;
        const duration = await withTiming(ctx, "voiceover.scene_synthesize", {
          scene_id: scene.id,
          provider: audioCtx.audio_provider,
          model: audioCtx.audio_model,
          chars: text.length,
          audio_mode: performance?.audio_mode ?? null,
        }, () => synthesizeTts(audioCtx, text, output, batchReferenceId, { performance, allowProviderFallback }));
        return {
          scene_id: scene.id,
          path: path.resolve(output),
          provider: audioCtx.audio_provider,
          model: audioCtx.audio_model,
          duration_seconds: Math.round(duration * 1000) / 1000,
          ...(performance
            ? {
                audio_mode: performance.audio_mode,
                audio_note: performance.audio_note,
                emotion_context: performance.emotion_context,
                tts_speed: performance.speed,
                tts_temperature: performance.temperature,
                trailing_silence: performance.trailing_silence,
              }
            : {}),
        };
      }),
    );
    const rejected = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
    if (rejected) throw rejected.reason;
    return settled.map((item) => (item as PromiseFulfilledResult<SceneVoiceover>).value);
  };

  const fishReferenceId = referenceId || ctx.fish_audio_reference_id;
  if (ctx.audio_provider === "hume" && ctx.fish_audio_api_key && fishReferenceId) {
    try {
      return await synthesizeBatch(ctx, referenceId, false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const canFallbackToFish =
        /\b(zero_credits|exhausted credit|status 402|status 429|status 5\d\d|timeout|temporar(?:y|ily))\b/i.test(message);
      if (!canFallbackToFish) throw err;
      for (const scene of scenes) {
        rmSync(path.join(dir, `${scene.id}.${ctx.audio_format}`), { force: true });
      }
      recordTimingEvent(ctx, {
        phase: "event",
        name: "tts.hume.batch_fallback_to_fish",
        metadata: { reason: message.slice(0, 240), scene_count: scenes.length, fish_model: "s2.1-pro" },
      });
      return synthesizeBatch({ ...ctx, audio_provider: "fish", audio_model: "s2.1-pro" }, fishReferenceId, true);
    }
  }

  return synthesizeBatch(ctx, referenceId, true);
}

/**
 * Concatenate per-section voiceover audio into one file. Preserves the
 * single-voiceover manifest contract (path + duration) while the per-section
 * files remain the source of truth for video alignment.
 */
export async function combineSectionVoiceovers(
  ctx: ProjectContext,
  sectionVoiceovers: SectionVoiceover[],
): Promise<VoiceoverAsset> {
  if (sectionVoiceovers.length === 0) throw new Error("No section voiceovers to combine");
  const output = path.join(ctx.project_dir, "voiceover", `voiceover.${ctx.audio_format}`);
  mkdirSync(path.dirname(output), { recursive: true });
  const paths = sectionVoiceovers.map((item) => item.path);

  if (paths.length === 1) {
    copyFileSync(paths[0]!, output);
  } else {
    const concatList = path.join(path.dirname(output), "voiceover_concat.txt");
    writeFileSync(concatList, paths.map((p) => `file '${path.resolve(p)}'\n`).join(""), "utf-8");
    try {
      await runFfmpeg(
        ["-y", "-f", "concat", "-safe", "0", "-i", path.resolve(concatList), "-c", "copy", output],
        "combine section voiceovers ffmpeg",
      );
    } finally {
      try {
        unlinkSync(concatList);
      } catch {
        // best-effort cleanup
      }
    }
  }

  const duration = await probeMediaDuration(output);
  return {
    path: output,
    provider: ctx.audio_provider,
    model: ctx.audio_model,
    duration_seconds: Math.round(duration * 1000) / 1000,
    target_duration_seconds:
      Math.round(sectionVoiceovers.reduce((sum, item) => sum + item.duration_seconds, 0) * 1000) / 1000,
    sections: sectionVoiceovers,
  };
}

async function runFfmpeg(args: string[], label: string): Promise<void> {
  const result = await execa("ffmpeg", args, { reject: false });
  if (result.exitCode !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || "no command output";
    throw new Error(`${label} failed:\n${detail}`);
  }
}

export async function probeMediaDuration(filePath: string): Promise<number> {
  const result = await execa(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath],
    { reject: false },
  );
  if (result.exitCode !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || "no command output";
    throw new Error(`ffprobe duration failed for ${filePath}:\n${detail}`);
  }
  const duration = Number.parseFloat(result.stdout.trim());
  if (!(duration > 0)) {
    throw new Error(`Media has invalid duration ${duration}: ${filePath}`);
  }
  return duration;
}

export interface MediaStreamDurations {
  format_duration_seconds: number;
  video_duration_seconds: number | null;
  audio_duration_seconds: number | null;
}

export async function probeMediaStreamDurations(filePath: string): Promise<MediaStreamDurations> {
  const result = await execa(
    "ffprobe",
    [
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_type,duration",
      "-of", "json",
      filePath,
    ],
    { reject: false },
  );
  if (result.exitCode !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || "no command output";
    throw new Error(`ffprobe stream duration failed for ${filePath}:\n${detail}`);
  }
  const payload = JSON.parse(result.stdout);
  const streamDuration = (kind: string) => {
    const stream = (payload.streams ?? []).find((item: any) => item.codec_type === kind && Number(item.duration) > 0);
    return stream ? Number(stream.duration) : null;
  };
  return {
    format_duration_seconds: Number(payload.format?.duration ?? 0),
    video_duration_seconds: streamDuration("video"),
    audio_duration_seconds: streamDuration("audio"),
  };
}

const MAX_AUDIO_OVERRUN_EXTENSION_SECONDS = 2.0;
const AUDIO_DURATION_CODEC_TOLERANCE_SECONDS = 0.25;
const MAX_VOICEOVER_CONFORM_SPEEDUP_RATIO = 1.06;
const NATURAL_SPEECH_END_MARGIN_SECONDS = 0.3;
const MAX_UNCONFORMED_AUDIO_TAIL_SECONDS = 0.04;
const FINAL_TARGET_OVERRUN_RATIO = 0.08;
const FINAL_TARGET_OVERRUN_SECONDS = 3.0;

const formatSeconds = (seconds: number) => seconds.toFixed(3);

export async function conformVoiceoverToTarget(
  ctx: ProjectContext,
  filePath: string,
  targetDurationSeconds: number,
): Promise<number> {
  const actualDuration = await probeMediaDuration(filePath);
  const requestedDuration = Number(targetDurationSeconds);
  const targetDuration =
    Number.isFinite(requestedDuration) && requestedDuration > 1
      ? requestedDuration - Math.min(NATURAL_SPEECH_END_MARGIN_SECONDS, requestedDuration * 0.01)
      : requestedDuration;
  if (
    !Number.isFinite(targetDuration) ||
    targetDuration <= 0 ||
    actualDuration <= targetDuration
  ) {
    return actualDuration;
  }

  const speedupRatio = actualDuration / targetDuration;
  if (
    speedupRatio > MAX_VOICEOVER_CONFORM_SPEEDUP_RATIO ||
    actualDuration - targetDuration > MAX_AUDIO_OVERRUN_EXTENSION_SECONDS
  ) {
    return actualDuration;
  }

  const parsed = path.parse(filePath);
  const conformed = path.join(parsed.dir, `${parsed.name}.conformed${parsed.ext}`);
  rmSync(conformed, { force: true });
  await runFfmpeg(
    [
      "-y",
      "-i", path.resolve(filePath),
      "-map", "0:a:0",
      "-af",
      `atempo=${speedupRatio.toFixed(6)},atrim=duration=${formatSeconds(targetDuration)},asetpts=PTS-STARTPTS`,
      conformed,
    ],
    "voiceover target-duration conform",
  );
  const conformedDuration = await probeMediaDuration(conformed);
  if (Math.abs(conformedDuration - targetDuration) > AUDIO_DURATION_CODEC_TOLERANCE_SECONDS) {
    rmSync(conformed, { force: true });
    throw new Error(
      `Voiceover duration conform produced ${conformedDuration.toFixed(3)}s for a ` +
        `${targetDuration.toFixed(3)}s target.`,
    );
  }
  renameSync(conformed, filePath);
  recordTimingEvent(ctx, {
    phase: "event",
    name: "voiceover.duration_conformed",
    metadata: {
      original_duration_seconds: Number(actualDuration.toFixed(3)),
      target_duration_seconds: Number(targetDuration.toFixed(3)),
      final_duration_seconds: Number(conformedDuration.toFixed(3)),
      speedup_ratio: Number(speedupRatio.toFixed(4)),
    },
  });
  return conformedDuration;
}

export function plannedFinalDurationSeconds(videos: Array<Record<string, any>>): number | null {
  const requested: number[] = [];
  for (const video of videos) {
    const duration = Number(video.duration_seconds);
    if (!Number.isFinite(duration) || duration <= 0) return null;
    requested.push(duration);
  }
  if (requested.length === 0) return null;
  return Math.max(0.1, requested.reduce((a, b) => a + b, 0));
}

const even = (value: number) => (value % 2 === 0 ? value : value + 1);

export function targetFrameSize(ctx: ProjectContext): [number, number] {
  const base = Number.parseInt(String(ctx.resolution || "720p").replace(/p$/, ""), 10) || 720;
  if (ctx.aspect_ratio === "9:16") return [even(base), even(Math.round((base * 16) / 9))];
  if (ctx.aspect_ratio === "1:1") return [even(base), even(base)];
  return [even(Math.round((base * 16) / 9)), even(base)];
}

export async function normalizeSceneVideoForStitch(
  ctx: ProjectContext,
  source: string,
  output: string,
  options: { source_start?: number | null; source_end?: number | null; target_duration_seconds?: number | null } = {},
): Promise<string> {
  const [width, height] = targetFrameSize(ctx);
  const sourceStart = Number(options.source_start ?? 0);
  const sourceEnd = Number(options.source_end ?? 0);
  const targetDuration = Number(options.target_duration_seconds ?? 0);
  const trimDuration =
    Number.isFinite(sourceStart) && Number.isFinite(sourceEnd) && sourceEnd > sourceStart
      ? sourceEnd - Math.max(0, sourceStart)
      : null;
  const timingFilter =
    Number.isFinite(targetDuration) && targetDuration > 0
      ? `,tpad=stop_mode=clone:stop_duration=${formatSeconds(targetDuration)},` +
        `trim=duration=${formatSeconds(targetDuration)},setpts=PTS-STARTPTS`
      : ",setpts=PTS-STARTPTS";
  mkdirSync(path.dirname(output), { recursive: true });
  await runFfmpeg(
    [
      "-y",
      ...(Number.isFinite(sourceStart) && sourceStart > 0 ? ["-ss", formatSeconds(sourceStart)] : []),
      "-i", path.resolve(source),
      ...(trimDuration !== null ? ["-t", formatSeconds(trimDuration)] : []),
      "-vf",
      `scale=${width}:${height}:force_original_aspect_ratio=increase,` +
        `crop=${width}:${height},` +
        `fps=30,settb=AVTB${timingFilter},format=yuv420p`,
      "-c:v", "libx264", "-preset", "fast",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-an",
      output,
    ],
    "normalize scene video for stitch",
  );
  await probeMediaDuration(output);
  return output;
}

/**
 * Stitch scene videos with hard cuts, then overlay voiceover.
 */
export async function stitchAssets(
  ctx: ProjectContext,
  videos: Array<Record<string, any>>,
  voiceover: Record<string, any>,
  options: { target_duration_seconds?: number | null } = {},
): Promise<string> {
  const final = path.join(ctx.project_dir, "final.mp4");
  const n = videos.length;
  let plannedDuration = plannedFinalDurationSeconds(videos);

  if (n === 0) throw new Error("No videos to stitch");

  const normalizedDir = path.join(ctx.project_dir, "normalized");
  resetProviderOutputDir(normalizedDir);
  const normalizedPaths: string[] = [];
  for (let index = 0; index < videos.length; index++) {
    normalizedPaths.push(
      await normalizeSceneVideoForStitch(
        ctx,
        videos[index]!.path,
        path.join(normalizedDir, `scene_${String(index + 1).padStart(2, "0")}.mp4`),
      ),
    );
  }

  // --- Step 1: Hard-cut scene videos into one clip ---
  const merged = path.join(ctx.project_dir, "merged.mp4");

  if (n === 1) {
    copyFileSync(normalizedPaths[0]!, merged);
  } else {
    const concatList = path.join(ctx.project_dir, "merged_concat.txt");
    writeFileSync(concatList, normalizedPaths.map((p) => `file '${path.resolve(p)}'\n`).join(""), "utf-8");
    try {
      await runFfmpeg(
        [
          "-y",
          "-f", "concat", "-safe", "0",
          "-i", path.resolve(concatList),
          "-c:v", "libx264", "-preset", "fast",
          "-crf", "18",
          "-pix_fmt", "yuv420p",
          "-r", "30",
          "-an",
          "-movflags", "+faststart",
          merged,
        ],
        "hard-cut ffmpeg stitch",
      );
    } finally {
      try {
        unlinkSync(concatList);
      } catch {
        // best-effort cleanup
      }
    }
  }

  const mergedDuration = await probeMediaDuration(merged);
  const voiceoverDuration = await probeMediaDuration(voiceover.path);
  if (plannedDuration === null) plannedDuration = mergedDuration;

  let outputDuration: number;
  if (options.target_duration_seconds != null) {
    outputDuration = Number(options.target_duration_seconds);
  } else if (
    voiceoverDuration > plannedDuration &&
    voiceoverDuration - plannedDuration <= MAX_AUDIO_OVERRUN_EXTENSION_SECONDS
  ) {
    outputDuration = voiceoverDuration;
  } else {
    outputDuration = plannedDuration;
  }
  outputDuration = Math.max(0.1, outputDuration);
  const padDuration = Math.max(0.0, outputDuration - mergedDuration);

  if (voiceoverDuration > outputDuration + MAX_UNCONFORMED_AUDIO_TAIL_SECONDS) {
    throw new Error(
      `Voiceover is ${voiceoverDuration.toFixed(3)}s but the final video target is ` +
        `${outputDuration.toFixed(3)}s. Redraft or regenerate shorter narration before stitching; audio will not be cut.`,
    );
  }
  const audioFilter = "apad";

  const timed = path.join(ctx.project_dir, "merged_timed.mp4");
  await runFfmpeg(
    [
      "-y",
      "-i", merged,
      "-vf",
      "tpad=stop_mode=clone:" +
        `stop_duration=${formatSeconds(padDuration)},` +
        `trim=duration=${formatSeconds(outputDuration)},setpts=PTS-STARTPTS`,
      "-c:v", "libx264", "-preset", "fast",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-an",
      timed,
    ],
    "target-duration ffmpeg normalize",
  );

  // --- Step 2: Overlay voiceover audio onto the merged video ---
  await runFfmpeg(
    [
      "-y",
      "-i", timed,
      "-i", voiceover.path,
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c:v", "copy",
      "-af", audioFilter,
      "-c:a", "aac", "-b:a", "192k",
      "-t", formatSeconds(outputDuration),
      "-movflags", "+faststart",
      final,
    ],
    "voiceover mux ffmpeg",
  );

  for (const intermediate of [merged, timed]) {
    try {
      unlinkSync(intermediate);
    } catch {
      // best-effort cleanup
    }
  }

  console.info(`Final video saved: ${final}`);
  return final;
}

export interface TimelineStitchClip {
  id: string;
  path: string;
  source_start: number;
  source_end: number;
  timeline_start: number;
  timeline_end: number;
  duration: number;
  [key: string]: any;
}

export async function stitchTimelineAssets(
  ctx: ProjectContext,
  clips: TimelineStitchClip[],
  voiceover: Record<string, any>,
  options: { target_duration_seconds?: number | null } = {},
): Promise<string> {
  if (clips.length === 0) throw new Error("No timeline clips to stitch");
  if (!voiceover?.path) throw new Error("No voiceover asset found for timeline stitch");

  const final = path.join(ctx.project_dir, "final.mp4");
  const timelineDir = path.join(ctx.project_dir, "timeline_clips");
  resetProviderOutputDir(timelineDir);

  const ordered = [...clips].sort((a, b) => a.timeline_start - b.timeline_start);
  const normalizedPaths: string[] = [];
  for (let index = 0; index < ordered.length; index++) {
    const clip = ordered[index]!;
    const label = `clip_${String(index + 1).padStart(2, "0")}.mp4`;
    normalizedPaths.push(
      await normalizeSceneVideoForStitch(ctx, clip.path, path.join(timelineDir, label), {
        source_start: clip.source_start,
        source_end: clip.source_end,
        target_duration_seconds: clip.duration,
      }),
    );
  }

  const merged = path.join(ctx.project_dir, "timeline_merged.mp4");
  if (normalizedPaths.length === 1) {
    copyFileSync(normalizedPaths[0]!, merged);
  } else {
    const concatList = path.join(ctx.project_dir, "timeline_concat.txt");
    writeFileSync(concatList, normalizedPaths.map((p) => `file '${path.resolve(p)}'\n`).join(""), "utf-8");
    try {
      await runFfmpeg(
        [
          "-y",
          "-f", "concat", "-safe", "0",
          "-i", path.resolve(concatList),
          "-c:v", "libx264", "-preset", "fast",
          "-crf", "18",
          "-pix_fmt", "yuv420p",
          "-r", "30",
          "-an",
          "-movflags", "+faststart",
          merged,
        ],
        "timeline concat ffmpeg",
      );
    } finally {
      try {
        unlinkSync(concatList);
      } catch {
        // best-effort cleanup
      }
    }
  }

  const mergedDuration = await probeMediaDuration(merged);
  const voiceoverDuration = await probeMediaDuration(voiceover.path);
  const requestedTarget = Number(options.target_duration_seconds ?? 0);
  let outputDuration = Math.max(
    0.1,
    Number.isFinite(requestedTarget) && requestedTarget > 0
      ? requestedTarget
      : Math.max(mergedDuration, voiceoverDuration),
  );
  const padDuration = Math.max(0.0, outputDuration - mergedDuration);

  if (voiceoverDuration > outputDuration + MAX_UNCONFORMED_AUDIO_TAIL_SECONDS) {
    throw new Error(
      `Voiceover is ${voiceoverDuration.toFixed(3)}s but the final video target is ` +
        `${outputDuration.toFixed(3)}s. Redraft or regenerate shorter narration before stitching; audio will not be cut.`,
    );
  }
  const audioFilter = "apad";

  const timed = path.join(ctx.project_dir, "timeline_timed.mp4");
  await runFfmpeg(
    [
      "-y",
      "-i", merged,
      "-vf",
      "tpad=stop_mode=clone:" +
        `stop_duration=${formatSeconds(padDuration)},` +
        `trim=duration=${formatSeconds(outputDuration)},setpts=PTS-STARTPTS`,
      "-c:v", "libx264", "-preset", "fast",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-an",
      timed,
    ],
    "timeline target-duration ffmpeg normalize",
  );

  await runFfmpeg(
    [
      "-y",
      "-i", timed,
      "-i", voiceover.path,
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c:v", "copy",
      "-af", audioFilter,
      "-c:a", "aac", "-b:a", "192k",
      "-t", formatSeconds(outputDuration),
      "-movflags", "+faststart",
      final,
    ],
    "timeline voiceover mux ffmpeg",
  );

  for (const intermediate of [merged, timed]) {
    try {
      unlinkSync(intermediate);
    } catch {
      // best-effort cleanup
    }
  }

  console.info(`Final video saved from timeline: ${final}`);
  return final;
}

/**
 * Mux one normalized (silent) scene video with its section audio.
 *
 * The output is clamped to the requested section duration, falling back to the
 * audio duration. If the video is shorter the last frame is frozen; if the
 * audio is shorter it is padded with silence inside the section.
 * This makes each section self-contained so section boundaries are exact and
 * concatenation can never drift audio out of sync with footage.
 */
async function muxSection(
  normalizedVideo: string,
  audioPath: string,
  audioDuration: number,
  output: string,
  targetDurationSeconds?: number | null,
  allowAudioTrimToTarget = false,
): Promise<string> {
  const videoDuration = await probeMediaDuration(normalizedVideo);
  const requestedTarget = Number(targetDurationSeconds ?? 0);
  if (
    Number.isFinite(requestedTarget) &&
    requestedTarget > 0 &&
    !allowAudioTrimToTarget &&
    audioDuration > requestedTarget + AUDIO_DURATION_CODEC_TOLERANCE_SECONDS
  ) {
    throw new Error(
      `Section audio is ${audioDuration.toFixed(3)}s but the section target is ` +
        `${requestedTarget.toFixed(3)}s. Redraft shorter narration before stitching; audio will not be cut.`,
    );
  }
  const sectionDuration =
    Number.isFinite(requestedTarget) && requestedTarget > 0
      ? allowAudioTrimToTarget
        ? requestedTarget
        : Math.max(requestedTarget, audioDuration)
      : audioDuration;
  const padDuration = Math.max(0.0, sectionDuration - videoDuration);
  await runFfmpeg(
    [
      "-y",
      "-i", path.resolve(normalizedVideo),
      "-i", path.resolve(audioPath),
      "-filter_complex",
      "[0:v]tpad=stop_mode=clone:" +
        `stop_duration=${formatSeconds(padDuration)},` +
        `trim=duration=${formatSeconds(sectionDuration)},setpts=PTS-STARTPTS[v];` +
        `[1:a]apad,atrim=duration=${formatSeconds(sectionDuration)},asetpts=PTS-STARTPTS[a]`,
      "-map", "[v]",
      "-map", "[a]",
      "-c:v", "libx264", "-preset", "fast",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
      "-t", formatSeconds(sectionDuration),
      "-movflags", "+faststart",
      output,
    ],
    "per-section mux ffmpeg",
  );
  return output;
}

export interface PerSectionScene {
  video_path: string;
  audio_path: string;
  audio_duration_seconds: number;
  target_duration_seconds?: number | null;
  allow_audio_trim_to_target?: boolean;
  [key: string]: any;
}

async function normalizeFinalDuration(
  ctx: ProjectContext,
  input: string,
  targetDuration: number,
): Promise<string> {
    const sourceDuration = await probeMediaDuration(input);
  const allowedOverrun = Math.max(FINAL_TARGET_OVERRUN_SECONDS, targetDuration * FINAL_TARGET_OVERRUN_RATIO);
  if (sourceDuration > targetDuration + allowedOverrun + AUDIO_DURATION_CODEC_TOLERANCE_SECONDS) {
    throw new Error(
      `Final section edit is ${sourceDuration.toFixed(3)}s but the requested target is ` +
        `${targetDuration.toFixed(3)}s. Redraft shorter narration before final stitching; audio will not be cut.`,
    );
  }
  if (sourceDuration > targetDuration + AUDIO_DURATION_CODEC_TOLERANCE_SECONDS) {
    recordTimingEvent(ctx, {
      phase: "event",
      name: "workflow.final_duration_target_overrun_allowed",
      metadata: {
        actual_duration_seconds: Number(sourceDuration.toFixed(3)),
        target_duration_seconds: Number(targetDuration.toFixed(3)),
        allowed_overrun_seconds: Number(allowedOverrun.toFixed(3)),
      },
    });
    return input;
  }
  if (sourceDuration + AUDIO_DURATION_CODEC_TOLERANCE_SECONDS < targetDuration) {
    throw new Error(
      `Final edit is ${sourceDuration.toFixed(3)}s for a ${targetDuration.toFixed(3)}s target. ` +
        "Redraft with more scene coverage before stitching; the renderer will not freeze-pad the final frame.",
    );
  }
  return input;
}

/**
 * Stitch scenes where each carries its own audio, then hard-cut concat.
 *
 * Each scene's video is normalized, muxed with its own section audio and
 * clamped to that audio's duration, then the per-section MP4s are concatenated
 * with the concat demuxer (hard cuts). Audio and video stay locked together
 * regardless of duration estimates or dropped sections.
 */
export async function stitchAssetsPerSection(
  ctx: ProjectContext,
  scenes: PerSectionScene[],
  options: { target_duration_seconds?: number | null } = {},
): Promise<string> {
  const n = scenes.length;
  if (n === 0) throw new Error("No scenes to stitch");

  const final = path.join(ctx.project_dir, "final.mp4");
  const normalizedDir = path.join(ctx.project_dir, "normalized");
  resetProviderOutputDir(normalizedDir);
  const sectionsDir = path.join(ctx.project_dir, "muxed_sections");
  resetProviderOutputDir(sectionsDir);

  const muxedPaths: string[] = [];
  for (let index = 0; index < scenes.length; index++) {
    const scene = scenes[index]!;
    const label = `scene_${String(index + 1).padStart(2, "0")}.mp4`;
    const targetDuration = Number(scene.target_duration_seconds ?? 0);
    const normalized = await normalizeSceneVideoForStitch(ctx, scene.video_path, path.join(normalizedDir, label), {
      target_duration_seconds: Number.isFinite(targetDuration) && targetDuration > 0 ? targetDuration : null,
    });
    const muxed = await muxSection(
      normalized,
      scene.audio_path,
      Number(scene.audio_duration_seconds),
      path.join(sectionsDir, label),
      Number.isFinite(targetDuration) && targetDuration > 0 ? targetDuration : null,
      scene.allow_audio_trim_to_target === true,
    );
    muxedPaths.push(muxed);
  }

  if (n === 1) {
    copyFileSync(muxedPaths[0]!, final);
  } else {
    const concatList = path.join(ctx.project_dir, "sections_concat.txt");
    writeFileSync(concatList, muxedPaths.map((p) => `file '${path.resolve(p)}'\n`).join(""), "utf-8");
    try {
      await runFfmpeg(
        [
          "-y",
          "-f", "concat", "-safe", "0",
          "-i", path.resolve(concatList),
          "-c:v", "libx264", "-preset", "fast",
          "-crf", "18",
          "-pix_fmt", "yuv420p",
          "-r", "30",
          "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
          "-movflags", "+faststart",
          final,
        ],
        "per-section concat ffmpeg",
      );
    } finally {
      try {
        unlinkSync(concatList);
      } catch {
        // best-effort cleanup
      }
    }
  }

  if (options.target_duration_seconds != null) {
    const targetDuration = Number(options.target_duration_seconds);
    if (Number.isFinite(targetDuration) && targetDuration > 0) {
      await normalizeFinalDuration(ctx, final, targetDuration);
    }
  }

  console.info(`Final video saved (per-section): ${final}`);
  return final;
}

/**
 * Decide whether any scene carries its own (embedded or on-camera) audio.
 *
 * Used by the final stitch step to branch: if false, the all-b-roll global-VO
 * overlay path is taken unchanged; if true, every scene is routed through the
 * audio-preserving per-section assembler so each scene keeps its own mp3.
 */
export function anyEmbeddedAudio(videos: Array<Record<string, any>>): boolean {
  return videos.some((v) => v.has_embedded_audio === true || v.on_camera === true);
}

/**
 * Mixed-mode stitch entry point: a thin named wrapper around
 * {@link stitchAssetsPerSection} so the workflow has one dispatcher for
 * projects that contain at least one talking (audio-bearing) scene. Passes
 * through faithfully; the per-section assembler keeps each scene's own audio.
 */
export async function stitchMixedAssets(
  ctx: ProjectContext,
  scenes: PerSectionScene[],
  options: { target_duration_seconds?: number | null } = {},
): Promise<string> {
  return stitchAssetsPerSection(ctx, scenes, options);
}
