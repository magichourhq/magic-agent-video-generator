import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectContext } from "../src/context.js";
import { PROJECT_CONTEXT_DEFAULTS } from "../src/context.js";
import { extractDominantSubject, normalizeYoutubeSectionsForProject } from "../src/prompts.js";
import { initializeProjectState } from "../src/renderState.js";
import { metadataSpecificityRejectionReason, requiredSubjectRejectionReason } from "../src/youtubeShort.js";

describe("extractDominantSubject", () => {
  it("extracts a confident proper-noun subject", () => {
    const subject = extractDominantSubject(
      "A 30-second factual short about Patrick Mahomes and the Kansas City Chiefs",
    );
    expect(subject).not.toBeNull();
    const tokens = subject!.tokens;
    expect(tokens.includes("mahomes") || tokens.includes("chiefs")).toBe(true);
    expect(subject!.phrase.length).toBeGreaterThan(0);
  });

  it("returns null for abstract / lowercase prompts", () => {
    expect(extractDominantSubject("a calming abstract gradient loop")).toBeNull();
  });

  it("returns null when there is no confident proper-noun subject", () => {
    expect(extractDominantSubject("make a short video about cooking dinner at home")).toBeNull();
  });
});

describe("requiredSubjectRejectionReason", () => {
  it("rejects a candidate that mentions none of the subject tokens", () => {
    expect(requiredSubjectRejectionReason("bill gates 2007 microsoft keynote", ["steve", "jobs"])).not.toBeNull();
  });

  it("accepts a candidate that mentions a subject token", () => {
    expect(requiredSubjectRejectionReason("steve jobs unveils the iphone 2007", ["steve", "jobs"])).toBeNull();
  });

  it("returns null for empty subject tokens", () => {
    expect(requiredSubjectRejectionReason("anything at all", [])).toBeNull();
  });
});

describe("normalizeYoutubeSectionsForProject subject hint injection", () => {
  it("prepends the subject phrase and attaches subject_tokens (non-factual branch)", () => {
    const sections = [
      {
        section: 1,
        dialogue: "He throws a deep touchdown pass under pressure.",
        search_hint: "quarterback throwing a touchdown",
        duration_seconds: 6,
        search_order: null,
        published_after: null,
        published_before: null,
        video_duration: null,
        video_category: null,
        require_captions: false,
        channel_hint: null,
        candidate_video_urls: [],
      },
    ] as any[];

    const ctx = makeCtxWithPrompt(
      "Make a short video about Patrick Mahomes and the Kansas City Chiefs",
    );
    const normalized = normalizeYoutubeSectionsForProject(ctx, sections);
    const hint = normalized[0]!.search_hint.toLowerCase();
    expect(hint.includes("mahomes") || hint.includes("chiefs")).toBe(true);
    const subjectTokens = (normalized[0] as any).subject_tokens as string[] | undefined;
    expect(Array.isArray(subjectTokens)).toBe(true);
    expect(subjectTokens!.includes("mahomes") || subjectTokens!.includes("chiefs")).toBe(true);
  });

  it("prepends the subject phrase and attaches subject_tokens (factual branch)", () => {
    const sections = [
      {
        section: 1,
        dialogue: "The team celebrates a clutch win in the final seconds.",
        search_hint: "quarterback throwing a touchdown",
        duration_seconds: 6,
        search_order: null,
        published_after: null,
        published_before: null,
        video_duration: null,
        video_category: null,
        require_captions: false,
        channel_hint: null,
        candidate_video_urls: [],
      },
    ] as any[];

    const ctx = makeCtxWithPrompt(
      "Make a 30-second factual news short about Patrick Mahomes and the Kansas City Chiefs",
    );
    const normalized = normalizeYoutubeSectionsForProject(ctx, sections);
    const hint = normalized[0]!.search_hint.toLowerCase();
    expect(hint.includes("mahomes") || hint.includes("chiefs")).toBe(true);
    const subjectTokens = (normalized[0] as any).subject_tokens as string[] | undefined;
    expect(Array.isArray(subjectTokens)).toBe(true);
    expect(subjectTokens!.includes("mahomes") || subjectTokens!.includes("chiefs")).toBe(true);
  });

  it("leaves abstract prompts untouched (no subject_tokens)", () => {
    const sections = [
      {
        section: 1,
        dialogue: "Soft gradients drift across the screen.",
        search_hint: "calming abstract gradient loop",
        duration_seconds: 6,
        search_order: null,
        published_after: null,
        published_before: null,
        video_duration: null,
        video_category: null,
        require_captions: false,
        channel_hint: null,
        candidate_video_urls: [],
      },
    ] as any[];

    const ctx = makeCtxWithPrompt("a calming abstract gradient loop");
    const normalized = normalizeYoutubeSectionsForProject(ctx, sections);
    expect((normalized[0] as any).subject_tokens).toBeUndefined();
  });
});

describe("metadataSpecificityRejectionReason subject gate", () => {
  // A neutral subject (no per-name allowlist regex applies) so this isolates
  // the new generic subject gate from the legacy requiredEntityRejectionReason ladder.
  const baseSection = {
    section: 1,
    dialogue: "The quarterback throws a deep touchdown pass.",
    search_hint: "quarterback touchdown pass",
    require_captions: false,
    channel_hint: null,
  } as any;

  it("rejects a non-subject candidate when subject_tokens is set", () => {
    const section = { ...baseSection, subject_tokens: ["mahomes", "chiefs"] };
    const candidate = {
      title: "Bills vs Dolphins full game highlights",
      channel_title: "NFL",
      description: "Josh Allen leads a comeback drive.",
    };
    expect(metadataSpecificityRejectionReason(section, candidate, false)).not.toBeNull();
  });

  it("accepts a subject candidate when subject_tokens is set", () => {
    const section = { ...baseSection, subject_tokens: ["mahomes", "chiefs"] };
    const candidate = {
      title: "Patrick Mahomes throws a clutch touchdown",
      channel_title: "NFL",
      description: "Chiefs quarterback delivers under pressure.",
    };
    expect(metadataSpecificityRejectionReason(section, candidate, false)).toBeNull();
  });

  it("ignores broad concept tokens that are not true required subjects", () => {
    const section = { ...baseSection, subject_tokens: ["AI", "small businesses", "customer service"] };
    const candidate = {
      title: "Shop owner shows tools that help customer support",
      channel_title: "Local Business Daily",
      description: "A practical look at saving time in a small team.",
    };
    expect(metadataSpecificityRejectionReason(section, candidate, false)).toBeNull();
  });

  it("is unchanged when subject_tokens is unset", () => {
    const candidate = {
      title: "Bills vs Dolphins full game highlights",
      channel_title: "NFL",
      description: "Josh Allen leads a comeback drive.",
    };
    expect(metadataSpecificityRejectionReason(baseSection, candidate, false)).toBeNull();
  });
});

function makeCtxWithPrompt(prompt: string): ProjectContext {
  const dir = mkdtempSync(path.join(tmpdir(), "yt-subject-"));
  const ctx: ProjectContext = {
    project_id: "yt-subject-test",
    project_dir: dir,
    aspect_ratio: "9:16",
    resolution: "1080p",
    ...PROJECT_CONTEXT_DEFAULTS,
  };
  initializeProjectState(ctx, { user_preferences: { prompt } });
  return ctx;
}

