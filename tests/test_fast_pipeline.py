import asyncio
import json
import shutil
import subprocess
import threading
import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest
from agents import ToolSearchTool
from agents.usage import Usage
from fastapi.testclient import TestClient
from openai.types.responses.response_usage import InputTokensDetails, OutputTokensDetails

from backend.app import main
from backend.app.tools import media
from backend.app.tools import youtube_short


def test_main_agent_uses_split_namespaced_video_studio_tools() -> None:
    tool_names = {getattr(tool, "name", None) for tool in main.video_agent.tools}
    expected_tools = {
        "draft_video_plan",
        "generate_voiceover",
        "generate_scene_images",
        "animate_scene_videos",
        "stitch_final_video",
        "inspect_render_status",
        "record_project_decision",
        "retry_scene",
        "regenerate_scene",
        "revise_narration",
        "replace_voiceover",
        "restitch_video",
    }

    assert expected_tools.issubset(tool_names)
    assert "execute_video_batch" not in tool_names
    assert any(isinstance(tool, ToolSearchTool) for tool in main.video_agent.tools)
    for tool in main.video_agent.tools:
        if getattr(tool, "name", None) in expected_tools:
            assert getattr(tool, "defer_loading") is True
            assert getattr(tool, "_tool_namespace") == "video_studio"
    assert main.video_agent.model_settings.reasoning.effort == "low"


def test_create_request_defaults_to_generated_workflow_and_accepts_youtube_clips() -> None:
    generated = main.CreateProjectRequest(prompt="make a video")
    youtube = main.CreateProjectRequest(prompt="make a fast news short", workflow="youtube_clips")
    ytdlp = main.CreateProjectRequest(
        prompt="make a fast news short",
        workflow="youtube_clips",
        youtube_search_provider="yt_dlp",
    )

    assert generated.workflow == "generated"
    assert generated.youtube_search_provider == "youtube_data_api"
    assert generated.youtube_allow_provider_fallback is False
    assert youtube.workflow == "youtube_clips"
    assert youtube.youtube_search_provider == "youtube_data_api"
    assert youtube.youtube_allow_provider_fallback is False
    assert ytdlp.youtube_search_provider == "yt_dlp"


def test_create_request_accepts_disabled_youtube_provider_fallback() -> None:
    request = main.CreateProjectRequest(
        prompt="make a fast news short",
        workflow="youtube_clips",
        youtube_search_provider="yt_dlp",
        youtube_allow_provider_fallback=False,
    )

    assert request.youtube_search_provider == "yt_dlp"
    assert request.youtube_allow_provider_fallback is False


def test_youtube_script_prompt_forbids_stock_and_watermark_queries() -> None:
    prompt = main.YOUTUBE_SCRIPT_SYSTEM_PROMPT

    assert 'append "stock"' not in prompt
    assert "watermark" in prompt
    assert "genuine YouTube" in prompt


def test_youtube_eval_payload_targets_data_api_provider() -> None:
    spec = importlib.util.spec_from_file_location("youtube_workflow_evals", "scripts/run_youtube_workflow_evals.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    payload = module.payload_for(
        {
            "id": "yt-eval-001",
            "prompt": "make a YouTube short",
            "settings": {"duration_seconds": 12, "scene_count": 3},
        },
        "youtube_data_api",
    )

    assert payload["youtube_search_provider"] == "youtube_data_api"
    assert module.PROVIDERS == ("youtube_data_api",)


def test_main_agent_exposes_prompt_based_youtube_short_tool_in_separate_namespace() -> None:
    tool_by_name = {getattr(tool, "name", None): tool for tool in main.video_agent.tools}

    assert "create_youtube_short_from_prompt" in tool_by_name
    assert "create_youtube_short" not in tool_by_name
    assert getattr(tool_by_name["create_youtube_short_from_prompt"], "defer_loading") is True
    assert getattr(tool_by_name["create_youtube_short_from_prompt"], "_tool_namespace") == "youtube_short"


def test_main_agent_owns_youtube_workflow_tool_surface() -> None:
    tool_names = {getattr(tool, "name", None) for tool in main.video_agent.tools}

    assert "create_youtube_short_from_prompt" in tool_names
    assert "create_youtube_short" not in tool_names
    assert "draft_video_plan" in tool_names
    assert "generate_scene_images" in tool_names
    assert any(isinstance(tool, ToolSearchTool) for tool in main.video_agent.tools)
    assert main.project_agent_for_request(main.CreateProjectRequest(prompt="make a video")) is main.video_agent
    assert (
        main.project_agent_for_request(
            main.CreateProjectRequest(prompt="make a YouTube clips video", workflow="youtube_clips")
        )
        is main.video_agent
    )


def test_youtube_short_tool_does_not_import_legacy_pipeline_package() -> None:
    source = Path("backend/app/tools/youtube_short.py").read_text(encoding="utf-8")

    assert "yt_pipeline" not in source
    assert "google.genai" not in source


def test_youtube_api_key_skips_invalid_configured_key(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[str] = []

    monkeypatch.setattr(
        youtube_short,
        "_candidate_youtube_api_keys",
        lambda: [("YOUTUBE_API_KEY_2", "bad-key"), ("YOUTUBE_API_KEY_1", "good-key")],
        raising=False,
    )

    def fake_key_validation(api_key: str) -> tuple[bool, str | None]:
        seen.append(api_key)
        return api_key == "good-key", "invalid"

    monkeypatch.setattr(youtube_short, "_is_youtube_api_key_working", fake_key_validation, raising=False)
    monkeypatch.setattr(youtube_short, "_WORKING_YOUTUBE_API_KEY", None, raising=False)

    assert youtube_short._youtube_api_key() == "good-key"
    assert seen == ["bad-key", "good-key"]


def test_youtube_api_key_reports_when_no_configured_key_works(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        youtube_short,
        "_candidate_youtube_api_keys",
        lambda: [("YOUTUBE_API_KEY_2", "bad-key"), ("YOUTUBE_API_KEY_3", "also-bad")],
        raising=False,
    )
    monkeypatch.setattr(youtube_short, "_is_youtube_api_key_working", lambda key: (False, "invalid"), raising=False)
    monkeypatch.setattr(youtube_short, "_WORKING_YOUTUBE_API_KEY", None, raising=False)

    with pytest.raises(RuntimeError, match="No working YouTube Data API key"):
        youtube_short._youtube_api_key()


def test_youtube_short_download_uses_local_youtube_helpers(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(section=1, dialogue="The onboard camera shows the start.", search_hint="f1 onboard start", duration_seconds=3)
    seen: dict[str, object] = {}

    def fake_search(query: str, limit: int = 5) -> list[dict[str, str]]:
        seen["query"] = query
        seen["limit"] = limit
        return [
            {
                "video_id": "abc123",
                "title": "F1 onboard start",
                "channel_title": "Race News",
                "published_at": "2026-05-19T00:00:00Z",
            }
        ]

    def fake_duration(video_id: str) -> float:
        seen["duration_video_id"] = video_id
        return 20.0

    def fake_transcript_window(video_id: str, total_duration: float, wanted_duration: float, section_arg: object):
        seen["transcript_window"] = (video_id, total_duration, wanted_duration, getattr(section_arg, "dialogue"))
        return 4.0, 7.0, {"source": "transcript", "score": 3.0, "text": "onboard camera shows start"}

    def fake_download(video_id: str, start: float, duration: float, *, out_dir: str, proxy_url: str | None = None) -> str:
        seen["download"] = (video_id, start, duration, out_dir, proxy_url)
        path = Path(out_dir) / "clip.mp4"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"clip")
        return str(path)

    monkeypatch.setattr(youtube_short, "_search_video_candidates", fake_search)
    monkeypatch.setattr(youtube_short, "_video_duration", fake_duration)
    monkeypatch.setattr(youtube_short, "_pick_transcript_window", fake_transcript_window)
    monkeypatch.setattr(youtube_short, "_download_clip", fake_download)

    asset = youtube_short._download_section_clip(ctx, section, proxy_url="http://proxy.local")

    assert asset["scene_id"] == "scene_1"
    assert asset["video_id"] == "abc123"
    assert asset["youtube_title"] == "F1 onboard start"
    assert asset["youtube_channel"] == "Race News"
    assert asset["start_seconds"] == 4.0
    assert asset["end_seconds"] == 7.0
    assert asset["window_source"] == "transcript"
    assert seen["query"] == "f1 onboard start"
    assert seen["transcript_window"] == ("abc123", 20.0, 3, "The onboard camera shows the start.")
    assert seen["download"] == (
        "abc123",
        4.0,
        3.0,
        str(ctx.project_dir / "youtube_clips" / "scene_1"),
        "http://proxy.local",
    )


def test_download_section_clip_uses_transcript_window_before_random(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="Stage separation worked before splashdown.",
        search_hint="latest SpaceX Starship stage separation",
        duration_seconds=5,
    )
    seen: dict[str, object] = {}

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "starship",
                "title": "Latest Starship launch update",
                "channel_title": "SpaceX",
                "published_at": "2026-05-20T00:00:00Z",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_video_duration", lambda video_id: 120.0)

    def fake_transcript_window(video_id: str, total_duration: float, wanted_duration: float, section_arg: object):
        seen["transcript_args"] = (video_id, total_duration, wanted_duration, getattr(section_arg, "dialogue"))
        return 42.0, 47.0, {"source": "transcript", "score": 3.0, "text": "stage separation worked"}

    def fake_download(video_id: str, start: float, duration: float, *, out_dir: str, proxy_url: str | None = None) -> str:
        path = Path(out_dir) / "clip.mp4"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"clip")
        return str(path)

    monkeypatch.setattr(youtube_short, "_pick_transcript_window", fake_transcript_window, raising=False)
    monkeypatch.setattr(youtube_short, "_download_clip", fake_download)

    asset = youtube_short._download_section_clip(ctx, section)

    assert seen["transcript_args"] == ("starship", 120.0, 5, "Stage separation worked before splashdown.")
    assert asset["start_seconds"] == 42.0
    assert asset["end_seconds"] == 47.0
    assert asset["window_source"] == "transcript"
    assert asset["window_match"]["text"] == "stage separation worked"


def test_download_section_clip_uses_relevant_visual_fallback_without_random(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="Stage separation worked before splashdown.",
        search_hint="latest SpaceX Starship stage separation",
        duration_seconds=5,
    )
    seen: dict[str, object] = {}

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "starship",
                "title": "Latest Starship launch update",
                "channel_title": "SpaceX",
                "description": "Stage separation worked before splashdown.",
                "published_at": "2026-05-20T00:00:00Z",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_video_duration", lambda video_id: 120.0)
    monkeypatch.setattr(youtube_short, "_pick_transcript_window", lambda *args: None, raising=False)

    def fake_random_window(total_duration: float, wanted_duration: float) -> tuple[float, float]:
        seen["random_window"] = (total_duration, wanted_duration)
        return 7.0, 12.0

    def fake_download(*args, **kwargs) -> str:
        seen["download"] = True
        return str(tmp_path / "should-not-download.mp4")

    monkeypatch.setattr(youtube_short, "_pick_window", fake_random_window, raising=False)
    monkeypatch.setattr(youtube_short, "_download_clip", fake_download)

    asset = youtube_short._download_section_clip(ctx, section)

    assert "random_window" not in seen
    assert seen["download"] is True
    assert asset["window_source"] == "visual_fallback"
    assert asset["window_match"]["score"] >= youtube_short.MIN_VISUAL_FALLBACK_SCORE


def test_download_section_clip_rejects_weak_visual_fallback(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="Restorers use water, picks, and patience to lift grime without scratches.",
        search_hint="coin restoration careful cleaning distilled water dental pick close up",
        duration_seconds=5,
    )

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "anime",
                "title": "Global Paranormal: Starting with Billions of Nether Coins #anime",
                "channel_title": "Bikini-Anime",
                "description": "Animated recap episode.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_pick_transcript_window", lambda *args: None, raising=False)
    monkeypatch.setattr(youtube_short, "_video_duration", lambda *args: (_ for _ in ()).throw(AssertionError("duration should not be probed")))
    monkeypatch.setattr(youtube_short, "_download_clip", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not download")))

    with pytest.raises(RuntimeError, match="fallback rejected"):
        youtube_short._download_section_clip(ctx, section)


def test_download_section_clip_rejects_stock_or_watermarked_youtube_sources(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="The Sahara's dunes shift across the frame before the scale becomes clear.",
        search_hint="Sahara Desert aerial landscape",
        duration_seconds=5,
    )

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "watermark",
                "title": "Cinematic Golden Sand Dunes - Majestic Desert Landscape Aerial - VisuStock.com",
                "channel_title": "Visustock",
                "description": "Royalty free stock footage preview with watermark.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_pick_transcript_window", lambda *args: None, raising=False)
    monkeypatch.setattr(youtube_short, "_video_duration", lambda *args: (_ for _ in ()).throw(AssertionError("duration should not be probed")))
    monkeypatch.setattr(youtube_short, "_download_clip", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not download")))

    with pytest.raises(RuntimeError, match="stock or watermarked source"):
        youtube_short._download_section_clip(ctx, section)


def test_download_section_clip_rejects_transcript_match_from_unrelated_video_metadata(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="Official demos showed camera input and replies quick enough to feel conversational.",
        search_hint="OpenAI GPT-4o official demo camera input voice",
        duration_seconds=5,
    )

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "elevenlabs",
                "title": "How To Use Elevenlabs - Master This AI Voice Generator in 23 minutes!",
                "channel_title": "Dan Kieft",
                "description": "AI voice generator tutorial.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_video_duration", lambda video_id: 120.0)
    monkeypatch.setattr(
        youtube_short,
        "_pick_transcript_window",
        lambda *args: (32.0, 37.0, {"source": "transcript", "score": 3.0, "text": "high voice, conversational, quick"}),
    )
    monkeypatch.setattr(youtube_short, "_download_clip", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not download")))

    with pytest.raises(RuntimeError, match="metadata does not match"):
        youtube_short._download_section_clip(ctx, section)


def test_download_section_clip_rejects_openai_model_mismatch(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="OpenAI's latest product update is GPT-4o.",
        search_hint="OpenAI GPT-4o Spring Update official",
        duration_seconds=5,
    )

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "api-key",
                "title": "How to Get an OpenAI ChatGPT API Key - 2026 Updated",
                "channel_title": "Tutorial Channel",
                "description": "OpenAI API key walkthrough.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_pick_transcript_window", lambda *args: None, raising=False)
    monkeypatch.setattr(youtube_short, "_video_duration", lambda *args: (_ for _ in ()).throw(AssertionError("duration should not be probed")))
    monkeypatch.setattr(youtube_short, "_download_clip", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not download")))

    with pytest.raises(RuntimeError, match="required OpenAI model"):
        youtube_short._download_section_clip(ctx, section)


def test_download_section_clip_rejects_gpt4o_mini_when_scene_requires_gpt4o(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="GPT-4o became cheaper in the API while keeping multimodal capability.",
        search_hint="OpenAI GPT-4o api cheaper",
        duration_seconds=5,
    )

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "gpt4o-mini",
                "title": "A FIRST LOOK AT OpenAI's NEW AFFORDABLE AI Model: GPT-4o Mini",
                "channel_title": "Infinite Ledger",
                "description": "Commentary on GPT-4o mini pricing and availability.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_video_duration", lambda video_id: 70.0)
    monkeypatch.setattr(
        youtube_short,
        "_pick_transcript_window",
        lambda *args: (4.0, 9.0, {"source": "transcript", "score": 3.0, "text": "available via the API"}),
    )
    monkeypatch.setattr(youtube_short, "_download_clip", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not download")))

    with pytest.raises(RuntimeError, match="required OpenAI model"):
        youtube_short._download_section_clip(ctx, section)


def test_download_section_clip_rejects_generic_openai_gpt_tutorial_even_with_model_name(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="The official demo showed GPT-4o reacting to camera input and spoken questions.",
        search_hint="OpenAI GPT-4o official live demo camera voice",
        duration_seconds=5,
    )

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "api-key-gpt4o",
                "title": "GPT-4o API Key Tutorial: Build Your First OpenAI App",
                "channel_title": "AI Tutorial Channel",
                "description": "Step by step OpenAI GPT-4o API key walkthrough for beginners.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_video_duration", lambda video_id: 90.0)
    monkeypatch.setattr(
        youtube_short,
        "_pick_transcript_window",
        lambda *args: (10.0, 15.0, {"source": "transcript", "score": 3.0, "text": "GPT-4o camera voice demo"}),
    )
    monkeypatch.setattr(youtube_short, "_download_clip", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not download")))

    with pytest.raises(RuntimeError, match="generic OpenAI tutorial"):
        youtube_short._download_section_clip(ctx, section)


def test_download_section_clip_rejects_openai_desktop_scene_without_desktop_metadata(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="OpenAI also introduced a desktop app for everyday use.",
        search_hint="OpenAI GPT-4o desktop app official update",
        duration_seconds=5,
    )

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "translation",
                "title": "Live demo of GPT-4o realtime translation",
                "channel_title": "OpenAI",
                "description": "A real-time voice translation demo.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_pick_transcript_window", lambda *args: None, raising=False)
    monkeypatch.setattr(youtube_short, "_video_duration", lambda *args: (_ for _ in ()).throw(AssertionError("duration should not be probed")))
    monkeypatch.setattr(youtube_short, "_download_clip", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not download")))

    with pytest.raises(RuntimeError, match="required desktop app scene"):
        youtube_short._download_section_clip(ctx, section)


def test_download_section_clip_rejects_hype_openai_coverage_when_official_requested(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="OpenAI announced GPT-4o as one model for text, vision, and voice.",
        search_hint="OpenAI Spring Update GPT-4o official livestream",
        duration_seconds=5,
    )

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "hype-gpt4o",
                "title": "OpenAI's New MultiModal GPT-4o Just SHOCKED Everyone!",
                "channel_title": "AI Symbiosis",
                "description": "Breathless reaction coverage of the new model.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_video_duration", lambda video_id: 70.0)
    monkeypatch.setattr(
        youtube_short,
        "_pick_transcript_window",
        lambda *args: (4.0, 9.0, {"source": "transcript", "score": 3.0, "text": "GPT-4o text vision voice"}),
    )
    monkeypatch.setattr(youtube_short, "_download_clip", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not download")))

    with pytest.raises(RuntimeError, match="hype OpenAI coverage"):
        youtube_short._download_section_clip(ctx, section)


def test_download_section_clip_rejects_low_authority_openai_hype_short(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="It follows instructions better, writes cleaner code, and handles longer prompts more reliably.",
        search_hint="OpenAI GPT-4 instruction following coding long context",
        duration_seconds=5,
    )

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "hype-short",
                "title": "GPT-4.1: AI Just Got a HUGE Upgrade! Coding, Context & Costs Slashed! #gpt4 #AI #OpenAI #Tech",
                "channel_title": "Solo AI Clips",
                "description": "Vertical AI news short with stock robot and cupcake visuals.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_video_duration", lambda video_id: 55.0)
    monkeypatch.setattr(
        youtube_short,
        "_pick_transcript_window",
        lambda *args: (42.0, 48.0, {"source": "transcript", "score": 3.0, "text": "follows instruction every single time"}),
    )
    monkeypatch.setattr(youtube_short, "_download_clip", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not download")))

    with pytest.raises(RuntimeError, match="hype OpenAI coverage"):
        youtube_short._download_section_clip(ctx, section)


def test_download_section_clip_uses_candidate_duration_before_yt_dlp_probe(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="GPT-4o is capable of real-time responses.",
        search_hint="OpenAI GPT-4o realtime official demo",
        duration_seconds=5,
    )
    seen: dict[str, object] = {}

    monkeypatch.setattr(
        youtube_short,
        "_search_section_video_candidates",
        lambda *args, **kwargs: [
            {
                "video_id": "official-gpt4o",
                "title": "Introducing GPT-4o",
                "channel_title": "OpenAI",
                "description": "Official GPT-4o launch demo.",
                "duration_seconds": 1530.0,
                "_search_provider": "youtube_data_api",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_video_duration", lambda *args: (_ for _ in ()).throw(AssertionError("yt-dlp duration probe should not run")))

    def fake_transcript_window(video_id: str, total_duration: float, wanted_duration: float, section_arg: object):
        seen["duration"] = total_duration
        return 1338.0, 1343.0, {"source": "transcript", "score": 4.0, "text": "GPT-4o is capable of real-time"}

    def fake_download(video_id: str, start: float, duration: float, *, out_dir: str, proxy_url: str | None = None) -> str:
        path = Path(out_dir) / "clip.mp4"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"clip")
        return str(path)

    monkeypatch.setattr(youtube_short, "_pick_transcript_window", fake_transcript_window)
    monkeypatch.setattr(youtube_short, "_download_clip", fake_download)

    asset = youtube_short._download_section_clip(ctx, section, search_provider="youtube_data_api")

    assert seen["duration"] == 1530.0
    assert asset["video_id"] == "official-gpt4o"


def test_youtube_data_api_search_candidates_attach_duration_metadata(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        youtube_short,
        "_search_response",
        lambda *args, **kwargs: {
            "_youtube_api_key_alias": "YOUTUBE_API_KEY_1",
            "items": [
                {
                    "id": {"videoId": "gpt4o"},
                    "snippet": {
                        "title": "Introducing GPT-4o",
                        "channelTitle": "OpenAI",
                        "publishedAt": "2024-05-13T17:00:00Z",
                        "description": "Official GPT-4o launch demo.",
                    },
                }
            ],
        },
    )
    monkeypatch.setattr(
        youtube_short,
        "_youtube_video_details_response",
        lambda video_ids: {"items": [{"id": "gpt4o", "contentDetails": {"duration": "PT25M30S"}}]},
        raising=False,
    )

    candidates = youtube_short._youtube_data_api_search_candidates("OpenAI GPT-4o official demo", limit=1)

    assert candidates[0]["video_id"] == "gpt4o"
    assert candidates[0]["duration_seconds"] == 1530.0


def test_youtube_data_api_factual_search_merges_literal_relevance_candidates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, object]] = []

    def fake_search_response(query: str, limit: int, *, factual: bool, published_after: str | None) -> dict:
        calls.append({"query": query, "factual": factual, "published_after": published_after})
        if factual:
            return {
                "_youtube_api_key_alias": "YOUTUBE_API_KEY_1",
                "items": [
                    {
                        "id": {"videoId": "api-key-news"},
                        "snippet": {
                            "title": "How to Get an OpenAI ChatGPT API Key - 2026 Updated",
                            "channelTitle": "Tutorial Channel",
                            "publishedAt": "2026-05-20T00:00:00Z",
                            "description": "OpenAI API key walkthrough for beginners.",
                        },
                    }
                ],
            }
        return {
            "_youtube_api_key_alias": "YOUTUBE_API_KEY_1",
            "items": [
                {
                    "id": {"videoId": "gpt4o-official"},
                    "snippet": {
                        "title": "Introducing GPT-4o",
                        "channelTitle": "OpenAI",
                        "publishedAt": "2024-05-13T17:45:43Z",
                        "description": "Official GPT-4o model demo with voice and vision.",
                    },
                }
            ],
        }

    monkeypatch.setattr(youtube_short, "_search_response", fake_search_response)
    monkeypatch.setattr(
        youtube_short,
        "_youtube_video_details_response",
        lambda video_ids: {
            "items": [
                {"id": video_id, "contentDetails": {"duration": "PT5M"}}
                for video_id in video_ids
            ]
        },
        raising=False,
    )

    candidates = youtube_short._youtube_data_api_search_candidates("OpenAI GPT-4o news official demo", limit=5)

    assert [call["factual"] for call in calls] == [True, False]
    assert {candidate["video_id"] for candidate in candidates} == {"api-key-news", "gpt4o-official"}
    assert candidates[0]["video_id"] == "gpt4o-official"


def test_youtube_data_api_current_event_search_keeps_recent_results_when_present(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, object]] = []

    def fake_search_response(query: str, limit: int, *, factual: bool, published_after: str | None) -> dict:
        calls.append({"query": query, "factual": factual, "published_after": published_after})
        return {
            "_youtube_api_key_alias": "YOUTUBE_API_KEY_1",
            "items": [
                {
                    "id": {"videoId": "recent-launch"},
                    "snippet": {
                        "title": "Latest Starship launch update",
                        "channelTitle": "Space Channel",
                        "publishedAt": "2026-05-20T00:00:00Z",
                        "description": "Current launch update footage.",
                    },
                }
            ],
        }

    monkeypatch.setattr(youtube_short, "_search_response", fake_search_response)
    monkeypatch.setattr(
        youtube_short,
        "_youtube_video_details_response",
        lambda video_ids: {"items": [{"id": "recent-launch", "contentDetails": {"duration": "PT2M"}}]},
        raising=False,
    )

    candidates = youtube_short._youtube_data_api_search_candidates("latest SpaceX Starship launch update", limit=5)

    assert [call["factual"] for call in calls] == [True]
    assert candidates[0]["video_id"] == "recent-launch"


def test_youtube_data_api_video_details_request_matches_notebook_metadata_batch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: dict[str, object] = {}

    class FakeListRequest:
        def execute(self) -> dict:
            return {"items": []}

    class FakeVideos:
        def list(self, **kwargs: object) -> FakeListRequest:
            seen.update(kwargs)
            return FakeListRequest()

    class FakeClient:
        def videos(self) -> FakeVideos:
            return FakeVideos()

    monkeypatch.setattr(youtube_short, "_youtube_client", lambda: FakeClient())

    youtube_short._youtube_video_details_response(["abc123", "def456"])

    assert seen["part"] == "snippet,statistics,contentDetails"
    assert seen["id"] == "abc123,def456"


def test_youtube_data_api_search_candidates_attach_notebook_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        youtube_short,
        "_search_response",
        lambda *args, **kwargs: {
            "_youtube_api_key_alias": "YOUTUBE_API_KEY_1",
            "items": [
                {
                    "id": {"videoId": "gpt4o"},
                    "snippet": {
                        "title": "Introducing GPT-4o",
                        "channelTitle": "OpenAI",
                        "publishedAt": "2024-05-13T17:45:43Z",
                        "description": "Official GPT-4o launch demo.",
                    },
                }
            ],
        },
    )
    monkeypatch.setattr(
        youtube_short,
        "_youtube_video_details_response",
        lambda video_ids: {
            "items": [
                {
                    "id": "gpt4o",
                    "snippet": {"tags": ["GPT-4o", "OpenAI"]},
                    "statistics": {"viewCount": "123456", "commentCount": "789"},
                    "contentDetails": {"duration": "PT25M30S", "definition": "hd", "dimension": "2d"},
                }
            ]
        },
        raising=False,
    )

    candidates = youtube_short._youtube_data_api_search_candidates("OpenAI GPT-4o official demo", limit=1)

    assert candidates[0]["duration_seconds"] == 1530.0
    assert candidates[0]["view_count"] == 123456
    assert candidates[0]["comment_count"] == 789
    assert candidates[0]["tags"] == ["GPT-4o", "OpenAI"]
    assert candidates[0]["definition"] == "hd"
    assert candidates[0]["dimension"] == "2d"


def test_download_section_clip_rejects_low_authority_openai_commentary_stock_visuals(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="That matters because apps can read bigger codebases and documents in one pass.",
        search_hint="OpenAI GPT-4.1 one million token context",
        duration_seconds=5,
    )

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "stock-ai-news",
                "title": "OpenAI's GPT-4.1 Is HERE - The Most Powerful ChatGPT Ever Released (1M Tokens!)",
                "channel_title": "AI Horizon Daily",
                "description": "AI news commentary with generated office imagery and code screens.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_video_duration", lambda video_id: 60.0)
    monkeypatch.setattr(
        youtube_short,
        "_pick_transcript_window",
        lambda *args: (22.0, 27.0, {"source": "transcript", "score": 3.0, "text": "million token context bigger codebases"}),
    )
    monkeypatch.setattr(youtube_short, "_download_clip", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not download")))

    with pytest.raises(RuntimeError, match="reputable OpenAI source"):
        youtube_short._download_section_clip(ctx, section)


def test_download_section_clip_rejects_named_reputable_source_mismatch_for_openai_scene(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="Reuters framed GPT-4o's free-user access as a shift toward everyday multimodal use.",
        search_hint="Reuters OpenAI GPT-4o free users May 2024",
        duration_seconds=5,
    )

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "openai-official",
                "title": "Introducing GPT-4o",
                "channel_title": "OpenAI",
                "description": "Product launch demo from the official OpenAI channel.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_video_duration", lambda video_id: 60.0)
    monkeypatch.setattr(
        youtube_short,
        "_pick_transcript_window",
        lambda *args: (35.0, 40.0, {"source": "transcript", "score": 3.0, "text": "free version of chat GPT"}),
    )
    monkeypatch.setattr(youtube_short, "_download_clip", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not download")))

    with pytest.raises(RuntimeError, match="requested reputable source"):
        youtube_short._download_section_clip(ctx, section)


def test_download_section_clip_rejects_official_openai_demo_from_untrusted_channel(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="OpenAI also showed desktop ChatGPT and camera sharing, so it sees context.",
        search_hint="OpenAI desktop ChatGPT camera sharing demo official",
        duration_seconds=5,
    )

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "job-interview",
                "title": "Using chatgpt to interview for Openai is next level #career #jobinterview",
                "channel_title": "Auzio",
                "description": "Vertical job interview clip using ChatGPT.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_video_duration", lambda video_id: 45.0)
    monkeypatch.setattr(
        youtube_short,
        "_pick_transcript_window",
        lambda *args: (4.0, 9.0, {"source": "transcript", "score": 3.0, "text": "OpenAI ChatGPT camera sharing"}),
    )
    monkeypatch.setattr(youtube_short, "_download_clip", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not download")))

    with pytest.raises(RuntimeError, match="official OpenAI source"):
        youtube_short._download_section_clip(ctx, section)


def test_download_section_clip_allows_reputable_openai_coverage_when_not_official_only(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="ChatGPT is rolling out Dreaming, with smarter memory for fresher replies.",
        search_hint="ChatGPT Dreaming OpenAI reputable news",
        duration_seconds=5,
    )

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "dreaming-news",
                "title": "OpenAI launches Dreaming memory for ChatGPT",
                "channel_title": "The Verge",
                "description": "Reputable coverage of OpenAI's ChatGPT Dreaming memory rollout.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_video_duration", lambda video_id: 40.0)
    monkeypatch.setattr(
        youtube_short,
        "_pick_transcript_window",
        lambda *args: (4.0, 9.0, {"source": "transcript", "score": 3.0, "text": "ChatGPT Dreaming memory"}),
    )
    monkeypatch.setattr(youtube_short, "_download_clip", lambda *args, **kwargs: str(tmp_path / "dreaming.mp4"))

    asset = youtube_short._download_section_clip(ctx, section)

    assert asset["video_id"] == "dreaming-news"


def test_download_section_clip_does_not_require_openai_channel_for_official_or_reputable_query(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="ChatGPT is rolling out Dreaming, with smarter memory for fresher replies.",
        search_hint="ChatGPT Dreaming OpenAI official or reputable news",
        duration_seconds=5,
    )

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "dreaming-verge",
                "title": "OpenAI launches Dreaming memory for ChatGPT",
                "channel_title": "The Verge",
                "description": "Reputable coverage of ChatGPT Dreaming.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_video_duration", lambda video_id: 40.0)
    monkeypatch.setattr(
        youtube_short,
        "_pick_transcript_window",
        lambda *args: (4.0, 9.0, {"source": "transcript", "score": 3.0, "text": "ChatGPT Dreaming memory"}),
    )
    monkeypatch.setattr(youtube_short, "_download_clip", lambda *args, **kwargs: str(tmp_path / "dreaming.mp4"))

    asset = youtube_short._download_section_clip(ctx, section)

    assert asset["video_id"] == "dreaming-verge"


def test_download_section_clip_rejects_openai_o_series_model_mismatch(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="OpenAI's newest release is o3 and o4-mini, aimed at harder reasoning tasks.",
        search_hint="OpenAI o3 o4-mini reasoning model update",
        duration_seconds=5,
    )

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "gpt54-news",
                "title": "GPT-5.4 Mini and Nano: OpenAI's Fastest Models Yet",
                "channel_title": "Universe of AI",
                "description": "Coverage of GPT-5.4 mini and nano availability.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_video_duration", lambda video_id: 70.0)
    monkeypatch.setattr(
        youtube_short,
        "_pick_transcript_window",
        lambda *args: (4.0, 9.0, {"source": "transcript", "score": 3.0, "text": "reasoning model availability and pricing"}),
    )
    monkeypatch.setattr(youtube_short, "_download_clip", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not download")))

    with pytest.raises(RuntimeError, match="required OpenAI model"):
        youtube_short._download_section_clip(ctx, section)


def test_download_section_clip_rejects_generic_keynote_for_iphone_scene(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="By the end, the first iPhone felt like the future had arrived early.",
        search_hint="Steve Jobs iPhone 2007 keynote applause finale",
        duration_seconds=5,
    )

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "generic-keynote",
                "title": "Traditional keynote endings",
                "channel_title": "Presentation Archive",
                "description": "A compilation of keynote closing remarks.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_pick_transcript_window", lambda *args: None, raising=False)
    monkeypatch.setattr(youtube_short, "_video_duration", lambda *args: (_ for _ in ()).throw(AssertionError("duration should not be probed")))
    monkeypatch.setattr(youtube_short, "_download_clip", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not download")))

    with pytest.raises(RuntimeError, match="required iPhone keynote subject"):
        youtube_short._download_section_clip(ctx, section)


def test_download_section_clip_rejects_generic_steve_jobs_keynote_without_iphone_metadata(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="Jobs revealed that the phone, iPod, and internet communicator were one product: iPhone.",
        search_hint="Steve Jobs iPhone 2007 keynote reveal",
        duration_seconds=5,
    )

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "generic-jobs",
                "title": "Steve Jobs keynote presentation style breakdown",
                "channel_title": "Business Talks",
                "description": "Generic presentation advice from famous keynotes.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_video_duration", lambda video_id: 80.0)
    monkeypatch.setattr(
        youtube_short,
        "_pick_transcript_window",
        lambda *args: (20.0, 25.0, {"source": "transcript", "score": 3.0, "text": "Steve Jobs keynote reveal"}),
    )
    monkeypatch.setattr(youtube_short, "_download_clip", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not download")))

    with pytest.raises(RuntimeError, match="required iPhone keynote subject"):
        youtube_short._download_section_clip(ctx, section)


def test_download_section_clip_rejects_podcast_title_card_for_iphone_keynote_scene(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="At Macworld 2007, the room felt electric before Steve Jobs even started.",
        search_hint="Steve Jobs Macworld 2007 keynote opening stage audience",
        duration_seconds=5,
    )

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "podcast-title-card",
                "title": "Steve Jobs' Historic Macworld Keynote and Bombshell",
                "channel_title": "Apple Keynote Chronicles by Computer Clan",
                "description": "A podcast episode about Apple keynote history.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_video_duration", lambda video_id: 90.0)
    monkeypatch.setattr(
        youtube_short,
        "_pick_transcript_window",
        lambda *args: (10.0, 15.0, {"source": "transcript", "score": 3.0, "text": "Steve Jobs Macworld keynote"}),
    )
    monkeypatch.setattr(youtube_short, "_download_clip", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not download")))

    with pytest.raises(RuntimeError, match="podcast or commentary"):
        youtube_short._download_section_clip(ctx, section)


def test_download_section_clip_rejects_steve_jobs_memorial_for_macworld_2007_keynote_scene(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="At Macworld 2007, Steve Jobs walked onstage before introducing the first iPhone.",
        search_hint="Steve Jobs Macworld 2007 keynote opening stage entrance",
        duration_seconds=5,
    )

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "celebrating-steve",
                "title": "Celebrating Steve | October 5 | Apple",
                "channel_title": "Apple",
                "description": "A memorial film about Steve Jobs.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_video_duration", lambda video_id: 70.0)
    monkeypatch.setattr(
        youtube_short,
        "_pick_transcript_window",
        lambda *args: (40.0, 45.0, {"source": "transcript", "score": 3.0, "text": "I'm Steve Jobs from Apple Computer"}),
    )
    monkeypatch.setattr(youtube_short, "_download_clip", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not download")))

    with pytest.raises(RuntimeError, match="2007 Macworld keynote"):
        youtube_short._download_section_clip(ctx, section)


def test_download_section_clip_rejects_modern_iphone_tutorial_for_pre_iphone_keyboard_scene(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="Before the iPhone, phones had tiny physical keyboards and clunky web browsing.",
        search_hint="mobile phones with physical keyboards 2006 b-roll",
        duration_seconds=5,
    )

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "iphone14-keyboard",
                "title": "How to Use Mouse and Keyboard on iPhone 14 Pro Max",
                "channel_title": "Fix369",
                "description": "Modern iPhone keyboard accessory tutorial.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_video_duration", lambda video_id: 180.0)
    monkeypatch.setattr(
        youtube_short,
        "_pick_transcript_window",
        lambda *args: (20.0, 25.0, {"source": "transcript", "score": 3.0, "text": "keyboard with your iPhone"}),
    )
    monkeypatch.setattr(youtube_short, "_download_clip", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not download")))

    with pytest.raises(RuntimeError, match="modern iPhone footage"):
        youtube_short._download_section_clip(ctx, section)


def test_download_section_clip_rejects_long_video_visual_fallback_without_transcript(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="By the end, the room knew this keynote had changed the direction of consumer tech.",
        search_hint="Macworld 2007 audience applause Steve Jobs iPhone keynote finale",
        duration_seconds=5,
    )

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "full-keynote",
                "title": "Macworld 2007 keynote Steve Jobs presents the 1st iPhone & Apple TV",
                "channel_title": "Apple Archive",
                "description": "Full presentation.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_video_duration", lambda video_id: 4800.0)
    monkeypatch.setattr(youtube_short, "_pick_transcript_window", lambda *args: None, raising=False)
    monkeypatch.setattr(youtube_short, "_download_clip", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not download")))

    with pytest.raises(RuntimeError, match="too long for visual fallback"):
        youtube_short._download_section_clip(ctx, section)


def test_download_section_clip_rejects_visual_fallback_with_low_specific_overlap(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="Restorers use water and wooden picks to lift debris slowly.",
        search_hint="ancient coin restoration cleaning wooden pick microscope",
        duration_seconds=5,
    )

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "pcgs-talk",
                "title": "PCGS Restoration Fail? Do You Still Get Charged If They Don't Restore?",
                "channel_title": "CoinHELPu",
                "description": "A talking-head coin grading discussion.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_pick_transcript_window", lambda *args: None, raising=False)
    monkeypatch.setattr(youtube_short, "_video_duration", lambda *args: (_ for _ in ()).throw(AssertionError("duration should not be probed")))
    monkeypatch.setattr(youtube_short, "_download_clip", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not download")))

    with pytest.raises(RuntimeError, match="metadata does not match"):
        youtube_short._download_section_clip(ctx, section)


def test_download_section_clip_rejects_openai_visual_fallback_missing_specific_product(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="ChatGPT is rolling out Dreaming, with smarter memory for fresher replies.",
        search_hint="ChatGPT Dreaming OpenAI news",
        duration_seconds=5,
    )

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "dream-room",
                "title": "Design your dream room by shopping with ChatGPT",
                "channel_title": "OpenAI",
                "description": "A shopping demo for interior design.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_pick_transcript_window", lambda *args: None, raising=False)
    monkeypatch.setattr(youtube_short, "_video_duration", lambda video_id: 40.0)
    monkeypatch.setattr(youtube_short, "_download_clip", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not download")))

    with pytest.raises(RuntimeError, match="metadata does not match search intent"):
        youtube_short._download_section_clip(ctx, section)


def test_download_section_clip_rejects_generic_modern_coin_footage_for_ancient_coin_scene(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="The restorer reveals ancient lettering and the portrait under the grime.",
        search_hint="ancient coin restoration reveal portrait lettering macro",
        duration_seconds=5,
    )

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "modern-quarter",
                "title": "Modern quarter coin roll hunting macro close up",
                "channel_title": "Coin Hobby",
                "description": "Modern pocket change coins under a microscope.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_video_duration", lambda *args: (_ for _ in ()).throw(AssertionError("duration should not be probed")))
    monkeypatch.setattr(youtube_short, "_pick_transcript_window", lambda *args: None, raising=False)
    monkeypatch.setattr(youtube_short, "_download_clip", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not download")))

    with pytest.raises(RuntimeError, match="required ancient coin subject"):
        youtube_short._download_section_clip(ctx, section)


def test_download_section_clip_rejects_us_dollar_coin_for_ancient_coin_discovery_scene(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="It starts as a crusted disk pulled from the soil, almost impossible to read.",
        search_hint="ancient coin found in dirt close up",
        duration_seconds=5,
    )

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "us-eagle-dollar",
                "title": "Rare One Dollar Coin Found in Dirt? Valuable U.S. Eagle Dollar Revealed",
                "channel_title": "Numismatic Coins",
                "description": "Modern United States silver dollars and everyday circulation coins.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_video_duration", lambda video_id: 90.0)
    monkeypatch.setattr(
        youtube_short,
        "_pick_transcript_window",
        lambda *args: (10.0, 15.0, {"source": "transcript", "score": 3.0, "text": "one dollar coin found in dirt"}),
    )
    monkeypatch.setattr(youtube_short, "_download_clip", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not download")))

    with pytest.raises(RuntimeError, match="required ancient coin subject"):
        youtube_short._download_section_clip(ctx, section)


def test_download_section_clip_rejects_ancient_non_coin_artifact_for_coin_scene(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="At first, the ancient coin looks like a dirt-caked disc from underground.",
        search_hint="ancient coin found in soil excavation close up",
        duration_seconds=5,
    )

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "ancient-stones",
                "title": "Ancient ceremonial stones discovered at pyramid",
                "channel_title": "AP Archive",
                "description": "Archaeologists document stones at a temple site.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_video_duration", lambda *args: (_ for _ in ()).throw(AssertionError("duration should not be probed")))
    monkeypatch.setattr(youtube_short, "_pick_transcript_window", lambda *args: None, raising=False)
    monkeypatch.setattr(youtube_short, "_download_clip", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not download")))

    with pytest.raises(RuntimeError, match="required ancient coin subject"):
        youtube_short._download_section_clip(ctx, section)


def test_download_section_clip_rejects_clickbait_mining_artifacts_for_ancient_coin_scene(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="This crusty coin looks worthless, but its history is trapped underneath.",
        search_hint="ancient coin close up unrestored dirt macro",
        duration_seconds=5,
    )

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "miners-artifacts",
                "title": "Miners found coins 350 million years old #ancient #history #facts #mystery",
                "channel_title": "Mystery Shorts",
                "description": "Miners found ancient artifacts underground.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_video_duration", lambda video_id: 42.0)
    monkeypatch.setattr(youtube_short, "_pick_transcript_window", lambda *args: None, raising=False)
    monkeypatch.setattr(youtube_short, "_download_clip", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not download")))

    with pytest.raises(RuntimeError, match="required ancient coin subject"):
        youtube_short._download_section_clip(ctx, section)


def test_download_section_clip_rejects_unrelated_sports_clip_for_saquon_scene(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="Saquon Barkley broke free for a long touchdown during the Eagles season.",
        search_hint="Saquon Barkley Eagles long touchdown 2024 highlights",
        duration_seconds=5,
    )

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "generic-eagles",
                "title": "Eagles vs Rams long touchdown highlights 2024",
                "channel_title": "NFL Clips",
                "description": "A different player scores during an Eagles game.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_video_duration", lambda *args: (_ for _ in ()).throw(AssertionError("duration should not be probed")))
    monkeypatch.setattr(youtube_short, "_pick_transcript_window", lambda *args: None, raising=False)
    monkeypatch.setattr(youtube_short, "_download_clip", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not download")))

    with pytest.raises(RuntimeError, match="required Saquon Barkley subject"):
        youtube_short._download_section_clip(ctx, section)


def test_download_section_clip_rejects_sports_interview_for_saquon_highlight_scene(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="Against the Bengals, the jump cuts looked unfair.",
        search_hint="Saquon Barkley Bengals highlights Eagles 2024",
        duration_seconds=5,
    )

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "post-interview",
                "title": "Saquon Barkley post interview from week 8 game Eagles vs Bengals 2024",
                "channel_title": "Snap N Shove",
                "description": "Sideline interview after the game.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_video_duration", lambda video_id: 60.0)
    monkeypatch.setattr(
        youtube_short,
        "_pick_transcript_window",
        lambda *args: (12.0, 17.0, {"source": "transcript", "score": 3.0, "text": "Saquon Barkley Eagles Bengals"}),
    )
    monkeypatch.setattr(youtube_short, "_download_clip", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not download")))

    with pytest.raises(RuntimeError, match="sports commentary or interview"):
        youtube_short._download_section_clip(ctx, section)


def test_download_section_clip_rejects_talking_head_show_for_saquon_highlight_scene(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="In Brazil, Saquon opened with three touchdowns and instantly changed the Eagles offense.",
        search_hint="Saquon Barkley Brazil Packers Week 1 three touchdowns Eagles highlights",
        duration_seconds=5,
    )

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "mott-show",
                "title": "Saquon Barkley just put the NFL on NOTICE vs Packers...",
                "channel_title": "The Thomas Mott Show",
                "description": "A studio talking-head reaction to the Eagles offense.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_video_duration", lambda video_id: 90.0)
    monkeypatch.setattr(
        youtube_short,
        "_pick_transcript_window",
        lambda *args: (12.0, 17.0, {"source": "transcript", "score": 3.0, "text": "Saquon puts the Eagles offense on notice"}),
    )
    monkeypatch.setattr(youtube_short, "_download_clip", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not download")))

    with pytest.raises(RuntimeError, match="sports commentary or interview"):
        youtube_short._download_section_clip(ctx, section)


def test_download_section_clip_rejects_reaction_overlay_for_saquon_highlight_scene(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="Then came the Jaguars game, where he hit a spin and cleared a defender backward.",
        search_hint="Saquon Barkley Jaguars backward hurdle spin move 2024",
        duration_seconds=5,
    )

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "reactors",
                "title": "Reactors Reacting To The Saquon Barkley Backwards Hurdle",
                "channel_title": "MagnumDB",
                "description": "Reaction compilation with face-cam overlays.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_video_duration", lambda video_id: 45.0)
    monkeypatch.setattr(
        youtube_short,
        "_pick_transcript_window",
        lambda *args: (8.0, 13.0, {"source": "transcript", "score": 3.0, "text": "Saquon Barkley backwards hurdle"}),
    )
    monkeypatch.setattr(youtube_short, "_download_clip", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not download")))

    with pytest.raises(RuntimeError, match="sports commentary or interview"):
        youtube_short._download_section_clip(ctx, section)


def test_download_section_clip_rejects_sports_news_aggregator_for_saquon_highlight_scene(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="December became his closing argument, with defenses out of answers.",
        search_hint="Saquon Barkley 2000 rushing yards Cowboys Eagles December 2024 highlights",
        duration_seconds=5,
    )

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "chat-sports",
                "title": "Philadelphia Eagles Get AMAZING NEWS After CRUSHING Cowboys Ft. Saquon Barkley",
                "channel_title": "Eagles Now by Chat Sports",
                "description": "Talking-head news and rumors show.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_video_duration", lambda video_id: 120.0)
    monkeypatch.setattr(
        youtube_short,
        "_pick_transcript_window",
        lambda *args: (20.0, 25.0, {"source": "transcript", "score": 3.0, "text": "Saquon Barkley Cowboys Eagles"}),
    )
    monkeypatch.setattr(youtube_short, "_download_clip", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not download")))

    with pytest.raises(RuntimeError, match="sports commentary or interview"):
        youtube_short._download_section_clip(ctx, section)


def test_download_section_clip_rejects_sports_news_recap_for_action_scene(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="Versus the Rams, the explosiveness kept coming, and 255 rushing yards buried them.",
        search_hint="Saquon Barkley Rams 255 rushing yards Eagles 2024",
        duration_seconds=5,
    )

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "news-recap",
                "title": "Saquon Barkley's Monster Night: 255 Yards Eagles Fly Past Rams 37-20",
                "channel_title": "The National Voice",
                "description": "Player photos and a short highlight package.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_video_duration", lambda video_id: 80.0)
    monkeypatch.setattr(
        youtube_short,
        "_pick_transcript_window",
        lambda *args: (20.0, 25.0, {"source": "transcript", "score": 3.0, "text": "255 rushing yards Eagles Rams"}),
    )
    monkeypatch.setattr(youtube_short, "_download_clip", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not download")))

    with pytest.raises(RuntimeError, match="sports commentary or interview"):
        youtube_short._download_section_clip(ctx, section)


def test_download_section_clip_rejects_saquon_week_18_news_for_milestone_highlight_scene(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="When Saquon crossed two thousand rushing yards, the milestone capped his comeback season.",
        search_hint="Saquon Barkley 2000 rushing yards Eagles 2024 milestone highlight",
        duration_seconds=5,
    )

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "sit-week-18",
                "title": "Saquon Barkley to sit Week 18 for Eagles, ending chase for NFL single-season rushing record",
                "channel_title": "Sports News Channel",
                "description": "News recap about the Eagles resting Barkley instead of game highlight footage.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_video_duration", lambda video_id: 80.0)
    monkeypatch.setattr(
        youtube_short,
        "_pick_transcript_window",
        lambda *args: (13.0, 18.0, {"source": "transcript", "score": 3.0, "text": "ending his pursuit of the NFL single season rushing"}),
    )
    monkeypatch.setattr(youtube_short, "_download_clip", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not download")))

    with pytest.raises(RuntimeError, match="sports commentary or interview"):
        youtube_short._download_section_clip(ctx, section)


def test_download_section_clip_rejects_submarine_explainer_for_research_review_scene(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="Later, researchers study the footage and hunt for clues about what survives below.",
        search_hint="deep sea marine researchers reviewing underwater footage lab",
        duration_seconds=5,
    )

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "military-submarine",
                "title": "Deep Ocean Military Secrets: Submarines, Hydrophones, and Tests",
                "channel_title": "Frontline Footage Lab",
                "description": "Animated military submarine explainer about deep ocean pressure.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_video_duration", lambda video_id: 120.0)
    monkeypatch.setattr(
        youtube_short,
        "_pick_transcript_window",
        lambda *args: (30.0, 35.0, {"source": "transcript", "score": 3.0, "text": "deep sea pressure footage lab"}),
    )
    monkeypatch.setattr(youtube_short, "_download_clip", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not download")))

    with pytest.raises(RuntimeError, match="required research scene"):
        youtube_short._download_section_clip(ctx, section)


def test_download_section_clip_rejects_deep_sea_survey_without_research_review_visual_cues(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="Back on deck, researchers replay every frame from the deep sea cameras.",
        search_hint="deep sea marine researchers reviewing monitor footage research vessel",
        duration_seconds=5,
    )

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "survey",
                "title": "Automating a 20-year survey of deep-sea animals",
                "channel_title": "MBARI (Monterey Bay Aquarium Research Institute)",
                "description": "Researchers launched a study of deep-sea animals.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_video_duration", lambda video_id: 90.0)
    monkeypatch.setattr(
        youtube_short,
        "_pick_transcript_window",
        lambda *args: (5.0, 11.0, {"source": "transcript", "score": 4.0, "text": "Researchers launched a study of deep-sea"}),
    )
    monkeypatch.setattr(youtube_short, "_download_clip", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not download")))

    with pytest.raises(RuntimeError, match="required research review scene"):
        youtube_short._download_section_clip(ctx, section)


def test_download_section_clip_rejects_generic_factoid_short_for_deep_sea_creature_scene(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="Out there, living sparks and drifting giants rewrite what life can be.",
        search_hint="bioluminescent jellyfish strange deep sea creatures footage",
        duration_seconds=5,
    )

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "top-five",
                "title": "Top 5 most dangerous deep sea creatures #facts #animals #wildlife",
                "channel_title": "FactPaw",
                "description": "Generic ranking short with unrelated animal facts.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_video_duration", lambda video_id: 45.0)
    monkeypatch.setattr(
        youtube_short,
        "_pick_transcript_window",
        lambda *args: (8.0, 13.0, {"source": "transcript", "score": 3.0, "text": "deep sea creature facts"}),
    )
    monkeypatch.setattr(youtube_short, "_download_clip", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not download")))

    with pytest.raises(RuntimeError, match="generic factoid clip"):
        youtube_short._download_section_clip(ctx, section)


def test_download_section_clip_rejects_myth_deep_sea_clip_for_research_review_scene(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="When the team finally reviews the footage, every strange flicker becomes a clue.",
        search_hint="marine researchers reviewing deep sea footage",
        duration_seconds=5,
    )

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "mythveil-morgawr",
                "title": "[Part 9] Morgawr | The Footage That Terrified Marine Researchers",
                "channel_title": "Mythveil",
                "description": "Dramatized sea-monster story with fictional creature footage.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_video_duration", lambda video_id: 90.0)
    monkeypatch.setattr(
        youtube_short,
        "_pick_transcript_window",
        lambda *args: (12.0, 17.0, {"source": "transcript", "score": 3.0, "text": "strange moments of stillness"}),
    )
    monkeypatch.setattr(youtube_short, "_download_clip", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not download")))

    with pytest.raises(RuntimeError, match="dramatized or stock deep-sea footage"):
        youtube_short._download_section_clip(ctx, section)


def test_download_section_clip_rejects_stock_deep_sea_source_for_creature_scene(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="Then the locals appear, glassy, glowing, almost alien.",
        search_hint="bioluminescent deep sea creatures footage",
        duration_seconds=5,
    )

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "beyond-abyss",
                "title": "Sea Lanterns: The Amazing Bioluminescent Creatures of the Ocean",
                "channel_title": "Beyond the Abyss - Deep Sea Discoveries",
                "description": "Stock-style generated deep ocean montage.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_video_duration", lambda video_id: 90.0)
    monkeypatch.setattr(
        youtube_short,
        "_pick_transcript_window",
        lambda *args: (12.0, 17.0, {"source": "transcript", "score": 3.0, "text": "bioluminescent marine creatures"}),
    )
    monkeypatch.setattr(youtube_short, "_download_clip", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not download")))

    with pytest.raises(RuntimeError, match="dramatized or stock deep-sea footage"):
        youtube_short._download_section_clip(ctx, section)


def test_download_section_clip_tries_next_candidate_after_visual_verifier_rejects_download(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="The submersible drops below the waves into the dark ocean.",
        search_hint="deep sea submersible descending ocean documentary footage",
        duration_seconds=5,
    )
    rejected_paths: list[str] = []

    monkeypatch.setattr(
        youtube_short,
        "_search_section_video_candidates",
        lambda *args, **kwargs: [
            {
                "video_id": "bad-title-card",
                "title": "Deep Sea Podcast Episode Cover Art",
                "channel_title": "Ocean Chat",
                "description": "A talking-head podcast about submersibles.",
            },
            {
                "video_id": "good-submersible",
                "title": "Deep sea submersible descending ocean documentary footage",
                "channel_title": "Ocean Exploration",
                "description": "Submersible descent footage under the waves.",
            },
        ],
    )
    monkeypatch.setattr(youtube_short, "_video_duration", lambda video_id: 80.0)
    monkeypatch.setattr(
        youtube_short,
        "_pick_transcript_window",
        lambda video_id, *_args: (12.0, 17.0, {"source": "transcript", "score": 3.0, "text": video_id}),
    )

    def fake_download(video_id: str, start: float, duration: float, *, out_dir: str, proxy_url: str | None = None) -> str:
        path = Path(out_dir) / f"{video_id}.mp4"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"clip")
        return str(path)

    def fake_visual_rejection(section_arg: object, candidate: dict[str, object], clip_path: str, window_match: dict[str, object]) -> str | None:
        if candidate["video_id"] == "bad-title-card":
            rejected_paths.append(clip_path)
            return "visual verifier mismatch: title card, not submersible footage"
        return None

    monkeypatch.setattr(youtube_short, "_download_clip", fake_download)
    monkeypatch.setattr(youtube_short, "_clip_visual_rejection_reason", fake_visual_rejection)

    asset = youtube_short._download_section_clip(ctx, section)

    assert asset["video_id"] == "good-submersible"
    assert rejected_paths and rejected_paths[0].endswith("bad-title-card.mp4")


def test_clip_visual_rejection_reason_uses_enabled_visual_judgment(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    section = SimpleNamespace(
        section=1,
        dialogue="Saquon Barkley breaks free for a long touchdown.",
        search_hint="Saquon Barkley long touchdown Eagles highlights",
    )
    candidate = {
        "video_id": "title-card",
        "title": "Saquon Barkley podcast cover art",
        "channel_title": "Sports Talk",
        "description": "Podcast art, not game footage.",
    }
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"clip")

    monkeypatch.setattr(youtube_short, "_visual_verifier_enabled", lambda: True)
    monkeypatch.setattr(
        youtube_short,
        "_openai_visual_match_judgment",
        lambda *args, **kwargs: {"match": False, "reason": "frames show a podcast cover, not football action"},
    )

    reason = youtube_short._clip_visual_rejection_reason(
        section,
        candidate,
        str(clip),
        {"source": "transcript", "score": 3.0, "text": "Saquon long touchdown"},
    )

    assert reason == "visual verifier mismatch: frames show a podcast cover, not football action"


def test_download_section_clip_uses_non_intro_visual_fallback_window(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="Soon the ocean goes black, where headlights shrink and every meter feels borrowed.",
        search_hint="ROV headlights deep ocean darkness",
        duration_seconds=5,
    )
    seen: dict[str, object] = {}

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "rov",
                "title": "ROV headlights reveal deep ocean darkness",
                "channel_title": "Ocean Exploration",
                "description": "Deep ocean ROV footage with lights in darkness.",
            }
        ],
    )
    monkeypatch.setattr(youtube_short, "_video_duration", lambda video_id: 100.0)
    monkeypatch.setattr(youtube_short, "_pick_transcript_window", lambda *args: None, raising=False)

    def fake_download(video_id: str, start: float, duration: float, *, out_dir: str, proxy_url: str | None = None) -> str:
        seen["download"] = (video_id, start, duration)
        path = Path(out_dir) / "clip.mp4"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"clip")
        return str(path)

    monkeypatch.setattr(youtube_short, "_download_clip", fake_download)

    asset = youtube_short._download_section_clip(ctx, section)

    assert asset["window_source"] == "visual_fallback"
    assert seen["download"] == ("rov", 18.0, 5.0)


def test_section_search_queries_add_focused_dialogue_variant_without_generic_terms() -> None:
    section = SimpleNamespace(
        dialogue="The submersible reaches hydrothermal vents where strange animals glow in the dark.",
        search_hint="deep sea submersible descending underwater b-roll",
    )

    queries = youtube_short._section_search_queries(section)

    assert queries[0] == "deep sea submersible descending underwater b-roll"
    assert len(queries) == 2
    assert "hydrothermal" in queries[1]
    assert "b-roll" not in queries[1]
    assert "broll" not in queries[1]


def test_section_search_queries_preserve_latest_intent_for_backup_query() -> None:
    section = SimpleNamespace(
        dialogue="Stage separation worked before splashdown.",
        search_hint="latest SpaceX Starship stage separation",
    )

    queries = youtube_short._section_search_queries(section)

    assert len(queries) == 2
    assert youtube_short._looks_factual_query(queries[1])


def test_search_always_uses_data_api(monkeypatch: pytest.MonkeyPatch) -> None:
    data_api_calls: list[tuple[str, int]] = []

    def fake_data_api_search(query: str, limit: int = 5) -> list[dict[str, str]]:
        data_api_calls.append((query, limit))
        return [{"video_id": "recent", "title": "Latest launch update", "channel_title": "Space News"}]

    monkeypatch.setattr(youtube_short, "_youtube_data_api_search_candidates", fake_data_api_search, raising=False)

    candidates = youtube_short._search_video_candidates("latest SpaceX Starship launch update", limit=6)

    assert candidates[0]["video_id"] == "recent"
    assert candidates[0]["_search_benchmark"]["requested_provider"] == "youtube_data_api"
    assert data_api_calls == [("latest SpaceX Starship launch update", 6)]


def test_legacy_provider_values_coerce_to_data_api(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_data_api_search(query: str, limit: int = 5) -> list[dict[str, str]]:
        return [{"video_id": "codex", "title": "OpenAI Codex official demo", "channel_title": "OpenAI"}]

    monkeypatch.setattr(youtube_short, "_youtube_data_api_search_candidates", fake_data_api_search, raising=False)

    for legacy in ("auto", "yt_dlp", "youtube_data_api"):
        candidates = youtube_short._search_video_candidates_with_provider("OpenAI Codex official demo", 5, legacy)
        assert candidates[0]["_search_benchmark"]["used_provider"] == "youtube_data_api"
    with pytest.raises(ValueError):
        youtube_short._normalize_youtube_search_provider("bing")


def test_generic_section_backoff_variants_stay_compact_and_scene_specific() -> None:
    section = SimpleNamespace(
        dialogue="Researchers review deep sea ROV footage inside the ship lab.",
        search_hint="marine researchers reviewing footage on ship",
    )

    variants = youtube_short._section_backoff_search_hint_variants(section)

    assert variants
    assert variants[0] != section.search_hint
    assert len(variants[0].split()) <= youtube_short.SECTION_QUERY_TOKEN_LIMIT
    assert "deep" in variants[0].lower()
    assert "rov" in variants[0].lower()
    assert "lab" in variants[0].lower()
    assert "b-roll" not in variants[0].lower()


def test_section_candidate_rerank_prefers_scene_specific_metadata() -> None:
    section = SimpleNamespace(
        dialogue="The submersible reaches hydrothermal vents where strange animals glow in the dark.",
        search_hint="deep sea submersible descending underwater b-roll",
    )
    candidates = [
        {
            "video_id": "navy-diver",
            "title": "Navy diver descends along a rope underwater during training",
            "channel_title": "Stock Archive",
            "description": "Generic underwater training footage.",
        },
        {
            "video_id": "vent-rov",
            "title": "ROV films hydrothermal vents on the deep sea floor",
            "channel_title": "Ocean Exploration",
            "description": "Submersible footage of glowing animals near a vent field.",
        },
    ]

    ranked = youtube_short._rank_section_candidates(section, candidates)

    assert ranked[0]["video_id"] == "vent-rov"


def test_download_section_clip_tries_second_ranked_candidate_for_transcript_match(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="The submersible reaches hydrothermal vents.",
        search_hint="deep sea submersible hydrothermal vents",
        duration_seconds=5,
    )
    seen: dict[str, object] = {"transcript_video_ids": []}

    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=10: [
            {
                "video_id": "bad",
                "title": "Submersible reaches hydrothermal vents full expedition",
                "channel_title": "Ocean Exploration",
                "published_at": "2024-01-01T00:00:00Z",
                "description": "Deep sea submersible footage around hydrothermal vent animals.",
            },
            {
                "video_id": "good",
                "title": "ROV hydrothermal vent closeup",
                "channel_title": "Ocean Exploration",
                "published_at": "2024-01-02T00:00:00Z",
                "description": "Submersible reaches vents.",
            },
        ],
    )
    monkeypatch.setattr(youtube_short, "_video_duration", lambda video_id: 120.0)

    def fake_transcript_window(video_id: str, total_duration: float, wanted_duration: float, section_arg: object):
        seen["transcript_video_ids"].append(video_id)
        if video_id == "good":
            return 33.0, 38.0, {"source": "transcript", "score": 3.0, "text": "submersible reaches hydrothermal vents"}
        return None

    def fake_download(video_id: str, start: float, duration: float, *, out_dir: str, proxy_url: str | None = None) -> str:
        seen["download"] = (video_id, start, duration)
        path = Path(out_dir) / "clip.mp4"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"clip")
        return str(path)

    monkeypatch.setattr(youtube_short, "_pick_transcript_window", fake_transcript_window)
    monkeypatch.setattr(youtube_short, "_download_clip", fake_download)

    asset = youtube_short._download_section_clip(ctx, section)

    assert asset["video_id"] == "good"
    assert seen["transcript_video_ids"] == ["bad", "good"]
    assert seen["download"] == ("good", 33.0, 5.0)


def test_download_section_clip_retries_compact_provider_query_after_metadata_rejections(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="The demo showed GPT-4o answering spoken questions while reacting to a phone camera.",
        search_hint=(
            "the latest OpenAI ChatGPT GPT-4o product news from official or reputable sources "
            "OpenAI ChatGPT GPT-4o live demo camera"
        ),
        duration_seconds=5,
    )
    calls: list[tuple[str, str]] = []

    def fake_section_search(
        section_arg: object,
        limit: int = 10,
        search_provider: str = "youtube_data_api",
    ) -> list[dict[str, object]]:
        calls.append((getattr(section_arg, "search_hint"), search_provider))
        if getattr(section_arg, "search_hint") == "OpenAI GPT-4o live demo camera":
            return [
                {
                    "video_id": "gpt4o-demo",
                    "title": "Introducing GPT-4o live demo camera vision",
                    "channel_title": "OpenAI",
                    "description": "Official GPT-4o demo showing camera input and fast spoken answers.",
                }
            ]
        return [
            {
                "video_id": "api-key",
                "title": "OpenAI ChatGPT API Key Tutorial for Beginners",
                "channel_title": "Tutorial Channel",
                "description": "A generic API key walkthrough.",
            }
        ]

    monkeypatch.setattr(youtube_short, "_search_section_video_candidates", fake_section_search)
    monkeypatch.setattr(youtube_short, "_video_duration", lambda video_id: 90.0)
    monkeypatch.setattr(
        youtube_short,
        "_pick_transcript_window",
        lambda *args: (12.0, 17.0, {"source": "transcript", "score": 3.0, "text": "camera input and spoken answers"}),
    )

    def fake_download(video_id: str, start: float, duration: float, *, out_dir: str, proxy_url: str | None = None) -> str:
        path = Path(out_dir) / "clip.mp4"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"clip")
        return str(path)

    monkeypatch.setattr(youtube_short, "_download_clip", fake_download)

    asset = youtube_short._download_section_clip(
        ctx,
        section,
        search_provider="youtube_data_api",
    )

    assert asset["video_id"] == "gpt4o-demo"
    assert calls == [
        (section.search_hint, "youtube_data_api"),
        ("OpenAI GPT-4o live demo camera", "youtube_data_api"),
    ]


def test_download_section_clip_retries_generic_compact_query_after_rejections(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="Researchers review deep sea ROV footage inside the ship lab.",
        search_hint="marine researchers reviewing footage on ship",
        duration_seconds=5,
    )
    calls: list[tuple[str, str]] = []

    def fake_section_search(
        section_arg: object,
        limit: int = 10,
        search_provider: str = "youtube_data_api",
    ) -> list[dict[str, object]]:
        hint = str(getattr(section_arg, "search_hint"))
        calls.append((hint, search_provider))
        if "rov" in hint.lower() and "lab" in hint.lower():
            return [
                {
                    "video_id": "research-lab",
                    "title": "Deep sea ROV footage reviewed in ship laboratory",
                    "channel_title": "Ocean Exploration",
                    "description": "Scientists review deep sea footage in the lab onboard a research vessel.",
                }
            ]
        return [
            {
                "video_id": "city-traffic",
                "title": "City traffic timelapse at night",
                "channel_title": "Urban Streams",
                "description": "Cars and buses moving through a downtown intersection.",
            }
        ]

    monkeypatch.setattr(youtube_short, "_search_section_video_candidates", fake_section_search)
    monkeypatch.setattr(youtube_short, "_video_duration", lambda video_id: 90.0)

    def fake_transcript_window(video_id: str, total_duration: float, wanted_duration: float, section_arg: object):
        if video_id == "research-lab":
            return 12.0, 17.0, {"source": "transcript", "score": 3.0, "text": "researchers review deep sea ROV footage in the ship lab"}
        return None

    def fake_download(video_id: str, start: float, duration: float, *, out_dir: str, proxy_url: str | None = None) -> str:
        path = Path(out_dir) / "clip.mp4"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"clip")
        return str(path)

    monkeypatch.setattr(youtube_short, "_pick_transcript_window", fake_transcript_window)
    monkeypatch.setattr(youtube_short, "_download_clip", fake_download)

    asset = youtube_short._download_section_clip(
        ctx,
        section,
        search_provider="youtube_data_api",
    )

    assert asset["video_id"] == "research-lab"
    assert calls[0] == (section.search_hint, "youtube_data_api")
    assert calls[1][1] == "youtube_data_api"
    assert "rov" in calls[1][0].lower()
    assert "lab" in calls[1][0].lower()


def test_download_section_clip_uses_requested_search_provider_and_records_benchmark(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="The submersible reaches hydrothermal vents.",
        search_hint="deep sea hydrothermal vents",
        duration_seconds=5,
    )
    seen: dict[str, object] = {}

    def fake_section_search(section_arg: object, limit: int = 10, search_provider: str = "youtube_data_api") -> list[dict[str, object]]:
        seen["search_provider"] = search_provider
        return [
            {
                "video_id": "vent",
                "title": "Hydrothermal vents",
                "channel_title": "Ocean",
                "published_at": "2026-05-20T00:00:00Z",
                "_search_benchmark": {
                    "requested_provider": "youtube_data_api",
                    "attempts": [{"provider": "youtube_data_api", "query": "deep sea hydrothermal vents", "duration_ms": 12.5}],
                },
            }
        ]

    def fake_download(video_id: str, start: float, duration: float, *, out_dir: str, proxy_url: str | None = None) -> str:
        path = Path(out_dir) / "clip.mp4"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"clip")
        return str(path)

    monkeypatch.setattr(youtube_short, "_search_section_video_candidates", fake_section_search)
    monkeypatch.setattr(youtube_short, "_video_duration", lambda video_id: 120.0)
    monkeypatch.setattr(
        youtube_short,
        "_pick_transcript_window",
        lambda *args: (33.0, 38.0, {"source": "transcript", "score": 3.0, "text": "hydrothermal vents"}),
    )
    monkeypatch.setattr(youtube_short, "_download_clip", fake_download)

    asset = youtube_short._download_section_clip(ctx, section, search_provider="yt_dlp")

    assert seen["search_provider"] == "youtube_data_api"
    assert asset["youtube_search_provider_requested"] == "youtube_data_api"
    assert asset["youtube_search_provider"] == "youtube_data_api"
    assert asset["youtube_search_benchmark"]["attempts"][0]["duration_ms"] == 12.5


@pytest.mark.asyncio
async def test_download_youtube_clip_assets_passes_search_provider(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(section=1, dialogue="A clip.", search_hint="clip search", duration_seconds=5)
    seen: dict[str, object] = {}

    def fake_download(ctx_arg: main.ProjectContext, section_arg: object, proxy_url: str | None = None, search_provider: str = "youtube_data_api") -> dict:
        seen["search_provider"] = search_provider
        seen["proxy_url"] = proxy_url
        return {"scene_id": "scene_1", "path": str(tmp_path / "clip.mp4")}

    monkeypatch.setattr(youtube_short, "_download_section_clip", fake_download)

    results = await youtube_short.download_youtube_clip_assets(
        ctx,
        [section],
        proxy_url="http://proxy.local",
        search_provider="yt_dlp",
    )

    assert results == [{"scene_id": "scene_1", "path": str(tmp_path / "clip.mp4")}]
    assert seen == {"search_provider": "youtube_data_api", "proxy_url": "http://proxy.local"}


def test_youtube_search_ranking_prefers_official_openai_channel() -> None:
    candidates = [
        {
            "video_id": "creator-short",
            "title": "How I use ChatGPT to create videos in 10 seconds #shorts",
            "channel_title": "Ryan Jordan",
            "description": "AI content tutorial",
        },
        {
            "video_id": "official-openai",
            "title": "Introducing a new OpenAI product",
            "channel_title": "OpenAI",
            "description": "Official product demo and announcement",
        },
    ]

    ranked = youtube_short._rank_video_candidates("latest OpenAI product news official", candidates)

    assert ranked[0]["video_id"] == "official-openai"


def test_strict_search_candidate_depth_is_large_enough_for_metadata_gated_queries() -> None:
    assert youtube_short.SEARCH_CANDIDATE_LIMIT >= 20
    assert youtube_short.TRANSCRIPT_CANDIDATE_LIMIT >= 8


def test_latest_search_retries_relaxed_relevance_when_recent_filter_is_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, object]] = []

    def fake_search_response(query: str, limit: int, *, factual: bool, published_after: str | None) -> dict:
        calls.append({"query": query, "factual": factual, "published_after": published_after})
        if len(calls) == 1:
            return {"items": []}
        return {"items": []}

    monkeypatch.setattr(youtube_short, "_search_response", fake_search_response)
    monkeypatch.setattr(youtube_short, "_yt_dlp_search_candidates", lambda query, limit=5: [], raising=False)

    assert youtube_short._search_video_candidates("latest SpaceX Starship launch update") == []
    assert len(calls) == 2
    assert calls[0]["factual"] is True
    assert calls[0]["published_after"]
    assert calls[1] == {
        "query": "latest SpaceX Starship launch update",
        "factual": False,
        "published_after": None,
    }


def test_openai_news_search_uses_relaxed_relevance_candidates_when_recent_filter_is_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, object]] = []

    def fake_search_response(query: str, limit: int, *, factual: bool, published_after: str | None) -> dict:
        calls.append({"query": query, "factual": factual, "published_after": published_after})
        if factual:
            return {"items": []}
        return {
            "_youtube_api_key_alias": "YOUTUBE_API_KEY_1",
            "items": [
                {
                    "id": {"videoId": "codex-demo"},
                    "snippet": {
                        "title": "OpenAI Codex demo",
                        "channelTitle": "OpenAI",
                        "publishedAt": "2026-05-16T00:00:00Z",
                        "description": "Official Codex demo for developers.",
                    },
                }
            ],
        }

    monkeypatch.setattr(youtube_short, "_search_response", fake_search_response)

    candidates = youtube_short._search_video_candidates("OpenAI Codex news official demo", limit=5)

    assert [call["factual"] for call in calls] == [True, False]
    assert candidates[0]["video_id"] == "codex-demo"
    assert candidates[0]["youtube_api_key_alias"] == "YOUTUBE_API_KEY_1"


def test_latest_openai_search_does_not_relax_to_stale_relevance_when_recent_filter_is_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, object]] = []

    def fake_search_response(query: str, limit: int, *, factual: bool, published_after: str | None) -> dict:
        calls.append({"query": query, "factual": factual, "published_after": published_after})
        if factual:
            return {"items": []}
        return {
            "_youtube_api_key_alias": "YOUTUBE_API_KEY_1",
            "items": [
                {
                    "id": {"videoId": "old-chatgpt-update"},
                    "snippet": {
                        "title": "Updates to deep research in ChatGPT",
                        "channelTitle": "OpenAI",
                        "publishedAt": "2026-02-10T19:30:48Z",
                        "description": "Older ChatGPT update video.",
                    },
                }
            ],
        }

    monkeypatch.setattr(youtube_short, "_search_response", fake_search_response)

    candidates = youtube_short._youtube_data_api_search_candidates("latest OpenAI update ChatGPT news", limit=5)

    assert candidates == []
    assert len(calls) == 1
    assert calls[0]["factual"] is True
    assert calls[0]["published_after"]


def test_section_search_params_map_agent_fields_to_data_api_parameters() -> None:
    section = SimpleNamespace(
        search_order="date",
        published_after="2024-05-01",
        published_before="2024-06-01",
        video_duration="short",
        video_category="science_technology",
        require_captions=True,
        channel_hint="OpenAI",
    )

    params = youtube_short._section_search_params(section)

    assert params == {
        "order": "date",
        "publishedAfter": "2024-05-01T00:00:00Z",
        "publishedBefore": "2024-06-01T00:00:00Z",
        "videoDuration": "short",
        "videoCategoryId": "28",
        "videoCaption": "closedCaption",
    }
    assert youtube_short._section_search_params(SimpleNamespace()) == {}


def test_section_search_params_ignore_invalid_agent_values() -> None:
    section = SimpleNamespace(
        search_order="bogus",
        published_after="not-a-date",
        video_duration="tiny",
        video_category="unknown_category",
        require_captions=False,
    )

    assert youtube_short._section_search_params(section) == {}


def test_agent_search_params_reach_search_list_and_relax_when_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, object] | None] = []

    def fake_search_response(query: str, limit: int, *, factual: bool, published_after: str | None, overrides=None) -> dict:
        calls.append(overrides)
        if overrides and "publishedAfter" in overrides:
            return {"items": []}
        return {
            "items": [
                {
                    "id": {"videoId": "relaxed"},
                    "snippet": {"title": "Relaxed result", "channelTitle": "OpenAI", "publishedAt": "2024-05-14T00:00:00Z", "description": ""},
                }
            ]
        }

    monkeypatch.setattr(youtube_short, "_search_response", fake_search_response)

    candidates = youtube_short._youtube_data_api_search_candidates(
        "OpenAI GPT-4o demo",
        limit=5,
        search_params={"order": "date", "publishedAfter": "2024-05-01T00:00:00Z"},
    )

    assert candidates[0]["video_id"] == "relaxed"
    assert calls[0] == {"order": "date", "publishedAfter": "2024-05-01T00:00:00Z"}
    assert calls[1] is None


def test_channel_hint_joins_section_query_and_boosts_matching_channel() -> None:
    section = SimpleNamespace(
        dialogue="The official demo shows live camera input.",
        search_hint="GPT-4o live demo",
        channel_hint="OpenAI",
    )

    queries = youtube_short._section_search_queries(section)
    assert queries[0] == "GPT-4o live demo OpenAI"

    official = {"video_id": "a", "title": "GPT-4o live demo", "channel_title": "OpenAI", "description": ""}
    other = {"video_id": "b", "title": "GPT-4o live demo", "channel_title": "Random Creator", "description": ""}
    assert youtube_short._section_candidate_score(section, official) > youtube_short._section_candidate_score(section, other)


def test_download_section_clip_recovers_via_web_search_before_failing(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    section = SimpleNamespace(
        section=1,
        dialogue="Mahomes launches a deep touchdown to Worthy.",
        search_hint="Mahomes deep touchdown Worthy highlight",
        duration_seconds=5,
    )

    monkeypatch.setattr(youtube_short, "_search_video_candidates", lambda *a, **k: [])
    monkeypatch.setattr(youtube_short, "_search_video_candidates_with_provider", lambda *a, **k: [])
    monkeypatch.setattr(
        youtube_short,
        "_web_search_video_urls_for_section",
        lambda section_arg: ["https://www.youtube.com/watch?v=recoveryVid"],
    )

    def fake_hydrate(video_ids: list[str], provider: str) -> list[dict[str, object]]:
        if not video_ids:
            return []
        assert video_ids == ["recoveryVid"]
        return [
            {
                "video_id": "recoveryVid",
                "title": "Mahomes deep touchdown to Worthy highlight",
                "channel_title": "NFL",
                "description": "Deep TD launch highlight.",
                "duration_seconds": 90.0,
                "_search_provider": "planner_web_search",
            }
        ]

    monkeypatch.setattr(youtube_short, "_hydrate_candidate_video_ids", fake_hydrate)
    monkeypatch.setattr(
        youtube_short,
        "_pick_transcript_window",
        lambda *args: (10.0, 15.0, {"source": "transcript", "score": 3.0, "text": "deep touchdown to Worthy"}),
    )

    def fake_download(video_id: str, start: float, duration: float, *, out_dir: str, proxy_url: str | None = None) -> str:
        path = Path(out_dir) / "clip.mp4"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"clip")
        return str(path)

    monkeypatch.setattr(youtube_short, "_download_clip", fake_download)

    asset = youtube_short._download_section_clip(ctx, section)

    assert asset["video_id"] == "recoveryVid"


@pytest.mark.asyncio
async def test_download_assets_backfills_candidate_urls_when_planner_skips(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    with_urls = SimpleNamespace(section=1, dialogue="A.", search_hint="a", duration_seconds=5, candidate_video_urls=["https://youtu.be/AAAAAAAAAAA"])
    without_urls = SimpleNamespace(section=2, dialogue="B.", search_hint="b", duration_seconds=5, candidate_video_urls=[])
    hunted: list[str] = []

    def fake_hunt(section: object) -> list[str]:
        hunted.append(str(getattr(section, "search_hint")))
        return ["https://www.youtube.com/watch?v=BBBBBBBBBBB"]

    seen_urls: dict[int, list[str]] = {}

    def fake_download(ctx_arg, section, proxy_url=None, search_provider="youtube_data_api"):
        seen_urls[int(section.section)] = list(getattr(section, "candidate_video_urls", []) or [])
        return {"scene_id": f"scene_{section.section}", "path": "x"}

    monkeypatch.setattr(youtube_short, "_web_search_video_urls_for_section", fake_hunt)
    monkeypatch.setattr(youtube_short, "_download_section_clip", fake_download)

    await youtube_short.download_youtube_clip_assets(ctx, [with_urls, without_urls])

    assert hunted == ["b"]
    assert seen_urls[1] == ["https://youtu.be/AAAAAAAAAAA"]
    assert seen_urls[2] == ["https://www.youtube.com/watch?v=BBBBBBBBBBB"]


def test_section_candidate_video_ids_parse_youtube_url_shapes() -> None:
    section = SimpleNamespace(
        candidate_video_urls=[
            "https://www.youtube.com/watch?v=DQacCB9tDaw",
            "https://youtu.be/c2DFg53Zhvw?t=10",
            "https://www.youtube.com/shorts/1uM8jhcqDP0",
            "https://www.youtube.com/watch?v=DQacCB9tDaw",
            "https://example.com/not-youtube",
            "not a url",
        ]
    )

    assert youtube_short._section_candidate_video_ids(section) == ["DQacCB9tDaw", "c2DFg53Zhvw", "1uM8jhcqDP0"]
    assert youtube_short._section_candidate_video_ids(SimpleNamespace()) == []


def test_planner_candidates_lead_pool_and_skip_search_when_strong(monkeypatch: pytest.MonkeyPatch) -> None:
    section = SimpleNamespace(
        section=1,
        dialogue="Introducing GPT-4o with live camera demo input.",
        search_hint="OpenAI GPT-4o live demo camera",
        duration_seconds=5,
        candidate_video_urls=["https://www.youtube.com/watch?v=DQacCB9tDaw"],
    )

    def fake_details(video_ids: list[str]) -> dict:
        assert video_ids == ["DQacCB9tDaw"]
        return {
            "items": [
                {
                    "id": "DQacCB9tDaw",
                    "snippet": {
                        "title": "Introducing GPT-4o live demo camera",
                        "channelTitle": "OpenAI",
                        "publishedAt": "2024-05-13T00:00:00Z",
                        "description": "Official GPT-4o demo with live camera input.",
                    },
                    "contentDetails": {"duration": "PT2M3S"},
                }
            ]
        }

    monkeypatch.setattr(youtube_short, "_youtube_video_details_response", fake_details)
    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("search.list should be skipped")),
    )

    ranked = youtube_short._search_section_video_candidates(section)

    assert ranked[0]["video_id"] == "DQacCB9tDaw"
    assert ranked[0]["duration_seconds"] == 123.0
    assert ranked[0]["_search_provider"] == "planner_web_search"


def test_planner_candidates_fall_back_to_search_when_invalid(monkeypatch: pytest.MonkeyPatch) -> None:
    section = SimpleNamespace(
        section=1,
        dialogue="Introducing GPT-4o with live camera demo input.",
        search_hint="OpenAI GPT-4o live demo camera",
        duration_seconds=5,
        candidate_video_urls=["https://www.youtube.com/watch?v=AAAAAAAAAAA"],
    )

    monkeypatch.setattr(youtube_short, "_youtube_video_details_response", lambda video_ids: {"items": []})
    monkeypatch.setattr(
        youtube_short,
        "_search_video_candidates",
        lambda query, limit=5: [
            {
                "video_id": "from-search",
                "title": "Introducing GPT-4o live demo camera",
                "channel_title": "OpenAI",
                "description": "Official demo.",
            }
        ],
    )

    ranked = youtube_short._search_section_video_candidates(section)

    assert ranked[0]["video_id"] == "from-search"


def test_historic_sports_queries_use_relevance_not_recent_news_filter(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, object]] = []

    def fake_search_response(query: str, limit: int, *, factual: bool, published_after: str | None) -> dict:
        calls.append({"query": query, "factual": factual, "published_after": published_after})
        return {
            "items": [
                {
                    "id": {"videoId": "saquon"},
                    "snippet": {
                        "title": "Saquon Barkley 2024 season highlights",
                        "channelTitle": "NFL",
                        "publishedAt": "2025-01-05T00:00:00Z",
                        "description": "Season highlight reel.",
                    },
                }
            ]
        }

    monkeypatch.setattr(youtube_short, "_search_response", fake_search_response)

    candidates = youtube_short._search_video_candidates("Saquon Barkley 2024 season highlights", limit=5)

    assert candidates[0]["video_id"] == "saquon"
    assert len(calls) == 1
    assert calls[0]["factual"] is False
    assert calls[0]["published_after"] is None


def test_latest_queries_use_recent_filter_without_forcing_news_category_for_product_demos(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, object] = {}

    def fake_search_response_for_key(api_key: str, query: str, limit: int, *, factual: bool, published_after: str | None) -> dict:
        seen.update(youtube_short._search_params(query, limit, factual=factual, published_after=published_after))
        return {"items": []}

    monkeypatch.setattr(youtube_short, "_ordered_youtube_api_keys", lambda: [("YOUTUBE_API_KEY_1", "key")])
    monkeypatch.setattr(youtube_short, "_search_response_for_key", fake_search_response_for_key)
    monkeypatch.setattr(youtube_short, "_WORKING_YOUTUBE_API_KEY", None, raising=False)

    youtube_short._search_response("latest OpenAI product official demo", 5, factual=True, published_after="2026-01-01T00:00:00Z")

    assert seen["order"] == "date"
    assert seen["publishedAfter"] == "2026-01-01T00:00:00Z"
    assert "videoCategoryId" not in seen


def test_latest_launch_queries_do_not_force_youtube_news_category(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, object] = {}

    def fake_search_response_for_key(api_key: str, query: str, limit: int, *, factual: bool, published_after: str | None) -> dict:
        seen.update(youtube_short._search_params(query, limit, factual=factual, published_after=published_after))
        return {"items": []}

    monkeypatch.setattr(youtube_short, "_ordered_youtube_api_keys", lambda: [("YOUTUBE_API_KEY_1", "key")])
    monkeypatch.setattr(youtube_short, "_search_response_for_key", fake_search_response_for_key)
    monkeypatch.setattr(youtube_short, "_WORKING_YOUTUBE_API_KEY", None, raising=False)

    youtube_short._search_response(
        "latest SpaceX Starship launch update",
        5,
        factual=True,
        published_after="2026-01-01T00:00:00Z",
    )

    assert seen["publishedAfter"] == "2026-01-01T00:00:00Z"
    assert "videoCategoryId" not in seen


def test_factual_youtube_prompt_normalizes_generic_search_hints(tmp_path: Path) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    main.initialize_project_state(ctx, main.CreateProjectRequest(prompt="video on latest US shooting", workflow="youtube_clips"))
    sections = [
        main.YouTubeClipSection(
            section=1,
            dialogue="Officials are still confirming details.",
            search_hint="vertical police lights street scene shorts",
            duration_seconds=5,
        )
    ]

    normalized = main.normalize_youtube_sections_for_project(ctx, sections)

    assert normalized[0].search_hint != sections[0].search_hint
    assert "latest US shooting" in normalized[0].search_hint
    assert "police lights" not in normalized[0].search_hint
    assert "shorts" not in normalized[0].search_hint
    assert "news" in normalized[0].search_hint


def test_non_factual_youtube_prompt_strips_stock_and_watermark_terms(tmp_path: Path) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    main.initialize_project_state(ctx, main.CreateProjectRequest(prompt="make a short about the Sahara", workflow="youtube_clips"))
    sections = [
        main.YouTubeClipSection(
            section=1,
            dialogue="The dunes stretch beyond the horizon.",
            search_hint="Sahara Desert aerial landscape stock footage watermark preview",
            duration_seconds=5,
        )
    ]

    normalized = main.normalize_youtube_sections_for_project(ctx, sections)

    assert normalized[0].search_hint == "Sahara Desert aerial landscape preview"
    assert "stock" not in normalized[0].search_hint.lower()
    assert "footage" not in normalized[0].search_hint.lower()
    assert "watermark" not in normalized[0].search_hint.lower()


def test_factual_youtube_prompt_strips_creation_instruction_from_search_hints(tmp_path: Path) -> None:
    prompt = (
        "Make a YouTube clips short on the latest OpenAI product news, "
        "using real clips from official OpenAI videos and OpenAI"
    )
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    main.initialize_project_state(ctx, main.CreateProjectRequest(prompt=prompt, workflow="youtube_clips"))
    sections = [
        main.YouTubeClipSection(section=1, dialogue="OpenAI shipped an update.", search_hint=prompt, duration_seconds=5),
        main.YouTubeClipSection(section=2, dialogue="The official demo shows it.", search_hint=prompt, duration_seconds=5),
        main.YouTubeClipSection(section=3, dialogue="Developers get new workflows.", search_hint=prompt, duration_seconds=5),
    ]

    normalized = main.normalize_youtube_sections_for_project(ctx, sections)

    assert normalized[0].search_hint == "the latest OpenAI product news official demo"
    assert normalized[1].search_hint == "the latest OpenAI product news official demo launch"
    assert normalized[2].search_hint == "the latest OpenAI product news official demo introducing"
    assert all("Make a YouTube clips short" not in section.search_hint for section in normalized)
    assert len({section.search_hint for section in normalized}) == 3


def test_openai_product_news_search_hints_include_product_from_dialogue(tmp_path: Path) -> None:
    prompt = (
        "Make a YouTube clips short on the latest OpenAI product news, "
        "using real clips from official OpenAI videos and reputable tech coverage"
    )
    hint = "Make a YouTube clips short on the latest OpenAI product news, using real clips from official OpenAI videos and OpenAI"
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    main.initialize_project_state(ctx, main.CreateProjectRequest(prompt=prompt, workflow="youtube_clips"))
    sections = [
        main.YouTubeClipSection(section=1, dialogue="OpenAI just launched Codex.", search_hint=hint, duration_seconds=5),
        main.YouTubeClipSection(section=2, dialogue="The official Codex demo shows the workflow.", search_hint=hint, duration_seconds=5),
    ]

    normalized = main.normalize_youtube_sections_for_project(ctx, sections)

    assert normalized[0].search_hint == "the latest OpenAI Codex product news official demo"
    assert normalized[1].search_hint == "the latest OpenAI Codex product news official demo launch"


def test_openai_model_specific_search_hints_stay_compact_and_scene_specific(tmp_path: Path) -> None:
    prompt = (
        "Make an 18-second YouTube clips short about the latest OpenAI product news "
        "from official or reputable sources. Use 4 scenes."
    )
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    main.initialize_project_state(ctx, main.CreateProjectRequest(prompt=prompt, workflow="youtube_clips"))
    sections = [
        main.YouTubeClipSection(
            section=1,
            dialogue="GPT-4o can answer spoken questions while reacting to a phone camera.",
            search_hint="OpenAI GPT-4o live demo camera",
            duration_seconds=5,
        ),
        main.YouTubeClipSection(
            section=2,
            dialogue="Codex shows a coding agent working through a task for developers.",
            search_hint="OpenAI Codex coding agent demo",
            duration_seconds=5,
        ),
        main.YouTubeClipSection(
            section=3,
            dialogue="OpenAI released o3 and o4-mini for harder reasoning tasks.",
            search_hint="OpenAI o3 o4-mini reasoning model update",
            duration_seconds=5,
        ),
    ]

    normalized = main.normalize_youtube_sections_for_project(ctx, sections)

    assert normalized[0].search_hint == "latest OpenAI GPT-4o live demo camera news"
    assert normalized[1].search_hint == "latest OpenAI Codex coding agent demo news"
    assert normalized[2].search_hint == "latest OpenAI o3 o4-mini reasoning model update news"
    assert "product news" not in normalized[0].search_hint
    assert "reputable sources" not in normalized[0].search_hint
    assert "Codex" not in normalized[0].search_hint
    assert "GPT-4o" not in normalized[1].search_hint
    assert "product news" not in normalized[2].search_hint
    assert "GPT-4o" not in normalized[2].search_hint
    assert "Codex" not in normalized[2].search_hint


def test_openai_generic_newsroom_hint_does_not_carry_source_clause(tmp_path: Path) -> None:
    prompt = (
        "Make an 18-second YouTube clips short about the latest OpenAI product news "
        "from official or reputable sources. Use 4 scenes."
    )
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    main.initialize_project_state(ctx, main.CreateProjectRequest(prompt=prompt, workflow="youtube_clips"))
    sections = [
        main.YouTubeClipSection(
            section=1,
            dialogue="OpenAI's latest product news is here, and it feels big.",
            search_hint="OpenAI newsroom homepage scroll",
            duration_seconds=4,
        ),
        main.YouTubeClipSection(
            section=2,
            dialogue="ChatGPT is rolling out Dreaming, with smarter memory for fresher replies.",
            search_hint="ChatGPT Dreaming OpenAI",
            duration_seconds=4,
        ),
        main.YouTubeClipSection(
            section=3,
            dialogue="OpenAI also introduced new GPT-Rosalind capabilities and wider Codex workflows.",
            search_hint="GPT-Rosalind Codex OpenAI",
            duration_seconds=5,
        ),
    ]

    normalized = main.normalize_youtube_sections_for_project(ctx, sections)

    assert "official or reputable sources" not in normalized[0].search_hint
    assert "newsroom" not in normalized[0].search_hint
    assert "homepage" not in normalized[0].search_hint
    assert "scroll" not in normalized[0].search_hint
    assert normalized[0].search_hint.startswith("OpenAI")
    assert normalized[0].search_hint.endswith("news")


def test_latest_openai_hints_keep_latest_without_cross_scene_product_pollution(tmp_path: Path) -> None:
    prompt = (
        "Make an 18-second YouTube clips short about the latest OpenAI product news "
        "from official or reputable sources. Use 4 scenes."
    )
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    main.initialize_project_state(ctx, main.CreateProjectRequest(prompt=prompt, workflow="youtube_clips"))
    sections = [
        main.YouTubeClipSection(
            section=1,
            dialogue="OpenAI packed early June with fresh launches across ChatGPT, Codex, and the API.",
            search_hint="OpenAI newsroom June 2026",
            duration_seconds=4,
        ),
        main.YouTubeClipSection(
            section=2,
            dialogue="The newest headline is GPT-Rosalind, built for life sciences and drug discovery.",
            search_hint="GPT-Rosalind OpenAI",
            duration_seconds=4,
        ),
        main.YouTubeClipSection(
            section=3,
            dialogue="Codex also expanded to more roles and workflows, with broader AWS access.",
            search_hint="Codex AWS OpenAI",
            duration_seconds=5,
        ),
        main.YouTubeClipSection(
            section=4,
            dialogue="Want the next drop first? Follow OpenAI's official newsroom and release notes.",
            search_hint="OpenAI release notes ChatGPT",
            duration_seconds=5,
        ),
    ]

    normalized = main.normalize_youtube_sections_for_project(ctx, sections)

    assert [section.search_hint for section in normalized] == [
        "latest OpenAI June 2026 news",
        "latest GPT-Rosalind OpenAI news",
        "latest Codex AWS OpenAI news",
        "latest OpenAI update ChatGPT news",
    ]


def test_historic_sports_prompt_does_not_enter_current_event_mode(tmp_path: Path) -> None:
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    main.initialize_project_state(ctx, main.CreateProjectRequest(prompt="saquon's 2024 season", workflow="youtube_clips"))
    sections = [
        main.YouTubeClipSection(
            section=1,
            dialogue="Saquon dominated the season.",
            search_hint="Saquon Barkley 2024 season highlights",
            duration_seconds=5,
        )
    ]

    normalized = main.normalize_youtube_sections_for_project(ctx, sections)

    assert normalized[0].search_hint == "Saquon Barkley 2024 season highlights"


def test_non_factual_prompt_carries_object_subject_into_search_hints(tmp_path: Path) -> None:
    prompt = "Make a short about how ancient coins are restored."
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    main.initialize_project_state(ctx, main.CreateProjectRequest(prompt=prompt, workflow="youtube_clips"))
    sections = [
        main.YouTubeClipSection(
            section=1,
            dialogue="Cleaning stays gentle.",
            search_hint="coin restoration cleaning soft brush close up",
            duration_seconds=5,
        ),
        main.YouTubeClipSection(
            section=2,
            dialogue="Then it is stored.",
            search_hint="coin preservation archival holder labeling",
            duration_seconds=5,
        ),
    ]

    normalized = main.normalize_youtube_sections_for_project(ctx, sections)

    assert normalized[0].search_hint == "ancient coin restoration cleaning soft brush close up"
    assert normalized[1].search_hint == "ancient coin preservation archival holder labeling"


def test_non_factual_prompt_carries_deep_sea_subject_into_search_hints(tmp_path: Path) -> None:
    prompt = "Make a short about deep sea exploration."
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    main.initialize_project_state(ctx, main.CreateProjectRequest(prompt=prompt, workflow="youtube_clips"))
    sections = [
        main.YouTubeClipSection(
            section=1,
            dialogue="Researchers review the footage.",
            search_hint="marine researchers reviewing footage on ship",
            duration_seconds=5,
        )
    ]

    normalized = main.normalize_youtube_sections_for_project(ctx, sections)

    assert normalized[0].search_hint == "deep sea marine researchers reviewing footage on ship"


def test_youtube_workflow_brief_factual_mode_requires_verified_current_terms(tmp_path: Path) -> None:
    request = main.CreateProjectRequest(prompt="video on latest US shooting", workflow="youtube_clips")
    ctx = main.context("a" * 32, request)

    brief = main.build_youtube_workflow_brief(request, ctx)

    assert "Factual/current-event YouTube mode is required." in brief
    assert "Use WebSearchTool first" in brief
    assert "Do not use generic b-roll terms" in brief
    assert "create_youtube_short_from_prompt exactly once" in brief
    assert "Do not draft title, narration, or section JSON yourself" in brief
    assert "Spoken narration budget:" in brief
    assert "Scene duration formula:" in brief


def test_youtube_script_agent_always_offers_web_search_for_planner_decision() -> None:
    request = main.CreateProjectRequest(
        prompt="Make a 20-second YouTube clips short about Steve Jobs introducing the first iPhone at the 2007 keynote.",
        workflow="youtube_clips",
    )

    agent = main.youtube_script_agent_for_request(request)
    web_tools = [tool for tool in agent.tools if isinstance(tool, main.WebSearchTool)]

    assert web_tools
    assert not [tool for tool in agent.tools if isinstance(tool, main.ToolSearchTool)]
    assert web_tools[0].filters is None
    assert web_tools[0].search_context_size == "low"
    assert "Decide whether WebSearchTool is needed" in agent.instructions
    assert "stable historical" in agent.instructions


def test_youtube_script_plan_records_web_search_decision() -> None:
    plan = main.YouTubeScriptPlan(
        title="Current Product News",
        web_search_needed=True,
        web_search_reason="The prompt asks for current product news.",
        sections=[
            main.YouTubeClipSection(
                section=1,
                dialogue="The latest product update is moving fast.",
                search_hint="latest product launch footage",
                duration_seconds=5,
            )
        ],
    )

    normalized = main.normalize_youtube_script_plan(plan)

    assert normalized.web_search_needed is True
    assert normalized.web_search_reason == "The prompt asks for current product news."


def test_youtube_script_result_used_web_search_detects_hosted_call() -> None:
    raw_item = type("RawItem", (), {"type": "web_search_call"})()
    result = type(
        "Result",
        (),
        {
            "new_items": [
                type("RunItem", (), {"type": "tool_call_item", "raw_item": raw_item})(),
            ]
        },
    )()

    assert main.youtube_script_result_used_web_search(result)


def test_planner_instructions_prioritize_fast_good_i2v_prompts() -> None:
    for phrase in {
        "draft_video_plan",
        "generate_voiceover",
        "generate_scene_images",
        "animate_scene_videos",
        "stitch_final_video",
        "inspect_render_status",
        "retry_scene",
        "record_project_decision",
        "regenerate_scene",
        "revise_narration",
        "replace_voiceover",
        "restitch_video",
        "art director",
        "Use 3-5 scenes",
        "Image prompts should be concrete",
        "Video prompts should describe camera motion",
        "prefer 4-6 second scenes",
    }:
        assert phrase in main.INSTRUCTIONS


def test_planning_instructions_treat_narration_as_spoken_story_not_visual_prompt() -> None:
    for phrase in {
        "Narration is spoken voiceover copy",
        "Do not write narration as image prompt",
        "not camera direction",
        "not a production note",
    }:
        assert phrase in main.PLANNING_INSTRUCTIONS
        assert phrase in main.build_generation_brief(main.CreateProjectRequest(prompt="make a video"), main.context("a" * 32, main.CreateProjectRequest(prompt="make a video")))


def test_magic_hour_requirement_supports_ltx_23_sdk_validator() -> None:
    requirement = Path("requirements.txt").read_text(encoding="utf-8")

    assert "magic-hour>=0.63.0" in requirement


def test_installed_magic_hour_sdk_accepts_ltx_23_model_literal() -> None:
    import inspect

    from magic_hour.resources.v1.image_to_video.client import ImageToVideoClient

    model_annotation = str(inspect.signature(ImageToVideoClient.create).parameters["model"].annotation)

    assert "ltx-2.3" in model_annotation


def test_video_poll_interval_defaults_to_lower_noise_provider_polling(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MAGIC_HOUR_POLL_INTERVAL", raising=False)

    assert media.video_poll_interval_seconds() == 2.0


def test_context_defaults_video_model_to_ltx_23_when_env_is_unset(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    monkeypatch.delitem(main.ENV, "MAGIC_HOUR_VIDEO_MODEL", raising=False)

    request = main.CreateProjectRequest(prompt="make a video")
    ctx = main.context("a" * 32, request)

    assert ctx.video_model == "ltx-2.3"


def test_context_coerces_magic_hour_default_video_model_to_ltx_23(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    monkeypatch.setitem(main.ENV, "MAGIC_HOUR_VIDEO_MODEL", "default")

    request = main.CreateProjectRequest(prompt="make a video")
    ctx = main.context("a" * 32, request)

    assert ctx.video_model == "ltx-2.3"


def test_context_defaults_image_model_to_seedream_when_env_is_unset(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    monkeypatch.delitem(main.ENV, "MAGIC_HOUR_IMAGE_MODEL", raising=False)

    request = main.CreateProjectRequest(prompt="make a video")
    ctx = main.context("a" * 32, request)

    assert ctx.image_model == "seedream-v4"


def test_context_coerces_magic_hour_default_image_model_to_seedream(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    monkeypatch.setitem(main.ENV, "MAGIC_HOUR_IMAGE_MODEL", "default")

    request = main.CreateProjectRequest(prompt="make a video")
    ctx = main.context("a" * 32, request)

    assert ctx.image_model == "seedream-v4"


def test_project_context_defaults_use_explicit_magic_hour_models(tmp_path: Path) -> None:
    ctx = main.ProjectContext(project_id="defaults", project_dir=tmp_path / "defaults", aspect_ratio="9:16", resolution="720p")

    assert ctx.image_model == "seedream-v4"
    assert ctx.video_model == "ltx-2.3"


def test_generation_brief_tells_agent_to_default_to_ltx_23_for_video(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    monkeypatch.delitem(main.ENV, "MAGIC_HOUR_VIDEO_MODEL", raising=False)
    monkeypatch.setattr(main, "probe_media_duration", lambda path: 10.0)
    request = main.CreateProjectRequest(prompt="make a video")
    ctx = main.context("b" * 32, request)

    brief = main.build_generation_brief(request, ctx)

    assert "Default image-to-video model: ltx-2.3" in brief
    assert "User-selected image-to-video model: agent chooses" not in brief


def test_generation_brief_tells_agent_to_default_to_seedream_for_images(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    monkeypatch.delitem(main.ENV, "MAGIC_HOUR_IMAGE_MODEL", raising=False)
    monkeypatch.setattr(main, "probe_media_duration", lambda path: 10.0)
    request = main.CreateProjectRequest(prompt="make a video")
    ctx = main.context("b" * 32, request)

    brief = main.build_generation_brief(request, ctx)

    assert "Default image model: seedream-v4" in brief
    assert "User-selected image model: agent chooses" not in brief


def test_project_message_brief_tells_agent_to_default_to_ltx_23_for_video(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    monkeypatch.delitem(main.ENV, "MAGIC_HOUR_VIDEO_MODEL", raising=False)
    project_id = "b" * 32
    request = main.CreateProjectRequest(prompt="make a video")
    ctx = main.context(project_id, request)
    main.initialize_project_state(ctx, request)
    main.write_json_artifact(ctx, "status", {"project_id": project_id, "status": "succeeded"})

    brief = main.build_project_message_brief(project_id, "make a new video", ctx)

    assert "Default image-to-video model: ltx-2.3" in brief
    assert "Default image model: seedream-v4" in brief


def test_scene_schema_describes_keyframe_and_i2v_prompt_contracts() -> None:
    schema = main.draft_video_plan.params_json_schema
    scene_properties = schema["$defs"]["Scene"]["properties"]
    image_description = scene_properties["image_prompt"]["description"]
    video_description = scene_properties["video_prompt"]["description"]

    assert "stable cinematic keyframe" in image_description
    assert "only what is visible" in image_description
    assert "one camera move" in video_description
    assert "only animate what already exists" in video_description
    assert "no cuts" in video_description


def test_agent_media_tools_expose_model_selection_contract() -> None:
    tool_by_name = {getattr(tool, "name", None): tool for tool in main.video_agent.tools}
    image_schema = tool_by_name["generate_scene_images"].params_json_schema["properties"]
    video_schema = tool_by_name["animate_scene_videos"].params_json_schema["properties"]
    regenerate_schema = tool_by_name["regenerate_scene"].params_json_schema["properties"]

    assert image_schema["model"]["enum"] == list(main.MAGIC_IMAGE_MODELS)
    assert image_schema["model"]["default"] == "seedream-v4"
    assert "Default to seedream-v4" in image_schema["model"]["description"]
    assert image_schema["image_resolution"]["enum"] == list(main.MAGIC_IMAGE_RESOLUTIONS)
    assert video_schema["model"]["enum"] == list(main.MAGIC_VIDEO_MODELS)
    assert video_schema["model"]["default"] == "ltx-2.3"
    assert "Default to ltx-2.3" in video_schema["model"]["description"]
    assert video_schema["resolution"]["enum"] == ["480p", "720p", "1080p"]
    assert "stable keyframe" in regenerate_schema["image_prompt"]["description"]
    assert "only animate what already exists" in regenerate_schema["video_prompt"]["description"]
    assert regenerate_schema["image_model"]["anyOf"][0]["enum"] == list(main.MAGIC_IMAGE_MODELS)
    assert regenerate_schema["video_model"]["anyOf"][0]["enum"] == list(main.MAGIC_VIDEO_MODELS)


def test_generation_brief_uses_tts_budget_and_crossfade_duration(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    project_dir = tmp_path / "old-render"
    voiceover_path = project_dir / "voiceover" / "voiceover.mp3"
    voiceover_path.parent.mkdir(parents=True)
    voiceover_path.write_bytes(b"voice")
    words = " ".join(f"word{i}" for i in range(30))
    (project_dir / "manifest.json").write_text(
        json.dumps(
            {
                "audio_model": "s2-pro",
                "voiceover": {"path": str(voiceover_path)},
                "plan": {"narration": words},
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    monkeypatch.setattr(main, "probe_media_duration", lambda path: 10.0)

    request = main.CreateProjectRequest(
        prompt="rainy alley story",
        duration_seconds=20,
        scene_count=4,
        aspect_ratio="9:16",
        resolution="720p",
    )
    ctx = main.ProjectContext(
        project_id="project",
        project_dir=tmp_path / "project",
        aspect_ratio="9:16",
        resolution="720p",
        audio_model="s2-pro",
    )

    brief = main.build_generation_brief(request, ctx)

    assert "Estimated Fish Audio pace: 3.00 words/second" in brief
    assert "Narration budget: 54-60 spoken words" in brief
    assert "Scene duration total: 21.5 seconds" in brief
    assert "Fish Audio S2 expression cues" in brief
    assert "[whispers softly]" in brief
    assert "(softly)" not in brief
    assert "Magic Hour image models" in brief
    assert "seedream-v4: detailed cinematic keyframes" in brief
    assert "Magic Hour image-to-video models" in brief
    assert "kling-3.0: cinematic multi-shot storytelling" in brief
    assert "Supported I2V durations" in brief


def test_generation_brief_lets_prompt_constraints_override_ui_defaults(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    monkeypatch.setattr(main, "probe_media_duration", lambda path: 10.0)
    ctx = main.ProjectContext(project_id="project", project_dir=tmp_path / "project", aspect_ratio="9:16", resolution="720p")

    wifi = main.CreateProjectRequest(
        prompt='Create a 15-second informational video explaining "How WiFi moves through walls." You cannot show a router or a computer. Use 3 scenes and a visual metaphor involving "water" or "light" to explain signal diffraction and absorption.',
        duration_seconds=20,
        scene_count=4,
    )
    wifi_brief = main.build_generation_brief(wifi, ctx)

    assert "Prompt duration constraint: 15 seconds" in wifi_brief
    assert "Scene count constraint: exactly 3 scenes" in wifi_brief
    assert "Requested scene count: 4" not in wifi_brief
    assert "Target final runtime: 15 seconds" in wifi_brief

    money = main.CreateProjectRequest(
        prompt='Generate a 15-second visual history of "The Evolution of Money," starting from "Bartering Cattle" and ending with "Digital Code." You must include exactly 4 scenes, and each scene must have a unique lighting style representing its era.',
    )
    money_brief = main.build_generation_brief(money, ctx)

    assert "Scene count constraint: exactly 4 scenes" in money_brief
    assert "Prompt duration constraint: 15 seconds" in money_brief


def test_generation_brief_handles_minimum_and_agent_decided_scene_counts(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    monkeypatch.setattr(main, "probe_media_duration", lambda path: 10.0)
    ctx = main.ProjectContext(project_id="project", project_dir=tmp_path / "project", aspect_ratio="9:16", resolution="720p")

    solar = main.CreateProjectRequest(
        prompt="Create a 15-second informational video explaining how a solar panel turns sunlight into electricity. The video must show at least three distinct stages of the process to be educational.",
        duration_seconds=20,
        scene_count=4,
    )
    solar_brief = main.build_generation_brief(solar, ctx)

    assert "Scene count constraint: at least 3 scenes or stages" in solar_brief
    assert "Prompt duration constraint: 15 seconds" in solar_brief

    purchasing_power = main.CreateProjectRequest(
        prompt="Explain why $100 bought a grocery cart full of food in 1970 but only a few items today. You decide the number of scenes and the visual style. The goal is to make the viewer feel the loss of purchasing power in 15 seconds.",
        duration_seconds=20,
        scene_count=4,
    )
    purchasing_brief = main.build_generation_brief(purchasing_power, ctx)

    assert "Scene count constraint: agent decides" in purchasing_brief
    assert "Requested scene count: 4" not in purchasing_brief
    assert "Prompt duration constraint: 15 seconds" in purchasing_brief


def test_generation_brief_handles_under_duration_and_director_scene_phrases(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    monkeypatch.setattr(main, "probe_media_duration", lambda path: 10.0)
    ctx = main.ProjectContext(project_id="project", project_dir=tmp_path / "project", aspect_ratio="9:16", resolution="720p")

    quantum = main.CreateProjectRequest(
        prompt="Explain 'Quantum Entanglement' using a visual metaphor. You are the director: decide the number of scenes and the sequence of events to show that when one particle spins, the other reacts instantly, no matter the distance. Keep it under 15 seconds.",
        duration_seconds=20,
        scene_count=4,
    )
    quantum_brief = main.build_generation_brief(quantum, ctx)

    assert "Prompt duration constraint: under 15 seconds" in quantum_brief
    assert "Scene count constraint: agent decides" in quantum_brief
    assert "Requested scene count: 4" not in quantum_brief

    mitosis = main.CreateProjectRequest(
        prompt="Create an informational short on 'How a Cell Divides.' You must decide how many scenes are needed to show the most critical steps of mitosis. Ensure the transition between scenes feels like one continuous biological event.",
        duration_seconds=20,
        scene_count=4,
    )
    mitosis_brief = main.build_generation_brief(mitosis, ctx)

    assert "Scene count constraint: agent decides" in mitosis_brief
    assert "Requested scene count: 4" not in mitosis_brief


@pytest.mark.asyncio
async def test_image_generation_tool_uses_agent_selected_model_settings(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    ctx = main.ProjectContext(project_id="models", project_dir=tmp_path / "models", aspect_ratio="9:16", resolution="720p")
    await main.draft_video_plan_impl(
        ctx,
        "Model Choice",
        "Narration.",
        [main.Scene(id="scene_1", narration="one", image_prompt="image", video_prompt="motion", duration_seconds=5)],
    )
    seen: dict[str, str] = {}

    async def fake_image(ctx_arg: main.ProjectContext, scene: main.Scene) -> dict:
        seen["image_model"] = ctx_arg.image_model
        seen["image_resolution"] = ctx_arg.image_resolution
        seen["image_style_tool"] = ctx_arg.image_style_tool
        path = ctx_arg.project_dir / "image.jpg"
        path.write_bytes(b"image")
        return {"scene_id": scene.id, "path": str(path), "prompt": scene.image_prompt, "model": ctx_arg.image_model}

    monkeypatch.setattr(main, "generate_image_asset", fake_image)

    payload = await main.generate_scene_images_impl(
        ctx,
        model="z-image-turbo",
        image_resolution="640px",
        image_style_tool="ai-photo-generator",
    )
    state = main.read_project_state(ctx)

    assert seen == {
        "image_model": "z-image-turbo",
        "image_resolution": "640px",
        "image_style_tool": "ai-photo-generator",
    }
    assert payload["images"][0]["model"] == "z-image-turbo"
    assert state["provider_settings"]["image_model"] == "z-image-turbo"
    assert state["provider_settings"]["image_resolution"] == "640px"
    assert state["provider_settings"]["image_style_tool"] == "ai-photo-generator"


@pytest.mark.asyncio
async def test_image_generation_tool_sends_visual_bible_with_each_scene_prompt(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    ctx = main.ProjectContext(project_id="continuity", project_dir=tmp_path / "continuity", aspect_ratio="9:16", resolution="720p")
    await main.draft_video_plan_impl(
        ctx,
        "Continuity",
        "Narration.",
        [
            main.Scene(
                id="scene_1",
                narration="one",
                image_prompt="Same woman tightens a motorcycle bolt at sunset.",
                video_prompt="motion",
                duration_seconds=5,
            )
        ],
        visual_bible="Same late-40s woman mechanic: tan skin, silver-streaked tied-back curls, rectangular glasses, green work shirt, red bandana.",
    )
    seen: dict[str, str] = {}

    async def fake_image(ctx_arg: main.ProjectContext, scene: main.Scene) -> dict:
        seen["prompt"] = scene.image_prompt
        path = ctx_arg.project_dir / "image.jpg"
        path.write_bytes(b"image")
        return {"scene_id": scene.id, "path": str(path), "prompt": scene.image_prompt, "model": ctx_arg.image_model}

    monkeypatch.setattr(main, "generate_image_asset", fake_image)

    payload = await main.generate_scene_images_impl(ctx)

    assert "Continuity bible for every scene:" in seen["prompt"]
    assert "silver-streaked tied-back curls" in seen["prompt"]
    assert "Same woman tightens a motorcycle bolt" in seen["prompt"]
    assert payload["images"][0]["prompt"] == seen["prompt"]


@pytest.mark.asyncio
async def test_video_generation_tool_uses_agent_selected_model_settings(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    ctx = main.ProjectContext(project_id="video-models", project_dir=tmp_path / "video-models", aspect_ratio="9:16", resolution="720p")
    await main.draft_video_plan_impl(
        ctx,
        "Video Model Choice",
        "Narration.",
        [main.Scene(id="scene_1", narration="one", image_prompt="image", video_prompt="motion", duration_seconds=5)],
    )
    main.write_json_artifact(ctx, "images", [{"scene_id": "scene_1", "path": str(ctx.project_dir / "image.jpg")}])
    seen: dict[str, object] = {}

    async def fake_video_batch(ctx_arg: main.ProjectContext, pairs: list[tuple[main.Scene, dict]]) -> list[dict]:
        seen["video_model"] = ctx_arg.video_model
        seen["resolution"] = ctx_arg.resolution
        seen["video_audio"] = ctx_arg.video_audio
        scene = pairs[0][0]
        path = ctx_arg.project_dir / "video.mp4"
        path.write_bytes(b"video")
        return [{"scene_id": scene.id, "path": str(path), "prompt": scene.video_prompt, "model": ctx_arg.video_model, "duration_seconds": scene.duration_seconds}]

    async def fake_stitch(ctx_arg: main.ProjectContext, videos: list[dict], voiceover: dict) -> str:
        path = ctx_arg.project_dir / "final.mp4"
        path.write_bytes(b"final")
        return str(path)

    monkeypatch.setattr(main, "generate_video_assets_batch", fake_video_batch)
    monkeypatch.setattr(main, "stitch_assets", fake_stitch)

    payload = await main.animate_scene_videos_impl(
        ctx,
        model="kling-3.0",
        resolution="1080p",
        audio=True,
    )
    main.write_json_artifact(ctx, "voiceover", {"path": str(ctx.project_dir / "voice.mp3"), "model": "voice-model", "duration_seconds": 5})
    manifest = await main.stitch_final_video_impl(ctx, main.pending_token_output(ctx, "gpt-5.5"))
    state = main.read_project_state(ctx)

    assert seen == {"video_model": "kling-3.0", "resolution": "1080p", "video_audio": True}
    assert payload["videos"][0]["model"] == "kling-3.0"
    assert state["provider_settings"]["video_model"] == "kling-3.0"
    assert state["provider_settings"]["video_resolution"] == "1080p"
    assert state["provider_settings"]["video_audio"] is True
    assert manifest["video_model"] == "kling-3.0"
    assert manifest["video_resolution"] == "1080p"
    assert manifest["video_audio"] is True


@pytest.mark.asyncio
async def test_draft_video_plan_clears_stale_render_outputs(tmp_path: Path) -> None:
    ctx = main.ProjectContext(project_id="stale", project_dir=tmp_path / "stale", aspect_ratio="9:16", resolution="720p")
    main.initialize_project_state(ctx, main.CreateProjectRequest(prompt="old prompt"))
    for artifact in ("voiceover", "images", "videos", "manifest"):
        main.write_json_artifact(ctx, artifact, {"old": True})
    stale_files = [
        ctx.project_dir / "voiceover" / "old.mp3",
        ctx.project_dir / "images" / "scene_1" / "old.png",
        ctx.project_dir / "videos" / "scene_1" / "old.mp4",
        ctx.project_dir / "final.mp4",
        ctx.project_dir / "merged.mp4",
    ]
    for path in stale_files:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"old")

    await main.draft_video_plan_impl(
        ctx,
        "WiFi",
        "Signals bend and fade.",
        [main.Scene(id="scene_1", narration="one", image_prompt="new image", video_prompt="new video", duration_seconds=5)],
    )

    assert not (ctx.project_dir / "voiceover").exists()
    assert not (ctx.project_dir / "images").exists()
    assert not (ctx.project_dir / "videos").exists()
    assert not (ctx.project_dir / "final.mp4").exists()
    assert not (ctx.project_dir / "merged.mp4").exists()
    assert not (ctx.project_dir / "manifest.json").exists()
    assert main.read_json_artifact(ctx, "images") is None
    assert main.read_project_state(ctx)["scene_assets"]["images"] == []


@pytest.mark.asyncio
async def test_image_generation_ignores_stale_files_in_scene_output_dir(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    class FakeImageGenerator:
        def generate(self, **kwargs):
            return type(
                "Result",
                (),
                {
                    "id": "new-image-job",
                    "downloaded_paths": [],
                    "downloads": [type("Download", (), {"url": "https://example.test/new-image.png"})()],
                },
            )()

    class FakeMagicHourClient:
        def __init__(self, token: str):
            self.v1 = type("V1", (), {"ai_image_generator": FakeImageGenerator()})()

    class FakeResponse:
        content = b"new image"

        def raise_for_status(self) -> None:
            return None

    class FakeHttpClient:
        def __init__(self, timeout: int):
            self.timeout = timeout

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def get(self, url: str):
            assert url == "https://example.test/new-image.png"
            return FakeResponse()

    monkeypatch.setattr(media, "MagicHourClient", FakeMagicHourClient)
    monkeypatch.setattr(media.httpx, "Client", FakeHttpClient)
    ctx = main.ProjectContext(project_id="provider", project_dir=tmp_path, aspect_ratio="9:16", resolution="720p")
    scene = main.Scene(id="scene_1", narration="one", image_prompt="new image", video_prompt="new motion", duration_seconds=5)
    stale = tmp_path / "images" / "scene_1" / "old-dragon.png"
    stale.parent.mkdir(parents=True, exist_ok=True)
    stale.write_bytes(b"old dragon")

    result = await main.generate_image_asset(ctx, scene)

    assert Path(result["path"]) == tmp_path / "images" / "scene_1" / "new-image.png"
    assert Path(result["path"]).read_bytes() == b"new image"
    assert not stale.exists()


def test_count_spoken_words_ignores_fish_audio_bracket_expression_cues() -> None:
    text = "[speaks softly] Rain taps the glass. [whispers] Listen closely. [pause]"

    assert main.count_spoken_words(text) == 6
    assert main.fish_audio_expression_cues(text) == ["speaks softly", "whispers", "pause"]


def test_normalize_plan_preserves_original_image_and_video_prompts() -> None:
    plan = main.VideoPlan(
        title="Continuity",
        narration="One. Two.",
        visual_bible="Same rainy alley, mustard raincoat, black cat, teal and amber palette, 35mm lens.",
        scenes=[
            main.Scene(
                id="a",
                narration="[speaks softly] The woman leaves the bakery.",
                image_prompt="Bakery doorway.",
                video_prompt="Slow push in.",
                duration_seconds=5,
            ),
            main.Scene(
                id="b",
                narration="The cat steps from the awning.",
                image_prompt="Cat near awning.",
                video_prompt="Tilt down.",
                duration_seconds=5,
            ),
        ],
    )

    normalized = main.normalize_plan(plan)

    assert normalized.scenes[0].id == "scene_1"
    assert normalized.scenes[0].image_prompt == "Bakery doorway."
    assert normalized.scenes[0].video_prompt == "Slow push in."
    assert normalized.scenes[1].image_prompt == "Cat near awning."
    assert normalized.scenes[1].video_prompt == "Tilt down."


def test_provider_image_prompt_prepends_visual_bible_for_independent_stills() -> None:
    plan = main.VideoPlan(
        title="Mechanic",
        narration="One.",
        visual_bible="Same late-40s woman mechanic: tan skin, silver-streaked tied-back curls, rectangular glasses, oil-stained green shirt, faded jeans, brown tool belt, red bandana.",
        scenes=[
            main.Scene(
                id="scene_1",
                narration="one",
                image_prompt="Same woman tightens a bolt beside the motorcycle at sunset.",
                video_prompt="Slow push in.",
                duration_seconds=5,
            )
        ],
    )

    prompt = main.provider_image_prompt(plan, plan.scenes[0])

    assert prompt.startswith("Continuity bible for every scene:")
    assert "late-40s woman mechanic" in prompt
    assert "red bandana" in prompt
    assert "Same woman tightens a bolt" in prompt


def test_provider_image_prompt_does_not_duplicate_existing_visual_bible() -> None:
    scene_prompt = "Same late-40s woman mechanic: tan skin, silver-streaked tied-back curls. She tightens a bolt."
    plan = main.VideoPlan(
        title="Mechanic",
        narration="One.",
        visual_bible="Same late-40s woman mechanic: tan skin, silver-streaked tied-back curls.",
        scenes=[main.Scene(id="scene_1", narration="one", image_prompt=scene_prompt, video_prompt="Slow push in.", duration_seconds=5)],
    )

    assert main.provider_image_prompt(plan, plan.scenes[0]) == scene_prompt


def test_normalize_plan_replaces_unsafe_scene_ids() -> None:
    plan = main.VideoPlan(
        title="Unsafe",
        narration="Narration.",
        scenes=[
            main.Scene(id="../one", narration="one", image_prompt="image", video_prompt="motion", duration_seconds=2),
            main.Scene(id="two/three", narration="two", image_prompt="image", video_prompt="motion", duration_seconds=2),
        ],
    )

    normalized = main.normalize_plan(plan)

    assert [scene.id for scene in normalized.scenes] == ["scene_1", "scene_2"]


def test_download_picker_uses_existing_file_over_stale_result_path(tmp_path: Path) -> None:
    real_file = tmp_path / "output-0.jpg"
    real_file.write_bytes(b"image")
    stale_file = tmp_path / "output-1.jpg"
    result = type("Result", (), {"downloaded_paths": [str(stale_file)]})()

    assert main.pick_download(result, tmp_path) == real_file


def test_token_output_payload_includes_gpt_usage_and_cost() -> None:
    payload = main.token_output_payload(
        "project",
        "gpt-5.4",
        Usage(
            requests=1,
            input_tokens=1000,
            input_tokens_details=InputTokensDetails(cached_tokens=200),
            output_tokens=500,
            output_tokens_details=OutputTokensDetails(reasoning_tokens=50),
            total_tokens=1500,
        ),
    )

    assert payload["usage"]["input_tokens"] == 1000
    assert payload["usage"]["cached_input_tokens"] == 200
    assert payload["usage"]["uncached_input_tokens"] == 800
    assert payload["usage"]["output_tokens"] == 500
    assert payload["usage"]["reasoning_tokens"] == 50
    assert payload["cost"]["total_usd"] == 0.00955


@pytest.mark.asyncio
async def test_plan_video_writes_token_output_json(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    async def fake_run(*args, **kwargs):
        assert "Narration budget" in kwargs["input"]
        assert "Fish Audio S2 expression cues" in kwargs["input"]
        usage = Usage(requests=1, input_tokens=1000, output_tokens=500, total_tokens=1500)
        plan = main.VideoPlan(
            title="Token Test",
            narration="Narration.",
            visual_bible="same subject",
            scenes=[
                main.Scene(
                    id="scene_1",
                    narration="one",
                    image_prompt="image",
                    video_prompt="slow push-in",
                    duration_seconds=1,
                )
            ],
        )
        return type("Result", (), {"final_output": plan, "context_wrapper": type("Wrapper", (), {"usage": usage})()})()

    monkeypatch.setattr(main.Runner, "run", fake_run)
    ctx = main.ProjectContext(project_id="project", project_dir=tmp_path, aspect_ratio="9:16", resolution="720p")

    plan, token_output = await main.plan_video(main.CreateProjectRequest(prompt="make a video"), ctx)

    data = json.loads((tmp_path / "token_output.json").read_text(encoding="utf-8"))
    assert plan.title == "Token Test"
    assert data["token_output_path"] == str(tmp_path / "token_output.json")
    assert token_output["cost"]["total_usd"] == data["cost"]["total_usd"]


@pytest.mark.asyncio
async def test_run_project_uses_video_agent_as_orchestrator(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    runner_calls = []

    async def fake_run(agent, input, *, context, **kwargs):
        runner_calls.append(agent)
        assert agent is main.video_agent
        assert "Narration budget" in input
        assert "Fish Audio S2 expression cues" in input
        pending_token_output = main.pending_token_output(context, main.video_agent.model)
        manifest = {
            "project_id": context.project_id,
            "title": "Agent Render",
            "final_video_path": str(context.project_dir / "final.mp4"),
            "manifest_path": str(context.project_dir / "manifest.json"),
            "failed_scene_count": 0,
            "token_output": pending_token_output,
            "token_output_path": pending_token_output["token_output_path"],
            "gpt_cost_usd": 0,
        }
        context.project_dir.mkdir(parents=True, exist_ok=True)
        (context.project_dir / "final.mp4").write_bytes(b"final")
        (context.project_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        usage = Usage(requests=1, input_tokens=1000, output_tokens=500, total_tokens=1500)
        return type("Result", (), {"final_output": "rendered", "context_wrapper": type("Wrapper", (), {"usage": usage})()})()

    async def direct_render_call(*args, **kwargs):
        raise AssertionError("run_project should let video_agent call render tools")

    monkeypatch.setattr(main, "render_plan", direct_render_call)
    monkeypatch.setattr(main.Runner, "run", fake_run)

    await main.run_project("a" * 32, main.CreateProjectRequest(prompt="make a video"))

    status = json.loads((tmp_path / ("a" * 32) / "status.json").read_text(encoding="utf-8"))
    manifest = status["manifest"]
    token_output = json.loads((tmp_path / ("a" * 32) / "token_output.json").read_text(encoding="utf-8"))
    assert runner_calls == [main.video_agent]
    assert status["status"] == "succeeded"
    assert manifest["title"] == "Agent Render"
    assert manifest["token_output"]["usage"]["input_tokens"] == 1000
    assert token_output["usage"]["input_tokens"] == 1000


@pytest.mark.asyncio
async def test_run_project_forces_youtube_workflow_through_main_orchestrator(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    monkeypatch.setattr(main, "MH_AGENT_YT_CLIPS_DIR", tmp_path / "yt-clips")
    runner_calls = []

    async def fake_run(agent, input, *, context, **kwargs):
        runner_calls.append(agent)
        assert agent is main.video_agent
        assert "Workflow: youtube_clips." in input
        assert "create_youtube_short_from_prompt exactly once" in input
        assert "Do not draft title, narration, or section JSON yourself" in input
        assert "generate_scene_images, animate_scene_videos, or stitch_final_video" in input
        pending_token_output = main.pending_token_output(context, main.video_agent.model)
        manifest = {
            "project_id": context.project_id,
            "title": "YouTube Agent Render",
            "workflow": "youtube_clips",
            "final_video_path": str(context.project_dir / "final.mp4"),
            "manifest_path": str(context.project_dir / "manifest.json"),
            "failed_scene_count": 0,
            "videos": [{"scene_id": "scene_1"}],
            "token_output": pending_token_output,
            "token_output_path": pending_token_output["token_output_path"],
            "gpt_cost_usd": 0,
        }
        context.project_dir.mkdir(parents=True, exist_ok=True)
        (context.project_dir / "final.mp4").write_bytes(b"final")
        (context.project_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        usage = Usage(requests=1, input_tokens=900, output_tokens=300, total_tokens=1200)
        return type("Result", (), {"final_output": "rendered", "context_wrapper": type("Wrapper", (), {"usage": usage})()})()

    monkeypatch.setattr(main.Runner, "run", fake_run)

    await main.run_project(
        "b" * 32,
        main.CreateProjectRequest(prompt="make a YouTube clips video", workflow="youtube_clips", youtube_search_provider="yt_dlp"),
    )

    status = json.loads((tmp_path / ("b" * 32) / "status.json").read_text(encoding="utf-8"))
    assert runner_calls == [main.video_agent]
    assert status["status"] == "succeeded"
    assert status["manifest"]["workflow"] == "youtube_clips"


@pytest.mark.asyncio
async def test_create_youtube_short_from_prompt_impl_uses_notebook_style_planner_then_existing_assembler(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    request = main.CreateProjectRequest(
        prompt="Make an 18-second YouTube clips short about deep sea exploration.",
        workflow="youtube_clips",
        duration_seconds=18,
        scene_count=4,
        youtube_search_provider="yt_dlp",
        youtube_allow_provider_fallback=False,
    )
    ctx = main.context("c" * 32, request)
    main.initialize_project_state(ctx, request)
    seen: dict[str, object] = {}

    async def fake_draft(ctx_arg: main.ProjectContext, request_arg: main.CreateProjectRequest) -> main.YouTubeScriptPlan:
        seen["draft_project_id"] = ctx_arg.project_id
        seen["draft_prompt"] = request_arg.prompt
        seen["draft_duration"] = request_arg.duration_seconds
        seen["draft_scene_count"] = request_arg.scene_count
        return main.YouTubeScriptPlan(
            title="Deep Sea Short",
            sections=[
                main.YouTubeClipSection(
                    section=1,
                    dialogue="A submersible drops past the last sunlight.",
                    search_hint="deep sea submersible descent footage",
                    duration_seconds=6,
                ),
                main.YouTubeClipSection(
                    section=2,
                    dialogue="Researchers review the strange footage on deck.",
                    search_hint="deep sea researchers reviewing footage",
                    duration_seconds=6,
                ),
            ],
        )

    async def fake_create(
        ctx_arg: main.ProjectContext,
        title: str,
        narration: str,
        sections: list[main.YouTubeClipSection],
        *,
        token_output: dict | None = None,
        proxy_url: str | None = None,
    ) -> dict:
        seen["create_project_id"] = ctx_arg.project_id
        seen["title"] = title
        seen["narration"] = narration
        seen["sections"] = [section.model_dump(mode="json") for section in sections]
        seen["token_model"] = (token_output or {}).get("model")
        seen["proxy_url"] = proxy_url
        return {"workflow": "youtube_clips", "title": title, "videos": []}

    monkeypatch.setattr(main, "draft_youtube_script_impl", fake_draft)
    monkeypatch.setattr(main, "create_youtube_short_impl", fake_create)

    manifest = await main.create_youtube_short_from_prompt_impl(ctx, proxy_url="http://proxy.local")

    assert manifest["title"] == "Deep Sea Short"
    assert seen == {
        "draft_project_id": "c" * 32,
        "draft_prompt": request.prompt,
        "draft_duration": 18,
        "draft_scene_count": 4,
        "create_project_id": "c" * 32,
        "title": "Deep Sea Short",
        "narration": "A submersible drops past the last sunlight. Researchers review the strange footage on deck.",
        "sections": [
            {
                "section": 1,
                "dialogue": "A submersible drops past the last sunlight.",
                "search_hint": "deep sea submersible descent footage",
                "duration_seconds": 6,
                "search_order": None,
                "published_after": None,
                "published_before": None,
                "video_duration": None,
                "video_category": None,
                "require_captions": False,
                "channel_hint": None,
                "candidate_video_urls": [],
            },
            {
                "section": 2,
                "dialogue": "Researchers review the strange footage on deck.",
                "search_hint": "deep sea researchers reviewing footage",
                "duration_seconds": 6,
                "search_order": None,
                "published_after": None,
                "published_before": None,
                "video_duration": None,
                "video_category": None,
                "require_captions": False,
                "channel_hint": None,
                "candidate_video_urls": [],
            },
        ],
        "token_model": main.youtube_script_agent.model,
        "proxy_url": "http://proxy.local",
    }


@pytest.mark.asyncio
async def test_create_youtube_short_impl_reuses_project_state_voiceover_and_stitching(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    main.initialize_project_state(
        ctx,
        main.CreateProjectRequest(
            prompt="make a 5 second city short",
            workflow="youtube_clips",
            youtube_search_provider="yt_dlp",
            youtube_allow_provider_fallback=False,
        ),
    )
    sections = [
        main.YouTubeClipSection(section=1, dialogue="The first beat lands fast.", search_hint="city breaking news stock", duration_seconds=2),
        main.YouTubeClipSection(section=2, dialogue="Then the context becomes clear.", search_hint="reporter newsroom stock", duration_seconds=3),
    ]
    seen: dict[str, object] = {}

    async def fake_download(
        ctx_arg: main.ProjectContext,
        sections_arg: list[main.YouTubeClipSection],
        proxy_url: str | None = None,
        search_provider: str | None = None,
    ) -> list[dict]:
        seen["download_project_dir"] = ctx_arg.project_dir
        seen["download_sections"] = [section.search_hint for section in sections_arg]
        seen["proxy_url"] = proxy_url
        seen["search_provider"] = search_provider
        assets = []
        for index, section in enumerate(sections_arg, 1):
            path = ctx_arg.project_dir / "youtube_clips" / f"clip_{index}.mp4"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"clip")
            assets.append(
                {
                    "scene_id": f"scene_{index}",
                    "path": str(path),
                    "prompt": section.search_hint,
                    "model": "youtube-clips",
                    "duration_seconds": section.duration_seconds,
                    "source": "youtube",
                    "video_id": f"video-{index}",
                }
            )
        return assets

    async def fake_section_vo(
        ctx_arg: main.ProjectContext,
        sections_arg: list[main.YouTubeClipSection],
    ) -> list[dict]:
        seen["vo_sections"] = [section.dialogue for section in sections_arg]
        results = []
        for section in sections_arg:
            path = ctx_arg.project_dir / "voiceover" / "sections" / f"section_{section.section}.mp3"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"voice")
            results.append(
                {
                    "section": section.section,
                    "scene_id": f"scene_{section.section}",
                    "path": str(path),
                    "duration_seconds": float(section.duration_seconds),
                }
            )
        return results

    async def fake_combine(ctx_arg: main.ProjectContext, section_voiceovers: list[dict]) -> dict:
        seen["combined_scene_ids"] = [item["scene_id"] for item in section_voiceovers]
        path = ctx_arg.project_dir / "voiceover" / "voiceover.mp3"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"voice")
        return {
            "path": str(path),
            "model": "s2-pro",
            "duration_seconds": sum(item["duration_seconds"] for item in section_voiceovers),
            "sections": section_voiceovers,
        }

    async def fake_stitch(ctx_arg: main.ProjectContext, scenes: list[dict]) -> str:
        seen["stitched_scene_count"] = len(scenes)
        seen["stitched_audio_paths"] = [scene["audio_path"] for scene in scenes]
        path = ctx_arg.project_dir / "final.mp4"
        path.write_bytes(b"final")
        return str(path)

    monkeypatch.setattr(main, "download_youtube_clip_assets", fake_download)
    monkeypatch.setattr(main, "generate_section_voiceovers", fake_section_vo)
    monkeypatch.setattr(main, "combine_section_voiceovers", fake_combine)
    monkeypatch.setattr(main, "stitch_assets_per_section", fake_stitch)

    manifest = await main.create_youtube_short_impl(
        ctx,
        title="News Short",
        narration="The first beat lands fast. Then the context becomes clear.",
        sections=sections,
        token_output=main.pending_token_output(ctx, "gpt-5.5"),
        proxy_url="http://proxy.local",
    )
    state = main.read_project_state(ctx)
    plan = main.read_json_artifact(ctx, "plan")

    assert manifest["workflow"] == "youtube_clips"
    assert manifest["youtube_search_provider"] == "yt_dlp"
    assert manifest["youtube_allow_provider_fallback"] is False
    assert manifest["video_model"] == "youtube-clips"
    assert manifest["image_model"] == "none"
    assert manifest["images"] == []
    assert manifest["videos"][0]["source"] == "youtube"
    assert manifest["videos"][1]["video_id"] == "video-2"
    assert state["provider_settings"]["workflow"] == "youtube_clips"
    assert state["provider_settings"]["youtube_search_provider"] == "yt_dlp"
    assert state["provider_settings"]["youtube_allow_provider_fallback"] is False
    assert state["scene_assets"]["final_video_path"] == manifest["final_video_path"]
    assert plan["scenes"][0]["image_prompt"] == "city breaking news"
    assert seen == {
        "download_project_dir": ctx.project_dir,
        "download_sections": ["city breaking news", "reporter newsroom"],
        "proxy_url": "http://proxy.local",
        "search_provider": "yt_dlp",
        "vo_sections": ["The first beat lands fast.", "Then the context becomes clear."],
        "combined_scene_ids": ["scene_1", "scene_2"],
        "stitched_scene_count": 2,
        "stitched_audio_paths": [
            str(ctx.project_dir / "voiceover" / "sections" / "section_1.mp3"),
            str(ctx.project_dir / "voiceover" / "sections" / "section_2.mp3"),
        ],
    }


@pytest.mark.asyncio
async def test_create_youtube_short_impl_uses_downloaded_clip_aspect_for_stitch(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    main.initialize_project_state(ctx, main.CreateProjectRequest(prompt="make a news short", workflow="youtube_clips"))
    sections = [
        main.YouTubeClipSection(section=1, dialogue="One update lands.", search_hint="tech keynote footage", duration_seconds=2),
        main.YouTubeClipSection(section=2, dialogue="The crowd reacts.", search_hint="audience reaction footage", duration_seconds=2),
    ]
    seen: dict[str, object] = {}

    async def fake_download(
        ctx_arg: main.ProjectContext,
        sections_arg: list[main.YouTubeClipSection],
        proxy_url: str | None = None,
        search_provider: str | None = None,
        allow_provider_fallback: bool = True,
    ) -> list[dict]:
        assets = []
        for index, section in enumerate(sections_arg, 1):
            path = ctx_arg.project_dir / "youtube_clips" / f"clip_{index}.mp4"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"clip")
            assets.append(
                {
                    "scene_id": f"scene_{index}",
                    "path": str(path),
                    "prompt": section.search_hint,
                    "model": "youtube-clips",
                    "duration_seconds": section.duration_seconds,
                    "source": "youtube",
                    "video_id": f"video-{index}",
                    "source_width": 1920,
                    "source_height": 1080,
                }
            )
        return assets

    async def fake_section_vo(
        ctx_arg: main.ProjectContext,
        sections_arg: list[main.YouTubeClipSection],
    ) -> list[dict]:
        results = []
        for section in sections_arg:
            path = ctx_arg.project_dir / "voiceover" / "sections" / f"section_{section.section}.mp3"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"voice")
            results.append(
                {
                    "section": section.section,
                    "scene_id": f"scene_{section.section}",
                    "path": str(path),
                    "duration_seconds": float(section.duration_seconds),
                }
            )
        return results

    async def fake_combine(ctx_arg: main.ProjectContext, section_voiceovers: list[dict]) -> dict:
        path = ctx_arg.project_dir / "voiceover" / "voiceover.mp3"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"voice")
        return {
            "path": str(path),
            "model": "s2-pro",
            "duration_seconds": sum(item["duration_seconds"] for item in section_voiceovers),
            "sections": section_voiceovers,
        }

    async def fake_stitch(ctx_arg: main.ProjectContext, scenes: list[dict]) -> str:
        seen["stitch_aspect_ratio"] = ctx_arg.aspect_ratio
        path = ctx_arg.project_dir / "final.mp4"
        path.write_bytes(b"final")
        return str(path)

    monkeypatch.setattr(main, "download_youtube_clip_assets", fake_download)
    monkeypatch.setattr(main, "generate_section_voiceovers", fake_section_vo)
    monkeypatch.setattr(main, "combine_section_voiceovers", fake_combine)
    monkeypatch.setattr(main, "stitch_assets_per_section", fake_stitch)

    manifest = await main.create_youtube_short_impl(
        ctx,
        title="News Short",
        narration="One update lands. The crowd reacts.",
        sections=sections,
        token_output=main.pending_token_output(ctx, "gpt-5.5"),
    )
    state = main.read_project_state(ctx)

    assert seen["stitch_aspect_ratio"] == "16:9"
    assert manifest["aspect_ratio"] == "16:9"
    assert manifest["plan"]["aspect_ratio"] == "16:9"
    assert state["provider_settings"]["aspect_ratio"] == "16:9"


@pytest.mark.asyncio
async def test_create_youtube_short_impl_reuses_existing_manifest_without_redownload(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    main.initialize_project_state(ctx, main.CreateProjectRequest(prompt="make a news short", workflow="youtube_clips"))
    final_path = ctx.project_dir / "final.mp4"
    final_path.parent.mkdir(parents=True, exist_ok=True)
    final_path.write_bytes(b"final")
    existing = {
        "project_id": ctx.project_id,
        "workflow": "youtube_clips",
        "title": "Existing",
        "videos": [{"scene_id": "scene_1", "path": str(ctx.project_dir / "youtube_clips" / "scene_1" / "clip.mp4")}],
        "final_video_path": str(final_path),
        "manifest_path": str(ctx.project_dir / "manifest.json"),
    }
    main.write_json_artifact(ctx, "manifest", existing)

    async def should_not_run(*args, **kwargs):
        raise AssertionError("duplicate YouTube short calls must not regenerate assets")

    monkeypatch.setattr(main, "draft_video_plan_impl", should_not_run)
    monkeypatch.setattr(main, "generate_section_voiceovers", should_not_run)
    monkeypatch.setattr(main, "combine_section_voiceovers", should_not_run)
    monkeypatch.setattr(main, "download_youtube_clip_assets", should_not_run)
    monkeypatch.setattr(main, "stitch_assets_per_section", should_not_run)

    manifest = await main.create_youtube_short_impl(
        ctx,
        title="Replacement",
        narration="Different narration.",
        sections=[
            main.YouTubeClipSection(section=1, dialogue="Different.", search_hint="different search", duration_seconds=5),
        ],
    )
    state = main.read_project_state(ctx)

    assert manifest == existing
    assert state["decisions"][-1]["decision"] == "Reused existing YouTube short manifest; skipped duplicate generation and downloads."


@pytest.mark.asyncio
async def test_create_youtube_short_impl_records_stitch_failure(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    ctx = main.ProjectContext(project_id="youtube", project_dir=tmp_path / "youtube", aspect_ratio="9:16", resolution="720p")
    main.initialize_project_state(ctx, main.CreateProjectRequest(prompt="make a news short", workflow="youtube_clips"))
    sections = [main.YouTubeClipSection(section=1, dialogue="A verified update.", search_hint="verified news update", duration_seconds=5)]

    async def fake_download(
        ctx_arg: main.ProjectContext,
        sections_arg: list[main.YouTubeClipSection],
        proxy_url: str | None = None,
        search_provider: str | None = None,
        allow_provider_fallback: bool = True,
    ) -> list[dict]:
        path = ctx_arg.project_dir / "youtube_clips" / "scene_1" / "clip.mp4"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"clip")
        return [{"scene_id": "scene_1", "path": str(path), "prompt": "verified news update", "model": "youtube-clips", "duration_seconds": 5}]

    async def fake_section_vo(
        ctx_arg: main.ProjectContext,
        sections_arg: list[main.YouTubeClipSection],
    ) -> list[dict]:
        results = []
        for section in sections_arg:
            path = ctx_arg.project_dir / "voiceover" / "sections" / f"section_{section.section}.mp3"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"voice")
            results.append(
                {
                    "section": section.section,
                    "scene_id": f"scene_{section.section}",
                    "path": str(path),
                    "duration_seconds": float(section.duration_seconds),
                }
            )
        return results

    async def fake_combine(ctx_arg: main.ProjectContext, section_voiceovers: list[dict]) -> dict:
        path = ctx_arg.project_dir / "voiceover" / "voiceover.mp3"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"voice")
        return {"path": str(path), "model": "s2-pro", "duration_seconds": 5, "sections": section_voiceovers}

    async def fake_stitch(ctx_arg: main.ProjectContext, scenes: list[dict]) -> str:
        raise RuntimeError("per-section concat failed: mismatched timebase")

    monkeypatch.setattr(main, "download_youtube_clip_assets", fake_download)
    monkeypatch.setattr(main, "generate_section_voiceovers", fake_section_vo)
    monkeypatch.setattr(main, "combine_section_voiceovers", fake_combine)
    monkeypatch.setattr(main, "stitch_assets_per_section", fake_stitch)

    with pytest.raises(RuntimeError, match="mismatched timebase"):
        await main.create_youtube_short_impl(ctx, "News", "A verified update.", sections=sections)

    state = main.read_project_state(ctx)
    assert state["status"]["stage"] == "youtube_short_failed"
    assert "mismatched timebase" in state["status"]["error"]
    assert state["failures"][-1]["stage"] == "stitching"


def test_merge_token_output_into_manifest_surfaces_recorded_tool_error(tmp_path: Path) -> None:
    ctx = main.ProjectContext(project_id="missing-manifest", project_dir=tmp_path / "missing", aspect_ratio="9:16", resolution="720p")
    main.initialize_project_state(ctx, main.CreateProjectRequest(prompt="make a news short", workflow="youtube_clips"))
    main.update_project_state(
        ctx,
        status={
            "stage": "youtube_short_failed",
            "progress": 70,
            "message": "YouTube short stitching failed.",
            "error": "xfade failed: mismatched timebase",
        },
    )

    with pytest.raises(RuntimeError, match="xfade failed: mismatched timebase"):
        main.merge_token_output_into_manifest(ctx, main.pending_token_output(ctx, "gpt-5.4"))


def test_merge_token_output_exports_youtube_final_mp4_with_prompt_name(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    export_dir = tmp_path / "mh_agent_output" / "yt-clips"
    monkeypatch.setattr(main, "MH_AGENT_YT_CLIPS_DIR", export_dir)
    project_id = "c" * 32
    request = main.CreateProjectRequest(prompt="Latest US shootings!!!", workflow="youtube_clips")
    ctx = main.context(project_id, request)
    main.initialize_project_state(ctx, request)
    final_path = ctx.project_dir / "final.mp4"
    final_path.parent.mkdir(parents=True, exist_ok=True)
    final_path.write_bytes(b"final-video")
    token_output = main.pending_token_output(ctx, "gpt-5.4")
    main.write_json_artifact(
        ctx,
        "manifest",
        {
            "project_id": project_id,
            "workflow": "youtube_clips",
            "title": "Latest US Shootings",
            "videos": [{"scene_id": "scene_1", "path": str(final_path)}],
            "token_output": token_output,
            "token_output_path": token_output["token_output_path"],
            "final_video_path": str(final_path),
            "manifest_path": str(ctx.project_dir / "manifest.json"),
        },
    )

    manifest = main.merge_token_output_into_manifest(ctx, token_output)

    exported = export_dir / "latest-us-shootings__cccccccc.mp4"
    assert exported.read_bytes() == b"final-video"
    assert manifest["exported_final_video_path"] == str(exported)
    assert json.loads((ctx.project_dir / "manifest.json").read_text(encoding="utf-8"))["exported_final_video_path"] == str(exported)


def test_project_state_persists_request_preferences_and_status(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    project_id = "b" * 32
    request = main.CreateProjectRequest(
        prompt="make a quiet product teaser",
        duration_seconds=24,
        scene_count=5,
        aspect_ratio="16:9",
        resolution="1080p",
    )
    ctx = main.context(project_id, request)

    state = main.initialize_project_state(ctx, request)
    main.update_project_state(ctx, status={"stage": "queued", "progress": 0, "message": "queued"})
    reloaded = main.read_project_state(ctx)

    assert state["project_id"] == project_id
    assert reloaded["user_preferences"]["prompt"] == "make a quiet product teaser"
    assert reloaded["user_preferences"]["duration_seconds"] == 24
    assert reloaded["user_preferences"]["scene_count"] == 5
    assert reloaded["user_preferences"]["aspect_ratio"] == "16:9"
    assert reloaded["user_preferences"]["resolution"] == "1080p"
    assert reloaded["provider_settings"]["image_model"] == ctx.image_model
    assert reloaded["status"]["stage"] == "queued"
    assert (ctx.project_dir / "project_state.json").exists()


@pytest.mark.asyncio
async def test_read_project_status_includes_persistent_state_after_memory_clear(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    project_id = "c" * 32
    request = main.CreateProjectRequest(prompt="state survives restart")
    ctx = main.context(project_id, request)
    main.initialize_project_state(ctx, request)

    await main.update_project_status(
        project_id,
        status="running",
        stage="planning",
        progress=10,
        message="Planning.",
    )
    main.PROJECTS.pop(project_id, None)

    status = main.read_project_status(project_id)

    assert status is not None
    assert status["status"] == "running"
    assert status["project_state"]["user_preferences"]["prompt"] == "state survives restart"
    assert status["project_state"]["status"]["stage"] == "planning"


@pytest.mark.asyncio
async def test_read_project_status_repairs_running_youtube_status_after_complete_manifest(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    project_id = "d" * 32
    request = main.CreateProjectRequest(prompt="make a YouTube clips short", workflow="youtube_clips")
    ctx = main.context(project_id, request)
    main.initialize_project_state(ctx, request)
    final_video = ctx.project_dir / "final.mp4"
    final_video.parent.mkdir(parents=True, exist_ok=True)
    final_video.write_bytes(b"video")
    manifest = {
        "project_id": project_id,
        "workflow": "youtube_clips",
        "render_status": "complete",
        "completed_scene_count": 2,
        "failed_scene_count": 0,
        "videos": [{"scene_id": "scene_1", "path": str(final_video)}],
        "final_video_path": str(final_video),
        "final_video_url": f"/media/{project_id}/final.mp4",
    }
    main.write_json_artifact(ctx, "manifest", manifest)
    await main.update_project_status(
        project_id,
        status="running",
        stage="youtube_short",
        progress=20,
        message="Creating a YouTube clip short.",
    )

    status = main.read_project_status(project_id)

    assert status is not None
    assert status["status"] == "succeeded"
    assert status["stage"] == "complete"
    assert status["progress"] == 100
    assert status["message"] == "Video is ready."
    assert status["manifest"]["final_video_path"] == str(final_video)
    assert status["project_state"]["status"]["stage"] == "complete"
    persisted = json.loads((ctx.project_dir / "status.json").read_text(encoding="utf-8"))
    assert persisted["status"] == "succeeded"
    assert persisted["manifest"]["render_status"] == "complete"


def test_main_agent_exposes_project_decision_memory_tool() -> None:
    tool_names = {getattr(tool, "name", None) for tool in main.video_agent.tools}

    assert "record_project_decision" in tool_names


def test_youtube_eval_runner_treats_terminal_manifest_as_done(tmp_path: Path) -> None:
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "run_youtube_workflow_evals",
        Path("scripts/run_youtube_workflow_evals.py"),
    )
    assert spec is not None
    runner = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(runner)

    final_video = tmp_path / "final.mp4"
    final_video.write_bytes(b"video")
    snapshot = {
        "status": "running",
        "manifest": {
            "workflow": "youtube_clips",
            "render_status": "partial",
            "videos": [{"scene_id": "scene_1"}],
            "final_video_path": str(final_video),
        },
    }

    assert runner.snapshot_is_terminal(snapshot) is True
    assert runner.normalized_snapshot_status(snapshot) == "succeeded"


@pytest.mark.asyncio
async def test_run_project_keeps_terminal_youtube_manifest_when_agent_errors_after_tool(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    project_id = "e" * 32
    request = main.CreateProjectRequest(prompt="make a YouTube clips short", workflow="youtube_clips")

    async def fake_run(agent, input, *, context, **kwargs):
        final_video = context.project_dir / "final.mp4"
        final_video.parent.mkdir(parents=True, exist_ok=True)
        final_video.write_bytes(b"video")
        main.write_json_artifact(
            context,
            "manifest",
            {
                "project_id": project_id,
                "workflow": "youtube_clips",
                "render_status": "partial",
                "completed_scene_count": 1,
                "failed_scene_count": 1,
                "videos": [{"scene_id": "scene_1", "path": str(final_video)}],
                "final_video_path": str(final_video),
                "final_video_url": f"/media/{project_id}/final.mp4",
            },
        )
        raise RuntimeError("agent failed after youtube tool returned")

    monkeypatch.setattr(main.Runner, "run", fake_run)

    await main.run_project(project_id, request)

    status = main.read_project_status(project_id)
    assert status is not None
    assert status["status"] == "succeeded"
    assert status["stage"] == "complete"
    assert status["message"] == "Partial video is ready with 1 failed scene(s)."
    assert status["manifest"]["final_video_url"] == f"/media/{project_id}/final.mp4"


@pytest.mark.asyncio
async def test_split_render_tools_persist_artifacts_and_manifest(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    ctx = main.ProjectContext(project_id="split", project_dir=tmp_path / "split", aspect_ratio="9:16", resolution="720p")
    main.initialize_project_state(
        ctx,
        main.CreateProjectRequest(prompt="split render prompt", duration_seconds=20, scene_count=2),
    )
    scenes = [
        main.Scene(id="unsafe/one", narration="one", image_prompt="image one", video_prompt="video one", duration_seconds=2),
        main.Scene(id="custom-two", narration="two", image_prompt="image two", video_prompt="video two", duration_seconds=3),
    ]

    async def fake_voice(ctx_arg: main.ProjectContext, narration: str, duration_seconds: int) -> dict:
        path = ctx_arg.project_dir / "voiceover" / "voiceover.mp3"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"voice")
        return {"path": str(path), "model": "voice-model", "duration_seconds": 5, "target_duration_seconds": duration_seconds}

    async def fake_image(ctx_arg: main.ProjectContext, scene: main.Scene) -> dict:
        path = ctx_arg.project_dir / "images" / scene.id / "output.jpg"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"image")
        return {"scene_id": scene.id, "path": str(path), "prompt": scene.image_prompt, "model": "image-model"}

    async def fake_video_batch(ctx_arg: main.ProjectContext, pairs: list[tuple[main.Scene, dict]]) -> list[dict]:
        videos = []
        for scene, _image in pairs:
            path = ctx_arg.project_dir / "videos" / scene.id / "output.mp4"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"video")
            videos.append({"scene_id": scene.id, "path": str(path), "prompt": scene.video_prompt, "model": "video-model", "duration_seconds": scene.duration_seconds})
        return videos

    async def fake_stitch(ctx_arg: main.ProjectContext, videos: list[dict], voiceover: dict) -> str:
        assert [video["scene_id"] for video in videos] == ["scene_1", "scene_2"]
        assert Path(voiceover["path"]).exists()
        path = ctx_arg.project_dir / "final.mp4"
        path.write_bytes(b"final")
        return str(path)

    monkeypatch.setattr(main, "generate_voiceover_asset", fake_voice)
    monkeypatch.setattr(main, "generate_image_asset", fake_image)
    monkeypatch.setattr(main, "generate_video_assets_batch", fake_video_batch)
    monkeypatch.setattr(main, "stitch_assets", fake_stitch)

    plan_payload = await main.draft_video_plan_impl(ctx, "Split Render", "One. Two.", scenes)
    voiceover = await main.generate_voiceover_impl(ctx)
    images_payload = await main.generate_scene_images_impl(ctx)
    videos_payload = await main.animate_scene_videos_impl(ctx)
    status = await main.inspect_render_status_impl(ctx)
    await main.record_project_decision_impl(ctx, "Keep the first completed take.", rationale="The asset is clean.", scene_id="scene_1")
    manifest = await main.stitch_final_video_impl(ctx, main.pending_token_output(ctx, "gpt-5.5"))
    state = main.read_project_state(ctx)

    assert plan_payload["plan"]["scenes"][0]["id"] == "scene_1"
    assert voiceover["voiceover"]["target_duration_seconds"] == 5
    assert [image["scene_id"] for image in images_payload["images"]] == ["scene_1", "scene_2"]
    assert [video["scene_id"] for video in videos_payload["videos"]] == ["scene_1", "scene_2"]
    assert status["artifacts"]["plan"] is True
    assert status["project_state"]["current_plan"]["title"] == "Split Render"
    assert status["completed_scene_count"] == 2
    assert manifest["render_status"] == "complete"
    assert manifest["final_video_url"] == "/media/split/final.mp4"
    assert state["current_plan"]["title"] == "Split Render"
    assert [image["scene_id"] for image in state["scene_assets"]["images"]] == ["scene_1", "scene_2"]
    assert [video["scene_id"] for video in state["scene_assets"]["videos"]] == ["scene_1", "scene_2"]
    assert state["scene_assets"]["voiceover"]["target_duration_seconds"] == 5
    assert state["scene_assets"]["final_video_path"].endswith("final.mp4")
    assert state["failures"] == []
    assert any(decision["decision"] == "Keep the first completed take." for decision in state["decisions"])
    assert (ctx.project_dir / "plan.json").exists()
    assert (ctx.project_dir / "project_state.json").exists()
    assert (ctx.project_dir / "voiceover.json").exists()
    assert (ctx.project_dir / "images.json").exists()
    assert (ctx.project_dir / "videos.json").exists()
    assert (ctx.project_dir / "manifest.json").exists()


@pytest.mark.asyncio
async def test_retry_scene_regenerates_bounded_scene_assets(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    ctx = main.ProjectContext(project_id="retry", project_dir=tmp_path / "retry", aspect_ratio="9:16", resolution="720p")
    scenes = [
        main.Scene(id="scene_1", narration="one", image_prompt="image one", video_prompt="video one", duration_seconds=2),
        main.Scene(id="scene_2", narration="two", image_prompt="image two", video_prompt="video two", duration_seconds=3),
    ]
    await main.draft_video_plan_impl(ctx, "Retry Render", "One. Two.", scenes)
    main.write_json_artifact(ctx, "images", [{"scene_id": "scene_2", "path": str(ctx.project_dir / "old.jpg")}])
    main.write_json_artifact(ctx, "videos", [{"scene_id": "scene_1", "path": str(ctx.project_dir / "scene_1.mp4")}])
    main.write_json_artifact(
        ctx,
        "failed_scenes",
        [{"scene_id": "scene_2", "stage": "video_generation", "error": "provider timeout"}],
    )

    async def fake_image(ctx_arg: main.ProjectContext, scene: main.Scene) -> dict:
        raise AssertionError("video retry should reuse the existing image")

    async def fake_video(ctx_arg: main.ProjectContext, scene: main.Scene, image: dict) -> dict:
        assert scene.id == "scene_2"
        assert image["path"].endswith("old.jpg")
        path = ctx_arg.project_dir / "videos" / scene.id / "retry.mp4"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"video")
        return {"scene_id": scene.id, "path": str(path), "prompt": scene.video_prompt, "model": "video-model", "duration_seconds": scene.duration_seconds}

    monkeypatch.setattr(main, "generate_image_asset", fake_image)
    monkeypatch.setattr(main, "generate_video_asset", fake_video)

    payload = await main.retry_scene_impl(ctx, "scene_2", stage="video")
    state = main.read_project_state(ctx)

    assert payload["retried_scene_id"] == "scene_2"
    assert [video["scene_id"] for video in payload["videos"]] == ["scene_1", "scene_2"]
    assert main.read_json_artifact(ctx, "failed_scenes", []) == []
    assert state["failures"] == []
    assert state["scene_assets"]["videos"][1]["scene_id"] == "scene_2"


@pytest.mark.asyncio
async def test_regenerate_scene_patches_one_scene_and_restitches(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    ctx = main.ProjectContext(project_id="revise-scene", project_dir=tmp_path / "revise-scene", aspect_ratio="9:16", resolution="720p")
    main.initialize_project_state(ctx, main.CreateProjectRequest(prompt="revise one scene", scene_count=2))
    scenes = [
        main.Scene(id="scene_1", narration="one", image_prompt="old image one", video_prompt="old video one", duration_seconds=2),
        main.Scene(id="scene_2", narration="two", image_prompt="old image two", video_prompt="old video two", duration_seconds=3),
    ]
    await main.draft_video_plan_impl(ctx, "Revision Test", "One. Two.", scenes)
    old_image = {"scene_id": "scene_1", "path": str(ctx.project_dir / "images" / "scene_1" / "old.jpg"), "prompt": "old image one", "model": "image-model"}
    old_video = {"scene_id": "scene_1", "path": str(ctx.project_dir / "videos" / "scene_1" / "old.mp4"), "prompt": "old video one", "model": "video-model", "duration_seconds": 2}
    main.write_json_artifact(ctx, "images", [old_image])
    main.write_json_artifact(ctx, "videos", [old_video])
    main.write_json_artifact(ctx, "voiceover", {"path": str(ctx.project_dir / "voice.mp3"), "model": "voice-model", "duration_seconds": 5})

    async def fake_image(ctx_arg: main.ProjectContext, scene: main.Scene) -> dict:
        assert scene.id == "scene_2"
        assert scene.image_prompt == "new image two"
        path = ctx_arg.project_dir / "images" / scene.id / "new.jpg"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"image")
        return {"scene_id": scene.id, "path": str(path), "prompt": scene.image_prompt, "model": "image-model"}

    async def fake_video(ctx_arg: main.ProjectContext, scene: main.Scene, image: dict) -> dict:
        assert scene.id == "scene_2"
        assert scene.video_prompt == "new video two"
        assert image["prompt"] == "new image two"
        path = ctx_arg.project_dir / "videos" / scene.id / "new.mp4"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"video")
        return {"scene_id": scene.id, "path": str(path), "prompt": scene.video_prompt, "model": "video-model", "duration_seconds": scene.duration_seconds}

    async def fake_stitch(ctx_arg: main.ProjectContext, videos: list[dict], voiceover: dict) -> str:
        assert [video["scene_id"] for video in videos] == ["scene_1", "scene_2"]
        path = ctx_arg.project_dir / "final_revised.mp4"
        path.write_bytes(b"final")
        return str(path)

    monkeypatch.setattr(main, "generate_image_asset", fake_image)
    monkeypatch.setattr(main, "generate_video_asset", fake_video)
    monkeypatch.setattr(main, "stitch_assets", fake_stitch)

    patched = await main.regenerate_scene_impl(
        ctx,
        "scene_2",
        image_prompt="new image two",
        video_prompt="new video two",
        narration="revised two",
    )
    manifest = await main.restitch_video_impl(ctx, main.pending_token_output(ctx, "gpt-5.5"), reason="scene_2 looked flat")
    plan = main.load_video_plan(ctx)
    state = main.read_project_state(ctx)

    assert plan.scenes[1].narration == "revised two"
    assert plan.scenes[1].image_prompt == "new image two"
    assert patched["scene"]["video_prompt"] == "new video two"
    assert [image["scene_id"] for image in patched["images"]] == ["scene_1", "scene_2"]
    assert patched["videos"][0]["path"] == old_video["path"]
    assert patched["videos"][1]["prompt"] == "new video two"
    assert manifest["final_video_path"].endswith("final_revised.mp4")
    assert state["scene_assets"]["final_video_path"].endswith("final_revised.mp4")
    assert any(decision["tool"] == "regenerate_scene" for decision in state["decisions"])
    assert any(decision["tool"] == "restitch_video" for decision in state["decisions"])


@pytest.mark.asyncio
async def test_revise_narration_invalidates_and_replaces_voiceover(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    ctx = main.ProjectContext(project_id="revise-audio", project_dir=tmp_path / "revise-audio", aspect_ratio="9:16", resolution="720p")
    main.initialize_project_state(ctx, main.CreateProjectRequest(prompt="revise narration", scene_count=2))
    await main.draft_video_plan_impl(
        ctx,
        "Narration Revision",
        "Old full narration.",
        [
            main.Scene(id="scene_1", narration="old one", image_prompt="image one", video_prompt="video one", duration_seconds=2),
            main.Scene(id="scene_2", narration="old two", image_prompt="image two", video_prompt="video two", duration_seconds=3),
        ],
    )
    main.write_json_artifact(ctx, "voiceover", {"path": str(ctx.project_dir / "old_voice.mp3"), "model": "voice-model", "duration_seconds": 5})

    async def fake_voice(ctx_arg: main.ProjectContext, narration: str, duration_seconds: int) -> dict:
        assert narration == "New full narration."
        path = ctx_arg.project_dir / "voiceover" / "replacement.mp3"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"voice")
        return {"path": str(path), "model": "voice-model", "duration_seconds": 5, "target_duration_seconds": duration_seconds}

    monkeypatch.setattr(main, "generate_voiceover_asset", fake_voice)

    revised = await main.revise_narration_impl(
        ctx,
        "New full narration.",
        [main.SceneNarrationRevision(scene_id="scene_2", narration="new two")],
    )
    assert not (ctx.project_dir / "voiceover.json").exists()

    voiceover = await main.replace_voiceover_impl(ctx)
    plan = main.load_video_plan(ctx)
    state = main.read_project_state(ctx)

    assert revised["plan"]["narration"] == "New full narration."
    assert plan.scenes[1].narration == "new two"
    assert voiceover["voiceover"]["path"].endswith("replacement.mp3")
    assert state["scene_assets"]["voiceover"]["path"].endswith("replacement.mp3")
    assert any(decision["tool"] == "revise_narration" for decision in state["decisions"])
    assert any(decision["tool"] == "replace_voiceover" for decision in state["decisions"])


@pytest.mark.asyncio
async def test_image_tool_creates_download_directory_before_sdk_write(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    class FakeGenerator:
        def generate(self, **kwargs):
            download_dir = Path(kwargs["download_directory"])
            assert download_dir.exists()
            file_path = download_dir / "output-0.jpg"
            file_path.write_bytes(b"image")
            return type("Result", (), {"id": "job1", "downloads": [], "downloaded_paths": [str(file_path)]})()

    class FakeV1:
        ai_image_generator = FakeGenerator()

    class FakeMagicHourClient:
        def __init__(self, token: str):
            self.v1 = FakeV1()

    monkeypatch.setattr(media, "MagicHourClient", FakeMagicHourClient)
    scene = main.Scene(
        id="scene_1",
        narration="one",
        image_prompt="image prompt",
        video_prompt="video prompt",
        duration_seconds=1,
    )
    ctx = main.ProjectContext(
        project_id="project",
        project_dir=tmp_path,
        aspect_ratio="9:16",
        resolution="720p",
        magic_hour_api_key="key",
    )

    result = await main.generate_image_asset(ctx, scene)

    path = Path(result["path"])
    assert path.exists()
    assert path.parent == tmp_path / "images" / "scene_1"


@pytest.mark.asyncio
async def test_video_tool_keeps_download_inside_scene_directory(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    class FakeVideoGenerator:
        def generate(self, **kwargs):
            download_dir = Path(kwargs["download_directory"])
            assert download_dir.exists()
            file_path = download_dir / "output-0.mp4"
            file_path.write_bytes(b"video")
            return type("Result", (), {"id": "job2", "downloads": [], "downloaded_paths": [str(file_path)]})()

    class FakeV1:
        image_to_video = FakeVideoGenerator()

    class FakeMagicHourClient:
        def __init__(self, token: str):
            self.v1 = FakeV1()

    monkeypatch.setattr(media, "MagicHourClient", FakeMagicHourClient)
    image_path = tmp_path / "source.jpg"
    image_path.write_bytes(b"image")
    scene = main.Scene(
        id="scene_1",
        narration="one",
        image_prompt="image prompt",
        video_prompt="slow push-in",
        duration_seconds=1,
    )
    ctx = main.ProjectContext(
        project_id="project",
        project_dir=tmp_path,
        aspect_ratio="9:16",
        resolution="720p",
        magic_hour_api_key="key",
    )

    result = await main.generate_video_asset(ctx, scene, {"path": str(image_path)})

    path = Path(result["path"])
    assert path.exists()
    assert path.parent == tmp_path / "videos" / "scene_1"


@pytest.mark.asyncio
async def test_video_tool_downloads_provider_url_when_sdk_does_not_write_file(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    class FakeVideoGenerator:
        def generate(self, **kwargs):
            download_dir = Path(kwargs["download_directory"])
            assert download_dir.exists()
            return type(
                "Result",
                (),
                {
                    "id": "job2",
                    "status": "complete",
                    "error": None,
                    "downloads": [
                        type("Download", (), {"url": "https://example.test/render/output.mp4"})(),
                    ],
                    "downloaded_paths": [],
                },
            )()

    class FakeV1:
        image_to_video = FakeVideoGenerator()

    class FakeMagicHourClient:
        def __init__(self, token: str):
            self.v1 = FakeV1()

    class FakeResponse:
        content = b"video"

        def raise_for_status(self) -> None:
            return None

    class FakeHttpClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def get(self, url: str):
            assert url == "https://example.test/render/output.mp4"
            return FakeResponse()

    monkeypatch.setattr(media, "MagicHourClient", FakeMagicHourClient)
    monkeypatch.setattr(media.httpx, "Client", FakeHttpClient)
    image_path = tmp_path / "source.jpg"
    image_path.write_bytes(b"image")
    scene = main.Scene(
        id="scene_1",
        narration="one",
        image_prompt="image prompt",
        video_prompt="slow push-in",
        duration_seconds=1,
    )
    ctx = main.ProjectContext(
        project_id="project",
        project_dir=tmp_path,
        aspect_ratio="9:16",
        resolution="720p",
        magic_hour_api_key="key",
    )

    result = await main.generate_video_asset(ctx, scene, {"path": str(image_path)})

    path = Path(result["path"])
    assert path == tmp_path / "videos" / "scene_1" / "output.mp4"
    assert path.read_bytes() == b"video"


@pytest.mark.asyncio
async def test_video_batch_submits_all_jobs_before_polling(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    scenes = [
        main.Scene(id="scene1", narration="one", image_prompt="image one", video_prompt="video one", duration_seconds=1),
        main.Scene(id="scene2", narration="two", image_prompt="image two", video_prompt="video two", duration_seconds=1),
        main.Scene(id="scene3", narration="three", image_prompt="image three", video_prompt="video three", duration_seconds=1),
    ]
    ctx = main.ProjectContext(project_id="batch", project_dir=tmp_path, aspect_ratio="9:16", resolution="720p")
    pairs = [(scene, {"path": str(tmp_path / f"{scene.id}.jpg")}) for scene in scenes]
    submitted: list[str] = []
    polled: list[str] = []
    all_submitted = asyncio.Event()

    async def fake_submit(ctx_arg: main.ProjectContext, scene: main.Scene, image: dict) -> media.VideoAssetJob:
        submitted.append(scene.id)
        if len(submitted) == len(scenes):
            all_submitted.set()
        return media.VideoAssetJob(
            scene=scene,
            image=image,
            out_dir=ctx_arg.project_dir / "videos" / scene.id,
            provider_job_id=f"job-{scene.id}",
            prompt=scene.video_prompt,
            model=ctx_arg.video_model,
            resolution=ctx_arg.resolution,
            audio=ctx_arg.video_audio,
            duration_seconds=scene.duration_seconds,
            submitted_status="queued",
        )

    async def fake_poll(ctx_arg: main.ProjectContext, job: media.VideoAssetJob) -> dict:
        await asyncio.wait_for(all_submitted.wait(), timeout=1)
        polled.append(job.scene.id)
        output = job.out_dir / "output.mp4"
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"video")
        return {"scene_id": job.scene.id, "path": str(output), "provider_job_id": job.provider_job_id}

    monkeypatch.setattr(media, "submit_video_asset_job", fake_submit)
    monkeypatch.setattr(media, "poll_video_asset_job", fake_poll)

    results = await media.generate_video_assets_batch(ctx, pairs)

    assert submitted == ["scene1", "scene2", "scene3"]
    assert polled == ["scene1", "scene2", "scene3"]
    assert [result["scene_id"] for result in results] == ["scene1", "scene2", "scene3"]


@pytest.mark.asyncio
async def test_stitch_assets_pads_short_voiceover_to_planned_final_duration(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    commands: list[tuple[str, list[str]]] = []

    async def fake_run_ffmpeg(cmd: list[str], label: str) -> None:
        commands.append((label, cmd))

    async def fake_probe(path: str | Path) -> float:
        return 12.0 if str(path).endswith("voice.mp3") else 10.0

    monkeypatch.setattr(media, "_run_ffmpeg", fake_run_ffmpeg)
    monkeypatch.setattr(media, "_run_ffprobe_duration", fake_probe)
    ctx = main.ProjectContext(project_id="timed", project_dir=tmp_path, aspect_ratio="9:16", resolution="720p")
    videos = [
        {"scene_id": "scene_1", "path": str(tmp_path / "scene_1.mp4"), "duration_seconds": 10},
        {"scene_id": "scene_2", "path": str(tmp_path / "scene_2.mp4"), "duration_seconds": 10},
    ]
    voiceover = {"path": str(tmp_path / "voice.mp3"), "duration_seconds": 12}

    final = await media.stitch_assets(ctx, videos, voiceover)

    final_cmd = next(cmd for label, cmd in commands if label == "voiceover mux ffmpeg")
    assert final == str(tmp_path / "final.mp4")
    assert "-shortest" not in final_cmd
    assert final_cmd[final_cmd.index("-af") + 1] == "apad"
    assert final_cmd[final_cmd.index("-t") + 1] == "19.500"


@pytest.mark.asyncio
async def test_stitch_assets_trims_long_voiceover_to_planned_video_duration(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    commands: list[tuple[str, list[str]]] = []

    async def fake_run_ffmpeg(cmd: list[str], label: str) -> None:
        commands.append((label, cmd))

    async def fake_probe(path: str | Path) -> float:
        return 24.0 if str(path).endswith("voice.mp3") else 10.0

    monkeypatch.setattr(media, "_run_ffmpeg", fake_run_ffmpeg)
    monkeypatch.setattr(media, "_run_ffprobe_duration", fake_probe)
    ctx = main.ProjectContext(project_id="timed", project_dir=tmp_path, aspect_ratio="9:16", resolution="720p")
    videos = [
        {"scene_id": "scene_1", "path": str(tmp_path / "scene_1.mp4"), "duration_seconds": 10},
        {"scene_id": "scene_2", "path": str(tmp_path / "scene_2.mp4"), "duration_seconds": 10},
    ]
    voiceover = {"path": str(tmp_path / "voice.mp3"), "duration_seconds": 24}

    await media.stitch_assets(ctx, videos, voiceover)

    final_cmd = next(cmd for label, cmd in commands if label == "voiceover mux ffmpeg")
    assert final_cmd[final_cmd.index("-t") + 1] == "19.500"
    assert "afade=t=out" in final_cmd[final_cmd.index("-af") + 1]


@pytest.mark.asyncio
async def test_stitch_assets_extends_tiny_voiceover_overrun_instead_of_cutting(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    commands: list[tuple[str, list[str]]] = []

    async def fake_run_ffmpeg(cmd: list[str], label: str) -> None:
        commands.append((label, cmd))

    async def fake_probe(path: str | Path) -> float:
        return 20.0 if str(path).endswith("voice.mp3") else 10.0

    monkeypatch.setattr(media, "_run_ffmpeg", fake_run_ffmpeg)
    monkeypatch.setattr(media, "_run_ffprobe_duration", fake_probe)
    ctx = main.ProjectContext(project_id="timed", project_dir=tmp_path, aspect_ratio="9:16", resolution="720p")
    videos = [
        {"scene_id": "scene_1", "path": str(tmp_path / "scene_1.mp4"), "duration_seconds": 10},
        {"scene_id": "scene_2", "path": str(tmp_path / "scene_2.mp4"), "duration_seconds": 10},
    ]
    voiceover = {"path": str(tmp_path / "voice.mp3"), "duration_seconds": 20}

    await media.stitch_assets(ctx, videos, voiceover)

    final_cmd = next(cmd for label, cmd in commands if label == "voiceover mux ffmpeg")
    assert final_cmd[final_cmd.index("-t") + 1] == "20.000"
    assert final_cmd[final_cmd.index("-af") + 1] == "apad"


@pytest.mark.asyncio
async def test_stitch_assets_honors_explicit_hard_target_duration(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    commands: list[tuple[str, list[str]]] = []

    async def fake_run_ffmpeg(cmd: list[str], label: str) -> None:
        commands.append((label, cmd))

    async def fake_probe(path: str | Path) -> float:
        return 20.0 if str(path).endswith("voice.mp3") else 3.0

    monkeypatch.setattr(media, "_run_ffmpeg", fake_run_ffmpeg)
    monkeypatch.setattr(media, "_run_ffprobe_duration", fake_probe)
    ctx = main.ProjectContext(project_id="timed", project_dir=tmp_path, aspect_ratio="9:16", resolution="720p")
    videos = [
        {"scene_id": "scene_1", "path": str(tmp_path / "scene_1.mp4"), "duration_seconds": 3},
        {"scene_id": "scene_2", "path": str(tmp_path / "scene_2.mp4"), "duration_seconds": 4},
        {"scene_id": "scene_3", "path": str(tmp_path / "scene_3.mp4"), "duration_seconds": 3},
    ]
    voiceover = {"path": str(tmp_path / "voice.mp3"), "duration_seconds": 20}

    await media.stitch_assets(ctx, videos, voiceover, target_duration_seconds=10)

    timed_cmd = next(cmd for label, cmd in commands if label == "target-duration ffmpeg normalize")
    final_cmd = next(cmd for label, cmd in commands if label == "voiceover mux ffmpeg")
    vf = timed_cmd[timed_cmd.index("-vf") + 1]
    assert "trim=duration=10.000" in vf
    assert final_cmd[final_cmd.index("-t") + 1] == "10.000"
    assert "afade=t=out" in final_cmd[final_cmd.index("-af") + 1]


@pytest.mark.asyncio
async def test_stitch_assets_normalizes_scene_videos_before_crossfade(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    commands: list[tuple[str, list[str]]] = []

    async def fake_run_ffmpeg(cmd: list[str], label: str) -> None:
        commands.append((label, cmd))

    async def fake_probe(path: str | Path) -> float:
        return 12.0 if str(path).endswith("voice.mp3") else 5.0

    monkeypatch.setattr(media, "_run_ffmpeg", fake_run_ffmpeg)
    monkeypatch.setattr(media, "_run_ffprobe_duration", fake_probe)
    ctx = main.ProjectContext(project_id="yt", project_dir=tmp_path, aspect_ratio="9:16", resolution="720p")
    videos = [
        {"scene_id": "scene_1", "path": str(tmp_path / "source_1.mp4"), "duration_seconds": 5},
        {"scene_id": "scene_2", "path": str(tmp_path / "source_2.mp4"), "duration_seconds": 5},
    ]
    voiceover = {"path": str(tmp_path / "voice.mp3"), "duration_seconds": 12}

    await media.stitch_assets(ctx, videos, voiceover)

    normalize_commands = [cmd for label, cmd in commands if label == "normalize scene video for stitch"]
    xfade_cmd = next(cmd for label, cmd in commands if label == "crossfade ffmpeg stitch")

    assert len(normalize_commands) == 2
    for command in normalize_commands:
        vf = command[command.index("-vf") + 1]
        assert "fps=30" in vf
        assert "settb=AVTB" in vf
        assert "setpts=PTS-STARTPTS" in vf
        assert "format=yuv420p" in vf
    assert str(tmp_path / "normalized" / "scene_01.mp4") in xfade_cmd
    assert str(tmp_path / "normalized" / "scene_02.mp4") in xfade_cmd


@pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="ffmpeg/ffprobe required for per-section stitch integration test",
)
@pytest.mark.asyncio
async def test_stitch_assets_per_section_locks_each_scene_to_its_audio_duration(
    tmp_path: Path,
) -> None:
    """The desync fix's core invariant: every muxed section's video length equals
    its measured spoken (audio) length, so boundaries cannot drift. Exercises both
    the pad branch (video shorter than audio) and the trim branch (video longer)."""

    def _make_video(path: Path, duration: float) -> None:
        subprocess.run(
            [
                "ffmpeg", "-y",
                "-f", "lavfi",
                "-i", f"testsrc=size=144x256:rate=30:duration={duration}",
                "-pix_fmt", "yuv420p",
                str(path),
            ],
            check=True,
            capture_output=True,
        )

    def _make_audio(path: Path, duration: float) -> None:
        subprocess.run(
            [
                "ffmpeg", "-y",
                "-f", "lavfi",
                "-i", f"sine=frequency=440:duration={duration}",
                str(path),
            ],
            check=True,
            capture_output=True,
        )

    # scene 1: video (1.0s) SHORTER than audio (2.0s) -> freeze-frame pad branch
    # scene 2: video (6.0s) LONGER than audio (3.5s)  -> trim branch
    _make_video(tmp_path / "vid_1.mp4", 1.0)
    _make_video(tmp_path / "vid_2.mp4", 6.0)
    _make_audio(tmp_path / "aud_1.mp3", 2.0)
    _make_audio(tmp_path / "aud_2.mp3", 3.5)

    ctx = main.ProjectContext(project_id="yt", project_dir=tmp_path, aspect_ratio="9:16", resolution="144p")
    scenes = [
        {"video_path": str(tmp_path / "vid_1.mp4"), "audio_path": str(tmp_path / "aud_1.mp3"), "audio_duration_seconds": 2.0},
        {"video_path": str(tmp_path / "vid_2.mp4"), "audio_path": str(tmp_path / "aud_2.mp3"), "audio_duration_seconds": 3.5},
    ]

    final = await media.stitch_assets_per_section(ctx, scenes)

    # Each muxed section's video duration must equal its audio duration (±1-2 frames).
    muxed_1 = await media._run_ffprobe_duration(tmp_path / "muxed_sections" / "scene_01.mp4")
    muxed_2 = await media._run_ffprobe_duration(tmp_path / "muxed_sections" / "scene_02.mp4")
    assert abs(muxed_1 - 2.0) < 0.1, f"section 1 should be 2.0s, got {muxed_1}"
    assert abs(muxed_2 - 3.5) < 0.1, f"section 2 should be 3.5s, got {muxed_2}"

    # The concatenated final equals the sum of the section (spoken) durations.
    final_duration = await media._run_ffprobe_duration(final)
    assert abs(final_duration - 5.5) < 0.2, f"final should be ~5.5s, got {final_duration}"


@pytest.mark.asyncio
async def test_generation_runs_images_and_videos_in_parallel(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    plan = main.VideoPlan(
        title="Parallel Test",
        narration="Fast narration.",
        scenes=[
            main.Scene(id="scene1", narration="one", image_prompt="image one", video_prompt="video one", duration_seconds=1),
            main.Scene(id="scene2", narration="two", image_prompt="image two", video_prompt="video two", duration_seconds=1),
            main.Scene(id="scene3", narration="three", image_prompt="image three", video_prompt="video three", duration_seconds=1),
        ],
    )
    image_started: list[str] = []
    video_started: list[str] = []
    all_images_started = asyncio.Event()
    all_videos_started = asyncio.Event()

    async def fake_image(ctx: main.ProjectContext, scene: main.Scene) -> dict:
        image_started.append(scene.id)
        if len(image_started) == 3:
            all_images_started.set()
        await asyncio.wait_for(all_images_started.wait(), timeout=1)
        path = ctx.project_dir / f"{scene.id}.png"
        path.write_bytes(b"image")
        return {"scene_id": scene.id, "path": str(path)}

    async def fake_video(ctx: main.ProjectContext, scene: main.Scene, image: dict) -> dict:
        video_started.append(scene.id)
        if len(video_started) == 3:
            all_videos_started.set()
        await asyncio.wait_for(all_videos_started.wait(), timeout=1)
        path = ctx.project_dir / f"{scene.id}.mp4"
        path.write_bytes(b"video")
        return {"scene_id": scene.id, "path": str(path)}

    async def fake_video_batch(ctx: main.ProjectContext, pairs: list[tuple[main.Scene, dict]]) -> list[dict]:
        return await asyncio.gather(*(fake_video(ctx, scene, image) for scene, image in pairs))

    async def fake_voice(ctx: main.ProjectContext, narration: str, duration_seconds: int) -> dict:
        path = ctx.project_dir / "voice.mp3"
        path.write_bytes(b"voice")
        return {"path": str(path)}

    async def fake_stitch(ctx: main.ProjectContext, videos: list[dict], voiceover: dict) -> str:
        path = ctx.project_dir / "final.mp4"
        path.write_bytes(b"final")
        return str(path)

    monkeypatch.setattr(main, "generate_image_asset", fake_image)
    monkeypatch.setattr(main, "generate_video_assets_batch", fake_video_batch)
    monkeypatch.setattr(main, "generate_voiceover_asset", fake_voice)
    monkeypatch.setattr(main, "stitch_assets", fake_stitch)
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)

    manifest = await main.render_plan(
        plan,
        main.ProjectContext(
            project_id="parallel",
            project_dir=tmp_path / "parallel",
            aspect_ratio="9:16",
            resolution="720p",
        ),
        {
            "token_output_path": str(tmp_path / "token_output.json"),
            "cost": {"total_usd": 0.01},
        },
    )

    assert image_started == ["scene1", "scene2", "scene3"]
    assert video_started == ["scene1", "scene2", "scene3"]
    assert Path(manifest["final_video_path"]).exists()
    assert manifest["gpt_cost_usd"] == 0.01


@pytest.mark.asyncio
async def test_render_plan_stitches_successful_segments_when_one_video_fails(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    plan = main.VideoPlan(
        title="Partial Test",
        narration="Fast narration.",
        scenes=[
            main.Scene(id="scene1", narration="one", image_prompt="image one", video_prompt="video one", duration_seconds=1),
            main.Scene(id="scene2", narration="two", image_prompt="image two", video_prompt="video two", duration_seconds=1),
            main.Scene(id="scene3", narration="three", image_prompt="image three", video_prompt="video three", duration_seconds=1),
        ],
    )

    async def fake_image(ctx: main.ProjectContext, scene: main.Scene) -> dict:
        path = ctx.project_dir / "images" / scene.id / "output.jpg"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"image")
        return {"scene_id": scene.id, "path": str(path), "prompt": scene.image_prompt, "model": "image-model"}

    async def fake_video(ctx: main.ProjectContext, scene: main.Scene, image: dict) -> dict:
        if scene.id == "scene3":
            raise RuntimeError("provider did not return the final segment")
        path = ctx.project_dir / "videos" / scene.id / "output.mp4"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"video")
        return {"scene_id": scene.id, "path": str(path), "prompt": scene.video_prompt, "model": "video-model", "duration_seconds": scene.duration_seconds}

    async def fake_video_batch(ctx: main.ProjectContext, pairs: list[tuple[main.Scene, dict]]) -> list[dict | Exception]:
        return await asyncio.gather(
            *(fake_video(ctx, scene, image) for scene, image in pairs),
            return_exceptions=True,
        )

    async def fake_voice(ctx: main.ProjectContext, narration: str, duration_seconds: int) -> dict:
        path = ctx.project_dir / "voiceover" / "voiceover.mp3"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"voice")
        return {"path": str(path), "model": "voice-model", "duration_seconds": duration_seconds}

    async def fake_stitch(ctx: main.ProjectContext, videos: list[dict], voiceover: dict) -> str:
        assert [video["scene_id"] for video in videos] == ["scene1", "scene2"]
        path = ctx.project_dir / "final.mp4"
        path.write_bytes(b"partial final")
        return str(path)

    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    monkeypatch.setattr(main, "generate_image_asset", fake_image)
    monkeypatch.setattr(main, "generate_video_assets_batch", fake_video_batch)
    monkeypatch.setattr(main, "generate_voiceover_asset", fake_voice)
    monkeypatch.setattr(main, "stitch_assets", fake_stitch)
    ctx = main.ProjectContext(project_id="partial", project_dir=tmp_path / "partial", aspect_ratio="9:16", resolution="720p")

    manifest = await main.render_plan(
        plan,
        ctx,
        {
            "token_output_path": str(ctx.project_dir / "token_output.json"),
            "cost": {"total_usd": 0.01},
        },
    )

    assert manifest["render_status"] == "partial"
    assert [scene["scene_id"] for scene in manifest["failed_scenes"]] == ["scene3"]
    assert Path(manifest["final_video_path"]).exists()


def test_backend_health() -> None:
    response = TestClient(main.app).get("/api/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] in {"ok", "missing_config"}
    assert body["output_dir"] == str(main.OUTPUT_DIR)
    assert "missing_config" in body


def test_public_media_path_is_relative_to_output_dir(tmp_path: Path) -> None:
    project_file = main.OUTPUT_DIR / "project-1" / "final.mp4"

    assert main.public_media_path(project_file) == "/media/project-1/final.mp4"


def test_public_media_path_rejects_files_outside_output_dir(tmp_path: Path) -> None:
    outside_file = tmp_path / "final.mp4"

    with pytest.raises(ValueError, match="outside output directory"):
        main.public_media_path(outside_file)


def test_project_id_rejects_path_traversal() -> None:
    with pytest.raises(ValueError, match="Invalid project id"):
        main.project_dir_for("../manifest")


@pytest.mark.asyncio
async def test_create_project_returns_pollable_job(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    monkeypatch.setattr(main, "missing_configuration", lambda: [])
    monkeypatch.setattr(main, "missing_system_dependencies", lambda: [])
    started = threading.Event()

    async def fake_run_project(project_id: str, request: main.CreateProjectRequest) -> None:
        started.set()
        await main.update_project_status(
            project_id,
            status="succeeded",
            stage="complete",
            progress=100,
            message="Ready.",
            manifest={"project_id": project_id, "title": "Done"},
        )

    monkeypatch.setattr(main, "run_project", fake_run_project)

    with TestClient(main.app) as client:
        response = client.post("/api/projects", json={"prompt": "make a polished launch video"})
        assert response.status_code == 202
        body = response.json()
        assert body["status"] == "queued"
        assert body["status_url"] == f"/api/projects/{body['project_id']}"

        assert started.wait(timeout=1)
        status = client.get(body["status_url"]).json()

    assert status["status"] == "succeeded"
    assert status["manifest"]["title"] == "Done"
    assert (tmp_path / body["project_id"] / "status.json").exists()


@pytest.mark.asyncio
async def test_youtube_review_session_starts_data_api_provider_and_persists_comments(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    monkeypatch.setattr(main, "missing_configuration", lambda: [])
    monkeypatch.setattr(main, "missing_system_dependencies", lambda: [])
    requests: list[main.CreateProjectRequest] = []
    started = threading.Event()

    async def fake_run_project(project_id: str, request: main.CreateProjectRequest) -> None:
        requests.append(request)
        started.set()
        await main.update_project_status(
            project_id,
            status="succeeded",
            stage="complete",
            progress=100,
            message="Ready.",
            manifest={
                "project_id": project_id,
                "workflow": "youtube_clips",
                "youtube_search_provider": request.youtube_search_provider,
                "render_status": "complete",
                "completed_scene_count": 1,
                "failed_scene_count": 0,
                "final_video_path": str(tmp_path / project_id / "final.mp4"),
                "final_video_url": f"/media/{project_id}/final.mp4",
            },
        )

    monkeypatch.setattr(main, "run_project", fake_run_project)

    with TestClient(main.app) as client:
        response = client.post(
            "/api/youtube-review-sessions",
            json={
                "prompt": "Make a YouTube clips short about Saquon Barkley.",
                "duration_seconds": 18,
                "scene_count": 4,
                "aspect_ratio": "9:16",
                "resolution": "720p",
            },
        )
        assert response.status_code == 202
        body = response.json()
        review_id = body["review_id"]

        assert started.wait(timeout=1)
        status = client.get(f"/api/youtube-review-sessions/{review_id}").json()
        comment_response = client.post(
            f"/api/youtube-review-sessions/{review_id}/comments",
            json={"provider": "youtube_data_api", "comments": "Better football action, but scene 2 is commentary."},
        )

    providers = {request.youtube_search_provider: request for request in requests}
    assert set(providers) == {"youtube_data_api"}
    assert all(request.workflow == "youtube_clips" for request in requests)
    assert status["providers"]["youtube_data_api"]["status"]["status"] == "succeeded"
    assert status["providers"]["youtube_data_api"]["latency_seconds"] is not None
    assert comment_response.status_code == 200
    assert comment_response.json()["providers"]["youtube_data_api"]["comments"] == "Better football action, but scene 2 is commentary."

    review_path = tmp_path / "reviews" / review_id / "review.json"
    persisted = json.loads(review_path.read_text(encoding="utf-8"))
    assert persisted["providers"]["youtube_data_api"]["comments"] == "Better football action, but scene 2 is commentary."


@pytest.mark.asyncio
async def test_youtube_review_session_surfaces_manifest_video_while_project_is_running(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    project_id = "a" * 32
    review_id = "b" * 32
    request = main.CreateProjectRequest(
        prompt="Make a YouTube clips short about OpenAI.",
        workflow="youtube_clips",
        youtube_search_provider="youtube_data_api",
        youtube_allow_provider_fallback=False,
    )
    main.initialize_project_state(main.context(project_id, request), request)
    await main.update_project_status(
        project_id,
        status="running",
        stage="youtube_short",
        progress=20,
        message="Creating a YouTube clip short.",
    )
    manifest = {
        "project_id": project_id,
        "workflow": "youtube_clips",
        "youtube_search_provider": "youtube_data_api",
        "render_status": "complete",
        "completed_scene_count": 4,
        "failed_scene_count": 0,
        "final_video_path": str(tmp_path / project_id / "final.mp4"),
        "final_video_url": f"/media/{project_id}/final.mp4",
    }
    (tmp_path / project_id / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    main.write_youtube_review_session(
        {
            "review_id": review_id,
            "prompt": request.prompt,
            "created_at": "2026-06-01T00:00:00+00:00",
            "updated_at": "2026-06-01T00:00:00+00:00",
            "settings": {"duration_seconds": None, "scene_count": None, "aspect_ratio": "9:16", "resolution": "720p"},
            "providers": {
                "youtube_data_api": {
                    "provider": "youtube_data_api",
                    "project_id": project_id,
                    "status_url": f"/api/projects/{project_id}",
                    "started_at": "2026-06-01T00:00:00+00:00",
                    "comments": "",
                    "comments_updated_at": None,
                }
            },
        }
    )

    with TestClient(main.app) as client:
        response = client.get(f"/api/youtube-review-sessions/{review_id}")

    assert response.status_code == 200
    provider = response.json()["providers"]["youtube_data_api"]
    assert provider["status"]["status"] == "running"
    assert provider["final_video_url"] == f"/media/{project_id}/final.mp4"
    assert provider["completed_scene_count"] == 4


@pytest.mark.asyncio
async def test_youtube_review_batch_starts_prompt_set_with_both_providers(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    monkeypatch.setattr(main, "missing_configuration", lambda: [])
    monkeypatch.setattr(main, "missing_system_dependencies", lambda: [])
    prompt_set_path = tmp_path / "youtube_prompts.jsonl"
    prompt_set_path.write_text(
        "\n".join(
            [
                json.dumps(
                    {
                        "id": "yt-eval-a",
                        "name": "openai_news",
                        "category": "current_news",
                        "prompt": "Make an 18-second YouTube clips short about OpenAI news.",
                        "settings": {
                            "aspect_ratio": "9:16",
                            "duration_seconds": 18,
                            "scene_count": 4,
                            "resolution": "720p",
                        },
                    }
                ),
                json.dumps(
                    {
                        "id": "yt-eval-b",
                        "name": "iphone_keynote",
                        "category": "historical_tech",
                        "prompt": "Make a 20-second YouTube clips short about the first iPhone keynote.",
                        "settings": {
                            "aspect_ratio": "9:16",
                            "duration_seconds": 20,
                            "scene_count": 4,
                            "resolution": "720p",
                        },
                    }
                ),
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(main, "YOUTUBE_REVIEW_PROMPT_SET_PATH", prompt_set_path, raising=False)
    requests: list[main.CreateProjectRequest] = []
    started = threading.Event()

    async def fake_run_project(project_id: str, request: main.CreateProjectRequest) -> None:
        requests.append(request)
        if len(requests) == 2:
            started.set()
        await main.update_project_status(
            project_id,
            status="succeeded",
            stage="complete",
            progress=100,
            message="Ready.",
            manifest={
                "project_id": project_id,
                "workflow": "youtube_clips",
                "youtube_search_provider": request.youtube_search_provider,
                "render_status": "complete",
                "completed_scene_count": 1,
                "failed_scene_count": 0,
                "final_video_path": str(tmp_path / project_id / "final.mp4"),
                "final_video_url": f"/media/{project_id}/final.mp4",
            },
        )

    monkeypatch.setattr(main, "run_project", fake_run_project)

    with TestClient(main.app) as client:
        response = client.post("/api/youtube-review-batches")
        assert response.status_code == 202
        body = response.json()
        batch_id = body["batch_id"]

        assert started.wait(timeout=1)
        status = client.get(f"/api/youtube-review-batches/{batch_id}").json()
        latest = client.get("/api/youtube-review-batches/latest").json()

    assert len(status["items"]) == 2
    assert latest["batch_id"] == batch_id
    assert status["items"][0]["prompt_id"] == "yt-eval-a"
    assert status["items"][0]["review"]["providers"]["youtube_data_api"]["status"]["status"] == "succeeded"
    assert status["items"][1]["review"]["providers"]["youtube_data_api"]["final_video_url"].endswith("/final.mp4")
    assert {(request.prompt, request.youtube_search_provider) for request in requests} == {
        ("Make an 18-second YouTube clips short about OpenAI news.", "youtube_data_api"),
        ("Make a 20-second YouTube clips short about the first iPhone keynote.", "youtube_data_api"),
    }
    assert all(request.workflow == "youtube_clips" for request in requests)
    assert requests[0].duration_seconds == 18

    batch_path = tmp_path / "reviews" / "batches" / batch_id / "batch.json"
    persisted = json.loads(batch_path.read_text(encoding="utf-8"))
    assert [item["prompt_id"] for item in persisted["items"]] == ["yt-eval-a", "yt-eval-b"]


@pytest.mark.asyncio
async def test_youtube_review_batch_runs_provider_projects_serially(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    monkeypatch.setattr(main, "missing_configuration", lambda: [])
    monkeypatch.setattr(main, "missing_system_dependencies", lambda: [])
    prompt_set_path = tmp_path / "youtube_prompts.jsonl"
    prompt_set_path.write_text(
        "\n".join(
            [
                json.dumps(
                    {
                        "id": "yt-eval-a",
                        "name": "openai_news",
                        "category": "current_news",
                        "prompt": "Make an 18-second YouTube clips short about OpenAI news.",
                        "settings": {"duration_seconds": 18, "scene_count": 4, "aspect_ratio": "9:16", "resolution": "720p"},
                    }
                ),
                json.dumps(
                    {
                        "id": "yt-eval-b",
                        "name": "iphone_keynote",
                        "category": "historical_tech",
                        "prompt": "Make a 20-second YouTube clips short about the first iPhone keynote.",
                        "settings": {"duration_seconds": 20, "scene_count": 4, "aspect_ratio": "9:16", "resolution": "720p"},
                    }
                ),
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(main, "YOUTUBE_REVIEW_PROMPT_SET_PATH", prompt_set_path, raising=False)
    requests: list[main.CreateProjectRequest] = []
    first_started = threading.Event()
    release_first = threading.Event()
    second_started_before_release = threading.Event()
    all_started = threading.Event()

    async def fake_run_project(project_id: str, request: main.CreateProjectRequest) -> None:
        requests.append(request)
        if len(requests) == 1:
            first_started.set()
            await asyncio.to_thread(release_first.wait, 1)
        elif not release_first.is_set():
            second_started_before_release.set()
        if len(requests) == 2:
            all_started.set()
        await main.update_project_status(
            project_id,
            status="succeeded",
            stage="complete",
            progress=100,
            message="Ready.",
            manifest={
                "project_id": project_id,
                "workflow": "youtube_clips",
                "youtube_search_provider": request.youtube_search_provider,
                "render_status": "complete",
                "completed_scene_count": 1,
                "failed_scene_count": 0,
                "final_video_url": f"/media/{project_id}/final.mp4",
            },
        )

    monkeypatch.setattr(main, "run_project", fake_run_project)

    with TestClient(main.app) as client:
        response = client.post("/api/youtube-review-batches")
        assert response.status_code == 202
        assert first_started.wait(timeout=1)
        second_started_before_release.wait(timeout=0.2)
        assert len(requests) == 1
        assert not second_started_before_release.is_set()
        release_first.set()
        assert all_started.wait(timeout=2)


@pytest.mark.asyncio
async def test_message_endpoint_queues_agent_turn_for_existing_project(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    monkeypatch.setattr(main, "missing_configuration", lambda: [])
    monkeypatch.setattr(main, "missing_system_dependencies", lambda: [])
    project_id = "d" * 32
    request = main.CreateProjectRequest(prompt="initial render", scene_count=2)
    ctx = main.context(project_id, request)
    main.initialize_project_state(ctx, request)
    await main.update_project_status(
        project_id,
        status="succeeded",
        stage="complete",
        progress=100,
        message="Video is ready.",
        manifest={"project_id": project_id, "title": "Initial"},
    )
    started = threading.Event()

    async def fake_run_project_message(project_id_arg: str, message: str) -> None:
        assert project_id_arg == project_id
        assert message == "make scene_2 brighter"
        started.set()
        await main.update_project_status(
            project_id_arg,
            status="succeeded",
            stage="message_complete",
            progress=100,
            message="Handled message.",
        )

    monkeypatch.setattr(main, "run_project_message", fake_run_project_message)

    with TestClient(main.app) as client:
        response = client.post(
            f"/api/projects/{project_id}/messages",
            json={"message": "make scene_2 brighter"},
        )
        assert response.status_code == 202
        body = response.json()
        assert body["stage"] == "message_queued"
        assert body["project_state"]["messages"][-1]["role"] == "user"
        assert body["project_state"]["messages"][-1]["content"] == "make scene_2 brighter"

        assert started.wait(timeout=1)
        status = client.get(f"/api/projects/{project_id}").json()

    assert status["stage"] == "message_complete"


@pytest.mark.asyncio
async def test_run_project_message_uses_video_agent_with_persistent_project_state(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    project_id = "e" * 32
    request = main.CreateProjectRequest(prompt="initial render", scene_count=2, aspect_ratio="16:9")
    ctx = main.context(project_id, request)
    main.initialize_project_state(ctx, request)
    await main.update_project_status(
        project_id,
        status="succeeded",
        stage="complete",
        progress=100,
        message="Video is ready.",
        manifest={"project_id": project_id, "title": "Initial"},
    )
    main.append_project_message(ctx, role="user", content="make scene_2 brighter")
    runner_inputs: list[str] = []

    async def fake_run(agent, input, *, context, **kwargs):
        runner_inputs.append(input)
        assert agent is main.video_agent
        assert context.project_id == project_id
        assert context.aspect_ratio == "16:9"
        assert kwargs["max_turns"] > 10
        assert "make scene_2 brighter" in input
        assert "project_state.json" in input
        assert '"messages"' in input
        usage = Usage(requests=1, input_tokens=700, output_tokens=100, total_tokens=800)
        return type(
            "Result",
            (),
            {
                "final_output": "I brightened scene_2 and restitched the edit.",
                "context_wrapper": type("Wrapper", (), {"usage": usage})(),
            },
        )()

    monkeypatch.setattr(main.Runner, "run", fake_run)

    await main.run_project_message(project_id, "make scene_2 brighter")

    status = main.read_project_status(project_id)
    state = main.read_project_state(ctx)
    token_output = json.loads((ctx.project_dir / "token_output.json").read_text(encoding="utf-8"))
    assert runner_inputs
    assert status is not None
    assert status["stage"] == "message_complete"
    assert state["messages"][-1]["role"] == "assistant"
    assert state["messages"][-1]["content"] == "I brightened scene_2 and restitched the edit."
    assert token_output["usage"]["input_tokens"] == 700


@pytest.mark.asyncio
async def test_run_project_uses_extended_agent_turn_budget(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    project_id = "c" * 32
    request = main.CreateProjectRequest(prompt="make a solar explainer")
    seen: dict[str, int] = {}

    async def fake_run(agent, input, *, context, **kwargs):
        seen["max_turns"] = kwargs["max_turns"]
        assert agent is main.video_agent
        usage = Usage(requests=1, input_tokens=700, output_tokens=100, total_tokens=800)
        ctx = context
        main.write_json_artifact(
            ctx,
            "manifest",
            {
                "project_id": ctx.project_id,
                "title": "Done",
                "token_output_path": str(ctx.project_dir / "token_output.json"),
                "cost": {"total_usd": 0},
            },
        )
        return type(
            "Result",
            (),
            {
                "final_output": "Done",
                "context_wrapper": type("Wrapper", (), {"usage": usage})(),
            },
        )()

    monkeypatch.setattr(main.Runner, "run", fake_run)

    await main.run_project(project_id, request)

    assert seen["max_turns"] > 10


@pytest.mark.asyncio
async def test_run_project_message_does_not_reuse_previous_manifest_after_new_plan(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    project_id = "f" * 32
    request = main.CreateProjectRequest(prompt="dragon video", scene_count=2)
    ctx = main.context(project_id, request)
    main.initialize_project_state(ctx, request)
    previous_manifest = {"project_id": project_id, "title": "Dragon", "images": [{"scene_id": "scene_1", "path": "dragon.png"}]}
    main.write_json_artifact(ctx, "manifest", previous_manifest)
    await main.update_project_status(
        project_id,
        status="succeeded",
        stage="complete",
        progress=100,
        message="Video is ready.",
        manifest=previous_manifest,
    )
    main.append_project_message(ctx, role="user", content="now make a wifi video")

    async def fake_run(agent, input, *, context, **kwargs):
        await main.draft_video_plan_impl(
            context,
            "WiFi",
            "WiFi waves bend and fade.",
            [main.Scene(id="scene_1", narration="one", image_prompt="wifi image", video_prompt="wifi motion", duration_seconds=5)],
        )
        usage = Usage(requests=1, input_tokens=700, output_tokens=100, total_tokens=800)
        return type(
            "Result",
            (),
            {
                "final_output": "I drafted a WiFi plan and queued fresh rendering.",
                "context_wrapper": type("Wrapper", (), {"usage": usage})(),
            },
        )()

    monkeypatch.setattr(main.Runner, "run", fake_run)

    await main.run_project_message(project_id, "now make a wifi video")

    status = main.read_project_status(project_id)
    state = main.read_project_state(ctx)
    assert status is not None
    assert status["stage"] == "message_complete"
    assert status.get("manifest") is None
    assert state["current_plan"]["title"] == "WiFi"
    assert state["scene_assets"]["images"] == []


@pytest.mark.asyncio
async def test_render_plan_emits_progress_and_media_urls(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    plan = main.VideoPlan(
        title="Progress Test",
        narration="Fast narration.",
        scenes=[
            main.Scene(id="scene1", narration="one", image_prompt="image one", video_prompt="video one", duration_seconds=1),
            main.Scene(id="scene2", narration="two", image_prompt="image two", video_prompt="video two", duration_seconds=1),
        ],
    )
    progress: list[tuple[str, int]] = []

    async def fake_image(ctx: main.ProjectContext, scene: main.Scene) -> dict:
        path = ctx.project_dir / "images" / scene.id / "output.jpg"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"image")
        return {"scene_id": scene.id, "path": str(path), "prompt": scene.image_prompt, "model": "image-model"}

    async def fake_video(ctx: main.ProjectContext, scene: main.Scene, image: dict) -> dict:
        path = ctx.project_dir / "videos" / scene.id / "output.mp4"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"video")
        return {"scene_id": scene.id, "path": str(path), "prompt": scene.video_prompt, "model": "video-model", "duration_seconds": scene.duration_seconds}

    async def fake_video_batch(ctx: main.ProjectContext, pairs: list[tuple[main.Scene, dict]]) -> list[dict]:
        return await asyncio.gather(*(fake_video(ctx, scene, image) for scene, image in pairs))

    async def fake_voice(ctx: main.ProjectContext, narration: str, duration_seconds: int) -> dict:
        path = ctx.project_dir / "voiceover" / "voiceover.mp3"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"voice")
        return {"path": str(path), "model": "voice-model", "duration_seconds": duration_seconds}

    async def fake_stitch(ctx: main.ProjectContext, videos: list[dict], voiceover: dict) -> str:
        path = ctx.project_dir / "final.mp4"
        path.write_bytes(b"final")
        return str(path)

    async def capture(stage: str, progress_value: int, message: str) -> None:
        progress.append((stage, progress_value))

    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    monkeypatch.setattr(main, "generate_image_asset", fake_image)
    monkeypatch.setattr(main, "generate_video_assets_batch", fake_video_batch)
    monkeypatch.setattr(main, "generate_voiceover_asset", fake_voice)
    monkeypatch.setattr(main, "stitch_assets", fake_stitch)
    ctx = main.ProjectContext(project_id="progress", project_dir=tmp_path / "progress", aspect_ratio="9:16", resolution="720p")

    manifest = await main.render_plan(
        plan,
        ctx,
        {
            "token_output_path": str(ctx.project_dir / "token_output.json"),
            "cost": {"total_usd": 0.01},
        },
        on_progress=capture,
    )

    assert progress == [
        ("voiceover_images", 30),
        ("video_generation", 65),
        ("stitching", 90),
    ]
    assert manifest["final_video_url"] == "/media/progress/final.mp4"
    assert manifest["images"][0]["url"] == "/media/progress/images/scene1/output.jpg"
    assert manifest["videos"][0]["url"] == "/media/progress/videos/scene1/output.mp4"
