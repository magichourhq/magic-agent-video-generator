from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import re
import shutil
import subprocess
import uuid
from contextlib import suppress
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Literal

from agents import Agent, ModelSettings, RunContextWrapper, Runner, ToolSearchTool, WebSearchTool, function_tool, tool_namespace
from agents.usage import Usage, serialize_usage
from dotenv import dotenv_values
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError

from .render_state import (
    append_project_message,
    append_project_decision,
    artifact_path,
    clear_scene_failures,
    initialize_project_state as write_initial_project_state,
    ordered_scene_assets,
    read_json_artifact,
    read_project_state,
    record_scene_failures,
    remove_json_artifact,
    update_project_state,
    upsert_scene_assets,
    write_json_artifact,
)
from .tools import (
    ProjectContext,
    combine_section_voiceovers,
    generate_image_asset,
    generate_section_voiceovers,
    generate_video_asset,
    generate_video_assets_batch,
    generate_voiceover_asset,
    download_youtube_clip_assets,
    pick_download,
    probe_media_duration,
    stitch_assets,
    stitch_assets_per_section,
)


ROOT = Path(__file__).resolve().parents[2]
SHARED_ENV = Path("/Users/tanmay/Magic Hour ML role/.env")


def env() -> dict[str, str]:
    values = {key: value for key, value in dotenv_values(SHARED_ENV).items() if value is not None}
    values.update({key: value for key, value in dotenv_values(ROOT / ".env").items() if value is not None})
    values.update(os.environ)
    return values


ENV = env()
OUTPUT_DIR = Path(ENV.get("OUTPUT_DIR", ROOT / "outputs")).expanduser().resolve()
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
MH_AGENT_YT_CLIPS_DIR = Path(
    ENV.get("MH_AGENT_YT_CLIPS_DIR", ROOT.parent / "mh_agent_output" / "yt-clips")
).expanduser().resolve()
os.environ.setdefault("OPENAI_API_KEY", ENV.get("OPENAI_API_KEY", ""))
logging.basicConfig(level=ENV.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger("video-agent")

OPENAI_TEXT_PRICING_USD_PER_1M = {
    "gpt-5.5": {
        "input": 5.00,
        "cached_input": 0.50,
        "output": 30.00,
        "long_context_threshold_input_tokens": 272_000,
        "long_context_input_multiplier": 2.0,
        "long_context_output_multiplier": 1.5,
        "source": "https://developers.openai.com/api/docs/models/gpt-5.5/",
    },
    "gpt-5.4": {
        "input": 2.50,
        "cached_input": 0.25,
        "output": 15.00,
        "long_context_threshold_input_tokens": 272_000,
        "long_context_input_multiplier": 2.0,
        "long_context_output_multiplier": 1.5,
        "source": "https://developers.openai.com/api/docs/models/gpt-5.4/",
    }
}


AspectRatio = Literal["9:16", "16:9", "1:1"]
Resolution = Literal["480p", "720p", "1080p"]
WorkflowMode = Literal["generated", "youtube_clips"]
YouTubeSearchProvider = Literal["auto", "youtube_data_api", "yt_dlp"]
YouTubeReviewProvider = Literal["youtube_data_api", "yt_dlp"]
MagicImageModel = Literal[
    "default",
    "flux-schnell",
    "z-image-turbo",
    "seedream-v4",
    "nano-banana",
    "nano-banana-2",
    "nano-banana-pro",
]
MagicImageResolution = Literal["640px", "1k", "2k", "4k"]
MagicImageStyleTool = Literal[
    "general",
    "ai-photo-generator",
    "ai-character-generator",
    "ai-landscape-generator",
    "ai-illustration-generator",
    "ai-art-generator",
    "movie-poster-generator",
    "architecture-generator",
    "ai-background-generator",
]
MagicVideoModel = Literal[
    "default",
    "ltx-2",
    "ltx-2.3",
    "wan-2.2",
    "seedance",
    "seedance-2.0",
    "kling-2.5",
    "kling-3.0",
    "sora-2",
    "veo3.1",
    "veo3.1-lite",
    "kling-1.6",
]
ProjectStatus = Literal["queued", "running", "succeeded", "failed"]
ProgressCallback = Callable[[str, int, str], Awaitable[None]]
PROJECT_ID_PATTERN = re.compile(r"^[a-f0-9]{32}$")
WORD_PATTERN = re.compile(r"[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)?")
FISH_AUDIO_BRACKET_CUE_PATTERN = re.compile(r"\[([^\[\]\n]{1,80})\]")
FISH_AUDIO_LEGACY_PAREN_CUE_PATTERN = re.compile(r"\(([a-z][a-z -]{0,32})\)")
PROMPT_DURATION_UNDER_PATTERN = re.compile(r"\b(?:keep\s+it\s+)?under\s+(\d{1,2})\s+seconds?\b", re.IGNORECASE)
PROMPT_DURATION_PATTERN = re.compile(r"\b(\d{1,2})(?:\s*-\s*|\s+)seconds?\b", re.IGNORECASE)
PROMPT_NUMBER_WORDS: dict[str, int] = {
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
}
PROMPT_COUNT_TOKEN = r"\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten"
PROMPT_EXACT_SCENE_PATTERNS = (
    re.compile(rf"\bexactly\s+(?P<count>{PROMPT_COUNT_TOKEN})\s+(?:distinct\s+|unique\s+)?(?:scenes?|stages?)\b", re.IGNORECASE),
    re.compile(rf"\buse\s+(?P<count>{PROMPT_COUNT_TOKEN})\s+(?:distinct\s+|unique\s+)?(?:scenes?|stages?)\b", re.IGNORECASE),
    re.compile(rf"\binclude\s+(?P<count>{PROMPT_COUNT_TOKEN})\s+(?:distinct\s+|unique\s+)?(?:scenes?|stages?)\b", re.IGNORECASE),
)
PROMPT_MIN_SCENE_PATTERN = re.compile(
    rf"\bat\s+least\s+(?P<count>{PROMPT_COUNT_TOKEN})\s+(?:distinct\s+|unique\s+)?(?:scenes?|stages?)\b",
    re.IGNORECASE,
)
PROMPT_AGENT_DECIDES_SCENE_PATTERNS = (
    re.compile(r"\b(?:you\s+(?:must\s+)?)?(?:decide|determine|choose)\b.{0,100}\b(?:number\s+of\s+scenes|how\s+many\s+scenes|scene\s+count)\b", re.IGNORECASE),
    re.compile(r"\b(?:number\s+of\s+scenes|how\s+many\s+scenes|scene\s+count)\b.{0,100}\b(?:you\s+)?(?:decide|determine|choose)\b", re.IGNORECASE),
)
FACTUAL_YOUTUBE_PROMPT_PATTERN = re.compile(
    r"\b(latest|today|tonight|current|breaking|news|shooting|election|war|attack|trial|lawsuit|earnings|weather|emergency|press conference)\b",
    re.IGNORECASE,
)
HISTORICAL_YOUTUBE_PROMPT_PATTERN = re.compile(
    r"\b(19\d{2}|20\d{2}|season|career|history|historic|classic|highlights?|recap|documentary|throwback)\b",
    re.IGNORECASE,
)
GENERIC_YOUTUBE_BROLL_PATTERN = re.compile(
    r"\b(vertical|shorts?|stock(?:\s+(?:video|footage))?|b[-\s]?roll|generic|watermark(?:ed)?|police lights|street scene)\b",
    re.IGNORECASE,
)
YOUTUBE_CREATION_PREFIX_PATTERN = re.compile(
    r"^\s*(?:(?:make|create|generate|build)\s+(?:an?\s+)?)?"
    r"(?:(?:under\s+\d{1,2}\s+seconds?|\d{1,2}(?:\s+|-)?seconds?)\s+)?"
    r"(?:(?:youtube\s+clips?|yt\s+clips?)\s+)?"
    r"(?:short|video|clip|reel)\s+(?:on|about|of)\s+",
    re.IGNORECASE,
)
YOUTUBE_SOURCE_FILLER_PATTERN = re.compile(
    r"\b(?:using|real|clips?|from|videos?|footage|coverage|and|or)\b",
    re.IGNORECASE,
)
YOUTUBE_DUPLICATE_HINT_SUFFIXES = (
    "official update",
    "announcement",
    "product demo",
    "press briefing",
    "launch news",
    "developer update",
)
YOUTUBE_PRODUCT_DUPLICATE_HINT_SUFFIXES = (
    "launch",
    "introducing",
    "announcement",
    "developer update",
)
OPENAI_PRODUCT_TERM_PATTERN = re.compile(
    r"\b(Codex|ChatGPT(?:\s+Atlas)?|GPT-(?:\d(?:\.\d+)?|4o|[A-Za-z][A-Za-z0-9-]*)|O3|O4(?:[-\s]?mini)?|O1(?:[-\s]?(?:pro|mini))?|Sora|AgentKit|DALL-E)\b",
    re.IGNORECASE,
)
FACTUAL_SUBJECT_STOPWORDS = {
    "about",
    "actual",
    "clip",
    "clips",
    "coverage",
    "from",
    "into",
    "latest",
    "make",
    "news",
    "official",
    "real",
    "reputable",
    "short",
    "today",
    "tonight",
    "using",
    "video",
    "videos",
    "with",
    "youtube",
}
DEFAULT_AUTO_DURATION_SECONDS = 15
DEFAULT_AUTO_SCENE_BUDGET_COUNT = 4
DEFAULT_MAGIC_HOUR_IMAGE_MODEL: MagicImageModel = "seedream-v4"
DEFAULT_MAGIC_HOUR_VIDEO_MODEL: MagicVideoModel = "ltx-2.3"
DEFAULT_AGENT_MAX_TURNS = 30
DEFAULT_TTS_WORDS_PER_SECOND = 2.8
MIN_TTS_WORDS_PER_SECOND = 1.6
MAX_TTS_WORDS_PER_SECOND = 3.6
NARRATION_MIN_FACTOR = 0.9
NARRATION_MAX_FACTOR = 1.0
SCENE_CROSSFADE_SECONDS = 0.5
REQUIRED_ENV_KEYS = (
    "OPENAI_API_KEY",
    "MAGIC_HOUR_API_KEY",
    "FISH_AUDIO_API_KEY",
    "FISH_AUDIO_REFERENCE_ID",
)
REQUIRED_SYSTEM_COMMANDS = ("ffmpeg", "ffprobe")
PROJECTS: dict[str, dict[str, Any]] = {}
YOUTUBE_REVIEW_PROVIDERS: tuple[YouTubeReviewProvider, ...] = ("youtube_data_api",)
YOUTUBE_REVIEW_PROMPT_SET_PATH = ROOT / "evals" / "youtube_workflow_eval_prompts.jsonl"
RUNNING_YOUTUBE_REVIEW_BATCHES: set[str] = set()

MAGIC_IMAGE_MODELS: tuple[MagicImageModel, ...] = (
    "default",
    "flux-schnell",
    "z-image-turbo",
    "seedream-v4",
    "nano-banana",
    "nano-banana-2",
    "nano-banana-pro",
)
MAGIC_IMAGE_RESOLUTIONS: tuple[MagicImageResolution, ...] = ("640px", "1k", "2k", "4k")
MAGIC_IMAGE_STYLE_TOOLS: tuple[MagicImageStyleTool, ...] = (
    "general",
    "ai-photo-generator",
    "ai-character-generator",
    "ai-landscape-generator",
    "ai-illustration-generator",
    "ai-art-generator",
    "movie-poster-generator",
    "architecture-generator",
    "ai-background-generator",
)
MAGIC_VIDEO_MODELS: tuple[MagicVideoModel, ...] = (
    "default",
    "ltx-2",
    "ltx-2.3",
    "wan-2.2",
    "seedance",
    "seedance-2.0",
    "kling-2.5",
    "kling-3.0",
    "sora-2",
    "veo3.1",
    "veo3.1-lite",
    "kling-1.6",
)
MAGIC_IMAGE_MODEL_RESOLUTIONS: dict[str, set[str]] = {
    "flux-schnell": {"640px", "1k", "2k"},
    "z-image-turbo": {"640px", "1k", "2k"},
    "seedream-v4": {"640px", "1k", "2k", "4k"},
    "nano-banana": {"640px", "1k"},
    "nano-banana-2": {"640px", "1k", "2k", "4k"},
    "nano-banana-pro": {"1k", "2k", "4k"},
}
MAGIC_VIDEO_MODEL_RESOLUTIONS: dict[str, set[str]] = {
    "ltx-2": {"480p", "720p", "1080p"},
    "ltx-2.3": {"480p", "720p", "1080p"},
    "wan-2.2": {"480p", "720p", "1080p"},
    "seedance": {"480p", "720p", "1080p"},
    "seedance-2.0": {"480p", "720p"},
    "kling-2.5": {"720p", "1080p"},
    "kling-3.0": {"720p", "1080p"},
    "sora-2": {"720p"},
    "veo3.1": {"720p", "1080p"},
    "veo3.1-lite": {"720p", "1080p"},
    "kling-1.6": {"720p", "1080p"},
}
MAGIC_VIDEO_MODEL_DURATIONS: dict[str, set[int]] = {
    "ltx-2": {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 25, 30},
    "ltx-2.3": {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 25, 30},
    "wan-2.2": {3, 4, 5, 6, 7, 8, 9, 10, 15},
    "seedance": {2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12},
    "seedance-2.0": {4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15},
    "kling-2.5": {5, 10},
    "kling-3.0": {3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15},
    "sora-2": {4, 8, 12, 24, 36, 48, 60},
    "veo3.1": {4, 6, 8, 16, 24, 32, 40, 48, 56},
    "veo3.1-lite": {8, 16, 24, 32, 40, 48, 56},
    "kling-1.6": {5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60},
}
IMAGE_PROMPT_DESCRIPTION = (
    "Provider prompt for the still image. Write a stable cinematic keyframe later to be used for image-to-video generations.: "
    "describe only what is visible in one frame, including subject identity, action pose, foreground/background, "
    "lighting, lens/framing, texture, palette, and continuity details. Avoid text, logos, UI, captions, "
    "multi-panel layouts, and anything the later video prompt must invent."
)
VIDEO_PROMPT_DESCRIPTION = (
    "Provider prompt for animating that exact still image. Use one camera move and at most one subject motion; "
    "only animate what already exists in the image. Use no cuts. Do not add new objects, locations, cuts, scene changes, "
    "transformations, text, or events that are not grounded in the keyframe."
)


class Scene(BaseModel):
    id: str
    narration: str
    image_prompt: str = Field(description=IMAGE_PROMPT_DESCRIPTION)
    video_prompt: str = Field(description=VIDEO_PROMPT_DESCRIPTION)
    duration_seconds: int = Field(ge=1, le=30)


class VideoPlan(BaseModel):
    title: str
    narration: str
    visual_bible: str = Field(default="", max_length=900)
    scenes: list[Scene] = Field(min_length=1, max_length=10)


YouTubeSearchOrder = Literal["relevance", "date", "viewCount", "rating"]
YouTubeVideoDuration = Literal["short", "medium", "long"]
YouTubeVideoCategory = Literal[
    "film_animation",
    "autos_vehicles",
    "music",
    "pets_animals",
    "sports",
    "travel_events",
    "gaming",
    "people_blogs",
    "comedy",
    "entertainment",
    "news_politics",
    "howto_style",
    "education",
    "science_technology",
]


class YouTubeClipSection(BaseModel):
    section: int = Field(ge=1, le=10)
    dialogue: str = Field(min_length=1, max_length=600)
    search_hint: str = Field(min_length=2, max_length=120)
    duration_seconds: int = Field(ge=1, le=30)
    # Optional retrieval-targeting fields mapped directly onto YouTube Data API
    # search.list parameters, so the planner controls recency, category,
    # captions, and clip length per scene instead of backend heuristics.
    search_order: YouTubeSearchOrder | None = None
    published_after: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    published_before: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    video_duration: YouTubeVideoDuration | None = None
    video_category: YouTubeVideoCategory | None = None
    require_captions: bool = False
    channel_hint: str | None = Field(default=None, max_length=80)
    # Direct YouTube URLs the planner found via web search; validated and
    # hydrated server-side, they lead the candidate pool ahead of search.
    candidate_video_urls: list[str] = Field(default_factory=list, max_length=3)


class YouTubeScriptPlan(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    web_search_needed: bool = False
    web_search_reason: str = Field(default="", max_length=300)
    sections: list[YouTubeClipSection] = Field(min_length=1, max_length=10)


class SceneNarrationRevision(BaseModel):
    scene_id: str
    narration: str


class CreateProjectRequest(BaseModel):
    prompt: str = Field(min_length=3, max_length=2_000)
    workflow: WorkflowMode = "generated"
    youtube_search_provider: YouTubeSearchProvider = "youtube_data_api"
    youtube_allow_provider_fallback: bool = False
    duration_seconds: int | None = Field(default=None, ge=1, le=60)
    scene_count: int | None = Field(default=None, ge=1, le=10)
    aspect_ratio: AspectRatio = "9:16"
    resolution: Resolution = "720p"
    image_model: MagicImageModel | None = None
    video_model: MagicVideoModel | None = None
    image_resolution: MagicImageResolution | None = None
    video_resolution: Resolution | None = None


class ProjectMessageRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4_000)


class YouTubeReviewSessionRequest(BaseModel):
    prompt: str = Field(min_length=3, max_length=2_000)
    duration_seconds: int | None = Field(default=None, ge=1, le=60)
    scene_count: int | None = Field(default=None, ge=1, le=10)
    aspect_ratio: AspectRatio = "9:16"
    resolution: Resolution = "720p"


class YouTubeReviewCommentRequest(BaseModel):
    provider: YouTubeReviewProvider
    comments: str = Field(default="", max_length=8_000)


@dataclass(frozen=True)
class SpeechBudget:
    words_per_second: float
    min_words: int
    max_words: int
    scene_duration_total_seconds: float
    final_duration_seconds: int


SceneConstraintMode = Literal["exact", "minimum", "agent_decides"]


@dataclass(frozen=True)
class GenerationConstraints:
    duration_seconds: int
    duration_source: Literal["prompt", "request", "auto"]
    duration_is_upper_bound: bool
    scene_mode: SceneConstraintMode
    scene_count: int | None
    scene_source: Literal["prompt", "request", "auto"]
    scene_budget_count: int


INSTRUCTIONS = """
You are a cinematic art director and autonomous video production agent.
Do not ask clarification questions. Infer missing details, make taste decisions,
and own the creative loop and render decisions.

Use the video_studio tools as a bounded production loop:
1. Call draft_video_plan with the complete title, narration, visual bible, and
   scene list.
2. Call generate_voiceover and generate_scene_images after the plan is saved.
3. Call animate_scene_videos after images exist.
4. Call inspect_render_status whenever an asset step is incomplete or unclear.
5. Call retry_scene for failed or missing scene assets before final stitching.
6. Call stitch_final_video once there is at least one completed scene video and
   a voiceover.
7. Call record_project_decision for important creative choices, retry choices,
   or user-preference interpretations that should persist in project_state.json.
8. After inspecting a result, use revision tools for narrow patches:
   regenerate_scene for one bad scene, revise_narration for script edits,
   replace_voiceover for stale audio, and restitch_video to verify the patched
   edit.

When the brief says Workflow: youtube_clips, use
youtube_short.create_youtube_short_from_prompt instead of the Magic Hour
image/video tools. The YouTube tool owns notebook-style script planning, search
hints, clip download, voiceover, stitching, project state, and manifest creation.

Quality rules:
- Narration is spoken voiceover copy for Fish Audio: it should sound like a
  tiny story being told aloud, not camera direction, not image description, and
  not a production note.
- Write a specific, natural narration with tension, intention, and payoff. No
  hype filler, no "this video".
- Use 3-5 scenes unless the user explicitly asks for more.
- Image prompts should be concrete: subject, setting, light, composition,
  style, mood, and continuity details.
- Treat each image prompt as the stable cinematic keyframe that the video model
  will animate. It must describe what is visible in one frame, not a sequence.
- Video prompts should describe camera motion and subject motion only.
- Video prompts should animate only what already exists in that keyframe: one
  camera move, at most one subject motion, no cuts, no scene changes, and no
  new objects.
- Choose Magic Hour image and image-to-video models yourself when the user does
  not specify them. Use model-specific strengths and constraints from the user
  brief and tool parameter descriptions.
- Keep motion realistic and easy for image-to-video to follow.
- Avoid text, logos, captions, distorted hands, and impossible camera moves.
- For speed, prefer 4-6 second scenes. Use longer durations only if needed.
- Make the total close to the requested duration.
- Keep visual continuity across scenes: subject identity, palette, lens language,
  camera energy, and environmental details should feel intentionally directed.
- If the user's requested scene count conflicts with quality, choose the scene
  count that makes the best final video and explain that choice in the title or
  narration only if needed.
""".strip()


PLANNING_INSTRUCTIONS = """
You are a senior cinematic art director. Return one complete VideoPlan that
matches the supplied timing brief. Do not ask clarification questions.

Planning rules:
- The full narration must fit the spoken-word budget in the user brief.
- Narration is spoken voiceover copy for Fish Audio. It should tell a compact
  story with character intention, obstacle, change, and payoff.
- Do not write narration as image prompt prose, not camera direction, and not a production note.
  Avoid lens, wardrobe, lighting, blocking, and model-facing
  visual inventory in narration unless it matters to the spoken story.
- Scene narrations should be one short sentence each and should combine cleanly
  into the full narration.
- Add Fish Audio S2 expression cues in brackets at the start of narration
  sentences where useful, for example [whispers softly], [speaks calmly],
  [curious], [tense], [laughs quietly], or [emphasis]. Keep cues sparse and
  natural.
- Image prompts should be concrete: subject, setting, light, composition,
  style, mood, and important visual details.
- Video prompts must describe only camera or subject motion that can happen in
  the current still image.
- Treat image_prompt as a stable cinematic keyframe and video_prompt as a small,
  grounded motion instruction for that exact keyframe.
- Keep all prompts compact. Do not add captions, logos, text, impossible camera
  moves, or new continuity details not present in the plan.
""".strip()


app = FastAPI(title="Fast OpenAI Video Agent")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000", "http://0.0.0.0:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/media", StaticFiles(directory=str(OUTPUT_DIR)), name="media")


def missing_configuration() -> list[str]:
    return [key for key in REQUIRED_ENV_KEYS if not ENV.get(key)]


def missing_system_dependencies() -> list[str]:
    return [command for command in REQUIRED_SYSTEM_COMMANDS if shutil.which(command) is None]


def assert_runtime_ready() -> None:
    missing_config = missing_configuration()
    missing_dependencies = missing_system_dependencies()
    if missing_config or missing_dependencies:
        raise HTTPException(
            status_code=503,
            detail={
                "message": "Project is not ready to render locally.",
                "missing_config": missing_config,
                "missing_dependencies": missing_dependencies,
            },
        )


def project_dir_for(project_id: str) -> Path:
    if not PROJECT_ID_PATTERN.fullmatch(project_id):
        raise ValueError(f"Invalid project id: {project_id}")
    return (OUTPUT_DIR / project_id).resolve()


def public_media_path(path: str | Path) -> str:
    resolved = Path(path).expanduser().resolve()
    try:
        relative = resolved.relative_to(OUTPUT_DIR.resolve())
    except ValueError as exc:
        raise ValueError(f"Media path is outside output directory: {resolved}") from exc
    return f"/media/{relative.as_posix()}"


def slugify_filename(value: str, *, fallback: str = "youtube-short", max_length: int = 80) -> str:
    slug = re.sub(r"[^A-Za-z0-9]+", "-", value.lower()).strip("-")
    slug = re.sub(r"-{2,}", "-", slug)
    if not slug:
        return fallback
    if len(slug) <= max_length:
        return slug
    trimmed = slug[:max_length].rsplit("-", 1)[0].strip("-")
    return trimmed or slug[:max_length].strip("-") or fallback


def export_youtube_final_video(ctx: ProjectContext, manifest: dict[str, Any]) -> dict[str, Any]:
    if manifest.get("workflow") != "youtube_clips":
        return manifest
    final_video_path = manifest.get("final_video_path")
    if not final_video_path:
        return manifest
    source = Path(str(final_video_path)).expanduser().resolve()
    if not source.is_file():
        return manifest

    state = read_project_state(ctx)
    prompt = str((state.get("user_preferences") or {}).get("prompt") or manifest.get("title") or "")
    filename = f"{slugify_filename(prompt)}__{ctx.project_id[:8]}.mp4"
    destination = MH_AGENT_YT_CLIPS_DIR / filename
    MH_AGENT_YT_CLIPS_DIR.mkdir(parents=True, exist_ok=True)
    if source != destination:
        shutil.copy2(source, destination)

    exported = dict(manifest)
    exported["exported_final_video_path"] = str(destination)
    return exported


def with_media_url(asset: dict[str, Any]) -> dict[str, Any]:
    payload = dict(asset)
    if payload.get("path"):
        payload["url"] = public_media_path(payload["path"])
    return payload


def status_file_for(project_id: str) -> Path:
    return project_dir_for(project_id) / "status.json"


async def update_project_status(
    project_id: str,
    *,
    status: ProjectStatus,
    stage: str,
    progress: int,
    message: str,
    manifest: dict[str, Any] | None = None,
    error: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "project_id": project_id,
        "status": status,
        "stage": stage,
        "progress": max(0, min(progress, 100)),
        "message": message,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "status_url": f"/api/projects/{project_id}",
    }
    if manifest is not None:
        payload["manifest"] = manifest
    if error is not None:
        payload["error"] = error

    PROJECTS[project_id] = payload
    status_path = status_file_for(project_id)
    status_path.parent.mkdir(parents=True, exist_ok=True)
    status_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    state_path = status_path.parent / "project_state.json"
    if state_path.exists():
        state_ctx = ProjectContext(project_id=project_id, project_dir=status_path.parent, aspect_ratio="", resolution="")
        update_project_state(
            state_ctx,
            status={
                "status": status,
                "stage": stage,
                "progress": payload["progress"],
                "message": message,
                **({"error": error} if error is not None else {}),
            },
        )
    return payload


def terminal_youtube_status_from_manifest(project_id: str, manifest: dict[str, Any]) -> dict[str, Any] | None:
    if manifest.get("workflow") != "youtube_clips":
        return None
    if manifest.get("render_status") not in {"complete", "partial"}:
        return None
    if not manifest.get("videos"):
        return None
    final_video_path = manifest.get("final_video_path")
    final_video_url = manifest.get("final_video_url")
    if final_video_path:
        if not Path(str(final_video_path)).expanduser().is_file():
            return None
    elif not final_video_url:
        return None

    failed_count = int(manifest.get("failed_scene_count") or 0)
    return {
        "project_id": project_id,
        "status": "succeeded",
        "stage": "complete",
        "progress": 100,
        "message": "Video is ready." if failed_count == 0 else f"Partial video is ready with {failed_count} failed scene(s).",
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "status_url": f"/api/projects/{project_id}",
        "manifest": manifest,
    }


def repair_running_status_from_terminal_youtube_manifest(
    project_id: str,
    payload: dict[str, Any],
    state: dict[str, Any] | None,
) -> dict[str, Any]:
    if payload.get("status") in {"succeeded", "failed"}:
        if state is not None:
            payload = dict(payload)
            payload["project_state"] = state
        return payload

    project_dir = project_dir_for(project_id)
    manifest = payload.get("manifest")
    manifest_path = project_dir / "manifest.json"
    if not isinstance(manifest, dict) and manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        if state is not None:
            payload = dict(payload)
            payload["project_state"] = state
        return payload

    repaired = terminal_youtube_status_from_manifest(project_id, manifest)
    if repaired is None:
        if state is not None:
            payload = dict(payload)
            payload["project_state"] = state
        return payload

    PROJECTS[project_id] = repaired
    status_path = status_file_for(project_id)
    status_path.parent.mkdir(parents=True, exist_ok=True)
    status_path.write_text(json.dumps(repaired, indent=2), encoding="utf-8")

    state_path = project_dir / "project_state.json"
    if state_path.exists():
        state_ctx = ProjectContext(project_id=project_id, project_dir=project_dir, aspect_ratio="", resolution="")
        update_project_state(
            state_ctx,
            status={
                "status": "succeeded",
                "stage": "complete",
                "progress": 100,
                "message": repaired["message"],
            },
        )
        state = read_project_state(state_ctx)

    payload = dict(repaired)
    if state is not None:
        payload["project_state"] = state
    return payload


def read_project_status(project_id: str) -> dict[str, Any] | None:
    project_dir = project_dir_for(project_id)
    state_ctx = ProjectContext(project_id=project_id, project_dir=project_dir, aspect_ratio="", resolution="")
    state = read_project_state(state_ctx) if (project_dir / "project_state.json").exists() else None
    if project_id in PROJECTS:
        return repair_running_status_from_terminal_youtube_manifest(project_id, dict(PROJECTS[project_id]), state)

    status_path = project_dir / "status.json"
    if status_path.exists():
        payload = json.loads(status_path.read_text(encoding="utf-8"))
        return repair_running_status_from_terminal_youtube_manifest(project_id, payload, state)

    manifest_path = project_dir / "manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        payload = terminal_youtube_status_from_manifest(project_id, manifest) or {
            "project_id": project_id,
            "status": "succeeded",
            "stage": "complete",
            "progress": 100,
            "message": "Video is ready.",
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "status_url": f"/api/projects/{project_id}",
            "manifest": manifest,
        }
        if state is not None:
            payload["project_state"] = state
        return payload

    return None


def review_dir_for(review_id: str) -> Path:
    if not PROJECT_ID_PATTERN.fullmatch(review_id):
        raise ValueError(f"Invalid review id: {review_id}")
    return (OUTPUT_DIR / "reviews" / review_id).resolve()


def review_file_for(review_id: str) -> Path:
    return review_dir_for(review_id) / "review.json"


def review_batch_dir_for(batch_id: str) -> Path:
    if not PROJECT_ID_PATTERN.fullmatch(batch_id):
        raise ValueError(f"Invalid review batch id: {batch_id}")
    return (OUTPUT_DIR / "reviews" / "batches" / batch_id).resolve()


def review_batch_file_for(batch_id: str) -> Path:
    return review_batch_dir_for(batch_id) / "batch.json"


def read_youtube_review_session(review_id: str) -> dict[str, Any] | None:
    review_path = review_file_for(review_id)
    if not review_path.exists():
        return None
    return json.loads(review_path.read_text(encoding="utf-8"))


def write_youtube_review_session(payload: dict[str, Any]) -> dict[str, Any]:
    review_path = review_file_for(str(payload["review_id"]))
    review_path.parent.mkdir(parents=True, exist_ok=True)
    review_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return payload


def read_youtube_review_batch(batch_id: str) -> dict[str, Any] | None:
    batch_path = review_batch_file_for(batch_id)
    if not batch_path.exists():
        return None
    return json.loads(batch_path.read_text(encoding="utf-8"))


def write_youtube_review_batch(payload: dict[str, Any]) -> dict[str, Any]:
    batch_path = review_batch_file_for(str(payload["batch_id"]))
    batch_path.parent.mkdir(parents=True, exist_ok=True)
    batch_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return payload


def latest_youtube_review_batch() -> dict[str, Any] | None:
    batches_dir = OUTPUT_DIR / "reviews" / "batches"
    if not batches_dir.exists():
        return None
    batch_files = [path for path in batches_dir.glob("*/batch.json") if path.is_file()]
    if not batch_files:
        return None
    latest_path = max(batch_files, key=lambda path: path.stat().st_mtime)
    return json.loads(latest_path.read_text(encoding="utf-8"))


def load_youtube_review_prompt_set(path: Path | None = None) -> list[dict[str, Any]]:
    prompt_path = path or YOUTUBE_REVIEW_PROMPT_SET_PATH
    prompts: list[dict[str, Any]] = []
    for line_number, line in enumerate(prompt_path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        raw = json.loads(line)
        settings = raw.get("settings") or {}
        request = YouTubeReviewSessionRequest(
            prompt=str(raw["prompt"]),
            duration_seconds=settings.get("duration_seconds"),
            scene_count=settings.get("scene_count"),
            aspect_ratio=settings.get("aspect_ratio", "9:16"),
            resolution=settings.get("resolution", "720p"),
        )
        prompts.append(
            {
                "prompt_id": str(raw.get("id") or f"prompt-{line_number:03d}"),
                "name": str(raw.get("name") or raw.get("id") or f"Prompt {line_number}"),
                "category": str(raw.get("category") or "uncategorized"),
                "request": request,
            }
        )
    if not prompts:
        raise ValueError(f"No review prompts found in {prompt_path}")
    return prompts


def parse_iso_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def project_latency_seconds(started_at: Any, status: dict[str, Any] | None) -> float | None:
    started = parse_iso_datetime(started_at)
    if started is None:
        return None
    is_terminal = status is not None and status.get("status") in {"succeeded", "failed"}
    finished = parse_iso_datetime(status.get("updated_at")) if is_terminal and status is not None else None
    ended = finished or datetime.now(timezone.utc)
    return round(max(0.0, (ended - started).total_seconds()), 2)


def youtube_review_project_request(
    request: YouTubeReviewSessionRequest,
    provider: YouTubeReviewProvider,
) -> CreateProjectRequest:
    return CreateProjectRequest(
        prompt=request.prompt,
        workflow="youtube_clips",
        youtube_search_provider=provider,
        youtube_allow_provider_fallback=False,
        duration_seconds=request.duration_seconds,
        scene_count=request.scene_count,
        aspect_ratio=request.aspect_ratio,
        resolution=request.resolution,
    )


def youtube_review_session_response(payload: dict[str, Any]) -> dict[str, Any]:
    providers: dict[str, Any] = {}
    for provider, provider_payload in (payload.get("providers") or {}).items():
        project_id = str(provider_payload.get("project_id"))
        status = read_project_status(project_id)
        manifest = status.get("manifest") if isinstance(status, dict) else None
        manifest = manifest if isinstance(manifest, dict) else {}
        if not manifest:
            manifest_path = project_dir_for(project_id) / "manifest.json"
            if manifest_path.exists():
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        providers[provider] = {
            **provider_payload,
            "status": status,
            "latency_seconds": project_latency_seconds(provider_payload.get("started_at"), status),
            "render_status": manifest.get("render_status"),
            "completed_scene_count": manifest.get("completed_scene_count"),
            "failed_scene_count": manifest.get("failed_scene_count"),
            "final_video_path": manifest.get("final_video_path"),
            "final_video_url": manifest.get("final_video_url"),
        }

    return {
        "review_id": payload["review_id"],
        "prompt": payload["prompt"],
        "created_at": payload["created_at"],
        "updated_at": payload["updated_at"],
        "settings": payload["settings"],
        "metadata": payload.get("metadata") or {},
        "providers": providers,
    }


def youtube_review_batch_response(payload: dict[str, Any]) -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    for item in payload.get("items") or []:
        review_payload = read_youtube_review_session(str(item["review_id"]))
        items.append(
            {
                **item,
                "review": youtube_review_session_response(review_payload) if review_payload is not None else None,
            }
        )
    return {
        "batch_id": payload["batch_id"],
        "prompt_set_path": payload["prompt_set_path"],
        "created_at": payload["created_at"],
        "updated_at": payload["updated_at"],
        "items": items,
    }


def context(project_id: str, request: CreateProjectRequest) -> ProjectContext:
    return ProjectContext(
        project_id=project_id,
        project_dir=project_dir_for(project_id),
        aspect_ratio=request.aspect_ratio,
        resolution=request.video_resolution or request.resolution,
        magic_hour_api_key=ENV.get("MAGIC_HOUR_API_KEY", ""),
        fish_audio_api_key=ENV.get("FISH_AUDIO_API_KEY", ""),
        fish_audio_reference_id=ENV.get("FISH_AUDIO_REFERENCE_ID", ""),
        image_model=request.image_model or default_magic_hour_image_model(),
        image_resolution=request.image_resolution or ENV.get("MAGIC_HOUR_IMAGE_RESOLUTION", default_image_resolution(request.resolution)),
        image_style_tool=ENV.get("MAGIC_HOUR_IMAGE_STYLE_TOOL", "general"),
        video_model=request.video_model or default_magic_hour_video_model(),
        video_audio=ENV.get("MAGIC_HOUR_VIDEO_AUDIO", "false").lower() in {"1", "true", "yes"},
        audio_model=ENV.get("FISH_AUDIO_MODEL", "s2-pro"),
        audio_format=ENV.get("FISH_AUDIO_FORMAT", "mp3"),
    )


def context_for_existing_project(project_id: str) -> ProjectContext:
    project_dir = project_dir_for(project_id)
    state_ctx = ProjectContext(project_id=project_id, project_dir=project_dir, aspect_ratio="", resolution="")
    state = read_project_state(state_ctx)
    preferences = state.get("user_preferences") or {}
    providers = state.get("provider_settings") or {}
    return ProjectContext(
        project_id=project_id,
        project_dir=project_dir,
        aspect_ratio=str(providers.get("aspect_ratio") or preferences.get("aspect_ratio") or "9:16"),
        resolution=str(providers.get("resolution") or preferences.get("resolution") or "720p"),
        magic_hour_api_key=ENV.get("MAGIC_HOUR_API_KEY", ""),
        fish_audio_api_key=ENV.get("FISH_AUDIO_API_KEY", ""),
        fish_audio_reference_id=ENV.get("FISH_AUDIO_REFERENCE_ID", ""),
        image_model=str(providers.get("image_model") or default_magic_hour_image_model()),
        image_resolution=str(
            providers.get("image_resolution")
            or ENV.get("MAGIC_HOUR_IMAGE_RESOLUTION", default_image_resolution(str(providers.get("resolution") or preferences.get("resolution") or "720p")))
        ),
        image_style_tool=str(providers.get("image_style_tool") or ENV.get("MAGIC_HOUR_IMAGE_STYLE_TOOL", "general")),
        video_model=str(providers.get("video_model") or default_magic_hour_video_model()),
        video_audio=bool(providers.get("video_audio") or ENV.get("MAGIC_HOUR_VIDEO_AUDIO", "false").lower() in {"1", "true", "yes"}),
        audio_model=str(providers.get("audio_model") or ENV.get("FISH_AUDIO_MODEL", "s2-pro")),
        audio_format=str(providers.get("audio_format") or ENV.get("FISH_AUDIO_FORMAT", "mp3")),
    )


def default_image_resolution(video_resolution: str) -> MagicImageResolution:
    return {"480p": "640px", "720p": "1k", "1080p": "2k"}.get(video_resolution, "1k")  # type: ignore[return-value]


def explicit_magic_hour_default(value: str | None, fallback: str) -> str:
    configured = (value or "").strip()
    if not configured or configured == "default":
        return fallback
    return configured


def default_magic_hour_image_model() -> str:
    return explicit_magic_hour_default(ENV.get("MAGIC_HOUR_IMAGE_MODEL"), DEFAULT_MAGIC_HOUR_IMAGE_MODEL)


def default_magic_hour_video_model() -> str:
    return explicit_magic_hour_default(ENV.get("MAGIC_HOUR_VIDEO_MODEL"), DEFAULT_MAGIC_HOUR_VIDEO_MODEL)


def configured_agent_max_turns() -> int:
    raw = ENV.get("OPENAI_AGENT_MAX_TURNS")
    if not raw:
        return DEFAULT_AGENT_MAX_TURNS
    try:
        return max(11, min(int(raw), 80))
    except ValueError:
        logger.warning("Ignoring invalid OPENAI_AGENT_MAX_TURNS override: %s", raw)
        return DEFAULT_AGENT_MAX_TURNS


def user_preferences_for_request(request: CreateProjectRequest) -> dict[str, Any]:
    return request.model_dump(mode="json")


def bool_setting(value: Any, *, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)


def provider_settings_for_context(ctx: ProjectContext) -> dict[str, Any]:
    return {
        "image_model": ctx.image_model,
        "image_resolution": ctx.image_resolution,
        "image_style_tool": ctx.image_style_tool,
        "video_model": ctx.video_model,
        "video_resolution": ctx.resolution,
        "video_audio": ctx.video_audio,
        "audio_model": ctx.audio_model,
        "audio_format": ctx.audio_format,
        "aspect_ratio": ctx.aspect_ratio,
        "resolution": ctx.resolution,
    }


def _positive_int(value: Any) -> int | None:
    try:
        parsed = int(float(value))
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _probe_video_dimensions(path: str | Path) -> tuple[int, int] | None:
    video_path = Path(path)
    if not video_path.exists():
        return None
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height",
                "-of",
                "json",
                str(video_path),
            ],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    try:
        payload = json.loads(result.stdout or "{}")
    except json.JSONDecodeError:
        return None
    streams = payload.get("streams")
    if not isinstance(streams, list) or not streams:
        return None
    stream = streams[0] if isinstance(streams[0], dict) else {}
    width = _positive_int(stream.get("width"))
    height = _positive_int(stream.get("height"))
    if width is None or height is None:
        return None
    return width, height


def _video_asset_dimensions(video: dict[str, Any]) -> tuple[int, int] | None:
    width = _positive_int(video.get("source_width") or video.get("width"))
    height = _positive_int(video.get("source_height") or video.get("height"))
    if width is not None and height is not None:
        return width, height
    path = video.get("path")
    if not path:
        return None
    return _probe_video_dimensions(str(path))


def _aspect_ratio_for_dimensions(width: int, height: int) -> AspectRatio:
    if abs(width - height) <= max(width, height) * 0.05:
        return "1:1"
    if height > width:
        return "9:16"
    return "16:9"


def infer_youtube_output_aspect_ratio(
    videos: list[dict[str, Any]],
    *,
    default_aspect_ratio: AspectRatio,
) -> AspectRatio:
    votes: dict[AspectRatio, int] = {"9:16": 0, "16:9": 0, "1:1": 0}
    first_detected: AspectRatio | None = None
    for video in videos:
        dimensions = _video_asset_dimensions(video)
        if dimensions is None:
            continue
        aspect_ratio = _aspect_ratio_for_dimensions(*dimensions)
        if first_detected is None:
            first_detected = aspect_ratio
        votes[aspect_ratio] += 1
    if first_detected is None:
        return default_aspect_ratio
    max_votes = max(votes.values())
    winners = {aspect_ratio for aspect_ratio, count in votes.items() if count == max_votes}
    if len(winners) == 1:
        return next(iter(winners))
    return first_detected


def initialize_project_state(ctx: ProjectContext, request: CreateProjectRequest) -> dict[str, Any]:
    return write_initial_project_state(
        ctx,
        user_preferences=user_preferences_for_request(request),
        provider_settings={
            **provider_settings_for_context(ctx),
            "workflow": request.workflow,
            "youtube_search_provider": request.youtube_search_provider,
            "youtube_allow_provider_fallback": request.youtube_allow_provider_fallback,
        },
    )


def ensure_project_state(ctx: ProjectContext, request: CreateProjectRequest) -> dict[str, Any]:
    if artifact_path(ctx, "project_state").exists():
        return read_project_state(ctx)
    return initialize_project_state(ctx, request)


def count_spoken_words(text: str) -> int:
    return len(WORD_PATTERN.findall(strip_fish_audio_expression_cues(text)))


def fish_audio_expression_cues(text: str) -> list[str]:
    return FISH_AUDIO_BRACKET_CUE_PATTERN.findall(text)


def strip_fish_audio_expression_cues(text: str) -> str:
    without_bracket_cues = FISH_AUDIO_BRACKET_CUE_PATTERN.sub(" ", text)
    return FISH_AUDIO_LEGACY_PAREN_CUE_PATTERN.sub(" ", without_bracket_cues)


def compact_words(text: str, max_words: int) -> str:
    cleaned = " ".join(text.split())
    words = cleaned.split()
    if len(words) <= max_words:
        return cleaned
    return " ".join(words[:max_words]).rstrip(" ,;:") + "."


def clamped_float(value: float, lower: float, upper: float) -> float:
    return max(lower, min(value, upper))


def configured_tts_words_per_second() -> float | None:
    raw = ENV.get("FISH_AUDIO_WORDS_PER_SECOND") or ENV.get("TTS_WORDS_PER_SECOND")
    if not raw:
        return None
    try:
        return clamped_float(float(raw), MIN_TTS_WORDS_PER_SECOND, MAX_TTS_WORDS_PER_SECOND)
    except ValueError:
        logger.warning("Ignoring invalid TTS words-per-second override: %s", raw)
        return None


def estimate_tts_words_per_second(audio_model: str, output_dir: Path | None = None) -> float:
    configured = configured_tts_words_per_second()
    if configured is not None:
        return round(configured, 2)

    samples: list[float] = []
    root = output_dir or OUTPUT_DIR
    if root.exists():
        for manifest_path in root.glob("*/manifest.json"):
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                if manifest.get("audio_model") != audio_model:
                    continue
                narration = str((manifest.get("plan") or {}).get("narration") or manifest.get("narration") or "")
                word_count = count_spoken_words(narration)
                if word_count < 10:
                    continue
                voiceover_path = (manifest.get("voiceover") or {}).get("path")
                if not voiceover_path:
                    continue
                voiceover_file = Path(voiceover_path)
                if not voiceover_file.is_absolute():
                    voiceover_file = manifest_path.parent / voiceover_file
                if not voiceover_file.exists():
                    continue
                duration = probe_media_duration(voiceover_file)
                if duration < 3:
                    continue
                samples.append(word_count / duration)
            except Exception as exc:
                logger.debug("Skipping TTS calibration sample %s: %s", manifest_path, exc)

    if not samples:
        fallback = float(ENV.get("FISH_AUDIO_DEFAULT_WORDS_PER_SECOND", DEFAULT_TTS_WORDS_PER_SECOND))
        return round(clamped_float(fallback, MIN_TTS_WORDS_PER_SECOND, MAX_TTS_WORDS_PER_SECOND), 2)

    samples.sort()
    midpoint = len(samples) // 2
    if len(samples) % 2:
        median = samples[midpoint]
    else:
        median = (samples[midpoint - 1] + samples[midpoint]) / 2
    return round(clamped_float(median, MIN_TTS_WORDS_PER_SECOND, MAX_TTS_WORDS_PER_SECOND), 2)


def prompt_number_value(value: str) -> int | None:
    if value.isdigit():
        return int(value)
    return PROMPT_NUMBER_WORDS.get(value.lower())


def bounded_prompt_count(value: int | None) -> int | None:
    if value is None or value < 1 or value > 10:
        return None
    return value


def extract_prompt_duration(prompt: str) -> tuple[int, bool] | None:
    under_match = PROMPT_DURATION_UNDER_PATTERN.search(prompt)
    if under_match:
        duration = int(under_match.group(1))
        if 1 <= duration <= 60:
            return duration, True

    duration_match = PROMPT_DURATION_PATTERN.search(prompt)
    if not duration_match:
        return None
    duration = int(duration_match.group(1))
    if 1 <= duration <= 60:
        return duration, False
    return None


def extract_prompt_scene_constraint(prompt: str) -> tuple[SceneConstraintMode, int | None] | None:
    for pattern in PROMPT_EXACT_SCENE_PATTERNS:
        exact_match = pattern.search(prompt)
        if exact_match:
            count = bounded_prompt_count(prompt_number_value(exact_match.group("count")))
            if count is not None:
                return "exact", count

    minimum_match = PROMPT_MIN_SCENE_PATTERN.search(prompt)
    if minimum_match:
        count = bounded_prompt_count(prompt_number_value(minimum_match.group("count")))
        if count is not None:
            return "minimum", count

    if any(pattern.search(prompt) for pattern in PROMPT_AGENT_DECIDES_SCENE_PATTERNS):
        return "agent_decides", None

    return None


def resolve_generation_constraints(request: CreateProjectRequest) -> GenerationConstraints:
    prompt_duration = extract_prompt_duration(request.prompt)
    if prompt_duration is not None:
        duration_seconds, duration_is_upper_bound = prompt_duration
        duration_source: Literal["prompt", "request", "auto"] = "prompt"
    elif request.duration_seconds is not None:
        duration_seconds = request.duration_seconds
        duration_is_upper_bound = False
        duration_source = "request"
    else:
        duration_seconds = DEFAULT_AUTO_DURATION_SECONDS
        duration_is_upper_bound = False
        duration_source = "auto"

    prompt_scene_constraint = extract_prompt_scene_constraint(request.prompt)
    if prompt_scene_constraint is not None:
        scene_mode, scene_count = prompt_scene_constraint
        scene_source: Literal["prompt", "request", "auto"] = "prompt"
    elif request.scene_count is not None:
        scene_mode = "exact"
        scene_count = request.scene_count
        scene_source = "request"
    else:
        scene_mode = "agent_decides"
        scene_count = None
        scene_source = "auto"

    scene_budget_count = scene_count if scene_count is not None else DEFAULT_AUTO_SCENE_BUDGET_COUNT
    return GenerationConstraints(
        duration_seconds=duration_seconds,
        duration_source=duration_source,
        duration_is_upper_bound=duration_is_upper_bound,
        scene_mode=scene_mode,
        scene_count=scene_count,
        scene_source=scene_source,
        scene_budget_count=scene_budget_count,
    )


def speech_budget_for_request(request: CreateProjectRequest, ctx: ProjectContext) -> SpeechBudget:
    constraints = resolve_generation_constraints(request)
    words_per_second = estimate_tts_words_per_second(ctx.audio_model)
    raw_scene_duration = constraints.duration_seconds + max(constraints.scene_budget_count - 1, 0) * SCENE_CROSSFADE_SECONDS
    min_words = max(4, math.floor(constraints.duration_seconds * words_per_second * NARRATION_MIN_FACTOR))
    max_words = max(min_words + 1, math.ceil(constraints.duration_seconds * words_per_second * NARRATION_MAX_FACTOR))
    return SpeechBudget(
        words_per_second=words_per_second,
        min_words=min_words,
        max_words=max_words,
        scene_duration_total_seconds=raw_scene_duration,
        final_duration_seconds=constraints.duration_seconds,
    )


def request_from_project_state(ctx: ProjectContext) -> CreateProjectRequest | None:
    preferences = read_project_state(ctx).get("user_preferences") or {}
    if not preferences:
        return None
    try:
        return CreateProjectRequest.model_validate(preferences)
    except ValidationError:
        logger.warning("Ignoring invalid saved request preferences for %s", ctx.project_id)
        return None


def explicit_target_final_duration_seconds_for_project(ctx: ProjectContext) -> int | None:
    request = request_from_project_state(ctx)
    if request is None:
        return None
    constraints = resolve_generation_constraints(request)
    if constraints.duration_source == "auto":
        return None
    return constraints.duration_seconds


def magic_hour_model_catalog_for_agent() -> str:
    return "\n".join(
        [
            "Magic Hour image models:",
            "- seedream-v4: detailed cinematic keyframes with strong descriptive prompt adherence at 640px/1k/2k/4k; default for this app.",
            "- default: Magic Hour recommended image model; do not use unless the user explicitly asks for Magic Hour's default.",
            "- flux-schnell: low-cost fast drafts at 640px/1k/2k.",
            "- z-image-turbo: low-cost fast drafts at 640px/1k/2k.",
            "- nano-banana: higher-cost image model for polished creative output at 640px/1k.",
            "- nano-banana-2: higher-cost model with broader image counts and up to 4k.",
            "- nano-banana-pro: highest-cost professional image model at 1k/2k/4k.",
            "Magic Hour image-to-video models:",
            "- ltx-2.3: default for this app; fast iteration with audio, lip-sync, and end frame support; supports 1-10/15/20/25/30 second clips and 480p/720p/1080p.",
            "- ltx-2: older fast-iteration LTX option with the same I2V duration and resolution set.",
            "- default: Magic Hour recommended video model; do not use unless the user explicitly asks for Magic Hour's default.",
            "- wan-2.2: fast strong visuals/effects, supports 3-10/15 second clips and 480p/720p/1080p.",
            "- seedance: fast iteration, supports 2-12 second clips and 480p/720p/1080p.",
            "- seedance-2.0: quality and consistency, supports 4-15 second clips and 480p/720p.",
            "- kling-2.5: motion/action/camera control, supports 5 or 10 second clips and 720p/1080p.",
            "- kling-3.0: cinematic multi-shot storytelling, supports 3-15 second clips and 720p/1080p.",
            "- sora-2: story-first creativity, supports 4/8/12/24/36/48/60 second clips and 720p.",
            "- veo3.1: realistic visuals and prompt adherence, supports 4/6/8/16/24/32/40/48/56 second clips and 720p/1080p.",
            "- veo3.1-lite: faster affordable high-quality video, supports 8/16/24/32/40/48/56 second clips and 720p/1080p.",
            "Supported I2V durations and resolutions are model-specific; choose scene durations and tool parameters that match the selected video model.",
        ]
    )


def duration_constraint_line(constraints: GenerationConstraints) -> str:
    if constraints.duration_source == "prompt":
        if constraints.duration_is_upper_bound:
            return f"Prompt duration constraint: under {constraints.duration_seconds} seconds. Treat this as a hard upper bound."
        return f"Prompt duration constraint: {constraints.duration_seconds} seconds. This overrides UI/default duration controls."
    if constraints.duration_source == "request":
        return f"User-selected duration constraint: {constraints.duration_seconds} seconds."
    return f"Duration constraint: agent decides. Use a compact {constraints.duration_seconds}-second budget unless the prompt demands different pacing."


def image_model_policy_line(request: CreateProjectRequest, ctx: ProjectContext) -> str:
    if request.image_model:
        return f"User-selected image model: {request.image_model}."
    return f"Default image model: {ctx.image_model}. Use another image model only if the user explicitly asks or the prompt clearly needs that model-specific capability."


def video_model_policy_line(request: CreateProjectRequest, ctx: ProjectContext) -> str:
    if request.video_model:
        return f"User-selected image-to-video model: {request.video_model}."
    return f"Default image-to-video model: {ctx.video_model}. Use another model only if the user explicitly asks or the prompt clearly needs that model-specific capability."


def scene_constraint_line(constraints: GenerationConstraints) -> str:
    if constraints.scene_mode == "exact" and constraints.scene_count is not None:
        return f"Scene count constraint: exactly {constraints.scene_count} scenes."
    if constraints.scene_mode == "minimum" and constraints.scene_count is not None:
        return f"Scene count constraint: at least {constraints.scene_count} scenes or stages."
    return "Scene count constraint: agent decides. Choose the count needed for clarity, usually 3-5 scenes."


def build_generation_brief(request: CreateProjectRequest, ctx: ProjectContext) -> str:
    constraints = resolve_generation_constraints(request)
    budget = speech_budget_for_request(request, ctx)
    return "\n".join(
        [
            f"Prompt: {request.prompt}",
            f"Aspect ratio: {request.aspect_ratio}",
            f"Resolution: {request.resolution}",
            image_model_policy_line(request, ctx),
            f"User-selected image resolution: {request.image_resolution or 'agent chooses'}.",
            video_model_policy_line(request, ctx),
            f"User-selected video resolution: {request.video_resolution or request.resolution}.",
            duration_constraint_line(constraints),
            scene_constraint_line(constraints),
            "Prompt constraints are authoritative: preserve exact counts, minimum stages, prohibitions, metaphors, start/end anchors, and lighting requirements from the prompt.",
            f"Target final runtime: {budget.final_duration_seconds} seconds after crossfades.",
            f"Scene duration total: {budget.scene_duration_total_seconds:.1f} seconds before crossfades.",
            f"Estimated Fish Audio pace: {budget.words_per_second:.2f} words/second.",
            f"Narration budget: {budget.min_words}-{budget.max_words} spoken words.",
            (
                "Narration is spoken voiceover copy for Fish Audio. Tell a compact story with character intention, "
                "obstacle, change, and payoff. Do not write narration as image prompt prose, not camera direction, "
                "and not a production note; keep visual inventory in image_prompt instead."
            ),
            (
                "Fish Audio S2 expression cues: include bracketed natural-language cues at sentence starts, "
                "such as [whispers softly], [speaks calmly], [curious], [tense], [laughs quietly], or [emphasis]. "
                "These cue tokens are not spoken words; keep the spoken words within budget."
            ),
            f"Scene duration formula: total scene seconds should equal final runtime + {SCENE_CROSSFADE_SECONDS:.1f} seconds for each transition between scenes.",
            "Set scene durations as integers that total as close as possible to the scene duration total.",
            "Each image_prompt should be concrete: subject, setting, light, composition, style, mood, and important visual details.",
            "For recurring characters, every image_prompt must repeat the full identity and outfit details; do not rely on relative wording like 'same woman' because each still image is generated independently.",
            "Put the complete recurring character identity in visual_bible so provider prompts can carry it into every independent image generation.",
            "Each video_prompt must describe only camera or subject motion that can happen in the current still image.",
            "Keep image_prompt under 75 words and video_prompt under 35 words.",
            "",
            magic_hour_model_catalog_for_agent(),
        ]
    )


YOUTUBE_SCRIPT_SYSTEM_PROMPT = """
You are a professional scriptwriter for an automated YouTube clip assembly pipeline.

Write a production-ready short-form script where every section can be matched to real YouTube footage.
The downstream tool only needs section dialogue, duration_seconds, and search_hint.

Section timing rules:
- If the user asks for a scene count, use exactly that many sections.
- Otherwise, duration less than or equal to eighteen seconds: two equal sections.
- Nineteen to twenty-four seconds: three equal sections.
- Twenty-five to twenty-eight seconds: four equal sections.
- Twenty-nine seconds: five sections at about five point eight seconds each.
- Thirty seconds: exactly five six-second sections.
- Thirty-one to forty seconds: five or six sections at about six to seven seconds each.
- More than forty seconds: use about one section per six point five seconds.
- Keep section durations contiguous in spirit and make the total close to the requested runtime.

Dialogue rules:
- Keep dialogue natural, neutral, informative, and creator-like.
- Open with a strong hook and speak directly to "you" only when it fits the subject.
- Mix punchy one-liners with slightly longer lines.
- End with one concrete payoff or next step.
- Write all numbers as words in dialogue.
- Do not write camera direction, production notes, or visual descriptions as dialogue.

Search hint rules:
- Write concise, human-like YouTube search queries in six to eight words or fewer when possible.
- Use literal visual nouns for generic scene-setting footage; never add stock, stock video, stock footage, watermark, or preview-source terms.
- Prefer genuine YouTube videos from creators, official channels, news outlets, institutions, or documentary-style uploads over source-library preview clips.
- For specific people, brands, events, logos, games, keynotes, or real-world moments, keep the query literal and do not add a stock suffix.
- Match each search hint closely to its dialogue and the requested visual beat.
- Do not put duration, aspect ratio, scene-count instructions, or "make/create/use scenes" in search_hint.

Search targeting rules (per section, all optional — set them only when they sharpen retrieval):
- These fields map directly to YouTube Data API search parameters; use them instead of stuffing qualifiers into search_hint.
- search_order: "date" for breaking or recent coverage, "viewCount" for iconic widely-seen moments, "relevance" otherwise. Leave unset when unsure.
- published_after / published_before (YYYY-MM-DD): bound the upload window for time-anchored events, for example a product launch, a game, or a news cycle. Use both to pin a historical event to its era and avoid modern retrospectives.
- video_duration: "short" (under four minutes) for clips and highlights, "medium" (four to twenty minutes) for typical coverage, "long" for keynotes, full games, or documentaries.
- video_category: set when the subject clearly belongs to one category, for example news_politics for current events, sports for game footage, science_technology for tech launches, education for explainers.
- require_captions: set true when the scene depends on spoken content being findable in the transcript; leave false for visual b-roll where captions do not matter.
- channel_hint: name the channel or outlet whose footage is wanted when the source matters, for example "OpenAI" for official product demos, "NFL" for game action, "Apple" for keynote footage. The backend folds it into search and prefers matching channels.
- candidate_video_urls: for EVERY scene, run a dedicated web search for the footage itself, such as "<scene topic> youtube", "<event> official video youtube", or "<subject> footage youtube", and put up to three direct YouTube watch URLs from the results here, best match first. URLs must be on youtube.com or youtu.be (a watch, shorts, or live link with a video id); links to other sites are discarded even when they host the same footage, so when search returns an off-platform video page, search again with "youtube" added to find the YouTube upload of it. These are tried before any YouTube search and are far cheaper, so always provide them. For specific moments (a named event, play, demo, keynote, launch) prefer canonical uploads from the right channel; for b-roll scenes prefer videos whose title clearly shows the needed visuals and that likely have spoken narration matching the topic. Only include URLs that actually appeared in web search results; never invent or guess URLs from memory.

Currentness rules:
- Decide whether the prompt depends on information that may have changed after model training.
- If it asks for latest, today, current, breaking, news, recent products, model releases, public figures, sports, prices, laws, safety guidance, or other time-sensitive facts, use WebSearchTool before naming a specific current product, event, date, or claim.
- For stable historical, fictional, evergreen educational, or purely visual prompts, do not use web search.
- If no verified current detail is available, keep the dialogue source-oriented and make search hints target official or reputable current-source footage rather than inventing a product name.
- Web search is also your footage finder: for every scene, search for the video itself (for example "<scene topic> youtube"), even when the dialogue facts need no verification, and record the resulting YouTube links in that scene's candidate_video_urls.
""".strip()


def build_youtube_script_prompt(request: CreateProjectRequest, ctx: ProjectContext) -> str:
    constraints = resolve_generation_constraints(request)
    budget = speech_budget_for_request(request, ctx)
    scene_count = (
        str(constraints.scene_count)
        if constraints.scene_count is not None and constraints.scene_mode == "exact"
        else "planner chooses by timing rules"
    )
    return "\n".join(
        [
            YOUTUBE_SCRIPT_SYSTEM_PROMPT,
            "",
            f"Current date: {datetime.now(timezone.utc).date().isoformat()}",
            f"Prompt: {request.prompt}",
            f"Target runtime seconds: {budget.final_duration_seconds}",
            f"Requested scene count: {scene_count}",
            f"Aspect ratio: {request.aspect_ratio}",
            f"Resolution: {request.resolution}",
            f"Spoken narration budget: {budget.min_words}-{budget.max_words} words total across all section dialogue.",
            "Return a concise title, web_search_needed, web_search_reason, and ordered sections only.",
        ]
    )


def normalize_youtube_script_plan(plan: YouTubeScriptPlan) -> YouTubeScriptPlan:
    sections: list[YouTubeClipSection] = []
    for index, section in enumerate(plan.sections, start=1):
        sections.append(
            section.model_copy(
                update={
                    "section": index,
                    "dialogue": re.sub(r"\s+", " ", section.dialogue).strip(),
                    "search_hint": compact_search_query(section.search_hint),
                    "duration_seconds": max(1, min(30, int(round(section.duration_seconds)))),
                }
            )
        )
    title = re.sub(r"\s+", " ", plan.title).strip() or "YouTube Short"
    return YouTubeScriptPlan(
        title=title[:120],
        web_search_needed=plan.web_search_needed,
        web_search_reason=plan.web_search_reason[:300],
        sections=sections,
    )


def youtube_script_narration(plan: YouTubeScriptPlan) -> str:
    return " ".join(section.dialogue.strip() for section in plan.sections if section.dialogue.strip())


def is_factual_youtube_prompt(prompt: str) -> bool:
    if not FACTUAL_YOUTUBE_PROMPT_PATTERN.search(prompt):
        return False
    if HISTORICAL_YOUTUBE_PROMPT_PATTERN.search(prompt) and not re.search(
        r"\b(latest|today|tonight|current|breaking|news)\b",
        prompt,
        re.IGNORECASE,
    ):
        return False
    return True


def important_factual_subject_tokens(prompt: str) -> set[str]:
    return {
        token.lower()
        for token in WORD_PATTERN.findall(prompt)
        if len(token) >= 3 and token.lower() not in FACTUAL_SUBJECT_STOPWORDS
    }


def compact_search_query(query: str, max_length: int = 120) -> str:
    cleaned = re.sub(r"\s+", " ", query).strip(" ,;-")
    if len(cleaned) <= max_length:
        return cleaned
    clipped = cleaned[:max_length].rsplit(" ", 1)[0].strip(" ,;-")
    return clipped or cleaned[:max_length].strip()


def dedupe_query_words(query: str) -> str:
    seen: set[str] = set()
    words: list[str] = []
    for word in WORD_PATTERN.findall(query):
        key = word.lower()
        if key in seen:
            continue
        seen.add(key)
        words.append(word)
    return " ".join(words)


def extract_openai_product_terms(text: str) -> list[str]:
    terms: list[str] = []
    for match in OPENAI_PRODUCT_TERM_PATTERN.finditer(text):
        term = re.sub(r"\s+", " ", match.group(1)).strip()
        key = term.lower()
        if key not in {existing.lower() for existing in terms}:
            terms.append(term)
    return terms


def has_openai_product_term(text: str) -> bool:
    return bool(OPENAI_PRODUCT_TERM_PATTERN.search(text))


def is_openai_youtube_prompt(prompt: str) -> bool:
    return "openai" in prompt.lower() or has_openai_product_term(prompt)


def enrich_openai_product_query(query: str, product_terms: list[str]) -> str:
    enriched = query
    for term in product_terms[:2]:
        if re.search(rf"\b{re.escape(term)}\b", enriched, re.IGNORECASE):
            continue
        if re.search(r"\bOpenAI\b", enriched, re.IGNORECASE):
            enriched = re.sub(r"\bOpenAI\b", f"OpenAI {term}", enriched, count=1, flags=re.IGNORECASE)
        else:
            enriched = f"OpenAI {term} {enriched}"
    return compact_search_query(dedupe_query_words(enriched))


def compact_openai_product_hint(source_prompt: str, hint: str) -> str:
    compacted = video_friendly_openai_search_hint(hint)
    if "openai" in source_prompt.lower() and not re.search(r"\bOpenAI\b", compacted, re.IGNORECASE):
        compacted = f"OpenAI {compacted}"
    allows_reputable_sources = openai_prompt_allows_reputable_sources(source_prompt)
    if (
        re.search(r"\b(?:official|reputable)\b", source_prompt, re.IGNORECASE)
        and not re.search(r"\b(?:official|reuters|cnbc|associated press|ap news|the verge|techcrunch)\b", compacted, re.IGNORECASE)
    ):
        compacted = f"{compacted} {'news' if allows_reputable_sources else 'official'}"
    return compact_search_query(dedupe_query_words(compacted))


def openai_prompt_allows_reputable_sources(source_prompt: str) -> bool:
    return bool(re.search(r"\bofficial\s+or\s+reputable\b|\breputable\s+(?:sources?|coverage)\b", source_prompt, re.IGNORECASE))


def is_current_openai_source_prompt(source_prompt: str) -> bool:
    return "openai" in source_prompt.lower() and bool(
        re.search(r"\b(?:latest|today|tonight|current|breaking|recent|news)\b", source_prompt, re.IGNORECASE)
    )


def preserve_current_openai_freshness(source_prompt: str, query: str) -> str:
    cleaned = compact_search_query(query)
    if not is_current_openai_source_prompt(source_prompt):
        return cleaned
    if re.search(r"\b(?:latest|today|tonight|current|breaking|recent)\b", cleaned, re.IGNORECASE):
        return cleaned
    return compact_search_query(dedupe_query_words(f"latest {cleaned}"))


def video_friendly_openai_search_hint(hint: str) -> str:
    cleaned = compact_search_query(hint)
    cleaned = re.sub(r"\brelease\s+notes?\b", "update", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\b(?:newsroom|homepage|scroll(?:ing)?)\b", " ", cleaned, flags=re.IGNORECASE)
    cleaned = compact_search_query(dedupe_query_words(cleaned))
    if cleaned.lower() in {"openai", "chatgpt", "openai chatgpt"}:
        cleaned = compact_search_query(f"{cleaned} latest product news")
    return cleaned


def concise_youtube_search_query(text: str) -> str:
    cleaned = compact_search_query(text)
    cleaned = re.split(r"\.\s+", cleaned, maxsplit=1)[0]
    cleaned = re.sub(r"\bUse\s+(?:exactly\s+)?(?:\d{1,2}|one|two|three|four|five)\s+scenes?\b.*$", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\bThe\s+narration\s+should\b.*$", "", cleaned, flags=re.IGNORECASE)
    source_clause = ""
    using_match = re.search(r"\busing\b", cleaned, re.IGNORECASE)
    if using_match:
        source_clause = cleaned[using_match.start() :]
        cleaned = cleaned[: using_match.start()]
    cleaned = YOUTUBE_CREATION_PREFIX_PATTERN.sub("", cleaned).strip(" ,;-")
    cleaned = GENERIC_YOUTUBE_BROLL_PATTERN.sub(" ", cleaned).strip(" ,;-")
    source_clause = YOUTUBE_SOURCE_FILLER_PATTERN.sub(" ", source_clause).strip(" ,;-")
    combined = compact_search_query(f"{cleaned} {source_clause}")
    if (
        re.search(r"\bofficial\b", source_clause, re.IGNORECASE)
        and re.search(r"\bproduct\b", combined, re.IGNORECASE)
        and not re.search(r"\b(?:demo|announcement)\b", combined, re.IGNORECASE)
    ):
        combined = compact_search_query(f"{combined} demo")
    return compact_search_query(dedupe_query_words(combined))


def looks_like_youtube_creation_instruction(hint: str) -> bool:
    return bool(
        re.search(r"\b(?:make|create|generate|build)\b", hint, re.IGNORECASE)
        and re.search(r"\b(?:youtube|clips?|short|video|reel|seconds?|scenes?)\b", hint, re.IGNORECASE)
    )


def clean_section_search_hint(section: YouTubeClipSection) -> str:
    hint = section.search_hint
    if looks_like_youtube_creation_instruction(hint):
        cleaned_instruction = concise_youtube_search_query(hint)
        if cleaned_instruction:
            return cleaned_instruction
        hint = section.dialogue
    cleaned = concise_youtube_search_query(hint)
    return cleaned or compact_search_query(section.dialogue)


def carry_source_subject_terms(source_prompt: str, search_hint: str) -> str:
    hint = compact_search_query(search_hint)
    prompt_lower = source_prompt.lower()
    hint_lower = hint.lower()
    if re.search(r"\bancient coins?\b", prompt_lower) and re.search(r"\bcoins?\b", hint_lower) and "ancient" not in hint_lower:
        return compact_search_query(re.sub(r"\bcoins?\b", "ancient coin", hint, count=1, flags=re.IGNORECASE))
    if "deep sea" in prompt_lower and "deep sea" not in hint_lower and re.search(
        r"\b(?:ocean|marine|underwater|submersible|rov|squid|jellyfish|researchers?|footage)\b",
        hint_lower,
    ):
        return compact_search_query(f"deep sea {hint}")
    if "saquon barkley" in prompt_lower and not re.search(r"\b(?:saquon|barkley)\b", hint_lower) and re.search(
        r"\b(?:eagles|rams|jaguars|packers|touchdowns?|hurdle|season|highlights?)\b",
        hint_lower,
    ):
        return compact_search_query(f"Saquon Barkley {hint}")
    if "steve jobs" in prompt_lower and not re.search(r"\b(?:steve|jobs)\b", hint_lower) and re.search(
        r"\b(?:iphone|ipod|macworld|keynote|phone|internet communicator)\b",
        hint_lower,
    ):
        return compact_search_query(f"Steve Jobs {hint}")
    return hint


def unique_youtube_search_hint(base_hint: str, duplicate_index: int) -> str:
    if duplicate_index <= 0:
        return base_hint
    suffixes = (
        YOUTUBE_PRODUCT_DUPLICATE_HINT_SUFFIXES
        if re.search(r"\b(?:openai|product)\b", base_hint, re.IGNORECASE)
        else YOUTUBE_DUPLICATE_HINT_SUFFIXES
    )
    suffix = suffixes[(duplicate_index - 1) % len(suffixes)]
    return compact_search_query(dedupe_query_words(f"{base_hint} {suffix}"))


def dedupe_youtube_section_hints(sections: list[YouTubeClipSection]) -> list[YouTubeClipSection]:
    seen: dict[str, int] = {}
    normalized: list[YouTubeClipSection] = []
    for section in sections:
        key = section.search_hint.lower()
        duplicate_index = seen.get(key, 0)
        seen[key] = duplicate_index + 1
        normalized.append(section.model_copy(update={"search_hint": unique_youtube_search_hint(section.search_hint, duplicate_index)}))
    return normalized


def factual_youtube_search_hint(source_prompt: str, hint: str, product_terms: list[str] | None = None) -> str:
    prompt = concise_youtube_search_query(source_prompt)
    cleaned_hint = concise_youtube_search_query(hint) or prompt
    if "openai" in source_prompt.lower():
        cleaned_hint = video_friendly_openai_search_hint(cleaned_hint)
    if "openai" in source_prompt.lower() and has_openai_product_term(cleaned_hint):
        return preserve_current_openai_freshness(source_prompt, compact_openai_product_hint(source_prompt, cleaned_hint))
    should_enrich_openai_products = bool(product_terms) and not re.search(
        r"\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|20\d{2})\b",
        cleaned_hint,
        re.IGNORECASE,
    )
    if "openai" in source_prompt.lower() and should_enrich_openai_products:
        prompt = enrich_openai_product_query(prompt, product_terms)
        cleaned_hint = enrich_openai_product_query(cleaned_hint, product_terms)
        if has_openai_product_term(cleaned_hint):
            if openai_prompt_allows_reputable_sources(source_prompt) and not re.search(
                r"\b(news|official|press|update|briefing|local)\b",
                cleaned_hint,
                re.IGNORECASE,
            ):
                cleaned_hint = compact_search_query(f"{cleaned_hint} news")
            return preserve_current_openai_freshness(source_prompt, cleaned_hint)
    subject_tokens = important_factual_subject_tokens(prompt)
    hint_tokens = {token.lower() for token in WORD_PATTERN.findall(cleaned_hint)}
    if subject_tokens and not subject_tokens.issubset(hint_tokens):
        if not ("openai" in source_prompt.lower() and re.search(r"\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|20\d{2})\b", cleaned_hint, re.IGNORECASE)):
            cleaned_hint = compact_search_query(f"{prompt} {cleaned_hint}")
    if not re.search(r"\b(news|official|press|update|briefing|local)\b", cleaned_hint, re.IGNORECASE):
        cleaned_hint = compact_search_query(f"{cleaned_hint} news")
    return preserve_current_openai_freshness(source_prompt, cleaned_hint)


def normalize_youtube_sections_for_project(ctx: ProjectContext, sections: list[YouTubeClipSection]) -> list[YouTubeClipSection]:
    state = read_project_state(ctx)
    source_prompt = str((state.get("user_preferences") or {}).get("prompt") or "")
    if not source_prompt or not is_factual_youtube_prompt(source_prompt):
        cleaned_sections = [
            section.model_copy(
                update={
                    "search_hint": carry_source_subject_terms(
                        source_prompt,
                        clean_section_search_hint(section),
                    )
                }
            )
            for section in sections
        ]
        return dedupe_youtube_section_hints(cleaned_sections)
    product_terms: list[str] = []
    if "openai" in source_prompt.lower():
        for section in sections:
            product_terms.extend(extract_openai_product_terms(section.dialogue))
        product_terms = list(dict.fromkeys(product_terms))
    normalized = [
        section.model_copy(update={"search_hint": factual_youtube_search_hint(source_prompt, clean_section_search_hint(section), product_terms)})
        for section in sections
    ]
    return dedupe_youtube_section_hints(normalized)


def existing_youtube_manifest(ctx: ProjectContext) -> dict[str, Any] | None:
    manifest = read_json_artifact(ctx, "manifest", None)
    if not isinstance(manifest, dict) or manifest.get("workflow") != "youtube_clips":
        return None
    final_path = manifest.get("final_video_path")
    if not final_path or not Path(str(final_path)).is_file():
        return None
    if not manifest.get("videos"):
        return None
    return manifest


def build_youtube_workflow_brief(request: CreateProjectRequest, ctx: ProjectContext) -> str:
    constraints = resolve_generation_constraints(request)
    budget = speech_budget_for_request(request, ctx)
    lines = [
        "Workflow: youtube_clips.",
        "Create a short assembled from searched YouTube clips, current-project Fish voiceover, and ffmpeg stitching.",
        "You must call create_youtube_short_from_prompt exactly once. After it returns a manifest, stop and respond with a brief completion summary.",
        "Do not draft title, narration, or section JSON yourself; the YouTube tool contains the notebook-style script planner.",
        "Do not call create_youtube_short, draft_video_plan, generate_scene_images, animate_scene_videos, or stitch_final_video for this workflow.",
        f"Prompt: {request.prompt}",
        f"Aspect ratio: {request.aspect_ratio}",
        f"Resolution: {request.resolution}",
        "YouTube search provider: youtube_data_api. All clip search goes through the YouTube Data API.",
        duration_constraint_line(constraints),
        scene_constraint_line(constraints),
        f"Target final runtime: {budget.final_duration_seconds} seconds after crossfades.",
        f"Spoken narration budget: {budget.min_words}-{budget.max_words} words total across all section dialogue. This is a hard cap.",
        f"Scene duration formula: if using N sections, total section seconds should equal target runtime + {SCENE_CROSSFADE_SECONDS:.1f} seconds for each transition.",
    ]
    if is_factual_youtube_prompt(request.prompt):
        lines.extend(
            [
                "Factual/current-event YouTube mode is required.",
                "Use WebSearchTool first inside the prompt-based YouTube script planner before naming current products, events, dates, or claims.",
                "The generated search hints must preserve the factual subject from the user's prompt and verified current-event terms.",
                "Do not use generic b-roll terms like stock, vertical, shorts, police lights, or street scene unless they are part of a specific factual source query.",
            ]
        )
    else:
        lines.append("The prompt-based YouTube script planner will make literal search hints for real people/events/brands and genuine YouTube footage hints without stock or watermark terms.")
    lines.extend(
        [
            "The YouTube tool will draft the script, search hints, and section durations from the current project request.",
            "The tool will download clips, generate one Fish voiceover, save project_state.json artifacts, and write manifest.json.",
        ]
    )
    return "\n".join(lines)


def build_project_run_brief(request: CreateProjectRequest, ctx: ProjectContext) -> str:
    if request.workflow == "youtube_clips":
        return build_youtube_workflow_brief(request, ctx)
    return build_generation_brief(request, ctx)


def ensure_supported_image_options(model: str, resolution: str) -> None:
    if model not in MAGIC_IMAGE_MODELS:
        raise ValueError(f"Unsupported Magic Hour image model: {model}")
    if resolution not in MAGIC_IMAGE_RESOLUTIONS:
        raise ValueError(f"Unsupported Magic Hour image resolution: {resolution}")
    supported = MAGIC_IMAGE_MODEL_RESOLUTIONS.get(model)
    if supported is not None and resolution not in supported:
        raise ValueError(f"{model} supports image resolutions {sorted(supported)}, not {resolution}.")


def ensure_supported_video_options(model: str, resolution: str, scenes: list[Scene]) -> None:
    if model not in MAGIC_VIDEO_MODELS:
        raise ValueError(f"Unsupported Magic Hour image-to-video model: {model}")
    supported_resolutions = MAGIC_VIDEO_MODEL_RESOLUTIONS.get(model)
    if supported_resolutions is not None and resolution not in supported_resolutions:
        raise ValueError(f"{model} supports video resolutions {sorted(supported_resolutions)}, not {resolution}.")
    supported_durations = MAGIC_VIDEO_MODEL_DURATIONS.get(model)
    if supported_durations is None:
        return
    unsupported = [scene.duration_seconds for scene in scenes if scene.duration_seconds not in supported_durations]
    if unsupported:
        raise ValueError(
            f"{model} does not support scene duration(s) {sorted(set(unsupported))}. "
            f"Supported I2V durations: {sorted(supported_durations)}."
        )


def context_with_magic_image_settings(
    ctx: ProjectContext,
    *,
    model: str,
    image_resolution: str,
    image_style_tool: str,
) -> ProjectContext:
    ensure_supported_image_options(model, image_resolution)
    if image_style_tool not in MAGIC_IMAGE_STYLE_TOOLS:
        raise ValueError(f"Unsupported Magic Hour image style tool: {image_style_tool}")
    return replace(ctx, image_model=model, image_resolution=image_resolution, image_style_tool=image_style_tool)


def context_with_magic_video_settings(
    ctx: ProjectContext,
    *,
    model: str,
    resolution: str,
    audio: bool,
    scenes: list[Scene],
) -> ProjectContext:
    ensure_supported_video_options(model, resolution, scenes)
    return replace(ctx, video_model=model, resolution=resolution, video_audio=audio)


def compact_project_status_for_agent(status: dict[str, Any] | None) -> dict[str, Any]:
    if not status:
        return {}
    return {
        key: value
        for key, value in status.items()
        if key not in {"project_state"}
    }


def build_project_message_brief(project_id: str, message: str, ctx: ProjectContext) -> str:
    snapshot = {
        "project_state": read_project_state(ctx),
        "status": compact_project_status_for_agent(read_project_status(project_id)),
    }
    return "\n".join(
        [
            "A user sent a follow-up message for an existing video project.",
            "Keep the frontend separate; this is a backend agent turn over persisted project state.",
            "Do not start from scratch unless the user explicitly requests a new render.",
            "Inspect the saved project state and artifacts before deciding what to patch.",
            "Use revision tools for narrow changes, then restitch_video when the final edit changes.",
            f"Default image model: {ctx.image_model}. Use another image model only if the user explicitly asks or the prompt clearly needs that model-specific capability.",
            f"Default image-to-video model: {ctx.video_model}. Use another model only if the user explicitly asks or the prompt clearly needs that model-specific capability.",
            f"Project directory: {ctx.project_dir}",
            f"Project state file: {artifact_path(ctx, 'project_state')}",
            "",
            magic_hour_model_catalog_for_agent(),
            "",
            "User message:",
            message,
            "",
            "Current project snapshot JSON:",
            json.dumps(snapshot, indent=2, default=str),
        ]
    )


def agent_response_content(value: Any) -> str:
    if value is None:
        return "Agent turn completed."
    if isinstance(value, str):
        return value
    return json.dumps(value, indent=2, default=str)


def normalize_plan(plan: VideoPlan) -> VideoPlan:
    visual_bible = compact_words(plan.visual_bible, 60)
    scenes = []
    for index, scene in enumerate(plan.scenes, start=1):
        scenes.append(
            scene.model_copy(
                update={
                    "id": f"scene_{index}",
                    "image_prompt": " ".join(scene.image_prompt.split()),
                    "video_prompt": " ".join(scene.video_prompt.split()),
                }
            )
        )
    return plan.model_copy(update={"visual_bible": visual_bible, "scenes": scenes})


def provider_image_prompt(plan: VideoPlan, scene: Scene) -> str:
    prompt = " ".join(scene.image_prompt.split())
    visual_bible = " ".join(plan.visual_bible.split())
    if not visual_bible:
        return prompt
    if visual_bible.lower() in prompt.lower():
        return prompt
    return f"Continuity bible for every scene: {visual_bible}. Scene keyframe: {prompt}"


def narration_stats(plan: VideoPlan, voiceover: dict[str, Any]) -> dict[str, Any]:
    words = count_spoken_words(plan.narration)
    cues = fish_audio_expression_cues(plan.narration)
    duration = float(voiceover.get("duration_seconds") or 0)
    return {
        "word_count": words,
        "expression_cue_count": len(cues),
        "expression_cues": cues,
        "voiceover_duration_seconds": duration,
        "words_per_second": round(words / duration, 3) if duration > 0 else None,
    }


def pricing_key_for_model(model: str) -> str:
    if model in OPENAI_TEXT_PRICING_USD_PER_1M:
        return model
    for known_model in OPENAI_TEXT_PRICING_USD_PER_1M:
        if model.startswith(f"{known_model}-"):
            return known_model
    raise KeyError(f"No OpenAI pricing configured for model: {model}")


def token_detail_value(details: Any, key: str) -> int:
    if hasattr(details, key):
        return int(getattr(details, key) or 0)
    if isinstance(details, dict):
        return int(details.get(key) or 0)
    return 0


def token_output_payload(project_id: str, model: str, usage: Usage) -> dict[str, Any]:
    pricing = OPENAI_TEXT_PRICING_USD_PER_1M[pricing_key_for_model(model)]
    cached_input_tokens = token_detail_value(usage.input_tokens_details, "cached_tokens")
    reasoning_tokens = token_detail_value(usage.output_tokens_details, "reasoning_tokens")
    tool_search_tokens = token_detail_value(usage.input_tokens_details, "tool_search_tokens")
    uncached_input_tokens = max(usage.input_tokens - cached_input_tokens, 0)
    max_request_input_tokens = max(
        [usage.input_tokens, *(entry.input_tokens for entry in usage.request_usage_entries)],
        default=0,
    )
    long_context_applies = max_request_input_tokens > pricing["long_context_threshold_input_tokens"]
    input_multiplier = pricing["long_context_input_multiplier"] if long_context_applies else 1.0
    output_multiplier = pricing["long_context_output_multiplier"] if long_context_applies else 1.0

    input_cost = uncached_input_tokens * pricing["input"] * input_multiplier / 1_000_000
    cached_input_cost = cached_input_tokens * pricing["cached_input"] * input_multiplier / 1_000_000
    output_cost = usage.output_tokens * pricing["output"] * output_multiplier / 1_000_000
    total_cost = input_cost + cached_input_cost + output_cost

    return {
        "project_id": project_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "provider": "openai",
        "model": model,
        "pricing": {
            "currency": "USD",
            "unit": "per_1m_tokens",
            "source": pricing["source"],
            "input": pricing["input"],
            "cached_input": pricing["cached_input"],
            "output": pricing["output"],
            "long_context_threshold_input_tokens": pricing["long_context_threshold_input_tokens"],
            "long_context_applies": long_context_applies,
            "input_multiplier": input_multiplier,
            "output_multiplier": output_multiplier,
        },
        "usage": {
            **serialize_usage(usage),
            "cached_input_tokens": cached_input_tokens,
            "uncached_input_tokens": uncached_input_tokens,
            "reasoning_tokens": reasoning_tokens,
            "tool_search_tokens": tool_search_tokens,
        },
        "cost": {
            "input_usd": round(input_cost, 8),
            "cached_input_usd": round(cached_input_cost, 8),
            "output_usd": round(output_cost, 8),
            "total_usd": round(total_cost, 8),
        },
        "scope": "OpenAI GPT/agent planning run only. Magic Hour, Fish Audio, and ffmpeg costs are not included.",
    }


def pending_token_output(ctx: ProjectContext, model: str) -> dict[str, Any]:
    path = ctx.project_dir / "token_output.json"
    return {
        "project_id": ctx.project_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "provider": "openai",
        "model": model,
        "usage": {
            "requests": 0,
            "input_tokens": 0,
            "cached_input_tokens": 0,
            "uncached_input_tokens": 0,
            "output_tokens": 0,
            "reasoning_tokens": 0,
            "tool_search_tokens": 0,
            "total_tokens": 0,
        },
        "cost": {
            "input_usd": 0,
            "cached_input_usd": 0,
            "output_usd": 0,
            "total_usd": 0,
        },
        "token_output_path": str(path),
        "scope": "Pending until the OpenAI agent run completes. Magic Hour, Fish Audio, and ffmpeg costs are not included.",
    }


def write_token_output(ctx: ProjectContext, usage: Usage, model: str | None = None) -> dict[str, Any]:
    path = ctx.project_dir / "token_output.json"
    payload = token_output_payload(ctx.project_id, model or video_agent.model, usage)
    payload["token_output_path"] = str(path)
    ctx.project_dir.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return payload


def merge_token_output_into_manifest(ctx: ProjectContext, token_output: dict[str, Any]) -> dict[str, Any]:
    manifest_path = ctx.project_dir / "manifest.json"
    if not manifest_path.exists():
        state = read_project_state(ctx)
        error = (state.get("status") or {}).get("error")
        if error:
            raise RuntimeError(str(error))
        raise RuntimeError("Agent finished without producing a video manifest.")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["token_output"] = token_output
    manifest["token_output_path"] = token_output["token_output_path"]
    manifest["gpt_cost_usd"] = token_output["cost"]["total_usd"]
    if manifest.get("final_video_path") and not manifest.get("final_video_url"):
        manifest["final_video_url"] = public_media_path(manifest["final_video_path"])
    manifest = export_youtube_final_video(ctx, manifest)
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    update_project_state(ctx, manifest=manifest)
    return manifest


async def plan_video(request: CreateProjectRequest, ctx: ProjectContext) -> tuple[VideoPlan, dict[str, Any]]:
    result = await Runner.run(
        planning_agent,
        input=build_generation_brief(request, ctx),
        context=ctx,
        max_turns=configured_agent_max_turns(),
    )
    token_output = write_token_output(ctx, result.context_wrapper.usage, model=planning_agent.model)
    plan = result.final_output if isinstance(result.final_output, VideoPlan) else VideoPlan.model_validate(result.final_output)
    return normalize_plan(plan), token_output


def youtube_script_result_used_web_search(result: Any) -> bool:
    for item in getattr(result, "new_items", []) or []:
        raw_item = getattr(item, "raw_item", None)
        raw_type = getattr(raw_item, "type", "")
        if isinstance(raw_item, dict):
            raw_type = raw_item.get("type", raw_type)
        markers = [
            getattr(item, "type", ""),
            getattr(item, "title", ""),
            getattr(item, "description", ""),
            raw_type,
            type(raw_item).__name__ if raw_item is not None else "",
        ]
        normalized = " ".join(str(marker or "").lower() for marker in markers)
        if "web_search" in normalized or "websearch" in normalized:
            return True
    return False


async def draft_youtube_script_impl(ctx: ProjectContext, request: CreateProjectRequest) -> YouTubeScriptPlan:
    script_agent = youtube_script_agent_for_request(request)
    result = await Runner.run(
        script_agent,
        input=build_youtube_script_prompt(request, ctx),
        context=ctx,
        max_turns=configured_agent_max_turns(),
    )
    plan = result.final_output if isinstance(result.final_output, YouTubeScriptPlan) else YouTubeScriptPlan.model_validate(result.final_output)
    plan = normalize_youtube_script_plan(plan)
    web_search_used = youtube_script_result_used_web_search(result)
    if plan.web_search_needed and not web_search_used:
        raise RuntimeError(
            "YouTube script planner marked web_search_needed=true but did not call WebSearchTool. "
            "Regenerate so current facts are grounded before script drafting."
        )
    write_json_artifact(ctx, "youtube_script_plan", plan.model_dump(mode="json"))
    update_project_state(
        ctx,
        decision={
            "tool": "draft_youtube_script",
            "decision": "Drafted a notebook-style YouTube script plan from the project prompt.",
            "metadata": {
                "title": plan.title,
                "section_count": len(plan.sections),
                "search_hints": [section.search_hint for section in plan.sections],
                "model": script_agent.model,
                "web_search_available": any(isinstance(tool, WebSearchTool) for tool in script_agent.tools),
                "web_search_needed": plan.web_search_needed,
                "web_search_used": web_search_used,
                "web_search_reason": plan.web_search_reason,
                "web_search_context_size": "low" if any(isinstance(tool, WebSearchTool) for tool in script_agent.tools) else None,
            },
        },
    )
    return plan


def load_video_plan(ctx: ProjectContext) -> VideoPlan:
    payload = read_json_artifact(ctx, "plan")
    if not payload:
        raise RuntimeError("No video plan found. Call draft_video_plan before rendering assets.")
    return VideoPlan.model_validate(payload)


def plan_duration_seconds(plan: VideoPlan) -> int:
    return sum(scene.duration_seconds for scene in plan.scenes)


def scene_ids_for(plan: VideoPlan, scene_ids: list[str] | None = None) -> set[str]:
    if not scene_ids:
        return {scene.id for scene in plan.scenes}
    known = {scene.id for scene in plan.scenes}
    requested = set(scene_ids)
    unknown = sorted(requested - known)
    if unknown:
        raise ValueError(f"Unknown scene id(s): {', '.join(unknown)}")
    return requested


def save_video_plan(ctx: ProjectContext, plan: VideoPlan) -> VideoPlan:
    write_json_artifact(ctx, "plan", plan.model_dump(mode="json"))
    update_project_state(ctx, current_plan=plan.model_dump(mode="json"))
    return plan


def patch_scene_in_plan(
    plan: VideoPlan,
    scene_id: str,
    *,
    narration: str | None = None,
    image_prompt: str | None = None,
    video_prompt: str | None = None,
    duration_seconds: int | None = None,
) -> tuple[VideoPlan, Scene]:
    patched_scenes: list[Scene] = []
    patched_scene: Scene | None = None
    for scene in plan.scenes:
        if scene.id != scene_id:
            patched_scenes.append(scene)
            continue
        updates: dict[str, Any] = {}
        if narration is not None:
            updates["narration"] = narration
        if image_prompt is not None:
            updates["image_prompt"] = " ".join(image_prompt.split())
        if video_prompt is not None:
            updates["video_prompt"] = " ".join(video_prompt.split())
        if duration_seconds is not None:
            updates["duration_seconds"] = duration_seconds
        patched_scene = scene.model_copy(update=updates)
        patched_scenes.append(patched_scene)
    if patched_scene is None:
        raise ValueError(f"Unknown scene id: {scene_id}")
    return plan.model_copy(update={"scenes": patched_scenes}), patched_scene


def revise_scene_narrations(plan: VideoPlan, revisions: list[SceneNarrationRevision]) -> VideoPlan:
    if not revisions:
        return plan
    revision_by_scene = {revision.scene_id: revision.narration for revision in revisions}
    unknown = sorted(set(revision_by_scene) - {scene.id for scene in plan.scenes})
    if unknown:
        raise ValueError(f"Unknown scene id(s): {', '.join(unknown)}")
    return plan.model_copy(
        update={
            "scenes": [
                scene.model_copy(update={"narration": revision_by_scene[scene.id]})
                if scene.id in revision_by_scene
                else scene
                for scene in plan.scenes
            ]
        }
    )


def invalidate_final_artifacts(ctx: ProjectContext, *, voiceover: bool = False) -> None:
    remove_json_artifact(ctx, "manifest")
    if voiceover:
        remove_json_artifact(ctx, "voiceover")
    update_project_state(ctx, final_video_path=None, manifest_path=None, **({"voiceover": None} if voiceover else {}))


def clear_render_outputs(ctx: ProjectContext) -> None:
    for artifact in ("voiceover", "images", "videos", "failed_scenes", "manifest"):
        remove_json_artifact(ctx, artifact)
    for directory in ("voiceover", "images", "videos", "youtube_clips"):
        shutil.rmtree(ctx.project_dir / directory, ignore_errors=True)
    for filename in ("final.mp4", "merged.mp4", "merged_timed.mp4"):
        with suppress(FileNotFoundError):
            (ctx.project_dir / filename).unlink()


def build_video_manifest(
    plan: VideoPlan,
    ctx: ProjectContext,
    *,
    images: list[dict[str, Any]],
    videos: list[dict[str, Any]],
    voiceover: dict[str, Any],
    failed_scenes: list[dict[str, str]],
    token_output: dict[str, Any],
    final_video: str,
) -> dict[str, Any]:
    plan_payload = plan.model_dump(mode="json")
    plan_payload["aspect_ratio"] = ctx.aspect_ratio
    plan_payload["resolution"] = ctx.resolution
    provider_settings = read_project_state(ctx).get("provider_settings") or {}

    manifest = {
        "project_id": ctx.project_id,
        "title": plan.title,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "workflow": provider_settings.get("workflow", "generated"),
        "aspect_ratio": ctx.aspect_ratio,
        "resolution": ctx.resolution,
        "image_model": provider_settings.get("image_model", ctx.image_model),
        "image_resolution": provider_settings.get("image_resolution", ctx.image_resolution),
        "image_style_tool": provider_settings.get("image_style_tool", ctx.image_style_tool),
        "video_model": provider_settings.get("video_model", ctx.video_model),
        "video_resolution": provider_settings.get("video_resolution", ctx.resolution),
        "video_audio": provider_settings.get("video_audio", ctx.video_audio),
        "audio_model": ctx.audio_model,
        "render_status": "partial" if failed_scenes else "complete",
        "completed_scene_count": len(videos),
        "failed_scene_count": len(failed_scenes),
        "failed_scenes": failed_scenes,
        "plan": plan_payload,
        "images": [with_media_url(image) for image in images],
        "videos": [with_media_url(video) for video in videos],
        "voiceover": with_media_url(voiceover),
        "narration_stats": narration_stats(plan, voiceover),
        "token_output": token_output,
        "token_output_path": token_output["token_output_path"],
        "gpt_cost_usd": token_output["cost"]["total_usd"],
        "final_video_path": final_video,
        "final_video_url": public_media_path(final_video),
        "manifest_path": str(ctx.project_dir / "manifest.json"),
    }
    write_json_artifact(ctx, "manifest", manifest)
    update_project_state(
        ctx,
        manifest=manifest,
        failures=failed_scenes,
        final_video_path=final_video,
        manifest_path=manifest["manifest_path"],
    )
    return manifest


async def draft_video_plan_impl(
    ctx: ProjectContext,
    title: str,
    narration: str,
    scenes: list[Scene],
    visual_bible: str = "",
    normalize_scene_ids: bool = True,
) -> dict[str, Any]:
    plan = VideoPlan(title=title, narration=narration, visual_bible=visual_bible, scenes=scenes)
    if normalize_scene_ids:
        plan = normalize_plan(plan)
    ctx.project_dir.mkdir(parents=True, exist_ok=True)
    clear_render_outputs(ctx)
    write_json_artifact(ctx, "plan", plan.model_dump(mode="json"))
    write_json_artifact(ctx, "failed_scenes", [])
    update_project_state(
        ctx,
        current_plan=plan.model_dump(mode="json"),
        voiceover=None,
        images=[],
        videos=[],
        failures=[],
        final_video_path=None,
        manifest_path=None,
        status={"stage": "plan_drafted", "progress": 15, "message": "Creative plan drafted."},
        decision={
            "tool": "draft_video_plan",
            "decision": f"Drafted plan '{plan.title}' with {len(plan.scenes)} scene(s).",
            "metadata": {"scene_ids": [scene.id for scene in plan.scenes]},
        },
    )
    return {
        "project_id": ctx.project_id,
        "stage": "plan_drafted",
        "plan": plan.model_dump(mode="json"),
        "next_tools": ["generate_voiceover", "generate_scene_images"],
    }


async def generate_voiceover_impl(ctx: ProjectContext) -> dict[str, Any]:
    plan = load_video_plan(ctx)
    voiceover = await generate_voiceover_asset(ctx, plan.narration, plan_duration_seconds(plan))
    write_json_artifact(ctx, "voiceover", voiceover)
    update_project_state(
        ctx,
        voiceover=voiceover,
        status={"stage": "voiceover_generated", "progress": 30, "message": "Voiceover generated."},
        decision={
            "tool": "generate_voiceover",
            "decision": "Generated voiceover for the saved narration.",
            "metadata": {"target_duration_seconds": voiceover.get("target_duration_seconds")},
        },
    )
    return {
        "project_id": ctx.project_id,
        "stage": "voiceover_generated",
        "voiceover": with_media_url(voiceover),
        "next_tools": ["generate_scene_images", "animate_scene_videos"],
    }


async def generate_scene_images_impl(
    ctx: ProjectContext,
    scene_ids: list[str] | None = None,
    *,
    model: MagicImageModel | None = None,
    image_resolution: MagicImageResolution | None = None,
    image_style_tool: MagicImageStyleTool = "general",
) -> dict[str, Any]:
    plan = load_video_plan(ctx)
    selected_ids = scene_ids_for(plan, scene_ids)
    scenes = [
        scene.model_copy(update={"image_prompt": provider_image_prompt(plan, scene)})
        for scene in plan.scenes
        if scene.id in selected_ids
    ]
    image_ctx = context_with_magic_image_settings(
        ctx,
        model=model or ctx.image_model,
        image_resolution=image_resolution or ctx.image_resolution,
        image_style_tool=image_style_tool or ctx.image_style_tool,
    )
    image_results = await asyncio.gather(
        *(generate_image_asset(image_ctx, scene) for scene in scenes),
        return_exceptions=True,
    )
    existing_images = read_json_artifact(ctx, "images", [])
    existing_failures = read_json_artifact(ctx, "failed_scenes", [])
    images: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []

    for scene, result in zip(scenes, image_results):
        if isinstance(result, Exception):
            logger.warning(
                "Scene image generation failed for %s",
                scene.id,
                exc_info=(type(result), result, result.__traceback__),
            )
            failures.append({"scene_id": scene.id, "stage": "image_generation", "error": str(result)})
        else:
            images.append(result)

    merged_images = ordered_scene_assets(plan, upsert_scene_assets(existing_images, images))
    failure_free_images = {image["scene_id"] for image in images}
    updated_failures = clear_scene_failures(existing_failures, failure_free_images, {"image_generation"})
    updated_failures = record_scene_failures(updated_failures, failures)
    write_json_artifact(ctx, "images", merged_images)
    write_json_artifact(ctx, "failed_scenes", updated_failures)
    update_project_state(
        ctx,
        provider_settings={
            "image_model": image_ctx.image_model,
            "image_resolution": image_ctx.image_resolution,
            "image_style_tool": image_ctx.image_style_tool,
        },
        images=merged_images,
        failures=updated_failures,
        status={"stage": "images_generated", "progress": 45, "message": "Scene images generated."},
        decision={
            "tool": "generate_scene_images",
            "decision": f"Generated {len(images)} scene image(s).",
            "metadata": {
                "requested_scene_ids": [scene.id for scene in scenes],
                "failed_scene_ids": [failure["scene_id"] for failure in failures],
            },
        },
    )
    return {
        "project_id": ctx.project_id,
        "stage": "images_generated",
        "images": [with_media_url(image) for image in merged_images],
        "failed_scenes": updated_failures,
        "next_tools": ["animate_scene_videos"],
    }


async def animate_scene_videos_impl(
    ctx: ProjectContext,
    scene_ids: list[str] | None = None,
    *,
    model: MagicVideoModel | None = None,
    resolution: Resolution | None = None,
    audio: bool | None = None,
) -> dict[str, Any]:
    plan = load_video_plan(ctx)
    selected_ids = scene_ids_for(plan, scene_ids)
    selected_scenes = [scene for scene in plan.scenes if scene.id in selected_ids]
    video_ctx = context_with_magic_video_settings(
        ctx,
        model=model or ctx.video_model,
        resolution=resolution or ctx.resolution,
        audio=ctx.video_audio if audio is None else audio,
        scenes=selected_scenes,
    )
    existing_images = read_json_artifact(ctx, "images", [])
    image_by_scene = {image["scene_id"]: image for image in existing_images}
    video_scene_pairs = [
        (scene, image_by_scene[scene.id])
        for scene in selected_scenes
        if scene.id in image_by_scene
    ]
    missing_image_failures = [
        {"scene_id": scene.id, "stage": "video_generation", "error": "No image asset exists for this scene."}
        for scene in selected_scenes
        if scene.id not in image_by_scene
    ]
    if not video_scene_pairs:
        existing_failures = read_json_artifact(ctx, "failed_scenes", [])
        updated_failures = record_scene_failures(existing_failures, missing_image_failures)
        write_json_artifact(ctx, "failed_scenes", updated_failures)
        update_project_state(
            ctx,
            failures=updated_failures,
            status={"stage": "video_generation_blocked", "progress": 65, "message": "No scene images are ready for animation."},
        )
        raise RuntimeError("No scene images completed, so no videos can be animated.")

    video_results = await generate_video_assets_batch(video_ctx, video_scene_pairs)
    existing_videos = read_json_artifact(ctx, "videos", [])
    existing_failures = read_json_artifact(ctx, "failed_scenes", [])
    videos: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = [*missing_image_failures]

    for (scene, _image), result in zip(video_scene_pairs, video_results):
        if isinstance(result, Exception):
            logger.warning(
                "Scene video generation failed for %s",
                scene.id,
                exc_info=(type(result), result, result.__traceback__),
            )
            failures.append({"scene_id": scene.id, "stage": "video_generation", "error": str(result)})
        else:
            videos.append(result)

    merged_videos = ordered_scene_assets(plan, upsert_scene_assets(existing_videos, videos))
    successful_video_ids = {video["scene_id"] for video in videos}
    updated_failures = clear_scene_failures(existing_failures, successful_video_ids, {"video_generation"})
    updated_failures = record_scene_failures(updated_failures, failures)
    write_json_artifact(ctx, "videos", merged_videos)
    write_json_artifact(ctx, "failed_scenes", updated_failures)
    update_project_state(
        ctx,
        provider_settings={
            "video_model": video_ctx.video_model,
            "video_resolution": video_ctx.resolution,
            "video_audio": video_ctx.video_audio,
        },
        videos=merged_videos,
        failures=updated_failures,
        status={"stage": "videos_animated", "progress": 70, "message": "Scene videos animated."},
        decision={
            "tool": "animate_scene_videos",
            "decision": f"Animated {len(videos)} scene video(s).",
            "metadata": {
                "requested_scene_ids": [scene.id for scene, _image in video_scene_pairs],
                "failed_scene_ids": [failure["scene_id"] for failure in failures],
            },
        },
    )
    return {
        "project_id": ctx.project_id,
        "stage": "videos_animated",
        "videos": [with_media_url(video) for video in merged_videos],
        "failed_scenes": updated_failures,
        "next_tools": ["stitch_final_video", "retry_scene"],
    }


async def stitch_final_video_impl(ctx: ProjectContext, token_output: dict[str, Any] | None = None) -> dict[str, Any]:
    plan = load_video_plan(ctx)
    images = ordered_scene_assets(plan, read_json_artifact(ctx, "images", []))
    videos = ordered_scene_assets(plan, read_json_artifact(ctx, "videos", []))
    voiceover = read_json_artifact(ctx, "voiceover")
    failed_scenes = read_json_artifact(ctx, "failed_scenes", [])
    if not videos:
        failures = "; ".join(
            f"{failure['scene_id']} {failure['stage']}: {failure['error']}"
            for failure in failed_scenes
        )
        detail = f" Failures: {failures}" if failures else ""
        raise RuntimeError(f"No scene videos completed, so no final MP4 can be stitched.{detail}")
    if not voiceover:
        raise RuntimeError("No voiceover asset found. Call generate_voiceover before stitching.")

    final_video = await stitch_assets(ctx, videos, voiceover)
    return build_video_manifest(
        plan,
        ctx,
        images=images,
        videos=videos,
        voiceover=voiceover,
        failed_scenes=failed_scenes,
        token_output=token_output or pending_token_output(ctx, ENV.get("OPENAI_MODEL", "gpt-5.5")),
        final_video=final_video,
    )


def youtube_sections_to_video_plan(title: str, narration: str, sections: list[YouTubeClipSection]) -> VideoPlan:
    scenes = [
        Scene(
            id=f"scene_{section.section}",
            narration=section.dialogue,
            image_prompt=section.search_hint,
            video_prompt=f"YouTube clip search: {section.search_hint}",
            duration_seconds=section.duration_seconds,
        )
        for section in sections
    ]
    return normalize_plan(VideoPlan(title=title, narration=narration, visual_bible="YouTube-sourced b-roll and real footage.", scenes=scenes))


async def create_youtube_short_impl(
    ctx: ProjectContext,
    title: str,
    narration: str,
    sections: list[YouTubeClipSection],
    *,
    token_output: dict[str, Any] | None = None,
    proxy_url: str | None = None,
) -> dict[str, Any]:
    if not sections:
        raise ValueError("At least one YouTube clip section is required.")

    existing_manifest = existing_youtube_manifest(ctx)
    if existing_manifest is not None:
        update_project_state(
            ctx,
            decision={
                "tool": "create_youtube_short",
                "decision": "Reused existing YouTube short manifest; skipped duplicate generation and downloads.",
                "metadata": {"manifest_path": existing_manifest.get("manifest_path")},
            },
        )
        return existing_manifest

    sections = normalize_youtube_sections_for_project(ctx, sections)
    state = read_project_state(ctx)
    provider_settings = state.get("provider_settings") or {}
    user_preferences = state.get("user_preferences") or {}
    youtube_search_provider = str(
        provider_settings.get("youtube_search_provider")
        or user_preferences.get("youtube_search_provider")
        or "youtube_data_api"
    )
    youtube_allow_provider_fallback = bool_setting(
        provider_settings.get(
            "youtube_allow_provider_fallback",
            user_preferences.get("youtube_allow_provider_fallback", False),
        ),
        default=False,
    )
    plan = youtube_sections_to_video_plan(title, narration, sections)
    await draft_video_plan_impl(ctx, plan.title, plan.narration, plan.scenes, plan.visual_bible, normalize_scene_ids=False)

    # --- Per-section voiceover (alignment source of truth) ---
    # Drafting clears old render outputs, so TTS must happen after the plan is
    # persisted. Then the measured spoken duration becomes authoritative for
    # each section and we save the updated plan without clearing media again.
    section_voiceovers = await generate_section_voiceovers(ctx, sections)
    vo_by_scene = {item["scene_id"]: item for item in section_voiceovers}
    for section, item in zip(sections, section_voiceovers):
        section.duration_seconds = max(1, min(30, round(item["duration_seconds"])))
    write_json_artifact(ctx, "section_voiceovers", section_voiceovers)
    plan = save_video_plan(ctx, youtube_sections_to_video_plan(title, narration, sections))

    update_project_state(
        ctx,
        provider_settings={
            "workflow": "youtube_clips",
            "image_model": "none",
            "image_resolution": "none",
            "image_style_tool": "none",
            "video_model": "youtube-clips",
            "video_resolution": ctx.resolution,
            "video_audio": False,
            "youtube_search_provider": youtube_search_provider,
            "youtube_allow_provider_fallback": youtube_allow_provider_fallback,
        },
        decision={
            "tool": "create_youtube_short",
            "decision": f"Using YouTube clip workflow with {len(sections)} section(s).",
            "metadata": {
                "search_hints": [section.search_hint for section in sections],
                "youtube_search_provider": youtube_search_provider,
                "youtube_allow_provider_fallback": youtube_allow_provider_fallback,
            },
        },
        status={"stage": "youtube_voiceover_generated", "progress": 35, "message": "Per-section voiceovers generated for YouTube short."},
    )

    clip_results = await download_youtube_clip_assets(
        ctx,
        sections,
        proxy_url=proxy_url,
        search_provider=youtube_search_provider,
    )
    videos: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    for section, result in zip(sections, clip_results):
        scene_id = f"scene_{section.section}"
        if isinstance(result, Exception):
            failures.append({"scene_id": scene_id, "stage": "youtube_clip_download", "error": str(result)})
        else:
            videos.append(result)

    videos = ordered_scene_assets(plan, videos)
    write_json_artifact(ctx, "videos", videos)
    write_json_artifact(ctx, "images", [])
    write_json_artifact(ctx, "failed_scenes", failures)
    update_project_state(
        ctx,
        images=[],
        videos=videos,
        failures=failures,
        status={"stage": "youtube_clips_downloaded", "progress": 70, "message": "YouTube clips downloaded."},
    )
    if not videos:
        detail = "; ".join(f"{failure['scene_id']}: {failure['error']}" for failure in failures)
        error = f"No YouTube clips downloaded, so no final MP4 can be stitched. {detail}".strip()
        update_project_state(
            ctx,
            failures=failures,
            status={
                "stage": "youtube_short_failed",
                "progress": 70,
                "message": "YouTube clip sourcing failed.",
                "error": error,
            },
        )
        raise RuntimeError(error)

    youtube_output_aspect_ratio = infer_youtube_output_aspect_ratio(videos, default_aspect_ratio=ctx.aspect_ratio)
    render_ctx = replace(ctx, aspect_ratio=youtube_output_aspect_ratio)
    update_project_state(
        ctx,
        provider_settings={
            "aspect_ratio": render_ctx.aspect_ratio,
            "resolution": render_ctx.resolution,
        },
        decision={
            "tool": "create_youtube_short",
            "decision": f"Using {render_ctx.aspect_ratio} output aspect from downloaded YouTube clips.",
            "metadata": {
                "requested_aspect_ratio": ctx.aspect_ratio,
                "output_aspect_ratio": render_ctx.aspect_ratio,
            },
        },
    )

    # Combine only the surviving sections' audio so the manifest voiceover
    # matches the final video. The per-section files remain the alignment
    # source of truth; dropping a failed scene cannot desync the survivors.
    ordered_section_vo = [vo_by_scene[video["scene_id"]] for video in videos if video["scene_id"] in vo_by_scene]
    missing_audio = [item["path"] for item in ordered_section_vo if not Path(str(item["path"])).exists()]
    if missing_audio:
        detail = "; ".join(missing_audio)
        error = f"Per-section voiceover files missing before combine: {detail}"
        audio_failure = {"scene_id": "final", "stage": "voiceover_combine", "error": error}
        failures = [*failures, audio_failure]
        write_json_artifact(ctx, "failed_scenes", failures)
        update_project_state(
            ctx,
            failures=failures,
            status={
                "stage": "youtube_short_failed",
                "progress": 70,
                "message": "YouTube short voiceover combine failed.",
                "error": error,
            },
        )
        raise RuntimeError(error)
    try:
        voiceover = await combine_section_voiceovers(ctx, ordered_section_vo)
    except Exception as exc:
        audio_paths = [str(item.get("path") or "") for item in ordered_section_vo]
        error = f"Failed to combine per-section voiceovers: {exc}. Section audio paths: {audio_paths}"
        audio_failure = {"scene_id": "final", "stage": "voiceover_combine", "error": error}
        failures = [*failures, audio_failure]
        write_json_artifact(ctx, "failed_scenes", failures)
        update_project_state(
            ctx,
            failures=failures,
            status={
                "stage": "youtube_short_failed",
                "progress": 70,
                "message": "YouTube short voiceover combine failed.",
                "error": error,
            },
        )
        raise RuntimeError(error) from exc
    write_json_artifact(ctx, "voiceover", voiceover)
    update_project_state(ctx, voiceover=voiceover)

    scenes_for_stitch = [
        {
            "video_path": video["path"],
            "audio_path": vo_by_scene[video["scene_id"]]["path"],
            "audio_duration_seconds": vo_by_scene[video["scene_id"]]["duration_seconds"],
        }
        for video in videos
        if video["scene_id"] in vo_by_scene
    ]

    try:
        final_video = await stitch_assets_per_section(render_ctx, scenes_for_stitch)
    except Exception as exc:
        stitch_failure = {"scene_id": "final", "stage": "stitching", "error": str(exc)}
        failures = [*failures, stitch_failure]
        write_json_artifact(ctx, "failed_scenes", failures)
        update_project_state(
            ctx,
            failures=failures,
            status={
                "stage": "youtube_short_failed",
                "progress": 70,
                "message": "YouTube short stitching failed.",
                "error": str(exc),
            },
        )
        raise

    manifest = build_video_manifest(
        plan,
        render_ctx,
        images=[],
        videos=videos,
        voiceover=voiceover,
        failed_scenes=failures,
        token_output=token_output or pending_token_output(ctx, ENV.get("OPENAI_MODEL", "gpt-5.5")),
        final_video=final_video,
    )
    manifest["workflow"] = "youtube_clips"
    manifest["image_model"] = "none"
    manifest["video_model"] = "youtube-clips"
    manifest["youtube_search_provider"] = youtube_search_provider
    manifest["youtube_allow_provider_fallback"] = youtube_allow_provider_fallback
    write_json_artifact(ctx, "manifest", manifest)
    update_project_state(
        ctx,
        manifest=manifest,
        final_video_path=final_video,
        manifest_path=manifest["manifest_path"],
        status={"stage": "youtube_short_stitched", "progress": 95, "message": "YouTube short stitched."},
    )
    return manifest


async def inspect_render_status_impl(ctx: ProjectContext) -> dict[str, Any]:
    artifacts = {
        name: artifact_path(ctx, name).exists()
        for name in ("plan", "voiceover", "images", "videos", "manifest")
    }
    plan_payload = read_json_artifact(ctx, "plan")
    images = read_json_artifact(ctx, "images", [])
    videos = read_json_artifact(ctx, "videos", [])
    failed_scenes = read_json_artifact(ctx, "failed_scenes", [])
    scene_ids: list[str] = []
    missing_images: list[str] = []
    missing_videos: list[str] = []

    if plan_payload:
        plan = VideoPlan.model_validate(plan_payload)
        scene_ids = [scene.id for scene in plan.scenes]
        image_ids = {image["scene_id"] for image in images}
        video_ids = {video["scene_id"] for video in videos}
        missing_images = [scene_id for scene_id in scene_ids if scene_id not in image_ids]
        missing_videos = [scene_id for scene_id in scene_ids if scene_id not in video_ids]

    next_tools = []
    if not artifacts["plan"]:
        next_tools.append("draft_video_plan")
    else:
        if not artifacts["voiceover"]:
            next_tools.append("generate_voiceover")
        if missing_images:
            next_tools.append("generate_scene_images")
        if missing_videos and not missing_images:
            next_tools.append("animate_scene_videos")
        if videos and artifacts["voiceover"] and not artifacts["manifest"]:
            next_tools.append("stitch_final_video")
        if failed_scenes:
            next_tools.append("retry_scene")

    return {
        "project_id": ctx.project_id,
        "project_state": read_project_state(ctx),
        "artifacts": artifacts,
        "scene_ids": scene_ids,
        "completed_scene_count": len(videos),
        "failed_scene_count": len(failed_scenes),
        "missing_images": missing_images,
        "missing_videos": missing_videos,
        "failed_scenes": failed_scenes,
        "next_tools": next_tools,
    }


async def retry_scene_impl(ctx: ProjectContext, scene_id: str, stage: str = "video") -> dict[str, Any]:
    return await retry_scene_with_models_impl(ctx, scene_id, stage=stage)


async def retry_scene_with_models_impl(
    ctx: ProjectContext,
    scene_id: str,
    stage: str = "video",
    *,
    image_model: MagicImageModel | None = None,
    image_resolution: MagicImageResolution | None = None,
    image_style_tool: MagicImageStyleTool | None = None,
    video_model: MagicVideoModel | None = None,
    video_resolution: Resolution | None = None,
    video_audio: bool | None = None,
) -> dict[str, Any]:
    if stage not in {"image", "video", "all"}:
        raise ValueError("stage must be one of: image, video, all")
    plan = load_video_plan(ctx)
    scene = next((candidate for candidate in plan.scenes if candidate.id == scene_id), None)
    if scene is None:
        raise ValueError(f"Unknown scene id: {scene_id}")
    image_ctx = context_with_magic_image_settings(
        ctx,
        model=image_model or ctx.image_model,
        image_resolution=image_resolution or ctx.image_resolution,
        image_style_tool=image_style_tool or ctx.image_style_tool,
    )
    video_ctx = context_with_magic_video_settings(
        ctx,
        model=video_model or ctx.video_model,
        resolution=video_resolution or ctx.resolution,
        audio=ctx.video_audio if video_audio is None else video_audio,
        scenes=[scene],
    )

    images = read_json_artifact(ctx, "images", [])
    videos = read_json_artifact(ctx, "videos", [])
    failures = read_json_artifact(ctx, "failed_scenes", [])
    image_by_scene = {image["scene_id"]: image for image in images}
    new_images: list[dict[str, Any]] = []
    new_videos: list[dict[str, Any]] = []

    if stage in {"image", "all"} or scene_id not in image_by_scene:
        image = await generate_image_asset(image_ctx, scene)
        new_images.append(image)
        image_by_scene[scene_id] = image
        failures = clear_scene_failures(failures, {scene_id}, {"image_generation"})

    if stage in {"video", "all"}:
        image = image_by_scene.get(scene_id)
        if not image:
            raise RuntimeError(f"No image asset exists for {scene_id}; retry with stage='all'.")
        video = await generate_video_asset(video_ctx, scene, image)
        new_videos.append(video)
        failures = clear_scene_failures(failures, {scene_id}, {"video_generation"})

    merged_images = ordered_scene_assets(plan, upsert_scene_assets(images, new_images))
    merged_videos = ordered_scene_assets(plan, upsert_scene_assets(videos, new_videos))
    write_json_artifact(ctx, "images", merged_images)
    write_json_artifact(ctx, "videos", merged_videos)
    write_json_artifact(ctx, "failed_scenes", failures)
    update_project_state(
        ctx,
        provider_settings={
            "image_model": image_ctx.image_model,
            "image_resolution": image_ctx.image_resolution,
            "image_style_tool": image_ctx.image_style_tool,
            "video_model": video_ctx.video_model,
            "video_resolution": video_ctx.resolution,
            "video_audio": video_ctx.video_audio,
        },
        images=merged_images,
        videos=merged_videos,
        failures=failures,
        status={"stage": "scene_retried", "progress": 75, "message": f"Retried {scene_id}."},
        decision={
            "tool": "retry_scene",
            "decision": f"Retried {stage} asset(s) for {scene_id}.",
            "scene_id": scene_id,
        },
    )
    return {
        "project_id": ctx.project_id,
        "stage": "scene_retried",
        "retried_scene_id": scene_id,
        "images": [with_media_url(image) for image in merged_images],
        "videos": [with_media_url(video) for video in merged_videos],
        "failed_scenes": failures,
        "next_tools": ["stitch_final_video", "inspect_render_status"],
    }


async def record_project_decision_impl(
    ctx: ProjectContext,
    decision: str,
    rationale: str = "",
    scene_id: str | None = None,
) -> dict[str, Any]:
    entry = append_project_decision(
        ctx,
        decision=decision,
        rationale=rationale,
        scene_id=scene_id,
        tool="record_project_decision",
    )
    return {
        "project_id": ctx.project_id,
        "stage": "decision_recorded",
        "decision": entry,
        "decision_count": len(read_project_state(ctx)["decisions"]),
    }


async def regenerate_scene_impl(
    ctx: ProjectContext,
    scene_id: str,
    *,
    narration: str | None = None,
    image_prompt: str | None = None,
    video_prompt: str | None = None,
    duration_seconds: int | None = None,
    regenerate_image: bool = True,
    image_model: MagicImageModel | None = None,
    image_resolution: MagicImageResolution | None = None,
    image_style_tool: MagicImageStyleTool | None = None,
    video_model: MagicVideoModel | None = None,
    video_resolution: Resolution | None = None,
    video_audio: bool | None = None,
) -> dict[str, Any]:
    plan = load_video_plan(ctx)
    plan, scene = patch_scene_in_plan(
        plan,
        scene_id,
        narration=narration,
        image_prompt=image_prompt,
        video_prompt=video_prompt,
        duration_seconds=duration_seconds,
    )
    save_video_plan(ctx, plan)
    invalidate_final_artifacts(ctx)

    images = read_json_artifact(ctx, "images", [])
    videos = read_json_artifact(ctx, "videos", [])
    failures = read_json_artifact(ctx, "failed_scenes", [])
    image_by_scene = {image["scene_id"]: image for image in images}
    image_ctx = context_with_magic_image_settings(
        ctx,
        model=image_model or ctx.image_model,
        image_resolution=image_resolution or ctx.image_resolution,
        image_style_tool=image_style_tool or ctx.image_style_tool,
    )
    video_ctx = context_with_magic_video_settings(
        ctx,
        model=video_model or ctx.video_model,
        resolution=video_resolution or ctx.resolution,
        audio=ctx.video_audio if video_audio is None else video_audio,
        scenes=[scene],
    )

    if regenerate_image or scene_id not in image_by_scene:
        image = await generate_image_asset(image_ctx, scene)
    else:
        image = image_by_scene[scene_id]
    video = await generate_video_asset(video_ctx, scene, image)

    merged_images = ordered_scene_assets(plan, upsert_scene_assets(images, [image]))
    merged_videos = ordered_scene_assets(plan, upsert_scene_assets(videos, [video]))
    failures = clear_scene_failures(failures, {scene_id}, {"image_generation", "video_generation"})
    write_json_artifact(ctx, "images", merged_images)
    write_json_artifact(ctx, "videos", merged_videos)
    write_json_artifact(ctx, "failed_scenes", failures)
    update_project_state(
        ctx,
        current_plan=plan.model_dump(mode="json"),
        provider_settings={
            "image_model": image_ctx.image_model,
            "image_resolution": image_ctx.image_resolution,
            "image_style_tool": image_ctx.image_style_tool,
            "video_model": video_ctx.video_model,
            "video_resolution": video_ctx.resolution,
            "video_audio": video_ctx.video_audio,
        },
        images=merged_images,
        videos=merged_videos,
        failures=failures,
        final_video_path=None,
        manifest_path=None,
        status={"stage": "scene_regenerated", "progress": 78, "message": f"Regenerated {scene_id}."},
        decision={
            "tool": "regenerate_scene",
            "decision": f"Regenerated assets for {scene_id}.",
            "scene_id": scene_id,
            "metadata": {
                "regenerated_image": regenerate_image or scene_id not in image_by_scene,
                "patched_fields": [
                    field
                    for field, value in {
                        "narration": narration,
                        "image_prompt": image_prompt,
                        "video_prompt": video_prompt,
                        "duration_seconds": duration_seconds,
                    }.items()
                    if value is not None
                ],
            },
        },
    )
    return {
        "project_id": ctx.project_id,
        "stage": "scene_regenerated",
        "scene": scene.model_dump(mode="json"),
        "images": [with_media_url(asset) for asset in merged_images],
        "videos": [with_media_url(asset) for asset in merged_videos],
        "failed_scenes": failures,
        "next_tools": ["inspect_render_status", "restitch_video"],
    }


async def revise_narration_impl(
    ctx: ProjectContext,
    narration: str,
    scene_narration_updates: list[SceneNarrationRevision] | None = None,
) -> dict[str, Any]:
    plan = load_video_plan(ctx)
    plan = plan.model_copy(update={"narration": narration})
    plan = revise_scene_narrations(plan, scene_narration_updates or [])
    save_video_plan(ctx, plan)
    invalidate_final_artifacts(ctx, voiceover=True)
    update_project_state(
        ctx,
        current_plan=plan.model_dump(mode="json"),
        status={"stage": "narration_revised", "progress": 35, "message": "Narration revised; voiceover is stale."},
        decision={
            "tool": "revise_narration",
            "decision": "Revised narration and invalidated the previous voiceover.",
            "metadata": {"scene_ids": [revision.scene_id for revision in scene_narration_updates or []]},
        },
    )
    return {
        "project_id": ctx.project_id,
        "stage": "narration_revised",
        "plan": plan.model_dump(mode="json"),
        "next_tools": ["replace_voiceover", "restitch_video"],
    }


async def replace_voiceover_impl(ctx: ProjectContext, narration: str | None = None) -> dict[str, Any]:
    plan = load_video_plan(ctx)
    if narration is not None:
        plan = plan.model_copy(update={"narration": narration})
        save_video_plan(ctx, plan)
    invalidate_final_artifacts(ctx, voiceover=True)
    voiceover = await generate_voiceover_asset(ctx, plan.narration, plan_duration_seconds(plan))
    write_json_artifact(ctx, "voiceover", voiceover)
    update_project_state(
        ctx,
        current_plan=plan.model_dump(mode="json"),
        voiceover=voiceover,
        final_video_path=None,
        manifest_path=None,
        status={"stage": "voiceover_replaced", "progress": 55, "message": "Voiceover replaced."},
        decision={
            "tool": "replace_voiceover",
            "decision": "Replaced the voiceover audio from the current narration.",
            "metadata": {"target_duration_seconds": voiceover.get("target_duration_seconds")},
        },
    )
    return {
        "project_id": ctx.project_id,
        "stage": "voiceover_replaced",
        "voiceover": with_media_url(voiceover),
        "next_tools": ["restitch_video"],
    }


async def restitch_video_impl(
    ctx: ProjectContext,
    token_output: dict[str, Any] | None = None,
    reason: str = "",
) -> dict[str, Any]:
    manifest = await stitch_final_video_impl(ctx, token_output)
    update_project_state(
        ctx,
        status={"stage": "video_restitched", "progress": 95, "message": "Final video restitched."},
        decision={
            "tool": "restitch_video",
            "decision": "Restitched the final video from current scene videos and voiceover.",
            **({"rationale": reason} if reason else {}),
        },
    )
    return manifest


async def render_plan(
    plan: VideoPlan,
    ctx: ProjectContext,
    token_output: dict[str, Any],
    on_progress: ProgressCallback | None = None,
) -> dict[str, Any]:
    await draft_video_plan_impl(ctx, plan.title, plan.narration, plan.scenes, plan.visual_bible, normalize_scene_ids=False)
    voice_task = asyncio.create_task(generate_voiceover_impl(ctx))
    try:
        if on_progress:
            await on_progress("voiceover_images", 30, "Generating the voiceover and scene images.")
        await generate_scene_images_impl(ctx)
        if on_progress:
            await on_progress("video_generation", 65, "Animating scene videos.")
        await animate_scene_videos_impl(ctx)
        await voice_task
        if on_progress:
            await on_progress("stitching", 90, "Stitching the final edit.")
        return await stitch_final_video_impl(ctx, token_output)
    except Exception:
        if not voice_task.done():
            voice_task.cancel()
            with suppress(asyncio.CancelledError):
                await voice_task
        raise


@function_tool(defer_loading=True)
async def draft_video_plan(
    ctx: RunContextWrapper[ProjectContext],
    title: str,
    narration: str,
    scenes: list[Scene],
    visual_bible: str = "",
) -> dict[str, Any]:
    """
    Persist the complete creative plan before making provider calls.

    Args:
        title: Concise title for the finished video.
        narration: Full voiceover script for the complete edit.
        visual_bible: Compact continuity notes for subject, palette, lens language, and environment.
        scenes: Ordered scene plan with narration, image prompts, motion prompts, and durations.
    """
    await update_project_status(
        ctx.context.project_id,
        status="running",
        stage="planning",
        progress=15,
        message="Creative plan drafted by the agent.",
    )
    return await draft_video_plan_impl(ctx.context, title, narration, scenes, visual_bible)


@function_tool(defer_loading=True)
async def generate_voiceover(ctx: RunContextWrapper[ProjectContext]) -> dict[str, Any]:
    """Generate the voiceover audio for the current saved plan."""
    await update_project_status(
        ctx.context.project_id,
        status="running",
        stage="voiceover",
        progress=30,
        message="Generating the voiceover.",
    )
    return await generate_voiceover_impl(ctx.context)


@function_tool(defer_loading=True)
async def generate_scene_images(
    ctx: RunContextWrapper[ProjectContext],
    model: MagicImageModel = DEFAULT_MAGIC_HOUR_IMAGE_MODEL,
    image_resolution: MagicImageResolution = "1k",
    image_style_tool: MagicImageStyleTool = "general",
    scene_ids: list[str] | None = None,
) -> dict[str, Any]:
    """
    Generate still images for all scenes, or for selected scene ids.

    Args:
        model: Magic Hour image model. Default to seedream-v4 unless the user explicitly selected a different model or the prompt clearly needs a model-specific capability. Do not use Magic Hour's default model unless the user explicitly asks for it.
        image_resolution: Magic Hour image resolution. Choose a value supported by the selected image model: 640px, 1k, 2k, or 4k.
        image_style_tool: Magic Hour image style category. Use general unless a specific image domain such as ai-photo-generator, ai-character-generator, ai-landscape-generator, or movie-poster-generator clearly fits.
        scene_ids: Optional scene ids to generate. Omit to generate every scene in the saved plan.
    """
    await update_project_status(
        ctx.context.project_id,
        status="running",
        stage="image_generation",
        progress=45,
        message=f"Generating scene images with {model}.",
    )
    return await generate_scene_images_impl(
        ctx.context,
        scene_ids,
        model=model,
        image_resolution=image_resolution,
        image_style_tool=image_style_tool,
    )


@function_tool(defer_loading=True)
async def animate_scene_videos(
    ctx: RunContextWrapper[ProjectContext],
    model: MagicVideoModel = DEFAULT_MAGIC_HOUR_VIDEO_MODEL,
    resolution: Resolution = "720p",
    audio: bool = False,
    scene_ids: list[str] | None = None,
) -> dict[str, Any]:
    """
    Animate scene videos from generated images.

    Args:
        model: Magic Hour image-to-video model. Default to ltx-2.3 unless the user explicitly selected a different model or the prompt clearly needs a model-specific capability. Use seedance-2.0 for consistency, kling-2.5 for motion/camera control, kling-3.0 for cinematic storytelling, veo3.1 for realism/prompt adherence, or sora-2 for story-first creative motion only when that tradeoff is intentional.
        resolution: Output video resolution supported by the selected video model.
        audio: Whether Magic Hour should generate provider audio. Usually false because the final edit uses Fish Audio voiceover.
        scene_ids: Optional scene ids to animate. Omit to animate every scene with an image.
    """
    await update_project_status(
        ctx.context.project_id,
        status="running",
        stage="video_generation",
        progress=70,
        message=f"Animating scene videos with {model}.",
    )
    return await animate_scene_videos_impl(
        ctx.context,
        scene_ids,
        model=model,
        resolution=resolution,
        audio=audio,
    )


@function_tool(defer_loading=True)
async def stitch_final_video(ctx: RunContextWrapper[ProjectContext]) -> dict[str, Any]:
    """Stitch completed scene videos with the voiceover into the final MP4."""
    await update_project_status(
        ctx.context.project_id,
        status="running",
        stage="stitching",
        progress=90,
        message="Stitching the final edit.",
    )
    return await stitch_final_video_impl(
        ctx.context,
        pending_token_output(ctx.context, ENV.get("OPENAI_MODEL", "gpt-5.5")),
    )


@function_tool(defer_loading=True)
async def inspect_render_status(ctx: RunContextWrapper[ProjectContext]) -> dict[str, Any]:
    """Inspect saved plan, project_state.json, media artifacts, failures, and recommended next tools."""
    return await inspect_render_status_impl(ctx.context)


@function_tool(defer_loading=True)
async def record_project_decision(
    ctx: RunContextWrapper[ProjectContext],
    decision: str,
    rationale: str = "",
    scene_id: str | None = None,
) -> dict[str, Any]:
    """
    Persist an important creative, retry, or user-preference decision.

    Args:
        decision: Short statement of the choice being made.
        rationale: Optional reason for the choice.
        scene_id: Optional scene id when the decision is scene-specific.
    """
    return await record_project_decision_impl(ctx.context, decision, rationale, scene_id)


@function_tool(defer_loading=True)
async def regenerate_scene(
    ctx: RunContextWrapper[ProjectContext],
    scene_id: str,
    narration: str | None = None,
    image_prompt: str | None = Field(default=None, description="Optional replacement still-image prompt. Write a stable keyframe for image-to-video: concrete visible subject, action pose, foreground/background, lighting, lens/framing, palette, and continuity. Do not include text/logos/UI or anything that must be invented later."),
    video_prompt: str | None = Field(default=None, description="Optional replacement image-to-video motion prompt. Use one camera move and at most one subject motion; only animate what already exists in the still image. No cuts, new objects, scene changes, transformations, or ungrounded events."),
    duration_seconds: int | None = None,
    regenerate_image: bool = True,
    image_model: MagicImageModel | None = None,
    image_resolution: MagicImageResolution | None = None,
    image_style_tool: MagicImageStyleTool | None = None,
    video_model: MagicVideoModel | None = None,
    video_resolution: Resolution | None = None,
    video_audio: bool | None = None,
) -> dict[str, Any]:
    """
    Patch one scene and regenerate only that scene's media assets.

    Args:
        scene_id: Saved scene id, such as scene_2.
        narration: Optional replacement narration for this scene.
        image_prompt: Optional replacement still-image prompt. Write a stable keyframe for image-to-video with visible subject, action pose, foreground/background, lighting, lens/framing, palette, and continuity. Avoid text/logos/UI and anything the video model must invent.
        video_prompt: Optional replacement motion prompt. Use one camera move and at most one subject motion; only animate what already exists in the still image. No cuts, new objects, scene changes, transformations, or ungrounded events.
        duration_seconds: Optional replacement scene duration.
        regenerate_image: Whether to regenerate the image before animating the scene.
        image_model: Optional Magic Hour image model for the regenerated keyframe.
        image_resolution: Optional Magic Hour image resolution for the regenerated keyframe.
        image_style_tool: Optional Magic Hour image style tool.
        video_model: Optional Magic Hour image-to-video model for the regenerated scene.
        video_resolution: Optional Magic Hour video resolution for the regenerated scene.
        video_audio: Optional provider-audio toggle; usually false because final stitching uses Fish Audio.
    """
    await update_project_status(
        ctx.context.project_id,
        status="running",
        stage="regenerate_scene",
        progress=78,
        message=f"Regenerating {scene_id}.",
    )
    return await regenerate_scene_impl(
        ctx.context,
        scene_id,
        narration=narration,
        image_prompt=image_prompt,
        video_prompt=video_prompt,
        duration_seconds=duration_seconds,
        regenerate_image=regenerate_image,
        image_model=image_model,
        image_resolution=image_resolution,
        image_style_tool=image_style_tool,
        video_model=video_model,
        video_resolution=video_resolution,
        video_audio=video_audio,
    )


@function_tool(defer_loading=True)
async def revise_narration(
    ctx: RunContextWrapper[ProjectContext],
    narration: str,
    scene_narration_updates: list[SceneNarrationRevision] | None = None,
) -> dict[str, Any]:
    """
    Patch the saved narration and invalidate stale voiceover/final video artifacts.

    Args:
        narration: Replacement full voiceover narration.
        scene_narration_updates: Optional per-scene narration replacements.
    """
    await update_project_status(
        ctx.context.project_id,
        status="running",
        stage="revise_narration",
        progress=35,
        message="Revising narration.",
    )
    return await revise_narration_impl(ctx.context, narration, scene_narration_updates)


@function_tool(defer_loading=True)
async def replace_voiceover(
    ctx: RunContextWrapper[ProjectContext],
    narration: str | None = None,
) -> dict[str, Any]:
    """
    Replace the voiceover audio from the current saved narration or a new narration.

    Args:
        narration: Optional full narration to save before generating audio.
    """
    await update_project_status(
        ctx.context.project_id,
        status="running",
        stage="replace_voiceover",
        progress=55,
        message="Replacing voiceover.",
    )
    return await replace_voiceover_impl(ctx.context, narration)


@function_tool(defer_loading=True)
async def restitch_video(
    ctx: RunContextWrapper[ProjectContext],
    reason: str = "",
) -> dict[str, Any]:
    """
    Rebuild the final MP4 from the current scene videos and voiceover.

    Args:
        reason: Optional reason for restitching after a revision.
    """
    await update_project_status(
        ctx.context.project_id,
        status="running",
        stage="restitching",
        progress=95,
        message="Restitching the final edit.",
    )
    return await restitch_video_impl(
        ctx.context,
        pending_token_output(ctx.context, ENV.get("OPENAI_MODEL", "gpt-5.5")),
        reason,
    )


@function_tool(defer_loading=True)
async def retry_scene(
    ctx: RunContextWrapper[ProjectContext],
    scene_id: str,
    stage: Literal["image", "video", "all"] = "video",
    image_model: MagicImageModel | None = None,
    image_resolution: MagicImageResolution | None = None,
    image_style_tool: MagicImageStyleTool | None = None,
    video_model: MagicVideoModel | None = None,
    video_resolution: Resolution | None = None,
    video_audio: bool | None = None,
) -> dict[str, Any]:
    """
    Retry one scene without restarting the whole project.

    Args:
        scene_id: Saved scene id, such as scene_1.
        stage: Retry image, video, or all scene assets.
        image_model: Optional Magic Hour image model when retrying image/all.
        image_resolution: Optional Magic Hour image resolution when retrying image/all.
        image_style_tool: Optional Magic Hour image style tool when retrying image/all.
        video_model: Optional Magic Hour image-to-video model when retrying video/all.
        video_resolution: Optional Magic Hour video resolution when retrying video/all.
        video_audio: Optional provider-audio toggle; usually false because final stitching uses Fish Audio.
    """
    await update_project_status(
        ctx.context.project_id,
        status="running",
        stage="retry_scene",
        progress=75,
        message=f"Retrying {scene_id}.",
    )
    return await retry_scene_with_models_impl(
        ctx.context,
        scene_id,
        stage,
        image_model=image_model,
        image_resolution=image_resolution,
        image_style_tool=image_style_tool,
        video_model=video_model,
        video_resolution=video_resolution,
        video_audio=video_audio,
    )


@function_tool(defer_loading=True)
async def create_youtube_short(
    ctx: RunContextWrapper[ProjectContext],
    title: str,
    narration: str,
    sections: list[YouTubeClipSection],
    proxy_url: str | None = None,
) -> dict[str, Any]:
    """
    Create a short from searched YouTube clips, current Fish voiceover, and ffmpeg stitching.

    Args:
        title: Concise title for the finished short.
        narration: Full spoken script made by joining the section dialogue in order.
        sections: Ordered clip plan. Each section needs dialogue, a YouTube search hint, and duration.
        proxy_url: Optional proxy URL for yt-dlp downloads when needed.
    """
    await update_project_status(
        ctx.context.project_id,
        status="running",
        stage="youtube_short",
        progress=20,
        message="Creating a YouTube clip short.",
    )
    return await create_youtube_short_impl(
        ctx.context,
        title,
        narration,
        sections,
        token_output=pending_token_output(ctx.context, ENV.get("OPENAI_MODEL", "gpt-5.5")),
        proxy_url=proxy_url,
    )


async def create_youtube_short_from_prompt_impl(
    ctx: ProjectContext,
    *,
    proxy_url: str | None = None,
) -> dict[str, Any]:
    request = request_from_project_state(ctx)
    if request is None:
        raise RuntimeError("No project request found. Start a project before creating a YouTube short from prompt.")
    if request.workflow != "youtube_clips":
        raise RuntimeError("create_youtube_short_from_prompt is only available for workflow='youtube_clips'.")
    script = await draft_youtube_script_impl(ctx, request)
    return await create_youtube_short_impl(
        ctx,
        script.title,
        youtube_script_narration(script),
        script.sections,
        token_output=pending_token_output(ctx, youtube_script_model()),
        proxy_url=proxy_url,
    )


@function_tool(defer_loading=True)
async def create_youtube_short_from_prompt(
    ctx: RunContextWrapper[ProjectContext],
    proxy_url: str | None = None,
) -> dict[str, Any]:
    """
    Create a YouTube clip short from the current project prompt.

    The tool first drafts a notebook-style YouTube script plan with ordered
    section dialogue, duration_seconds, and search_hint values, then reuses the
    existing YouTube clip downloader, per-section Fish voiceover, and stitcher.

    Args:
        proxy_url: Optional proxy URL for yt-dlp downloads when needed.
    """
    await update_project_status(
        ctx.context.project_id,
        status="running",
        stage="youtube_script",
        progress=15,
        message="Drafting the YouTube script and search hints.",
    )
    return await create_youtube_short_from_prompt_impl(ctx.context, proxy_url=proxy_url)


VIDEO_STUDIO_TOOLS = tool_namespace(
    name="video_studio",
    description="Professional cinematic video generation and post-production tools.",
    tools=[
        draft_video_plan,
        generate_voiceover,
        generate_scene_images,
        animate_scene_videos,
        stitch_final_video,
        inspect_render_status,
        record_project_decision,
        regenerate_scene,
        revise_narration,
        replace_voiceover,
        restitch_video,
        retry_scene,
    ],
)


YOUTUBE_SHORT_TOOLS = tool_namespace(
    name="youtube_short",
    description="Create shorts from searched YouTube clips, current-project voiceover, and ffmpeg stitching.",
    tools=[create_youtube_short_from_prompt],
)


# Legacy direct planner retained for focused plan/token tests; run_project uses video_agent.
planning_agent = Agent(
    name="Fast Video Planning Agent",
    model=ENV.get("OPENAI_MODEL", "gpt-5.5"),
    instructions=PLANNING_INSTRUCTIONS,
    tools=[],
    output_type=VideoPlan,
    model_settings=ModelSettings(
        reasoning={"effort": ENV.get("OPENAI_REASONING_EFFORT", "low")},
        verbosity=ENV.get("OPENAI_VERBOSITY", "low"),
        parallel_tool_calls=False,
    ),
)


def youtube_script_model() -> str:
    return ENV.get("YOUTUBE_SCRIPT_MODEL", ENV.get("OPENAI_FAST_MODEL", ENV.get("OPENAI_MODEL", "gpt-5.4")))


def youtube_script_tools_for_request(request: CreateProjectRequest | None) -> list[Any]:
    return [WebSearchTool(search_context_size="low")]


def youtube_script_instructions_for_request(request: CreateProjectRequest | None) -> str:
    return " ".join(
        [
            "Draft only the structured YouTube script requested by the prompt.",
            "Decide whether WebSearchTool is needed from the user's prompt and current date, not from a fixed topic list.",
            "Use WebSearchTool only when the script needs facts that can drift, such as latest/current/recent news, product releases, public figures, sports, prices, laws, safety guidance, or dated claims.",
            "For stable historical, fictional, evergreen educational, or purely visual prompts, set web_search_needed=false and do not call WebSearchTool.",
            "If web search is needed, call WebSearchTool before naming specific current facts, set web_search_needed=true, and summarize why in web_search_reason.",
            "Never set web_search_needed=true unless you actually called WebSearchTool during this run.",
            "Use quick broad web search, not deep research; prefer fresh reputable or official sources.",
            "Keep source URLs and citations out of dialogue and search_hint fields.",
        ]
    )


def youtube_script_agent_for_request(request: CreateProjectRequest | None = None) -> Agent:
    return Agent(
        name="Notebook-Style YouTube Script Planner",
        model=youtube_script_model(),
        instructions=youtube_script_instructions_for_request(request),
        tools=youtube_script_tools_for_request(request),
        output_type=YouTubeScriptPlan,
        model_settings=ModelSettings(
            reasoning={"effort": ENV.get("YOUTUBE_SCRIPT_REASONING_EFFORT", "low")},
            verbosity=ENV.get("YOUTUBE_SCRIPT_VERBOSITY", "low"),
            parallel_tool_calls=False,
        ),
    )


youtube_script_agent = youtube_script_agent_for_request()


# The production path: the agent owns planning, provider-tool sequencing,
# retries, and stitching. The UI workflow toggle is enforced through the run
# brief, not by swapping to a different orchestrator agent.
video_agent = Agent(
    name="Autonomous Video Art Director",
    model=ENV.get("OPENAI_MODEL", "gpt-5.4"),
    instructions=INSTRUCTIONS,
    tools=[*VIDEO_STUDIO_TOOLS, *YOUTUBE_SHORT_TOOLS, ToolSearchTool()],
    model_settings=ModelSettings(
        reasoning={"effort": ENV.get("OPENAI_REASONING_EFFORT", "low")},
        verbosity=ENV.get("OPENAI_VERBOSITY", "low"),
        parallel_tool_calls=True,
    ),
)


def project_agent_for_request(request: CreateProjectRequest) -> Agent:
    # ``workflow`` constrains the main orchestrator's brief. ``generated`` lets
    # it use the normal Magic Hour toolchain; ``youtube_clips`` forces the
    # YouTube workflow tool first. Auto-routing can be added later as a new
    # workflow mode without introducing a second director.
    return video_agent


@app.get("/api/health")
async def health() -> dict[str, Any]:
    missing_config = missing_configuration()
    missing_dependencies = missing_system_dependencies()
    return {
        "status": "ok" if not missing_config and not missing_dependencies else "missing_config",
        "output_dir": str(OUTPUT_DIR),
        "missing_config": missing_config,
        "missing_dependencies": missing_dependencies,
        "active_projects": sum(1 for project in PROJECTS.values() if project["status"] in {"queued", "running"}),
    }


async def run_project(project_id: str, request: CreateProjectRequest) -> None:
    ctx = context(project_id, request)
    ensure_project_state(ctx, request)

    try:
        await update_project_status(
            project_id,
            status="running",
            stage="planning",
            progress=10,
            message="Planning the timed script and scene continuity.",
        )

        agent = project_agent_for_request(request)
        result = await Runner.run(
            agent,
            input=build_project_run_brief(request, ctx),
            context=ctx,
            max_turns=configured_agent_max_turns(),
        )
        token_output = write_token_output(ctx, result.context_wrapper.usage, model=agent.model)
        manifest = merge_token_output_into_manifest(ctx, token_output)
        failed_count = int(manifest.get("failed_scene_count") or 0)
        await update_project_status(
            project_id,
            status="succeeded",
            stage="complete",
            progress=100,
            message="Video is ready." if failed_count == 0 else f"Partial video is ready with {failed_count} failed scene(s).",
            manifest=manifest,
        )
    except Exception as exc:
        logger.exception("Project generation failed")
        manifest = read_json_artifact(ctx, "manifest", None)
        if isinstance(manifest, dict):
            repaired = terminal_youtube_status_from_manifest(project_id, manifest)
            if repaired is not None:
                update_project_state(
                    ctx,
                    decision={
                        "tool": "run_project",
                        "decision": "Preserved completed YouTube manifest after the outer agent errored.",
                        "metadata": {"error": str(exc)},
                    },
                )
                await update_project_status(
                    project_id,
                    status="succeeded",
                    stage="complete",
                    progress=100,
                    message=repaired["message"],
                    manifest=manifest,
                )
                return
        current = PROJECTS.get(project_id, {})
        await update_project_status(
            project_id,
            status="failed",
            stage="failed",
            progress=int(current.get("progress", 0)),
            message="Generation failed.",
            error=str(exc),
        )


async def run_project_message(project_id: str, message: str) -> None:
    ctx = context_for_existing_project(project_id)
    previous_status = read_project_status(project_id) or {}
    previous_manifest = previous_status.get("manifest")

    try:
        await update_project_status(
            project_id,
            status="running",
            stage="message_running",
            progress=25,
            message="Agent is handling the project message.",
            manifest=previous_manifest,
        )
        result = await Runner.run(
            video_agent,
            input=build_project_message_brief(project_id, message, ctx),
            context=ctx,
            max_turns=configured_agent_max_turns(),
        )
        token_output = write_token_output(ctx, result.context_wrapper.usage, model=video_agent.model)
        manifest = merge_token_output_into_manifest(ctx, token_output) if artifact_path(ctx, "manifest").exists() else None
        response_text = agent_response_content(result.final_output)
        append_project_message(
            ctx,
            role="assistant",
            content=response_text,
            metadata={
                "model": video_agent.model,
                "token_output_path": token_output["token_output_path"],
            },
        )
        await update_project_status(
            project_id,
            status="succeeded",
            stage="message_complete",
            progress=100,
            message=response_text[:240],
            manifest=manifest,
        )
    except Exception as exc:
        logger.exception("Project message handling failed")
        append_project_message(
            ctx,
            role="assistant",
            content=f"Agent turn failed: {exc}",
            metadata={"error": str(exc)},
        )
        current = PROJECTS.get(project_id, {})
        await update_project_status(
            project_id,
            status="failed",
            stage="message_failed",
            progress=int(current.get("progress", 0)),
            message="Project message failed.",
            error=str(exc),
            manifest=previous_manifest,
        )


async def queue_project(request: CreateProjectRequest, *, start: bool = True) -> dict[str, Any]:
    project_id = uuid.uuid4().hex
    initialize_project_state(context(project_id, request), request)
    payload = await update_project_status(
        project_id,
        status="queued",
        stage="queued",
        progress=0,
        message="Project queued locally.",
    )
    if start:
        asyncio.create_task(run_project(project_id, request))
    return payload


async def queue_youtube_review_session(
    request: YouTubeReviewSessionRequest,
    *,
    metadata: dict[str, Any] | None = None,
    start_projects: bool = True,
) -> dict[str, Any]:
    review_id = uuid.uuid4().hex
    now = datetime.now(timezone.utc).isoformat()
    providers: dict[str, Any] = {}

    for provider in YOUTUBE_REVIEW_PROVIDERS:
        project_request = youtube_review_project_request(request, provider)
        project_payload = await queue_project(project_request, start=start_projects)
        providers[provider] = {
            "provider": provider,
            "project_id": project_payload["project_id"],
            "status_url": project_payload["status_url"],
            "started_at": now,
            "comments": "",
            "comments_updated_at": None,
        }

    payload = {
        "review_id": review_id,
        "prompt": request.prompt,
        "created_at": now,
        "updated_at": now,
        "settings": {
            "duration_seconds": request.duration_seconds,
            "scene_count": request.scene_count,
            "aspect_ratio": request.aspect_ratio,
            "resolution": request.resolution,
        },
        "metadata": metadata or {},
        "providers": providers,
    }
    write_youtube_review_session(payload)
    return payload


async def run_youtube_review_batch(batch_id: str) -> None:
    try:
        payload = read_youtube_review_batch(batch_id)
        if payload is None:
            logger.warning("Review batch disappeared before it could run: %s", batch_id)
            return

        for item in payload.get("items") or []:
            review_payload = read_youtube_review_session(str(item["review_id"]))
            if review_payload is None:
                logger.warning("Review session disappeared before batch run: %s", item.get("review_id"))
                continue
            request = YouTubeReviewSessionRequest(
                prompt=str(review_payload["prompt"]),
                duration_seconds=(review_payload.get("settings") or {}).get("duration_seconds"),
                scene_count=(review_payload.get("settings") or {}).get("scene_count"),
                aspect_ratio=(review_payload.get("settings") or {}).get("aspect_ratio", "9:16"),
                resolution=(review_payload.get("settings") or {}).get("resolution", "720p"),
            )
            for provider in YOUTUBE_REVIEW_PROVIDERS:
                provider_payload = (review_payload.get("providers") or {}).get(provider)
                if not isinstance(provider_payload, dict):
                    continue
                project_id = str(provider_payload["project_id"])
                current_status = read_project_status(project_id)
                if current_status is not None and current_status.get("status") in {"running", "succeeded", "failed"}:
                    continue
                await run_project(project_id, youtube_review_project_request(request, provider))
    finally:
        RUNNING_YOUTUBE_REVIEW_BATCHES.discard(batch_id)


def review_batch_has_queued_projects(payload: dict[str, Any]) -> bool:
    for item in payload.get("items") or []:
        review_payload = read_youtube_review_session(str(item["review_id"]))
        if review_payload is None:
            continue
        for provider_payload in (review_payload.get("providers") or {}).values():
            if not isinstance(provider_payload, dict):
                continue
            status = read_project_status(str(provider_payload["project_id"]))
            if status is not None and status.get("status") == "queued":
                return True
    return False


def start_youtube_review_batch_worker(batch_id: str) -> None:
    if batch_id in RUNNING_YOUTUBE_REVIEW_BATCHES:
        return
    RUNNING_YOUTUBE_REVIEW_BATCHES.add(batch_id)
    asyncio.create_task(run_youtube_review_batch(batch_id))


@app.post("/api/projects", status_code=202)
async def create_project(request: CreateProjectRequest) -> dict[str, Any]:
    assert_runtime_ready()
    return await queue_project(request)


@app.post("/api/youtube-review-sessions", status_code=202)
async def create_youtube_review_session(request: YouTubeReviewSessionRequest) -> dict[str, Any]:
    assert_runtime_ready()
    payload = await queue_youtube_review_session(request)
    return youtube_review_session_response(payload)


@app.post("/api/youtube-review-batches", status_code=202)
async def create_youtube_review_batch() -> dict[str, Any]:
    assert_runtime_ready()
    try:
        prompt_entries = load_youtube_review_prompt_set()
    except (OSError, ValueError, KeyError, json.JSONDecodeError, ValidationError) as exc:
        raise HTTPException(status_code=500, detail=f"Could not load review prompt set: {exc}") from exc

    batch_id = uuid.uuid4().hex
    now = datetime.now(timezone.utc).isoformat()
    items: list[dict[str, Any]] = []

    for entry in prompt_entries:
        request = entry["request"]
        metadata = {
            "prompt_id": entry["prompt_id"],
            "name": entry["name"],
            "category": entry["category"],
            "batch_id": batch_id,
        }
        review_payload = await queue_youtube_review_session(request, metadata=metadata, start_projects=False)
        items.append(
            {
                "prompt_id": entry["prompt_id"],
                "name": entry["name"],
                "category": entry["category"],
                "prompt": request.prompt,
                "settings": {
                    "duration_seconds": request.duration_seconds,
                    "scene_count": request.scene_count,
                    "aspect_ratio": request.aspect_ratio,
                    "resolution": request.resolution,
                },
                "review_id": review_payload["review_id"],
            }
        )

    payload = {
        "batch_id": batch_id,
        "prompt_set_path": str(YOUTUBE_REVIEW_PROMPT_SET_PATH),
        "created_at": now,
        "updated_at": now,
        "items": items,
    }
    write_youtube_review_batch(payload)
    start_youtube_review_batch_worker(batch_id)
    return youtube_review_batch_response(payload)


@app.get("/api/youtube-review-batches/latest")
async def get_latest_youtube_review_batch() -> dict[str, Any]:
    payload = latest_youtube_review_batch()
    if payload is None:
        raise HTTPException(status_code=404, detail="Review batch not found")
    if review_batch_has_queued_projects(payload):
        start_youtube_review_batch_worker(str(payload["batch_id"]))
    return youtube_review_batch_response(payload)


@app.get("/api/youtube-review-batches/{batch_id}")
async def get_youtube_review_batch(batch_id: str) -> dict[str, Any]:
    try:
        payload = read_youtube_review_batch(batch_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Review batch not found") from exc
    if payload is None:
        raise HTTPException(status_code=404, detail="Review batch not found")
    if review_batch_has_queued_projects(payload):
        start_youtube_review_batch_worker(batch_id)
    return youtube_review_batch_response(payload)


@app.get("/api/youtube-review-sessions/{review_id}")
async def get_youtube_review_session(review_id: str) -> dict[str, Any]:
    try:
        payload = read_youtube_review_session(review_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Review session not found") from exc
    if payload is None:
        raise HTTPException(status_code=404, detail="Review session not found")
    return youtube_review_session_response(payload)


@app.post("/api/youtube-review-sessions/{review_id}/comments")
async def save_youtube_review_comment(review_id: str, request: YouTubeReviewCommentRequest) -> dict[str, Any]:
    try:
        payload = read_youtube_review_session(review_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Review session not found") from exc
    if payload is None:
        raise HTTPException(status_code=404, detail="Review session not found")

    provider_payload = (payload.get("providers") or {}).get(request.provider)
    if not isinstance(provider_payload, dict):
        raise HTTPException(status_code=404, detail="Review provider not found")

    provider_payload["comments"] = request.comments
    provider_payload["comments_updated_at"] = datetime.now(timezone.utc).isoformat()
    payload["updated_at"] = provider_payload["comments_updated_at"]
    write_youtube_review_session(payload)
    return youtube_review_session_response(payload)


@app.post("/api/projects/{project_id}/messages", status_code=202)
async def create_project_message(project_id: str, request: ProjectMessageRequest) -> dict[str, Any]:
    assert_runtime_ready()
    try:
        existing_status = read_project_status(project_id)
        ctx = context_for_existing_project(project_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Project not found") from exc
    if existing_status is None:
        raise HTTPException(status_code=404, detail="Project not found")

    append_project_message(ctx, role="user", content=request.message)
    payload = await update_project_status(
        project_id,
        status="queued",
        stage="message_queued",
        progress=int(existing_status.get("progress", 0)),
        message="Project message queued for the agent.",
        manifest=existing_status.get("manifest"),
    )
    payload["project_state"] = read_project_state(ctx)
    asyncio.create_task(run_project_message(project_id, request.message))
    return payload


@app.get("/api/projects/{project_id}")
async def get_project(project_id: str) -> dict[str, Any]:
    try:
        status = read_project_status(project_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Project not found") from exc
    if status is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return status
