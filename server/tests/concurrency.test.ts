import { describe, expect, it } from "vitest";
import { AsyncLimiter } from "../src/concurrency.js";

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("AsyncLimiter", () => {
  it("runs up to the configured limit and queues later provider calls", async () => {
    const limiter = new AsyncLimiter("test-provider", 2);
    const started: string[] = [];
    const resolvers = new Map<string, () => void>();

    const run = (label: string) =>
      limiter.run(label, () =>
        new Promise<string>((resolve) => {
          started.push(label);
          resolvers.set(label, () => resolve(label));
        }),
      );

    const tasks = [run("a"), run("b"), run("c")];
    await tick();

    expect(started).toEqual(["a", "b"]);
    expect(limiter.snapshot()).toMatchObject({ active: 2, queued: 1, limit: 2, queued_labels: ["c"] });

    resolvers.get("a")?.();
    await tick();
    expect(started).toEqual(["a", "b", "c"]);
    expect(limiter.snapshot()).toMatchObject({ active: 2, queued: 0, limit: 2 });

    resolvers.get("b")?.();
    resolvers.get("c")?.();
    await expect(Promise.all(tasks)).resolves.toEqual(["a", "b", "c"]);
    expect(limiter.snapshot()).toMatchObject({ active: 0, queued: 0, limit: 2 });
  });
});

