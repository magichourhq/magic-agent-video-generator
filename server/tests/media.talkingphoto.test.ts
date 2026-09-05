import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectContext } from "../src/context.js";
import { makeScene, makeSilentVideo, makeTone, testContext as createTestContext } from "./helpers/testFixtures.js";

// Mock the Magic Hour SDK boundary. `media.ts` constructs `new Client(...)`
// inside the module-private `magicHourClient(ctx)`, so stubbing the `Client`
// class lets us spy on `v1.aiTalkingPhoto.generate` without hitting the network.
const aiTalkingPhotoGenerate = vi.fn();
const videoProjectsGet = vi.fn();
vi.mock("magic-hour", () => {
  return {
    Client: class {
      v1 = { aiTalkingPhoto: { generate: aiTalkingPhotoGenerate }, videoProjects: { get: videoProjectsGet } };
    },
  };
});

// Imported AFTER vi.mock so the mocked `magic-hour` is wired in.
const { generateTalkingClip } = await import("../src/media.js");

async function makeImage(pathname: string) {
  await execa("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=320x180:d=1",
    "-frames:v",
    "1",
    pathname,
  ]);
}

function testContext(projectDir: string): ProjectContext {
  return createTestContext(projectDir, "media-talkingphoto-test");
}

describe("generateTalkingClip", () => {
  afterEach(() => {
    aiTalkingPhotoGenerate.mockReset();
    videoProjectsGet.mockReset();
    vi.restoreAllMocks();
  });

  it("calls v1.aiTalkingPhoto.generate with image+audio / realistic mode and returns a labeled asset", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "media-talkingphoto-"));
    const imageFile = path.join(dir, "keyframe.png");
    const audio = path.join(dir, "scene.mp3");
    const fixtureOutput = path.join(dir, "talking_fixture.mp4");
    await makeImage(imageFile);
    await makeTone(audio, 2);
    await makeSilentVideo(fixtureOutput, 2);

    const audioDuration = 2.0;

    // Simulate the SDK completing the job AND landing the downloaded file in
    // the requested download directory, so `ensureProviderOutputDownloaded`
    // (via `pickDownload`) finds a real fixture mp4 on disk.
    aiTalkingPhotoGenerate.mockImplementation(async (_request: any, opts: any) => {
      const downloadDir: string = opts.downloadDirectory;
      mkdirSync(downloadDir, { recursive: true });
      const landed = path.join(downloadDir, "talking.mp4");
      copyFileSync(fixtureOutput, landed);
      return { id: "p1", status: "queued" };
    });
    videoProjectsGet.mockResolvedValue({ id: "p1", status: "complete", downloads: [{ url: "https://example.test/t.mp4" }] });

    const scene = makeScene({
      id: "scene_3",
      narration: "hello there",
      video_prompt: "a person speaking",
      on_camera: true,
    });

    const asset = await generateTalkingClip(testContext(dir), scene, imageFile, audio, audioDuration);

    // --- Request shape assertions ---
    expect(aiTalkingPhotoGenerate).toHaveBeenCalledTimes(1);
    const [request] = aiTalkingPhotoGenerate.mock.calls[0]!;
    expect(request.assets.imageFilePath).toBe(path.resolve(imageFile));
    expect(request.assets.audioFilePath).toBe(path.resolve(audio));
    expect(request.startSeconds).toBe(0);
    expect(request.endSeconds).toBe(audioDuration);
    expect(request.style.generationMode).toBe("realistic");
    expect(aiTalkingPhotoGenerate.mock.calls[0]![1].waitForCompletion).toBe(false);
    expect(videoProjectsGet).toHaveBeenCalledWith({ id: "p1" });
    // Lip-sync-only / forbidden fields must never be sent.
    expect(request.assets).not.toHaveProperty("videoFilePath");
    expect(request.assets).not.toHaveProperty("videoSource");
    expect(request).not.toHaveProperty("videoFilePath");
    expect(request).not.toHaveProperty("videoSource");
    expect(request).not.toHaveProperty("resolution");
    expect(request).not.toHaveProperty("maxResolution");
    expect(request).not.toHaveProperty("height");
    expect(request).not.toHaveProperty("width");

    // --- Returned asset assertions ---
    expect(asset.path).toBe(path.join(dir, "videos", "scene_3", "talking", "talking.mp4"));
    expect(asset.has_embedded_audio).toBe(true);
    expect(asset.on_camera).toBe(true);
    expect(asset.audio_path).toBe(path.resolve(audio));
    expect(asset.audio_duration_seconds).toBe(Math.round(audioDuration * 1000) / 1000);
    expect(asset.scene_id).toBe("scene_3");
    expect(asset.audio).toBe(true);
  });

  it("does not resubmit a paid talking-photo job when status polling has a transient 502", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "media-talkingphoto-"));
    const imageFile = path.join(dir, "keyframe.png");
    const audio = path.join(dir, "scene.mp3");
    const fixtureOutput = path.join(dir, "talking_fixture.mp4");
    await makeImage(imageFile);
    await makeTone(audio, 2);
    await makeSilentVideo(fixtureOutput, 2);

    const audioDuration = 2.0;

    aiTalkingPhotoGenerate.mockImplementation(async (_request: any, opts: any) => {
      const downloadDir: string = opts.downloadDirectory;
      mkdirSync(downloadDir, { recursive: true });
      const landed = path.join(downloadDir, "talking.mp4");
      copyFileSync(fixtureOutput, landed);
      return { id: "p1", status: "queued" };
    });
    videoProjectsGet
      .mockRejectedValueOnce(Object.assign(new Error("502 was returned from get /v1/video-projects/x"), { status: 502 }))
      .mockResolvedValueOnce({ id: "p1", status: "complete", downloads: [{ url: "https://example.test/t.mp4" }] });

    const scene = makeScene({
      id: "scene_3",
      narration: "hello there",
      video_prompt: "a person speaking",
      on_camera: true,
    });

    // Fake timers so the backoff sleep does not actually delay the test.
    vi.useFakeTimers();
    try {
      const pending = generateTalkingClip(testContext(dir), scene, imageFile, audio, audioDuration);
      await vi.runAllTimersAsync();
      const asset = await pending;

      expect(aiTalkingPhotoGenerate).toHaveBeenCalledTimes(1);
      expect(videoProjectsGet).toHaveBeenCalledTimes(2);
      expect(asset.path).toBe(path.join(dir, "videos", "scene_3", "talking", "talking.mp4"));
      expect(asset.has_embedded_audio).toBe(true);
      expect(asset.on_camera).toBe(true);
      expect(asset.audio).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a non-transient error (400) and rejects after a single call", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "media-talkingphoto-"));
    const imageFile = path.join(dir, "keyframe.png");
    const audio = path.join(dir, "scene.mp3");
    await makeImage(imageFile);
    await makeTone(audio, 2);

    aiTalkingPhotoGenerate.mockRejectedValue(
      Object.assign(new Error("400 bad request"), { status: 400 }),
    );

    const scene = makeScene({ id: "scene_3", narration: "hi", video_prompt: "speaking" });

    await expect(generateTalkingClip(testContext(dir), scene, imageFile, audio, 2.0)).rejects.toThrow(
      "400 bad request",
    );
    expect(aiTalkingPhotoGenerate).toHaveBeenCalledTimes(1);
    expect(videoProjectsGet).not.toHaveBeenCalled();
  });
});
