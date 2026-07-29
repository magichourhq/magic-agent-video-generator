import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectContext } from "../src/context.js";
import { runAgentUntilManifest } from "../src/runners.js";

// The helper only reads `ctx.project_dir` (for the existsSync manifest check),
// so a minimal ctx-like object with a real temp dir is enough to exercise it
// without touching the OpenAI/network path (runFn is injected).
let projectDir: string;
let ctx: ProjectContext;

beforeEach(() => {
  projectDir = mkdtempSync(path.join(tmpdir(), "runner-retry-"));
  ctx = { project_dir: projectDir } as unknown as ProjectContext;
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function writeManifest(): void {
  writeFileSync(path.join(projectDir, "manifest.json"), JSON.stringify({ ok: true }), "utf-8");
}

const fakeAgent = {} as any;
const brief = "make a video";

describe("runAgentUntilManifest", () => {
  it("defaults to one attempt so provider renders are not duplicated by an outer agent retry", async () => {
    const runFn = vi.fn(async () => ({ finalOutput: null, usage: { total: 1 } }));
    const onRetry = vi.fn();

    const result = await runAgentUntilManifest(fakeAgent, brief, ctx, runFn, { onRetry });

    expect(runFn).toHaveBeenCalledTimes(1);
    expect(result.attempts).toBe(1);
    expect(result.manifestExists).toBe(false);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("retries up to maxAttempts when the manifest is never produced", async () => {
    const runFn = vi.fn(async () => ({ finalOutput: null, usage: { total: 1 } }));
    const onRetry = vi.fn();

    const result = await runAgentUntilManifest(fakeAgent, brief, ctx, runFn, {
      maxAttempts: 3,
      onRetry,
    });

    expect(runFn).toHaveBeenCalledTimes(3);
    expect(result.attempts).toBe(3);
    expect(result.manifestExists).toBe(false);
    // onRetry fires between attempts only (2 retries for 3 attempts).
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("stops after the manifest appears on the 2nd attempt", async () => {
    let calls = 0;
    const runFn = vi.fn(async () => {
      calls += 1;
      if (calls === 2) writeManifest();
      return { finalOutput: null, usage: { attempt: calls } };
    });
    const onRetry = vi.fn();

    const result = await runAgentUntilManifest(fakeAgent, brief, ctx, runFn, {
      maxAttempts: 3,
      onRetry,
    });

    expect(runFn).toHaveBeenCalledTimes(2);
    expect(result.attempts).toBe(2);
    expect(result.manifestExists).toBe(true);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(result.usage).toEqual({ attempt: 2 });
  });

  it("runs once and does not retry when the manifest appears on the 1st attempt", async () => {
    const runFn = vi.fn(async () => {
      writeManifest();
      return { finalOutput: null, usage: { total: 7 } };
    });
    const onRetry = vi.fn();

    const result = await runAgentUntilManifest(fakeAgent, brief, ctx, runFn, {
      maxAttempts: 3,
      onRetry,
    });

    expect(runFn).toHaveBeenCalledTimes(1);
    expect(result.attempts).toBe(1);
    expect(result.manifestExists).toBe(true);
    expect(onRetry).not.toHaveBeenCalled();
  });
});

