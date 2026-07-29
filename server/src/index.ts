import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { ENV, OUTPUT_DIR, YOUTUBE_REVIEW_PROMPT_SET_PATH } from "./config.js";
import { providerConcurrencySnapshot } from "./concurrency.js";
import { fetchOpenRouterModels } from "./agentRuntime.js";
import { projectEvents } from "./events.js";
import { classifyMagicHourRequest, unsupportedPlannedCapability } from "./magicHourCapabilities.js";
import { contextForExistingProject } from "./projectContext.js";
import {
  HttpError,
  PROJECTS,
  assertProjectContextReady,
  assertRuntimeReady,
  latestYoutubeReviewBatch,
  listProjectStatuses,
  missingConfiguration,
  missingSystemDependencies,
  readProjectStatus,
  readYoutubeReviewBatch,
  readYoutubeReviewSession,
  writeYoutubeReviewBatch,
  writeYoutubeReviewSession,
  youtubeReviewBatchResponse,
  youtubeReviewSessionResponse,
  loadYoutubeReviewPromptSet,
} from "./projects.js";
import { appendProjectMessage, readProjectState } from "./renderState.js";
import type { JsonDict } from "./renderState.js";
import { rememberProjectRuntimeCredentials, runtimeCredentialsFromRequest } from "./runtimeCredentials.js";
import { storeInputMedia } from "./inputMedia.js";
import {
  newId,
  projectRunSchedulerStatus,
  queueProject,
  queueYoutubeReviewSession,
  reviewBatchHasQueuedProjects,
  runProjectMessage,
  startYoutubeReviewBatchWorker,
} from "./runners.js";
import {
  CreateProjectRequestSchema,
  ProjectMessageRequestSchema,
  ProjectTimelineEditRequestSchema,
  YouTubeReviewCommentRequestSchema,
  YouTubeReviewSessionRequestSchema,
} from "./schemas.js";
import {
  inspectTimelineImpl,
  moveTimelineClipImpl,
  setFinalHoldImpl,
  trimTimelineClipImpl,
} from "./workflows.js";

const app = Fastify({ logger: true, bodyLimit: 32 * 1024 * 1024 });

for (const contentType of [/^image\//, /^audio\//]) {
  app.addContentTypeParser(contentType, { parseAs: "buffer", bodyLimit: 30 * 1024 * 1024 }, (_request, body, done) => {
    done(null, body);
  });
}

await app.register(cors, {
  origin: ["http://localhost:3000", "http://127.0.0.1:3000", "http://0.0.0.0:3000"],
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
});

await app.register(fastifyStatic, {
  root: OUTPUT_DIR,
  prefix: "/media/",
  decorateReply: true,
});

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof HttpError) {
    reply.status(error.statusCode).send({ detail: error.detail });
    return;
  }
  app.log.error(error);
  reply.status(500).send({ detail: String((error as Error)?.message ?? error) });
});

function notFound(detail: string): never {
  throw new HttpError(404, detail);
}

app.get("/api/health", async () => {
  const missingConfig = missingConfiguration();
  const missingDependencies = missingSystemDependencies();
  return {
    status: missingConfig.length === 0 && missingDependencies.length === 0 ? "ok" : "missing_config",
    output_dir: OUTPUT_DIR,
    missing_config: missingConfig,
    missing_dependencies: missingDependencies,
    active_projects: [...PROJECTS.values()].filter((project) => ["queued", "running"].includes(project.status)).length,
    project_run_scheduler: projectRunSchedulerStatus(),
    provider_concurrency: providerConcurrencySnapshot(),
  };
});

app.get("/api/projects", async (request) => {
  const query = typeof request.query === "object" && request.query !== null ? (request.query as JsonDict) : {};
  const limit = Number.parseInt(String(query.limit ?? "100"), 10);
  return { projects: listProjectStatuses({ limit }) };
});

app.post("/api/projects", async (request, reply) => {
  const body = CreateProjectRequestSchema.parse(request.body);
  const routing = classifyMagicHourRequest(body);
  if (!routing.needs_clarification && !unsupportedPlannedCapability(routing.capability_id)) {
    assertRuntimeReady(body);
  }
  reply.status(202);
  return queueProject(body);
});

app.post("/api/input-media", async (request) => {
  const body = request.body;
  if (!Buffer.isBuffer(body)) throw new HttpError(400, "Upload an image or audio file as the request body.");
  const rawName = String(request.headers["x-file-name"] ?? "upload");
  let name = rawName;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    // Keep the safe basename cleanup in storeInputMedia as the fallback.
  }
  return storeInputMedia(body, name, String(request.headers["content-type"] ?? "application/octet-stream"));
});

app.post("/api/providers/openrouter/models", async (request) => {
  const body = typeof request.body === "object" && request.body !== null ? (request.body as JsonDict) : {};
  const models = await fetchOpenRouterModels(typeof body.api_key === "string" ? body.api_key : null);
  return { models };
});

app.post("/api/youtube-review-sessions", async (request, reply) => {
  assertRuntimeReady();
  const body = YouTubeReviewSessionRequestSchema.parse(request.body);
  const payload = await queueYoutubeReviewSession(body);
  reply.status(202);
  return youtubeReviewSessionResponse(payload);
});

app.post("/api/youtube-review-batches", async (_request, reply) => {
  assertRuntimeReady();
  let promptEntries;
  try {
    promptEntries = loadYoutubeReviewPromptSet();
  } catch (exc: any) {
    throw new HttpError(500, `Could not load review prompt set: ${exc?.message ?? exc}`);
  }

  const batchId = newId();
  const now = new Date().toISOString();
  const items: JsonDict[] = [];

  for (const entry of promptEntries) {
    const entryRequest = entry.request;
    const metadata = {
      prompt_id: entry.prompt_id,
      name: entry.name,
      category: entry.category,
      batch_id: batchId,
    };
    const reviewPayload = await queueYoutubeReviewSession(entryRequest, { metadata, start_projects: false });
    items.push({
      prompt_id: entry.prompt_id,
      name: entry.name,
      category: entry.category,
      prompt: entryRequest.prompt,
      settings: {
        duration_seconds: entryRequest.duration_seconds ?? null,
        scene_count: entryRequest.scene_count ?? null,
        aspect_ratio: entryRequest.aspect_ratio,
        resolution: entryRequest.resolution,
      },
      review_id: reviewPayload.review_id,
    });
  }

  const payload = {
    batch_id: batchId,
    prompt_set_path: YOUTUBE_REVIEW_PROMPT_SET_PATH,
    created_at: now,
    updated_at: now,
    items,
  };
  writeYoutubeReviewBatch(payload);
  startYoutubeReviewBatchWorker(batchId);
  reply.status(202);
  return youtubeReviewBatchResponse(payload);
});

app.get("/api/youtube-review-batches/latest", async () => {
  const payload = latestYoutubeReviewBatch();
  if (payload === null) notFound("Review batch not found");
  if (reviewBatchHasQueuedProjects(payload)) {
    startYoutubeReviewBatchWorker(String(payload.batch_id));
  }
  return youtubeReviewBatchResponse(payload);
});

app.get<{ Params: { batchId: string } }>("/api/youtube-review-batches/:batchId", async (request) => {
  let payload: JsonDict | null;
  try {
    payload = readYoutubeReviewBatch(request.params.batchId);
  } catch {
    notFound("Review batch not found");
  }
  if (payload === null) notFound("Review batch not found");
  if (reviewBatchHasQueuedProjects(payload)) {
    startYoutubeReviewBatchWorker(request.params.batchId);
  }
  return youtubeReviewBatchResponse(payload);
});

app.get<{ Params: { reviewId: string } }>("/api/youtube-review-sessions/:reviewId", async (request) => {
  let payload: JsonDict | null;
  try {
    payload = readYoutubeReviewSession(request.params.reviewId);
  } catch {
    notFound("Review session not found");
  }
  if (payload === null) notFound("Review session not found");
  return youtubeReviewSessionResponse(payload);
});

app.post<{ Params: { reviewId: string } }>("/api/youtube-review-sessions/:reviewId/comments", async (request) => {
  const body = YouTubeReviewCommentRequestSchema.parse(request.body);
  let payload: JsonDict | null;
  try {
    payload = readYoutubeReviewSession(request.params.reviewId);
  } catch {
    notFound("Review session not found");
  }
  if (payload === null) notFound("Review session not found");

  const providerPayload = (payload.providers ?? {})[body.provider];
  if (typeof providerPayload !== "object" || providerPayload === null) {
    notFound("Review provider not found");
  }

  providerPayload.comments = body.comments;
  providerPayload.comments_updated_at = new Date().toISOString();
  payload.updated_at = providerPayload.comments_updated_at;
  writeYoutubeReviewSession(payload);
  return youtubeReviewSessionResponse(payload);
});

app.post<{ Params: { projectId: string } }>("/api/projects/:projectId/messages", async (request, reply) => {
  const body = ProjectMessageRequestSchema.parse(request.body);
  let existingStatus: JsonDict | null;
  try {
    existingStatus = readProjectStatus(request.params.projectId);
  } catch {
    notFound("Project not found");
  }
  if (existingStatus === null) notFound("Project not found");

  rememberProjectRuntimeCredentials(request.params.projectId, runtimeCredentialsFromRequest(body));
  const ctx = contextForExistingProject(request.params.projectId);
  assertProjectContextReady(ctx);

  appendProjectMessage(ctx, { role: "user", content: body.message });
  const { updateProjectStatus } = await import("./projects.js");
  const payload = await updateProjectStatus(request.params.projectId, {
    status: "queued",
    stage: "message_queued",
    progress: Number(existingStatus.progress ?? 0),
    message: "Project message queued for the agent.",
    manifest: existingStatus.manifest,
  });
  payload.project_state = readProjectState(ctx);
  void runProjectMessage(request.params.projectId, body.message, runtimeCredentialsFromRequest(body));
  reply.status(202);
  return payload;
});

app.patch<{ Params: { projectId: string } }>("/api/projects/:projectId/timeline", async (request) => {
  let existingStatus: JsonDict | null;
  let ctx;
  try {
    existingStatus = readProjectStatus(request.params.projectId);
    ctx = contextForExistingProject(request.params.projectId);
  } catch {
    notFound("Project not found");
  }
  if (existingStatus === null) notFound("Project not found");

  const body = ProjectTimelineEditRequestSchema.parse(request.body);
  let timelineResult: JsonDict;
  switch (body.operation) {
    case "inspect":
      timelineResult = inspectTimelineImpl(ctx);
      break;
    case "trim_clip":
      timelineResult = trimTimelineClipImpl(ctx, body.clip_id, {
        source_start: body.source_start,
        source_end: body.source_end,
      });
      break;
    case "move_clip":
      timelineResult = moveTimelineClipImpl(ctx, body.clip_id, body.timeline_start);
      break;
    case "set_final_hold":
      timelineResult = setFinalHoldImpl(ctx, body.hold_seconds, body.reason);
      break;
    default:
      throw new HttpError(400, "Unsupported timeline operation");
  }

  const payload = {
    ...existingStatus,
    project_state: readProjectState(ctx),
    timeline: timelineResult.timeline,
    timeline_summary: timelineResult.summary,
  };
  return payload;
});

app.get<{ Params: { projectId: string } }>("/api/projects/:projectId", async (request) => {
  let status: JsonDict | null;
  try {
    status = readProjectStatus(request.params.projectId);
  } catch {
    notFound("Project not found");
  }
  if (status === null) notFound("Project not found");
  return status;
});

// Live activity feed: replays buffered project events, then streams new ones.
app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/events", async (request, reply) => {
  const projectId = request.params.projectId;
  try {
    readProjectStatus(projectId);
  } catch {
    notFound("Project not found");
  }

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": request.headers.origin ?? "*",
    "Access-Control-Allow-Credentials": "true",
  });
  reply.raw.write(":ok\n\n");

  const send = (event: JsonDict) => {
    reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };

  for (const event of projectEvents.bufferedEvents(projectId)) send(event);

  const unsubscribe = projectEvents.subscribe(projectId, send);
  const heartbeat = setInterval(() => {
    reply.raw.write(":heartbeat\n\n");
  }, 15_000);

  request.raw.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });

  await new Promise<void>((resolve) => {
    request.raw.on("close", resolve);
  });
});

const port = Number(ENV.SERVER_PORT ?? ENV.PORT ?? 8000);
const host = ENV.SERVER_HOST ?? "127.0.0.1";

app
  .listen({ port, host })
  .then(() => {
    console.info(`video-agent server listening on http://${host}:${port}`);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
