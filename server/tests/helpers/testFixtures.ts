import { execa } from "execa";
import path from "node:path";
import type { ProjectContext } from "../../src/context.js";
import { PROJECT_CONTEXT_DEFAULTS } from "../../src/context.js";
import { writeJsonArtifact } from "../../src/renderState.js";
import type { Scene, VideoPlan } from "../../src/schemas.js";

export function makeScene(overrides: Partial<Scene> & Pick<Scene, "id">): Scene {
  return {
    narration: "",
    image_prompt: "an image",
    video_prompt: "a video",
    duration_seconds: 2,
    on_camera: true,
    audio_source: null,
    native_audio_prompt: null,
    audio_mode: "ugc_casual",
    audio_note: null,
    reference_media_ids: [],
    continuity: {
      story_beat: "",
      required_subjects: [],
      opening_state: "",
      closing_state: "",
      setting: "",
      screen_direction: "not_applicable",
    },
    ...overrides,
  };
}

export function testContext(projectDir: string, projectId: string): ProjectContext {
  return {
    project_id: projectId,
    project_dir: projectDir,
    aspect_ratio: "16:9",
    resolution: "720p",
    ...PROJECT_CONTEXT_DEFAULTS,
  };
}

export async function makeSilentVideo(pathname: string, seconds: number): Promise<void> {
  await execa("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=black:s=320x180:d=${seconds}:r=30`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    pathname,
  ]);
}

export async function makeTone(pathname: string, seconds: number): Promise<void> {
  await execa("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:duration=${seconds}`,
    "-c:a",
    "mp3",
    pathname,
  ]);
}

export function silentClipFor(ctx: ProjectContext, scene: Scene) {
  return {
    scene_id: scene.id,
    path: path.join(ctx.project_dir, "videos", `${scene.id}.mp4`),
    prompt: scene.video_prompt,
    model: ctx.video_model,
    resolution: ctx.resolution,
    audio: false,
    duration_seconds: scene.duration_seconds,
    provider_job_id: null,
    provider_url: null,
  };
}

export function talkingClipFor(ctx: ProjectContext, scene: Scene, audioPath: string, audioDuration: number) {
  return {
    scene_id: scene.id,
    path: path.join(ctx.project_dir, "videos", scene.id, "talking", "talking.mp4"),
    prompt: scene.video_prompt,
    model: "ai-talking-photo",
    resolution: ctx.resolution,
    audio: true,
    duration_seconds: audioDuration,
    provider_job_id: "talk1",
    provider_url: null,
    has_embedded_audio: true,
    on_camera: true,
    audio_path: audioPath,
    audio_duration_seconds: audioDuration,
  };
}

function writePlanAndImages(
  ctx: ProjectContext,
  scenes: Scene[],
  planOverrides: Partial<Pick<VideoPlan, "voice" | "visual_bible">>,
  includeImageStyle: boolean,
): void {
  const plan: VideoPlan = {
    title: "Test plan",
    creative_vibe: "polished_ugc",
    narration: "overall narration",
    visual_bible: "",
    scenes,
    voice: null,
    ...planOverrides,
  };
  writeJsonArtifact(ctx, "plan", plan);
  writeJsonArtifact(
    ctx,
    "images",
    scenes.map((scene) => ({
      scene_id: scene.id,
      path: path.join(ctx.project_dir, "images", `${scene.id}.png`),
      prompt: scene.image_prompt,
      model: ctx.image_model,
      resolution: ctx.image_resolution,
      ...(includeImageStyle ? { style_tool: ctx.image_style_tool } : {}),
      provider_job_id: null,
      provider_url: null,
    })),
  );
}

export function seedPlanAndImages(
  ctx: ProjectContext,
  scenes: Scene[],
  planOverrides: Partial<Pick<VideoPlan, "voice" | "visual_bible">> = {},
): void {
  writePlanAndImages(ctx, scenes, planOverrides, false);
}

export function seedPlanImagesVideos(
  ctx: ProjectContext,
  scenes: Scene[],
  planOverrides: Partial<Pick<VideoPlan, "voice" | "visual_bible">> = {},
): void {
  writePlanAndImages(ctx, scenes, planOverrides, true);
  writeJsonArtifact(ctx, "videos", scenes.map((scene) => silentClipFor(ctx, scene)));
}
