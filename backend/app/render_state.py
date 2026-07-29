from __future__ import annotations

import json
from contextlib import suppress
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .tools import ProjectContext

PROJECT_STATE_VERSION = 1
_MISSING = object()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def artifact_path(ctx: ProjectContext, name: str) -> Path:
    filename = "manifest.json" if name == "manifest" else f"{name}.json"
    return ctx.project_dir / filename


def read_json_artifact(ctx: ProjectContext, name: str, default: Any = None) -> Any:
    path = artifact_path(ctx, name)
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def write_json_artifact(ctx: ProjectContext, name: str, payload: Any) -> Any:
    path = artifact_path(ctx, name)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return payload


def remove_json_artifact(ctx: ProjectContext, name: str) -> None:
    with suppress(FileNotFoundError):
        artifact_path(ctx, name).unlink()


def default_project_state(
    ctx: ProjectContext,
    *,
    user_preferences: dict[str, Any] | None = None,
    provider_settings: dict[str, Any] | None = None,
) -> dict[str, Any]:
    now = utc_now()
    return {
        "version": PROJECT_STATE_VERSION,
        "project_id": ctx.project_id,
        "created_at": now,
        "updated_at": now,
        "status": {
            "stage": "initialized",
            "progress": 0,
            "message": "Project state initialized.",
        },
        "user_preferences": user_preferences or {},
        "provider_settings": provider_settings or {},
        "current_plan": None,
        "scene_assets": {
            "voiceover": None,
            "images": [],
            "videos": [],
            "final_video_path": None,
            "manifest_path": None,
        },
        "failures": [],
        "decisions": [],
        "messages": [],
    }


def normalize_project_state(ctx: ProjectContext, state: dict[str, Any]) -> dict[str, Any]:
    defaults = default_project_state(ctx)
    normalized = {**defaults, **state}
    normalized["project_id"] = ctx.project_id
    normalized["status"] = {**defaults["status"], **(state.get("status") or {})}
    normalized["scene_assets"] = {**defaults["scene_assets"], **(state.get("scene_assets") or {})}
    normalized["user_preferences"] = dict(state.get("user_preferences") or {})
    normalized["provider_settings"] = dict(state.get("provider_settings") or {})
    normalized["failures"] = list(state.get("failures") or [])
    normalized["decisions"] = list(state.get("decisions") or [])
    normalized["messages"] = list(state.get("messages") or [])
    return normalized


def initialize_project_state(
    ctx: ProjectContext,
    *,
    user_preferences: dict[str, Any] | None = None,
    provider_settings: dict[str, Any] | None = None,
) -> dict[str, Any]:
    state = default_project_state(
        ctx,
        user_preferences=user_preferences,
        provider_settings=provider_settings,
    )
    return write_json_artifact(ctx, "project_state", state)


def read_project_state(ctx: ProjectContext) -> dict[str, Any]:
    state = read_json_artifact(ctx, "project_state")
    if not state:
        return default_project_state(ctx)
    return normalize_project_state(ctx, state)


def write_project_state(ctx: ProjectContext, state: dict[str, Any]) -> dict[str, Any]:
    state = normalize_project_state(ctx, state)
    state["updated_at"] = utc_now()
    return write_json_artifact(ctx, "project_state", state)


def update_project_state(
    ctx: ProjectContext,
    *,
    status: dict[str, Any] | None = None,
    user_preferences: dict[str, Any] | None = None,
    provider_settings: dict[str, Any] | None = None,
    current_plan: Any = _MISSING,
    voiceover: Any = _MISSING,
    images: Any = _MISSING,
    videos: Any = _MISSING,
    failures: Any = _MISSING,
    final_video_path: Any = _MISSING,
    manifest_path: Any = _MISSING,
    manifest: dict[str, Any] | None = None,
    decision: dict[str, Any] | None = None,
) -> dict[str, Any]:
    state = read_project_state(ctx)
    if status is not None:
        state["status"] = {**state.get("status", {}), **status}
    if user_preferences is not None:
        state["user_preferences"] = {**state.get("user_preferences", {}), **user_preferences}
    if provider_settings is not None:
        state["provider_settings"] = {**state.get("provider_settings", {}), **provider_settings}
    if current_plan is not _MISSING:
        state["current_plan"] = current_plan
    scene_assets = state["scene_assets"]
    if voiceover is not _MISSING:
        scene_assets["voiceover"] = voiceover
    if images is not _MISSING:
        scene_assets["images"] = images
    if videos is not _MISSING:
        scene_assets["videos"] = videos
    if failures is not _MISSING:
        state["failures"] = failures
    if final_video_path is not _MISSING:
        scene_assets["final_video_path"] = final_video_path
    if manifest_path is not _MISSING:
        scene_assets["manifest_path"] = manifest_path
    if manifest is not None:
        scene_assets["manifest_path"] = manifest.get("manifest_path") or scene_assets.get("manifest_path")
        scene_assets["final_video_path"] = manifest.get("final_video_path") or scene_assets.get("final_video_path")
        state["failures"] = manifest.get("failed_scenes", state.get("failures", []))
    if decision is not None:
        entry = {
            "created_at": utc_now(),
            **decision,
        }
        state["decisions"] = [*state.get("decisions", []), entry]
    return write_project_state(ctx, state)


def append_project_decision(
    ctx: ProjectContext,
    *,
    decision: str,
    rationale: str = "",
    scene_id: str | None = None,
    tool: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    entry: dict[str, Any] = {"decision": decision}
    if rationale:
        entry["rationale"] = rationale
    if scene_id:
        entry["scene_id"] = scene_id
    if tool:
        entry["tool"] = tool
    if metadata:
        entry["metadata"] = metadata
    state = update_project_state(ctx, decision=entry)
    return state["decisions"][-1]


def append_project_message(
    ctx: ProjectContext,
    *,
    role: str,
    content: str,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "created_at": utc_now(),
        "role": role,
        "content": content,
    }
    if metadata:
        entry["metadata"] = metadata
    state = read_project_state(ctx)
    state["messages"] = [*state.get("messages", []), entry]
    write_project_state(ctx, state)
    return entry


def ordered_scene_assets(plan: Any, assets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_scene = {asset["scene_id"]: asset for asset in assets}
    return [by_scene[scene.id] for scene in plan.scenes if scene.id in by_scene]


def upsert_scene_assets(existing: list[dict[str, Any]], replacements: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_scene = {asset["scene_id"]: asset for asset in existing}
    for asset in replacements:
        by_scene[asset["scene_id"]] = asset
    return list(by_scene.values())


def clear_scene_failures(
    failures: list[dict[str, str]],
    scene_ids: set[str],
    stages: set[str] | None = None,
) -> list[dict[str, str]]:
    return [
        failure
        for failure in failures
        if not (
            failure.get("scene_id") in scene_ids
            and (stages is None or failure.get("stage") in stages)
        )
    ]


def record_scene_failures(
    existing: list[dict[str, str]],
    failures: list[dict[str, str]],
) -> list[dict[str, str]]:
    cleaned = clear_scene_failures(
        existing,
        {failure["scene_id"] for failure in failures},
        {failure["stage"] for failure in failures},
    )
    return [*cleaned, *failures]
