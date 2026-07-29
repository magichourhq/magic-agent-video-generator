"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { API_BASE } from "@/lib/api";
import type { ProjectActivityEvent } from "@/lib/types";

const MAX_EVENTS = 400;

/**
 * Streams live agent activity over SSE. Status events also invalidate the
 * project query so the manifest refreshes instantly instead of on a poll tick.
 */
export function useProjectEvents(projectId: string | null) {
  const queryClient = useQueryClient();
  const [events, setEvents] = useState<ProjectActivityEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const seenIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    setEvents([]);
    seenIds.current = new Set();
    if (!projectId) return;

    const source = new EventSource(`${API_BASE}/api/projects/${projectId}/events`);

    const push = (raw: MessageEvent) => {
      let event: ProjectActivityEvent;
      try {
        event = JSON.parse(raw.data) as ProjectActivityEvent;
      } catch {
        return;
      }
      if (event.id) {
        if (seenIds.current.has(event.id)) return;
        seenIds.current.add(event.id);
      }
      setEvents((prev) => {
        const next = [...prev, event];
        return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
      });
      if (event.type === "status") {
        queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      }
    };

    source.addEventListener("status", push);
    source.addEventListener("agent_event", push);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);

    return () => {
      source.close();
      setConnected(false);
    };
  }, [projectId, queryClient]);

  return { events, connected };
}
