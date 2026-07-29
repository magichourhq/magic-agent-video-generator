#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import json
import math
import os
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from openai import OpenAI
from PIL import Image, ImageDraw, ImageFilter, ImageStat


ROOT = Path(__file__).resolve().parents[1]
MAGIC_HOUR_ROOT = ROOT.parent
DEFAULT_OUT_DIR = ROOT / "benchmark_artifacts" / f"video_sota_{datetime.now().strftime('%Y%m%d_%H%M%S')}"

VIDEO_EXTENSIONS = {".mp4", ".mov", ".webm", ".mkv"}

PLATFORM_DIRS = {
    "Canva": MAGIC_HOUR_ROOT / "canvaAI",
    "FocalML": MAGIC_HOUR_ROOT / "focalml_out",
    "Hailuo": MAGIC_HOUR_ROOT / "hailuo" / "hailuo-assets",
    "InVideo": MAGIC_HOUR_ROOT / "inVideo_out",
    "MH Agent": MAGIC_HOUR_ROOT / "mh_agent_output",
    "Pika": MAGIC_HOUR_ROOT / "pika",
}

SCORE_COLUMNS = [
    "prompt_adherence_1_5",
    "story_coherence_1_5",
    "visual_quality_1_5",
    "motion_quality_1_5",
    "narration_audio_1_5",
    "finishedness_1_5",
    "editability_1_5",
]

QUALITY_WEIGHTS = {
    "prompt_adherence_1_5": 20,
    "story_coherence_1_5": 20,
    "visual_quality_1_5": 20,
    "motion_quality_1_5": 15,
    "narration_audio_1_5": 10,
    "finishedness_1_5": 10,
    "editability_1_5": 5,
}

DETAIL_COLUMNS = [
    "video_id",
    "platform",
    "scenario_id",
    "scenario_name",
    "file_name",
    "path",
    "prompt_source",
    "prompt",
    "duration_sec",
    "target_duration_sec",
    "duration_fit_score_1_5",
    "width",
    "height",
    "detected_aspect_ratio",
    "target_aspect_ratio",
    "aspect_fit_score_1_5",
    "format_fit_score_100",
    "fps",
    "video_codec",
    "audio_present",
    "audio_codec",
    "file_size_mb",
    "bitrate_kbps",
    "generation_time_minutes",
    "generation_time_evidence",
    "generation_time_score_1_5",
    *SCORE_COLUMNS,
    "quality_score_100",
    "benchmark_score_100",
    "benchmark_score_basis",
    "rank_within_scenario",
    "state_of_art_tier",
    "usable_first_try",
    "major_failures",
    "visual_summary",
    "judge_notes",
    "audio_transcript_excerpt",
    "contact_sheet_path",
    "judge_model",
    "inference_status",
]


@dataclass(frozen=True)
class Scenario:
    scenario_id: str
    name: str
    prompt: str
    prompt_source: str
    target_duration_sec: float | None = None
    target_aspect_ratio: str = "9:16"


@dataclass(frozen=True)
class VideoItem:
    video_id: str
    platform: str
    path: Path
    scenario: Scenario


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def run_json(cmd: list[str]) -> dict[str, Any]:
    result = subprocess.run(cmd, check=True, text=True, capture_output=True)
    return json.loads(result.stdout)


def run_cmd(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def safe_slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")


def load_benchmark_prompts() -> dict[str, dict[str, Any]]:
    path = ROOT / "evals" / "video_generation_benchmark_prompts.jsonl"
    prompts: dict[str, dict[str, Any]] = {}
    if not path.exists():
        return prompts
    text = path.read_text(encoding="utf-8")
    decoder = json.JSONDecoder()
    idx = 0
    while idx < len(text):
        while idx < len(text) and text[idx].isspace():
            idx += 1
        if idx >= len(text):
            break
        row, end = decoder.raw_decode(text, idx)
        prompts[row["id"]] = row
        idx = end
    return prompts


def scenario_from_case(case: dict[str, Any]) -> Scenario:
    settings = case.get("settings") or {}
    return Scenario(
        scenario_id=case["id"],
        name=case["name"],
        prompt=case["prompt"],
        prompt_source="official_benchmark_prompt",
        target_duration_sec=float(settings["duration_seconds"]) if settings.get("duration_seconds") else None,
        target_aspect_ratio=settings.get("aspect_ratio", "9:16"),
    )


def build_inferred_scenarios(benchmark_prompts: dict[str, dict[str, Any]]) -> dict[str, Scenario]:
    official = {key: scenario_from_case(value) for key, value in benchmark_prompts.items()}
    return {
        **official,
        "audio_workflow": Scenario(
            "audio_workflow",
            "Audio workflow / waveform explainer",
            "Create a short vertical AI-video concept showing an audio workflow or waveform transformation. It should feel clear, modern, and intentionally directed, not like a random abstract loop.",
            "filename_inferred_prompt",
            15,
        ),
        "day_in_life": Scenario(
            "day_in_life",
            "Day-in-the-life / morning vlog",
            "Create a short vertical day-in-the-life or morning-vlog style video with coherent everyday pacing, human realism, and a natural social-video feel.",
            "filename_inferred_prompt",
            15,
        ),
        "late_night_work": Scenario(
            "late_night_work",
            "Late-night work short",
            "Create a short vertical late-night work video with a focused, credible mood. Show the workspace and person consistently without generic productivity cliches.",
            "filename_inferred_prompt",
            15,
        ),
        "ugc_gadget": Scenario(
            "ugc_gadget",
            "UGC product/gadget video",
            "Create a short vertical UGC-style product or gadget video that feels usable for social ads: clear product, natural human behavior, and minimal visual artifacts.",
            "filename_inferred_prompt",
            15,
        ),
        "did_you_know_food": Scenario(
            "did_you_know_food",
            "Food / habit educational short",
            "Create a short vertical educational 'did you know' video about food, habits, or walking after meals. It should be simple, visually understandable, and not medically overclaiming.",
            "filename_inferred_prompt",
            15,
        ),
        "dragon_story": Scenario(
            "dragon_story",
            "Dragon micro-story",
            "Create a short cinematic story about a dragon who forgot how to fly. It should preserve the dragon and story goal across shots and feel like one coherent micro-narrative.",
            "filename_inferred_prompt",
            20,
        ),
        "food_history": Scenario(
            "food_history",
            "History of food explainer",
            "Create an educational video explaining the history of food with clear visuals, factual-seeming structure, and a coherent narrative flow.",
            "filename_inferred_prompt",
            None,
            "16:9",
        ),
    }


def choose_scenario(path: Path, scenarios: dict[str, Scenario]) -> Scenario:
    name = path.stem.lower()
    normalized = name.replace("-", "_")
    if "ai_camera" in normalized or "ai_safety_camera" in normalized:
        return scenarios["vg-bench-001"]
    if "b2b" in normalized or "internal_ai" in normalized:
        return scenarios["vg-bench-002"]
    if "courier" in normalized or "night_delivery" in normalized:
        return scenarios["vg-bench-003"]
    if "mrna" in normalized:
        return scenarios["vg-bench-004"]
    if "cafe" in normalized or "restaurant" in normalized:
        return scenarios["vg-bench-005"]
    if "nfp" in normalized or "fundraiser" in normalized or "nonprofit" in normalized:
        return scenarios["vg-bench-006"]
    if "lisbon" in normalized or "travelling" in normalized or "travel" in normalized:
        return scenarios["vg-bench-008"]
    if "habit_coach" in normalized:
        return scenarios["vg-bench-009"]
    if "waveform" in normalized or "audio" in normalized:
        return scenarios["audio_workflow"]
    if "day_in_my_life" in normalized or "dayin_my_life" in normalized or "morning_vlog" in normalized:
        return scenarios["day_in_life"]
    if "late_night" in normalized or "latenight" in normalized:
        return scenarios["late_night_work"]
    if "ugc" in normalized:
        return scenarios["ugc_gadget"]
    if "did_you_know" in normalized or "did_u_know" in normalized or "walk_after_meals" in normalized:
        return scenarios["did_you_know_food"]
    if "dragon" in normalized:
        return scenarios["dragon_story"]
    if "history_of_food" in normalized:
        return scenarios["food_history"]
    return Scenario(
        "unmapped",
        "Unmapped exported video",
        "Evaluate this exported AI-video output for general visual quality, coherence, motion, and finishedness.",
        "unmapped_filename",
        None,
    )


def discover_videos() -> list[VideoItem]:
    benchmark_prompts = load_benchmark_prompts()
    scenarios = build_inferred_scenarios(benchmark_prompts)
    items: list[VideoItem] = []
    for platform, directory in PLATFORM_DIRS.items():
        if not directory.exists():
            continue
        for path in sorted(directory.iterdir()):
            if path.is_file() and path.suffix.lower() in VIDEO_EXTENSIONS:
                digest = hashlib.sha1(str(path).encode("utf-8")).hexdigest()[:10]
                video_id = f"{safe_slug(platform)}_{safe_slug(path.stem)}_{digest}"
                items.append(VideoItem(video_id=video_id, platform=platform, path=path, scenario=choose_scenario(path, scenarios)))
    return items


def ffprobe(path: Path) -> dict[str, Any]:
    return run_json(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration,bit_rate:stream=index,codec_type,codec_name,width,height,r_frame_rate,duration",
            "-of",
            "json",
            str(path),
        ]
    )


def parse_rate(value: str | None) -> float | None:
    if not value or value == "0/0":
        return None
    if "/" in value:
        numerator, denominator = value.split("/", 1)
        try:
            denominator_f = float(denominator)
            return float(numerator) / denominator_f if denominator_f else None
        except ValueError:
            return None
    try:
        return float(value)
    except ValueError:
        return None


def metadata_for_video(path: Path) -> dict[str, Any]:
    data = ffprobe(path)
    streams = data.get("streams") or []
    video_stream = next((stream for stream in streams if stream.get("codec_type") == "video"), {})
    audio_stream = next((stream for stream in streams if stream.get("codec_type") == "audio"), {})
    duration = float((data.get("format") or {}).get("duration") or video_stream.get("duration") or 0)
    file_size = path.stat().st_size
    bit_rate = (data.get("format") or {}).get("bit_rate")
    return {
        "duration_sec": round(duration, 2),
        "width": int(video_stream.get("width") or 0),
        "height": int(video_stream.get("height") or 0),
        "fps": round(parse_rate(video_stream.get("r_frame_rate")) or 0, 2),
        "video_codec": video_stream.get("codec_name", ""),
        "audio_present": bool(audio_stream),
        "audio_codec": audio_stream.get("codec_name", ""),
        "file_size_mb": round(file_size / (1024 * 1024), 2),
        "bitrate_kbps": round(float(bit_rate) / 1000, 1) if bit_rate else "",
    }


def aspect_label(width: int, height: int) -> str:
    if not width or not height:
        return ""
    ratio = width / height
    if height > width and abs(ratio - 9 / 16) < 0.12:
        return "9:16"
    if width > height and abs(ratio - 16 / 9) < 0.16:
        return "16:9"
    if abs(ratio - 1) < 0.08:
        return "1:1"
    return f"{width}:{height}"


def aspect_fit_score(detected: str, target: str) -> int:
    if not detected or not target:
        return 3
    if detected == target:
        return 5
    if detected in {"9:16", "16:9", "1:1"} and target in {"9:16", "16:9", "1:1"}:
        return 2
    return 3


def duration_fit_score(duration_sec: float, target_duration_sec: float | None) -> int:
    if not target_duration_sec or not duration_sec:
        return 3
    delta = abs(duration_sec - target_duration_sec)
    if delta <= 2:
        return 5
    if delta <= 5:
        return 4
    if delta <= 10:
        return 3
    if duration_sec >= 45 and target_duration_sec <= 20:
        return 2
    return 2


def generation_time_for(item: VideoItem) -> tuple[str, str, str]:
    # Only the local-agent benchmark had durable run timestamps in this repo.
    local_latencies = {
        "vg-bench-001": "3.51",
        "vg-bench-002": "2.75",
        "vg-bench-003": "3.76",
        "vg-bench-005": "3.01",
        "vg-bench-006": "3.76",
        "vg-bench-008": "5.51",
        "vg-bench-009": "3.26",
    }
    if item.platform == "MH Agent" and item.scenario.scenario_id in local_latencies:
        minutes = local_latencies[item.scenario.scenario_id]
        return minutes, "captured in prior local-agent benchmark run metadata", speed_score(float(minutes))
    return "", "not recoverable from exported video file; needs timed generation log", ""


def speed_score(minutes: float) -> str:
    if minutes <= 2:
        return "5"
    if minutes <= 4:
        return "4"
    if minutes <= 8:
        return "3"
    if minutes <= 15:
        return "2"
    return "1"


def sample_times(duration: float, sample_count: int) -> list[float]:
    if duration <= 0:
        return [0.0]
    if sample_count <= 1:
        return [duration / 2]
    start = min(0.5, duration * 0.1)
    end = max(start, duration - min(0.5, duration * 0.1))
    return [start + (end - start) * i / (sample_count - 1) for i in range(sample_count)]


def extract_frames(item: VideoItem, meta: dict[str, Any], frames_dir: Path, sample_count: int) -> list[Path]:
    video_frames_dir = frames_dir / item.video_id
    video_frames_dir.mkdir(parents=True, exist_ok=True)
    duration = float(meta.get("duration_sec") or 0)
    frame_paths: list[Path] = []
    for idx, timestamp in enumerate(sample_times(duration, sample_count), 1):
        frame_path = video_frames_dir / f"frame_{idx:02d}.jpg"
        if not frame_path.exists():
            run_cmd(
                [
                    "ffmpeg",
                    "-y",
                    "-ss",
                    f"{timestamp:.3f}",
                    "-i",
                    str(item.path),
                    "-frames:v",
                    "1",
                    "-q:v",
                    "3",
                    str(frame_path),
                ]
            )
        frame_paths.append(frame_path)
    return frame_paths


def contact_sheet(item: VideoItem, frame_paths: list[Path], contact_dir: Path) -> tuple[Path, dict[str, Any]]:
    contact_dir.mkdir(parents=True, exist_ok=True)
    contact_path = contact_dir / f"{item.video_id}.jpg"
    thumbs: list[Image.Image] = []
    metrics_frames: list[Image.Image] = []
    for frame_path in frame_paths:
        image = Image.open(frame_path).convert("RGB")
        metrics_frames.append(image.copy().resize((160, 160)))
        image.thumbnail((360, 240), Image.Resampling.LANCZOS)
        canvas = Image.new("RGB", (360, 265), "white")
        canvas.paste(image, ((360 - image.width) // 2, 0))
        draw = ImageDraw.Draw(canvas)
        draw.text((8, 244), frame_path.stem.replace("frame_", "sample "), fill=(20, 20, 20))
        thumbs.append(canvas)
    cols = 4
    rows = math.ceil(len(thumbs) / cols)
    sheet = Image.new("RGB", (cols * 360, rows * 265), "white")
    for idx, thumb in enumerate(thumbs):
        sheet.paste(thumb, ((idx % cols) * 360, (idx // cols) * 265))
    sheet.save(contact_path, quality=88)
    return contact_path, visual_metrics(metrics_frames)


def visual_metrics(frames: list[Image.Image]) -> dict[str, float]:
    if not frames:
        return {}
    brightness_values: list[float] = []
    contrast_values: list[float] = []
    edge_values: list[float] = []
    hist_diffs: list[float] = []
    previous_hist: list[int] | None = None
    for image in frames:
        gray = image.convert("L")
        stat = ImageStat.Stat(gray)
        brightness_values.append(float(stat.mean[0]))
        contrast_values.append(float(stat.stddev[0]))
        edges = gray.filter(ImageFilter.FIND_EDGES)
        edge_values.append(float(ImageStat.Stat(edges).mean[0]))
        hist = gray.histogram()
        if previous_hist is not None:
            diff = sum(abs(a - b) for a, b in zip(hist, previous_hist)) / (gray.width * gray.height * 2)
            hist_diffs.append(diff)
        previous_hist = hist
    return {
        "brightness_mean": round(statistics.mean(brightness_values), 2),
        "contrast_mean": round(statistics.mean(contrast_values), 2),
        "edge_mean": round(statistics.mean(edge_values), 2),
        "sample_histogram_diff_mean": round(statistics.mean(hist_diffs), 4) if hist_diffs else 0,
    }


def extract_audio_sample(item: VideoItem, meta: dict[str, Any], audio_dir: Path) -> Path | None:
    if not meta.get("audio_present"):
        return None
    audio_dir.mkdir(parents=True, exist_ok=True)
    audio_path = audio_dir / f"{item.video_id}.mp3"
    if audio_path.exists():
        return audio_path
    run_cmd(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(item.path),
            "-t",
            "90",
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-b:a",
            "48k",
            str(audio_path),
        ]
    )
    return audio_path


def transcribe_audio(client: OpenAI, item: VideoItem, audio_path: Path | None, cache_dir: Path) -> tuple[str, str]:
    if audio_path is None:
        return "", "no_audio_stream"
    cache_path = cache_dir / f"{item.video_id}.json"
    if cache_path.exists():
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
        return payload.get("text", ""), payload.get("status", "cached")
    try:
        with audio_path.open("rb") as fh:
            transcript = client.audio.transcriptions.create(model=os.environ.get("BENCHMARK_TRANSCRIBE_MODEL", "whisper-1"), file=fh)
        text = getattr(transcript, "text", "") or ""
        payload = {"status": "succeeded", "text": text}
    except Exception as exc:
        payload = {"status": f"failed: {type(exc).__name__}: {exc}", "text": ""}
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return payload.get("text", ""), payload.get("status", "")


def encode_image_data_url(path: Path) -> str:
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:image/jpeg;base64,{encoded}"


def judge_prompt(item: VideoItem, meta: dict[str, Any], metrics: dict[str, Any], transcript: str) -> str:
    transcript_excerpt = transcript[:1800] if transcript else ""
    return f"""
Evaluate this AI-generated video output using the sampled contact sheet. The contact sheet contains frames sampled across the whole video, so judge the full output implied by those frames, not one best frame.

Platform: {item.platform}
File: {item.path.name}
Scenario: {item.scenario.name}
Prompt/source task: {item.scenario.prompt}
Prompt source: {item.scenario.prompt_source}

Mechanical metadata:
- duration_sec: {meta.get("duration_sec")}
- width: {meta.get("width")}
- height: {meta.get("height")}
- detected_aspect_ratio: {aspect_label(int(meta.get("width") or 0), int(meta.get("height") or 0))}
- target_aspect_ratio: {item.scenario.target_aspect_ratio}
- fps: {meta.get("fps")}
- audio_present: {meta.get("audio_present")}
- sampled visual metrics: {json.dumps(metrics, sort_keys=True)}
- audio transcript excerpt, if available: {transcript_excerpt or "[none]"}

Return strict JSON only with these keys:
- prompt_adherence_1_5
- story_coherence_1_5
- visual_quality_1_5
- motion_quality_1_5
- narration_audio_1_5
- finishedness_1_5
- editability_1_5
- usable_first_try: "yes" or "no"
- major_failures: short semicolon-separated failure list, or empty string
- visual_summary: one sentence describing what the video appears to show
- judge_notes: concise evidence-backed grading note

Scoring rules:
- Use integers 1 through 5 only.
- Give prompt_adherence credit for matching the scenario, requested format, and duration/aspect constraints when known.
- Story coherence should reward planned scene progression over unrelated clips.
- Visual quality should reward sharpness, aesthetic quality, realism, and lack of artifacts.
- Motion quality should penalize morphing, jitter, implausible movement, and static slideshow feel inferred from sampled frames and metadata.
- Narration/audio should be 1 if there is no audio stream. If audio exists, use the transcript excerpt and metadata; if transcript is empty, score conservatively.
- Finishedness should answer whether the output is usable as an end-user deliverable.
- Editability should reward platforms/outputs that appear to have coherent scenes/structure a user could revise, and penalize raw single clips or generic stock montages.
""".strip()


def coerce_score(value: Any) -> int:
    try:
        number = int(round(float(value)))
    except Exception:
        return 1
    return max(1, min(5, number))


def parse_json_payload(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?", "", cleaned).strip()
        cleaned = re.sub(r"```$", "", cleaned).strip()
    match = re.search(r"\{.*\}", cleaned, re.DOTALL)
    if match:
        cleaned = match.group(0)
    return json.loads(cleaned)


def judge_video(client: OpenAI, model: str, item: VideoItem, contact_path: Path, meta: dict[str, Any], metrics: dict[str, Any], transcript: str, cache_dir: Path) -> dict[str, Any]:
    cache_path = cache_dir / f"{item.video_id}.json"
    if cache_path.exists():
        return json.loads(cache_path.read_text(encoding="utf-8"))
    message = judge_prompt(item, meta, metrics, transcript)
    payload: dict[str, Any]
    try:
        response = client.chat.completions.create(
            model=model,
            temperature=0,
            response_format={"type": "json_object"},
            messages=[
                {
                    "role": "system",
                    "content": "You are a strict AI-video benchmark judge. Score only from the supplied frames, prompt, transcript, and metadata.",
                },
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": message},
                        {"type": "image_url", "image_url": {"url": encode_image_data_url(contact_path), "detail": "high"}},
                    ],
                },
            ],
            max_tokens=900,
        )
        content = response.choices[0].message.content or "{}"
        payload = parse_json_payload(content)
        payload["inference_status"] = "succeeded"
    except Exception as exc:
        payload = {
            "inference_status": f"failed: {type(exc).__name__}: {exc}",
            "prompt_adherence_1_5": "",
            "story_coherence_1_5": "",
            "visual_quality_1_5": "",
            "motion_quality_1_5": "",
            "narration_audio_1_5": "",
            "finishedness_1_5": "",
            "editability_1_5": "",
            "usable_first_try": "",
            "major_failures": "",
            "visual_summary": "",
            "judge_notes": "",
        }
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    return payload


def quality_score(row: dict[str, Any]) -> str:
    total = 0.0
    for column, weight in QUALITY_WEIGHTS.items():
        total += coerce_score(row.get(column)) * weight
    return f"{total / 5:.1f}"


def benchmark_score(row: dict[str, Any]) -> str:
    quality = float(row["quality_score_100"])
    fit = float(row.get("format_fit_score_100") or 0)
    speed = row.get("generation_time_score_1_5")
    if speed == "":
        return f"{quality * 0.85 + fit * 0.15:.1f}"
    return f"{quality * 0.75 + fit * 0.15 + (coerce_score(speed) * 20) * 0.1:.1f}"


def tier(score: str) -> str:
    if score == "":
        return "unscored"
    value = float(score)
    if value >= 85:
        return "SOTA candidate"
    if value >= 75:
        return "strong"
    if value >= 65:
        return "competitive"
    if value >= 50:
        return "usable with fixes"
    return "weak"


def build_detail_row(
    item: VideoItem,
    meta: dict[str, Any],
    contact_path: Path,
    metrics: dict[str, Any],
    transcript: str,
    judge: dict[str, Any],
    model: str,
) -> dict[str, Any]:
    detected_aspect = aspect_label(int(meta.get("width") or 0), int(meta.get("height") or 0))
    generation_minutes, generation_evidence, generation_score = generation_time_for(item)
    duration_score = duration_fit_score(float(meta.get("duration_sec") or 0), item.scenario.target_duration_sec)
    aspect_score = aspect_fit_score(detected_aspect, item.scenario.target_aspect_ratio)
    row: dict[str, Any] = {
        "video_id": item.video_id,
        "platform": item.platform,
        "scenario_id": item.scenario.scenario_id,
        "scenario_name": item.scenario.name,
        "file_name": item.path.name,
        "path": str(item.path),
        "prompt_source": item.scenario.prompt_source,
        "prompt": item.scenario.prompt,
        "duration_sec": meta.get("duration_sec", ""),
        "target_duration_sec": item.scenario.target_duration_sec or "",
        "duration_fit_score_1_5": duration_score,
        "width": meta.get("width", ""),
        "height": meta.get("height", ""),
        "detected_aspect_ratio": detected_aspect,
        "target_aspect_ratio": item.scenario.target_aspect_ratio,
        "aspect_fit_score_1_5": aspect_score,
        "format_fit_score_100": f"{((duration_score + aspect_score) / 10) * 100:.1f}",
        "fps": meta.get("fps", ""),
        "video_codec": meta.get("video_codec", ""),
        "audio_present": "yes" if meta.get("audio_present") else "no",
        "audio_codec": meta.get("audio_codec", ""),
        "file_size_mb": meta.get("file_size_mb", ""),
        "bitrate_kbps": meta.get("bitrate_kbps", ""),
        "generation_time_minutes": generation_minutes,
        "generation_time_evidence": generation_evidence,
        "generation_time_score_1_5": generation_score,
        "contact_sheet_path": str(contact_path),
        "judge_model": model,
        "inference_status": judge.get("inference_status", ""),
        "audio_transcript_excerpt": transcript[:600],
    }
    for column in SCORE_COLUMNS:
        value = judge.get(column, "")
        row[column] = coerce_score(value) if value != "" else ""
    if row["audio_present"] == "no":
        row["narration_audio_1_5"] = 1
    row["usable_first_try"] = judge.get("usable_first_try", "")
    row["major_failures"] = judge.get("major_failures", "")
    row["visual_summary"] = judge.get("visual_summary", "")
    row["judge_notes"] = judge.get("judge_notes", "")
    if all(row.get(column) != "" for column in SCORE_COLUMNS):
        row["quality_score_100"] = quality_score(row)
        row["benchmark_score_100"] = benchmark_score(row)
        row["benchmark_score_basis"] = "quality_75_format_15_time_10" if row.get("generation_time_score_1_5") != "" else "quality_85_format_15_time_missing"
        row["state_of_art_tier"] = tier(row["quality_score_100"])
    else:
        row["quality_score_100"] = ""
        row["benchmark_score_100"] = ""
        row["benchmark_score_basis"] = ""
        row["state_of_art_tier"] = "unscored"
    row.update({f"metric_{key}": value for key, value in metrics.items()})
    return row


def rank_rows(rows: list[dict[str, Any]]) -> None:
    by_scenario: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        by_scenario.setdefault(str(row["scenario_id"]), []).append(row)
    for scenario_rows in by_scenario.values():
        ranked = sorted(
            [row for row in scenario_rows if row.get("quality_score_100") != ""],
            key=lambda row: float(row["quality_score_100"]),
            reverse=True,
        )
        current_rank = 0
        previous_score: float | None = None
        for idx, row in enumerate(ranked, 1):
            score = float(row["quality_score_100"])
            if previous_score is None or score < previous_score:
                current_rank = idx
            row["rank_within_scenario"] = current_rank
            previous_score = score
        for row in scenario_rows:
            row.setdefault("rank_within_scenario", "")


def write_csv(path: Path, rows: list[dict[str, Any]], columns: list[str] | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if columns is None:
        keys: list[str] = []
        for row in rows:
            for key in row:
                if key not in keys:
                    keys.append(key)
        columns = keys
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def average(values: list[float]) -> str:
    return f"{statistics.mean(values):.1f}" if values else ""


def platform_summary(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    summaries: list[dict[str, Any]] = []
    for platform in sorted({row["platform"] for row in rows}):
        platform_rows = [row for row in rows if row["platform"] == platform]
        scored = [row for row in platform_rows if row.get("quality_score_100") != ""]
        scores = [float(row["quality_score_100"]) for row in scored]
        benchmark_scores = [float(row["benchmark_score_100"]) for row in scored if row.get("benchmark_score_100") != ""]
        format_scores = [float(row["format_fit_score_100"]) for row in platform_rows if row.get("format_fit_score_100") != ""]
        speed_scores = [coerce_score(row["generation_time_score_1_5"]) for row in platform_rows if row.get("generation_time_score_1_5") != ""]
        portrait_rows = [row for row in platform_rows if row.get("detected_aspect_ratio") == "9:16"]
        audio_rows = [row for row in platform_rows if row.get("audio_present") == "yes"]
        best = max(scored, key=lambda row: float(row["quality_score_100"])) if scored else None
        summaries.append(
            {
                "platform": platform,
                "videos_evaluated": len(platform_rows),
                "scored_videos": len(scored),
                "avg_quality_score_100": average(scores),
                "avg_benchmark_score_100": average(benchmark_scores),
                "avg_format_fit_score_100": average(format_scores),
                "median_quality_score_100": f"{statistics.median(scores):.1f}" if scores else "",
                "best_quality_score_100": f"{max(scores):.1f}" if scores else "",
                "best_scenario": best["scenario_name"] if best else "",
                "best_file": best["file_name"] if best else "",
                "avg_generation_time_score_1_5": average([float(value) for value in speed_scores]),
                "generation_time_known_count": len(speed_scores),
                "portrait_9_16_share": f"{len(portrait_rows) / len(platform_rows):.0%}" if platform_rows else "",
                "audio_present_share": f"{len(audio_rows) / len(platform_rows):.0%}" if platform_rows else "",
                "avg_duration_sec": average([float(row["duration_sec"]) for row in platform_rows if row.get("duration_sec") != ""]),
                "sota_takeaway": platform_takeaway(platform, scores, speed_scores),
            }
        )
    ranked = sorted(
        [row for row in summaries if row.get("avg_quality_score_100") != ""],
        key=lambda row: float(row["avg_quality_score_100"]),
        reverse=True,
    )
    for idx, row in enumerate(ranked, 1):
        row["platform_quality_rank"] = idx
    for row in summaries:
        row.setdefault("platform_quality_rank", "")
    return sorted(summaries, key=lambda row: row.get("platform_quality_rank") or 999)


def platform_takeaway(platform: str, scores: list[float], speed_scores: list[int]) -> str:
    if not scores:
        return "No scored videos."
    avg_score = statistics.mean(scores)
    if platform == "MH Agent":
        return "Best test of end-to-end short production when narration, multi-scene structure, and editability matter." if avg_score >= 70 else "End-to-end workflow is present, but output quality needs fixes."
    if platform == "InVideo":
        return "Strong finished-video and long-form baseline, but several exports are not like-for-like short-form generations."
    if avg_score >= 75:
        return "Strong visual baseline in this corpus."
    if avg_score >= 65:
        return "Competitive for quick visual clips, weaker as a finished multi-scene product video."
    return "Useful as a fast/raw-generation reference, not state-of-art finished output in this corpus."


def scenario_summary(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    summaries: list[dict[str, Any]] = []
    for scenario_id in sorted({row["scenario_id"] for row in rows}):
        scenario_rows = [row for row in rows if row["scenario_id"] == scenario_id and row.get("quality_score_100") != ""]
        if not scenario_rows:
            continue
        best = max(scenario_rows, key=lambda row: float(row["quality_score_100"]))
        summaries.append(
            {
                "scenario_id": scenario_id,
                "scenario_name": best["scenario_name"],
                "outputs_compared": len(scenario_rows),
                "winning_platform": best["platform"],
                "winning_file": best["file_name"],
                "winning_quality_score_100": best["quality_score_100"],
                "runner_up_platform": sorted(scenario_rows, key=lambda row: float(row["quality_score_100"]), reverse=True)[1]["platform"] if len(scenario_rows) > 1 else "",
                "notes": best["judge_notes"],
            }
        )
    return summaries


def evaluate_item(client: OpenAI, model: str, item: VideoItem, out_dir: Path, sample_count: int) -> dict[str, Any]:
    meta = metadata_for_video(item.path)
    frames = extract_frames(item, meta, out_dir / "frames", sample_count)
    contact_path, metrics = contact_sheet(item, frames, out_dir / "contact_sheets")
    audio_path = extract_audio_sample(item, meta, out_dir / "audio_samples")
    transcript, _transcription_status = transcribe_audio(client, item, audio_path, out_dir / "transcripts")
    judge = judge_video(client, model, item, contact_path, meta, metrics, transcript, out_dir / "judge_raw")
    return build_detail_row(item, meta, contact_path, metrics, transcript, judge, model)


def write_readme(out_dir: Path, rows: list[dict[str, Any]], summaries: list[dict[str, Any]], model: str) -> None:
    top_platform = summaries[0] if summaries else {}
    readme = f"""# AI Video SOTA Benchmark

Generated: {datetime.now(timezone.utc).isoformat()}

This benchmark evaluates exported videos from Canva, Hailuo, FocalML, MH Agent, InVideo, and Pika. It combines mechanical video metadata from `ffprobe`, sampled-frame visual inference with `{model}`, and audio transcription when an audio stream exists.

## Files

- `video_inference_scores.csv`: Google-Sheets-ready per-video benchmark rows.
- `platform_summary.csv`: platform-level averages and ranking.
- `scenario_winners.csv`: best platform per mapped scenario.
- `ai_video_sota_benchmark_2026-05-08.xlsx`: formatted workbook for Google Sheets or Excel.
- `contact_sheets/`: sampled-frame evidence used for visual inference.
- `judge_raw/` and `transcripts/`: raw inference outputs.

## Current Topline

- Videos evaluated: {len(rows)}
- Top platform by average benchmark score: {top_platform.get("platform", "")} ({top_platform.get("avg_benchmark_score_100", "")}/100)
- Generation time caveat: only MH Agent rows inherited durable generation timing from the prior local benchmark. The external exported MP4s do not contain actual generation start/end timestamps, so generation time is marked unknown unless captured elsewhere.
"""
    (out_dir / "README.md").write_text(readme, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate exported AI-video platform outputs with sampled-frame inference.")
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    parser.add_argument("--model", default=os.environ.get("BENCHMARK_JUDGE_MODEL", "gpt-4o"))
    parser.add_argument("--sample-count", type=int, default=8)
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    load_dotenv(ROOT.parent / ".env")
    load_dotenv(ROOT / ".env")

    if not os.environ.get("OPENAI_API_KEY"):
        raise SystemExit("OPENAI_API_KEY is required. It was not found in env or parent .env.")
    if not shutil.which("ffprobe") or not shutil.which("ffmpeg"):
        raise SystemExit("ffmpeg and ffprobe are required.")

    out_dir = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    items = discover_videos()
    if args.limit:
        items = items[: args.limit]

    client = OpenAI()
    started = time.time()
    rows: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
        futures = {executor.submit(evaluate_item, client, args.model, item, out_dir, args.sample_count): item for item in items}
        for future in as_completed(futures):
            item = futures[future]
            try:
                row = future.result()
            except Exception as exc:
                row = {
                    "video_id": item.video_id,
                    "platform": item.platform,
                    "scenario_id": item.scenario.scenario_id,
                    "scenario_name": item.scenario.name,
                    "file_name": item.path.name,
                    "path": str(item.path),
                    "inference_status": f"failed: {type(exc).__name__}: {exc}",
                }
            rows.append(row)
            print(f"[{len(rows):02d}/{len(items):02d}] {item.platform}: {item.path.name} -> {row.get('quality_score_100', '')}", flush=True)

    rank_rows(rows)
    detail_columns = DETAIL_COLUMNS + sorted({key for row in rows for key in row if key.startswith("metric_")})
    rows_sorted = sorted(rows, key=lambda row: (str(row.get("scenario_id", "")), str(row.get("platform", "")), str(row.get("file_name", ""))))
    platform_rows = platform_summary(rows_sorted)
    scenario_rows = scenario_summary(rows_sorted)

    write_csv(out_dir / "video_inference_scores.csv", rows_sorted, detail_columns)
    write_csv(out_dir / "platform_summary.csv", platform_rows)
    write_csv(out_dir / "scenario_winners.csv", scenario_rows)
    (out_dir / "video_inference_scores.json").write_text(json.dumps(rows_sorted, indent=2, sort_keys=True), encoding="utf-8")
    (out_dir / "run_config.json").write_text(
        json.dumps(
            {
                "created_at": datetime.now(timezone.utc).isoformat(),
                "judge_model": args.model,
                "sample_count": args.sample_count,
                "workers": args.workers,
                "elapsed_seconds": round(time.time() - started, 2),
                "source_dirs": {key: str(value) for key, value in PLATFORM_DIRS.items()},
            },
            indent=2,
            sort_keys=True,
        ),
        encoding="utf-8",
    )
    write_readme(out_dir, rows_sorted, platform_rows, args.model)
    print(out_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
