import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { execa } from "execa";
import OpenAI from "openai";
import { ENV } from "./config.js";
import type { ProjectContext } from "./context.js";
import { probeMediaDuration } from "./media.js";
import type { YouTubeClipSection } from "./schemas.js";
import { rankYoutubeCandidatesWithSubagent, youtubeSubagentModel, type YoutubeCandidateSubagentResult } from "./youtubeSubagents.js";

export type Candidate = Record<string, any>;

const YOUTUBE_API_KEY_NAMES = ["YOUTUBE_API_KEY_1", "YOUTUBE_API_KEY_2", "YOUTUBE_API_KEY_3", "YOUTUBE_API_KEY"] as const;
const YOUTUBE_API_KEY_VALIDATION_VIDEO_ID = "dQw4w9WgXcQ";
export const SEARCH_CANDIDATE_LIMIT = 18;
export const TRANSCRIPT_CANDIDATE_LIMIT = 8;
export const MIN_TRANSCRIPT_WINDOW_SCORE = 2.0;
export const MIN_VISUAL_FALLBACK_SCORE = 3.0;
export const MAX_VISUAL_FALLBACK_DURATION_SECONDS = 600.0;
export const YOUTUBE_CLIP_FORMAT_SELECTOR = "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/best";
const SECTION_QUERY_TOKEN_LIMIT = 10;
const BACKUP_SEARCH_MIN_SCENE_SCORE = 5.0;
const BROAD_SUBJECT_TOKEN =
  /^(?:ai|artificial intelligence|small businesses?|business(?:es)?|automation|tasks?|customer service|human touch|customer experience|innovation|balance|interaction|benefits?)$/i;
export const AUTO_YOUTUBE_SEARCH_PROVIDER = "auto";
export const YOUTUBE_DATA_API_PROVIDER = "youtube_data_api";
export const YT_DLP_SEARCH_PROVIDER = "yt_dlp";
export const DEFAULT_YOUTUBE_SEARCH_PROVIDER = YOUTUBE_DATA_API_PROVIDER;
// yt-dlp search was dropped for recall quality; legacy "auto"/"yt_dlp" values
// are still accepted from old payloads but always coerce to the Data API.
export const YOUTUBE_SEARCH_PROVIDERS = new Set([
  AUTO_YOUTUBE_SEARCH_PROVIDER,
  YOUTUBE_DATA_API_PROVIDER,
  YT_DLP_SEARCH_PROVIDER,
]);
// YouTube Data API videoCategoryId values the script planner may target.
const YOUTUBE_VIDEO_CATEGORY_IDS: Record<string, string> = {
  film_animation: "1",
  autos_vehicles: "2",
  music: "10",
  pets_animals: "15",
  sports: "17",
  travel_events: "19",
  gaming: "20",
  people_blogs: "22",
  comedy: "23",
  entertainment: "24",
  news_politics: "25",
  howto_style: "26",
  education: "27",
  science_technology: "28",
};
const YOUTUBE_SEARCH_ORDERS = new Set(["relevance", "date", "viewCount", "rating"]);
const YOUTUBE_VIDEO_DURATIONS = new Set(["short", "medium", "long"]);
const YOUTUBE_URL_VIDEO_ID_PATTERN =
  /(?:youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;
const PLANNER_WEB_SEARCH_PROVIDER = "planner_web_search";
// Verified/official channels get a soft score boost in candidate ranking.
// These are channels with YouTube verification badges (or equivalent authority)
// across diverse categories — not limited to tech.
const VERIFIED_CHANNEL_NAMES = new Set<string>([
  // Tech / AI
  "openai", "anthropic", "google", "google deepmind", "nvidia",
  "microsoft", "apple", "meta", "amazon web services", "ibm",
  // News / Media
  "bbc news", "cnn", "reuters", "associated press", "the new york times",
  "the wall street journal", "bloomberg television", "cnbc", "al jazeera english",
  "the guardian", "nbc news", "abc news", "cbs news", "fox news",
  "sky news", "vice news", "vox", "the verge",
  // Science / Education
  "nasa", "national geographic", "ted", "ted-ed", "veritasium",
  "kurzgesagt – in a nutshell", "vsauce", "minutephysics", "smarter every day",
  "khan academy", "crashcourse", "3blue1brown",
  // Sports
  "nba", "nfl", "espn", "premier league", "ufc", "formula 1",
  "olympics", "nhl", "mlb",
  // Entertainment / Music
  "netflix", "hbo", "disney", "warner bros. pictures", "universal pictures",
  "sony pictures entertainment", "a24",
  // Business / Finance
  "goldman sachs", "jpmorgan chase", "tesla", "spacex",
  "y combinator", "harvard business review",
]);
const VERIFIED_CHANNEL_SCORE_BOOST = 4.0;
// yt-dlp network safety net: bound each call so one stalled download/probe
// cannot hang the whole generation run. These are per-call ceilings, NOT a
// run-abort deadline — runs are never killed mid-generation.
const YT_DLP_SOCKET_TIMEOUT_SECONDS = 15;
export const YT_DLP_SUBPROCESS_TIMEOUT_SECONDS = 120;
let workingYoutubeApiKey: string | null = null;
const VIDEO_DURATION_CACHE = new Map<string, number>();
const TRANSCRIPT_ENTRIES_CACHE = new Map<string, Array<Record<string, any>>>();
const RECENT_QUERY_PATTERN = /\b(latest|today|tonight|current|breaking|news)\b/i;
const HISTORICAL_QUERY_PATTERN =
  /\b(19\d{2}|20\d{2}|season|career|history|historic|classic|highlights?|recap|documentary|throwback)\b/i;
const NEWS_CATEGORY_QUERY_PATTERN =
  /\b(shooting|election|war|attack|trial|lawsuit|earnings|weather|emergency|press|briefing|political)\b/i;
const UNRELATED_ENTERTAINMENT_PATTERN =
  /\b(?:anime|manhwa|manga|recap|episode|chapter|paranormal|nether|gameplay|minecraft|roblox|podcast|talking-head)\b|動漫|诡异|熱血/i;
const OPENAI_COMPETITOR_PATTERN = /\b(?:anthropic|claude|gemini|grok|llama|meta)\b/i;
const OPENAI_SUBJECT_PATTERN = /\b(?:open\s*ai|openai|chatgpt|gpt|codex)\b/i;
const OPENAI_MODEL_TERM_PATTERN = /\b(?:chatgpt|gpt)\s*[- ]?\s*(\d+(?:\.\d+)?[a-z]?)\b/i;
const OPENAI_REASONING_MODEL_TERM_PATTERN = /\bo\s*[- ]?\s*(?:1(?:[- ]?(?:pro|mini))?|3|4(?:[- ]?mini)?)\b/i;
const OPENAI_PRODUCT_QUERY_PATTERN =
  /\b(?:gpt\s*[- ]?\s*(?:\d+(?:\.\d+)?[a-z]?|[a-z][a-z0-9-]*)|o\s*[- ]?\s*(?:1(?:[- ]?(?:pro|mini))?|3|4(?:[- ]?mini)?)|codex|chatgpt(?:\s+atlas)?|sora|agentkit|dall-e)\b/i;
const OPENAI_TUTORIAL_PATTERN =
  /\b(?:api\s*key|tutorial|how\s+to|walkthrough|beginners?|course|build\s+your\s+first)\b/i;
const OPENAI_HYPE_COVERAGE_PATTERN =
  /\b(?:shocked|mind[- ]?blowing|insane|crazy|huge\s+upgrade|just\s+got\s+a|slashed|game[- ]?chang(?:ing|er))\b/i;
const OPENAI_REPUTABLE_SOURCE_PATTERN =
  /\b(?:openai|microsoft|visual\s+studio\s+code|reuters|the\s+verge|techcrunch|cnbc|bloomberg|associated\s+press|ap\s+news|wall\s+street\s+journal|wsj|wired)\b/i;
const OPENAI_NAMED_REPUTABLE_SOURCE_PATTERN =
  /\b(?:reuters|the\s+verge|techcrunch|cnbc|bloomberg|associated\s+press|ap\s+news|wall\s+street\s+journal|wsj|wired)\b/i;
const OPENAI_LOW_AUTHORITY_COVERAGE_PATTERN =
  /\b(?:ai\s+(?:horizon|daily|with|news|clips?|updates?|show)|horizon\s+daily|arun\s+show|generated|stock|commentary|deep\s+dive|beyond\s+the\s+hype|is\s+here|most\s+powerful)\b/i;
const OPENAI_CAREER_INTERVIEW_PATTERN = /\b(?:career|job\s*interview|jobinterview|resume|hiring)\b/i;
const MODERN_IPHONE_PATTERN = /\biphone\s*(?:[2-9]|1[0-9])\b/i;
const KEYNOTE_COMMENTARY_PATTERN = /\b(?:podcast|chronicles?|commentary|breakdown|explained)\b/i;
const ANCIENT_COIN_EVIDENCE_PATTERN =
  /\b(?:coins?|numismatic|numismatics|denarius|drachma|solidus|roman|greek|byzantine|medieval|classical)\b/i;
const ANCIENT_COIN_CLICKBAIT_PATTERN =
  /(?:\bminers?\s+found\b|\b350\s+million\b|#\s*(?:facts?|mystery)\b|\bmystery\s+shorts?\b)/i;
const ANCIENT_COIN_MODERN_US_CURRENCY_PATTERN =
  /\b(?:one\s+dollar|u\.?s\.?|united\s+states|eagle\s+dollar|silver\s+dollars?|everyday\s+circulation|pocket\s+change)\b/i;
const UNRELATED_SUBMARINE_EXPLAINER_PATTERN = /\b(?:military\s+secrets?|submarines?|hydrophones?)\b/i;
const SPORTS_ACTION_QUERY_PATTERN =
  /\b(?:highlights?|touchdowns?|rushing|yards?|hurdle|run|runs|game|season|tape)\b/i;
const SPORTS_COMMENTARY_INTERVIEW_PATTERN =
  /\b(?:post[-\s]?interview|interview|talking[-\s]?head|news|rumors?|reactors?|reacting|reaction|chat\s+sports|podcast|sit\s+or\s+play|sit\s+week|ending\s+chase|chase\s+for|resting|nfl\s+24h\s+online|snap\s+n\s+shove|national\s+voice|player\s+photos?)\b/i;
const GPT4O_MINI_PATTERN = /\bgpt\s*[- ]?\s*4o\s*[- ]?\s*mini\b/i;
const GENERIC_FACTOID_CLIP_PATTERN = /(?:\btop\s*\d+\b|#\s*(?:facts?|animals?|wildlife)\b|\bfactpaw\b)/i;
const DEEP_SEA_CREATURE_QUERY_PATTERN =
  /\b(?:deep\s+sea|bioluminescent|jellyfish|squid|creatures?|underwater)\b/i;
const DEEP_SEA_DRAMATIZED_STOCK_PATTERN =
  /\b(?:mythveil|morgawr|terrified|sea[-\s]?monster|fictional|cryptid|stock[-\s]?style|stock\s+footage|generated|deep\s+ocean\s+enigma\s+lab|beyond\s+the\s+abyss)\b/i;
export const STOCK_OR_WATERMARK_SOURCE_PATTERN = new RegExp(
  "\\b(?:" +
    "stock\\s+(?:footage|video|videos|clips?|library|media|preview)|" +
    "(?:footage|video)\\s+stock|" +
    "royalty[-\\s]?free|copyright[-\\s]?free|no\\s+copyright|" +
    "watermark(?:ed)?|" +
    "visustock|clever\\s+stock|naturefootage|shutterstock|pond5|storyblocks|videvo|" +
    "pixabay|pexels|istock|adobe\\s+stock|envato\\s+elements|motion\\s+elements|videezy" +
    ")\\b",
  "i",
);
const VTT_TIMESTAMP_PATTERN =
  /(?<start>\d{2}:\d{2}(?::\d{2})?[.,]\d{3})\s+-->\s+(?<end>\d{2}:\d{2}(?::\d{2})?[.,]\d{3})/;
const YOUTUBE_ISO_DURATION_PATTERN =
  /^P(?:(?<days>\d+)D)?(?:T(?:(?<hours>\d+)H)?(?:(?<minutes>\d+)M)?(?:(?<seconds>\d+)S)?)?$/;
const SECRET_QUERY_PARAM_PATTERN = /([?&](?:key|api_key|token|access_token)=)[^&\s"'<>]+/gi;
const GOOGLE_API_KEY_PATTERN = /AIza[0-9A-Za-z_-]+/g;
const QUERY_CHANNEL_STOPWORDS = new Set([
  "about",
  "announcement",
  "and",
  "are",
  "broll",
  "briefing",
  "but",
  "can",
  "clips",
  "current",
  "demo",
  "developer",
  "footage",
  "for",
  "free",
  "from",
  "generic",
  "has",
  "have",
  "into",
  "its",
  "latest",
  "launch",
  "local",
  "major",
  "near",
  "news",
  "off",
  "official",
  "onto",
  "our",
  "press",
  "product",
  "reputable",
  "roll",
  "scene",
  "scenes",
  "shot",
  "shots",
  "short",
  "stock",
  "that",
  "the",
  "their",
  "then",
  "there",
  "these",
  "this",
  "those",
  "through",
  "today",
  "tonight",
  "toward",
  "towards",
  "was",
  "were",
  "where",
  "which",
  "while",
  "who",
  "with",
  "without",
  "update",
  "video",
  "videos",
]);
const VISUAL_GENERIC_TOKENS = new Set([
  ...QUERY_CHANNEL_STOPWORDS,
  "barkley", // handled as a required named entity with saquon below
  "clip",
  "clips",
  "close",
  "explainer",
  "highlight",
  "highlights",
  "minute",
  "minutes",
  "reel",
  "shorts",
  "source",
  "sources",
  "vertical",
]);
const QUERY_VARIANT_STOPWORDS = new Set([
  ...[...VISUAL_GENERIC_TOKENS].filter((token) => token !== "demo"),
  "about",
  "and",
  "from",
  "latest",
  "news",
  "official",
  "openai",
  "or",
  "product",
  "real",
  "reputable",
  "source",
  "sources",
  "the",
  "using",
]);
const BROAD_VISUAL_QUERY_STOPWORDS = new Set([
  ...QUERY_VARIANT_STOPWORDS,
  "checking",
  "employee",
  "friendly",
  "helping",
  "late",
  "owner",
  "person",
  "show",
  "showing",
  "using",
  "working",
]);
const OPENAI_VISUAL_FALLBACK_GENERIC_TOKENS = new Set([
  ...VISUAL_GENERIC_TOKENS,
  "chatgpt",
  "gpt",
  "latest",
  "news",
  "official",
  "openai",
  "product",
  "reputable",
]);

// ---------------------------------------------------------------------------
// Generic helpers mirroring Python stdlib semantics
// ---------------------------------------------------------------------------

function errorText(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

function toError(exc: unknown): Error {
  return exc instanceof Error ? exc : new Error(String(exc));
}

/** All matches of `pattern` in `text` (re.finditer equivalent). */
function reFindIter(pattern: RegExp, text: string): RegExpMatchArray[] {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return [...text.matchAll(new RegExp(pattern.source, flags))];
}

function setIntersection<T>(a: Set<T>, b: Set<T>): Set<T> {
  const out = new Set<T>();
  for (const item of a) if (b.has(item)) out.add(item);
  return out;
}

function setIsDisjoint<T>(a: Set<T>, b: Set<T>): boolean {
  for (const item of a) if (b.has(item)) return false;
  return true;
}

function setIsSubset<T>(a: Set<T>, b: Set<T>): boolean {
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

/** round(x, 3) — note JS half-up vs Python banker's rounding on exact ties. */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Python str(float): integers render with a trailing ".0" (e.g. "4.0"). */
function pythonFloatStr(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e16) return `${value}.0`;
  return String(value);
}

/** Mirror Python's f"{value:g}" formatting (6 significant digits, no trailing zeros). */
export function formatG(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return "0";
  const exp = Math.floor(Math.log10(Math.abs(value)));
  if (exp < -4 || exp >= 6) {
    const [rawMantissa, rawExponent] = value.toExponential(5).split("e") as [string, string];
    let mantissa = rawMantissa;
    if (mantissa.includes(".")) mantissa = mantissa.replace(/0+$/, "").replace(/\.$/, "");
    const sign = rawExponent.startsWith("-") ? "-" : "+";
    const digits = rawExponent.replace(/^[+-]/, "").padStart(2, "0");
    return `${mantissa}e${sign}${digits}`;
  }
  let out = value.toPrecision(6);
  if (out.includes("e")) out = Number(out).toString();
  if (out.includes(".")) out = out.replace(/0+$/, "").replace(/\.$/, "");
  return out;
}

// Subset of Python html.unescape sufficient for YouTube VTT caption text.
const HTML_NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
};

function htmlUnescape(text: string): string {
  return text.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (full, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isNaN(code) ? full : String.fromCodePoint(code);
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isNaN(code) ? full : String.fromCodePoint(code);
    }
    const named = HTML_NAMED_ENTITIES[body.toLowerCase()];
    return named ?? full;
  });
}

// ---------------------------------------------------------------------------
// Environment / API key handling
// ---------------------------------------------------------------------------

function envValue(...keys: string[]): string | null {
  // ENV already merges shared .env, project .env, and process.env with the
  // same precedence the Python dotenv lookups used.
  for (const key of keys) {
    const value = ENV[key];
    if (value) return String(value);
  }
  return null;
}

export function redactSecretText(value: string): string {
  const redacted = value.replace(SECRET_QUERY_PARAM_PATTERN, "$1[redacted]");
  return redacted.replace(GOOGLE_API_KEY_PATTERN, "[redacted]");
}

function candidateYoutubeApiKeys(): Array<[string, string]> {
  const candidates: Array<[string, string]> = [];
  const seenValues = new Set<string>();
  const configuredNames = process.env.YOUTUBE_API_KEY_ALIASES;
  const keyNames = configuredNames
    ? configuredNames
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name)
    : [...YOUTUBE_API_KEY_NAMES];
  for (const keyName of keyNames) {
    const value = envValue(keyName);
    if (!value || seenValues.has(value)) continue;
    candidates.push([keyName, value]);
    seenValues.add(value);
  }
  return candidates;
}

function orderedYoutubeApiKeys(): Array<[string, string]> {
  const candidates = candidateYoutubeApiKeys();
  if (!workingYoutubeApiKey) return candidates;
  let preferred: [string, string] | null = null;
  const rest: Array<[string, string]> = [];
  for (const [keyName, apiKey] of candidates) {
    if (apiKey === workingYoutubeApiKey) {
      preferred = [keyName, apiKey];
    } else {
      rest.push([keyName, apiKey]);
    }
  }
  if (preferred === null) return candidates;
  return [preferred, ...rest];
}

class YouTubeApiError extends Error {
  content: string | null;

  constructor(message: string, content: string | null) {
    super(message);
    this.name = "YouTubeApiError";
    this.content = content;
  }
}

/** Plain REST replacement for googleapiclient request execution. */
async function youtubeApiRequest(apiKey: string, endpoint: string, params: Record<string, any>): Promise<Record<string, any>> {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
  url.searchParams.set("key", apiKey);
  const response = await fetch(url);
  if (!response.ok) {
    let body: string | null = null;
    try {
      body = await response.text();
    } catch {
      body = null;
    }
    throw new YouTubeApiError(
      `HTTP ${response.status} ${response.statusText} when requesting ${url.toString()}`,
      body,
    );
  }
  return (await response.json()) as Record<string, any>;
}

function youtubeDataApiFailureMessage(exc: unknown): string {
  let message = errorText(exc);
  const content = exc instanceof YouTubeApiError ? exc.content : null;
  if (typeof content === "string") {
    let payload: any = null;
    try {
      payload = JSON.parse(content);
    } catch {
      payload = null;
    }
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const error = payload.error;
      if (error && typeof error === "object" && !Array.isArray(error)) {
        message = String(error.message || message);
        const errors = error.errors;
        if (Array.isArray(errors)) {
          const reasons = errors
            .filter((item: any) => item && typeof item === "object" && item.reason)
            .map((item: any) => String(item.reason));
          if (reasons.length > 0) {
            message = `${message} (${reasons.join(", ")})`;
          }
        }
      }
    }
  }
  return redactSecretText(message);
}

async function isYoutubeApiKeyWorking(apiKey: string): Promise<[boolean, string | null]> {
  let response: Record<string, any>;
  try {
    response = await youtubeApiRequest(apiKey, "videos", { part: "id", id: YOUTUBE_API_KEY_VALIDATION_VIDEO_ID });
  } catch (exc) {
    return [false, youtubeDataApiFailureMessage(exc)];
  }
  if (Array.isArray(response.items) && response.items.length > 0) {
    return [true, null];
  }
  return [false, "YouTube Data API key validation returned no public video metadata."];
}

async function youtubeApiKeyValue(): Promise<string> {
  if (workingYoutubeApiKey) return workingYoutubeApiKey;

  const candidates = candidateYoutubeApiKeys();
  if (candidates.length === 0) {
    throw new Error("Missing YOUTUBE_API_KEY_1, YOUTUBE_API_KEY_2, YOUTUBE_API_KEY_3, or YOUTUBE_API_KEY for YouTube clip search.");
  }

  const errors: string[] = [];
  for (const [keyName, apiKey] of candidates) {
    const [working, error] = await isYoutubeApiKeyWorking(apiKey);
    if (working) {
      workingYoutubeApiKey = apiKey;
      return apiKey;
    }
    errors.push(`${keyName}: ${error || "validation failed"}`);
  }

  throw new Error(`No working YouTube Data API key configured. ${errors.join("; ")}`);
}

// ---------------------------------------------------------------------------
// Query heuristics
// ---------------------------------------------------------------------------

function looksFactualQuery(query: string): boolean {
  if (!RECENT_QUERY_PATTERN.test(query)) return false;
  if (
    HISTORICAL_QUERY_PATTERN.test(query) &&
    !/\b(latest|today|tonight|current|breaking|update)\b/i.test(query)
  ) {
    return false;
  }
  return true;
}

function shouldMergeLiteralRelevanceForFactualQuery(query: string): boolean {
  return OPENAI_PRODUCT_QUERY_PATTERN.test(query);
}

function requiresStrictRecentOpenaiResults(query: string): boolean {
  return /\bopenai\b/i.test(query) && /\b(?:latest|today|tonight|current|breaking|recent)\b/i.test(query);
}

function needsNewsCategory(query: string): boolean {
  if (/\b(openai|product|demo|launch|introducing|sports?|season|highlights?)\b/i.test(query)) {
    return false;
  }
  return NEWS_CATEGORY_QUERY_PATTERN.test(query);
}

function queryEntityTokens(query: string): string[] {
  const tokens: string[] = [];
  for (const token of query.match(/[A-Za-z0-9]+/g) ?? []) {
    const lowered = token.toLowerCase();
    if (
      (lowered.length < 3 && !/^(?:[a-z]\d|\d[a-z])$/.test(lowered)) ||
      QUERY_CHANNEL_STOPWORDS.has(lowered)
    ) {
      continue;
    }
    if (!tokens.includes(lowered)) tokens.push(lowered);
  }
  return tokens;
}

export function normalizedToken(value: string): string {
  const token = value.toLowerCase();
  if (token.length > 4 && token.endsWith("ies")) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.length > 3 && token.endsWith("s")) {
    return token.slice(0, -1);
  }
  return token;
}

function normalizedTokenSet(text: string): Set<string> {
  return new Set(queryEntityTokens(text).map((token) => normalizedToken(token)));
}

function candidateText(candidate: Candidate): string {
  return ["title", "channel_title", "description"]
    .map((field) => String(candidate[field] ?? ""))
    .join(" ");
}

function requiresOfficialOpenaiSource(queryLower: string): boolean {
  if (!queryLower.includes("official")) return false;
  if (/\bofficial\s+or\s+reputable\b|\breputable\b/i.test(queryLower)) return false;
  return /\b(?:openai|chatgpt|gpt|codex)\b/i.test(queryLower);
}

function stockOrWatermarkedSourceRejectionReason(candidate: Candidate): string | null {
  if (STOCK_OR_WATERMARK_SOURCE_PATTERN.test(candidateText(candidate))) {
    return "metadata looks like stock or watermarked source";
  }
  return null;
}

function candidateFieldRejectionReason(query: string, candidate: Candidate): string | null {
  const queryLower = query.toLowerCase();
  const text = candidateText(candidate);
  const candidateLower = text.toLowerCase();
  const channel = String(candidate.channel_title ?? "").trim().toLowerCase();
  const stockRejection = stockOrWatermarkedSourceRejectionReason(candidate);
  if (stockRejection) return stockRejection;
  if (requiresOfficialOpenaiSource(queryLower) && channel !== "openai") {
    return "metadata does not match required official OpenAI source";
  }
  if (
    OPENAI_SUBJECT_PATTERN.test(queryLower) &&
    /\b(?:latest|today|tonight|current|breaking|recent|news|june|2026)\b/i.test(queryLower) &&
    !OPENAI_REPUTABLE_SOURCE_PATTERN.test(channel)
  ) {
    return "metadata does not match current OpenAI official or reputable source";
  }
  if (
    OPENAI_SUBJECT_PATTERN.test(queryLower) &&
    OPENAI_PRODUCT_QUERY_PATTERN.test(query) &&
    !OPENAI_REPUTABLE_SOURCE_PATTERN.test(channel) &&
    OPENAI_LOW_AUTHORITY_COVERAGE_PATTERN.test(text)
  ) {
    return "metadata does not match reputable OpenAI source";
  }
  const requestedReputableSources = new Set(
    reFindIter(OPENAI_NAMED_REPUTABLE_SOURCE_PATTERN, query).map((match) => match[0].toLowerCase()),
  );
  if (requestedReputableSources.size > 0 && !OPENAI_NAMED_REPUTABLE_SOURCE_PATTERN.test(text)) {
    return "metadata does not match requested reputable source";
  }
  if (
    /\b(?:openai|chatgpt|gpt|codex)\b/i.test(queryLower) &&
    /\b(?:demo|camera|desktop|voice|launch|update)\b/i.test(queryLower) &&
    OPENAI_CAREER_INTERVIEW_PATTERN.test(text) &&
    !OPENAI_CAREER_INTERVIEW_PATTERN.test(query)
  ) {
    return "metadata looks like career/interview content, not an OpenAI product demo";
  }
  if (
    /\b(?:steve\s+jobs|macworld|keynote)\b/i.test(queryLower) &&
    KEYNOTE_COMMENTARY_PATTERN.test(text) &&
    !/\b(?:introduces?|unveils?|demo|presentation|iphone)\b/i.test(candidateLower)
  ) {
    return "metadata looks like podcast or commentary, not keynote footage";
  }
  return null;
}

function canonicalOpenaiReasoningModelTerm(raw: string): string {
  const compact = raw.toLowerCase().replace(/[\s_-]+/g, "");
  if (compact === "o4mini") return "o4-mini";
  if (compact === "o1pro") return "o1-pro";
  if (compact === "o1mini") return "o1-mini";
  return compact;
}

function openaiModelTerms(text: string): Set<string> {
  const terms = new Set(
    reFindIter(OPENAI_MODEL_TERM_PATTERN, text).map((match) => `gpt-${(match[1] ?? "").toLowerCase()}`),
  );
  for (const match of reFindIter(OPENAI_REASONING_MODEL_TERM_PATTERN, text)) {
    terms.add(canonicalOpenaiReasoningModelTerm(match[0]));
  }
  return terms;
}

function hasUnrelatedEntertainmentTerms(query: string, text: string): boolean {
  return UNRELATED_ENTERTAINMENT_PATTERN.test(text) && !UNRELATED_ENTERTAINMENT_PATTERN.test(query);
}

function hasOpenaiSourceMismatch(query: string, text: string): boolean {
  if (!OPENAI_SUBJECT_PATTERN.test(query)) return false;
  if (OPENAI_COMPETITOR_PATTERN.test(text) && !OPENAI_COMPETITOR_PATTERN.test(query)) return true;
  const queryModels = openaiModelTerms(query);
  const candidateModels = openaiModelTerms(text);
  return queryModels.size > 0 && candidateModels.size > 0 && setIsDisjoint(queryModels, candidateModels);
}

function candidateScore(query: string, candidate: Candidate): number {
  const queryLower = query.toLowerCase();
  const title = String(candidate.title ?? "").toLowerCase();
  const channel = String(candidate.channel_title ?? "").toLowerCase();
  const description = String(candidate.description ?? "").toLowerCase();
  const text = candidateText(candidate);
  const entityTokens = queryEntityTokens(query);
  const wantsOfficial = requiresOfficialOpenaiSource(queryLower);
  let score = 0.0;
  for (const token of entityTokens) {
    if (channel.includes(token)) score += 5.0;
    if (title.includes(token)) score += 1.5;
    if (description.includes(token)) score += 0.5;
  }
  if (wantsOfficial && entityTokens.some((token) => channel.includes(token))) {
    score += 8.0;
  }
  if (wantsOfficial && queryLower.includes("openai") && channel.trim() === "openai") {
    score += 12.0;
  }
  if (VERIFIED_CHANNEL_NAMES.has(channel.trim())) {
    score += VERIFIED_CHANNEL_SCORE_BOOST;
  }
  if (title.includes("shorts") || title.includes("#short")) {
    score -= 3.0;
  }
  if (/\b(memorial|tribute)\b/.test(title)) {
    score -= 12.0;
  }
  if (title.includes("reaction") && !queryLower.includes("reaction")) {
    score -= 8.0;
  }
  if (hasUnrelatedEntertainmentTerms(queryLower, text)) {
    score -= 18.0;
  }
  if (hasOpenaiSourceMismatch(queryLower, text)) {
    score -= 16.0;
  }
  const queryYears = new Set(queryLower.match(/\b(?:19|20)\d{2}\b/g) ?? []);
  const titleYears = new Set(title.match(/\b(?:19|20)\d{2}\b/g) ?? []);
  if (queryYears.size > 0 && titleYears.size > 0 && setIsDisjoint(queryYears, titleYears)) {
    score -= 8.0;
  }
  if (queryLower.includes("iphone") && (queryYears.has("2007") || queryLower.includes("first iphone"))) {
    if (/\biphone\s*(?:[2-9]|1[0-9])\b/.test(title)) {
      score -= 20.0;
    }
  }
  return score;
}

function requiredEntityRejectionReason(query: string, text: string): string | null {
  const queryLower = query.toLowerCase();
  const candidateLower = text.toLowerCase();
  if (
    /\bgpt\s*[- ]?\s*4o\b/i.test(query) &&
    !GPT4O_MINI_PATTERN.test(query) &&
    GPT4O_MINI_PATTERN.test(text)
  ) {
    return "metadata does not match required OpenAI model";
  }
  const queryModels = openaiModelTerms(query);
  if (queryModels.size > 0 && setIsDisjoint(queryModels, openaiModelTerms(text))) {
    return "metadata does not match required OpenAI model";
  }
  if (
    OPENAI_SUBJECT_PATTERN.test(queryLower) &&
    OPENAI_TUTORIAL_PATTERN.test(text) &&
    !OPENAI_TUTORIAL_PATTERN.test(query)
  ) {
    return "metadata looks like generic OpenAI tutorial";
  }
  if (OPENAI_SUBJECT_PATTERN.test(queryLower) && OPENAI_HYPE_COVERAGE_PATTERN.test(text)) {
    return "metadata looks like hype OpenAI coverage";
  }
  if (
    OPENAI_SUBJECT_PATTERN.test(queryLower) &&
    !OPENAI_SUBJECT_PATTERN.test(candidateLower)
  ) {
    return "metadata does not match required OpenAI subject";
  }
  if (
    /\b(?:before\s+the\s+iphone|physical\s+keyboards?|2006)\b/i.test(queryLower) &&
    MODERN_IPHONE_PATTERN.test(text)
  ) {
    return "metadata looks like modern iPhone footage";
  }
  if (
    /\b(?:steve\s+jobs|macworld|keynote)\b/i.test(queryLower) &&
    /\b(?:2007|macworld|iphone)\b/i.test(queryLower) &&
    /\b(?:memorial|tribute|celebrating\s+steve|october\s+5)\b/i.test(candidateLower)
  ) {
    return "metadata does not match required 2007 Macworld keynote footage";
  }
  if (
    /\bdesktop\s+app\b/i.test(queryLower) &&
    !/\b(?:desktop|mac\s*app|windows\s*app|chatgpt\s*app)\b/i.test(candidateLower)
  ) {
    return "metadata does not match required desktop app scene";
  }
  if (queryLower.includes("iphone") && queryLower.includes("steve jobs")) {
    const hasJobs = /\b(?:steve|jobs)\b/i.test(candidateLower);
    const hasIphoneContext = /\b(?:iphone|macworld)\b/i.test(candidateLower);
    if (!hasJobs || !hasIphoneContext) {
      return "metadata does not match required iPhone keynote subject";
    }
  }
  if (/\b(?:saquon|barkley)\b/i.test(queryLower) && !/\b(?:saquon|barkley)\b/i.test(candidateLower)) {
    return "metadata does not match required Saquon Barkley subject";
  }
  if (
    /\b(?:saquon|barkley)\b/i.test(queryLower) &&
    SPORTS_ACTION_QUERY_PATTERN.test(query) &&
    SPORTS_COMMENTARY_INTERVIEW_PATTERN.test(text)
  ) {
    return "metadata looks like sports commentary or interview";
  }
  if (DEEP_SEA_CREATURE_QUERY_PATTERN.test(query) && DEEP_SEA_DRAMATIZED_STOCK_PATTERN.test(text)) {
    return "metadata looks like dramatized or stock deep-sea footage";
  }
  if (DEEP_SEA_CREATURE_QUERY_PATTERN.test(query) && GENERIC_FACTOID_CLIP_PATTERN.test(text)) {
    return "metadata looks like generic factoid clip";
  }
  if (
    /\b(?:researchers?|reviewing|review|scientists?|lab)\b/i.test(queryLower) &&
    UNRELATED_SUBMARINE_EXPLAINER_PATTERN.test(text) &&
    !/\b(?:researchers?|research|scientists?|science|laboratory)\b/i.test(candidateLower)
  ) {
    return "metadata does not match required research scene";
  }
  if (
    /\b(?:reviewing|review|replay|monitor|frames?|ship\s+lab|research\s+vessel)\b/i.test(queryLower) &&
    /\b(?:researchers?|scientists?)\b/i.test(queryLower) &&
    !/\b(?:reviewing|review|replay|monitor|screen|frames?|footage|video|lab|laboratory|vessel|ship|deck|aboard|control\s+room)\b/i.test(
      candidateLower,
    )
  ) {
    return "metadata does not match required research review scene";
  }
  if (
    /\b(?:researchers?|scientists?|lab)\b/i.test(queryLower) &&
    !/\b(?:researchers?|research|scientists?|science|lab|laboratory)\b/i.test(candidateLower)
  ) {
    return "metadata does not match required research scene";
  }
  if (/\bancient coins?\b/i.test(queryLower)) {
    if (ANCIENT_COIN_CLICKBAIT_PATTERN.test(text)) {
      return "metadata does not match required ancient coin subject";
    }
    if (ANCIENT_COIN_MODERN_US_CURRENCY_PATTERN.test(text)) {
      return "metadata does not match required ancient coin subject";
    }
    if (!ANCIENT_COIN_EVIDENCE_PATTERN.test(text)) {
      return "metadata does not match required ancient coin subject";
    }
    if (
      !/\b(?:ancient|roman|greek|medieval|byzantine|archaeolog|artifact|artefact|numismatic|numismatics|classical)\b/i.test(
        candidateLower,
      )
    ) {
      return "metadata does not match required ancient coin subject";
    }
  }
  return null;
}

/**
 * Generic subject-identity gate: when a confident dominant subject was attached
 * to the section (subject_tokens), the candidate's text must mention at least
 * one of those tokens. Returns a rejection reason otherwise. No-op (null) when
 * subjectTokens is empty, so behavior is unchanged for prompts without a
 * confident proper-noun subject. The candidate text is expected already
 * lowercased (as sectionContextText / candidateText produce).
 */
export function requiredSubjectRejectionReason(candidateText: string, subjectTokens: string[]): string | null {
  const requiredTokens = (subjectTokens ?? []).filter((token) => !BROAD_SUBJECT_TOKEN.test(String(token).trim()));
  if (requiredTokens.length === 0) return null;
  const candidateLower = candidateText.toLowerCase();
  const tokens = new Set(normalizedTokenSet(candidateLower));
  const matches = requiredTokens.some((token) => {
    const lower = token.toLowerCase();
    if (tokens.has(normalizedToken(lower))) return true;
    // Fall back to substring containment for multi-token / hyphenated names.
    return candidateLower.includes(lower);
  });
  if (matches) return null;
  return `metadata does not match required subject: ${requiredTokens.slice(0, 3).join(", ")}`;
}

export function metadataSpecificityRejectionReason(
  section: YouTubeClipSection,
  candidate: Candidate,
  strictOverlap = true,
): string | null {
  const searchHint = String(section.search_hint ?? "");
  const context = sectionContextText(section);
  const text = candidateText(candidate);
  const requiredRejection = requiredEntityRejectionReason(context, text);
  if (requiredRejection) return requiredRejection;
  const subjectRejection = requiredSubjectRejectionReason(text, section.subject_tokens ?? []);
  if (subjectRejection) return subjectRejection;
  const fieldRejection = candidateFieldRejectionReason(context, candidate);
  if (fieldRejection) return fieldRejection;
  if (!strictOverlap) return null;

  const queryTokens = new Set(
    [...normalizedTokenSet(searchHint)].filter((token) => !VISUAL_GENERIC_TOKENS.has(token)),
  );
  if (queryTokens.size < 4) return null;
  const candidateTokens = normalizedTokenSet(text);
  const overlap = setIntersection(queryTokens, candidateTokens);
  const minimumOverlap = queryTokens.size >= 6 ? 2 : 1;
  if (overlap.size < minimumOverlap) {
    return (
      "metadata does not match search intent: " +
      `matched ${overlap.size} of ${queryTokens.size} specific token(s)`
    );
  }
  return null;
}

function rankVideoCandidates(query: string, candidates: Candidate[]): Candidate[] {
  return candidates
    .map((candidate, index) => ({ candidate, index, score: candidateScore(query, candidate) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.candidate);
}

export function normalizeYoutubeSearchProvider(searchProvider: string | null | undefined): string {
  const provider = (searchProvider || DEFAULT_YOUTUBE_SEARCH_PROVIDER).trim();
  if (!YOUTUBE_SEARCH_PROVIDERS.has(provider)) {
    throw new Error(`Unsupported YouTube search provider: ${provider}`);
  }
  return YOUTUBE_DATA_API_PROVIDER;
}

function compactQuery(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sectionContextText(section: YouTubeClipSection): string {
  return compactQuery(
    [section.dialogue ?? "", section.search_hint ?? ""].map((value) => String(value ?? "")).join(" "),
  );
}

function canonicalOpenaiProductTerm(term: string): string {
  const compacted = term.replace(/\s+/g, " ").trim();
  const lowered = compacted.toLowerCase();
  if (lowered.startsWith("gpt")) {
    const suffix = compacted.replace(/^gpt\s*[- ]?\s*/i, "");
    return `GPT-${suffix}`;
  }
  if (lowered === "codex") return "Codex";
  if (lowered.startsWith("chatgpt atlas")) return "ChatGPT Atlas";
  if (lowered === "chatgpt") return "ChatGPT";
  if (lowered === "sora") return "Sora";
  if (lowered === "agentkit") return "AgentKit";
  if (lowered === "dall-e") return "DALL-E";
  return compacted;
}

function compactOpenaiQueryVariant(text: string): string | null {
  const matches = reFindIter(OPENAI_PRODUCT_QUERY_PATTERN, text);
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1]!;
  const product = canonicalOpenaiProductTerm(last[0]);
  const tail = text.slice((last.index ?? 0) + last[0].length);
  const actionTokens: string[] = [];
  for (const token of tail.match(/[A-Za-z0-9]+/g) ?? []) {
    if (token.length < 3) continue;
    const normalized = normalizedToken(token);
    if (QUERY_VARIANT_STOPWORDS.has(normalized) || normalized === "chatgpt" || normalized === "gpt") {
      continue;
    }
    if (!actionTokens.includes(token.toLowerCase())) actionTokens.push(token.toLowerCase());
  }
  const query = compactQuery(["OpenAI", product, ...actionTokens.slice(0, 6)].join(" "));
  return query.toLowerCase() !== compactQuery(text).toLowerCase() ? query : null;
}

function compactSectionQueryVariant(section: YouTubeClipSection): string | null {
  const context = sectionContextText(section);
  const tokens = queryEntityTokens(context);
  if (tokens.length === 0) return null;
  const query = compactQuery(tokens.slice(0, SECTION_QUERY_TOKEN_LIMIT).join(" "));
  const primary = compactQuery(String(section.search_hint ?? ""));
  if (!query || query.toLowerCase() === primary.toLowerCase()) return null;
  return query;
}

function sectionBackoffSearchHintVariants(section: YouTubeClipSection): string[] {
  const variants: string[] = [];
  for (const text of [String(section.search_hint ?? ""), sectionContextText(section)]) {
    const variant = compactOpenaiQueryVariant(text);
    if (!variant) continue;
    if (variant.toLowerCase() === String(section.search_hint ?? "").trim().toLowerCase()) continue;
    if (!variants.some((item) => item.toLowerCase() === variant.toLowerCase())) {
      variants.push(variant);
    }
  }
  const genericVariant = compactSectionQueryVariant(section);
  if (genericVariant && !variants.some((item) => item.toLowerCase() === genericVariant.toLowerCase())) {
    variants.push(genericVariant);
  }
  return variants;
}

function sectionWithCandidateUrls(section: YouTubeClipSection, urls: string[]): YouTubeClipSection {
  return { ...section, candidate_video_urls: urls };
}

function webSearchVideoUrlsForSection(_section: YouTubeClipSection): string[] {
  return [];
}

function sectionWithSearchHint(section: YouTubeClipSection, searchHint: string): YouTubeClipSection {
  return { ...section, search_hint: searchHint };
}

/**
 * Translate agent-provided scene targeting fields into search.list params.
 *
 * The script planner sets these per scene so retrieval intent (recency,
 * category, captions, clip length) is explicit instead of inferred from
 * query-text heuristics.
 */
function sectionSearchParams(section: YouTubeClipSection): Record<string, any> {
  const params: Record<string, any> = {};
  const order = String(section.search_order ?? "").trim();
  if (YOUTUBE_SEARCH_ORDERS.has(order)) {
    params.order = order;
  }
  for (const [field, apiKey] of [
    ["published_after", "publishedAfter"],
    ["published_before", "publishedBefore"],
  ] as const) {
    const raw = String((section as Record<string, any>)[field] ?? "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      params[apiKey] = `${raw}T00:00:00Z`;
    } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(raw)) {
      params[apiKey] = raw;
    }
  }
  const videoDuration = String(section.video_duration ?? "").trim();
  if (YOUTUBE_VIDEO_DURATIONS.has(videoDuration)) {
    params.videoDuration = videoDuration;
  }
  const category = String(section.video_category ?? "").trim();
  if (category in YOUTUBE_VIDEO_CATEGORY_IDS) {
    params.videoCategoryId = YOUTUBE_VIDEO_CATEGORY_IDS[category];
  }
  if (section.require_captions) {
    params.videoCaption = "closedCaption";
  }
  return params;
}

/** Video IDs from planner-provided YouTube URLs (found via web search). */
function sectionCandidateVideoIds(section: YouTubeClipSection): string[] {
  const urls = section.candidate_video_urls ?? [];
  const videoIds: string[] = [];
  for (const url of urls) {
    const match = YOUTUBE_URL_VIDEO_ID_PATTERN.exec(String(url ?? ""));
    if (match && match[1] && !videoIds.includes(match[1])) {
      videoIds.push(match[1]);
    }
  }
  return videoIds;
}

async function plannerCandidateVideos(section: YouTubeClipSection): Promise<Candidate[]> {
  return hydrateCandidateVideoIds(sectionCandidateVideoIds(section), PLANNER_WEB_SEARCH_PROVIDER);
}

/**
 * Validate and hydrate video IDs via videos.list (1 quota unit).
 *
 * Hallucinated or dead IDs simply do not come back from the API, so this also
 * acts as validation. Returns the same candidate shape as Data API search.
 */
async function hydrateCandidateVideoIds(videoIds: string[], provider: string): Promise<Candidate[]> {
  if (videoIds.length === 0) return [];
  let response: Record<string, any>;
  try {
    response = await youtubeVideoDetailsResponse(videoIds.slice(0, 5));
  } catch {
    return [];
  }
  const candidates: Candidate[] = [];
  for (const item of response.items ?? []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const videoId = String(item.id ?? "");
    if (!videoId) continue;
    const snippet = item.snippet && typeof item.snippet === "object" ? item.snippet : {};
    const contentDetails = item.contentDetails && typeof item.contentDetails === "object" ? item.contentDetails : {};
    const candidate: Candidate = {
      video_id: videoId,
      title: snippet.title ?? null,
      channel_title: snippet.channelTitle ?? null,
      published_at: snippet.publishedAt ?? null,
      description: snippet.description ?? null,
    };
    const duration = parseYoutubeDurationSeconds(String(contentDetails.duration ?? ""));
    if (duration) {
      candidate.duration_seconds = duration;
      VIDEO_DURATION_CACHE.set(videoId, duration);
    }
    const tags = snippet.tags;
    if (Array.isArray(tags)) {
      candidate.tags = tags.filter((tag: any) => typeof tag === "string").map((tag: string) => String(tag));
    }
    candidates.push(candidate);
  }
  return annotateSearchCandidates(candidates, {
    requested_provider: provider,
    used_provider: provider,
    attempts: [{ provider, query: videoIds.join(","), result_count: candidates.length }],
  });
}

function sectionChannelHint(section: YouTubeClipSection): string {
  return compactQuery(String(section.channel_hint ?? ""));
}

function sectionSearchQueries(section: YouTubeClipSection): string[] {
  let primary = compactQuery(String(section.search_hint ?? ""));
  const channelHint = sectionChannelHint(section);
  if (channelHint && !primary.toLowerCase().includes(channelHint.toLowerCase())) {
    primary = compactQuery(`${primary} ${channelHint}`);
  }
  const context = sectionContextText(section);
  let focused = queryEntityTokens(context).slice(0, SECTION_QUERY_TOKEN_LIMIT).join(" ");
  if (focused && primary && looksFactualQuery(primary) && !RECENT_QUERY_PATTERN.test(focused)) {
    focused = `latest ${focused}`;
  }
  const queries: string[] = [];
  const broadTokens = queryEntityTokens(context)
    .filter((token) => !BROAD_VISUAL_QUERY_STOPWORDS.has(token))
    .slice(0, 4);
  const broad = broadTokens.length >= 2 ? `${broadTokens.join(" ")} b roll` : "";
  for (const query of [primary, focused, broad]) {
    if (query && !queries.some((item) => item.toLowerCase() === query.toLowerCase())) {
      queries.push(query);
    }
  }
  return queries;
}

function sectionCandidateScore(section: YouTubeClipSection, candidate: Candidate): number {
  const dialogue = String(section.dialogue ?? "");
  let score =
    candidateScore(sectionContextText(section), candidate) + candidateScore(dialogue, candidate) * 1.25;
  const channelHint = sectionChannelHint(section);
  if (channelHint) {
    const channelTitle = String(candidate.channel_title ?? "");
    const hintTokens = normalizedTokenSet(channelHint);
    if (hintTokens.size > 0 && setIsSubset(hintTokens, normalizedTokenSet(channelTitle))) {
      score += 6.0;
    }
  }
  return score;
}

function candidateMatchesChannelHint(section: YouTubeClipSection, candidate: Candidate): boolean {
  const channelHint = sectionChannelHint(section);
  if (!channelHint) return false;
  const hintTokens = normalizedTokenSet(channelHint);
  if (hintTokens.size === 0) return false;
  return setIsSubset(hintTokens, normalizedTokenSet(String(candidate.channel_title ?? "")));
}

function candidateHasAuthoritativeChannel(section: YouTubeClipSection, candidate: Candidate): boolean {
  if (candidateMatchesChannelHint(section, candidate)) return true;
  const channel = String(candidate.channel_title ?? "").trim().toLowerCase();
  return VERIFIED_CHANNEL_NAMES.has(channel);
}

function candidateIsWebSourced(candidate: Candidate): boolean {
  return candidate._search_provider === PLANNER_WEB_SEARCH_PROVIDER;
}

function visualFallbackRejectionReason(
  section: YouTubeClipSection,
  candidate: Candidate,
  score: number,
): string | null {
  const query = sectionContextText(section);
  const text = candidateText(candidate);
  const stockRejection = stockOrWatermarkedSourceRejectionReason(candidate);
  if (stockRejection) return stockRejection;
  if (hasUnrelatedEntertainmentTerms(query, text)) {
    return "candidate looks like unrelated entertainment or recap content";
  }
  if (hasOpenaiSourceMismatch(query, text)) {
    return "candidate conflicts with the requested OpenAI source or model";
  }
  if (candidateIsWebSourced(candidate)) {
    // Web-search candidates were relevance-vetted by live search ranking,
    // so skip the strict token-overlap guards (highlight/b-roll titles
    // rarely echo the hint). But the model sometimes hallucinates video
    // ids that resolve to unrelated uploads, so require at least one
    // shared token between scene context and the hydrated metadata.
    const contextTokens = new Set(
      [...normalizedTokenSet(sectionContextText(section))].filter(
        (token) => !VISUAL_GENERIC_TOKENS.has(token),
      ),
    );
    if (contextTokens.size > 0 && setIntersection(contextTokens, normalizedTokenSet(text)).size === 0) {
      return "web-sourced candidate metadata shares no tokens with the scene";
    }
    return null;
  }
  const metadataRejection = metadataSpecificityRejectionReason(section, candidate);
  if (metadataRejection) return metadataRejection;
  if (/\b(?:openai|chatgpt|gpt|codex)\b/i.test(query)) {
    const requiredTokens = new Set(
      [...normalizedTokenSet(String(section.search_hint ?? ""))].filter(
        (token) => !OPENAI_VISUAL_FALLBACK_GENERIC_TOKENS.has(token),
      ),
    );
    if (requiredTokens.size > 0) {
      const candidateTokens = normalizedTokenSet(text);
      const overlap = setIntersection(requiredTokens, candidateTokens);
      if (overlap.size === 0) {
        return "metadata does not match search intent: missing " + [...requiredTokens].sort().slice(0, 3).join(", ");
      }
    }
  }
  if (score < MIN_VISUAL_FALLBACK_SCORE) {
    return `candidate score too weak: ${formatG(score)}`;
  }
  return null;
}

export function visualFallbackDurationRejectionReason(
  section: YouTubeClipSection,
  candidate: Candidate,
  totalDuration: number,
): string | null {
  if (totalDuration <= MAX_VISUAL_FALLBACK_DURATION_SECONDS) return null;
  if (!section.require_captions && candidateHasAuthoritativeChannel(section, candidate)) return null;
  return "video is too long for visual fallback without transcript";
}

/**
 * Compute the YouTube clip download window length.
 *
 * The download is trimmed at the planned (pre-voiceover) section duration, but the
 * per-section TTS voiceover almost always runs longer, so a clip cut to the planned
 * length is shorter than its narration and the timeline freezes the last frame (a dead
 * end-pause). We over-fetch the window so there is real footage to cover the longer VO:
 * `max(planned, planned*1.4 + 1.5)`, clamped to the source's available duration. The
 * window extends FORWARD from the transcript-match start (see pickTranscriptWindow), so
 * we never pull in the video's final seconds / end-cards.
 */
export function youtubeWindowDurationSeconds(plannedDuration: number, sourceDuration: number): number {
  const planned = Math.max(0, Number(plannedDuration) || 0);
  const overFetch = Math.max(planned, planned * 1.4 + 1.5);
  const clamped = Number.isFinite(sourceDuration) && sourceDuration > 0 ? Math.min(overFetch, sourceDuration) : overFetch;
  return round3(clamped);
}

/**
 * ffprobe the actual downloaded clip so the recorded source window reflects real footage,
 * not the planned estimate. Falls back to the requested window length if the probe fails,
 * so a transient ffprobe error never discards an otherwise-good download.
 */
async function probedClipDuration(filePath: string, requestedWindow: number): Promise<number> {
  try {
    return round3(await probeMediaDuration(filePath));
  } catch {
    const fallback = Number(requestedWindow);
    return round3(Number.isFinite(fallback) && fallback > 0 ? fallback : 1);
  }
}

export function visualFallbackWindow(totalDuration: number, wantedDuration: number): [number, number] {
  const wanted = Math.min(wantedDuration, totalDuration);
  const latestStart = Math.max(0.0, totalDuration - wanted);
  if (latestStart <= 0) {
    return [0.0, round3(totalDuration)];
  }
  const start = Math.min(latestStart, Math.max(4.0, totalDuration * 0.18));
  return [round3(start), round3(Math.min(totalDuration, start + wanted))];
}

function truthyEnv(value: string | null | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

function visualVerifierEnabled(): boolean {
  const configured = envValue("YOUTUBE_VISUAL_VERIFY", "YOUTUBE_VISUAL_VERIFY_ENABLED");
  if (configured === null) return true;
  return truthyEnv(configured);
}

async function ffprobeClipDuration(clipPath: string): Promise<number | null> {
  const result = await execa(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", clipPath],
    { reject: false, timeout: 15_000 },
  );
  if (result.timedOut) {
    throw new Error(`ffprobe timed out for ${clipPath}`);
  }
  if (result.exitCode !== 0) return null;
  const duration = Number.parseFloat(String(result.stdout).trim());
  if (Number.isNaN(duration)) return null;
  return duration > 0 ? duration : null;
}

/**
 * Fractional sample points across the clip. Edges (~0.04 open, ~0.96 close) catch the
 * title slates / intro cards (open) and end-screens / subscribe CTAs (close) that the old
 * 0.2/0.5/0.8 sampling missed, plus interior points so a frozen/static shot is detectable.
 */
const VISUAL_VERIFICATION_FRAME_OFFSETS = [0.04, 0.22, 0.4, 0.6, 0.78, 0.96] as const;

/**
 * Sample timestamps (seconds) for visual verification frames.
 *
 * Edge frames are taken relative to the INTENDED window length (the planned section
 * duration the clip represents), NOT the full over-fetched file length, so the ~0.96
 * close-edge frame lands near the end of the content that will actually be used rather
 * than in the over-fetched tail. The effective duration is clamped to the real file
 * duration so we never seek past the end of the file.
 */
export function visualVerificationFrameTimestamps(fileDuration: number, intendedDuration?: number): number[] {
  const file = Number.isFinite(fileDuration) && fileDuration > 0 ? fileDuration : 5.0;
  const intended = Number.isFinite(intendedDuration as number) && (intendedDuration as number) > 0
    ? (intendedDuration as number)
    : file;
  // Sample within the intended/planned window, but never seek past the real file end.
  const effective = Math.min(file, intended);
  return VISUAL_VERIFICATION_FRAME_OFFSETS.map((offset) => round3(Math.max(0.0, effective * offset)));
}

async function extractVisualVerificationFrames(
  clipPath: string,
  outputDir: string,
  intendedDuration?: number,
): Promise<string[]> {
  const duration = (await ffprobeClipDuration(clipPath)) || 5.0;
  const frames: string[] = [];
  const timestamps = visualVerificationFrameTimestamps(duration, intendedDuration);
  for (let index = 1; index <= timestamps.length; index++) {
    const timestamp = timestamps[index - 1]!;
    const framePath = path.join(outputDir, `verify_${index}.jpg`);
    const result = await execa(
      "ffmpeg",
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        timestamp.toFixed(3),
        "-i",
        clipPath,
        "-frames:v",
        "1",
        "-vf",
        "scale='min(640,iw)':-2",
        "-q:v",
        "4",
        framePath,
      ],
      { reject: false, timeout: 30_000 },
    );
    if (result.timedOut) {
      throw new Error(`ffmpeg frame extraction timed out for ${clipPath}`);
    }
    if (result.exitCode === 0 && existsSync(framePath) && statSync(framePath).size > 0) {
      frames.push(framePath);
    }
  }
  return frames;
}

function imageDataUri(filePath: string): string {
  const encoded = readFileSync(filePath).toString("base64");
  return `data:image/jpeg;base64,${encoded}`;
}

function responseOutputText(response: any): string {
  const outputText = response?.output_text;
  if (typeof outputText === "string" && outputText.trim()) {
    return outputText;
  }
  const chunks: string[] = [];
  for (const item of response?.output ?? []) {
    for (const content of item?.content ?? []) {
      const text = content?.text;
      if (typeof text === "string") chunks.push(text);
    }
  }
  return chunks.join("\n");
}

/**
 * Build the visual-hygiene judge prompt. Pure so the artifact-rejection rules can be
 * asserted in tests without invoking OpenAI. The JSON shape (match/reason) is unchanged.
 */
export function buildVisualMatchPrompt(
  section: YouTubeClipSection,
  candidate: Candidate,
  windowMatch: Record<string, any>,
): string {
  return (
    "You are a cheap visual hygiene subagent verifying sampled frames from a downloaded YouTube clip. " +
    "The frames are ordered from the start to the end of the clip. " +
    "Reject if the frames visibly show an ad, sponsor slate, subscribe/like/bell callout, end screen, title card, " +
    "podcast art, presenter/reactor overlay, generic UI, heavy distracting captions, watermark preview, black frame, " +
    "unrelated news package, stock footage, or a different event/product than requested. " +
    "Reject when a subscribe/follow/like/bell prompt or other call-to-action banner is LARGE or PROMINENT " +
    "(a full-width lower-third bar, a big subscribe/end-card overlay, or anything covering a significant part of the frame), " +
    "especially when it persists across MOST of the sampled frames. " +
    "Also reject if the clip OPENS or ENDS on a title slate, intro/outro card, or end-screen that dominates that frame, " +
    "or if the sampled frames are nearly identical (a frozen/static shot with no real motion). " +
    "A small corner logo, small channel watermark, or a thin minor banner is acceptable even if it stays on screen — small overlays are fine. " +
    "If the narration or search hint names a specific real person or team, the footage must show that ACTUAL person or team — " +
    "reject impersonators, children in costume, lookalikes, fan cosplay, jersey-only tributes, or video-game / animation renderings of them. " +
    "Accept only when the visible footage itself supports the narration and search hint.\n\n" +
    `Narration: ${section.dialogue ?? ""}\n` +
    `Search hint: ${section.search_hint ?? ""}\n` +
    `YouTube title: ${candidate.title}\n` +
    `YouTube channel: ${candidate.channel_title}\n` +
    `Transcript/window text: ${windowMatch.text}\n\n` +
    "Return JSON with keys: match (boolean), reason (short string)."
  );
}

async function openaiVisualMatchJudgment(
  section: YouTubeClipSection,
  candidate: Candidate,
  clipPath: string,
  windowMatch: Record<string, any>,
): Promise<Record<string, any>> {
  const apiKey = envValue("OPENAI_API_KEY");
  if (!apiKey) {
    return { match: false, reason: "OPENAI_API_KEY is not configured for visual verification" };
  }
  const tmp = mkdtempSync(path.join(os.tmpdir(), "yt-visual-verify-"));
  let response: any;
  try {
    // Sample frames against the intended/planned section window so the close-edge (~0.96)
    // frame lands at the end of the content that will actually be used, not the over-fetched tail.
    const frames = await extractVisualVerificationFrames(clipPath, tmp, Number(section.duration_seconds) || undefined);
    if (frames.length === 0) {
      return { match: false, reason: "could not extract verification frames" };
    }
    const prompt = buildVisualMatchPrompt(section, candidate, windowMatch);
    const content: any[] = [{ type: "input_text", text: prompt }];
    content.push(
      ...frames.map((frame) => ({ type: "input_image", image_url: imageDataUri(frame), detail: "low" })),
    );
    response = await new OpenAI({ apiKey }).responses.create(
      {
        model: envValue("YOUTUBE_VISUAL_VERIFY_MODEL", "YOUTUBE_SUBAGENT_MODEL", "OPENAI_FAST_MODEL") || youtubeSubagentModel(),
        input: [{ role: "user", content }],
        max_output_tokens: 180,
        text: {
          format: {
            type: "json_schema",
            name: "youtube_visual_match",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                match: { type: "boolean" },
                reason: { type: "string" },
              },
              required: ["match", "reason"],
            },
          },
        },
      } as any,
      { timeout: Number(envValue("YOUTUBE_VISUAL_VERIFY_TIMEOUT_SECONDS") || 45) * 1000 },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const rawText = responseOutputText(response);
  let parsed: any;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { match: false, reason: `visual verifier returned invalid JSON: ${rawText.slice(0, 120)}` };
  }
  return { match: Boolean(parsed?.match), reason: String(parsed?.reason || "visual mismatch") };
}

async function clipVisualRejectionReason(
  section: YouTubeClipSection,
  candidate: Candidate,
  clipPath: string,
  windowMatch: Record<string, any>,
): Promise<string | null> {
  if (!visualVerifierEnabled()) return null;
  let judgment: Record<string, any>;
  try {
    judgment = await openaiVisualMatchJudgment(section, candidate, clipPath, windowMatch);
  } catch (exc) {
    return `visual verifier failed: ${redactSecretText(errorText(exc))}`;
  }
  if (judgment.match === true) return null;
  const reason = String(judgment.reason || "visible frames do not match narration");
  return `visual verifier mismatch: ${reason}`;
}

function rankSectionCandidates(section: YouTubeClipSection, candidates: Candidate[]): Candidate[] {
  return candidates
    .map((candidate, index) => ({ candidate, index, score: sectionCandidateScore(section, candidate) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.candidate);
}

function dedupeCandidates(candidates: Candidate[]): Candidate[] {
  const deduped: Candidate[] = [];
  const seenIds = new Set<string>();
  for (const candidate of candidates) {
    const videoId = String(candidate.video_id ?? "");
    if (!videoId || seenIds.has(videoId)) continue;
    deduped.push(candidate);
    seenIds.add(videoId);
  }
  return deduped;
}

async function searchSectionVideoCandidates(
  section: YouTubeClipSection,
  limit: number = SEARCH_CANDIDATE_LIMIT,
  searchProvider: string = DEFAULT_YOUTUBE_SEARCH_PROVIDER,
): Promise<Candidate[]> {
  normalizeYoutubeSearchProvider(searchProvider);
  const queries = sectionSearchQueries(section);
  if (queries.length === 0) return [];
  const searchParamsForSection = sectionSearchParams(section);

  const search = async (query: string): Promise<Candidate[]> => {
    if (Object.keys(searchParamsForSection).length > 0) {
      return searchVideoCandidatesWithProvider(query, limit, DEFAULT_YOUTUBE_SEARCH_PROVIDER, searchParamsForSection);
    }
    return searchVideoCandidates(query, limit);
  };

  // Planner web-search candidates lead the pool; when they already rank
  // strongly, skip search.list entirely (hydration costs 1 unit vs 100).
  const candidates = await plannerCandidateVideos(section);
  let ranked = rankSectionCandidates(section, dedupeCandidates(candidates));
  if (ranked.length > 0 && sectionCandidateScore(section, ranked[0]!) >= BACKUP_SEARCH_MIN_SCENE_SCORE) {
    return ranked;
  }

  for (let index = 0; index < queries.length; index += 1) {
    if (index > 0 && ranked.length > 0 && sectionCandidateScore(section, ranked[0]!) >= BACKUP_SEARCH_MIN_SCENE_SCORE) {
      break;
    }
    candidates.push(...(await search(queries[index]!)));
    ranked = rankSectionCandidates(section, dedupeCandidates(candidates));
  }
  if (ranked.length === 0) {
    const webUrls = webSearchVideoUrlsForSection(section);
    if (webUrls.length > 0) {
      const webSection = sectionWithCandidateUrls(section, webUrls);
      candidates.push(...(await plannerCandidateVideos(webSection)));
      ranked = rankSectionCandidates(section, dedupeCandidates(candidates));
    }
  }
  return ranked;
}

function buildSearchParams(
  query: string,
  limit: number,
  options: { factual: boolean; published_after: string | null; overrides?: Record<string, any> | null },
): Record<string, any> {
  const params: Record<string, any> = {
    part: "snippet",
    type: "video",
    q: query,
    maxResults: limit,
    order: options.factual ? "date" : "relevance",
  };
  if (options.factual && options.published_after) {
    params.publishedAfter = options.published_after;
  }
  if (options.factual && options.published_after && needsNewsCategory(query)) {
    params.videoCategoryId = "25";
  }
  if (options.overrides) {
    Object.assign(params, options.overrides);
  }
  return params;
}

async function searchResponseForKey(
  apiKey: string,
  query: string,
  limit: number,
  options: { factual: boolean; published_after: string | null; overrides?: Record<string, any> | null },
): Promise<Record<string, any>> {
  return youtubeApiRequest(apiKey, "search", buildSearchParams(query, limit, options));
}

async function searchResponse(
  query: string,
  limit: number,
  options: { factual: boolean; published_after: string | null; overrides?: Record<string, any> | null },
): Promise<Record<string, any>> {
  const errors: string[] = [];
  const keys = orderedYoutubeApiKeys();
  if (keys.length === 0) {
    throw new Error("Missing YOUTUBE_API_KEY_1, YOUTUBE_API_KEY_2, YOUTUBE_API_KEY_3, or YOUTUBE_API_KEY for YouTube clip search.");
  }
  for (const [keyName, apiKey] of keys) {
    let response: Record<string, any>;
    try {
      response = await searchResponseForKey(apiKey, query, limit, options);
    } catch (exc) {
      if (workingYoutubeApiKey === apiKey) {
        workingYoutubeApiKey = null;
      }
      errors.push(`${keyName}: ${youtubeDataApiFailureMessage(exc)}`);
      continue;
    }
    workingYoutubeApiKey = apiKey;
    response._youtube_api_key_alias = keyName;
    return response;
  }
  throw new Error(`All configured YouTube Data API keys failed search.list. ${errors.join("; ")}`);
}

export function publishedAfterIso(days = 45): string {
  // Match Python's isoformat(timespec="seconds") + "Z" (UTC, seconds precision).
  const date = new Date(Date.now() - days * 86_400_000);
  return `${date.toISOString().slice(0, 19)}Z`;
}

function youtubeResponseCandidates(response: Record<string, any>): Candidate[] {
  const items = response.items ?? [];
  return items
    .filter((item: any) => item?.id?.videoId)
    .map((item: any) => ({
      video_id: item.id.videoId,
      title: item.snippet?.title ?? null,
      channel_title: item.snippet?.channelTitle ?? null,
      published_at: item.snippet?.publishedAt ?? null,
      description: item.snippet?.description ?? null,
      youtube_api_key_alias: response._youtube_api_key_alias ?? null,
    }));
}

export function parseYoutubeDurationSeconds(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = YOUTUBE_ISO_DURATION_PATTERN.exec(value);
  if (!match) return null;
  const groups = match.groups ?? {};
  const days = Number.parseInt(groups.days || "0", 10);
  const hours = Number.parseInt(groups.hours || "0", 10);
  const minutes = Number.parseInt(groups.minutes || "0", 10);
  const seconds = Number.parseInt(groups.seconds || "0", 10);
  const total = days * 86400 + hours * 3600 + minutes * 60 + seconds;
  return total > 0 ? total : null;
}

async function youtubeVideoDetailsResponse(videoIds: string[]): Promise<Record<string, any>> {
  return youtubeApiRequest(await youtubeApiKeyValue(), "videos", {
    part: "snippet,statistics,contentDetails",
    id: videoIds.join(","),
  });
}

function parseYoutubeInt(value: any): number | null {
  if (value === null || value === undefined || value === true || value === false) return null;
  const parsed = typeof value === "number" ? Math.trunc(value) : Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) ? null : parsed;
}

async function attachYoutubeDataApiVideoDetails(candidates: Candidate[]): Promise<Candidate[]> {
  const videoIds = candidates
    .filter((candidate) => candidate.video_id)
    .map((candidate) => String(candidate.video_id ?? ""));
  if (videoIds.length === 0) return candidates;
  let response: Record<string, any>;
  try {
    response = await youtubeVideoDetailsResponse(videoIds.slice(0, 50));
  } catch {
    return candidates;
  }
  const detailsById: Record<string, Record<string, any>> = {};
  for (const item of response.items ?? []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const videoId = String(item.id ?? "");
    if (!videoId) continue;
    const updates: Record<string, any> = {};
    const snippet = item.snippet && typeof item.snippet === "object" ? item.snippet : {};
    const statistics = item.statistics && typeof item.statistics === "object" ? item.statistics : {};
    const contentDetails = item.contentDetails && typeof item.contentDetails === "object" ? item.contentDetails : {};

    const duration = parseYoutubeDurationSeconds(String(contentDetails.duration ?? ""));
    if (duration) {
      updates.duration_seconds = duration;
      VIDEO_DURATION_CACHE.set(videoId, duration);
    }
    const tags = snippet.tags;
    if (Array.isArray(tags)) {
      updates.tags = tags.filter((tag: any) => typeof tag === "string").map((tag: string) => String(tag));
    }
    const viewCount = parseYoutubeInt(statistics.viewCount);
    if (viewCount !== null) {
      updates.view_count = viewCount;
    }
    const commentCount = parseYoutubeInt(statistics.commentCount);
    if (commentCount !== null) {
      updates.comment_count = commentCount;
    }
    for (const field of ["definition", "dimension"] as const) {
      const value = contentDetails[field];
      if (value) updates[field] = value;
    }
    if (Object.keys(updates).length > 0) {
      detailsById[videoId] = updates;
    }
  }
  for (const candidate of candidates) {
    const videoId = String(candidate.video_id ?? "");
    if (videoId in detailsById) {
      Object.assign(candidate, detailsById[videoId]);
    }
  }
  return candidates;
}

async function youtubeDataApiSearchCandidates(
  query: string,
  limit = 5,
  searchParams: Record<string, any> | null = null,
): Promise<Candidate[]> {
  if (searchParams) {
    // The script planner stated its retrieval intent explicitly; trust it.
    // If the filtered search comes back empty, retry once with the filters
    // relaxed so an over-constrained scene still gets a candidate pool.
    let candidates: Candidate[];
    try {
      let response = await searchResponse(query, limit, {
        factual: false,
        published_after: null,
        overrides: searchParams,
      });
      candidates = youtubeResponseCandidates(response);
      if (candidates.length === 0) {
        // Drop every filter including order: date-ordering itself can
        // starve recall on evergreen topics.
        response = await searchResponse(query, limit, { factual: false, published_after: null });
        candidates = youtubeResponseCandidates(response);
      }
    } catch (exc) {
      throw new Error(youtubeDataApiFailureMessage(exc));
    }
    candidates = await attachYoutubeDataApiVideoDetails(dedupeCandidates(candidates));
    return rankVideoCandidates(query, candidates);
  }

  // Legacy heuristic path for callers without planner-provided params.
  const factual = looksFactualQuery(query);
  const publishedAfter = factual ? publishedAfterIso() : null;
  const strictRecentOpenai = factual && requiresStrictRecentOpenaiResults(query);
  let candidates: Candidate[];
  try {
    const response = await searchResponse(query, limit, { factual, published_after: publishedAfter });
    candidates = youtubeResponseCandidates(response);
    if (
      factual &&
      !strictRecentOpenai &&
      (candidates.length === 0 || shouldMergeLiteralRelevanceForFactualQuery(query))
    ) {
      let relaxedResponse: Record<string, any> | null = null;
      try {
        relaxedResponse = await searchResponse(query, limit, { factual: false, published_after: null });
      } catch (relaxedExc) {
        if (candidates.length === 0) {
          throw relaxedExc;
        }
      }
      if (relaxedResponse !== null) {
        candidates.push(...youtubeResponseCandidates(relaxedResponse));
      }
    }
  } catch (exc) {
    throw new Error(youtubeDataApiFailureMessage(exc));
  }
  candidates = await attachYoutubeDataApiVideoDetails(dedupeCandidates(candidates));
  return rankVideoCandidates(query, candidates);
}

function searchAttempt(options: {
  provider: string;
  query: string;
  limit: number;
  started_at: number;
  result_count?: number;
  error?: string | null;
}): Record<string, any> {
  const attempt: Record<string, any> = {
    provider: options.provider,
    query: options.query,
    limit: options.limit,
    duration_ms: round2(performance.now() - options.started_at),
    result_count: options.result_count ?? 0,
  };
  if (options.error) {
    attempt.error = redactSecretText(options.error);
  }
  return attempt;
}

function annotateSearchCandidates(
  candidates: Candidate[],
  options: { requested_provider: string; used_provider: string; attempts: Array<Record<string, any>> },
): Candidate[] {
  const benchmark = {
    requested_provider: options.requested_provider,
    used_provider: options.used_provider,
    attempts: options.attempts,
  };
  return candidates.map((candidate) => ({
    ...candidate,
    _search_provider: options.used_provider,
    _search_benchmark: benchmark,
  }));
}

async function searchVideoCandidatesWithProvider(
  query: string,
  limit = 5,
  searchProvider: string = DEFAULT_YOUTUBE_SEARCH_PROVIDER,
  searchParams: Record<string, any> | null = null,
): Promise<Candidate[]> {
  const requestedProvider = normalizeYoutubeSearchProvider(searchProvider);
  const attempts: Array<Record<string, any>> = [];
  const startedAt = performance.now();
  let candidates: Candidate[];
  try {
    if (searchParams) {
      candidates = await youtubeDataApiSearchCandidates(query, limit, searchParams);
    } else {
      candidates = await youtubeDataApiSearchCandidates(query, limit);
    }
  } catch (exc) {
    attempts.push(
      searchAttempt({
        provider: YOUTUBE_DATA_API_PROVIDER,
        query,
        limit,
        started_at: startedAt,
        error: errorText(exc),
      }),
    );
    return [];
  }
  attempts.push(
    searchAttempt({
      provider: YOUTUBE_DATA_API_PROVIDER,
      query,
      limit,
      started_at: startedAt,
      result_count: candidates.length,
    }),
  );
  return annotateSearchCandidates(candidates, {
    requested_provider: requestedProvider,
    used_provider: YOUTUBE_DATA_API_PROVIDER,
    attempts,
  });
}

async function searchVideoCandidates(query: string, limit = 5): Promise<Candidate[]> {
  return searchVideoCandidatesWithProvider(query, limit);
}

async function searchVideoIds(query: string, limit = 5): Promise<string[]> {
  return (await searchVideoCandidates(query, limit)).map((candidate) => candidate.video_id as string);
}

function ytDlpCommand(): string[] {
  return ENV.YT_DLP_PATH ? [ENV.YT_DLP_PATH] : ["yt-dlp"];
}

async function videoDuration(videoId: string): Promise<number> {
  const cached = VIDEO_DURATION_CACHE.get(videoId);
  if (cached !== undefined) return cached;
  const [bin, ...binArgs] = ytDlpCommand();
  const result = await execa(
    bin!,
    [
      ...binArgs,
      "--socket-timeout",
      String(YT_DLP_SOCKET_TIMEOUT_SECONDS),
      "--print",
      "duration",
      `https://www.youtube.com/watch?v=${videoId}`,
    ],
    { timeout: YT_DLP_SUBPROCESS_TIMEOUT_SECONDS * 1000 },
  );
  const text = String(result.stdout).trim();
  const duration = text ? Number(text) : Number.NaN;
  if (Number.isNaN(duration)) {
    throw new Error(`Could not read duration for YouTube video ${videoId}: ${text}`);
  }
  VIDEO_DURATION_CACHE.set(videoId, duration);
  return duration;
}

async function candidateDuration(candidate: Candidate): Promise<number> {
  const videoId = String(candidate.video_id);
  const rawDuration = candidate.duration_seconds;
  if (rawDuration !== null && rawDuration !== undefined) {
    const parsed = Number(rawDuration);
    const duration = Number.isNaN(parsed) ? 0.0 : parsed;
    if (duration > 0) {
      VIDEO_DURATION_CACHE.set(videoId, duration);
      return duration;
    }
  }
  return videoDuration(videoId);
}

export function parseVttTimestamp(value: string): number {
  const parts = value.replace(",", ".").split(":");
  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts as [string, string, string];
    return Number.parseInt(hours, 10) * 3600 + Number.parseInt(minutes, 10) * 60 + Number.parseFloat(seconds);
  }
  if (parts.length === 2) {
    const [minutes, seconds] = parts as [string, string];
    return Number.parseInt(minutes, 10) * 60 + Number.parseFloat(seconds);
  }
  return Number.parseFloat(parts[0]!);
}

export function cleanVttText(text: string): string {
  let cleaned = text.replace(/<[^>]+>/g, " ");
  cleaned = htmlUnescape(cleaned);
  cleaned = cleaned.replace(/\s+/g, " ");
  return cleaned.trim();
}

function parseVttEntries(filePath: string): Array<Record<string, any>> {
  const entries: Array<Record<string, any>> = [];
  let currentStart: number | null = null;
  let currentEnd: number | null = null;
  let currentLines: string[] = [];

  const flush = (): void => {
    if (currentStart === null || currentEnd === null) {
      currentLines = [];
      return;
    }
    const text = cleanVttText(currentLines.join(" "));
    if (text) {
      entries.push({ start: currentStart, end: currentEnd, text });
    }
    currentStart = null;
    currentEnd = null;
    currentLines = [];
  };

  for (const rawLine of readFileSync(filePath, "utf-8").split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (!line) {
      flush();
      continue;
    }
    const match = VTT_TIMESTAMP_PATTERN.exec(line);
    if (match) {
      flush();
      currentStart = parseVttTimestamp(match.groups!.start!);
      currentEnd = parseVttTimestamp(match.groups!.end!);
      currentLines = [];
      continue;
    }
    if (
      currentStart !== null &&
      !["WEBVTT", "Kind:", "Language:", "NOTE"].some((prefix) => line.startsWith(prefix))
    ) {
      currentLines.push(line);
    }
  }
  flush();
  return entries;
}

async function transcriptEntries(videoId: string): Promise<Array<Record<string, any>>> {
  const cached = TRANSCRIPT_ENTRIES_CACHE.get(videoId);
  if (cached !== undefined) {
    return cached.map((entry) => ({ ...entry }));
  }

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "yt-transcripts-"));
  try {
    const outputTemplate = path.join(tempDir, "%(id)s.%(ext)s");
    const [bin, ...binArgs] = ytDlpCommand();
    const result = await execa(
      bin!,
      [
        ...binArgs,
        `https://www.youtube.com/watch?v=${videoId}`,
        "--skip-download",
        "--write-subs",
        "--write-auto-subs",
        "--sub-langs",
        "en.*",
        "--sub-format",
        "vtt",
        "-o",
        outputTemplate,
        "--quiet",
        "--no-warnings",
      ],
      { reject: false },
    );
    if (result.exitCode !== 0) {
      TRANSCRIPT_ENTRIES_CACHE.set(videoId, []);
      return [];
    }
    const entries: Array<Record<string, any>> = [];
    const vttFiles = readdirSync(tempDir)
      .filter((name) => name.endsWith(".vtt"))
      .sort()
      .map((name) => path.join(tempDir, name));
    for (const vttPath of vttFiles) {
      entries.push(...parseVttEntries(vttPath));
    }
    TRANSCRIPT_ENTRIES_CACHE.set(videoId, entries);
    return entries.map((entry) => ({ ...entry }));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function transcriptQueryTokens(section: YouTubeClipSection): Set<string> {
  const text = [section.dialogue ?? "", section.search_hint ?? ""].map((value) => String(value ?? "")).join(" ");
  return new Set(queryEntityTokens(text));
}

async function pickTranscriptWindow(
  videoId: string,
  totalDuration: number,
  wantedDuration: number,
  section: YouTubeClipSection,
): Promise<[number, number, Record<string, any>] | null> {
  const tokens = transcriptQueryTokens(section);
  if (tokens.size === 0) return null;
  const entries = await transcriptEntries(videoId);
  let bestEntry: Record<string, any> | null = null;
  let bestScore = 0.0;
  for (const entry of entries) {
    const entryTokens = new Set(queryEntityTokens(String(entry.text ?? "")));
    if (entryTokens.size === 0) continue;
    const overlap = setIntersection(tokens, entryTokens);
    const score = overlap.size;
    if (score > bestScore) {
      bestScore = score;
      bestEntry = entry;
    }
  }
  if (bestEntry === null || bestScore <= 0) return null;

  const wanted = Math.min(wantedDuration, totalDuration);
  const cueStart = Number(bestEntry.start);
  const start = Math.min(Math.max(0.0, cueStart), Math.max(0.0, totalDuration - wanted));
  const end = Math.min(totalDuration, start + wanted);
  return [
    round3(start),
    round3(end),
    {
      source: "transcript",
      score: bestScore,
      text: String(bestEntry.text ?? ""),
      cue_start_seconds: round3(Number(bestEntry.start)),
      cue_end_seconds: round3(Number(bestEntry.end)),
    },
  ];
}

async function downloadClip(
  videoId: string,
  start: number,
  duration: number,
  options: { out_dir: string; proxy_url?: string | null },
): Promise<string> {
  const outputDir = options.out_dir;
  mkdirSync(outputDir, { recursive: true });
  const end = round3(start + duration);
  const startLabel = pythonFloatStr(start).replace(".", "_");
  const template = path.join(outputDir, `${startLabel}_%(id)s.%(ext)s`);
  const [bin, ...binArgs] = ytDlpCommand();
  const args = [
    ...binArgs,
    `https://www.youtube.com/watch?v=${videoId}`,
    "--socket-timeout",
    String(YT_DLP_SOCKET_TIMEOUT_SECONDS),
    "--download-sections",
    `*${pythonFloatStr(start)}-${pythonFloatStr(end)}`,
    "-f",
    YOUTUBE_CLIP_FORMAT_SELECTOR,
    "--merge-output-format",
    "mp4",
    "--remux-video",
    "mp4",
    "-o",
    template,
    "--quiet",
    "--no-playlist",
    "--no-mtime",
  ];
  if (options.proxy_url) {
    args.push("--proxy", options.proxy_url);
  }
  await execa(bin!, args, { timeout: YT_DLP_SUBPROCESS_TIMEOUT_SECONDS * 1000 });
  const prefix = `${startLabel}_${videoId}.`;
  const files = readdirSync(outputDir)
    .filter((name) => name.startsWith(prefix))
    .sort()
    .map((name) => path.join(outputDir, name));
  if (files.length === 0) {
    throw new Error(`No clip downloaded for YouTube video ${videoId}`);
  }
  return path.resolve(files[0]!);
}

function searchProviderForCandidate(candidate: Candidate, requestedProvider: string): string {
  const benchmark = candidate._search_benchmark;
  if (benchmark && typeof benchmark === "object" && !Array.isArray(benchmark)) {
    const usedProvider = benchmark.used_provider;
    if (typeof usedProvider === "string" && usedProvider) {
      return usedProvider;
    }
    const attempts = benchmark.attempts;
    if (Array.isArray(attempts) && attempts.length > 0) {
      const lastAttempt = attempts[attempts.length - 1];
      const provider =
        lastAttempt && typeof lastAttempt === "object" && !Array.isArray(lastAttempt) ? lastAttempt.provider : null;
      if (typeof provider === "string" && provider) {
        return provider;
      }
    }
  }
  const provider = candidate._search_provider;
  return String(provider || requestedProvider);
}

/**
 * Injectable dependencies for {@link selectLastResortClip}. In production these
 * are bound to the real implementations inside downloadSectionClip; tests inject
 * lightweight mocks so the last-resort selection logic can be exercised without
 * network/yt-dlp/VLM calls.
 */
export interface LastResortDeps {
  candidateDuration: (candidate: Candidate) => Promise<number>;
  downloadClip: (
    videoId: string,
    start: number,
    duration: number,
    options: { out_dir: string; proxy_url?: string | null },
  ) => Promise<string>;
  clipVisualRejectionReason: (
    section: YouTubeClipSection,
    candidate: Candidate,
    clipPath: string,
    windowMatch: Record<string, any>,
  ) => Promise<string | null>;
  outDir: string;
  proxyUrl: string | null;
}

/**
 * Outcome of a successful last-resort selection: enough to compose the final
 * section-clip record in the caller (video_id / path / window) without leaking
 * the full ProjectContext-derived metadata shape into the testable helper.
 */
export interface LastResortClip {
  candidate: Candidate;
  video_id: string;
  path: string;
  start: number;
  end: number;
  windowMatch: Record<string, any>;
  window_source: "last_resort";
}

/**
 * Last-resort clip selection, reached ONLY after the strict transcript and
 * visual-fallback tiers have both failed for every candidate.
 *
 * The non-negotiable invariant: this relaxes ONLY the transcript/visual SCORE
 * thresholds (MIN_TRANSCRIPT_WINDOW_SCORE / MIN_VISUAL_FALLBACK_SCORE). The
 * subject gate and the VLM cleanliness gate stay HARD:
 *   - Subject gate: metadataSpecificityRejectionReason(section, candidate, false)
 *     keeps the entity/subject/field rejections (requiredSubjectRejectionReason
 *     etc.) but skips the strict token-overlap *score* check — so a wrong-subject
 *     clip is never accepted, while a subject-relevant clip with a weak alignment
 *     score is no longer discarded purely for the score.
 *   - VLM gate: clipVisualRejectionReason still rejects CTA/title/end-screen/
 *     watermark/podcast clips on the downloaded footage.
 *
 * Candidates are visited in the caller's ranked order (best first); the first
 * subject-relevant, VLM-clean clip wins. Returns null (with reasons appended to
 * `failures`) only when NO subject-relevant, VLM-clean clip exists in the pool —
 * in which case the scene legitimately fails rather than accepting junk.
 */
export async function selectLastResortClip(
  section: YouTubeClipSection,
  candidates: Candidate[],
  deps: LastResortDeps,
  failures: string[] = [],
): Promise<LastResortClip | null> {
  for (const candidate of candidates) {
    const videoId = String(candidate.video_id ?? "");
    if (!videoId) continue;
    // Subject gate stays HARD (strictOverlap=false drops only the score-like
    // token-overlap check, keeping the entity/subject/field rejections).
    const subjectRejection = metadataSpecificityRejectionReason(section, candidate, false);
    if (subjectRejection) {
      failures.push(`${videoId}: last-resort skipped: ${subjectRejection}`);
      continue;
    }
    let totalDuration: number;
    try {
      totalDuration = await deps.candidateDuration(candidate);
    } catch (exc) {
      failures.push(`${videoId}: last-resort duration failed: ${redactSecretText(errorText(exc))}`);
      continue;
    }
    const wantedWindow = youtubeWindowDurationSeconds(section.duration_seconds, totalDuration);
    const [start, end] = visualFallbackWindow(totalDuration, wantedWindow);
    let downloaded: string;
    try {
      downloaded = await deps.downloadClip(videoId, start, end - start, {
        out_dir: deps.outDir,
        proxy_url: deps.proxyUrl,
      });
    } catch (exc) {
      failures.push(`${videoId}: last-resort download failed: ${redactSecretText(errorText(exc))}`);
      continue;
    }
    const windowMatch: Record<string, any> = {
      source: "last_resort",
      score: round3(sectionCandidateScore(section, candidate)),
      text: String(candidate.title ?? ""),
      cue_start_seconds: round3(start),
      cue_end_seconds: round3(end),
    };
    // VLM cleanliness gate stays HARD: CTA/title/end-screen/watermark/podcast
    // clips are still rejected on the downloaded footage.
    const visualRejection = await deps.clipVisualRejectionReason(section, candidate, downloaded, windowMatch);
    if (visualRejection) {
      failures.push(`${videoId}: last-resort ${visualRejection}`);
      continue;
    }
    return {
      candidate,
      video_id: videoId,
      path: path.resolve(downloaded),
      start: round3(start),
      end: round3(end),
      windowMatch,
      window_source: "last_resort",
    };
  }
  return null;
}

async function downloadSectionClip(
  ctx: ProjectContext,
  section: YouTubeClipSection,
  proxyUrl: string | null = null,
  searchProvider: string = DEFAULT_YOUTUBE_SEARCH_PROVIDER,
  attemptedHintsArg: Set<string> | null = null,
): Promise<Record<string, any>> {
  searchProvider = normalizeYoutubeSearchProvider(searchProvider);
  const sceneId = `scene_${Math.trunc(section.section)}`;
  const attemptedHints = new Set(attemptedHintsArg ?? []);
  attemptedHints.add(String(section.search_hint ?? "").trim().toLowerCase());
  let candidates = await searchSectionVideoCandidates(section, SEARCH_CANDIDATE_LIMIT, searchProvider);
  if (candidates.length === 0) {
    throw new Error(`No YouTube video found for search hint: ${section.search_hint}`);
  }
  let candidateSubagent: YoutubeCandidateSubagentResult | null = null;
  candidateSubagent = await rankYoutubeCandidatesWithSubagent(section, candidates);
  candidates = candidateSubagent.candidates;

  if (!String(section.dialogue ?? "").trim()) {
    throw new Error(`No dialogue available for transcript-aligned YouTube window: ${section.search_hint}`);
  }

  const failures: string[] = [];
  for (const candidate of candidates.slice(0, TRANSCRIPT_CANDIDATE_LIMIT)) {
    const videoId = candidate.video_id as string;
    const metadataRejection = metadataSpecificityRejectionReason(section, candidate, true);
    if (metadataRejection) {
      failures.push(`${videoId}: metadata rejected: ${metadataRejection}`);
      continue;
    }
    let totalDuration: number;
    try {
      totalDuration = await candidateDuration(candidate);
    } catch (exc) {
      failures.push(`${videoId}: duration failed: ${redactSecretText(errorText(exc))}`);
      continue;
    }

    // Over-fetch the window forward from the transcript match so the trimmed clip is
    // long enough to cover the (usually longer) per-section voiceover instead of
    // freezing its last frame. pickTranscriptWindow clamps the window to totalDuration.
    const wantedWindow = youtubeWindowDurationSeconds(section.duration_seconds, totalDuration);
    const transcriptWindow = await pickTranscriptWindow(videoId, totalDuration, wantedWindow, section);
    if (transcriptWindow === null) {
      failures.push(`${videoId}: no transcript match`);
      continue;
    }

    const [start, end, windowMatch] = transcriptWindow;
    const score = Number(windowMatch.score || 0.0);
    if (score < MIN_TRANSCRIPT_WINDOW_SCORE) {
      failures.push(`${videoId}: transcript match too weak: ${formatG(score)}`);
      continue;
    }
    const outDir = path.join(ctx.project_dir, "youtube_clips", sceneId);
    let downloaded: string;
    try {
      downloaded = await downloadClip(videoId, start, end - start, { out_dir: outDir, proxy_url: proxyUrl });
    } catch (exc) {
      failures.push(`${videoId}: download failed: ${redactSecretText(errorText(exc))}`);
      continue;
    }
    const visualRejection = await clipVisualRejectionReason(section, candidate, downloaded, windowMatch);
    if (visualRejection) {
      failures.push(`${videoId}: ${visualRejection}`);
      continue;
    }
    // The downloaded clip starts at frame 0 of the trimmed file. Probe its real length so
    // the timeline sees the actual (over-fetched) footage window: when it is >= the
    // per-section voiceover, buildTimelineFromProjectState picks end_behavior 'cut' and the
    // stitch trims to the VO instead of freezing the last frame.
    const realDuration = await probedClipDuration(downloaded, end - start);
    return {
      scene_id: sceneId,
      path: path.resolve(downloaded),
      prompt: section.search_hint,
      model: "youtube-clips",
      resolution: ctx.resolution,
      audio: false,
      duration_seconds: section.duration_seconds,
      source_duration_seconds: realDuration,
      source: "youtube",
      search_hint: section.search_hint,
      video_id: videoId,
      youtube_url: `https://www.youtube.com/watch?v=${videoId}`,
      youtube_title: candidate.title,
      youtube_channel: candidate.channel_title,
      youtube_published_at: candidate.published_at,
      youtube_api_key_alias: candidate.youtube_api_key_alias,
      youtube_search_provider_requested: searchProvider,
      youtube_search_provider: searchProviderForCandidate(candidate, searchProvider),
      youtube_search_benchmark: candidate._search_benchmark,
      start_seconds: 0,
      end_seconds: realDuration,
      requested_start_seconds: start,
      requested_end_seconds: end,
      window_source: windowMatch.source,
      window_match: windowMatch,
      youtube_subagent_candidate_review: candidateSubagent.review,
    };
  }

  for (const candidate of candidates.slice(0, TRANSCRIPT_CANDIDATE_LIMIT)) {
    const videoId = candidate.video_id as string;
    const fallbackScore = sectionCandidateScore(section, candidate);
    const fallbackRejection = visualFallbackRejectionReason(section, candidate, fallbackScore);
    if (fallbackRejection) {
      failures.push(`${videoId}: fallback rejected: ${fallbackRejection}`);
      continue;
    }
    let totalDuration: number;
    try {
      totalDuration = await candidateDuration(candidate);
    } catch (exc) {
      failures.push(`${videoId}: fallback duration failed: ${redactSecretText(errorText(exc))}`);
      continue;
    }
    const durationRejection = visualFallbackDurationRejectionReason(section, candidate, totalDuration);
    if (durationRejection) {
      failures.push(`${videoId}: fallback rejected: ${durationRejection}`);
      continue;
    }
    const fallbackWindow = youtubeWindowDurationSeconds(section.duration_seconds, totalDuration);
    const [start, end] = visualFallbackWindow(totalDuration, fallbackWindow);
    const outDir = path.join(ctx.project_dir, "youtube_clips", sceneId);
    let downloaded: string;
    try {
      downloaded = await downloadClip(videoId, start, end - start, { out_dir: outDir, proxy_url: proxyUrl });
    } catch (exc) {
      failures.push(`${videoId}: fallback download failed: ${redactSecretText(errorText(exc))}`);
      continue;
    }
    const fallbackMatch: Record<string, any> = {
      source: "visual_fallback",
      score: round3(fallbackScore),
      text: String(candidate.title ?? ""),
      cue_start_seconds: round3(start),
      cue_end_seconds: round3(end),
    };
    const visualRejection = await clipVisualRejectionReason(section, candidate, downloaded, fallbackMatch);
    if (visualRejection) {
      failures.push(`${videoId}: ${visualRejection}`);
      continue;
    }
    const realDuration = await probedClipDuration(downloaded, end - start);
    return {
      scene_id: sceneId,
      path: path.resolve(downloaded),
      prompt: section.search_hint,
      model: "youtube-clips",
      resolution: ctx.resolution,
      audio: false,
      duration_seconds: section.duration_seconds,
      source_duration_seconds: realDuration,
      source: "youtube",
      search_hint: section.search_hint,
      video_id: videoId,
      youtube_url: `https://www.youtube.com/watch?v=${videoId}`,
      youtube_title: candidate.title,
      youtube_channel: candidate.channel_title,
      youtube_published_at: candidate.published_at,
      youtube_api_key_alias: candidate.youtube_api_key_alias,
      youtube_search_provider_requested: searchProvider,
      youtube_search_provider: searchProviderForCandidate(candidate, searchProvider),
      youtube_search_benchmark: candidate._search_benchmark,
      start_seconds: 0,
      end_seconds: realDuration,
      requested_start_seconds: round3(start),
      requested_end_seconds: round3(end),
      window_source: "visual_fallback",
      window_match: fallbackMatch,
      youtube_subagent_candidate_review: candidateSubagent.review,
    };
  }

  // Last-resort tier: both strict tiers failed for every candidate (typically
  // because the transcript/visual SCORE gate was too tight for a small pool).
  // Accept a subject-relevant, VLM-clean clip even if its alignment score is
  // weak — relaxing ONLY the score gate, keeping the subject + VLM gates hard —
  // so the scene is filled rather than dropped. Visit the full ranked pool (not
  // just TRANSCRIPT_CANDIDATE_LIMIT) so a clean subject match deeper in the pool
  // can still rescue the scene.
  const lastResort = await selectLastResortClip(section, candidates, {
    candidateDuration,
    downloadClip,
    clipVisualRejectionReason,
    outDir: path.join(ctx.project_dir, "youtube_clips", sceneId),
    proxyUrl,
  }, failures);
  if (lastResort) {
    const realDuration = await probedClipDuration(lastResort.path, lastResort.end - lastResort.start);
    const candidate = lastResort.candidate;
    return {
      scene_id: sceneId,
      path: lastResort.path,
      prompt: section.search_hint,
      model: "youtube-clips",
      resolution: ctx.resolution,
      audio: false,
      duration_seconds: section.duration_seconds,
      source_duration_seconds: realDuration,
      source: "youtube",
      search_hint: section.search_hint,
      video_id: lastResort.video_id,
      youtube_url: `https://www.youtube.com/watch?v=${lastResort.video_id}`,
      youtube_title: candidate.title,
      youtube_channel: candidate.channel_title,
      youtube_published_at: candidate.published_at,
      youtube_api_key_alias: candidate.youtube_api_key_alias,
      youtube_search_provider_requested: searchProvider,
      youtube_search_provider: searchProviderForCandidate(candidate, searchProvider),
      youtube_search_benchmark: candidate._search_benchmark,
      start_seconds: 0,
      end_seconds: realDuration,
      requested_start_seconds: lastResort.start,
      requested_end_seconds: lastResort.end,
      window_source: lastResort.window_source,
      window_match: lastResort.windowMatch,
      youtube_subagent_candidate_review: candidateSubagent.review,
    };
  }

  for (const retryHint of sectionBackoffSearchHintVariants(section)) {
    const retryKey = retryHint.trim().toLowerCase();
    if (attemptedHints.has(retryKey)) continue;
    const retrySection = sectionWithSearchHint(section, retryHint);
    try {
      return await downloadSectionClip(ctx, retrySection, proxyUrl, searchProvider, attemptedHints);
    } catch (exc) {
      failures.push(`${retryHint}: ${redactSecretText(errorText(exc))}`);
    }
  }

  const tried = failures.length > 0 ? failures.join("; ") : "no candidates tried";
  throw new Error(`No transcript-aligned YouTube window found for search hint: ${section.search_hint}. Tried: ${tried}`);
}

export async function downloadYoutubeClipAssets(
  ctx: ProjectContext,
  sections: YouTubeClipSection[],
  options: { proxy_url?: string | null; search_provider?: string | null } = {},
): Promise<Array<Record<string, any> | Error>> {
  const proxyUrl = options.proxy_url ?? null;
  const searchProvider = normalizeYoutubeSearchProvider(options.search_provider ?? DEFAULT_YOUTUBE_SEARCH_PROVIDER);

  const downloadCall = (section: YouTubeClipSection): Promise<Record<string, any>> => {
    let target = section;
    if (!(target.candidate_video_urls && target.candidate_video_urls.length > 0)) {
      const urls = webSearchVideoUrlsForSection(target);
      if (urls.length > 0) {
        target = sectionWithCandidateUrls(target, urls);
      }
    }
    return downloadSectionClip(ctx, target, proxyUrl, searchProvider);
  };

  // asyncio.gather(..., return_exceptions=True) equivalent.
  const settled = await Promise.allSettled(sections.map((section) => downloadCall(section)));
  return settled.map((result) => (result.status === "fulfilled" ? result.value : toError(result.reason)));
}

// Referenced to keep the legacy helper surface intact (unused internally,
// mirrors _search_video_ids in the Python module).
export { searchVideoIds as _searchVideoIds };

