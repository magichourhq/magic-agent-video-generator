import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

export interface ProjectEvent {
  id: string;
  type: string;
  project_id: string;
  created_at: string;
  [key: string]: any;
}

const MAX_BUFFERED_EVENTS = 500;

// Per-project live event feed for the frontend. Events are buffered in memory
// so an SSE client that connects mid-run still sees the full activity history.
class ProjectEventBus extends EventEmitter {
  private buffers = new Map<string, ProjectEvent[]>();

  emitProjectEvent(projectId: string, event: Omit<ProjectEvent, "id" | "project_id" | "created_at">): ProjectEvent {
    const payload: ProjectEvent = {
      ...event,
      id: randomUUID(),
      type: event.type,
      project_id: projectId,
      created_at: new Date().toISOString(),
    };
    const buffer = this.buffers.get(projectId) ?? [];
    buffer.push(payload);
    if (buffer.length > MAX_BUFFERED_EVENTS) buffer.splice(0, buffer.length - MAX_BUFFERED_EVENTS);
    this.buffers.set(projectId, buffer);
    this.emit(`project:${projectId}`, payload);
    return payload;
  }

  bufferedEvents(projectId: string): ProjectEvent[] {
    return [...(this.buffers.get(projectId) ?? [])];
  }

  subscribe(projectId: string, listener: (event: ProjectEvent) => void): () => void {
    const channel = `project:${projectId}`;
    this.on(channel, listener);
    return () => this.off(channel, listener);
  }
}

export const projectEvents = new ProjectEventBus();
projectEvents.setMaxListeners(100);
