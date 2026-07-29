import { describe, expect, it } from "vitest";
import {
  buildVisualMatchPrompt,
  cleanVttText,
  metadataSpecificityRejectionReason,
  normalizeYoutubeSearchProvider,
  parseVttTimestamp,
  parseYoutubeDurationSeconds,
  publishedAfterIso,
  redactSecretText,
  SEARCH_CANDIDATE_LIMIT,
  STOCK_OR_WATERMARK_SOURCE_PATTERN,
  TRANSCRIPT_CANDIDATE_LIMIT,
  visualFallbackDurationRejectionReason,
  visualFallbackWindow,
  visualVerificationFrameTimestamps,
  youtubeWindowDurationSeconds,
  YOUTUBE_CLIP_FORMAT_SELECTOR,
} from "../src/youtubeShort.js";

describe("candidate pool limits", () => {
  it("widens the search candidate pool to eighteen", () => {
    expect(SEARCH_CANDIDATE_LIMIT).toBe(18);
  });

  it("widens the transcript/first-accept pool to eight", () => {
    expect(TRANSCRIPT_CANDIDATE_LIMIT).toBe(8);
  });
});

describe("visualVerificationFrameTimestamps", () => {
  it("samples 5-6 frames including near-start (~0.04) and near-end (~0.96) edges", () => {
    const ts = visualVerificationFrameTimestamps(10);
    expect(ts.length).toBeGreaterThanOrEqual(5);
    expect(ts.length).toBeLessThanOrEqual(6);
    // near-start edge ~0.04 of 10s = ~0.4s
    expect(Math.min(...ts)).toBeLessThanOrEqual(0.5);
    // near-end edge ~0.96 of 10s = ~9.6s
    expect(Math.max(...ts)).toBeGreaterThanOrEqual(9.0);
    expect(Math.max(...ts)).toBeLessThanOrEqual(10.0);
    // timestamps must be sorted/ascending and unique-ish
    const sorted = [...ts].sort((a, b) => a - b);
    expect(ts).toEqual(sorted);
  });

  it("clamps the near-end edge to the INTENDED window, not the over-fetched file length", () => {
    // file is 20s but the intended/planned content is only the first 10s.
    const ts = visualVerificationFrameTimestamps(20, 10);
    // the latest sampled frame must land inside the intended 10s window, never the tail.
    expect(Math.max(...ts)).toBeLessThanOrEqual(10.0);
    // and it should be near the end of that intended window (~0.96 * 10 = ~9.6s)
    expect(Math.max(...ts)).toBeGreaterThanOrEqual(9.0);
  });

  it("uses the file duration when the intended window exceeds it", () => {
    const ts = visualVerificationFrameTimestamps(8, 30);
    expect(Math.max(...ts)).toBeLessThanOrEqual(8.0);
    expect(Math.max(...ts)).toBeGreaterThanOrEqual(7.0);
  });
});

describe("buildVisualMatchPrompt", () => {
  const section = { dialogue: "a", search_hint: "b", duration_seconds: 6 } as any;
  const candidate = { title: "t", channel_title: "c" } as any;
  const windowMatch = { text: "w" } as any;

  it("rejects clips that open or end on a title slate / intro-outro / end-screen / CTA", () => {
    const prompt = buildVisualMatchPrompt(section, candidate, windowMatch);
    expect(prompt).toContain("title slate");
    expect(prompt).toContain("end-screen");
    expect(prompt).toMatch(/opens or ends/i);
  });

  it("rejects nearly-identical frozen/static frames", () => {
    const prompt = buildVisualMatchPrompt(section, candidate, windowMatch);
    expect(prompt).toContain("static");
    expect(prompt).toMatch(/nearly identical|frozen/i);
  });

  it("only rejects when the slate/CTA/static dominates the frame", () => {
    const prompt = buildVisualMatchPrompt(section, candidate, windowMatch);
    expect(prompt).toMatch(/dominates/i);
    expect(prompt).toMatch(/corner logo/i);
  });

  it("keeps the existing watermark/stock-footage rejection", () => {
    const prompt = buildVisualMatchPrompt(section, candidate, windowMatch);
    expect(prompt).toContain("watermark");
    expect(prompt).toContain("stock footage");
  });
});

describe("youtubeWindowDurationSeconds", () => {
  it("over-fetches the planned window by 1.4x + 1.5s when the source is long", () => {
    // planned=4 => max(4, 4*1.4 + 1.5) = max(4, 7.1) = 7.1
    expect(youtubeWindowDurationSeconds(4, 60)).toBeCloseTo(7.1, 3);
  });

  it("clamps the over-fetch to the available source duration", () => {
    // source shorter than the desired over-fetch => clamp to source.
    expect(youtubeWindowDurationSeconds(4, 5)).toBeCloseTo(5, 3);
  });

  it("never returns less than the planned duration when source allows", () => {
    // planned dominates only when 1.4x+1.5 would be smaller, which it never is for
    // positive planned values; this still must be >= planned and <= source.
    const win = youtubeWindowDurationSeconds(10, 100);
    expect(win).toBeGreaterThanOrEqual(10);
    expect(win).toBeLessThanOrEqual(100);
    expect(win).toBeCloseTo(15.5, 3); // 10*1.4 + 1.5
  });
});

describe("publishedAfterIso", () => {
  it("formats UTC seconds-precision timestamps with a Z suffix", () => {
    const value = publishedAfterIso();
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("subtracts the requested number of days", () => {
    const value = publishedAfterIso(45);
    const deltaMs = Date.now() - Date.parse(value);
    expect(deltaMs).toBeGreaterThan(45 * 86_400_000 - 5_000);
    expect(deltaMs).toBeLessThan(45 * 86_400_000 + 5_000);
  });
});

describe("parseVttTimestamp", () => {
  it("parses HH:MM:SS.mmm timestamps", () => {
    expect(parseVttTimestamp("01:02:03.500")).toBeCloseTo(3723.5);
  });

  it("parses MM:SS,mmm timestamps with comma separators", () => {
    expect(parseVttTimestamp("01:02,500")).toBeCloseTo(62.5);
  });

  it("parses bare seconds", () => {
    expect(parseVttTimestamp("02.500")).toBeCloseTo(2.5);
  });
});

describe("parseYoutubeDurationSeconds", () => {
  it("parses ISO8601 PT#M#S durations", () => {
    expect(parseYoutubeDurationSeconds("PT4M13S")).toBe(253);
  });

  it("parses durations with days and hours", () => {
    expect(parseYoutubeDurationSeconds("P1DT2H3M4S")).toBe(86400 + 7200 + 180 + 4);
  });

  it("returns null for zero or invalid durations", () => {
    expect(parseYoutubeDurationSeconds("PT0S")).toBeNull();
    expect(parseYoutubeDurationSeconds("garbage")).toBeNull();
    expect(parseYoutubeDurationSeconds(null)).toBeNull();
  });
});

describe("STOCK_OR_WATERMARK_SOURCE_PATTERN", () => {
  it("matches stock and watermark metadata", () => {
    expect(STOCK_OR_WATERMARK_SOURCE_PATTERN.test("Royalty-free stock footage of the ocean")).toBe(true);
    expect(STOCK_OR_WATERMARK_SOURCE_PATTERN.test("Watermarked preview from Shutterstock")).toBe(true);
    expect(STOCK_OR_WATERMARK_SOURCE_PATTERN.test("no copyright nature video")).toBe(true);
  });

  it("does not match ordinary titles", () => {
    expect(STOCK_OR_WATERMARK_SOURCE_PATTERN.test("OpenAI launches GPT-5 with live demo")).toBe(false);
  });
});

describe("redactSecretText", () => {
  it("redacts API key query params and Google API keys", () => {
    const input = "request to https://example.com/v3/search?key=AIzaSyA123_-abc&part=snippet failed";
    const redacted = redactSecretText(input);
    expect(redacted).not.toContain("AIzaSyA123_-abc");
    expect(redacted).toContain("?key=[redacted]");
  });

  it("redacts bare Google API keys in text", () => {
    expect(redactSecretText("token AIzaSyB456 leaked")).toBe("token [redacted] leaked");
  });
});

describe("visualFallbackWindow", () => {
  it("starts at 18% of long videos, capped by the wanted duration", () => {
    expect(visualFallbackWindow(100, 10)).toEqual([18, 28]);
  });

  it("uses the whole video when it is shorter than the wanted duration", () => {
    expect(visualFallbackWindow(8, 10)).toEqual([0, 8]);
  });

  it("enforces the minimum 4 second start offset", () => {
    expect(visualFallbackWindow(20, 10)).toEqual([4, 14]);
  });
});

describe("visualFallbackDurationRejectionReason", () => {
  it("allows long authoritative clips when captions are optional", () => {
    const section = {
      search_hint: "NASA Artemis II moon flyby",
      dialogue: "NASA is preparing an Artemis moon flyby.",
      require_captions: false,
      channel_hint: "NASA",
    } as any;

    expect(
      visualFallbackDurationRejectionReason(
        section,
        { title: "Artemis II Moon Flyby", channel_title: "NASA" },
        2_400,
      ),
    ).toBeNull();
  });

  it("still rejects long clips from weak sources or caption-required scenes", () => {
    const section = {
      search_hint: "NASA Artemis II moon flyby",
      dialogue: "NASA is preparing an Artemis moon flyby.",
      require_captions: false,
      channel_hint: "NASA",
    } as any;

    expect(
      visualFallbackDurationRejectionReason(
        section,
        { title: "Artemis II Moon Flyby", channel_title: "Random Clips" },
        2_400,
      ),
    ).toBe("video is too long for visual fallback without transcript");

    expect(
      visualFallbackDurationRejectionReason(
        { ...section, require_captions: true },
        { title: "Artemis II Moon Flyby", channel_title: "NASA" },
        2_400,
      ),
    ).toBe("video is too long for visual fallback without transcript");
  });
});

describe("YOUTUBE_CLIP_FORMAT_SELECTOR", () => {
  it("does not force the obsolete single mp4 format", () => {
    expect(YOUTUBE_CLIP_FORMAT_SELECTOR).not.toBe("mp4");
    expect(YOUTUBE_CLIP_FORMAT_SELECTOR).toContain("bv*");
    expect(YOUTUBE_CLIP_FORMAT_SELECTOR).toContain("ba");
  });
});

describe("metadataSpecificityRejectionReason", () => {
  it("rejects low-authority commentary for current OpenAI news", () => {
    const section = {
      search_hint: "latest open ai news Built to benefit everyone OpenAI",
      dialogue: "On June eighth, leadership published a fresh company roadmap and mission update.",
      require_captions: false,
      channel_hint: "OpenAI",
    } as any;

    expect(
      metadataSpecificityRejectionReason(
        section,
        {
          title: "AI Whistleblower: We Are Being Gaslit By AI Companies",
          channel_title: "The Diary Of A CEO",
          description: "OpenAI mission discussion from a podcast interview.",
        },
        false,
      ),
    ).toBe("metadata does not match current OpenAI official or reputable source");

    expect(
      metadataSpecificityRejectionReason(
        section,
        {
          title: "OpenAI company update",
          channel_title: "OpenAI",
          description: "Official OpenAI update.",
        },
        false,
      ),
    ).toBeNull();
  });
});

describe("cleanVttText", () => {
  it("strips cue tags, unescapes entities, and collapses whitespace", () => {
    expect(cleanVttText("<c.colorE5E5E5>Hello</c> &amp;   world&#39;s")).toBe("Hello & world's");
  });
});

describe("normalizeYoutubeSearchProvider", () => {
  it("coerces legacy providers to the Data API", () => {
    expect(normalizeYoutubeSearchProvider("auto")).toBe("youtube_data_api");
    expect(normalizeYoutubeSearchProvider("yt_dlp")).toBe("youtube_data_api");
    expect(normalizeYoutubeSearchProvider(null)).toBe("youtube_data_api");
  });

  it("rejects unknown providers", () => {
    expect(() => normalizeYoutubeSearchProvider("bing")).toThrow("Unsupported YouTube search provider: bing");
  });
});
