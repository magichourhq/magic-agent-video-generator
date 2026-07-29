import type { AudioMode, Scene, VideoPlan } from "./schemas.js";

export type AudioPausePolicy = "none" | "short" | "long";

export interface AudioPerformanceSettings {
  audio_mode: AudioMode;
  audio_note: string | null;
  emotion_context: string | null;
  description: string;
  speed: number;
  temperature: number;
  trailing_silence: number;
  pause: AudioPausePolicy;
}

export const TOPIC_CHANGE_PAUSE_SECONDS = 0.5;

interface AudioModePreset {
  description: string;
  speed: number;
  temperature: number;
  trailing_silence: number;
  pause: AudioPausePolicy;
}

export const AUDIO_MODE_PRESETS: Record<AudioMode, AudioModePreset> = {
  ugc_hook: {
    description: "scroll-stopping UGC hook, fast, casual, direct-to-camera",
    speed: 1.1,
    temperature: 0.82,
    trailing_silence: 0,
    pause: "none",
  },
  ugc_casual: {
    description: "natural UGC creator, conversational, believable, lightly energetic",
    speed: 1.05,
    temperature: 0.8,
    trailing_silence: 0,
    pause: "none",
  },
  product_proof: {
    description: "clear confident product demo, concrete and easy to follow",
    speed: 1,
    temperature: 0.72,
    trailing_silence: 0,
    pause: "none",
  },
  testimonial: {
    description: "warm honest testimonial, human and specific, not polished",
    speed: 0.97,
    temperature: 0.82,
    trailing_silence: 0,
    pause: "short",
  },
  cinematic_narrator: {
    description: "measured cinematic narrator, polished but not announcer-like",
    speed: 0.92,
    temperature: 0.76,
    trailing_silence: 0,
    pause: "short",
  },
  tutorial_clear: {
    description: "precise tutorial voice, clear steps, calm confidence",
    speed: 0.98,
    temperature: 0.65,
    trailing_silence: 0,
    pause: "none",
  },
  calm_lifestyle: {
    description: "soft cozy lifestyle voice, relaxed and natural",
    speed: 0.9,
    temperature: 0.76,
    trailing_silence: 0,
    pause: "short",
  },
  urgent_reaction: {
    description: "urgent excited reaction, energetic but still clear",
    speed: 1.15,
    temperature: 0.86,
    trailing_silence: 0,
    pause: "none",
  },
  mostly_visual: {
    description: "minimal neutral voiceover, restrained and clean",
    speed: 1,
    temperature: 0.7,
    trailing_silence: 0,
    pause: "none",
  },
};

const AUDIO_NOTE_LEAK =
  /\b(camera|wide shot|close[- ]?up|b[- ]?roll|subtitle|caption|text overlay|image_prompt|video_prompt|duration_seconds|schema|json|scene_\d+)\b/i;
const PAUSE_TOKEN = /\[(?:long\s+)?pause\]/gi;
const LONG_PAUSE_TOKEN = /\[long\s+pause\]/i;
const PRODUCT_PROOF_PROMPT =
  /\b(product|close[- ]?up|demo|use|using|feature|setting|screen|progress|result|before|after|charging|brightness|remind|track)\b/i;
const RELATABLE_FRICTION =
  /\b(forgot|forgetting|annoying|stiff|tired|bad lighting|burn(?:ing|t)?|missed|problem|hard|frustrat|overwhelm|stress|messy|too many|retry|crash|heavy|rigid|struggle)\b/i;
const PRODUCT_DISCOVERY =
  /\b(wait|finally|switch|try|tried|using|use|feature|setting|mode|remind|charging|control|plan|generate|fix|proof|demo|close[- ]?up|difference)\b/i;
const PAYOFF_OR_CTA =
  /\b(final|ending|reveal|result|better|easier|worked|try|grab|download|shop|order|get one|worth|saved|on track|focused|cozy|done|ready|difference)\b/i;
const APP_OR_PROGRESS =
  /\b(app|track(?:s|ing)?|progress|dashboard|screen|goal|streak|metric|score)\b/i;
const FEATURE_OR_SETTING =
  /\b(setting|settings|mode|brightness|warm|cool|temperature|charging|reminder|notification|glow|ping|feature|control)\b/i;
const CTA_ONLY = /\b(try|grab|download|shop|order|get one|link in bio|sign up|start|today|now)\b/i;
const HIGH_ENERGY_CONTEXT =
  /\b(tiktok|reel|ugc|ad|comparison|running|fitness|workday|creator|social|fast|quick)\b/i;
const COZY_CONTEXT = /\b(cozy|warm|lamp|coffee|desk|study|home|evening|calm|lifestyle)\b/i;
const VOICE_VARIATION_REQUEST =
  /\b(multiple|different|separate|switch(?:ing)?)\s+(?:voices?|speakers?|narrators?)\b|\b(two|three|several)\s+(?:voices?|speakers?|people talking)\b|\bdialogue between\b|\bvoice changes?\b/i;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function compactNote(note: string | null | undefined): string | null {
  const cleaned = String(note ?? "").replace(PAUSE_TOKEN, " ").split(/\s+/).filter(Boolean).join(" ").trim();
  if (!cleaned || AUDIO_NOTE_LEAK.test(cleaned)) return null;
  return cleaned.length <= 80 ? cleaned : cleaned.slice(0, 80).replace(/\s+\S*$/, "").trim();
}

export function emotionContextForScene(scene: Scene, plan?: VideoPlan, index = 0): string | null {
  const sceneText = `${scene.narration} ${scene.image_prompt} ${scene.video_prompt}`;
  const planText = `${plan?.title ?? ""} ${plan?.creative_vibe ?? ""} ${plan?.visual_bible ?? ""}`;
  const combined = `${sceneText} ${planText}`;

  if (index === 0 && RELATABLE_FRICTION.test(sceneText)) {
    return "relatable frustration at the problem, then a quick curious lift";
  }
  if (PAYOFF_OR_CTA.test(sceneText) && index >= Math.max(0, (plan?.scenes.length ?? 1) - 2)) {
    return "satisfied payoff, confident but still creator-native";
  }
  if (scene.on_camera === true && HIGH_ENERGY_CONTEXT.test(combined) && /hook|wait|okay|honestly|problem|finally/i.test(sceneText)) {
    return "expressive creator energy with real curiosity and momentum";
  }
  if (PRODUCT_DISCOVERY.test(sceneText)) {
    return "curious product-proof emphasis, clear and slightly impressed";
  }
  if (COZY_CONTEXT.test(combined)) {
    return "warm, intimate, useful, and lightly relieved";
  }
  if (/cinematic|commercial|story/i.test(planText)) {
    return "emotionally polished story delivery with restraint";
  }
  return null;
}

export function defaultAudioModeForScene(scene: Scene, plan?: VideoPlan, index = 0): AudioMode {
  if (scene.audio_mode) return scene.audio_mode;
  const text = `${scene.narration} ${scene.image_prompt} ${scene.video_prompt} ${plan?.creative_vibe ?? ""} ${plan?.title ?? ""}`;
  if (scene.on_camera === true && index === 0 && /ugc|tiktok|reel|ad|commercial/i.test(`${plan?.creative_vibe ?? ""} ${plan?.title ?? ""}`)) {
    return "ugc_hook";
  }
  if (scene.on_camera === true && RELATABLE_FRICTION.test(text)) return "urgent_reaction";
  if (scene.on_camera === true && PAYOFF_OR_CTA.test(text)) return "testimonial";
  if (PRODUCT_PROOF_PROMPT.test(`${scene.image_prompt} ${scene.video_prompt}`)) return "product_proof";
  return scene.on_camera === true
    ? "ugc_casual"
    : plan?.creative_vibe === "tutorial_walkthrough"
      ? "tutorial_clear"
      : plan?.creative_vibe === "cinematic_commercial"
        ? "cinematic_narrator"
        : plan?.creative_vibe === "cozy_lifestyle"
          ? "calm_lifestyle"
          : "product_proof";
}

export function audioPerformanceForScene(scene: Scene, plan?: VideoPlan): AudioPerformanceSettings {
  const fallbackMode: AudioMode =
    scene.on_camera === true
      ? "ugc_casual"
      : plan?.creative_vibe === "tutorial_walkthrough"
        ? "tutorial_clear"
        : plan?.creative_vibe === "cinematic_commercial"
          ? "cinematic_narrator"
          : plan?.creative_vibe === "cozy_lifestyle"
            ? "calm_lifestyle"
            : "product_proof";
  const mode = defaultAudioModeForScene(scene, plan);
  const preset = AUDIO_MODE_PRESETS[mode] ?? AUDIO_MODE_PRESETS[fallbackMode];
  const note = compactNote(scene.audio_note);
  const sceneIndex = plan?.scenes.findIndex((item) => item.id === scene.id) ?? 0;
  const emotion = emotionContextForScene(scene, plan, sceneIndex >= 0 ? sceneIndex : 0);
  const wantsLongPause = Boolean(note && /long pause|dramatic pause/i.test(note));
  const allowLongPause =
    wantsLongPause &&
    (mode === "cinematic_narrator" || mode === "calm_lifestyle") &&
    !/ugc|product|demo/i.test(`${plan?.creative_vibe ?? ""} ${plan?.title ?? ""}`);

  const emotionalLift = emotion && /frustration|expressive|payoff|curious/.test(emotion) ? 0.03 : 0;
  const speedLift = emotion && /expressive|curious/.test(emotion) ? 0.02 : 0;
  const calmPullback = emotion && /warm|polished story/.test(emotion) ? -0.02 : 0;
  const description = [preset.description, emotion ? `emotional context: ${emotion}` : "", note ?? ""]
    .filter(Boolean)
    .join("; ");

  return {
    audio_mode: mode,
    audio_note: note,
    emotion_context: emotion,
    description,
    speed: round2(Math.max(0.85, Math.min(preset.speed + speedLift + calmPullback, 1.18))),
    temperature: round2(Math.max(0.6, Math.min(preset.temperature + emotionalLift, 0.9))),
    trailing_silence: round2(Math.max(0, Math.min(preset.trailing_silence, 0.35))),
    pause: allowLongPause ? "long" : preset.pause,
  };
}

function stableAudioModeForPlan(plan?: VideoPlan): AudioMode {
  const text = `${plan?.title ?? ""} ${plan?.creative_vibe ?? ""} ${plan?.visual_bible ?? ""}`;
  if (/tutorial|walkthrough|how[- ]?to/i.test(text)) return "tutorial_clear";
  if (/cinematic|commercial|story|brand film/i.test(text)) return "cinematic_narrator";
  if (/testimonial|review|founder/i.test(text)) return "testimonial";
  if (/\b(raw_ugc|polished_ugc|high_energy_social|ugc|tiktok|reel|creator|normal person|phone-shot|selfie)\b/i.test(text)) {
    return "ugc_casual";
  }
  if (/cozy|calm|lifestyle|study|home|evening/i.test(text)) return "calm_lifestyle";
  return "ugc_casual";
}

export function planAllowsVoiceVariation(plan?: VideoPlan | null): boolean {
  if (!plan) return false;
  const text = [
    plan.title,
    plan.narration,
    plan.visual_bible,
    ...plan.scenes.flatMap((scene) => [scene.narration, scene.image_prompt, scene.video_prompt, scene.audio_note ?? ""]),
  ].join(" ");
  return VOICE_VARIATION_REQUEST.test(text);
}

export function stableAudioPerformanceForPlan(plan?: VideoPlan | null): AudioPerformanceSettings {
  const mode = stableAudioModeForPlan(plan ?? undefined);
  const preset = AUDIO_MODE_PRESETS[mode] ?? AUDIO_MODE_PRESETS.ugc_casual;
  const stableSpeed =
    mode === "ugc_casual" || mode === "testimonial"
      ? Math.min(preset.speed, 0.96)
      : preset.speed;
  const emotion =
    mode === "calm_lifestyle"
      ? "warm, intimate, useful, and lightly relieved"
      : mode === "cinematic_narrator"
        ? "emotionally polished story delivery with restraint"
        : mode === "tutorial_clear"
          ? "precise, helpful, and confident"
          : mode === "testimonial"
            ? "honest, specific, and lightly enthusiastic"
            : "natural creator energy with believable momentum";
  const description = [
    preset.description,
    `emotional context: ${emotion}`,
  ].join("; ");
  return {
    audio_mode: mode,
    audio_note: null,
    emotion_context: emotion,
    description,
    speed: stableSpeed,
    temperature: preset.temperature,
    trailing_silence: 0,
    pause: preset.pause === "long" ? "short" : preset.pause,
  };
}

export function audioPerformanceForGeneration(scene: Scene, plan?: VideoPlan | null): AudioPerformanceSettings {
  if (!plan) return audioPerformanceForScene(scene);
  return planAllowsVoiceVariation(plan) ? audioPerformanceForScene(scene, plan ?? undefined) : stableAudioPerformanceForPlan(plan);
}

export function audioTopicForScene(scene: Scene, plan?: VideoPlan | null, index = 0): string {
  const text = `${scene.narration} ${scene.image_prompt} ${scene.video_prompt}`;
  const planText = `${plan?.title ?? ""} ${plan?.creative_vibe ?? ""} ${plan?.visual_bible ?? ""}`;
  const lastIndex = Math.max(0, (plan?.scenes.length ?? 1) - 1);
  if (index === 0 && RELATABLE_FRICTION.test(text)) return "hook_problem";
  if (APP_OR_PROGRESS.test(text)) return "app_progress";
  if (FEATURE_OR_SETTING.test(text)) return "feature_demo";
  if (PRODUCT_PROOF_PROMPT.test(`${scene.image_prompt} ${scene.video_prompt}`)) return "product_proof";
  if ((PAYOFF_OR_CTA.test(text) || CTA_ONLY.test(text)) && index >= Math.max(1, lastIndex - 1)) return "payoff_cta";
  if (/tutorial|walkthrough|how[- ]?to/i.test(planText)) return `tutorial_step_${index + 1}`;
  if (/cinematic|story|commercial/i.test(planText)) return index === 0 ? "story_setup" : index >= lastIndex ? "story_payoff" : "story_development";
  if (COZY_CONTEXT.test(`${text} ${planText}`)) return "lifestyle_moment";
  return scene.on_camera === true ? "creator_reaction" : "broll_context";
}

export function topicChangePauseSeconds(previous: Scene, next: Scene, plan?: VideoPlan | null, nextIndex = 1): number {
  const previousTopic = audioTopicForScene(previous, plan, Math.max(0, nextIndex - 1));
  const nextTopic = audioTopicForScene(next, plan, nextIndex);
  if (previousTopic === nextTopic) return 0;
  if (previous.audio_mode === "mostly_visual" || next.audio_mode === "mostly_visual") return 0;
  const previousWords = previous.narration.split(/\s+/).filter(Boolean).length;
  const nextWords = next.narration.split(/\s+/).filter(Boolean).length;
  if (previousWords < 5 || nextWords < 5) return 0;
  return TOPIC_CHANGE_PAUSE_SECONDS;
}

export function audioPerformanceSequenceForPlan(
  scenes: Scene[],
  plan?: VideoPlan | null,
  options: { targetSpeechSeconds?: number; wordsPerSecond?: number } = {},
): AudioPerformanceSettings[] {
  const sequence = scenes.map((scene, index) => {
    const settings = audioPerformanceForGeneration(scene, plan ?? null);
    const next = scenes[index + 1];
    if (!next) return settings;
    const topicPause = topicChangePauseSeconds(scene, next, plan, index + 1);
    if (topicPause <= settings.trailing_silence) return settings;
    return { ...settings, trailing_silence: topicPause };
  });
  const target = Number(options.targetSpeechSeconds ?? 0);
  const wordsPerSecond = Number(options.wordsPerSecond ?? 0);
  if (!(target > 0) || !(wordsPerSecond > 0)) return sequence;
  const estimated = scenes.reduce((sum, scene, index) => {
    const words = scene.narration.split(/\s+/).filter(Boolean).length;
    const settings = sequence[index]!;
    return sum + words / Math.max(1.05, wordsPerSecond * settings.speed) + settings.trailing_silence;
  }, 0);
  if (estimated >= target || estimated < target * 0.88) return sequence;
  const speedScale = estimated / target;
  return sequence.map((settings) => ({
    ...settings,
    speed: round2(Math.max(0.85, settings.speed * speedScale)),
  }));
}

export function sanitizeTextForAudioPerformance(text: string, settings: AudioPerformanceSettings): string {
  let cleaned = text.replace(/\s+/g, " ").trim();
  if (settings.pause === "none") return cleaned.replace(PAUSE_TOKEN, " ").replace(/\s+/g, " ").trim();

  const targetToken = settings.pause === "long" && LONG_PAUSE_TOKEN.test(cleaned) ? "[long pause]" : "[pause]";
  let used = false;
  cleaned = cleaned.replace(PAUSE_TOKEN, () => {
    if (used) return " ";
    used = true;
    return targetToken;
  });
  return cleaned.replace(/\s+/g, " ").trim();
}

export function averagedHumeTemperature(settings: AudioPerformanceSettings[]): number | null {
  if (settings.length === 0) return null;
  const avg = settings.reduce((sum, item) => sum + item.temperature, 0) / settings.length;
  return round2(Math.max(0.6, Math.min(avg, 0.9)));
}

export function audioPerformanceIssues(plan: VideoPlan): string[] {
  const issues: string[] = [];
  for (const scene of plan.scenes) {
    if (scene.audio_note && AUDIO_NOTE_LEAK.test(scene.audio_note)) {
      issues.push(`${scene.id} audio_note contains visual/schema instructions; keep it to voice delivery only.`);
    }
    if (scene.audio_mode === "mostly_visual" && scene.narration.split(/\s+/).filter(Boolean).length > 20) {
      issues.push(`${scene.id} uses mostly_visual audio_mode but has too much narration.`);
    }
    if (/ugc|product|demo/i.test(`${plan.creative_vibe} ${plan.title}`) && /\[long\s+pause\]/i.test(scene.narration)) {
      issues.push(`${scene.id} uses [long pause] in a UGC/product plan; remove dead-air pause tokens.`);
    }
  }
  return issues;
}
