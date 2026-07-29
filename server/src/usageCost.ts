import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Usage } from "@openai/agents";
import { OPENAI_TEXT_PRICING_USD_PER_1M } from "./config.js";
import type { ProjectContext } from "./context.js";
import { openRouterPricingForModel } from "./agentRuntime.js";
import type { JsonDict } from "./renderState.js";

export function pricingKeyForModel(model: string): string {
  if (model in OPENAI_TEXT_PRICING_USD_PER_1M) return model;
  if (model.startsWith("openai/")) {
    const openAiModel = model.slice("openai/".length);
    if (openAiModel in OPENAI_TEXT_PRICING_USD_PER_1M) return openAiModel;
  }
  for (const knownModel of Object.keys(OPENAI_TEXT_PRICING_USD_PER_1M)) {
    if (model.startsWith(`${knownModel}-`)) return knownModel;
  }
  throw new Error(`No OpenAI pricing configured for model: ${model}`);
}

function pricingForModel(model: string, provider = "openai") {
  if (provider === "openrouter") {
    const openRouterPricing = openRouterPricingForModel(model);
    if (openRouterPricing) return openRouterPricing;
  }
  try {
    return OPENAI_TEXT_PRICING_USD_PER_1M[pricingKeyForModel(model)] ?? null;
  } catch {
    return null;
  }
}

function tokenDetailValue(details: Array<Record<string, number>> | Record<string, number> | undefined, key: string): number {
  if (!details) return 0;
  if (Array.isArray(details)) {
    return details.reduce((sum, entry) => sum + Number(entry?.[key] ?? 0), 0);
  }
  return Number(details[key] ?? 0);
}

function round8(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

function serializeUsage(usage: Usage): JsonDict {
  return {
    requests: usage.requests,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    input_tokens_details: usage.inputTokensDetails,
    output_tokens_details: usage.outputTokensDetails,
    request_usage_entries: (usage.requestUsageEntries ?? []).map((entry) => ({
      input_tokens: entry.inputTokens,
      output_tokens: entry.outputTokens,
      total_tokens: entry.totalTokens,
      input_tokens_details: entry.inputTokensDetails,
      output_tokens_details: entry.outputTokensDetails,
      ...(entry.endpoint ? { endpoint: entry.endpoint } : {}),
    })),
  };
}

export function tokenOutputPayload(projectId: string, model: string, usage: Usage, provider = "openai"): JsonDict {
  const pricing = pricingForModel(model, provider);
  const cachedInputTokens = tokenDetailValue(usage.inputTokensDetails, "cached_tokens");
  const reasoningTokens = tokenDetailValue(usage.outputTokensDetails, "reasoning_tokens");
  const toolSearchTokens = tokenDetailValue(usage.inputTokensDetails, "tool_search_tokens");
  const uncachedInputTokens = Math.max(usage.inputTokens - cachedInputTokens, 0);
  const maxRequestInputTokens = Math.max(
    usage.inputTokens,
    ...(usage.requestUsageEntries ?? []).map((entry) => entry.inputTokens),
    0,
  );
  const longContextApplies = pricing ? maxRequestInputTokens > pricing.long_context_threshold_input_tokens : false;
  const inputMultiplier = pricing && longContextApplies ? pricing.long_context_input_multiplier : 1.0;
  const outputMultiplier = pricing && longContextApplies ? pricing.long_context_output_multiplier : 1.0;

  const inputCost = pricing ? (uncachedInputTokens * pricing.input * inputMultiplier) / 1_000_000 : 0;
  const cachedInputCost = pricing ? (cachedInputTokens * pricing.cached_input * inputMultiplier) / 1_000_000 : 0;
  const outputCost = pricing ? (usage.outputTokens * pricing.output * outputMultiplier) / 1_000_000 : 0;
  const totalCost = inputCost + cachedInputCost + outputCost;

  return {
    project_id: projectId,
    created_at: new Date().toISOString(),
    provider,
    model,
    pricing: {
      currency: "USD",
      unit: "per_1m_tokens",
      source: pricing?.source ?? "pricing_not_configured",
      estimate_available: Boolean(pricing),
      input: pricing?.input ?? 0,
      cached_input: pricing?.cached_input ?? 0,
      output: pricing?.output ?? 0,
      long_context_threshold_input_tokens: pricing?.long_context_threshold_input_tokens ?? null,
      long_context_applies: longContextApplies,
      input_multiplier: inputMultiplier,
      output_multiplier: outputMultiplier,
    },
    usage: {
      ...serializeUsage(usage),
      cached_input_tokens: cachedInputTokens,
      uncached_input_tokens: uncachedInputTokens,
      reasoning_tokens: reasoningTokens,
      tool_search_tokens: toolSearchTokens,
    },
    cost: {
      input_usd: round8(inputCost),
      cached_input_usd: round8(cachedInputCost),
      output_usd: round8(outputCost),
      total_usd: round8(totalCost),
    },
    scope: "Agent planning run only. Magic Hour, selected TTS provider, and ffmpeg costs are not included.",
  };
}

export function pendingTokenOutput(ctx: ProjectContext, model: string, provider = "openai"): JsonDict {
  const tokenOutputPath = path.join(ctx.project_dir, "token_output.json");
  return {
    project_id: ctx.project_id,
    created_at: new Date().toISOString(),
    provider,
    model,
    usage: {
      requests: 0,
      input_tokens: 0,
      cached_input_tokens: 0,
      uncached_input_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
      tool_search_tokens: 0,
      total_tokens: 0,
    },
    cost: {
      input_usd: 0,
      cached_input_usd: 0,
      output_usd: 0,
      total_usd: 0,
    },
    token_output_path: tokenOutputPath,
    scope: "Pending until the agent run completes. Magic Hour, selected TTS provider, and ffmpeg costs are not included.",
  };
}

export function pendingTokenOutputForContext(ctx: ProjectContext): JsonDict {
  return pendingTokenOutput(ctx, ctx.agent_model || "gpt-5.4", ctx.agent_provider || "openai");
}

export function writeTokenOutput(ctx: ProjectContext, usage: Usage, model: string, provider = "openai"): JsonDict {
  const tokenOutputPath = path.join(ctx.project_dir, "token_output.json");
  const payload = tokenOutputPayload(ctx.project_id, model, usage, provider);
  payload.token_output_path = tokenOutputPath;
  mkdirSync(ctx.project_dir, { recursive: true });
  writeFileSync(tokenOutputPath, JSON.stringify(payload, null, 2), "utf-8");
  return payload;
}

