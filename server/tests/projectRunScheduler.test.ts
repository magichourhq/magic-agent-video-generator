import { describe, expect, it } from "vitest";
import { ProjectRunScheduler } from "../src/projectRunScheduler.js";

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ProjectRunScheduler", () => {
  it("runs up to the limit and keeps later jobs queued until a slot opens", async () => {
    const scheduler = new ProjectRunScheduler(2);
    const started: string[] = [];
    const queued: string[] = [];
    const resolvers = new Map<string, () => void>();

    for (const projectId of ["a", "b", "c"]) {
      scheduler.enqueue({
        projectId,
        onStart: () => {
          started.push(projectId);
        },
        onQueued: () => {
          queued.push(projectId);
        },
        run: () =>
          new Promise<void>((resolve) => {
            resolvers.set(projectId, resolve);
          }),
      });
    }

    await tick();
    expect(started).toEqual(["a", "b"]);
    expect(queued).toEqual(["c"]);
    expect(scheduler.snapshot()).toMatchObject({ active: 2, queued: 1, limit: 2 });

    resolvers.get("a")?.();
    await tick();
    expect(started).toEqual(["a", "b", "c"]);
    expect(scheduler.snapshot()).toMatchObject({ active: 2, queued: 0, limit: 2 });

    resolvers.get("b")?.();
    resolvers.get("c")?.();
    await tick();
    expect(scheduler.snapshot()).toMatchObject({ active: 0, queued: 0, limit: 2 });
  });

  it("supports five parallel project runs and queues the sixth", async () => {
    const scheduler = new ProjectRunScheduler(5);
    const started: string[] = [];
    const queued: string[] = [];
    const resolvers = new Map<string, () => void>();

    for (const projectId of ["a", "b", "c", "d", "e", "f"]) {
      scheduler.enqueue({
        projectId,
        onStart: () => {
          started.push(projectId);
        },
        onQueued: () => {
          queued.push(projectId);
        },
        run: () =>
          new Promise<void>((resolve) => {
            resolvers.set(projectId, resolve);
          }),
      });
    }

    await tick();
    expect(started).toEqual(["a", "b", "c", "d", "e"]);
    expect(queued).toEqual(["f"]);
    expect(scheduler.snapshot()).toMatchObject({ active: 5, queued: 1, limit: 5 });

    resolvers.get("a")?.();
    await tick();
    expect(started).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(scheduler.snapshot()).toMatchObject({ active: 5, queued: 0, limit: 5 });

    for (const projectId of ["b", "c", "d", "e", "f"]) resolvers.get(projectId)?.();
    await tick();
    expect(scheduler.snapshot()).toMatchObject({ active: 0, queued: 0, limit: 5 });
  });
});

