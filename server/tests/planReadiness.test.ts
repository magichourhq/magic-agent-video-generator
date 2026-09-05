import { describe, expect, it } from "vitest";
import { buildPlanReadinessReport, planIssueFamily } from "../src/planReadiness.js";

describe("plan readiness reports", () => {
  it("marks a clean plan ready for provider calls", () => {
    const report = buildPlanReadinessReport([]);

    expect(report.status).toBe("ready");
    expect(report.provider_calls_allowed).toBe(true);
    expect(report.next_actions).toEqual([]);
  });

  it("returns a free planner-owned repair action for objective scene failures", () => {
    const report = buildPlanReadinessReport([
      "scene_2 opening state does not inherit enough physical state from scene_1's closing state.",
      "scene_3 narration contains visual/camera instructions.",
    ], [], 1);

    expect(report.status).toBe("repair_required");
    expect(report.provider_calls_allowed).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual(["physical_continuity", "spoken_script"]);
    expect(report.issues.map((issue) => issue.scene_id)).toEqual(["scene_2", "scene_3"]);
    expect(report.next_actions).toEqual([
      expect.objectContaining({
        tool: "draft_video_plan",
        owner: "planner",
        safe_to_auto_run: true,
        requires_provider_call: false,
      }),
    ]);
  });

  it("keeps issue families stable across differently worded repairs", () => {
    expect(planIssueFamily("scene_4 starts a fall without completing the landing.")).toBe("physical_continuity");
    expect(planIssueFamily("Narrated plan is under-scripted for 40 seconds.")).toBe("spoken_script");
    expect(planIssueFamily("Unknown uploaded image id product-front.")).toBe("input_media");
  });
});
