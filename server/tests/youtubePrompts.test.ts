import { describe, expect, it } from "vitest";
import {
  carrySourceSubjectTerms,
  extractPromptDuration,
  isCurrentOpenaiSourcePrompt,
  videoFriendlyOpenaiSearchHint,
} from "../src/prompts.js";

describe("OpenAI YouTube search hint cleanup", () => {
  it("treats new OpenAI requests as current-source prompts", () => {
    expect(isCurrentOpenaiSourcePrompt("new OpenAI and space stuff")).toBe(true);
  });

  it("broadens spelled-out fake GPT model hints to current product footage", () => {
    expect(videoFriendlyOpenaiSearchHint("OpenAI GPT five point five")).toBe("OpenAI latest product news");
  });

  it("carries source freshness without preserving fake spelled-out model tokens", () => {
    expect(
      carrySourceSubjectTerms(
        "gimme a very creative sarcastic script on the new openAI and space stuff",
        "OpenAI GPT five point five",
      ),
    ).toBe("OpenAI latest product news");
  });
});

describe("duration extraction", () => {
  it("parses compact second notation from user prompts", () => {
    expect(extractPromptDuration("make a meme worthy sarcastic 30s long video")).toEqual([30, false]);
    expect(extractPromptDuration("keep it under 20s")).toEqual([20, true]);
    expect(extractPromptDuration("make a 30-sec clip")).toEqual([30, false]);
  });
});
