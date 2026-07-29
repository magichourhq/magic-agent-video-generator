import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { decode as msgpackDecode } from "@msgpack/msgpack";
import { execa } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectContext } from "../src/context.js";
import { PROJECT_CONTEXT_DEFAULTS } from "../src/context.js";
import { DEFAULT_HUME_UGC_VOICE_DESCRIPTION } from "../src/voices.js";
import {
  isTransientProviderError,
  magicHourPollRequestAttempts,
  magicHourPollRequestTimeoutMs,
  plannedFinalDurationSeconds,
  probeMediaDuration,
  probeMediaStreamDurations,
} from "../src/media.js";
import {
  anyEmbeddedAudio,
  conformVoiceoverToTarget,
  generateVoiceoverAsset,
  generateSceneVoiceovers,
  stitchAssetsPerSection,
  stitchMixedAssets,
  stitchTimelineAssets,
} from "../src/media.js";
import type { Scene, VideoPlan } from "../src/schemas.js";

describe("provider polling guards", () => {
  afterEach(() => {
    delete process.env.MAGIC_HOUR_POLL_REQUEST_TIMEOUT_MS;
    delete process.env.MAGIC_HOUR_POLL_REQUEST_ATTEMPTS;
  });

  it("classifies status codes and network timeouts as transient provider errors", () => {
    expect(isTransientProviderError(Object.assign(new Error("502 was returned"), { status: 502 }))).toBe(true);
    expect(isTransientProviderError(Object.assign(new Error("socket reset"), { code: "ECONNRESET" }))).toBe(true);
    expect(isTransientProviderError(Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" }))).toBe(true);
    expect(isTransientProviderError(Object.assign(new Error("bad request"), { status: 400 }))).toBe(false);
  });

  it("keeps a bounded per-request timeout and request failure budget", () => {
    process.env.MAGIC_HOUR_POLL_REQUEST_TIMEOUT_MS = "10";
    process.env.MAGIC_HOUR_POLL_REQUEST_ATTEMPTS = "0";
    expect(magicHourPollRequestTimeoutMs()).toBe(5000);
    expect(magicHourPollRequestAttempts()).toBe(1);
  });
});

async function makeSilentVideo(pathname: string, seconds: number) {
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

async function makeTone(pathname: string, seconds: number) {
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

function testContext(projectDir: string): ProjectContext {
  return {
    project_id: "media-duration-test",
    project_dir: projectDir,
    aspect_ratio: "16:9",
    resolution: "720p",
    ...PROJECT_CONTEXT_DEFAULTS,
  };
}

function fishTestContext(projectDir: string): ProjectContext {
  return {
    ...testContext(projectDir),
    audio_provider: "fish",
    audio_model: "s2.1-pro",
    fish_audio_api_key: "test-fish-key",
    fish_audio_reference_id: "ENV_REF_DEFAULT",
  };
}

describe("stitchAssetsPerSection", () => {
  it("rejects final target underfill instead of freeze-padding the last frame", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "media-duration-"));
    const video = path.join(dir, "scene.mp4");
    const audio = path.join(dir, "scene.mp3");
    await makeSilentVideo(video, 1);
    await makeTone(audio, 1);

    await expect(
      stitchAssetsPerSection(
        testContext(dir),
        [{ video_path: video, audio_path: audio, audio_duration_seconds: 1 }],
        { target_duration_seconds: 3 },
      ),
    ).rejects.toThrow(/will not freeze-pad/);
  });

  it("preserves a b-roll section target when its narration is shorter", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "media-section-target-"));
    const video = path.join(dir, "scene.mp4");
    const audio = path.join(dir, "scene.mp3");
    await makeSilentVideo(video, 2);
    await makeTone(audio, 1);

    const final = await stitchAssetsPerSection(testContext(dir), [
      {
        video_path: video,
        audio_path: audio,
        audio_duration_seconds: 1,
        target_duration_seconds: 2,
      },
    ]);
    const streams = await probeMediaStreamDurations(final);

    expect(streams.format_duration_seconds).toBeGreaterThanOrEqual(1.9);
    expect(streams.format_duration_seconds).toBeLessThanOrEqual(2.2);
    expect(streams.audio_duration_seconds).toBeGreaterThanOrEqual(1.9);
  });
});

describe("plannedFinalDurationSeconds", () => {
  it("uses hard-cut timing without subtracting transition overlap", () => {
    expect(
      plannedFinalDurationSeconds([
        { duration_seconds: 10 },
        { duration_seconds: 15 },
        { duration_seconds: 5 },
      ]),
    ).toBe(30);
  });
});

describe("conformVoiceoverToTarget", () => {
  it("pitch-preservingly fits a small TTS overrun to the exact requested duration", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "media-voiceover-conform-"));
    const audio = path.join(dir, "voiceover.mp3");
    await makeTone(audio, 3.1);

    const duration = await conformVoiceoverToTarget(testContext(dir), audio, 3);

    expect(duration).toBeGreaterThanOrEqual(2.9);
    expect(duration).toBeLessThanOrEqual(3.15);
    expect(await probeMediaDuration(audio)).toBeLessThanOrEqual(3.15);
  });

  it("leaves a materially overlong voiceover for plan validation to reject", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "media-voiceover-too-long-"));
    const audio = path.join(dir, "voiceover.mp3");
    await makeTone(audio, 3.5);

    const duration = await conformVoiceoverToTarget(testContext(dir), audio, 3);

    expect(duration).toBeGreaterThan(3.25);
    expect(await probeMediaDuration(audio)).toBeGreaterThan(3.25);
  });

  it("leaves a natural ending margin instead of allowing a near-target tail to be mux-trimmed", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "media-voiceover-end-margin-"));
    const audio = path.join(dir, "voiceover.mp3");
    await makeTone(audio, 3.05);

    const duration = await conformVoiceoverToTarget(testContext(dir), audio, 3);

    expect(duration).toBeLessThan(3);
    expect(duration).toBeGreaterThanOrEqual(2.9);
  });
});

function makeScene(overrides: Partial<Scene> & Pick<Scene, "id">): Scene {
  return {
    narration: "",
    image_prompt: "",
    video_prompt: "",
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

describe("generateSceneVoiceovers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keys voiceovers by the real scene.id and writes them under voiceover/scenes/", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "media-scene-vo-"));

    // fishAudioTts POSTs to Fish Audio then probes the written bytes with
    // ffprobe, so the stubbed fetch must return a REAL audio buffer (>=1024
    // bytes, >=0.5s) or the probe step rejects.
    const tone = path.join(dir, "tone.mp3");
    await makeTone(tone, 2);
    const toneBytes = readFileSync(tone);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(toneBytes, { status: 200 })),
    );

    const result = await generateSceneVoiceovers(fishTestContext(dir), [
      makeScene({
        id: "scene_7",
        narration: "hello",
        duration_seconds: 2,
        on_camera: true,
      }),
    ]);

    expect(result).toHaveLength(1);
    const [item] = result;
    expect(item!.scene_id).toBe("scene_7");
    expect(item!.path).toContain(path.join("voiceover", "scenes"));
    expect(item!.path.endsWith(`scene_7.${PROJECT_CONTEXT_DEFAULTS.audio_format}`)).toBe(true);
    expect(item!.duration_seconds).toBeGreaterThan(0);
    // The probed duration reflects the real audio buffer we returned (~2s).
    expect(await probeMediaDuration(item!.path)).toBeGreaterThan(0);
  });

  it("preserves existing scene voiceovers when generating another scene", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "media-scene-vo-preserve-"));
    const tone = path.join(dir, "tone.mp3");
    await makeTone(tone, 2);
    const toneBytes = readFileSync(tone);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(toneBytes, { status: 200 })),
    );

    const ctx = fishTestContext(dir);
    const [first] = await generateSceneVoiceovers(ctx, [makeScene({ id: "scene_1", narration: "first line" })]);
    const [second] = await generateSceneVoiceovers(ctx, [makeScene({ id: "scene_2", narration: "second line" })]);

    expect(first?.path).toBeTruthy();
    expect(second?.path).toBeTruthy();
    expect(existsSync(first!.path)).toBe(true);
    expect(existsSync(second!.path)).toBe(true);
  });

  it("throws when a scene has blank narration", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "media-scene-vo-blank-"));
    await expect(
      generateSceneVoiceovers(testContext(dir), [makeScene({ id: "scene_1", narration: "   " })]),
    ).rejects.toThrow(/No narration for scene/);
  });

  it("sends an explicit referenceId override to Fish Audio", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "media-scene-vo-ref-"));
    const tone = path.join(dir, "tone.mp3");
    await makeTone(tone, 2);
    const toneBytes = readFileSync(tone);

    const bodies: Uint8Array[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: any, init: any) => {
        bodies.push(new Uint8Array(init.body));
        return new Response(toneBytes, { status: 200 });
      }),
    );

    await generateSceneVoiceovers(
      fishTestContext(dir),
      [makeScene({ id: "scene_1", narration: "hello" })],
      "CUSTOM_REF_123",
    );

    expect(bodies).toHaveLength(1);
    const decoded = msgpackDecode(bodies[0]!) as { reference_id: string };
    expect(decoded.reference_id).toBe("CUSTOM_REF_123");
  });

  it("defaults to the context reference_id when no override is given", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "media-scene-vo-default-"));
    const tone = path.join(dir, "tone.mp3");
    await makeTone(tone, 2);
    const toneBytes = readFileSync(tone);

    const bodies: Uint8Array[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: any, init: any) => {
        bodies.push(new Uint8Array(init.body));
        return new Response(toneBytes, { status: 200 });
      }),
    );

    const ctx = { ...fishTestContext(dir), fish_audio_reference_id: "ENV_REF_DEFAULT" };
    await generateSceneVoiceovers(ctx, [makeScene({ id: "scene_1", narration: "hello [pause] there" })]);

    expect(bodies).toHaveLength(1);
    const decoded = msgpackDecode(bodies[0]!) as { reference_id: string; text: string };
    expect(decoded.reference_id).toBe("ENV_REF_DEFAULT");
    expect(decoded.text).toBe("hello there");
  });

  it("can route scene voiceovers through Hume Octave", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "media-scene-vo-hume-"));
    const tone = path.join(dir, "tone.mp3");
    await makeTone(tone, 2);
    const toneBytes = readFileSync(tone);
    const bodies: any[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init: any) => {
        bodies.push(JSON.parse(String(init.body)));
        expect(String(url)).toBe("https://api.hume.ai/v0/tts");
        expect(init.headers["X-Hume-Api-Key"]).toBe("test-hume-key");
        return new Response(
          JSON.stringify({
            generations: [
              {
                audio: toneBytes.toString("base64"),
                duration: 2,
                encoding: { format: "mp3", sample_rate: 48000 },
              },
            ],
            request_id: "req_test",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const ctx: ProjectContext = {
      ...testContext(dir),
      audio_provider: "hume",
      audio_model: "octave-1",
      hume_api_key: "test-hume-key",
      hume_voice_description: "Energetic, normal UGC creator voice.",
    };
    const [item] = await generateSceneVoiceovers(ctx, [
      makeScene({
        id: "scene_1",
        narration: "Okay [long pause] this is actually useful.",
        audio_mode: "urgent_reaction",
        audio_note: "surprised but clear",
      }),
    ]);

    expect(item!.provider).toBe("hume");
    expect(item!.model).toBe("octave-1");
    expect(existsSync(item!.path)).toBe(true);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].utterances[0].description).toContain("Energetic, normal UGC creator voice.");
    expect(bodies[0].utterances[0].description).toContain("urgent excited reaction");
    expect(bodies[0].utterances[0].description).toContain("surprised but clear");
    expect(bodies[0].utterances[0].description).toContain("Speak only the provided words");
    expect(bodies[0].utterances[0].description.length).toBeLessThanOrEqual(1000);
    expect(bodies[0].utterances[0].text).toBe("Okay this is actually useful.");
    expect(bodies[0].utterances[0].speed).toBe(1.15);
    expect(bodies[0].utterances[0].trailing_silence).toBe(0);
    expect(bodies[0].temperature).toBe(0.86);
    expect(bodies[0].version).toBe("1");
    expect(bodies[0].num_generations).toBe(1);
    expect(bodies[0].split_utterances).toBe(true);
    expect(bodies[0].format.type).toBe("mp3");
    expect(item!.audio_mode).toBe("urgent_reaction");
    expect(item!.tts_speed).toBe(1.15);
  });

  it("falls back from Hume zero credits to Fish using the resolved voice reference", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "media-scene-vo-hume-fish-fallback-"));
    const tone = path.join(dir, "tone.mp3");
    await makeTone(tone, 2);
    const toneBytes = readFileSync(tone);
    const fishBodies: Uint8Array[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init: any) => {
        if (String(url).includes("hume.ai")) {
          return new Response(
            JSON.stringify({
              status_code: 400,
              message: "Exhausted credit balance.",
              details: { code: "E0300", slug: "zero_credits" },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
        fishBodies.push(new Uint8Array(init.body));
        return new Response(toneBytes, { status: 200 });
      }),
    );

    const ctx: ProjectContext = {
      ...testContext(dir),
      audio_provider: "hume",
      audio_model: "octave-1",
      hume_api_key: "test-hume-key",
      fish_audio_api_key: "test-fish-key",
      fish_audio_reference_id: "",
    };
    const [item] = await generateSceneVoiceovers(
      ctx,
      [makeScene({ id: "scene_1", narration: "This actually feels natural." })],
      "RESOLVED_REF_123",
    );

    expect(item!.provider).toBe("fish");
    expect(item!.model).toBe("s2.1-pro");
    expect(existsSync(item!.path)).toBe(true);
    expect(fishBodies).toHaveLength(1);
    const decoded = msgpackDecode(fishBodies[0]!) as { reference_id: string };
    expect(decoded.reference_id).toBe("RESOLVED_REF_123");
  });

  it("uses the curated American UGC Hume default when no voice description is supplied", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "media-scene-vo-hume-default-"));
    const tone = path.join(dir, "tone.mp3");
    await makeTone(tone, 1);
    const toneBytes = readFileSync(tone);
    const bodies: any[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: any, init: any) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(
          JSON.stringify({
            generations: [{ audio: toneBytes.toString("base64"), duration: 1 }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const ctx: ProjectContext = {
      ...testContext(dir),
      audio_provider: "hume",
      audio_model: "octave-1",
      hume_api_key: "test-hume-key",
      hume_voice_description: "",
    };

    await generateSceneVoiceovers(ctx, [makeScene({ id: "scene_1", narration: "This actually feels natural." })]);

    expect(bodies[0].utterances[0].description).toContain(DEFAULT_HUME_UGC_VOICE_DESCRIPTION);
    expect(bodies[0].utterances[0].description).toContain("neutral American accent");
    expect(bodies[0].utterances[0].description).toContain("not British");
  });

  it("passes full plan context into Hume per-scene emotion settings", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "media-scene-vo-hume-plan-"));
    const tone = path.join(dir, "tone.mp3");
    await makeTone(tone, 1);
    const toneBytes = readFileSync(tone);
    const bodies: any[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: any, init: any) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(
          JSON.stringify({
            generations: [{ audio: toneBytes.toString("base64"), duration: 1 }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const ctx: ProjectContext = {
      ...testContext(dir),
      audio_provider: "hume",
      audio_model: "octave-1",
      hume_api_key: "test-hume-key",
    };
    const onlyScene = makeScene({
      id: "scene_1",
      narration: "This feels right now.",
      image_prompt: "creator speaking in a quiet room",
      video_prompt: "small handheld push in",
      audio_mode: "ugc_casual",
    });
    const plan: VideoPlan = {
      title: "GlowBar cozy lifestyle test",
      creative_vibe: "cozy_lifestyle",
      narration: onlyScene.narration,
      visual_bible: "Warm desk lamp atmosphere, soft evening study setup, useful and calm.",
      scenes: [onlyScene],
      voice: null,
    };

    await generateSceneVoiceovers(ctx, [onlyScene], undefined, plan);

    expect(bodies[0].utterances[0].description).toContain("warm, intimate, useful");
  });

  it("uses one stable Hume performance profile across a single-speaker plan", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "media-scene-vo-hume-stable-"));
    const tone = path.join(dir, "tone.mp3");
    await makeTone(tone, 1);
    const toneBytes = readFileSync(tone);
    const bodies: any[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: any, init: any) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(
          JSON.stringify({
            generations: [{ audio: toneBytes.toString("base64"), duration: 1 }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const ctx: ProjectContext = {
      ...testContext(dir),
      audio_provider: "hume",
      audio_model: "octave-1",
      hume_api_key: "test-hume-key",
    };
    const first = makeScene({ id: "scene_1", narration: "Wait, I kept forgetting water.", audio_mode: "urgent_reaction" });
    const second = makeScene({
      id: "scene_2",
      narration: "Then the bottle reminded me right on time.",
      on_camera: false,
      audio_mode: "product_proof",
    });
    const plan: VideoPlan = {
      title: "AeroBottle UGC",
      creative_vibe: "polished_ugc",
      narration: `${first.narration} ${second.narration}`,
      visual_bible: "One creator, one consistent voice across every clip.",
      scenes: [first, second],
      voice: null,
    };

    await generateSceneVoiceovers(ctx, [first, second], undefined, plan);

    expect(bodies).toHaveLength(2);
    expect(bodies[0].utterances[0].description).toBe(bodies[1].utterances[0].description);
    expect(bodies[0].utterances[0].speed).toBe(bodies[1].utterances[0].speed);
    expect(bodies[0].utterances[0].trailing_silence).toBe(0.5);
    expect(bodies[1].utterances[0].trailing_silence).toBe(0);
    expect(bodies[0].temperature).toBe(bodies[1].temperature);
  });

  it("uses one global Hume utterance for full-plan narration to avoid scene-boundary repeats", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "media-global-hume-topic-pauses-"));
    const tone = path.join(dir, "tone.mp3");
    await makeTone(tone, 1);
    const toneBytes = readFileSync(tone);
    const bodies: any[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: any, init: any) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(
          JSON.stringify({
            generations: [{ audio: toneBytes.toString("base64"), duration: 1 }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const ctx: ProjectContext = {
      ...testContext(dir),
      audio_provider: "hume",
      audio_model: "octave-1",
      hume_api_key: "test-hume-key",
    };
    const scenes = [
      makeScene({
        id: "scene_1",
        narration: "Okay, I kept forgetting water once work got busy.",
        image_prompt: "creator at a laptop with an untouched smart bottle",
        audio_mode: "ugc_hook",
      }),
      makeScene({
        id: "scene_2",
        narration: "Then the reminder glow caught me right before the crash.",
        image_prompt: "close-up product proof of the smart bottle glowing on the desk",
        on_camera: false,
        audio_mode: "product_proof",
      }),
      makeScene({
        id: "scene_3",
        narration: "By the end of the day, I was actually on track.",
        image_prompt: "final clean desk reveal with the bottle and creator reaction",
        on_camera: false,
        audio_mode: "testimonial",
      }),
    ];
    const plan: VideoPlan = {
      title: "AeroBottle UGC",
      creative_vibe: "polished_ugc",
      narration: scenes.map((scene) => scene.narration).join(" "),
      visual_bible: "One consistent American UGC creator voice.",
      scenes,
      voice: null,
    };

    await generateVoiceoverAsset(ctx, plan.narration, 30, undefined, plan);

    expect(bodies).toHaveLength(1);
    expect(bodies[0].utterances).toHaveLength(1);
    expect(bodies[0].utterances[0].text).toContain("Okay, I kept forgetting water once work got busy.");
    expect(bodies[0].utterances[0].text).toContain("Then the reminder glow caught me right before the crash.");
    expect(bodies[0].utterances[0].text).toContain("By the end of the day, I was actually on track.");
    expect(bodies[0].utterances[0].description).not.toContain("same voice identity");
    expect(bodies[0].utterances[0].description).not.toContain("configured micro-pauses");
    expect(bodies[0].utterances[0].trailing_silence).toBe(0);
  });

  it("resolves Brielle and sends compact performance settings to ElevenLabs", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "media-global-elevenlabs-"));
    const tone = path.join(dir, "tone.mp3");
    await makeTone(tone, 1);
    const toneBytes = readFileSync(tone);
    const requests: Array<{ url: string; init: any }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init: any = {}) => {
        requests.push({ url: String(url), init });
        if (String(url).includes("/v2/voices")) {
          expect(init.headers["xi-api-key"]).toBe("test-eleven-key");
          return new Response(
            JSON.stringify({
              voices: [
                { voice_id: "other_voice", name: "Narrator" },
                { voice_id: "brielle_voice_id", name: "Brielle - Podcast Girl" },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(toneBytes, { status: 200, headers: { "content-type": "audio/mpeg" } });
      }),
    );

    const ctx: ProjectContext = {
      ...testContext(dir),
      audio_provider: "elevenlabs",
      audio_model: "eleven_multilingual_v2",
      elevenlabs_api_key: "test-eleven-key",
      elevenlabs_voice_name: "brielle - podcast girl",
    };
    const scene = makeScene({
      id: "scene_1",
      narration: "Okay, this bottle finally made hydration feel easy.",
      audio_mode: "ugc_hook",
    });
    const plan: VideoPlan = {
      title: "AeroBottle UGC",
      creative_vibe: "polished_ugc",
      narration: scene.narration,
      visual_bible: "One consistent UGC creator voice.",
      scenes: [scene],
      voice: null,
    };

    const item = await generateVoiceoverAsset(ctx, plan.narration, 30, undefined, plan);
    const ttsRequest = requests.find((request) => request.url.includes("/v1/text-to-speech/"));
    const body = JSON.parse(String(ttsRequest?.init.body ?? "{}"));

    expect(item.provider).toBe("elevenlabs");
    expect(item.model).toBe("eleven_multilingual_v2");
    expect(existsSync(item.path)).toBe(true);
    expect(ttsRequest?.url).toContain("/v1/text-to-speech/brielle_voice_id");
    expect(ttsRequest?.init.headers["xi-api-key"]).toBe("test-eleven-key");
    expect(body.text).toBe("Okay, this bottle finally made hydration feel easy.");
    expect(body.model_id).toBe("eleven_multilingual_v2");
    expect(body.voice_settings.use_speaker_boost).toBe(true);
    expect(body.voice_settings.speed).toBeGreaterThanOrEqual(0.75);
    expect(body.voice_settings.speed).toBeLessThanOrEqual(1.2);
    expect(body.voice_settings.style).toBeGreaterThan(0);
  });

  it("does not slow a global ElevenLabs utterance that already meets the estimated target", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "media-global-elevenlabs-calibrated-"));
    const tone = path.join(dir, "tone.mp3");
    await makeTone(tone, 1);
    const toneBytes = readFileSync(tone);
    let requestBody: any = null;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: any, init: any = {}) => {
        requestBody = JSON.parse(String(init.body));
        return new Response(toneBytes, { status: 200, headers: { "content-type": "audio/mpeg" } });
      }),
    );

    const ctx: ProjectContext = {
      ...testContext(dir),
      audio_provider: "elevenlabs",
      audio_model: "eleven_multilingual_v2",
      elevenlabs_api_key: "test-eleven-key",
      elevenlabs_voice_name: "Rachel",
    };
    const narration =
      "Imagine two babies falling from the sky onto the same man. Joseph was sweeping below a Detroit tenement when the first child fell. A year later, he was working nearby when another child dropped toward him. The crowd watched in disbelief as he survived both impacts and protected both children. The city remembered the impossible coincidence. Newspapers carried the story while neighbors repeated every astonishing detail for years afterward.";
    const scene = makeScene({
      id: "scene_1",
      narration,
      audio_mode: "cinematic_narrator",
      duration_seconds: 30,
    });
    const plan: VideoPlan = {
      title: "Historical story",
      creative_vibe: "cinematic_commercial",
      narration,
      visual_bible: "One consistent narrator.",
      scenes: [scene],
      voice: "ethan",
    };

    await generateVoiceoverAsset(ctx, narration, 30, undefined, plan);

    expect(requestBody.voice_settings.speed).toBe(0.91);
  });

  it("uses a verified preset voice id without requiring voices_read permission", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "media-global-elevenlabs-preset-"));
    const tone = path.join(dir, "tone.mp3");
    await makeTone(tone, 1);
    const toneBytes = readFileSync(tone);
    const requests: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        requests.push(String(url));
        return new Response(toneBytes, { status: 200, headers: { "content-type": "audio/mpeg" } });
      }),
    );

    const ctx: ProjectContext = {
      ...testContext(dir),
      audio_provider: "elevenlabs",
      audio_model: "eleven_multilingual_v2",
      elevenlabs_api_key: "test-eleven-key",
      elevenlabs_voice_name: "Rachel",
    };
    const scene = makeScene({
      id: "scene_1",
      narration: "This is a warm, natural story.",
      audio_mode: "cinematic_narrator",
    });
    const plan: VideoPlan = {
      title: "Narrated story",
      creative_vibe: "editorial_documentary",
      narration: scene.narration,
      visual_bible: "One consistent narrator.",
      scenes: [scene],
      voice: "sarah",
    };

    await generateVoiceoverAsset(ctx, plan.narration, 10, undefined, plan);

    expect(requests.some((url) => url.includes("/v2/voices"))).toBe(false);
    expect(requests.some((url) => url.includes("/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM"))).toBe(true);
  });

  it("retries one ElevenLabs connection failure inside the provider boundary", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "media-elevenlabs-transport-retry-"));
    const tone = path.join(dir, "tone.mp3");
    await makeTone(tone, 1);
    const toneBytes = readFileSync(tone);
    let attempts = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError("fetch failed");
        return new Response(toneBytes, { status: 200, headers: { "content-type": "audio/mpeg" } });
      }),
    );

    const ctx: ProjectContext = {
      ...testContext(dir),
      audio_provider: "elevenlabs",
      audio_model: "eleven_multilingual_v2",
      elevenlabs_api_key: "test-eleven-key",
      elevenlabs_voice_name: "Rachel",
    };
    const narration = "This is a natural voiceover after one temporary connection failure.";
    const scene = makeScene({
      id: "scene_1",
      narration,
      audio_mode: "cinematic_narrator",
    });
    const plan: VideoPlan = {
      title: "Transport retry",
      creative_vibe: "editorial_documentary",
      narration,
      visual_bible: "One consistent narrator.",
      scenes: [scene],
      voice: "sarah",
    };

    const item = await generateVoiceoverAsset(ctx, narration, 10, undefined, plan);

    expect(item.provider).toBe("elevenlabs");
    expect(attempts).toBe(2);
  });
});

describe("anyEmbeddedAudio", () => {
  it("returns true when any video has embedded audio or is on-camera", () => {
    expect(anyEmbeddedAudio([{ has_embedded_audio: true }])).toBe(true);
    expect(anyEmbeddedAudio([{ on_camera: true }])).toBe(true);
  });

  it("returns false for plain b-roll videos", () => {
    expect(anyEmbeddedAudio([{}])).toBe(false);
  });
});

describe("stitchMixedAssets", () => {
  it("concatenates per-section scenes preserving each scene's own audio", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "media-mixed-"));
    const video1 = path.join(dir, "scene1.mp4");
    const audio1 = path.join(dir, "scene1.mp3");
    const video2 = path.join(dir, "scene2.mp4");
    const audio2 = path.join(dir, "scene2.mp3");
    await makeSilentVideo(video1, 1);
    await makeTone(audio1, 1);
    await makeSilentVideo(video2, 1);
    await makeTone(audio2, 1);

    const final = await stitchMixedAssets(
      testContext(dir),
      [
        { video_path: video1, audio_path: audio1, audio_duration_seconds: 1 },
        { video_path: video2, audio_path: audio2, audio_duration_seconds: 1 },
      ],
      {},
    );

    const streams = await probeMediaStreamDurations(final);
    expect(streams.audio_duration_seconds).not.toBeNull();
    // Two ~1s scenes concatenated -> well over 1.5s total.
    expect(streams.format_duration_seconds).toBeGreaterThan(1.5);
  });

  it("accepts small final target overruns without cutting scene audio", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "media-mixed-overrun-"));
    const video1 = path.join(dir, "scene1.mp4");
    const audio1 = path.join(dir, "scene1.mp3");
    const video2 = path.join(dir, "scene2.mp4");
    const audio2 = path.join(dir, "scene2.mp3");
    await makeSilentVideo(video1, 1);
    await makeTone(audio1, 1.8);
    await makeSilentVideo(video2, 1);
    await makeTone(audio2, 1.8);

    const final = await stitchMixedAssets(
      testContext(dir),
      [
        { video_path: video1, audio_path: audio1, audio_duration_seconds: 1.8 },
        { video_path: video2, audio_path: audio2, audio_duration_seconds: 1.8 },
      ],
      { target_duration_seconds: 3 },
    );

    const streams = await probeMediaStreamDurations(final);
    expect(streams.format_duration_seconds).toBeGreaterThan(3.2);
    expect(streams.audio_duration_seconds).toBeGreaterThan(3.2);
  });
});

describe("stitchTimelineAssets", () => {
  it("pads each timeline clip to its own duration before final mux", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "media-timeline-"));
    const video = path.join(dir, "scene.mp4");
    const audio = path.join(dir, "voiceover.mp3");
    await makeSilentVideo(video, 1);
    await makeTone(audio, 2);

    const final = await stitchTimelineAssets(
      testContext(dir),
      [
        {
          id: "video:scene_1",
          path: video,
          source_start: 0,
          source_end: 1,
          timeline_start: 0,
          timeline_end: 2,
          duration: 2,
        },
      ],
      { path: audio },
      { target_duration_seconds: 2 },
    );

    expect(await probeMediaDuration(final)).toBeGreaterThanOrEqual(1.9);
    expect(await probeMediaDuration(final)).toBeLessThanOrEqual(2.2);
  });

  it("rejects a near-target voiceover overrun instead of silently cutting its final word", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "media-timeline-no-freeze-extension-"));
    const video = path.join(dir, "scene.mp4");
    const audio = path.join(dir, "voiceover.mp3");
    await makeSilentVideo(video, 2);
    await makeTone(audio, 2.1);

    await expect(
      stitchTimelineAssets(
        testContext(dir),
        [
          {
            id: "video:scene_1",
            path: video,
            source_start: 0,
            source_end: 2,
            timeline_start: 0,
            timeline_end: 2,
            duration: 2,
          },
        ],
        { path: audio },
        { target_duration_seconds: 2 },
      ),
    ).rejects.toThrow("audio will not be cut");
  });
});
