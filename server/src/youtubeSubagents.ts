import OpenAI from "openai";
import { ENV } from "./config.js";
import type { ProjectContext } from "./context.js";
import {
  countSpokenWords,
  speechBudgetForRequest,
  youtubeScriptNarration,
  normalizeYoutubeScriptPlan,
} from "./prompts.js";
import { YouTubeScriptPlanSchema, type CreateProjectRequest, type YouTubeClipSection, type YouTubeScriptPlan } from "./schemas.js";

export interface YoutubeSubagentReview {
  agent: string;
  model: string;
  accepted: boolean;
  changed: boolean;
  issues: string[];
  summary: string;
  usage?: Record<string, unknown> | null;
}

export interface YoutubeScriptSubagentResult {
  plan: YouTubeScriptPlan;
  review: YoutubeSubagentReview;
}

export interface YoutubeCandidateSubagentResult {
  candidates: Array<Record<string, any>>;
  review: YoutubeSubagentReview & {
    ranked_video_ids: string[];
    rejected_video_ids: Array<{ video_id: string; reason: string }>;
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function youtubeSubagentModel(): string {
  return ENV.YOUTUBE_SUBAGENT_MODEL ?? "gpt-5.4-mini";
}

function subagentsEnabled(): boolean {
  return ENV.YOUTUBE_SUBAGENTS_ENABLED !== "false" && Boolean(ENV.OPENAI_API_KEY);
}

function responseText(response: any): string {
  if (typeof response?.output_text === "string" && response.output_text.trim()) return response.output_text;
  const chunks: string[] = [];
  for (const item of response?.output ?? []) {
    for (const content of item?.content ?? []) {
      if (typeof content?.text === "string") chunks.push(content.text);
    }
  }
  return chunks.join("\n");
}

function plainUsage(usage: unknown): Record<string, unknown> | null {
  if (!usage || typeof usage !== "object") return null;
  return JSON.parse(JSON.stringify(usage));
}

function sectionDurationTotal(plan: YouTubeScriptPlan): number {
  return plan.sections.reduce((sum, section) => sum + Number(section.duration_seconds ?? 0), 0);
}

function scriptBudgetIssues(request: CreateProjectRequest, ctx: ProjectContext, plan: YouTubeScriptPlan): string[] {
  const budget = speechBudgetForRequest(request, ctx);
  const issues: string[] = [];
  const totalSeconds = sectionDurationTotal(plan);
  const words = countSpokenWords(youtubeScriptNarration(plan));
  if (totalSeconds > budget.scene_duration_total_seconds + 0.01) {
    issues.push(`section durations ${round3(totalSeconds)}s exceed budget ${round3(budget.scene_duration_total_seconds)}s`);
  }
  if (words > budget.max_words) {
    issues.push(`dialogue has ${words} words, above budget ${budget.max_words}`);
  }
  return issues;
}

export function fitYoutubeSectionDurations(plan: YouTubeScriptPlan, targetSectionSeconds: number): YouTubeScriptPlan {
  const normalized = normalizeYoutubeScriptPlan(plan);
  const sections = normalized.sections;
  if (sections.length === 0) return normalized;
  const currentTotal = sectionDurationTotal(normalized);
  if (currentTotal <= targetSectionSeconds + 0.01) return normalized;

  const floor = sections.length;
  const target = Math.max(floor, Math.round(targetSectionSeconds));
  let remaining = target;
  const raw = sections.map((section) => Math.max(1, (section.duration_seconds / currentTotal) * target));
  const fitted = raw.map((value) => Math.max(1, Math.floor(value)));
  remaining -= fitted.reduce((sum, value) => sum + value, 0);
  const order = raw
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);
  for (const item of order) {
    if (remaining <= 0) break;
    fitted[item.index]! += 1;
    remaining -= 1;
  }
  return {
    ...normalized,
    sections: sections.map((section, index) => ({ ...section, duration_seconds: fitted[index]! })),
  };
}

function words(text: string): string[] {
  return text.split(/\s+/).map((word) => word.trim()).filter(Boolean);
}

function truncateToWords(text: string, maxWords: number): string {
  const items = words(text);
  if (items.length <= maxWords) return text.replace(/\s+/g, " ").trim();
  const clipped = items.slice(0, Math.max(1, maxWords)).join(" ");
  return /[.!?]$/.test(clipped) ? clipped : `${clipped}.`;
}

export function fitYoutubeScriptToBudget(
  plan: YouTubeScriptPlan,
  options: { targetSectionSeconds: number; maxWords: number },
): YouTubeScriptPlan {
  const durationFitted = fitYoutubeSectionDurations(plan, options.targetSectionSeconds);
  const currentWords = countSpokenWords(youtubeScriptNarration(durationFitted));
  if (currentWords <= options.maxWords) return durationFitted;

  const sections = durationFitted.sections;
  const totalDuration = sectionDurationTotal(durationFitted) || sections.length;
  let remainingWords = options.maxWords;
  const fittedSections = sections.map((section, index) => {
    const remainingSections = sections.length - index;
    const sectionShare = Math.max(1, Math.floor((section.duration_seconds / totalDuration) * options.maxWords));
    const wordLimit = Math.max(1, Math.min(sectionShare, remainingWords - Math.max(0, remainingSections - 1)));
    remainingWords -= wordLimit;
    return { ...section, dialogue: truncateToWords(section.dialogue, wordLimit) };
  });
  return normalizeYoutubeScriptPlan({ ...durationFitted, sections: fittedSections });
}

export function applyCandidateRanking(
  candidates: Array<Record<string, any>>,
  rankedVideoIds: string[],
): Array<Record<string, any>> {
  const byId = new Map(candidates.map((candidate) => [String(candidate.video_id ?? ""), candidate]));
  const ranked: Array<Record<string, any>> = [];
  const seen = new Set<string>();
  for (const id of rankedVideoIds) {
    const candidate = byId.get(String(id));
    if (!candidate || seen.has(String(id))) continue;
    ranked.push(candidate);
    seen.add(String(id));
  }
  for (const candidate of candidates) {
    const id = String(candidate.video_id ?? "");
    if (!seen.has(id)) ranked.push(candidate);
  }
  return ranked;
}

export async function reviewYoutubeScriptWithSubagent(
  ctx: ProjectContext,
  request: CreateProjectRequest,
  plan: YouTubeScriptPlan,
): Promise<YoutubeScriptSubagentResult> {
  const model = youtubeSubagentModel();
  const budget = speechBudgetForRequest(request, ctx);
  const initialIssues = scriptBudgetIssues(request, ctx, plan);
  if (initialIssues.length === 0) {
    return {
      plan,
      review: {
        agent: "youtube_script_budget_subagent",
        model,
        accepted: true,
        changed: false,
        issues: [],
        summary: "Script already fits the target runtime and spoken-word budget.",
      },
    };
  }

  if (!subagentsEnabled()) {
    const fitted = fitYoutubeScriptToBudget(plan, {
      targetSectionSeconds: budget.scene_duration_total_seconds,
      maxWords: budget.max_words,
    });
    return {
      plan: fitted,
      review: {
        agent: "youtube_script_budget_subagent",
        model,
        accepted: false,
        changed: true,
        issues: initialIssues,
        summary: "Subagent disabled; clamped section durations deterministically.",
      },
    };
  }

  const prompt = [
    "You are a cheap YouTube script-budget subagent for a short-video composer.",
    "Rewrite only the section dialogue and duration_seconds when needed.",
    "Preserve title meaning, section count, search_hint, candidate_video_urls, and all search targeting fields.",
    "The final section must finish narration before the visual final hold; do not put extra spoken content after the ending visual beat.",
    `User prompt: ${request.prompt}`,
    `Target final runtime seconds: ${budget.final_duration_seconds}`,
    `Maximum total section seconds: ${round3(budget.scene_duration_total_seconds)}`,
    `Spoken word budget: ${budget.min_words}-${budget.max_words} words total`,
    `Issues to fix: ${initialIssues.join("; ")}`,
    `Current plan JSON: ${JSON.stringify(plan)}`,
    "Return a complete YouTubeScriptPlan JSON object.",
  ].join("\n");

  try {
    const response = await new OpenAI({ apiKey: ENV.OPENAI_API_KEY }).responses.create(
      {
        model,
        input: [{ role: "user", content: prompt }],
        max_output_tokens: 1800,
        text: {
          format: {
            type: "json_schema",
            name: "youtube_script_budget_plan",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                title: { type: "string" },
                web_search_needed: { type: "boolean" },
                web_search_reason: { type: "string" },
                sections: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      section: { type: "number" },
                      dialogue: { type: "string" },
                      search_hint: { type: "string" },
                      duration_seconds: { type: "integer" },
                      search_order: { anyOf: [{ type: "string" }, { type: "null" }] },
                      published_after: { anyOf: [{ type: "string" }, { type: "null" }] },
                      published_before: { anyOf: [{ type: "string" }, { type: "null" }] },
                      video_duration: { anyOf: [{ type: "string" }, { type: "null" }] },
                      video_category: { anyOf: [{ type: "string" }, { type: "null" }] },
                      require_captions: { type: "boolean" },
                      channel_hint: { anyOf: [{ type: "string" }, { type: "null" }] },
                      candidate_video_urls: { type: "array", items: { type: "string" } },
                    },
                    required: [
                      "section",
                      "dialogue",
                      "search_hint",
                      "duration_seconds",
                      "search_order",
                      "published_after",
                      "published_before",
                      "video_duration",
                      "video_category",
                      "require_captions",
                      "channel_hint",
                      "candidate_video_urls",
                    ],
                  },
                },
              },
              required: ["title", "web_search_needed", "web_search_reason", "sections"],
            },
          },
        },
      } as any,
      { timeout: Number(ENV.YOUTUBE_SUBAGENT_TIMEOUT_SECONDS ?? 20) * 1000 },
    );
    let revised = normalizeYoutubeScriptPlan(YouTubeScriptPlanSchema.parse(JSON.parse(responseText(response))));
    revised = fitYoutubeScriptToBudget(revised, {
      targetSectionSeconds: budget.scene_duration_total_seconds,
      maxWords: budget.max_words,
    });
    const remainingIssues = scriptBudgetIssues(request, ctx, revised);
    return {
      plan: revised,
      review: {
        agent: "youtube_script_budget_subagent",
        model,
        accepted: remainingIssues.length === 0,
        changed: true,
        issues: remainingIssues.length > 0 ? remainingIssues : initialIssues,
        summary: remainingIssues.length === 0 ? "Rewrote script to fit runtime budget." : "Rewrote script but budget issues remain.",
        usage: plainUsage(response.usage),
      },
    };
  } catch (exc: any) {
    const fitted = fitYoutubeScriptToBudget(plan, {
      targetSectionSeconds: budget.scene_duration_total_seconds,
      maxWords: budget.max_words,
    });
    return {
      plan: fitted,
      review: {
        agent: "youtube_script_budget_subagent",
        model,
        accepted: false,
        changed: true,
        issues: [...initialIssues, `subagent failed: ${String(exc?.message ?? exc).slice(0, 180)}`],
        summary: "Subagent failed; clamped section durations deterministically.",
      },
    };
  }
}

export async function rankYoutubeCandidatesWithSubagent(
  section: YouTubeClipSection,
  candidates: Array<Record<string, any>>,
): Promise<YoutubeCandidateSubagentResult> {
  const model = youtubeSubagentModel();
  const baseReview = {
    agent: "youtube_candidate_selection_subagent",
    model,
    accepted: true,
    changed: false,
    issues: [],
    summary: "Candidate order left unchanged.",
    ranked_video_ids: candidates.map((candidate) => String(candidate.video_id ?? "")).filter(Boolean),
    rejected_video_ids: [],
  };
  if (!subagentsEnabled() || candidates.length < 2) return { candidates, review: baseReview };

  const compactCandidates = candidates.slice(0, 8).map((candidate) => ({
    video_id: candidate.video_id,
    title: candidate.title,
    channel_title: candidate.channel_title,
    description: String(candidate.description ?? "").slice(0, 240),
    duration_seconds: candidate.duration_seconds ?? null,
    published_at: candidate.published_at ?? null,
  }));
  const prompt = [
    "You are a cheap YouTube candidate-selection subagent.",
    "Rank candidate videos for the exact narrated section. Prefer real footage matching the visible scene over commentary, stock, podcasts, title cards, or unrelated compilations.",
    `Section dialogue: ${section.dialogue}`,
    `Search hint: ${section.search_hint}`,
    `Candidates: ${JSON.stringify(compactCandidates)}`,
    "Return JSON with ranked_video_ids and rejected_video_ids.",
  ].join("\n");

  try {
    const response = await new OpenAI({ apiKey: ENV.OPENAI_API_KEY }).responses.create(
      {
        model,
        input: [{ role: "user", content: prompt }],
        max_output_tokens: 600,
        text: {
          format: {
            type: "json_schema",
            name: "youtube_candidate_ranking",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                ranked_video_ids: { type: "array", items: { type: "string" } },
                rejected_video_ids: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      video_id: { type: "string" },
                      reason: { type: "string" },
                    },
                    required: ["video_id", "reason"],
                  },
                },
                summary: { type: "string" },
              },
              required: ["ranked_video_ids", "rejected_video_ids", "summary"],
            },
          },
        },
      } as any,
      { timeout: Number(ENV.YOUTUBE_SUBAGENT_TIMEOUT_SECONDS ?? 20) * 1000 },
    );
    const parsed = JSON.parse(responseText(response));
    const rankedVideoIds = Array.isArray(parsed.ranked_video_ids) ? parsed.ranked_video_ids.map(String) : [];
    const reordered = applyCandidateRanking(candidates, rankedVideoIds);
    return {
      candidates: reordered,
      review: {
        ...baseReview,
        changed: rankedVideoIds.length > 0 && reordered[0]?.video_id !== candidates[0]?.video_id,
        summary: String(parsed.summary || "Candidate ranking reviewed."),
        ranked_video_ids: rankedVideoIds,
        rejected_video_ids: Array.isArray(parsed.rejected_video_ids) ? parsed.rejected_video_ids : [],
        usage: plainUsage(response.usage),
      },
    };
  } catch (exc: any) {
    return {
      candidates,
      review: {
        ...baseReview,
        accepted: false,
        issues: [`subagent failed: ${String(exc?.message ?? exc).slice(0, 180)}`],
        summary: "Candidate subagent failed; original ranker order kept.",
      },
    };
  }
}
