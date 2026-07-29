export type VoiceGender = "female" | "male" | "neutral";

export interface FishAudioVoice {
  key: string;
  reference_id: string;
  gender: VoiceGender;
  style: string;
}

// All verified live against Fish Audio /model (English).
export const FISH_AUDIO_VOICES: Record<string, FishAudioVoice> = {
  sarah:          { key: "sarah",          reference_id: "933563129e564b19a115bedd57b7406a", gender: "female",  style: "young, soft, conversational" },
  jasphina:       { key: "jasphina",       reference_id: "e9b134e4c0b547a3894793be502314f1", gender: "female",  style: "energetic, social-media" },
  ethan:          { key: "ethan",          reference_id: "536d3a5e000945adb7038665781a4aca", gender: "male",    style: "calm, professional narration" },
  energetic_male: { key: "energetic_male", reference_id: "802e3bc2b27e49c2995d23ef70e6ac89", gender: "male",    style: "young, enthusiastic, ad-style" },
  alle:           { key: "alle",           reference_id: "59e9dc1cb20c452584788a2690c80970", gender: "neutral", style: "young, conversational" },
};

export const VOICE_KEYS = Object.keys(FISH_AUDIO_VOICES) as [string, ...string[]]; // for a zod enum later
export const FEMALE_DEFAULT_VOICE = "sarah";
export const MALE_DEFAULT_VOICE = "ethan";
export const DEFAULT_HUME_UGC_VOICE_DESCRIPTION =
  "Young adult North American UGC creator voice with a neutral American accent: casual, warm, expressive, lightly energetic, clear, and believable on a phone-shot social video. Natural creator pacing with small human imperfections; not British, not formal, not theatrical, and not announcer-polished.";

// Resolved reference_ids for the gender defaults. The catalog is typed as an
// open Record (so unknown `plan.voice` lookups are correctly possibly-undefined
// under noUncheckedIndexedAccess); these constants pin the always-present
// defaults so the resolver stays type-safe without non-null assertions.
const FEMALE_DEFAULT_REFERENCE_ID = FISH_AUDIO_VOICES[FEMALE_DEFAULT_VOICE]!.reference_id;
const MALE_DEFAULT_REFERENCE_ID = FISH_AUDIO_VOICES[MALE_DEFAULT_VOICE]!.reference_id;

// Structural input types so this module does NOT depend on the schema.
// (The schema gains the `voice` field in a later task.)
interface VoiceResolvablePlan {
  voice?: string | null;
  creative_vibe?: string | null;
  title?: string | null;
  narration?: string | null;
  visual_bible?: string | null;
  scenes?: Array<{ narration?: string | null; image_prompt?: string | null }>;
}

interface VoiceResolvableCtx {
  fish_audio_reference_id: string;
}

const FEMALE_CUES =
  /\b(she|her|hers|woman|women|female|girl|lady|mother|mom|sister|daughter|actress)\b/gi;
const MALE_CUES =
  /\b(he|him|his|man|men|male|boy|guy|gentleman|father|dad|brother|son|actor)\b/gi;
const SINGLE_SPEAKER_UGC =
  /\b(ugc|tiktok|reel|testimonial|founder|creator|normal person|selfie|talking to camera|raw_ugc|polished_ugc|high_energy_social|founder_explainer)\b/i;
const MULTI_SPEAKER =
  /\b(two people|multiple speakers|different voices|several speakers|interview|conversation|dialogue between|man and woman|woman and man|customer and founder)\b/i;
const HIGH_ENERGY =
  /\b(ugc|tiktok|reel|social|comedy|skit|energetic|upbeat|punchy|fast|urgent|action|commercial|product ad)\b/i;

const ELEVENLABS_VOICE_NAMES: Record<string, string> = {
  sarah: "Rachel",
  jasphina: "Rachel",
  ethan: "Brian",
  energetic_male: "Adam",
  alle: "Rachel",
};

function countMatches(text: string, re: RegExp): number {
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

export function inferCharacterGender(plan: VoiceResolvablePlan): "female" | "male" | "unknown" {
  const parts: string[] = [];
  if (plan.visual_bible) parts.push(plan.visual_bible);
  for (const scene of plan.scenes ?? []) {
    if (scene.narration) parts.push(scene.narration);
    if (scene.image_prompt) parts.push(scene.image_prompt);
  }
  const text = parts.join(" ");

  const femaleCount = countMatches(text, FEMALE_CUES);
  const maleCount = countMatches(text, MALE_CUES);

  if (femaleCount > maleCount) return "female";
  if (maleCount > femaleCount) return "male";
  return "unknown";
}

export function resolveVoiceReferenceId(
  plan: VoiceResolvablePlan,
  ctx: VoiceResolvableCtx,
): string {
  const inferred = inferCharacterGender(plan);
  const candidate =
    plan.voice && FISH_AUDIO_VOICES[plan.voice] ? FISH_AUDIO_VOICES[plan.voice] : null;

  // Mismatch guard: a gendered candidate that contradicts the inferred gender is
  // overridden with the inferred gender's default. Neutral candidates pass through.
  if (
    candidate &&
    inferred !== "unknown" &&
    (candidate.gender === "female" || candidate.gender === "male") &&
    candidate.gender !== inferred
  ) {
    return inferred === "female" ? FEMALE_DEFAULT_REFERENCE_ID : MALE_DEFAULT_REFERENCE_ID;
  }

  if (candidate) return candidate.reference_id;

  if (inferred === "female") return FEMALE_DEFAULT_REFERENCE_ID;
  if (inferred === "male") return MALE_DEFAULT_REFERENCE_ID;

  return ctx.fish_audio_reference_id || FISH_AUDIO_VOICES.alle!.reference_id;
}

export function shouldLockSingleSpeakerVoice(plan: VoiceResolvablePlan): boolean {
  const text = [plan.title, plan.creative_vibe, plan.visual_bible, ...(plan.scenes ?? []).flatMap((scene) => [
    scene.narration,
    scene.image_prompt,
  ])]
    .filter(Boolean)
    .join(" ");
  return SINGLE_SPEAKER_UGC.test(text) && !MULTI_SPEAKER.test(text);
}

function hasSpokenNarration(plan: VoiceResolvablePlan): boolean {
  return Boolean(
    [plan.narration, ...(plan.scenes ?? []).map((scene) => scene.narration)]
      .filter(Boolean)
      .join(" ")
      .trim(),
  );
}

function isMultiSpeakerPlan(plan: VoiceResolvablePlan): boolean {
  return MULTI_SPEAKER.test(
    [plan.title, plan.creative_vibe, plan.visual_bible, plan.narration]
      .filter(Boolean)
      .join(" "),
  );
}

export function resolvePlanVoiceKey(plan: VoiceResolvablePlan): string | null {
  const candidate = plan.voice && FISH_AUDIO_VOICES[plan.voice] ? FISH_AUDIO_VOICES[plan.voice] : null;
  const inferred = inferCharacterGender(plan);
  if (
    candidate &&
    inferred !== "unknown" &&
    (candidate.gender === "female" || candidate.gender === "male") &&
    candidate.gender !== inferred
  ) {
    return inferred === "female" ? "jasphina" : "energetic_male";
  }
  if (candidate) return candidate.key;
  if (!hasSpokenNarration(plan) || isMultiSpeakerPlan(plan)) return null;
  const highEnergy = HIGH_ENERGY.test([plan.title, plan.creative_vibe, plan.visual_bible].filter(Boolean).join(" "));
  if (inferred === "female") return highEnergy ? "jasphina" : "sarah";
  if (inferred === "male") return highEnergy ? "energetic_male" : "ethan";
  return "alle";
}

export function normalizePlanVoice<T extends VoiceResolvablePlan>(plan: T): T {
  const voice = resolvePlanVoiceKey(plan);
  return voice ? { ...plan, voice } : plan;
}

export function elevenLabsVoiceNameForPlan(plan: VoiceResolvablePlan): string {
  const key = resolvePlanVoiceKey(plan) ?? "alle";
  return ELEVENLABS_VOICE_NAMES[key] ?? ELEVENLABS_VOICE_NAMES.alle!;
}

export function voiceContinuityIssues(plan: VoiceResolvablePlan): string[] {
  if (!shouldLockSingleSpeakerVoice(plan)) return [];
  const issues: string[] = [];
  const resolved = resolvePlanVoiceKey(plan);
  if (!resolved) issues.push("Single-speaker UGC plans must resolve to one stable voice key before provider calls.");
  const inferred = inferCharacterGender(plan);
  const candidate = plan.voice && FISH_AUDIO_VOICES[plan.voice] ? FISH_AUDIO_VOICES[plan.voice] : null;
  if (
    candidate &&
    inferred !== "unknown" &&
    (candidate.gender === "female" || candidate.gender === "male") &&
    candidate.gender !== inferred
  ) {
    issues.push("Selected voice key does not match the inferred on-screen creator gender.");
  }
  return issues;
}

export function humeVoiceDescriptionForPlan(
  plan: VoiceResolvablePlan,
  baseDescription: string | null | undefined,
): string {
  const base = (baseDescription ?? "").trim() || DEFAULT_HUME_UGC_VOICE_DESCRIPTION;
  const inferred = inferCharacterGender(plan);
  const candidate =
    plan.voice && FISH_AUDIO_VOICES[plan.voice] ? FISH_AUDIO_VOICES[plan.voice] : null;
  const gender =
    inferred !== "unknown"
      ? inferred
      : candidate && candidate.gender !== "neutral"
        ? candidate.gender
        : null;
  const style = candidate ? `Use the ${candidate.style} voice style.` : "";
  const genderRule = gender
    ? `Use a clearly ${gender} voice with a North American/American English accent that matches the on-screen ${gender === "female" ? "woman/female creator" : "man/male creator"}.`
    : "Use a voice that matches the on-screen creator identity; do not switch gender between scenes.";
  return `${base} ${genderRule} ${style}`.replace(/\s+/g, " ").trim();
}
