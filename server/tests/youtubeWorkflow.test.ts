import { describe, expect, it } from "vitest";
import { shouldReuseExistingYoutubeManifest } from "../src/workflows.js";

describe("YouTube workflow manifest reuse", () => {
  it("does not reuse an existing manifest unless explicitly requested", () => {
    expect(shouldReuseExistingYoutubeManifest()).toBe(false);
    expect(shouldReuseExistingYoutubeManifest({ reuse_existing_manifest: false })).toBe(false);
    expect(shouldReuseExistingYoutubeManifest({ reuse_existing_manifest: true })).toBe(true);
  });
});
