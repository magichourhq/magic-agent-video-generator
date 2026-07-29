import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildClarifyingQuestions,
  composeClarifiedPrompt,
  type ClarifyingAnswer,
} from "./clarifying-questions";

describe("clarifying questions", () => {
  it("adds a workflow-specific question to the shared clarification flow", () => {
    const generatedQuestions = buildClarifyingQuestions("generated");
    const youtubeQuestions = buildClarifyingQuestions("youtube_clips");

    assert.equal(generatedQuestions.length, 3);
    assert.equal(youtubeQuestions.length, 3);
    assert.equal(generatedQuestions[2].id, "visual_direction");
    assert.equal(youtubeQuestions[2].id, "source_strategy");
  });

  it("keeps the original brief and appends selected and custom answers", () => {
    const questions = buildClarifyingQuestions("generated");
    const answers: ClarifyingAnswer[] = [
      { questionId: "goal", label: "Drive signups", value: "Drive signups" },
      { questionId: "tone", label: "Something else", value: "dry, understated humor" },
    ];

    const prompt = composeClarifiedPrompt("Make a launch short for a pocket AI camera.", questions, answers);

    assert.match(prompt, /^Make a launch short for a pocket AI camera\./);
    assert.match(prompt, /Clarifying answers:/);
    assert.match(prompt, /Primary outcome: Drive signups/);
    assert.match(prompt, /Tone and pacing: dry, understated humor/);
  });
});
