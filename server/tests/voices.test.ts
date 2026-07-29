import { describe, it, expect } from "vitest";
import {
  DEFAULT_HUME_UGC_VOICE_DESCRIPTION,
  FISH_AUDIO_VOICES,
  FEMALE_DEFAULT_VOICE,
  MALE_DEFAULT_VOICE,
  humeVoiceDescriptionForPlan,
  elevenLabsVoiceNameForPlan,
  inferCharacterGender,
  normalizePlanVoice,
  resolveVoiceReferenceId,
  shouldLockSingleSpeakerVoice,
  voiceContinuityIssues,
} from "../src/voices.js";

const SARAH = FISH_AUDIO_VOICES.sarah!.reference_id;
const ETHAN = FISH_AUDIO_VOICES.ethan!.reference_id;
const JASPHINA = FISH_AUDIO_VOICES.jasphina!.reference_id;
const ALLE = FISH_AUDIO_VOICES.alle!.reference_id;
const ENV_DEFAULT_REF = "ENV_DEFAULT_REF";

const ctx = { fish_audio_reference_id: ENV_DEFAULT_REF };

describe("inferCharacterGender", () => {
  it("detects a clearly-female description", () => {
    expect(
      inferCharacterGender({ visual_bible: "She is a young woman, a confident lady and mother." }),
    ).toBe("female");
  });

  it("detects a clearly-male description", () => {
    expect(
      inferCharacterGender({ visual_bible: "He is a young man, a confident guy and father." }),
    ).toBe("male");
  });

  it("returns unknown when there are no gender words", () => {
    expect(
      inferCharacterGender({ visual_bible: "A cozy kitchen at sunrise with warm tones." }),
    ).toBe("unknown");
  });

  it("returns unknown on a tie", () => {
    expect(inferCharacterGender({ visual_bible: "She and he walk together." })).toBe("unknown");
  });

  it("uses word boundaries (does not match 'he' inside 'the')", () => {
    expect(inferCharacterGender({ visual_bible: "The theme is there." })).toBe("unknown");
  });

  it("scans scenes narration and image_prompt as well as the bible", () => {
    expect(
      inferCharacterGender({
        scenes: [
          { narration: "A woman speaks." },
          { image_prompt: "portrait of a girl, actress" },
        ],
      }),
    ).toBe("female");
  });
});

describe("resolveVoiceReferenceId", () => {
  it("female bible, no voice -> sarah", () => {
    expect(
      resolveVoiceReferenceId({ visual_bible: "She is a woman." }, ctx),
    ).toBe(SARAH);
  });

  it("male bible, no voice -> ethan", () => {
    expect(
      resolveVoiceReferenceId({ visual_bible: "He is a man." }, ctx),
    ).toBe(ETHAN);
  });

  it("voice=jasphina (female) + female bible -> jasphina (candidate honored)", () => {
    expect(
      resolveVoiceReferenceId({ voice: "jasphina", visual_bible: "She is a woman." }, ctx),
    ).toBe(JASPHINA);
  });

  it("voice=ethan (male) + female bible -> overridden to sarah (mismatch guard)", () => {
    expect(
      resolveVoiceReferenceId({ voice: "ethan", visual_bible: "She is a woman." }, ctx),
    ).toBe(SARAH);
  });

  it("voice=alle (neutral) + female bible -> alle (neutral never overridden)", () => {
    expect(
      resolveVoiceReferenceId({ voice: "alle", visual_bible: "She is a woman." }, ctx),
    ).toBe(ALLE);
  });

  it("no voice + ambiguous bible -> env default reference id", () => {
    expect(
      resolveVoiceReferenceId({ visual_bible: "A cozy kitchen at sunrise." }, ctx),
    ).toBe(ENV_DEFAULT_REF);
  });

  it("no voice + ambiguous bible + no env reference -> neutral catalog fallback", () => {
    expect(
      resolveVoiceReferenceId({ visual_bible: "A cozy kitchen at sunrise." }, { fish_audio_reference_id: "" }),
    ).toBe(ALLE);
  });

  it("invalid voice key + male bible -> ethan (gender default)", () => {
    expect(
      resolveVoiceReferenceId({ voice: "bogus", visual_bible: "He is a man." }, ctx),
    ).toBe(ETHAN);
  });
});

describe("humeVoiceDescriptionForPlan", () => {
  it("defaults to a North American UGC voice instead of a vague/British-prone voice", () => {
    const description = humeVoiceDescriptionForPlan(
      {
        visual_bible: "Creator: a woman in her late 20s filming a phone-shot desk ad.",
        scenes: [{ image_prompt: "Same woman speaking naturally to camera." }],
      },
      "",
    );

    expect(description).toContain(DEFAULT_HUME_UGC_VOICE_DESCRIPTION);
    expect(description).toContain("neutral American accent");
    expect(description).toContain("not British");
    expect(description).toContain("clearly female voice with a North American/American English accent");
  });

  it("adds female creator guidance when the plan has female visual cues", () => {
    const description = humeVoiceDescriptionForPlan(
      {
        visual_bible: "Creator: a woman in her late 20s wearing a grey hoodie.",
        scenes: [{ image_prompt: "Same woman speaking to camera." }],
      },
      "Energetic Gen Z UGC creator, natural and expressive.",
    );

    expect(description).toContain("clearly female voice");
    expect(description).toContain("woman/female creator");
    expect(description).not.toContain("same voice identity");
    expect(description).not.toContain("every scene");
  });

  it("uses the selected catalog style when plan.voice is set", () => {
    const description = humeVoiceDescriptionForPlan(
      { voice: "jasphina", visual_bible: "She is a woman." },
      "",
    );

    expect(description).toContain(FISH_AUDIO_VOICES.jasphina!.style);
  });
});

describe("single-speaker UGC voice lock", () => {
  it("locks a female UGC creator to one energetic female voice key", () => {
    const plan = normalizePlanVoice({
      title: "AeroBottle TikTok UGC",
      creative_vibe: "raw_ugc",
      visual_bible: "A woman films herself at her desk during the workday.",
      scenes: [{ narration: "I keep forgetting to drink water.", image_prompt: "Same woman speaking to camera." }],
      voice: null,
    });

    expect(shouldLockSingleSpeakerVoice(plan)).toBe(true);
    expect(plan.voice).toBe("jasphina");
    expect(voiceContinuityIssues(plan)).toEqual([]);
  });

  it("does not force a single voice for explicit multi-speaker videos", () => {
    const plan = normalizePlanVoice({
      title: "Founder and customer interview",
      creative_vibe: "raw_ugc",
      visual_bible: "A woman and man have a conversation with different voices.",
      scenes: [{ narration: "This should move between two people.", image_prompt: "Two people talking." }],
      voice: null,
    });

    expect(shouldLockSingleSpeakerVoice(plan)).toBe(false);
    expect(plan.voice).toBeNull();
  });

  it("selects a calmer female voice for a narrated cinematic project", () => {
    const plan = normalizePlanVoice({
      title: "Quiet documentary portrait",
      creative_vibe: "cinematic_documentary",
      visual_bible: "A woman narrates her reflective morning.",
      narration: "I remember how still the city felt.",
      scenes: [{ narration: "I remember how still the city felt.", image_prompt: "The woman at dawn." }],
      voice: null,
    });

    expect(plan.voice).toBe("sarah");
    expect(elevenLabsVoiceNameForPlan(plan)).toBe("Rachel");
  });

  it("selects an energetic male voice for an upbeat social project", () => {
    const plan = normalizePlanVoice({
      title: "Fast TikTok product test",
      creative_vibe: "high_energy_social",
      visual_bible: "A man excitedly tests the product.",
      narration: "Okay, this is actually useful.",
      scenes: [{ narration: "Okay, this is actually useful.", image_prompt: "The man tests the product." }],
      voice: null,
    });

    expect(plan.voice).toBe("energetic_male");
    expect(elevenLabsVoiceNameForPlan(plan)).toBe("Adam");
  });
});

describe("catalog constants", () => {
  it("exposes the five curated voices", () => {
    expect(Object.keys(FISH_AUDIO_VOICES).sort()).toEqual(
      ["alle", "energetic_male", "ethan", "jasphina", "sarah"].sort(),
    );
  });

  it("uses sarah/ethan as gender defaults", () => {
    expect(FEMALE_DEFAULT_VOICE).toBe("sarah");
    expect(MALE_DEFAULT_VOICE).toBe("ethan");
  });
});
