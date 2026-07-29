import { describe, it, expect } from "vitest";
import { buildVisualMatchPrompt } from "../src/youtubeShort.js";

const section: any = { section: 1, dialogue: "Mahomes leads the Chiefs.", search_hint: "Patrick Mahomes Chiefs", duration_seconds: 7 };
const candidate: any = { title: "Mahomes highlights", channel_title: "NFL", video_id: "x" };
const windowMatch: any = { text: "mahomes touchdown" };

// A LARGE/PROMINENT subscribe banner that persists is the bad case; a SMALL one is fine.
describe("VLM judge rejects large/prominent persistent CTA banners but allows small ones", () => {
  const prompt = buildVisualMatchPrompt(section, candidate, windowMatch).toLowerCase();

  it("rejects a LARGE/PROMINENT call-to-action banner, especially when persistent", () => {
    expect(prompt).toMatch(/large or prominent|prominent/);
    expect(prompt).toMatch(/subscribe|call-to-action|call to action/);
    expect(prompt).toContain("persists");
    expect(prompt).toContain("most of the sampled frames");
  });

  it("explicitly allows a small corner logo / thin minor banner even if it stays on screen", () => {
    expect(prompt).toMatch(/small corner logo|thin minor banner/);
    expect(prompt).toContain("acceptable");
    expect(prompt).toContain("small overlays are fine");
  });
});

describe("VLM judge requires the actual named person (rejects impersonators/cosplay)", () => {
  const p = buildVisualMatchPrompt(section, candidate, windowMatch).toLowerCase();
  it("rejects impersonators / children in costume / cosplay / video-game renderings", () => {
    expect(p).toMatch(/actual person or team/);
    expect(p).toMatch(/impersonator|cosplay|costume/);
  });
});
