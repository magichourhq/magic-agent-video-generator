import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseDotenv } from "dotenv";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHARED_ENV = "/Users/tanmay/Magic Hour ML role/.env";

function dotenvValues(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  return parseDotenv(readFileSync(filePath, "utf-8"));
}

export function loadEnv(): Record<string, string> {
  const values: Record<string, string> = {
    ...dotenvValues(SHARED_ENV),
    ...dotenvValues(path.join(ROOT, ".env")),
  };
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) values[key] = value;
  }
  return values;
}

export const ENV = loadEnv();

// httpx-style safety net: empty proxy vars break some HTTP clients.
for (const proxyVar of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"]) {
  if (process.env[proxyVar] === "") delete process.env[proxyVar];
}

export const OUTPUT_DIR = path.resolve(ENV.OUTPUT_DIR ?? path.join(ROOT, "outputs"));
mkdirSync(OUTPUT_DIR, { recursive: true });

export const MH_AGENT_YT_CLIPS_DIR = path.resolve(
  ENV.MH_AGENT_YT_CLIPS_DIR ?? path.join(ROOT, "..", "mh_agent_output", "yt-clips"),
);

if (!process.env.OPENAI_API_KEY && ENV.OPENAI_API_KEY) {
  process.env.OPENAI_API_KEY = ENV.OPENAI_API_KEY;
}

export const REQUIRED_ENV_KEYS = [
  "OPENAI_API_KEY",
  "MAGIC_HOUR_API_KEY",
  "FISH_AUDIO_API_KEY",
  "FISH_AUDIO_REFERENCE_ID",
  "HUME_API_KEY",
] as const;

export const REQUIRED_SYSTEM_COMMANDS = ["ffmpeg", "ffprobe"] as const;

export const OPENAI_TEXT_PRICING_USD_PER_1M: Record<
  string,
  {
    input: number;
    cached_input: number;
    output: number;
    long_context_threshold_input_tokens: number;
    long_context_input_multiplier: number;
    long_context_output_multiplier: number;
    source: string;
  }
> = {
  "gpt-5.5": {
    input: 5.0,
    cached_input: 0.5,
    output: 30.0,
    long_context_threshold_input_tokens: 272_000,
    long_context_input_multiplier: 2.0,
    long_context_output_multiplier: 1.5,
    source: "https://developers.openai.com/api/docs/models/gpt-5.5/",
  },
  "gpt-5.4": {
    input: 2.5,
    cached_input: 0.25,
    output: 15.0,
    long_context_threshold_input_tokens: 272_000,
    long_context_input_multiplier: 2.0,
    long_context_output_multiplier: 1.5,
    source: "https://developers.openai.com/api/docs/models/gpt-5.4/",
  },
};

export const DEFAULT_AUTO_DURATION_SECONDS = 15;
export const DEFAULT_AUTO_SCENE_BUDGET_COUNT = 4;
export const DEFAULT_MAGIC_HOUR_IMAGE_MODEL = "nano-banana-2-lite";
export const DEFAULT_MAGIC_HOUR_VIDEO_MODEL = "ltx-2.3";
export const DEFAULT_AGENT_MAX_TURNS = 30;
export const DEFAULT_TTS_WORDS_PER_SECOND = 2.8;
export const DEFAULT_HUME_TTS_WORDS_PER_SECOND = 2.95;
// Thirty-one raw ElevenLabs takes measured 2.507 WPS median and 2.611 WPS at
// p75. Use the rounded p75 pace so first drafts cover runtime without padding.
export const DEFAULT_ELEVENLABS_TTS_WORDS_PER_SECOND = 2.6;
export const DEFAULT_ELEVENLABS_AUDIO_MODEL = "eleven_multilingual_v2";
export const DEFAULT_ELEVENLABS_VOICE_NAME = "brielle - podcast girl";
export const MAX_HUME_PLANNING_WORDS_PER_SECOND = 3.4;
export const MIN_TTS_WORDS_PER_SECOND = 1.6;
export const MAX_TTS_WORDS_PER_SECOND = 3.6;
export const NARRATION_MIN_FACTOR = 0.9;
export const NARRATION_MAX_FACTOR = 1.0;

export const YOUTUBE_REVIEW_PROMPT_SET_PATH = path.join(ROOT, "evals", "youtube_workflow_eval_prompts.jsonl");
