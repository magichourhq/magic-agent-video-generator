export type PlanIssueOwner = "planner" | "user_input";

export interface PlanReadinessIssue {
  code: string;
  scene_id: string | null;
  owner: PlanIssueOwner;
  safe_to_auto_repair: boolean;
  cost_tier: "free";
  message: string;
}

export interface PlanReadinessAction {
  kind: "revise_plan";
  tool: "draft_video_plan";
  owner: PlanIssueOwner;
  safe_to_auto_run: boolean;
  requires_provider_call: false;
  reason: string;
}

export interface PlanReadinessReport {
  stage: "plan_preflight";
  status: "ready" | "repair_required";
  provider_calls_allowed: boolean;
  repair_attempt: number;
  issues: PlanReadinessIssue[];
  warnings: PlanReadinessIssue[];
  next_actions: PlanReadinessAction[];
}

export function planIssueFamily(issue: string): string {
  if (/under-scripted|spoken words|narration|voiceover|speech|mid-thought/i.test(issue)) return "spoken_script";
  if (/opening state|closing state|continuity|geometry|fall|catch|landing|collision|screen direction|handoff|transfer/i.test(issue)) {
    return "physical_continuity";
  }
  if (/voice identity|voice continuity|speaker|voice changes/i.test(issue)) return "voice_identity";
  if (/audio mode|audio performance|pause|delivery|emotion/i.test(issue)) return "audio_performance";
  if (/duration|runtime|seconds|supported model value/i.test(issue)) return "runtime";
  if (/uploaded|reference_media_ids|image id|input media/i.test(issue)) return "input_media";
  if (/image|keyframe|visual|subject|object|split|collage|text-only|title card/i.test(issue)) return "visual_prompt";
  if (/creative_vibe|format|proof|payoff|cta|talking head|on-camera/i.test(issue)) return "creative_fit";
  if (/provider|model|resolution|aspect ratio|i2v|motion prompt/i.test(issue)) return "provider_contract";
  return issue.toLowerCase().replace(/\bscene_\d+\b/g, "scene").split(/[.:;]/, 1)[0]!.trim() || "plan_contract";
}

function issueOwner(issue: string): PlanIssueOwner {
  return /missing user|user must|ask the user|requires an uploaded|no uploaded/i.test(issue) ? "user_input" : "planner";
}

function readinessIssue(issue: string): PlanReadinessIssue {
  const owner = issueOwner(issue);
  return {
    code: planIssueFamily(issue),
    scene_id: issue.match(/\bscene_\d+\b/i)?.[0]?.toLowerCase() ?? null,
    owner,
    safe_to_auto_repair: owner === "planner",
    cost_tier: "free",
    message: issue,
  };
}

export function buildPlanReadinessReport(
  issues: string[],
  warnings: string[] = [],
  repairAttempt = 0,
): PlanReadinessReport {
  const structuredIssues = issues.map(readinessIssue);
  const structuredWarnings = warnings.map(readinessIssue);
  if (structuredIssues.length === 0) {
    return {
      stage: "plan_preflight",
      status: "ready",
      provider_calls_allowed: true,
      repair_attempt: repairAttempt,
      issues: [],
      warnings: structuredWarnings,
      next_actions: [],
    };
  }

  const requiresUser = structuredIssues.some((issue) => issue.owner === "user_input");
  return {
    stage: "plan_preflight",
    status: "repair_required",
    provider_calls_allowed: false,
    repair_attempt: repairAttempt,
    issues: structuredIssues,
    warnings: structuredWarnings,
    next_actions: [
      {
        kind: "revise_plan",
        tool: "draft_video_plan",
        owner: requiresUser ? "user_input" : "planner",
        safe_to_auto_run: !requiresUser,
        requires_provider_call: false,
        reason: requiresUser
          ? "Collect the missing user input before revising the plan."
          : "Revise only the reported plan fields, then rerun the free plan preflight.",
      },
    ],
  };
}
