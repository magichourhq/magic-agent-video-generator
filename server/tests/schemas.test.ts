import { describe, it, expect } from "vitest";
import { context } from "../src/projectContext.js";
import { CreateProjectRequestSchema, SceneSchema, VideoPlanSchema } from "../src/schemas.js";

const baseScene = { id: "s1", narration: "hi", image_prompt: "p", video_prompt: "v", duration_seconds: 4, on_camera: true };

describe("SceneSchema on_camera", () => {
  it("requires an explicit per-scene tool choice", () => {
    const { on_camera: _onCamera, ...withoutOnCamera } = baseScene;
    expect(() => SceneSchema.parse(withoutOnCamera)).toThrow();
  });
  it("round-trips an explicit b-roll choice", () => {
    expect(SceneSchema.parse({ ...baseScene, on_camera: false }).on_camera).toBe(false);
  });
  it("defaults compact audio delivery fields to backend inference for older saved plans", () => {
    const scene = SceneSchema.parse({ ...baseScene, on_camera: false });
    expect(scene.audio_mode).toBe(null);
    expect(scene.audio_note).toBe(null);
  });
  it("accepts compact audio mode and short voice note", () => {
    const scene = SceneSchema.parse({
      ...baseScene,
      audio_mode: "product_proof",
      audio_note: "confident but not announcer-like",
    });
    expect(scene.audio_mode).toBe("product_proof");
    expect(scene.audio_note).toBe("confident but not announcer-like");
  });
  it("preserves per-scene flags through VideoPlanSchema", () => {
    const plan = VideoPlanSchema.parse({
      title: "t",
      narration: "n",
      scenes: [{ ...baseScene, id: "a" }, { ...baseScene, id: "b", on_camera: false }],
    });
    expect(plan.scenes.map((s) => s.on_camera)).toEqual([true, false]);
  });
  it("rejects unknown audio modes", () => {
    expect(() => SceneSchema.parse({ ...baseScene, audio_mode: "raw_hume_temperature" })).toThrow();
  });
});

describe("VideoPlanSchema voice", () => {
  const basePlan = { title: "t", narration: "n", scenes: [baseScene] };

  it("defaults creative_vibe for older saved plans", () => {
    expect(VideoPlanSchema.parse(basePlan).creative_vibe).toBe("polished_ugc");
  });

  it("accepts an explicit creative_vibe", () => {
    expect(VideoPlanSchema.parse({ ...basePlan, creative_vibe: "cinematic_commercial" }).creative_vibe).toBe(
      "cinematic_commercial",
    );
  });

  it("rejects an unknown creative_vibe", () => {
    expect(() => VideoPlanSchema.parse({ ...basePlan, creative_vibe: "purple_magic" })).toThrow();
  });

  it("defaults voice to null when omitted", () => {
    expect(VideoPlanSchema.parse(basePlan).voice).toBe(null);
  });

  it("accepts a valid catalog voice key", () => {
    expect(VideoPlanSchema.parse({ ...basePlan, voice: "sarah" }).voice).toBe("sarah");
  });

  it("rejects an unknown voice key", () => {
    expect(() => VideoPlanSchema.parse({ ...basePlan, voice: "bogus" })).toThrow();
  });
});

describe("CreateProjectRequestSchema audio provider", () => {
  it("defaults image generation to Nano Banana 2 Lite at a supported resolution", () => {
    const request = CreateProjectRequestSchema.parse({
      prompt: "Make a polished vertical product video.",
      resolution: "1080p",
    });
    const ctx = context("0123456789abcdef0123456789abcdef", request);

    expect(ctx.image_model).toBe("nano-banana-2-lite");
    expect(ctx.image_resolution).toBe("1k");
  });

  it("accepts isolated uploaded image and audio descriptors", () => {
    const request = CreateProjectRequestSchema.parse({
      prompt: "Make a product video using my inputs.",
      input_media: [
        {
          id: "0123456789abcdef0123456789abcdef",
          kind: "image",
          name: "product.png",
          mime_type: "image/png",
          url: "/media/input_media/0123456789abcdef0123456789abcdef.png",
        },
      ],
    });

    expect(request.input_media).toHaveLength(1);
    expect(request.input_media[0]?.kind).toBe("image");
  });

  it("accepts longer quality-benchmark video requests up to two minutes", () => {
    const request = CreateProjectRequestSchema.parse({
      prompt: "Make a 70 second nonprofit video about planting trees in overheated city blocks.",
      duration_seconds: 70,
    });
    expect(request.duration_seconds).toBe(70);
  });

  it("uses Hume Octave as the default project audio provider", () => {
    const request = CreateProjectRequestSchema.parse({
      prompt: "Make a 30 second UGC ad.",
    });
    const ctx = context("0123456789abcdef0123456789abcdef", request);

    expect(ctx.audio_provider).toBe("hume");
    expect(ctx.audio_model).toBe("octave-1");
  });

  it("accepts Hume Octave settings for a generation request", () => {
    const request = CreateProjectRequestSchema.parse({
      prompt: "Make a 30 second UGC ad.",
      audio_provider: "hume",
      hume_voice_description: "Energetic and conversational.",
      runtime_credentials: { hume_api_key: "test-hume-key" },
    });
    expect(request.audio_provider).toBe("hume");
    expect(request.hume_voice_description).toBe("Energetic and conversational.");
    expect(request.runtime_credentials?.hume_api_key).toBe("test-hume-key");
  });

  it("accepts ElevenLabs settings for a generation request", () => {
    const request = CreateProjectRequestSchema.parse({
      prompt: "Make a 30 second UGC ad.",
      audio_provider: "elevenlabs",
      elevenlabs_voice_name: "brielle - podcast girl",
      runtime_credentials: { elevenlabs_api_key: "test-eleven-key" },
    });
    const ctx = context("0123456789abcdef0123456789abcdef", request);

    expect(request.audio_provider).toBe("elevenlabs");
    expect(ctx.audio_provider).toBe("elevenlabs");
    expect(ctx.audio_model).toBe("eleven_multilingual_v2");
    expect(ctx.elevenlabs_voice_name).toBe("brielle - podcast girl");
    expect(ctx.elevenlabs_api_key).toBe("test-eleven-key");
  });
});
