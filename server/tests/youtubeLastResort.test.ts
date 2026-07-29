import { describe, expect, it, vi } from "vitest";
import { selectLastResortClip, type LastResortDeps } from "../src/youtubeShort.js";

const baseSection = {
  section: 2,
  dialogue: "Patrick Mahomes throws a clutch touchdown in the final seconds.",
  search_hint: "Patrick Mahomes Chiefs touchdown",
  duration_seconds: 6,
  require_captions: false,
  channel_hint: null,
  subject_tokens: ["mahomes", "chiefs"],
} as any;

function subjectMatchingCandidate(videoId: string): Record<string, any> {
  return {
    video_id: videoId,
    title: "Patrick Mahomes throws a clutch touchdown",
    channel_title: "NFL",
    description: "Chiefs quarterback delivers under pressure.",
    duration_seconds: 120,
  };
}

function subjectMismatchedCandidate(videoId: string): Record<string, any> {
  return {
    video_id: videoId,
    title: "Bills vs Dolphins full game highlights",
    channel_title: "NFL",
    description: "Josh Allen leads a comeback drive.",
    duration_seconds: 120,
  };
}

function makeDeps(overrides: Partial<LastResortDeps> = {}): LastResortDeps {
  return {
    candidateDuration: vi.fn(async () => 120),
    downloadClip: vi.fn(async () => "/tmp/clip.mp4"),
    clipVisualRejectionReason: vi.fn(async () => null),
    outDir: "/tmp/out",
    proxyUrl: null,
    ...overrides,
  };
}

describe("selectLastResortClip", () => {
  it("fills the scene with a subject-matching, VLM-clean clip whose transcript/visual score was too weak", async () => {
    // Both top candidates are subject-matching and VLM-clean; they only failed
    // the strict transcript/visual SCORE gates upstream. The last resort relaxes
    // ONLY the score gate, so the scene must be filled rather than failing.
    const candidates = [subjectMatchingCandidate("aaaaaaaaaaa"), subjectMatchingCandidate("bbbbbbbbbbb")];
    const deps = makeDeps();

    const result = await selectLastResortClip(baseSection, candidates, deps);

    expect(result).not.toBeNull();
    expect(result!.video_id).toBe("aaaaaaaaaaa");
    expect(result!.window_source).toBe("last_resort");
    expect(deps.downloadClip).toHaveBeenCalledTimes(1);
  });

  it("returns null (scene still fails) when every candidate is subject-mismatched", async () => {
    const candidates = [subjectMismatchedCandidate("ccccccccccc"), subjectMismatchedCandidate("ddddddddddd")];
    const deps = makeDeps();

    const result = await selectLastResortClip(baseSection, candidates, deps);

    expect(result).toBeNull();
    // Subject gate rejects before any download, so the expensive VLM/download never runs.
    expect(deps.downloadClip).not.toHaveBeenCalled();
    expect(deps.clipVisualRejectionReason).not.toHaveBeenCalled();
  });

  it("returns null (scene still fails) when the only subject-matching clips are VLM-rejected (CTA/title/watermark)", async () => {
    const candidates = [subjectMatchingCandidate("eeeeeeeeeee"), subjectMatchingCandidate("fffffffffff")];
    const deps = makeDeps({
      clipVisualRejectionReason: vi.fn(async () => "visual verifier mismatch: COMING UP + SUBSCRIBE/LIKE CTA"),
    });

    const result = await selectLastResortClip(baseSection, candidates, deps);

    expect(result).toBeNull();
    // It tried to download/judge the subject-matching candidates but rejected all.
    expect(deps.downloadClip).toHaveBeenCalled();
    expect(deps.clipVisualRejectionReason).toHaveBeenCalled();
  });

  it("skips subject-mismatched candidates and accepts the first subject-matching VLM-clean one", async () => {
    const candidates = [
      subjectMismatchedCandidate("ggggggggggg"),
      subjectMatchingCandidate("hhhhhhhhhhh"),
    ];
    const deps = makeDeps();

    const result = await selectLastResortClip(baseSection, candidates, deps);

    expect(result).not.toBeNull();
    expect(result!.video_id).toBe("hhhhhhhhhhh");
    // Only the subject-matching candidate is downloaded.
    expect(deps.downloadClip).toHaveBeenCalledTimes(1);
  });
});
