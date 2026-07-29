import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectContext } from "../src/context.js";
import { PROJECT_CONTEXT_DEFAULTS } from "../src/context.js";
// `withMediaUrl` (called at the end of `animateSceneVideosImpl`) rejects asset
// paths outside OUTPUT_DIR, so the temp project dir must live under it.
import { OUTPUT_DIR } from "../src/config.js";
import type { Scene, VideoPlan } from "../src/schemas.js";
import { FISH_AUDIO_VOICES } from "../src/voices.js";

// --- media.ts mock --------------------------------------------------------
// `animateSceneVideosImpl` imports a fixed set of names from `media.js`. We
// stub the render-boundary functions this task wires together
// (`generateVideoAssetsBatch` for b-roll silent clips, `generateSceneVoiceovers`
// for per-scene TTS, `generateTalkingClip` for the submitted talking render, and
// `generateVideoAsset` for explicit retry/regenerate paths)
// while keeping every other export real via `importActual`, so unrelated
// helpers used elsewhere in `workflows.ts` still resolve.
const generateVideoAssetsBatch = vi.fn();
const generateSceneVoiceovers = vi.fn();
const generateTalkingClip = vi.fn();
const generateVideoAsset = vi.fn();
// `generateVoiceoverImpl` calls this to render the single global narration mp3.
// Spying lets us assert the all-talking skip path never invokes it.
const generateVoiceoverAsset = vi.fn();
const recoverVideoAssetFromProviderJob = vi.fn();
// `stitchFinalVideoImpl` routes talking projects through `stitchMixedAssets`;
// we stub it (returning a fake final path) to assert the branch + capture the
// per-scene inputs without touching ffmpeg. `probeMediaStreamDurations` runs in
// the post-stitch timeline verification, so it is stubbed to avoid ffprobe on
// the fake final path.
const stitchMixedAssets = vi.fn();
const probeMediaStreamDurations = vi.fn();
// The destructive, NON-audio-preserving timeline stitch (strips clip audio, `-an`).
// `restitchTimelineImpl` must NOT reach this on a talking project, so we spy on it.
// `stitchAssets` is the non-timeline b-roll fallback; stub it too so the b-roll
// control test can assert it gets PAST the guard without real ffmpeg fixtures.
const stitchTimelineAssets = vi.fn();
const stitchAssets = vi.fn();

vi.mock("../src/media.js", async () => {
  const actual = await vi.importActual<typeof import("../src/media.js")>("../src/media.js");
  return {
    ...actual,
    generateVideoAssetsBatch,
    generateSceneVoiceovers,
    generateTalkingClip,
    generateVideoAsset,
    generateVoiceoverAsset,
    recoverVideoAssetFromProviderJob,
    stitchMixedAssets,
    probeMediaStreamDurations,
    stitchTimelineAssets,
    stitchAssets,
  };
});

// Imported AFTER vi.mock so the mocked media boundary is wired in.
const {
  animateSceneVideosImpl,
  stitchFinalVideoImpl,
  generateVoiceoverImpl,
  inspectRenderStatusImpl,
  restitchTimelineImpl,
  replaceVoiceoverImpl,
} = await import("../src/workflows.js");
const { initializeProjectState, readJsonArtifact, writeJsonArtifact } = await import("../src/renderState.js");

function makeScene(overrides: Partial<Scene> & Pick<Scene, "id">): Scene {
  return {
    narration: "",
    image_prompt: "an image",
    video_prompt: "a video",
    duration_seconds: 2,
    on_camera: true,
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

function testContext(projectDir: string): ProjectContext {
  return {
    project_id: "workflows-lipsync-test",
    project_dir: projectDir,
    aspect_ratio: "16:9",
    resolution: "720p",
    ...PROJECT_CONTEXT_DEFAULTS,
  };
}

function seedPlanAndImages(
  ctx: ProjectContext,
  scenes: Scene[],
  planOverrides: Partial<Pick<VideoPlan, "voice" | "visual_bible">> = {},
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
  const images = scenes.map((scene) => ({
    scene_id: scene.id,
    path: path.join(ctx.project_dir, "images", `${scene.id}.png`),
    prompt: scene.image_prompt,
    model: ctx.image_model,
    resolution: ctx.image_resolution,
    provider_job_id: null,
    provider_url: null,
  }));
  writeJsonArtifact(ctx, "images", images);
}

let projectDir: string;
let ctx: ProjectContext;

beforeEach(() => {
  projectDir = mkdtempSync(path.join(OUTPUT_DIR, "workflows-lipsync-"));
  ctx = testContext(projectDir);
  generateVideoAssetsBatch.mockReset();
  generateSceneVoiceovers.mockReset();
  generateSceneVoiceovers.mockImplementation(async (_ctx: ProjectContext, scenes: Scene[]) =>
    scenes.map((scene) => ({
      scene_id: scene.id,
      path: path.join(projectDir, "voiceover", "scenes", `${scene.id}.mp3`),
      duration_seconds: 1.2,
    })),
  );
  generateTalkingClip.mockReset();
  generateVideoAsset.mockReset();
  generateVoiceoverAsset.mockReset();
  recoverVideoAssetFromProviderJob.mockReset();
  stitchMixedAssets.mockReset();
  probeMediaStreamDurations.mockReset();
  stitchTimelineAssets.mockReset();
  stitchAssets.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(projectDir, { recursive: true, force: true });
});

function silentClipFor(ctx: ProjectContext, scene: Scene) {
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

function talkingClipFor(ctx: ProjectContext, scene: Scene, audioPath: string, audioDuration: number) {
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

describe("animateSceneVideosImpl talking-photo partition", () => {
  it("voices only talking scenes, renders them via aiTalkingPhoto, and routes b-roll through imageToVideo", async () => {
    const talking = makeScene({ id: "scene_1", narration: "I am talking", on_camera: true });
    const broll = makeScene({ id: "scene_2", narration: "voiceover only", on_camera: false });
    seedPlanAndImages(ctx, [talking, broll]);

    generateVideoAssetsBatch.mockImplementation(async (_ctx, pairs: Array<[Scene, any]>) =>
      pairs.map(([scene]) => silentClipFor(ctx, scene)),
    );
    generateSceneVoiceovers.mockImplementation(async (_ctx, scenes: Scene[]) =>
      scenes.map((scene) => ({
        scene_id: scene.id,
        path: path.join(ctx.project_dir, "voiceover", "scenes", `${scene.id}.mp3`),
        duration_seconds: 2.5,
      })),
    );
    generateTalkingClip.mockImplementation(async (_ctx, scene: Scene, _imagePath, audioPath, audioDuration) =>
      talkingClipFor(ctx, scene, audioPath, audioDuration),
    );

    await animateSceneVideosImpl(ctx);

    // (a) TTS only for the talking scene.
    expect(generateSceneVoiceovers).toHaveBeenCalledTimes(1);
    const voScenes = generateSceneVoiceovers.mock.calls[0]![1] as Scene[];
    expect(voScenes.map((s) => s.id)).toEqual(["scene_1"]);
    // ...with the resolved voice reference id threaded as the 3rd arg. This plan
    // has voice: null and no gendered cues, so the resolver falls back to the
    // neutral default instead of passing an empty Fish reference.
    expect(generateSceneVoiceovers.mock.calls[0]![2]).toBe(FISH_AUDIO_VOICES.alle!.reference_id);

    // (b) Talking clip rendered once from the scene's IMAGE path + its audio.
    expect(generateTalkingClip).toHaveBeenCalledTimes(1);
    const [, talkScene, imagePath, audioPath, audioDuration] = generateTalkingClip.mock.calls[0]!;
    expect((talkScene as Scene).id).toBe("scene_1");
    expect(imagePath).toBe(path.join(ctx.project_dir, "images", "scene_1.png"));
    expect(audioPath).toBe(path.join(ctx.project_dir, "voiceover", "scenes", "scene_1.mp3"));
    expect(audioDuration).toBe(2.5);

    // imageToVideo batch only ran for the b-roll pair (NOT the talking scene).
    expect(generateVideoAssetsBatch).toHaveBeenCalledTimes(1);
    const batchPairs = generateVideoAssetsBatch.mock.calls[0]![1] as Array<[Scene, any]>;
    expect(batchPairs.map(([s]) => s.id)).toEqual(["scene_2"]);
    // Talking scene never gets a silent fallback clip.
    expect(generateVideoAsset).not.toHaveBeenCalled();

    // (c) Persisted videos: talking entry carries embedded audio + talking path; b-roll silent.
    const videos = readJsonArtifact<any[]>(ctx, "videos", [])!;
    const byScene = new Map(videos.map((v) => [v.scene_id, v]));
    const talkingVideo = byScene.get("scene_1");
    const brollVideo = byScene.get("scene_2");
    expect(talkingVideo.has_embedded_audio).toBe(true);
    expect(talkingVideo.audio_path).toBe(path.join(ctx.project_dir, "voiceover", "scenes", "scene_1.mp3"));
    expect(talkingVideo.path).toBe(path.join(ctx.project_dir, "videos", "scene_1", "talking", "talking.mp4"));
    expect(brollVideo.has_embedded_audio).toBeUndefined();
    expect(brollVideo.audio_path).toBeUndefined();
    expect(brollVideo.path).toBe(path.join(ctx.project_dir, "videos", "scene_2.mp4"));
  });

  it("does not apply LTX duration limits to on-camera talking-photo scenes", async () => {
    const talking = makeScene({ id: "scene_1", narration: "I speak for a while", duration_seconds: 14, on_camera: true });
    const broll = makeScene({ id: "scene_2", narration: "short proof", duration_seconds: 10, on_camera: false });
    seedPlanAndImages(ctx, [talking, broll]);

    generateVideoAssetsBatch.mockImplementation(async (_ctx, pairs: Array<[Scene, any]>) =>
      pairs.map(([scene]) => silentClipFor(ctx, scene)),
    );
    generateSceneVoiceovers.mockResolvedValue([
      { scene_id: talking.id, path: path.join(ctx.project_dir, "voiceover", "scene_1.mp3"), duration_seconds: 2.5 },
    ]);
    generateTalkingClip.mockResolvedValue(
      talkingClipFor(ctx, talking, path.join(ctx.project_dir, "voiceover", "scene_1.mp3"), 2.5),
    );

    await expect(animateSceneVideosImpl(ctx)).resolves.toMatchObject({ stage: "videos_animated" });
    expect(generateTalkingClip).toHaveBeenCalledTimes(1);
    expect(generateVideoAssetsBatch).toHaveBeenCalledTimes(1);
  });

  it("renders every scene on the first full render even if the agent passes a selected scene id", async () => {
    const broll1 = makeScene({ id: "scene_1", narration: "one", on_camera: false });
    const broll2 = makeScene({ id: "scene_2", narration: "two", on_camera: false });
    seedPlanAndImages(ctx, [broll1, broll2]);

    generateVideoAssetsBatch.mockImplementation(async (_ctx, pairs: Array<[Scene, any]>) =>
      pairs.map(([scene]) => silentClipFor(ctx, scene)),
    );

    await animateSceneVideosImpl(ctx, ["scene_2"]);

    const batchPairs = generateVideoAssetsBatch.mock.calls[0]![1] as Array<[Scene, any]>;
    expect(batchPairs.map(([scene]) => scene.id)).toEqual(["scene_1", "scene_2"]);
  });

  it("records a recoverable talking failure without spending a silent imageToVideo fallback", async () => {
    const talking = makeScene({ id: "scene_1", narration: "I am talking", on_camera: true });
    seedPlanAndImages(ctx, [talking]);

    // No b-roll pairs, so the batch is never called for this plan.
    generateVideoAssetsBatch.mockImplementation(async (_ctx, pairs: Array<[Scene, any]>) =>
      pairs.map(([scene]) => silentClipFor(ctx, scene)),
    );
    generateSceneVoiceovers.mockImplementation(async (_ctx, scenes: Scene[]) =>
      scenes.map((scene) => ({
        scene_id: scene.id,
        path: path.join(ctx.project_dir, "voiceover", "scenes", `${scene.id}.mp3`),
        duration_seconds: 2.5,
      })),
    );
    generateTalkingClip.mockRejectedValue(
      Object.assign(new Error("talking poll stalled"), {
        provider_job_id: "talk1",
        provider_kind: "talking-photo",
        provider_stage: "talking",
        provider_model: "ai-talking-photo",
        audio_path: path.join(ctx.project_dir, "voiceover", "scenes", "scene_1.mp3"),
        audio_duration_seconds: 2.5,
        duration_seconds: 2.5,
        on_camera: true,
      }),
    );

    await animateSceneVideosImpl(ctx);

    expect(generateVideoAsset).not.toHaveBeenCalled();

    const videos = readJsonArtifact<any[]>(ctx, "videos", [])!;
    expect(videos.find((v) => v.scene_id === "scene_1")).toBeUndefined();

    const failures = readJsonArtifact<any[]>(ctx, "failed_scenes", [])!;
    const talkFailure = failures.find((f) => f.scene_id === "scene_1" && f.stage === "talking");
    expect(talkFailure).toBeTruthy();
    expect(talkFailure.error).toContain("talking poll stalled");
    expect(talkFailure.provider_job_id).toBe("talk1");
    expect(talkFailure.provider_kind).toBe("talking-photo");
  });

  it("on a non-recoverable talking failure falls back to image-to-video without persisting a stale failure", async () => {
    const talking = makeScene({ id: "scene_1", narration: "I am talking", on_camera: true });
    seedPlanAndImages(ctx, [talking]);

    // No b-roll pairs, so the batch is never called for this plan.
    generateVideoAssetsBatch.mockImplementation(async (_ctx, pairs: Array<[Scene, any]>) =>
      pairs.map(([scene]) => silentClipFor(ctx, scene)),
    );
    generateSceneVoiceovers.mockImplementation(async (_ctx, scenes: Scene[]) =>
      scenes.map((scene) => ({
        scene_id: scene.id,
        path: path.join(ctx.project_dir, "voiceover", "scenes", `${scene.id}.mp3`),
        duration_seconds: 2.5,
      })),
    );
    generateTalkingClip.mockRejectedValue(new Error("talking boom"));
    generateVideoAsset.mockResolvedValue(silentClipFor(ctx, talking));

    await animateSceneVideosImpl(ctx);

    expect(generateTalkingClip).toHaveBeenCalledTimes(1);
    expect(generateVideoAsset).toHaveBeenCalledTimes(1);

    // The scene still produces a usable silent clip, so the full edit is not blocked.
    const videos = readJsonArtifact<any[]>(ctx, "videos", [])!;
    expect(videos.find((v) => v.scene_id === "scene_1")).toMatchObject({
      scene_id: "scene_1",
      audio: false,
    });

    // No stale talking/video-generation failure remains because the fallback clip succeeded.
    const failures = readJsonArtifact<any[]>(ctx, "failed_scenes", [])!;
    const talkFailures = failures.filter((f) => f.scene_id === "scene_1" && f.stage === "talking");
    const genFailures = failures.filter((f) => f.scene_id === "scene_1" && f.stage === "video_generation");
    expect(talkFailures).toHaveLength(0);
    expect(genFailures).toHaveLength(0);
  });

  it("threads the explicitly-chosen catalog voice's reference id into per-scene TTS", async () => {
    const talking = makeScene({ id: "scene_1", narration: "I am talking", on_camera: true });
    seedPlanAndImages(ctx, [talking], { voice: "jasphina" });

    generateSceneVoiceovers.mockImplementation(async (_ctx, scenes: Scene[]) =>
      scenes.map((scene) => ({
        scene_id: scene.id,
        path: path.join(ctx.project_dir, "voiceover", "scenes", `${scene.id}.mp3`),
        duration_seconds: 2.5,
      })),
    );
    generateTalkingClip.mockImplementation(async (_ctx, scene: Scene, _imagePath, audioPath, audioDuration) =>
      talkingClipFor(ctx, scene, audioPath, audioDuration),
    );

    await animateSceneVideosImpl(ctx);

    expect(generateSceneVoiceovers).toHaveBeenCalledTimes(1);
    expect(generateSceneVoiceovers.mock.calls[0]![2]).toBe(FISH_AUDIO_VOICES.jasphina!.reference_id);
  });

  it("falls back to the female-default voice's reference id when no voice is set but the visual bible is clearly female", async () => {
    const talking = makeScene({ id: "scene_1", narration: "I am talking", on_camera: true });
    seedPlanAndImages(ctx, [talking], {
      visual_bible: "She is a woman, a young female creator; her style is bold.",
    });

    generateSceneVoiceovers.mockImplementation(async (_ctx, scenes: Scene[]) =>
      scenes.map((scene) => ({
        scene_id: scene.id,
        path: path.join(ctx.project_dir, "voiceover", "scenes", `${scene.id}.mp3`),
        duration_seconds: 2.5,
      })),
    );
    generateTalkingClip.mockImplementation(async (_ctx, scene: Scene, _imagePath, audioPath, audioDuration) =>
      talkingClipFor(ctx, scene, audioPath, audioDuration),
    );

    await animateSceneVideosImpl(ctx);

    expect(generateSceneVoiceovers).toHaveBeenCalledTimes(1);
    expect(generateSceneVoiceovers.mock.calls[0]![2]).toBe(FISH_AUDIO_VOICES.sarah!.reference_id);
  });

  it("does not voice or render talking clips for a pure b-roll plan", async () => {
    const broll1 = makeScene({ id: "scene_1", narration: "vo one", on_camera: false });
    const broll2 = makeScene({ id: "scene_2", narration: "vo two", on_camera: false });
    seedPlanAndImages(ctx, [broll1, broll2]);

    generateVideoAssetsBatch.mockImplementation(async (_ctx, pairs: Array<[Scene, any]>) =>
      pairs.map(([scene]) => silentClipFor(ctx, scene)),
    );

    await animateSceneVideosImpl(ctx);

    expect(generateSceneVoiceovers).not.toHaveBeenCalled();
    expect(generateTalkingClip).not.toHaveBeenCalled();
    // All scenes routed through the imageToVideo batch.
    expect(generateVideoAssetsBatch).toHaveBeenCalledTimes(1);
    const batchPairs = generateVideoAssetsBatch.mock.calls[0]![1] as Array<[Scene, any]>;
    expect(batchPairs.map(([s]) => s.id)).toEqual(["scene_1", "scene_2"]);

    const videos = readJsonArtifact<any[]>(ctx, "videos", [])!;
    for (const video of videos) {
      expect(video.has_embedded_audio).toBeUndefined();
      expect(video.audio_path).toBeUndefined();
    }
  });
});

describe("generateVoiceoverImpl per-scene audio path", () => {
  it("reuses an accepted global voiceover instead of issuing duplicate TTS calls", async () => {
    const broll = makeScene({ id: "scene_1", narration: "One accepted narration.", on_camera: false });
    seedPlanAndImages(ctx, [broll]);
    const audioPath = path.join(ctx.project_dir, "voiceover", "voiceover.mp3");
    mkdirSync(path.dirname(audioPath), { recursive: true });
    writeFileSync(audioPath, "accepted-audio");
    writeJsonArtifact(ctx, "voiceover", {
      path: audioPath,
      provider: "elevenlabs",
      duration_seconds: 5,
      target_duration_seconds: 5,
    });

    const result = await generateVoiceoverImpl(ctx);

    expect(generateVoiceoverAsset).not.toHaveBeenCalled();
    expect(result.reused).toBe(true);
    expect(result.voiceover.path).toBe(audioPath);
  });

  it("skips the global voiceover and prepares scene audio when every scene is on_camera", async () => {
    const talking1 = makeScene({ id: "scene_1", narration: "I talk", on_camera: true });
    const talking2 = makeScene({ id: "scene_2", narration: "I also talk", on_camera: true });
    seedPlanAndImages(ctx, [talking1, talking2]);

    const result = await generateVoiceoverImpl(ctx);

    // No global VO rendered and no artifact persisted for a pure-talking plan.
    expect(generateVoiceoverAsset).not.toHaveBeenCalled();
    expect(readJsonArtifact(ctx, "voiceover", null)).toBeNull();
    expect(generateSceneVoiceovers).toHaveBeenCalledTimes(1);
    expect((generateSceneVoiceovers.mock.calls[0]![1] as Scene[]).map((scene) => scene.id)).toEqual(["scene_1", "scene_2"]);

    // Returns a sane result that keeps the agent flow moving to the same next step.
    expect(result.next_tools).toEqual(["generate_scene_images", "animate_scene_videos"]);
    expect(result.project_id).toBe(ctx.project_id);
  });

  it("skips the global voiceover and prepares all scene audio for mixed talking/b-roll plans", async () => {
    const talking = makeScene({ id: "scene_1", narration: "I talk", on_camera: true });
    const broll = makeScene({ id: "scene_2", narration: "voiceover only", on_camera: false });
    seedPlanAndImages(ctx, [talking, broll]);

    const result = await generateVoiceoverImpl(ctx);

    expect(generateVoiceoverAsset).not.toHaveBeenCalled();
    expect(readJsonArtifact(ctx, "voiceover", null)).toBeNull();
    expect(generateSceneVoiceovers).toHaveBeenCalledTimes(1);
    expect((generateSceneVoiceovers.mock.calls[0]![1] as Scene[]).map((scene) => scene.id)).toEqual(["scene_1", "scene_2"]);
    expect(result.stage).toBe("voiceover_generated");
    expect(result.next_tools).toEqual(["generate_scene_images", "animate_scene_videos"]);
  });

  it("rejects measured per-scene voiceover underfill before paid image/video calls", async () => {
    initializeProjectState(ctx, {
      user_preferences: {
        prompt: "Make a 6 second UGC ad.",
        duration_seconds: 6,
      },
    });
    const talking1 = makeScene({ id: "scene_1", narration: "Too short.", duration_seconds: 3, on_camera: true });
    const talking2 = makeScene({ id: "scene_2", narration: "Still short.", duration_seconds: 3, on_camera: true });
    seedPlanAndImages(ctx, [talking1, talking2]);

    const result = await generateVoiceoverImpl(ctx);

    expect(result.stage).toBe("voiceover_validation_failed");
    expect(result.next_tools).toEqual(["draft_video_plan"]);
    expect(result.issues.join(" ")).toContain("Measured scene coverage");
    expect(readJsonArtifact(ctx, "voiceover", null)).toBeNull();
  });

  it("asks for more narration when a global voiceover underfills the requested runtime", async () => {
    ctx = { ...ctx, audio_provider: "elevenlabs", audio_model: "eleven_multilingual_v2" };
    initializeProjectState(ctx, {
      user_preferences: {
        prompt: "Make a 30 second narrated story with no silent ending.",
        duration_seconds: 30,
      },
    });
    const broll = makeScene({
      id: "scene_1",
      narration: "A complete narrated story plays across the entire video.",
      duration_seconds: 30,
      on_camera: false,
    });
    seedPlanAndImages(ctx, [broll]);
    generateVoiceoverAsset.mockResolvedValue({
      path: path.join(ctx.project_dir, "voiceover", "voiceover.mp3"),
      duration_seconds: 20,
      target_duration_seconds: 30,
    });

    const result = await generateVoiceoverImpl(ctx);

    expect(result.stage).toBe("voiceover_validation_failed");
    expect(result.message).toContain("enough natural spoken narration");
    expect(result.message).not.toContain("shorter");
    expect(result.issues.join(" ")).toContain("73+ natural spoken words");
  });
});

describe("inspectRenderStatusImpl provider recovery routing", () => {
  it("routes mixed talking/b-roll projects to stitching without requesting a global voiceover", async () => {
    const talking = makeScene({ id: "scene_1", narration: "I talk", on_camera: true });
    const broll = makeScene({ id: "scene_2", narration: "proof voiceover", on_camera: false });
    seedPlanAndImages(ctx, [talking, broll]);
    writeJsonArtifact(ctx, "videos", [
      {
        scene_id: talking.id,
        path: path.join(ctx.project_dir, "videos", "scene_1", "talking", "output.mp4"),
        prompt: talking.video_prompt,
        model: "ai-talking-photo",
        resolution: ctx.resolution,
        audio: true,
        has_embedded_audio: true,
        on_camera: true,
        duration_seconds: 2.5,
        provider_job_id: "talk1",
        provider_url: null,
      },
      silentClipFor(ctx, broll),
    ]);
    writeJsonArtifact(ctx, "failed_scenes", []);

    const result = await inspectRenderStatusImpl(ctx);

    expect(result.next_tools).toContain("stitch_final_video");
    expect(result.next_tools).not.toContain("generate_voiceover");
  });

  it("prioritizes stitch-time provider recovery over fresh animation when a job id exists", async () => {
    const talking = makeScene({ id: "scene_1", narration: "I talk", on_camera: true });
    seedPlanAndImages(ctx, [talking]);
    writeJsonArtifact(ctx, "videos", []);
    writeJsonArtifact(ctx, "voiceover", {
      path: path.join(ctx.project_dir, "voiceover", "voiceover.mp3"),
      model: ctx.audio_model,
      duration_seconds: 2,
      target_duration_seconds: 2,
    });
    writeJsonArtifact(ctx, "failed_scenes", [
      {
        scene_id: "scene_1",
        stage: "talking",
        error: "poll stalled",
        provider_job_id: "talk1",
        provider_kind: "talking-photo",
        provider_stage: "talking",
        provider_model: "ai-talking-photo",
        audio_path: path.join(ctx.project_dir, "voiceover", "scenes", "scene_1.mp3"),
        audio_duration_seconds: 2,
      },
    ]);

    const result = await inspectRenderStatusImpl(ctx);

    expect(result.recoverable_failed_scene_count).toBe(1);
    expect(result.next_tools[0]).toBe("stitch_final_video");
    expect(result.next_tools).not.toContain("animate_scene_videos");
  });

  it("refuses first-run duplicate animation when a selected scene already has a recoverable provider job", async () => {
    const talking = makeScene({ id: "scene_1", narration: "I talk", on_camera: true });
    seedPlanAndImages(ctx, [talking]);
    writeJsonArtifact(ctx, "videos", []);
    writeJsonArtifact(ctx, "failed_scenes", [
      {
        scene_id: "scene_1",
        stage: "talking",
        error: "provider job timed out while still rendering",
        provider_job_id: "talk-timeout-1",
        provider_kind: "talking-photo",
        provider_stage: "talking",
        provider_model: "ai-talking-photo",
        audio_path: path.join(ctx.project_dir, "voiceover", "scenes", "scene_1.mp3"),
        audio_duration_seconds: 2,
      },
    ]);

    await expect(animateSceneVideosImpl(ctx, ["scene_1"])).rejects.toThrow(/duplicate provider render/i);
    expect(generateTalkingClip).not.toHaveBeenCalled();
    expect(generateVideoAssetsBatch).not.toHaveBeenCalled();
  });
});

describe("stitchFinalVideoImpl talking-project branch", () => {
  // A persisted lip-sync video entry as produced by Task 5.
  function talkingVideo(ctx: ProjectContext, scene: Scene) {
    return {
      scene_id: scene.id,
      path: path.join(ctx.project_dir, "videos", scene.id, "lipsync", "lipsync.mp4"),
      prompt: scene.video_prompt,
      model: ctx.video_model,
      resolution: ctx.resolution,
      audio: true,
      duration_seconds: 2.5,
      provider_job_id: "lip1",
      provider_url: null,
      has_embedded_audio: true,
      on_camera: true,
      audio_path: path.join(ctx.project_dir, "voiceover", "scenes", `${scene.id}.mp3`),
      audio_duration_seconds: 2.5,
    };
  }

  function fakeFinalVideo(ctx: ProjectContext): string {
    return path.join(ctx.project_dir, "final.mp4");
  }

  it("(a) routes a project with a talking scene through stitchMixedAssets with per-scene audio", async () => {
    const talking = makeScene({ id: "scene_1", narration: "I am talking", on_camera: true });
    const broll = makeScene({ id: "scene_2", narration: "voiceover only", on_camera: false });
    seedPlanAndImages(ctx, [talking, broll]);
    // Talking scene carries its own lip-sync audio; b-roll is a silent clip.
    writeJsonArtifact(ctx, "videos", [talkingVideo(ctx, talking), silentClipFor(ctx, broll)]);

    // b-roll cutaway gets a per-scene VO take.
    generateSceneVoiceovers.mockImplementation(async (_ctx, scenes: Scene[]) =>
      scenes.map((scene) => ({
        scene_id: scene.id,
        path: path.join(ctx.project_dir, "voiceover", "scenes", `${scene.id}.mp3`),
        duration_seconds: 1.5,
      })),
    );
    stitchMixedAssets.mockResolvedValue(fakeFinalVideo(ctx));
    probeMediaStreamDurations.mockResolvedValue({
      format_duration_seconds: 4,
      video_duration_seconds: 4,
      audio_duration_seconds: 4,
    });

    const manifest = await stitchFinalVideoImpl(ctx);

    // Routed through the audio-preserving per-section assembler.
    expect(stitchMixedAssets).toHaveBeenCalledTimes(1);
    const perScene = stitchMixedAssets.mock.calls[0]![1] as Array<Record<string, any>>;
    expect(stitchMixedAssets.mock.calls[0]![2]).toEqual({ target_duration_seconds: 4.5 });
    expect(perScene).toHaveLength(2);

    const talkingInput = perScene.find((s) => s.video_path.includes("lipsync"));
    expect(talkingInput).toBeTruthy();
    // If the transient mp3 sidecar is gone, talking clips reuse their own
    // embedded audio stream instead of regenerating TTS or failing the stitch.
    expect(talkingInput!.audio_path).toBe(path.join(ctx.project_dir, "videos", "scene_1", "lipsync", "lipsync.mp4"));
    expect(talkingInput!.audio_duration_seconds).toBe(2.5);

    const brollInput = perScene.find((s) => s.video_path === path.join(ctx.project_dir, "videos", "scene_2.mp4"));
    expect(brollInput).toBeTruthy();
    // b-roll cutaway gets a per-scene VO take.
    expect(brollInput!.audio_path).toBe(
      path.join(ctx.project_dir, "voiceover", "scenes", "scene_2.mp3"),
    );
    expect(brollInput!.audio_duration_seconds).toBe(1.5);
    expect(brollInput!.target_duration_seconds).toBe(2);

    // Per-scene VO generated only for the b-roll cutaway.
    expect(generateSceneVoiceovers).toHaveBeenCalledTimes(1);
    const voScenes = generateSceneVoiceovers.mock.calls[0]![1] as Scene[];
    expect(voScenes.map((s) => s.id)).toEqual(["scene_2"]);

    // Manifest points at the stitched final video.
    expect(manifest.final_video_path).toBe(fakeFinalVideo(ctx));
  });

  it("recovers a completed provider talking-photo job before declaring there are no videos to stitch", async () => {
    const talking = makeScene({ id: "scene_1", narration: "I am talking", on_camera: true });
    seedPlanAndImages(ctx, [talking]);
    writeJsonArtifact(ctx, "videos", []);
    writeJsonArtifact(ctx, "failed_scenes", [
      {
        scene_id: "scene_1",
        stage: "talking",
        error: "poll stalled",
        provider_job_id: "talk1",
        provider_kind: "talking-photo",
        provider_stage: "talking",
        provider_model: "ai-talking-photo",
        provider_resolution: ctx.resolution,
        prompt: talking.video_prompt,
        audio: true,
        duration_seconds: 2.5,
        audio_path: path.join(ctx.project_dir, "voiceover", "scenes", "scene_1.mp3"),
        audio_duration_seconds: 2.5,
        on_camera: true,
      },
    ]);
    recoverVideoAssetFromProviderJob.mockResolvedValue(talkingVideo(ctx, talking));
    stitchMixedAssets.mockResolvedValue(fakeFinalVideo(ctx));
    probeMediaStreamDurations.mockResolvedValue({
      format_duration_seconds: 2.5,
      video_duration_seconds: 2.5,
      audio_duration_seconds: 2.5,
    });

    const manifest = await stitchFinalVideoImpl(ctx);

    expect(recoverVideoAssetFromProviderJob).toHaveBeenCalledTimes(1);
    expect(stitchMixedAssets).toHaveBeenCalledTimes(1);
    expect(readJsonArtifact<any[]>(ctx, "failed_scenes", [])).toEqual([]);
    expect(manifest.final_video_path).toBe(fakeFinalVideo(ctx));
  });

  it("clears stale provider failures when the scene video is already complete", async () => {
    const talking = makeScene({ id: "scene_1", narration: "I am talking", on_camera: true });
    seedPlanAndImages(ctx, [talking]);
    writeJsonArtifact(ctx, "videos", [talkingVideo(ctx, talking)]);
    writeJsonArtifact(ctx, "failed_scenes", [
      {
        scene_id: "scene_1",
        stage: "talking",
        error: "old poll stalled",
        provider_job_id: "talk1",
        provider_kind: "talking-photo",
        provider_stage: "talking",
        audio_path: path.join(ctx.project_dir, "voiceover", "scenes", "scene_1.mp3"),
        audio_duration_seconds: 2.5,
        on_camera: true,
      },
    ]);
    stitchMixedAssets.mockResolvedValue(fakeFinalVideo(ctx));
    probeMediaStreamDurations.mockResolvedValue({
      format_duration_seconds: 2.5,
      video_duration_seconds: 2.5,
      audio_duration_seconds: 2.5,
    });

    const manifest = await stitchFinalVideoImpl(ctx);

    expect(recoverVideoAssetFromProviderJob).not.toHaveBeenCalled();
    expect(readJsonArtifact<any[]>(ctx, "failed_scenes", [])).toEqual([]);
    expect(manifest.render_status).toBe("complete");
    expect(manifest.failed_scene_count).toBe(0);
  });

  it("(b) a pure b-roll plan with no voiceover artifact still throws the voiceover-required error", async () => {
    const broll1 = makeScene({ id: "scene_1", narration: "vo one", on_camera: false });
    const broll2 = makeScene({ id: "scene_2", narration: "vo two", on_camera: false });
    seedPlanAndImages(ctx, [broll1, broll2]);
    writeJsonArtifact(ctx, "videos", [silentClipFor(ctx, broll1), silentClipFor(ctx, broll2)]);
    // No "voiceover" artifact seeded.

    await expect(stitchFinalVideoImpl(ctx)).rejects.toThrow(/voiceover/i);
    expect(stitchMixedAssets).not.toHaveBeenCalled();
  });

  it("(c) a talking-only plan with no voiceover artifact does NOT throw (guard relaxed)", async () => {
    const talking1 = makeScene({ id: "scene_1", narration: "I talk", on_camera: true });
    const talking2 = makeScene({ id: "scene_2", narration: "I also talk", on_camera: true });
    seedPlanAndImages(ctx, [talking1, talking2]);
    writeJsonArtifact(ctx, "videos", [talkingVideo(ctx, talking1), talkingVideo(ctx, talking2)]);
    // No global "voiceover" artifact, and no b-roll scenes, so no per-scene TTS.

    stitchMixedAssets.mockResolvedValue(fakeFinalVideo(ctx));
    probeMediaStreamDurations.mockResolvedValue({
      format_duration_seconds: 5,
      video_duration_seconds: 5,
      audio_duration_seconds: 5,
    });

    const manifest = await stitchFinalVideoImpl(ctx);

    expect(stitchMixedAssets).toHaveBeenCalledTimes(1);
    // All talking scenes reuse their own lip-sync audio; no per-scene VO needed.
    expect(generateSceneVoiceovers).not.toHaveBeenCalled();
    const perScene = stitchMixedAssets.mock.calls[0]![1] as Array<Record<string, any>>;
    expect(perScene.map((s) => s.audio_duration_seconds)).toEqual([2.5, 2.5]);
    expect(manifest.final_video_path).toBe(fakeFinalVideo(ctx));
  });
});

describe("restitchTimelineImpl talking-project audio-preserving path", () => {
  // A persisted lip-sync video entry (carries synced dialogue audio).
  function talkingVideo(ctx: ProjectContext, scene: Scene) {
    return {
      scene_id: scene.id,
      path: path.join(ctx.project_dir, "videos", scene.id, "lipsync", "lipsync.mp4"),
      prompt: scene.video_prompt,
      model: ctx.video_model,
      resolution: ctx.resolution,
      audio: true,
      duration_seconds: 2.5,
      provider_job_id: "lip1",
      provider_url: null,
      has_embedded_audio: true,
      on_camera: true,
      audio_path: path.join(ctx.project_dir, "voiceover", "scenes", `${scene.id}.mp3`),
      audio_duration_seconds: 2.5,
    };
  }

  it("re-stitches a talking project through the audio-preserving stitchMixedAssets path (not refused)", async () => {
    const talking = makeScene({ id: "scene_1", narration: "I am talking", on_camera: true });
    const broll = makeScene({ id: "scene_2", narration: "voiceover only", on_camera: false });
    seedPlanAndImages(ctx, [talking, broll]);
    writeJsonArtifact(ctx, "videos", [talkingVideo(ctx, talking), silentClipFor(ctx, broll)]);

    // b-roll cutaway gets a per-scene VO take during the mixed assembly.
    generateSceneVoiceovers.mockImplementation(async (_ctx, scenes: Scene[]) =>
      scenes.map((scene) => ({
        scene_id: scene.id,
        path: path.join(ctx.project_dir, "voiceover", "scenes", `${scene.id}.mp3`),
        duration_seconds: 1.5,
      })),
    );

    const fakeFinal = path.join(ctx.project_dir, "final.mp4");
    stitchMixedAssets.mockResolvedValue(fakeFinal);
    probeMediaStreamDurations.mockResolvedValue({
      format_duration_seconds: 4,
      video_duration_seconds: 4,
      audio_duration_seconds: 4,
    });

    const result = await restitchTimelineImpl(ctx, null, "user edited the timeline");

    // The re-stitch was NOT refused; it routed through the audio-preserving assembler,
    // which re-muxes each scene's own synced mp3 onto its clip.
    expect(result.stage).not.toBe("restitch_skipped");
    expect(stitchMixedAssets).toHaveBeenCalledTimes(1);
    expect(stitchMixedAssets.mock.calls[0]![2]).toEqual({ target_duration_seconds: 4.5 });
    // The non-audio-preserving b-roll stitch paths must NOT run for a talking project.
    expect(stitchTimelineAssets).not.toHaveBeenCalled();
    expect(stitchAssets).not.toHaveBeenCalled();

    // Produced a real manifest pointing at the freshly stitched final video.
    expect(result.project_id).toBe(ctx.project_id);
    expect(result.final_video_path).toBe(fakeFinal);
  });

  it("proceeds down the normal stitch path for a pure b-roll project", async () => {
    const broll1 = makeScene({ id: "scene_1", narration: "vo one", on_camera: false });
    const broll2 = makeScene({ id: "scene_2", narration: "vo two", on_camera: false });
    seedPlanAndImages(ctx, [broll1, broll2]);
    writeJsonArtifact(ctx, "videos", [silentClipFor(ctx, broll1), silentClipFor(ctx, broll2)]);
    // b-roll requires a global voiceover artifact.
    writeJsonArtifact(ctx, "voiceover", {
      path: path.join(ctx.project_dir, "voiceover", "voiceover.mp3"),
      model: ctx.audio_model,
      duration_seconds: 4,
      target_duration_seconds: 4,
    });

    const fakeFinal = path.join(ctx.project_dir, "final.mp4");
    stitchTimelineAssets.mockResolvedValue(fakeFinal);
    stitchAssets.mockResolvedValue(fakeFinal);
    probeMediaStreamDurations.mockResolvedValue({
      format_duration_seconds: 4,
      video_duration_seconds: 4,
      audio_duration_seconds: 4,
    });

    const manifest = await restitchTimelineImpl(ctx, null, "user edited the timeline");

    // Got past the guard: it did NOT short-circuit and produced a real manifest.
    expect(manifest.stage).not.toBe("restitch_skipped");
    expect(manifest.final_video_path).toBe(fakeFinal);
    // Reached one of the b-roll stitch paths (timeline or fallback), never the mixed one.
    expect(stitchTimelineAssets.mock.calls.length + stitchAssets.mock.calls.length).toBeGreaterThan(0);
    expect(stitchMixedAssets).not.toHaveBeenCalled();
  });
});

describe("replaceVoiceoverImpl voice-aware narration", () => {
  // The global voiceover rendered by replace_voiceover must use the
  // character-matched voice (via resolveVoiceReferenceId), not the env default,
  // so a female-character plan never gets re-voiced with the male default.
  const voiceoverAsset = (dir: string) => ({
    path: path.join(dir, "voiceover", "voiceover.mp3"),
    model: "stub-audio-model",
    duration_seconds: 4,
    target_duration_seconds: 4,
  });

  it("passes the gender-inferred default voice for a female-cued plan with voice:null", async () => {
    generateVoiceoverAsset.mockResolvedValue(voiceoverAsset(ctx.project_dir));
    const broll = makeScene({ id: "scene_1", narration: "voiceover only", on_camera: false });
    seedPlanAndImages(ctx, [broll], {
      voice: null,
      visual_bible: "She is a woman, a young female creator; her style is bold.",
    });

    await replaceVoiceoverImpl(ctx);

    expect(generateVoiceoverAsset).toHaveBeenCalledTimes(1);
    // 4th arg is the resolved referenceId.
    expect(generateVoiceoverAsset.mock.calls[0]![3]).toBe(FISH_AUDIO_VOICES.sarah!.reference_id);
  });

  it("passes the explicitly chosen voice's reference_id", async () => {
    generateVoiceoverAsset.mockResolvedValue(voiceoverAsset(ctx.project_dir));
    const broll = makeScene({ id: "scene_1", narration: "voiceover only", on_camera: false });
    seedPlanAndImages(ctx, [broll], {
      voice: "jasphina",
      visual_bible: "She is a woman, a young female creator; her style is bold.",
    });

    await replaceVoiceoverImpl(ctx);

    expect(generateVoiceoverAsset).toHaveBeenCalledTimes(1);
    expect(generateVoiceoverAsset.mock.calls[0]![3]).toBe(FISH_AUDIO_VOICES.jasphina!.reference_id);
  });
});
