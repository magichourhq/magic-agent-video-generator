import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectContext } from "../src/context.js";
// `withMediaUrl` (called at the end of the recovery impls) rejects asset paths
// outside OUTPUT_DIR, so the temp project dir must live under it.
import { OUTPUT_DIR } from "../src/config.js";
import type { Scene } from "../src/schemas.js";
import { FISH_AUDIO_VOICES } from "../src/voices.js";
import {
  makeScene,
  seedPlanImagesVideos,
  silentClipFor,
  talkingClipFor,
  testContext,
} from "./helpers/testFixtures.js";

// --- media.ts mock --------------------------------------------------------
// The recovery tools (`retrySceneWithModelsImpl` / `regenerateSceneImpl`) must
// re-render a scene's video through the SAME render mechanism the scene was
// authored with: on-camera scenes via `generateTalkingClip` (image + per-scene
// audio), b-roll via `generateVideoAsset` (silent imageToVideo). We stub those
// three render-boundary functions and keep every other export real.
const generateTalkingClip = vi.fn();
const generateVideoAsset = vi.fn();
const generateSceneVoiceovers = vi.fn();
// `regenerateSceneImpl` regenerates the keyframe image by default, so stub it to
// avoid touching a real image provider.
const generateImageAsset = vi.fn();

vi.mock("../src/media.js", async () => {
  const actual = await vi.importActual<typeof import("../src/media.js")>("../src/media.js");
  return {
    ...actual,
    generateTalkingClip,
    generateVideoAsset,
    generateSceneVoiceovers,
    generateImageAsset,
  };
});

// Imported AFTER vi.mock so the mocked media boundary is wired in.
const { retrySceneWithModelsImpl, regenerateSceneImpl, generateSceneImagesImpl } = await import("../src/workflows.js");
const { initializeProjectState, readJsonArtifact, updateProjectState, writeJsonArtifact } = await import("../src/renderState.js");

let projectDir: string;
let ctx: ProjectContext;

beforeEach(() => {
  projectDir = mkdtempSync(path.join(OUTPUT_DIR, "workflows-retry-"));
  ctx = testContext(projectDir, "workflows-retry-test");
  generateTalkingClip.mockReset();
  generateVideoAsset.mockReset();
  generateSceneVoiceovers.mockReset();
  generateImageAsset.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(projectDir, { recursive: true, force: true });
});

describe("retrySceneWithModelsImpl talking-aware video recovery", () => {
  it("retrying an on_camera scene's video re-renders via aiTalkingPhoto with the resolved voice (NOT silent imageToVideo)", async () => {
    const talking = makeScene({ id: "scene_1", narration: "I am talking", on_camera: true });
    // Female visual bible → the resolver picks the female-default (sarah) voice id.
    seedPlanImagesVideos(ctx, [talking], {
      visual_bible: "She is a woman, a young female creator.",
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

    await retrySceneWithModelsImpl(ctx, "scene_1", "video");

    // Per-scene TTS ran with the resolved (female-default) reference id.
    expect(generateSceneVoiceovers).toHaveBeenCalledTimes(1);
    const voScenes = generateSceneVoiceovers.mock.calls[0]![1] as Scene[];
    expect(voScenes.map((s) => s.id)).toEqual(["scene_1"]);
    expect(generateSceneVoiceovers.mock.calls[0]![2]).toBe(FISH_AUDIO_VOICES.sarah!.reference_id);

    // Talking clip rendered from the scene's IMAGE path + its per-scene audio.
    expect(generateTalkingClip).toHaveBeenCalledTimes(1);
    const [, talkScene, imagePath, audioPath, audioDuration] = generateTalkingClip.mock.calls[0]!;
    expect((talkScene as Scene).id).toBe("scene_1");
    expect(imagePath).toBe(path.join(ctx.project_dir, "images", "scene_1.png"));
    expect(audioPath).toBe(path.join(ctx.project_dir, "voiceover", "scenes", "scene_1.mp3"));
    expect(audioDuration).toBe(2.5);

    // The talking treatment is preserved — silent imageToVideo is NOT used.
    expect(generateVideoAsset).not.toHaveBeenCalled();

    // Persisted video carries the talking treatment.
    const videos = readJsonArtifact<any[]>(ctx, "videos", [])!;
    const persisted = videos.find((v) => v.scene_id === "scene_1");
    expect(persisted.model).toBe("ai-talking-photo");
    expect(persisted.on_camera).toBe(true);
    expect(persisted.has_embedded_audio).toBe(true);
    expect(persisted.path).toBe(path.join(ctx.project_dir, "videos", "scene_1", "talking", "talking.mp4"));
  });

  it("retrying a b-roll scene's video re-renders via silent imageToVideo (NOT aiTalkingPhoto)", async () => {
    const broll = makeScene({ id: "scene_1", narration: "voiceover only", on_camera: false });
    seedPlanImagesVideos(ctx, [broll]);

    generateVideoAsset.mockImplementation(async (_ctx, scene: Scene) => silentClipFor(ctx, scene));

    await retrySceneWithModelsImpl(ctx, "scene_1", "video");

    expect(generateVideoAsset).toHaveBeenCalledTimes(1);
    const [, brollScene] = generateVideoAsset.mock.calls[0]!;
    expect((brollScene as Scene).id).toBe("scene_1");
    expect(generateTalkingClip).not.toHaveBeenCalled();
    expect(generateSceneVoiceovers).not.toHaveBeenCalled();

    const videos = readJsonArtifact<any[]>(ctx, "videos", [])!;
    const persisted = videos.find((v) => v.scene_id === "scene_1");
    expect(persisted.has_embedded_audio).toBeUndefined();
    expect(persisted.path).toBe(path.join(ctx.project_dir, "videos", "scene_1.mp4"));
  });

  it("clears a stale prior 'talking' failure after a successful talking re-render", async () => {
    const talking = makeScene({ id: "scene_1", narration: "I am talking", on_camera: true });
    seedPlanImagesVideos(ctx, [talking]);
    // A prior render recorded a soft "talking" failure for this scene.
    writeJsonArtifact(ctx, "failed_scenes", [
      { scene_id: "scene_1", stage: "talking", error: "AI Talking Photo timed out" },
    ]);

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

    await retrySceneWithModelsImpl(ctx, "scene_1", "video");

    // The stale talking failure must be gone from the persisted artifact.
    const failures = readJsonArtifact<any[]>(ctx, "failed_scenes", [])!;
    expect(failures.some((f) => f.scene_id === "scene_1" && f.stage === "talking")).toBe(false);
  });

  it("on a hard talking-render failure, retry falls back to a silent imageToVideo clip so the scene still appears", async () => {
    const talking = makeScene({ id: "scene_1", narration: "I am talking", on_camera: true });
    seedPlanImagesVideos(ctx, [talking]);

    generateSceneVoiceovers.mockImplementation(async (_ctx, scenes: Scene[]) =>
      scenes.map((scene) => ({
        scene_id: scene.id,
        path: path.join(ctx.project_dir, "voiceover", "scenes", `${scene.id}.mp3`),
        duration_seconds: 2.5,
      })),
    );
    generateTalkingClip.mockRejectedValue(new Error("talking boom"));
    generateVideoAsset.mockImplementation(async (_ctx, scene: Scene) => silentClipFor(ctx, scene));

    await retrySceneWithModelsImpl(ctx, "scene_1", "video");

    expect(generateTalkingClip).toHaveBeenCalledTimes(1);
    expect(generateVideoAsset).toHaveBeenCalledTimes(1);
    const [, fallbackScene] = generateVideoAsset.mock.calls[0]!;
    expect((fallbackScene as Scene).id).toBe("scene_1");

    // The scene still appears, as the silent fallback clip.
    const videos = readJsonArtifact<any[]>(ctx, "videos", [])!;
    const persisted = videos.find((v) => v.scene_id === "scene_1");
    expect(persisted.path).toBe(path.join(ctx.project_dir, "videos", "scene_1.mp4"));
    expect(persisted.has_embedded_audio).toBeUndefined();
  });
});

describe("paid media preflight after voiceover failure", () => {
  it("blocks scene image generation when narrated audio failed", async () => {
    initializeProjectState(ctx);
    writeJsonArtifact(ctx, "plan", {
      title: "Narrated story",
      creative_vibe: "cinematic_commercial",
      narration: "A narrated historical story.",
      visual_bible: "Grounded archival footage.",
      voice: "energetic_male",
      scenes: [
        makeScene({
          id: "scene_1",
          narration: "The story begins here.",
          on_camera: false,
          duration_seconds: 10,
        }),
      ],
    });
    updateProjectState(ctx, {
      status: {
        stage: "voiceover_failed",
        progress: 30,
        message: "Voiceover generation failed.",
        error: "Audio provider authentication failed.",
      },
    });

    await expect(generateSceneImagesImpl(ctx)).rejects.toThrow("Audio provider authentication failed");
    expect(generateImageAsset).not.toHaveBeenCalled();
  });

  it("keeps visual provider calls blocked when a later status update hides the voiceover failure", async () => {
    initializeProjectState(ctx);
    writeJsonArtifact(ctx, "plan", {
      title: "Narrated story",
      creative_vibe: "cinematic_commercial",
      narration: "A narrated historical story.",
      visual_bible: "Grounded archival footage.",
      voice: "energetic_male",
      scenes: [
        makeScene({
          id: "scene_1",
          narration: "The story begins here.",
          on_camera: false,
          duration_seconds: 10,
        }),
      ],
    });
    updateProjectState(ctx, {
      status: {
        stage: "voiceover_failed",
        progress: 30,
        message: "Voiceover generation failed.",
        error: "Audio provider authentication failed.",
      },
      decision: {
        tool: "generate_voiceover",
        decision: "Voiceover provider failed before paid Magic Hour image/video calls.",
        metadata: { error: "Audio provider authentication failed." },
      },
    });
    updateProjectState(ctx, {
      status: {
        stage: "agent_working",
        progress: 35,
        message: "Agent continued processing.",
        error: null,
      },
      decision: {
        tool: "record_project_decision",
        decision: "Recorded a later orchestration update.",
      },
    });

    await expect(generateSceneImagesImpl(ctx)).rejects.toThrow("Audio provider authentication failed");
    expect(generateImageAsset).not.toHaveBeenCalled();
  });

  it("allows visual provider calls after a later successful voiceover decision", async () => {
    initializeProjectState(ctx);
    const scene = makeScene({
      id: "scene_1",
      narration: "The story begins here.",
      on_camera: false,
      duration_seconds: 10,
    });
    writeJsonArtifact(ctx, "plan", {
      title: "Narrated story",
      creative_vibe: "cinematic_commercial",
      narration: "A narrated historical story.",
      visual_bible: "Grounded archival footage.",
      voice: "energetic_male",
      scenes: [scene],
    });
    updateProjectState(ctx, {
      decision: {
        tool: "generate_voiceover",
        decision: "Voiceover provider failed before paid Magic Hour image/video calls.",
        metadata: { error: "Temporary audio failure." },
      },
    });
    updateProjectState(ctx, {
      voiceover: {
        path: path.join(ctx.project_dir, "voiceover", "voiceover.mp3"),
        duration_seconds: 9,
      },
      status: {
        stage: "voiceover_generated",
        progress: 30,
        message: "Voiceover generated.",
        error: null,
      },
      decision: {
        tool: "generate_voiceover",
        decision: "Generated voiceover for the saved narration.",
      },
    });
    generateImageAsset.mockImplementation(async () => ({
      scene_id: scene.id,
      path: path.join(ctx.project_dir, "images", `${scene.id}.png`),
      prompt: scene.image_prompt,
      model: ctx.image_model,
      resolution: ctx.image_resolution,
      style_tool: ctx.image_style_tool,
      provider_job_id: null,
      provider_url: null,
    }));

    await expect(generateSceneImagesImpl(ctx)).resolves.toMatchObject({ stage: "images_generated" });
    expect(generateImageAsset).toHaveBeenCalledTimes(1);
  });

  it("blocks an automatic paid retry for a scene image that already failed in the first run", async () => {
    initializeProjectState(ctx);
    const scene = makeScene({ id: "scene_1", narration: "", on_camera: false, duration_seconds: 10 });
    writeJsonArtifact(ctx, "plan", {
      title: "Single-pass image test",
      creative_vibe: "cinematic_commercial",
      narration: "",
      visual_bible: "One coherent visual world.",
      voice: null,
      scenes: [scene],
    });
    writeJsonArtifact(ctx, "failed_scenes", [
      { scene_id: "scene_1", stage: "image_generation", error: "Provider moderation failure." },
    ]);

    await expect(generateSceneImagesImpl(ctx)).rejects.toThrow("Automatic paid retries are disabled");
    expect(generateImageAsset).not.toHaveBeenCalled();
  });
});

describe("scene keyframe continuity references", () => {
  it("keeps an explicitly selected image model when the agent requests a different one", async () => {
    ctx = { ...ctx, image_model: "nano-banana-2-lite" };
    initializeProjectState(ctx, {
      user_preferences: {
        prompt: "Create one coherent scene.",
        workflow: "generated",
        image_model: "nano-banana-2-lite",
      },
    });
    const onlyScene = makeScene({ id: "scene_1", on_camera: false });
    writeJsonArtifact(ctx, "plan", {
      title: "Explicit provider model",
      creative_vibe: "cinematic_commercial",
      narration: "",
      visual_bible: "One coherent world.",
      voice: "ethan",
      scenes: [onlyScene],
    });
    generateImageAsset.mockImplementation(async (assetCtx, scene: Scene) => ({
      scene_id: scene.id,
      path: path.join(ctx.project_dir, "images", `${scene.id}.png`),
      prompt: scene.image_prompt,
      model: assetCtx.image_model,
      resolution: assetCtx.image_resolution,
      style_tool: assetCtx.image_style_tool,
      provider_job_id: null,
      provider_url: null,
    }));

    await generateSceneImagesImpl(ctx, null, { model: "nano-banana-2" });

    expect(generateImageAsset.mock.calls[0]![0].image_model).toBe("nano-banana-2-lite");
  });

  it("chains same-world continuity and keeps canonical identity across a time jump", async () => {
    initializeProjectState(ctx);
    const first = makeScene({
      id: "scene_1",
      on_camera: false,
      continuity: {
        story_beat: "Joseph sweeps beneath the window.",
        required_subjects: ["Joseph Figlock"],
        opening_state: "Joseph stands beneath the brick tenement window.",
        closing_state: "Joseph remains beneath the window and looks upward.",
        setting: "Detroit sidewalk beneath the brick tenement, daytime.",
        screen_direction: "stationary",
      },
    });
    const second = makeScene({
      id: "scene_2",
      on_camera: false,
      continuity: {
        story_beat: "Joseph catches the descending baby.",
        required_subjects: ["Joseph Figlock", "bundled baby"],
        opening_state: "Joseph remains beneath the same window with the baby above him.",
        closing_state: "Joseph holds the bundled baby safely.",
        setting: "Same Detroit sidewalk beneath the brick tenement, daytime.",
        screen_direction: "stationary",
      },
    });
    const third = makeScene({
      id: "scene_3",
      on_camera: false,
      continuity: {
        story_beat: "One year later Joseph starts work in another alley.",
        required_subjects: ["Joseph Figlock"],
        opening_state: "One year later Joseph enters a narrow alley.",
        closing_state: "Joseph sweeps alone in the alley.",
        setting: "Narrow Detroit alley, one year later.",
        screen_direction: "stationary",
      },
    });
    writeJsonArtifact(ctx, "plan", {
      title: "Historical continuity",
      creative_vibe: "cinematic_commercial",
      narration: "",
      visual_bible: "One consistent Joseph in a black-and-white 1930s Detroit world.",
      voice: "ethan",
      scenes: [first, second, third],
    });
    const referencesByScene = new Map<string, string[]>();
    generateImageAsset.mockImplementation(async (_ctx, scene: Scene, references: string[]) => {
      referencesByScene.set(scene.id, references);
      return {
        scene_id: scene.id,
        path: path.join(ctx.project_dir, "images", `${scene.id}.png`),
        prompt: scene.image_prompt,
        model: ctx.image_model,
        resolution: ctx.image_resolution,
        style_tool: ctx.image_style_tool,
        provider_job_id: null,
        provider_url: null,
      };
    });

    await generateSceneImagesImpl(ctx);

    expect(referencesByScene.get("scene_1")).toEqual([]);
    expect(referencesByScene.get("scene_2")).toEqual([
      path.join(ctx.project_dir, "images", "scene_1.png"),
    ]);
    expect(referencesByScene.get("scene_3")).toEqual([
      path.join(ctx.project_dir, "images", "scene_1.png"),
    ]);
    const thirdPrompt = generateImageAsset.mock.calls.find((call) => call[1].id === "scene_3")?.[1].image_prompt ?? "";
    expect(thirdPrompt).toContain("preserve only the recurring subject's exact identity");
    expect(thirdPrompt).toContain("do not copy the reference background");
  });

  it("keeps independent scenes parallel while a direct continuation waits for its reference", async () => {
    initializeProjectState(ctx);
    const first = makeScene({
      id: "scene_1",
      on_camera: false,
      continuity: {
        story_beat: "Joseph begins sweeping beneath the window.",
        required_subjects: ["Joseph"],
        opening_state: "Joseph stands beneath the tenement window.",
        closing_state: "Joseph looks upward beneath the window.",
        setting: "Detroit tenement sidewalk, morning.",
        screen_direction: "stationary",
      },
    });
    const continuation = makeScene({
      id: "scene_2",
      on_camera: false,
      continuity: {
        story_beat: "Joseph remains beneath the same window.",
        required_subjects: ["Joseph", "baby"],
        opening_state: "Joseph remains beneath the same window with a baby above him.",
        closing_state: "Joseph catches the baby.",
        setting: "Same Detroit tenement sidewalk, morning.",
        screen_direction: "stationary",
      },
    });
    const independent = makeScene({
      id: "scene_3",
      on_camera: false,
      continuity: {
        story_beat: "One year later a different worker enters another alley.",
        required_subjects: ["different worker"],
        opening_state: "One year later a different worker enters a narrow alley.",
        closing_state: "The different worker begins sweeping the alley.",
        setting: "Different Detroit alley, one year later.",
        screen_direction: "stationary",
      },
    });
    writeJsonArtifact(ctx, "plan", {
      title: "Parallel continuity",
      creative_vibe: "cinematic_commercial",
      narration: "",
      visual_bible: "One consistent Joseph in 1930s Detroit.",
      voice: "ethan",
      scenes: [first, continuation, independent],
    });

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: string[] = [];
    generateImageAsset.mockImplementation(async (_ctx, scene: Scene) => {
      started.push(scene.id);
      if (scene.id === "scene_1") await firstGate;
      return {
        scene_id: scene.id,
        path: path.join(ctx.project_dir, "images", `${scene.id}.png`),
        prompt: scene.image_prompt,
        model: ctx.image_model,
        resolution: ctx.image_resolution,
        style_tool: ctx.image_style_tool,
        provider_job_id: null,
        provider_url: null,
      };
    });

    const generation = generateSceneImagesImpl(ctx);
    await vi.waitFor(() => expect(started).toContain("scene_3"));
    expect(started).not.toContain("scene_2");
    releaseFirst();
    await generation;
    expect(started).toContain("scene_2");
  });
});

describe("regenerateSceneImpl talking-aware video recovery", () => {
  it("regenerating an on_camera scene re-renders the video via aiTalkingPhoto (preserves the talking treatment)", async () => {
    const talking = makeScene({ id: "scene_1", narration: "I am talking", on_camera: true });
    seedPlanImagesVideos(ctx, [talking], { voice: "jasphina" });

    generateImageAsset.mockImplementation(async (_ctx, scene: Scene) => ({
      scene_id: scene.id,
      path: path.join(ctx.project_dir, "images", `${scene.id}.png`),
      prompt: scene.image_prompt,
      model: ctx.image_model,
      resolution: ctx.image_resolution,
      style_tool: ctx.image_style_tool,
      provider_job_id: null,
      provider_url: null,
    }));
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

    await regenerateSceneImpl(ctx, "scene_1");

    // Resolved to the explicitly chosen catalog voice.
    expect(generateSceneVoiceovers).toHaveBeenCalledTimes(1);
    expect(generateSceneVoiceovers.mock.calls[0]![2]).toBe(FISH_AUDIO_VOICES.jasphina!.reference_id);

    expect(generateTalkingClip).toHaveBeenCalledTimes(1);
    expect(generateVideoAsset).not.toHaveBeenCalled();

    const videos = readJsonArtifact<any[]>(ctx, "videos", [])!;
    const persisted = videos.find((v) => v.scene_id === "scene_1");
    expect(persisted.model).toBe("ai-talking-photo");
    expect(persisted.on_camera).toBe(true);
    expect(persisted.has_embedded_audio).toBe(true);
  });

  it("clears a stale prior 'talking' failure after a successful regenerate", async () => {
    const talking = makeScene({ id: "scene_1", narration: "I am talking", on_camera: true });
    seedPlanImagesVideos(ctx, [talking]);
    writeJsonArtifact(ctx, "failed_scenes", [
      { scene_id: "scene_1", stage: "talking", error: "AI Talking Photo timed out" },
    ]);

    generateImageAsset.mockImplementation(async (_ctx, scene: Scene) => ({
      scene_id: scene.id,
      path: path.join(ctx.project_dir, "images", `${scene.id}.png`),
      prompt: scene.image_prompt,
      model: ctx.image_model,
      resolution: ctx.image_resolution,
      style_tool: ctx.image_style_tool,
      provider_job_id: null,
      provider_url: null,
    }));
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

    await regenerateSceneImpl(ctx, "scene_1");

    const failures = readJsonArtifact<any[]>(ctx, "failed_scenes", [])!;
    expect(failures.some((f) => f.scene_id === "scene_1" && f.stage === "talking")).toBe(false);
  });

  it("regenerating a b-roll scene re-renders the video via silent imageToVideo (NOT aiTalkingPhoto)", async () => {
    const broll = makeScene({ id: "scene_1", narration: "voiceover only", on_camera: false });
    seedPlanImagesVideos(ctx, [broll]);

    generateImageAsset.mockImplementation(async (_ctx, scene: Scene) => ({
      scene_id: scene.id,
      path: path.join(ctx.project_dir, "images", `${scene.id}.png`),
      prompt: scene.image_prompt,
      model: ctx.image_model,
      resolution: ctx.image_resolution,
      style_tool: ctx.image_style_tool,
      provider_job_id: null,
      provider_url: null,
    }));
    generateVideoAsset.mockImplementation(async (_ctx, scene: Scene) => silentClipFor(ctx, scene));

    await regenerateSceneImpl(ctx, "scene_1");

    expect(generateVideoAsset).toHaveBeenCalledTimes(1);
    expect(generateImageAsset.mock.calls[0]![1].image_prompt).toContain("Single unbroken photorealistic keyframe");
    expect(generateVideoAsset.mock.calls[0]![1].video_prompt).toContain(
      "Animate the supplied keyframe as one physically continuous shot",
    );
    expect(generateTalkingClip).not.toHaveBeenCalled();
    expect(generateSceneVoiceovers).not.toHaveBeenCalled();
  });
});
