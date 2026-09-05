import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { ENV } from "./config.js";
import type { ProjectContext } from "./context.js";
import {
  agentRuntimeStatus,
  assertAgentRuntimeReady,
  cloneAgentForRuntime,
  resolveAgentRuntime,
  runnerForRuntime,
  runtimeFromContext,
  type AgentRuntimeConfig,
} from "./agentRuntime.js";
import { projectEvents } from "./events.js";
import { ProjectRunScheduler } from "./projectRunScheduler.js";
import {
  context,
  contextForExistingProject,
  configuredAgentMaxTurns,
  ensureProjectState,
  initializeProjectState,
} from "./projectContext.js";
import {
  PROJECTS,
  RUNNING_YOUTUBE_REVIEW_BATCHES,
  YOUTUBE_REVIEW_PROVIDERS_ACTIVE,
  readProjectStatus,
  readYoutubeReviewBatch,
  readYoutubeReviewSession,
  terminalYoutubeStatusFromManifest,
  updateProjectStatus,
  writeYoutubeReviewSession,
  youtubeReviewProjectRequest,
} from "./projects.js";
import { classifyMagicHourRequest, unsupportedPlannedCapability } from "./magicHourCapabilities.js";
import { agentResponseContent, buildProjectMessageBrief, buildProjectRunBrief } from "./prompts.js";
import { appendProjectMessage, artifactPath, readJsonArtifact, readProjectState, updateProjectState } from "./renderState.js";
import type { JsonDict } from "./renderState.js";
import { rememberProjectRuntimeCredentials, runtimeCredentialsFromRequest } from "./runtimeCredentials.js";
import { recordTimingEvent, withTiming } from "./timings.js";
import {
  YouTubeReviewSessionRequestSchema,
  type CreateProjectRequest,
  type RuntimeCredentials,
  type YouTubeReviewSessionRequest,
} from "./schemas.js";
import { pendingTokenOutputForContext, writeTokenOutput } from "./usageCost.js";
import {
  animateSceneVideosImpl,
  draftFallbackVideoPlanImpl,
  generateSceneImagesImpl,
  generateVoiceoverImpl,
  mergeTokenOutputIntoManifest,
  requestClarificationImpl,
  stitchFinalVideoImpl,
} from "./workflows.js";
import { createYoutubeShortFromPromptImpl, projectAgentForRequest, projectMessageAgentForContext } from "./agents.js";

function newId(): string {
  return randomUUID().replaceAll("-", "");
}

function describeRunItem(item: any): JsonDict | null {
  const rawItem = item?.rawItem ?? {};
  const base: JsonDict = { item_type: item?.type ?? "unknown" };
  switch (item?.type) {
    case "tool_call_item": {
      base.tool_name = rawItem?.name ?? rawItem?.action?.type ?? rawItem?.type ?? "tool";
      const args = typeof rawItem?.arguments === "string" ? rawItem.arguments : JSON.stringify(rawItem?.arguments ?? null);
      base.arguments_preview = args ? String(args).slice(0, 400) : null;
      return base;
    }
    case "tool_call_output_item": {
      base.tool_name = rawItem?.name ?? "tool";
      const output = typeof item?.output === "string" ? item.output : JSON.stringify(item?.output ?? null);
      base.output_preview = output ? String(output).slice(0, 2000) : null;
      return base;
    }
    case "message_output_item": {
      const content = (rawItem?.content ?? [])
        .map((part: any) => part?.text ?? "")
        .filter(Boolean)
        .join(" ");
      base.text = String(content).slice(0, 600);
      return base;
    }
    case "reasoning_item": {
      const summary = (rawItem?.content ?? rawItem?.summary ?? [])
        .map((part: any) => part?.text ?? "")
        .filter(Boolean)
        .join(" ");
      base.text = String(summary).slice(0, 400);
      return base;
    }
    default:
      return base;
  }
}

async function runAgentStreamed(
  agent: any,
  input: string,
  ctx: ProjectContext,
  runtime: AgentRuntimeConfig = runtimeFromContext(ctx),
): Promise<{ finalOutput: unknown; usage: any }> {
  assertAgentRuntimeReady(runtime);
  return withTiming(ctx, "agent.run_streamed", {
    provider: runtime.provider,
    model: runtime.model,
    intensity: runtime.intensity,
  }, async () => {
    for (let transportAttempt = 1; transportAttempt <= 2; transportAttempt += 1) {
      let emittedVisibleOutput = false;
      let streamed: any = null;
      try {
        const runner = runnerForRuntime(runtime);
        streamed = await runner.run(cloneAgentForRuntime(agent, runtime) as any, input, {
          stream: true,
          context: ctx,
          maxTurns: configuredAgentMaxTurns(),
          signal: AbortSignal.timeout(AGENT_STREAM_TIMEOUT_MS),
        });
        let planValidationFailures = 0;
        let lastPlanValidationOutput = "";
        for await (const event of streamed) {
          if (event.type === "run_item_stream_event") {
            const detail = describeRunItem(event.item);
            if (detail) {
              emittedVisibleOutput = true;
              projectEvents.emitProjectEvent(ctx.project_id, {
                type: "agent_event",
                event_name: event.name,
                ...detail,
              });
              if (
                detail.tool_name === "draft_video_plan" &&
                typeof detail.output_preview === "string" &&
                !(detail.output_preview.includes("validation_failed") ||
                  detail.output_preview.includes("Draft plan failed first-run production quality checks"))
              ) {
                planValidationFailures = 0;
                lastPlanValidationOutput = "";
              } else if (
                detail.tool_name === "draft_video_plan" &&
                typeof detail.output_preview === "string" &&
                (detail.output_preview.includes("validation_failed") ||
                  detail.output_preview.includes("Draft plan failed first-run production quality checks"))
              ) {
                if (detail.output_preview.includes("Draft plan repair budget exhausted")) {
                  throw new Error(summarizePlanValidationOutput(detail.output_preview));
                }
                planValidationFailures += 1;
                lastPlanValidationOutput = detail.output_preview;
                if (planValidationFailures > MAX_STREAMED_PLAN_VALIDATION_FAILURES) {
                  const issueSummary = summarizePlanValidationOutput(lastPlanValidationOutput);
                  throw new Error(
                    "Draft plan failed production checks after the allowed pre-provider repairs. " +
                      "Stopping before paid provider calls." +
                      (issueSummary ? ` Issues: ${issueSummary}` : ""),
                  );
                }
              }
            }
          } else if (event.type === "agent_updated_stream_event") {
            projectEvents.emitProjectEvent(ctx.project_id, {
              type: "agent_event",
              event_name: "agent_updated",
              agent_name: event.agent?.name ?? "agent",
            });
          }
        }
        await streamed.completed;
        return { finalOutput: streamed.finalOutput, usage: streamed.runContext.usage };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const interrupted =
          runtime.provider === "openrouter" &&
          /\b(terminated|fetch failed|network|socket|econnreset|connection reset|abort(?:ed)?)\b/i.test(message);
        const state = readProjectState(ctx);
        const currentStage = String(state.status?.stage ?? "");
        const acceptedPlanExists = existsSync(artifactPath(ctx, "plan"));
        const needsAgentRepair =
          currentStage === "plan_validation_failed" ||
          currentStage === "voiceover_validation_failed" ||
          currentStage === "planning_failed" ||
          currentStage === "voiceover_failed";
        if (interrupted && emittedVisibleOutput && acceptedPlanExists && !needsAgentRepair) {
          recordTimingEvent(ctx, {
            phase: "event",
            name: "agent.interrupted_handoff",
            metadata: {
              error: message,
              stage: currentStage,
              provider_rerendered: false,
            },
          });
          return {
            finalOutput: null,
            usage: streamed?.runContext?.usage ?? {},
          };
        }
        const retryable =
          interrupted &&
          transportAttempt === 1 &&
          !acceptedPlanExists;
        if (!retryable) throw error;
        recordTimingEvent(ctx, {
          phase: "event",
          name: "agent.openrouter.pre_output_retry",
          metadata: { attempt: transportAttempt, error: message },
        });
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    }
    throw new Error("OpenRouter transport retry exhausted before agent output.");
  });
}

function summarizePlanValidationOutput(output: string): string {
  try {
    const parsed = JSON.parse(output) as { issues?: unknown };
    if (Array.isArray(parsed.issues)) {
      return parsed.issues.map((issue) => String(issue)).filter(Boolean).slice(0, 4).join(" ");
    }
  } catch {
    // Fall back to the preview text below.
  }
  const issuesMatch = output.match(/"issues"\s*:\s*\[(.*?)\]/s);
  return (issuesMatch?.[1] ?? output)
    .replaceAll(/\\n/g, " ")
    .replaceAll(/[{}\[\]"]/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, 800);
}

// Default to one outer agent pass. A full re-run can duplicate provider jobs, so
// production should opt into AGENT_MANIFEST_ATTEMPTS only for non-render dry runs
// or controlled debugging.
const MAX_MANIFEST_ATTEMPTS = Math.max(1, Math.trunc(Number(ENV.AGENT_MANIFEST_ATTEMPTS ?? 1)));
function projectRunConcurrencyLimit(): number {
  const raw = String(ENV.PROJECT_RUN_CONCURRENCY ?? ENV.MAX_PARALLEL_PROJECT_RUNS ?? "auto").trim().toLowerCase();
  const auto = Math.max(2, availableParallelism?.() ?? 4);
  if (!raw || raw === "auto" || raw === "hardware") return auto;
  const parsed = Math.trunc(Number(raw));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : auto;
}

const PROJECT_RUN_CONCURRENCY_LIMIT = projectRunConcurrencyLimit();
const MAX_STREAMED_PLAN_VALIDATION_FAILURES = Math.max(
  2,
  Math.trunc(Number(ENV.AGENT_PLAN_VALIDATION_REPAIRS ?? 2)) || 2,
);
const AGENT_STREAM_TIMEOUT_MS = Math.max(
  60_000,
  Math.trunc(Number(ENV.AGENT_STREAM_TIMEOUT_MS ?? 12 * 60_000)) || 12 * 60_000,
);

const projectRunScheduler = new ProjectRunScheduler(PROJECT_RUN_CONCURRENCY_LIMIT);

export function projectRunSchedulerStatus(): JsonDict {
  return projectRunScheduler.snapshot();
}

export function scheduleProjectRun(projectId: string, request: CreateProjectRequest): void {
  projectRunScheduler.enqueue({
    projectId,
    run: () => runProject(projectId, request),
    onQueued: async (position, active, limit) => {
      await updateProjectStatus(projectId, {
        status: "queued",
        stage: "queued",
        progress: 0,
        message: `Queued behind ${active} active generation${active === 1 ? "" : "s"} (position ${position}, limit ${limit}).`,
      });
    },
  });
}

export async function runAgentUntilManifest(
  agent: any,
  brief: string,
  ctx: ProjectContext,
  runFn: (agent: any, input: string, ctx: ProjectContext) => Promise<{ finalOutput: unknown; usage: any }> =
    runAgentStreamed,
  opts: { maxAttempts?: number; onRetry?: (nextAttempt: number) => void | Promise<void> } = {},
): Promise<{ usage: any; attempts: number; manifestExists: boolean }> {
  const maxAttempts = opts.maxAttempts ?? MAX_MANIFEST_ATTEMPTS;
  const manifestPath = path.join(ctx.project_dir, "manifest.json");
  let usage: any;
  let attempts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    ({ usage } = await runFn(agent, brief, ctx));
    if (existsSync(manifestPath)) {
      return { usage, attempts, manifestExists: true };
    }
    if (attempt < maxAttempts && opts.onRetry) {
      await opts.onRetry(attempt + 1);
    }
  }
  return { usage, attempts, manifestExists: false };
}

function generationFailureStatus(exc: unknown, state: JsonDict, current: JsonDict): { stage: string; message: string; error: string } {
  const raw = String((exc as Error)?.message ?? exc);
  const text = raw.toLowerCase();
  const currentStage = String(state.status?.stage ?? current.stage ?? "").toLowerCase();
  if (/api key|missing_config|not ready|503/.test(text)) {
    return { stage: "configuration_failed", message: "Generation needs working API keys or local dependencies.", error: raw };
  }
  if (/credit|quota|rate limit|429|balance/.test(text)) {
    return { stage: "provider_limited", message: "A provider rejected the run because of credits, quota, or rate limits.", error: raw };
  }
  if (/draft|plan|validation|schema/.test(text) || currentStage.includes("planning")) {
    return { stage: "planning_failed", message: "The creative plan did not pass the objective pre-render checks.", error: raw };
  }
  if (/voice|audio|hume|fish|elevenlabs|eleven labs|tts/.test(text) || currentStage.includes("voice")) {
    return { stage: "voiceover_failed", message: "Voice generation failed before the final video could be assembled.", error: raw };
  }
  if (/image|keyframe|still|collage|split/.test(text) || currentStage.includes("image")) {
    return { stage: "image_generation_failed", message: "Scene keyframe generation failed.", error: raw };
  }
  if (/video|animate|talking|magic hour|provider job|render/.test(text) || currentStage.includes("video")) {
    return { stage: "video_generation_failed", message: "Scene video generation failed.", error: raw };
  }
  if (/stitch|ffmpeg|timeline|mp4/.test(text) || currentStage.includes("stitch")) {
    return { stage: "stitching_failed", message: "Final stitching failed after media generation.", error: raw };
  }
  return { stage: "failed", message: "Generation failed. Check the activity log for the failing step.", error: raw };
}

async function completeAcceptedVideoPlan(ctx: ProjectContext, tokenOutput: JsonDict): Promise<void> {
  const state = readJsonArtifact<JsonDict>(ctx, "project_state", {}) ?? {};
  const status = state.status ?? {};
  if (status.error && /validation_failed|failed|blocked/i.test(String(status.stage ?? ""))) {
    throw new Error(String(status.error));
  }
  const plan = readJsonArtifact<JsonDict>(ctx, "plan", null);

  updateProjectState(ctx, {
    decision: {
      tool: "run_project",
      decision: "Agent saved a valid plan without finishing media tools; running deterministic render sequence.",
      metadata: { provider_rerendered: false },
    },
  });

  const voiceover = readJsonArtifact<JsonDict>(ctx, "voiceover", null);
  const narratedSceneIds = Array.isArray(plan?.scenes)
    ? plan.scenes
        .filter((scene: JsonDict) => String(scene.narration ?? "").trim())
        .map((scene: JsonDict) => String(scene.id))
    : [];
  const hasPerSceneAudio =
    narratedSceneIds.length > 0 &&
    narratedSceneIds.every((sceneId: string) =>
      existsSync(path.join(ctx.project_dir, "voiceover", "scenes", `${sceneId}.${ctx.audio_format}`)),
    );
  if (!voiceover && !hasPerSceneAudio) {
    const result = await generateVoiceoverImpl(ctx);
    if (result.validation_failed) throw new Error(String(result.message ?? "Voiceover validation failed."));
  }

  const images = readJsonArtifact<JsonDict[]>(ctx, "images", []) ?? [];
  if (images.length === 0) {
    await generateSceneImagesImpl(ctx);
  }

  const videos = readJsonArtifact<JsonDict[]>(ctx, "videos", []) ?? [];
  if (videos.length === 0) {
    await animateSceneVideosImpl(ctx);
  }

  const nextVideos = readJsonArtifact<JsonDict[]>(ctx, "videos", []) ?? [];
  if (nextVideos.length === 0) {
    throw new Error("Accepted plan rendered no scene videos; inspect provider errors before retrying.");
  }
  await stitchFinalVideoImpl(ctx, tokenOutput);
}

export async function runProject(projectId: string, request: CreateProjectRequest): Promise<void> {
  rememberProjectRuntimeCredentials(projectId, runtimeCredentialsFromRequest(request));
  const ctx = context(projectId, request);
  ensureProjectState(ctx, request);

  try {
    const routing = classifyMagicHourRequest(request);
    if (routing.needs_clarification) {
      const manifest = requestClarificationImpl(
        ctx,
        routing.questions,
        "The request is missing the minimum details needed to choose a Magic Hour capability.",
      );
      await updateProjectStatus(projectId, {
        status: "succeeded",
        stage: "needs_input",
        progress: 0,
        message: routing.questions[0] ?? "Magic Agent needs more information.",
        manifest,
      });
      return;
    }

    const plannedCapability = unsupportedPlannedCapability(routing.capability_id);
    if (plannedCapability) {
      const manifest = requestClarificationImpl(
        ctx,
        [
          `I can route this to ${plannedCapability.sdk_resource}, but this backend wrapper is not implemented yet. Add that tool wrapper before rendering this operation.`,
        ],
        "The selected Magic Hour capability is recognized but not safely wired into this backend yet.",
      );
      await updateProjectStatus(projectId, {
        status: "succeeded",
        stage: "needs_input",
        progress: 0,
        message: String((manifest.questions ?? [])[0] ?? "Magic Agent needs a supported tool wrapper."),
        manifest,
      });
      return;
    }

    await updateProjectStatus(projectId, {
      status: "running",
      stage: "planning",
      progress: 10,
      message: "Planning the timed script and scene continuity.",
    });

    const agent = projectAgentForRequest(request);
    const brief = buildProjectRunBrief(request, ctx);
    const runtime = resolveAgentRuntime(request);
    updateProjectState(ctx, {
      provider_settings: {
        agent_provider: runtime.provider,
        agent_model: runtime.model,
        agent_intensity: runtime.intensity,
        agent_runtime: agentRuntimeStatus(runtime),
      },
    });
    const { usage, manifestExists } = await runAgentUntilManifest(agent, brief, ctx, runAgentStreamed, {
      maxAttempts: MAX_MANIFEST_ATTEMPTS,
      onRetry: async (nextAttempt) => {
        await updateProjectStatus(projectId, {
          status: "running",
          stage: "planning",
          progress: 10,
          message: `Agent produced no video yet; retrying (attempt ${nextAttempt}).`,
        });
      },
    });
    const tokenOutput = writeTokenOutput(ctx, usage, runtime.model, runtime.provider);
    if (!manifestExists) {
      if (request.workflow === "youtube_clips") {
        updateProjectState(ctx, {
          decision: {
            tool: "run_project",
            decision: "Agent ended without a YouTube manifest; running the deterministic YouTube workflow.",
            metadata: { provider_rerendered: false },
          },
        });
        await createYoutubeShortFromPromptImpl(ctx);
      } else if (existsSync(artifactPath(ctx, "plan"))) {
        await completeAcceptedVideoPlan(ctx, tokenOutput);
      } else {
        const state = readProjectState(ctx);
        const draftValidationFailures = (state.decisions ?? []).filter(
          (decision: JsonDict) => decision.tool === "draft_video_plan" && decision.metadata?.validation_failed === true,
        );
        if (draftValidationFailures.length === 0) {
          throw new Error("Agent completed without a persisted plan or manifest. Stopping before provider fallback.");
        }
        const fallbackResult = await draftFallbackVideoPlanImpl(ctx);
        if (fallbackResult.validation_failed) {
          throw new Error(`Fallback video plan failed validation: ${String((fallbackResult.issues ?? []).join(" "))}`);
        }
        await completeAcceptedVideoPlan(ctx, tokenOutput);
      }
    }
    const manifest = mergeTokenOutputIntoManifest(ctx, tokenOutput);
    const failedCount = Number(manifest.failed_scene_count ?? 0);
    const manifestWorkflow = String(manifest.workflow ?? "");
    const completeMessage =
      manifestWorkflow === "standalone_image"
        ? "Image is ready."
        : manifestWorkflow === "clarification"
          ? String((manifest.questions ?? [])[0] ?? "Magic Agent needs more information.")
          : failedCount === 0
            ? "Video is ready."
            : `Partial video is ready with ${failedCount} failed scene(s).`;
    await updateProjectStatus(projectId, {
      status: "succeeded",
      stage: manifestWorkflow === "clarification" ? "needs_input" : "complete",
      progress: manifestWorkflow === "clarification" ? 0 : 100,
      message: completeMessage,
      manifest,
    });
  } catch (exc: any) {
    console.error("Project generation failed", exc);
    const manifest = readJsonArtifact<JsonDict>(ctx, "manifest", null);
    const state = readProjectState(ctx);
    const draftValidationFailures = (state.decisions ?? []).filter(
      (decision: JsonDict) => decision.tool === "draft_video_plan" && decision.metadata?.validation_failed === true,
    );
    const visualProviderArtifactsStarted =
      existsSync(artifactPath(ctx, "images")) ||
      existsSync(artifactPath(ctx, "videos")) ||
      existsSync(artifactPath(ctx, "manifest"));
    const voiceoverValidationFailed = String(state.status?.stage ?? "") === "voiceover_validation_failed";
    if (!manifest && (draftValidationFailures.length > 0 || voiceoverValidationFailed) && !visualProviderArtifactsStarted) {
      try {
        const fallbackTokenOutput = pendingTokenOutputForContext(ctx);
        const fallbackResult = await draftFallbackVideoPlanImpl(ctx);
        if (fallbackResult.validation_failed) {
          throw new Error(`Fallback video plan failed validation: ${String((fallbackResult.issues ?? []).join(" "))}`);
        }
        await completeAcceptedVideoPlan(ctx, fallbackTokenOutput);
        const fallbackManifest = mergeTokenOutputIntoManifest(ctx, fallbackTokenOutput);
        await updateProjectStatus(projectId, {
          status: "succeeded",
          stage: "complete",
          progress: 100,
          message: "Video is ready.",
          manifest: fallbackManifest,
        });
        return;
      } catch (fallbackErr) {
        updateProjectState(ctx, {
          decision: {
            tool: "run_project",
            decision: "Deterministic fallback plan failed after draft validation failure.",
            metadata: {
              original_error: String(exc?.message ?? exc),
              fallback_error: String((fallbackErr as Error)?.message ?? fallbackErr),
            },
          },
        });
      }
    }
    if (typeof manifest === "object" && manifest !== null) {
      const finalVideoPath = typeof manifest.final_video_path === "string" ? manifest.final_video_path : "";
      if (finalVideoPath && existsSync(finalVideoPath)) {
        updateProjectState(ctx, {
          decision: {
            tool: "run_project",
            decision: "Preserved completed manifest after the outer agent errored.",
            metadata: { error: String(exc?.message ?? exc), final_video_path: finalVideoPath },
          },
        });
        await updateProjectStatus(projectId, {
          status: "succeeded",
          stage: "complete",
          progress: 100,
          message: "Video is ready.",
          manifest,
        });
        return;
      }
      const repaired = terminalYoutubeStatusFromManifest(projectId, manifest);
      if (repaired !== null) {
        updateProjectState(ctx, {
          decision: {
            tool: "run_project",
            decision: "Preserved completed YouTube manifest after the outer agent errored.",
            metadata: { error: String(exc?.message ?? exc) },
          },
        });
        await updateProjectStatus(projectId, {
          status: "succeeded",
          stage: "complete",
          progress: 100,
          message: repaired.message,
          manifest,
        });
        return;
      }
    }
    const current = PROJECTS.get(projectId) ?? {};
    const failure = generationFailureStatus(exc, state, current);
    await updateProjectStatus(projectId, {
      status: "failed",
      stage: failure.stage,
      progress: Number(current.progress ?? 0),
      message: failure.message,
      error: failure.error,
    });
  }
}

export async function runProjectMessage(
  projectId: string,
  message: string,
  credentials: Partial<RuntimeCredentials> = {},
): Promise<void> {
  rememberProjectRuntimeCredentials(projectId, credentials);
  const ctx = contextForExistingProject(projectId);
  const previousStatus = readProjectStatus(projectId) ?? {};
  const previousManifest = previousStatus.manifest;

  try {
    await updateProjectStatus(projectId, {
      status: "running",
      stage: "message_running",
      progress: 25,
      message: "Agent is handling the project message.",
      manifest: previousManifest,
    });
    const brief = buildProjectMessageBrief(message, ctx, readProjectStatus(projectId));
    const runtime = runtimeFromContext(ctx);
    const { finalOutput, usage } = await runAgentStreamed(projectMessageAgentForContext(ctx), brief, ctx, runtime);
    const tokenOutput = writeTokenOutput(ctx, usage, runtime.model, runtime.provider);
    const manifest = existsSync(artifactPath(ctx, "manifest"))
      ? mergeTokenOutputIntoManifest(ctx, tokenOutput)
      : null;
    const responseText = agentResponseContent(finalOutput);
    appendProjectMessage(ctx, {
      role: "assistant",
      content: responseText,
      metadata: {
        model: runtime.model,
        provider: runtime.provider,
        token_output_path: tokenOutput.token_output_path,
      },
    });
    await updateProjectStatus(projectId, {
      status: "succeeded",
      stage: "message_complete",
      progress: 100,
      message: responseText.slice(0, 240),
      manifest,
    });
  } catch (exc: any) {
    console.error("Project message handling failed", exc);
    appendProjectMessage(ctx, {
      role: "assistant",
      content: `Agent turn failed: ${exc?.message ?? exc}`,
      metadata: { error: String(exc?.message ?? exc) },
    });
    const current = PROJECTS.get(projectId) ?? {};
    await updateProjectStatus(projectId, {
      status: "failed",
      stage: "message_failed",
      progress: Number(current.progress ?? 0),
      message: "Project message failed.",
      error: String(exc?.message ?? exc),
      manifest: previousManifest,
    });
  }
}

export async function queueProject(
  request: CreateProjectRequest,
  options: { start?: boolean } = {},
): Promise<JsonDict> {
  const { start = true } = options;
  const projectId = newId();
  rememberProjectRuntimeCredentials(projectId, runtimeCredentialsFromRequest(request));
  initializeProjectState(context(projectId, request), request);
  const payload = await updateProjectStatus(projectId, {
    status: "queued",
    stage: "queued",
    progress: 0,
    message: "Project queued locally.",
  });
  if (start) {
    scheduleProjectRun(projectId, request);
  }
  return payload;
}

export async function queueYoutubeReviewSession(
  request: YouTubeReviewSessionRequest,
  options: { metadata?: JsonDict | null; start_projects?: boolean } = {},
): Promise<JsonDict> {
  const { metadata = null, start_projects: startProjects = true } = options;
  const reviewId = newId();
  const now = new Date().toISOString();
  const providers: JsonDict = {};

  for (const provider of YOUTUBE_REVIEW_PROVIDERS_ACTIVE) {
    const projectRequest = youtubeReviewProjectRequest(request, provider);
    const projectPayload = await queueProject(projectRequest, { start: startProjects });
    providers[provider] = {
      provider,
      project_id: projectPayload.project_id,
      status_url: projectPayload.status_url,
      started_at: now,
      comments: "",
      comments_updated_at: null,
    };
  }

  const payload: JsonDict = {
    review_id: reviewId,
    prompt: request.prompt,
    created_at: now,
    updated_at: now,
    settings: {
      duration_seconds: request.duration_seconds ?? null,
      scene_count: request.scene_count ?? null,
      aspect_ratio: request.aspect_ratio,
      resolution: request.resolution,
    },
    metadata: metadata ?? {},
    providers,
  };
  writeYoutubeReviewSession(payload);
  return payload;
}

export async function runYoutubeReviewBatch(batchId: string): Promise<void> {
  try {
    const payload = readYoutubeReviewBatch(batchId);
    if (payload === null) {
      console.warn(`Review batch disappeared before it could run: ${batchId}`);
      return;
    }

    for (const item of (payload.items ?? []) as JsonDict[]) {
      const reviewPayload = readYoutubeReviewSession(String(item.review_id));
      if (reviewPayload === null) {
        console.warn(`Review session disappeared before batch run: ${item.review_id}`);
        continue;
      }
      const settings = reviewPayload.settings ?? {};
      const request = YouTubeReviewSessionRequestSchema.parse({
        prompt: String(reviewPayload.prompt),
        duration_seconds: settings.duration_seconds ?? null,
        scene_count: settings.scene_count ?? null,
        aspect_ratio: settings.aspect_ratio ?? "9:16",
        resolution: settings.resolution ?? "720p",
      });
      for (const provider of YOUTUBE_REVIEW_PROVIDERS_ACTIVE) {
        const providerPayload = (reviewPayload.providers ?? {})[provider];
        if (typeof providerPayload !== "object" || providerPayload === null) continue;
        const projectId = String(providerPayload.project_id);
        const currentStatus = readProjectStatus(projectId);
        if (currentStatus !== null && ["running", "succeeded", "failed"].includes(currentStatus.status)) {
          continue;
        }
        await runProject(projectId, youtubeReviewProjectRequest(request, provider));
      }
    }
  } finally {
    RUNNING_YOUTUBE_REVIEW_BATCHES.delete(batchId);
  }
}

export function reviewBatchHasQueuedProjects(payload: JsonDict): boolean {
  for (const item of (payload.items ?? []) as JsonDict[]) {
    const reviewPayload = readYoutubeReviewSession(String(item.review_id));
    if (reviewPayload === null) continue;
    for (const providerPayload of Object.values((reviewPayload.providers ?? {}) as JsonDict)) {
      if (typeof providerPayload !== "object" || providerPayload === null) continue;
      const status = readProjectStatus(String((providerPayload as JsonDict).project_id));
      if (status !== null && status.status === "queued") return true;
    }
  }
  return false;
}

export function startYoutubeReviewBatchWorker(batchId: string): void {
  if (RUNNING_YOUTUBE_REVIEW_BATCHES.has(batchId)) return;
  RUNNING_YOUTUBE_REVIEW_BATCHES.add(batchId);
  void runYoutubeReviewBatch(batchId);
}

export { newId };
