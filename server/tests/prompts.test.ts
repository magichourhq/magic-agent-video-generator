import { describe, expect, it } from "vitest";
import { PROJECT_CONTEXT_DEFAULTS } from "../src/context.js";
import { CreateProjectRequestSchema } from "../src/schemas.js";
import {
  INSTRUCTIONS,
  buildGenerationBrief,
  estimateTtsWordsPerSecondForContext,
  magicHourModelCatalogForAgent,
} from "../src/prompts.js";

describe("ElevenLabs planning calibration", () => {
  it("uses the raw unconformed Brielle pace instead of duration-conformed output pace", () => {
    expect(
      estimateTtsWordsPerSecondForContext({
        ...PROJECT_CONTEXT_DEFAULTS,
        audio_provider: "elevenlabs",
        audio_model: "eleven_multilingual_v2",
      } as any),
    ).toBe(2.6);
  });

  it("uses the strict narrated floor in the first brief when dead air is forbidden", () => {
    const request = CreateProjectRequestSchema.parse({
      prompt: "Create a 30 second cinematic historical story with narration and no silent ending.",
      duration_seconds: 30,
      audio_provider: "elevenlabs",
    });
    const brief = buildGenerationBrief(request, {
      ...PROJECT_CONTEXT_DEFAULTS,
      project_id: "strict-budget",
      project_dir: "/tmp/strict-budget",
      audio_provider: "elevenlabs",
      audio_model: "eleven_multilingual_v2",
    } as any);

    expect(brief).toContain("Narration planning target: 76-78 spoken words.");
    expect(brief).toContain("submitted payload MUST contain at least 76 and at most 78 actual spoken words");
  });
});

describe("INSTRUCTIONS on-camera contract", () => {
  it("documents explicit on_camera and first-person dialogue use", () => {
    expect(INSTRUCTIONS).toContain("on_camera");
    expect(INSTRUCTIONS).toContain("Default to on_camera=false");
    expect(INSTRUCTIONS).toContain("visible person/character/avatar/founder to speak");
    expect(INSTRUCTIONS).not.toContain("by default every scene");
  });

  it("keeps the video-prompt camera/subject-motion-only rule (b-roll regression)", () => {
    expect(INSTRUCTIONS).toContain("camera motion and subject motion only");
  });

  it("warns against re-rendering scenes that already succeeded", () => {
    expect(INSTRUCTIONS).toContain("already succeeded");
  });

  it("warns against adding a global voiceover for talking videos", () => {
    expect(INSTRUCTIONS).toContain("replace_voiceover");
    expect(INSTRUCTIONS).toContain("on-camera");
  });

  it("treats minimum narration counts as hard repair floors", () => {
    expect(INSTRUCTIONS).toContain("minimum-word issue as a hard floor");
    expect(INSTRUCTIONS).toMatch(/Count the revised\s+spoken words/);
  });

  it("prioritizes first-run quality without broad rerenders", () => {
    expect(INSTRUCTIONS).toContain("First-run quality");
    expect(INSTRUCTIONS).toContain("automatic rerenders");
  });

  it("allows clarification before paid provider calls when minimum details are missing", () => {
    expect(INSTRUCTIONS).toContain("request_clarification");
    expect(INSTRUCTIONS).toContain("before any paid provider tool");
    expect(INSTRUCTIONS).not.toContain("Do not ask clarification questions. Infer missing details");
  });
});

describe("buildGenerationBrief creative intent profile", () => {
  it("injects the first-run creative intent profile into the planner brief", () => {
    const request = CreateProjectRequestSchema.parse({
      prompt: "Make a TikTok UGC ad for AeroBottle with product closeups and a strong CTA.",
      duration_seconds: 30,
    });
    const brief = buildGenerationBrief(request, {
      project_id: "prompt-test",
      project_dir: "/tmp/prompt-test",
      aspect_ratio: "9:16",
      resolution: "720p",
      ...PROJECT_CONTEXT_DEFAULTS,
    });

    expect(brief).toContain("Creative intent profile");
    expect(brief).toContain("Magic Hour capability routing");
    expect(brief).toContain("Format intent: ugc");
    expect(brief).toContain("Voice emotion target");
    expect(brief).toContain("Suggested video vibe");
    expect(brief).toContain("hard cuts only");
    expect(brief).toContain("Format grammar");
    expect(brief).toContain("Required format-specific first-run beats");
    expect(brief).toContain("Voice identity contract");
    expect(brief).toContain("Editable storyboard contract");
    expect(brief).toContain("Run isolation contract");
    expect(brief).toContain("0.5s micro-pause");
    expect(brief).toContain("Per-scene narration budget");
    expect(brief).toContain("Hard narration word-count check");
    expect(brief).toContain("do not submit below the floor");
    expect(brief).toContain("do not fix low total coverage by overloading one short scene");
    expect(brief).toContain("Causal narration alignment");
  });
});

describe("ltx-2.3 model catalog blurb", () => {
  it("describes the AI Talking Photo pass", () => {
    expect(magicHourModelCatalogForAgent()).toContain("talking photo");
  });
});
