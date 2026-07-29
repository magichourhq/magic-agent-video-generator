import { mkdirSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectContext } from "../src/context.js";
import { PROJECT_CONTEXT_DEFAULTS } from "../src/context.js";
import { CreateProjectRequestSchema } from "../src/schemas.js";

const runMock = vi.hoisted(() => vi.fn());

vi.mock("@openai/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openai/agents")>();
  return {
    ...actual,
    run: runMock,
    Runner: class {
      run = runMock;
    },
  };
});

const { draftYoutubeScriptImpl, youtubeScriptResultUsedWebSearch } = await import("../src/agents.js");

function scriptOutput() {
  return {
    title: "Latest OpenAI and SpaceX updates",
    web_search_needed: true,
    web_search_reason: "The prompt asks for current product and company updates.",
    sections: [
      {
        section: 1,
        dialogue: "OpenAI and SpaceX both have fast-moving updates worth grounding in current sources.",
        search_hint: "latest OpenAI SpaceX update official news",
        duration_seconds: 5,
      },
    ],
  };
}

function webSearchRunItem() {
  return {
    type: "hosted_tool_call",
    rawItem: {
      type: "hosted_tool_call",
      name: "web_search",
      providerData: { type: "web_search_call", status: "completed" },
    },
  };
}

function testContext(): ProjectContext {
  const projectDir = path.join(tmpdir(), `youtube-script-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(projectDir, { recursive: true });
  return {
    project_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    project_dir: projectDir,
    aspect_ratio: "9:16",
    resolution: "720p",
    ...PROJECT_CONTEXT_DEFAULTS,
  };
}

afterEach(() => {
  runMock.mockReset();
});

describe("youtubeScriptResultUsedWebSearch", () => {
  it("detects hosted web search calls recorded in providerData", () => {
    expect(youtubeScriptResultUsedWebSearch({ newItems: [webSearchRunItem()] })).toBe(true);
  });
});

describe("draftYoutubeScriptImpl", () => {
  it("reruns with forced web_search when the planner says search was needed but did not call it", async () => {
    runMock
      .mockResolvedValueOnce({
        finalOutput: scriptOutput(),
        newItems: [],
        runContext: { usage: {} },
      })
      .mockResolvedValueOnce({
        finalOutput: scriptOutput(),
        newItems: [webSearchRunItem()],
        runContext: { usage: {} },
      });

    const request = CreateProjectRequestSchema.parse({
      prompt: "latest stuff on OpenAI and SpaceX",
      workflow: "youtube_clips",
      runtime_credentials: { openai_api_key: "test-openai-key" },
    });

    const plan = await draftYoutubeScriptImpl(testContext(), request);

    expect(plan.web_search_needed).toBe(true);
    expect(runMock).toHaveBeenCalledTimes(2);
    expect(runMock.mock.calls[1]?.[0]?.modelSettings?.toolChoice).toBe("web_search");
  });
});

