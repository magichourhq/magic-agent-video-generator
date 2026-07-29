import { describe, expect, it } from "vitest";
import { countSpokenWords, youtubeScriptNarration } from "../src/prompts.js";
import { applyCandidateRanking, fitYoutubeScriptToBudget, fitYoutubeSectionDurations } from "../src/youtubeSubagents.js";

describe("fitYoutubeSectionDurations", () => {
  it("scales overlong YouTube section durations to the target budget", () => {
    const plan = {
      title: "Overlong",
      web_search_needed: false,
      web_search_reason: "",
      sections: [
        { section: 1, dialogue: "one", search_hint: "one", duration_seconds: 10 },
        { section: 2, dialogue: "two", search_hint: "two", duration_seconds: 10 },
        { section: 3, dialogue: "three", search_hint: "three", duration_seconds: 9 },
        { section: 4, dialogue: "four", search_hint: "four", duration_seconds: 12 },
      ],
    };

    const fitted = fitYoutubeSectionDurations(plan as any, 31.5);

    expect(fitted.sections.reduce((sum, section) => sum + section.duration_seconds, 0)).toBe(32);
    expect(fitted.sections.map((section) => section.duration_seconds)).toEqual([8, 8, 7, 9]);
  });

  it("leaves plans inside budget unchanged", () => {
    const plan = {
      title: "Tight",
      web_search_needed: false,
      web_search_reason: "",
      sections: [
        { section: 1, dialogue: "one", search_hint: "one", duration_seconds: 5 },
        { section: 2, dialogue: "two", search_hint: "two", duration_seconds: 5 },
      ],
    };

    expect(fitYoutubeSectionDurations(plan as any, 12).sections.map((section) => section.duration_seconds)).toEqual([
      5,
      5,
    ]);
  });
});

describe("fitYoutubeScriptToBudget", () => {
  it("trims overlong dialogue when the subagent rewrite is unavailable", () => {
    const plan = {
      title: "Verbose",
      web_search_needed: false,
      web_search_reason: "",
      sections: [
        {
          section: 1,
          dialogue: "one two three four five six seven eight nine ten",
          search_hint: "one",
          duration_seconds: 10,
        },
        {
          section: 2,
          dialogue: "eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty",
          search_hint: "two",
          duration_seconds: 10,
        },
      ],
    };

    const fitted = fitYoutubeScriptToBudget(plan as any, { targetSectionSeconds: 12, maxWords: 8 });

    expect(fitted.sections.reduce((sum, section) => sum + section.duration_seconds, 0)).toBeLessThanOrEqual(12);
    expect(countSpokenWords(youtubeScriptNarration(fitted))).toBeLessThanOrEqual(8);
  });
});

describe("applyCandidateRanking", () => {
  it("moves subagent-ranked candidates first and preserves unranked candidates", () => {
    const candidates = [{ video_id: "a" }, { video_id: "b" }, { video_id: "c" }];

    expect(applyCandidateRanking(candidates, ["c", "missing", "a"]).map((candidate) => candidate.video_id)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });
});
