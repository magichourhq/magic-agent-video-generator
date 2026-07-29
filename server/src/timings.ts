import { randomUUID } from "node:crypto";
import type { ProjectContext } from "./context.js";
import { readJsonArtifact, writeJsonArtifact, type JsonDict } from "./renderState.js";

export type TimingPhase = "start" | "end" | "error" | "event";

export interface TimingEvent extends JsonDict {
  id: string;
  span_id?: string;
  phase: TimingPhase;
  name: string;
  created_at: string;
  duration_ms?: number;
  scene_id?: string;
  provider_job_id?: string;
  provider_kind?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function cleanMetadata(metadata: JsonDict | null | undefined): JsonDict | undefined {
  if (!metadata) return undefined;
  const cleaned: JsonDict = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined) continue;
    if (typeof value === "string") {
      cleaned[key] = value.length > 500 ? `${value.slice(0, 500)}...` : value;
    } else {
      cleaned[key] = value;
    }
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

export function readTimingEvents(ctx: ProjectContext): TimingEvent[] {
  return readJsonArtifact<TimingEvent[]>(ctx, "timings", []) ?? [];
}

export function recordTimingEvent(
  ctx: ProjectContext,
  event: Omit<TimingEvent, "id" | "created_at"> & { metadata?: JsonDict | null },
): TimingEvent {
  const payload = {
    ...event,
    id: randomUUID(),
    created_at: nowIso(),
  } as TimingEvent;
  const metadata = cleanMetadata(event.metadata);
  if (metadata) payload.metadata = metadata;
  else delete payload.metadata;
  writeJsonArtifact(ctx, "timings", [...readTimingEvents(ctx), payload]);
  return payload;
}

export async function withTiming<T>(
  ctx: ProjectContext,
  name: string,
  metadata: JsonDict | null | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const spanId = randomUUID();
  const started = Date.now();
  recordTimingEvent(ctx, { phase: "start", name, span_id: spanId, metadata });
  try {
    const result = await fn();
    recordTimingEvent(ctx, {
      phase: "end",
      name,
      span_id: spanId,
      duration_ms: Date.now() - started,
      metadata,
    });
    return result;
  } catch (err) {
    recordTimingEvent(ctx, {
      phase: "error",
      name,
      span_id: spanId,
      duration_ms: Date.now() - started,
      metadata: {
        ...metadata,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }
}

export function summarizeTimingEvents(events: TimingEvent[]): JsonDict {
  const spans = new Map<string, { name: string; started_at?: string; duration_ms?: number; metadata?: JsonDict }>();
  for (const event of events) {
    if (!event.span_id) continue;
    const current = spans.get(event.span_id) ?? { name: event.name };
    if (event.phase === "start") {
      current.started_at = event.created_at;
      current.metadata = event.metadata;
    } else if ((event.phase === "end" || event.phase === "error") && typeof event.duration_ms === "number") {
      current.duration_ms = event.duration_ms;
      current.metadata = event.metadata ?? current.metadata;
    }
    spans.set(event.span_id, current);
  }
  const completed = [...spans.values()].filter((span) => typeof span.duration_ms === "number");
  const byName: JsonDict = {};
  for (const span of completed) {
    const item = (byName[span.name] ??= { count: 0, total_ms: 0, max_ms: 0 });
    const duration = span.duration_ms ?? 0;
    item.count += 1;
    item.total_ms += duration;
    item.max_ms = Math.max(item.max_ms, duration);
  }
  for (const value of Object.values(byName) as JsonDict[]) {
    value.avg_ms = value.count > 0 ? Math.round(value.total_ms / value.count) : 0;
  }
  return {
    event_count: events.length,
    completed_span_count: completed.length,
    by_name: byName,
  };
}

