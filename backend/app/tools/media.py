from __future__ import annotations

import asyncio
import logging
import os
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
import ormsgpack

from magic_hour import Client as MagicHourClient

logger = logging.getLogger(__name__)

# Clean up empty proxy env vars. httpx treats "" as a proxy target
# and tries to resolve an empty hostname, causing Errno 8.
for _proxy_var in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"):
    if os.environ.get(_proxy_var) == "":
        del os.environ[_proxy_var]


@dataclass(frozen=True)
class ProjectContext:
    project_id: str
    project_dir: Path
    aspect_ratio: str
    resolution: str
    magic_hour_api_key: str = ""
    fish_audio_api_key: str = ""
    fish_audio_reference_id: str = ""
    image_model: str = "seedream-v4"
    image_resolution: str = "1k"
    image_style_tool: str = "general"
    video_model: str = "ltx-2.3"
    video_audio: bool = False
    audio_model: str = "s2-pro"
    audio_format: str = "mp3"


@dataclass(frozen=True)
class VideoAssetJob:
    scene: Any
    image: dict[str, Any]
    out_dir: Path
    provider_job_id: str
    prompt: str
    model: str
    resolution: str
    audio: bool
    duration_seconds: int
    submitted_status: str | None = None


def pick_download(result: Any, directory: Path) -> Path:
    for raw_path in getattr(result, "downloaded_paths", None) or []:
        path = Path(raw_path)
        if path.is_file():
            return path
    disk_files = sorted(path for path in directory.iterdir() if path.is_file())
    if disk_files:
        return disk_files[0]
    raise FileNotFoundError(f"No downloaded files in {directory}")


def first_download_url(result: Any) -> str | None:
    downloads = list(getattr(result, "downloads", None) or [])
    return getattr(downloads[0], "url", None) if downloads else None


def ensure_provider_output_downloaded(result: Any, directory: Path, label: str) -> Path:
    try:
        return pick_download(result, directory)
    except FileNotFoundError:
        pass

    url = first_download_url(result)
    if not url:
        provider_id = getattr(result, "id", None)
        status = getattr(result, "status", None)
        error = getattr(result, "error", None)
        raise FileNotFoundError(
            f"No local file or provider download URL for {label} output"
            f" in {directory}. provider_job_id={provider_id!r} status={status!r} error={error!r}"
        )

    directory.mkdir(parents=True, exist_ok=True)
    filename = Path(urlparse(url).path).name or f"{label}-output"
    download_path = directory / filename
    with httpx.Client(timeout=600) as http_client:
        response = http_client.get(url)
        response.raise_for_status()
    download_path.write_bytes(response.content)

    if download_path.stat().st_size <= 0:
        raise ValueError(f"Downloaded empty {label} output: {download_path}")

    logger.info("Downloaded %s output saved as: %s", label, download_path)
    return download_path


def reset_provider_output_dir(directory: Path) -> None:
    shutil.rmtree(directory, ignore_errors=True)
    directory.mkdir(parents=True, exist_ok=True)


async def generate_image_asset(ctx: ProjectContext, scene: Any) -> dict[str, Any]:
    def run() -> dict[str, Any]:
        out_dir = ctx.project_dir / "images" / scene.id
        reset_provider_output_dir(out_dir)
        result = MagicHourClient(token=ctx.magic_hour_api_key).v1.ai_image_generator.generate(
            image_count=1,
            style={"prompt": scene.image_prompt, "tool": ctx.image_style_tool},
            aspect_ratio=ctx.aspect_ratio,
            model=ctx.image_model,
            name=f"{ctx.project_id}-{scene.id}",
            resolution=ctx.image_resolution,
            wait_for_completion=True,
            download_outputs=False,
            download_directory=str(out_dir),
        )
        downloaded = ensure_provider_output_downloaded(result, out_dir, "image")
        return {
            "scene_id": scene.id,
            "path": str(downloaded),
            "prompt": scene.image_prompt,
            "model": ctx.image_model,
            "resolution": ctx.image_resolution,
            "style_tool": ctx.image_style_tool,
            "provider_job_id": getattr(result, "id", None),
            "provider_url": first_download_url(result),
        }

    return await asyncio.to_thread(run)


async def generate_video_asset(ctx: ProjectContext, scene: Any, image: dict[str, Any]) -> dict[str, Any]:
    def run() -> dict[str, Any]:
        out_dir = ctx.project_dir / "videos" / scene.id
        reset_provider_output_dir(out_dir)
        result = MagicHourClient(token=ctx.magic_hour_api_key).v1.image_to_video.generate(
            assets={"image_file_path": image["path"]},
            end_seconds=float(scene.duration_seconds),
            model=ctx.video_model,
            name=f"{ctx.project_id}-{scene.id}",
            resolution=ctx.resolution,
            style={"prompt": scene.video_prompt},
            audio=ctx.video_audio,
            wait_for_completion=True,
            download_outputs=False,
            download_directory=str(out_dir),
        )
        downloaded = ensure_provider_output_downloaded(result, out_dir, "video")
        return {
            "scene_id": scene.id,
            "path": str(downloaded),
            "prompt": scene.video_prompt,
            "model": ctx.video_model,
            "resolution": ctx.resolution,
            "audio": ctx.video_audio,
            "duration_seconds": scene.duration_seconds,
            "provider_job_id": getattr(result, "id", None),
            "provider_url": first_download_url(result),
        }

    return await asyncio.to_thread(run)


def video_poll_interval_seconds() -> float:
    return max(0.5, float(os.getenv("MAGIC_HOUR_POLL_INTERVAL", "2.0")))


def video_poll_timeout_seconds() -> float:
    return max(30.0, float(os.getenv("MAGIC_HOUR_VIDEO_TIMEOUT_SECONDS", "900")))


def video_status_error(result: Any) -> str:
    status = getattr(result, "status", None)
    error = getattr(result, "error", None)
    provider_id = getattr(result, "id", None)
    return f"provider_job_id={provider_id!r} status={status!r} error={error!r}"


async def submit_video_asset_job(ctx: ProjectContext, scene: Any, image: dict[str, Any]) -> VideoAssetJob:
    """Upload the scene image and submit an image-to-video job without blocking for completion."""

    def run() -> VideoAssetJob:
        out_dir = ctx.project_dir / "videos" / scene.id
        reset_provider_output_dir(out_dir)
        result = MagicHourClient(token=ctx.magic_hour_api_key).v1.image_to_video.generate(
            assets={"image_file_path": image["path"]},
            end_seconds=float(scene.duration_seconds),
            model=ctx.video_model,
            name=f"{ctx.project_id}-{scene.id}",
            resolution=ctx.resolution,
            style={"prompt": scene.video_prompt},
            audio=ctx.video_audio,
            wait_for_completion=False,
            download_outputs=False,
            download_directory=str(out_dir),
        )
        provider_job_id = getattr(result, "id", None)
        if not provider_job_id:
            raise RuntimeError(f"Magic Hour did not return a video project id for {scene.id}.")
        status = getattr(result, "status", None)
        if status in {"error", "canceled"}:
            raise RuntimeError(f"Magic Hour rejected video job for {scene.id}: {video_status_error(result)}")
        logger.info("Submitted Magic Hour video job %s for scene %s with status %s", provider_job_id, scene.id, status)
        return VideoAssetJob(
            scene=scene,
            image=image,
            out_dir=out_dir,
            provider_job_id=str(provider_job_id),
            prompt=scene.video_prompt,
            model=ctx.video_model,
            resolution=ctx.resolution,
            audio=ctx.video_audio,
            duration_seconds=scene.duration_seconds,
            submitted_status=str(status) if status else None,
        )

    return await asyncio.to_thread(run)


async def poll_video_asset_job(ctx: ProjectContext, job: VideoAssetJob) -> dict[str, Any]:
    """Poll a submitted image-to-video job and download its provider output."""
    client = MagicHourClient(token=ctx.magic_hour_api_key)
    interval = video_poll_interval_seconds()
    timeout = video_poll_timeout_seconds()
    start = time.monotonic()

    while True:
        result = await asyncio.to_thread(client.v1.video_projects.get, id=job.provider_job_id)
        status = getattr(result, "status", None)
        if status == "complete":
            break
        if status in {"error", "canceled"}:
            raise RuntimeError(f"Magic Hour video job failed for {job.scene.id}: {video_status_error(result)}")
        if time.monotonic() - start > timeout:
            raise TimeoutError(
                f"Timed out waiting for Magic Hour video job {job.provider_job_id} "
                f"for {job.scene.id} after {timeout:.0f}s. Last status: {status!r}"
            )
        await asyncio.sleep(interval)

    downloaded = await asyncio.to_thread(ensure_provider_output_downloaded, result, job.out_dir, "video")
    return {
        "scene_id": job.scene.id,
        "path": str(downloaded),
        "prompt": job.prompt,
        "model": job.model,
        "resolution": job.resolution,
        "audio": job.audio,
        "duration_seconds": job.duration_seconds,
        "provider_job_id": job.provider_job_id,
        "provider_url": first_download_url(result),
        "provider_status": getattr(result, "status", None),
    }


async def generate_video_assets_batch(
    ctx: ProjectContext,
    scene_image_pairs: list[tuple[Any, dict[str, Any]]],
) -> list[dict[str, Any] | Exception]:
    """Submit all video jobs first, then poll/download all submitted jobs concurrently."""
    if not scene_image_pairs:
        return []

    submit_results = await asyncio.gather(
        *(submit_video_asset_job(ctx, scene, image) for scene, image in scene_image_pairs),
        return_exceptions=True,
    )
    results: list[dict[str, Any] | Exception | None] = [None] * len(scene_image_pairs)
    poll_tasks = []
    poll_indexes: list[int] = []

    for index, submit_result in enumerate(submit_results):
        if isinstance(submit_result, Exception):
            results[index] = submit_result
            continue
        poll_indexes.append(index)
        poll_tasks.append(poll_video_asset_job(ctx, submit_result))

    if poll_tasks:
        poll_results = await asyncio.gather(*poll_tasks, return_exceptions=True)
        for index, poll_result in zip(poll_indexes, poll_results):
            results[index] = poll_result

    return [result if result is not None else RuntimeError("Video job did not produce a result.") for result in results]


async def _fish_audio_tts(ctx: ProjectContext, text: str, output: Path) -> float:
    """POST text to Fish Audio TTS, write the audio to ``output``, return measured duration.

    Shared by the single-narration voiceover and the per-section voiceover
    generators so both hit the API identically.
    """
    body = ormsgpack.packb(
        {
            "text": text,
            "reference_id": ctx.fish_audio_reference_id,
            "format": ctx.audio_format,
            "chunk_length": 200,
            "latency": "normal",
            "normalize": True,
        }
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    # Parallel per-section requests can trip Fish Audio's rate limit; back off
    # and retry 429s instead of failing the whole generation run.
    async with httpx.AsyncClient(timeout=180) as client:
        for attempt in range(4):
            response = await client.post(
                "https://api.fish.audio/v1/tts",
                headers={
                    "authorization": f"Bearer {ctx.fish_audio_api_key}",
                    "content-type": "application/msgpack",
                    "model": ctx.audio_model,
                },
                content=body,
            )
            if response.status_code == 429 and attempt < 3:
                await asyncio.sleep(2.0 * (attempt + 1))
                continue
            break
        response.raise_for_status()

    if len(response.content) < 1024:
        raise ValueError(
            f"Fish Audio returned suspiciously small response ({len(response.content)} bytes). "
            f"Status: {response.status_code}"
        )

    output.write_bytes(response.content)
    actual_duration = await _run_ffprobe_duration(output)
    if actual_duration < 0.5:
        raise ValueError(f"Fish Audio returned a voiceover with invalid duration {actual_duration:.3f}s.")
    return actual_duration


async def generate_voiceover_asset(ctx: ProjectContext, narration: str, duration_seconds: int) -> dict[str, Any]:
    """Generate a voiceover audio file from narration text via Fish Audio TTS."""
    output = ctx.project_dir / "voiceover" / f"voiceover.{ctx.audio_format}"
    logger.info(
        "Generating voiceover - narration length %d chars, reference_id=%s, model=%s",
        len(narration),
        ctx.fish_audio_reference_id,
        ctx.audio_model,
    )
    actual_duration = await _fish_audio_tts(ctx, narration, output)
    logger.info("Voiceover saved: %s (%.2fs)", output, actual_duration)
    return {
        "path": str(output),
        "model": ctx.audio_model,
        "duration_seconds": round(actual_duration, 3),
        "target_duration_seconds": duration_seconds,
    }


async def generate_section_voiceovers(ctx: ProjectContext, sections: list[Any]) -> list[dict[str, Any]]:
    """Generate one Fish Audio voiceover per section, concurrently.

    Returns a list ordered to match ``sections``, each item::

        {"section": int, "scene_id": str, "path": str, "duration_seconds": float}

    Per-section audio is the source of truth for video alignment: each scene's
    video length is later set to its measured audio duration, so a dropped or
    mis-estimated section can never shift the alignment of the others. Calls run
    in parallel via asyncio.gather, so N short requests finish in roughly the
    same wall-clock as the previous single whole-narration request.
    """
    voiceover_dir = ctx.project_dir / "voiceover" / "sections"
    reset_provider_output_dir(voiceover_dir)

    async def _one(section: Any) -> dict[str, Any]:
        section_num = int(section.section)
        text = str(getattr(section, "dialogue", "") or "").strip()
        if not text:
            raise RuntimeError(f"No dialogue for section {section_num}; cannot generate voiceover.")
        output = voiceover_dir / f"section_{section_num}.{ctx.audio_format}"
        duration = await _fish_audio_tts(ctx, text, output)
        return {
            "section": section_num,
            "scene_id": f"scene_{section_num}",
            "path": str(output.resolve()),
            "duration_seconds": round(duration, 3),
        }

    return list(await asyncio.gather(*(_one(section) for section in sections)))


async def combine_section_voiceovers(ctx: ProjectContext, section_voiceovers: list[dict[str, Any]]) -> dict[str, Any]:
    """Concatenate per-section voiceover audio into one file.

    Preserves the single-voiceover manifest contract (path + duration) consumed
    by the manifest, narration_stats, and TTS calibration, while the per-section
    files remain the source of truth for video alignment.
    """
    if not section_voiceovers:
        raise ValueError("No section voiceovers to combine")
    output = ctx.project_dir / "voiceover" / f"voiceover.{ctx.audio_format}"
    output.parent.mkdir(parents=True, exist_ok=True)
    paths = [Path(item["path"]) for item in section_voiceovers]

    if len(paths) == 1:
        shutil.copyfile(paths[0], output)
    else:
        concat_list = output.parent / "voiceover_concat.txt"
        concat_list.write_text(
            "".join(f"file '{p.resolve()}'\n" for p in paths),
            encoding="utf-8",
        )
        try:
            await _run_ffmpeg(
                [
                    "ffmpeg", "-y",
                    "-f", "concat", "-safe", "0",
                    "-i", str(concat_list.resolve()),
                    "-c", "copy",
                    str(output),
                ],
                "combine section voiceovers ffmpeg",
            )
        finally:
            try:
                concat_list.unlink()
            except OSError:
                pass

    duration = await _run_ffprobe_duration(output)
    return {
        "path": str(output),
        "model": ctx.audio_model,
        "duration_seconds": round(duration, 3),
        "target_duration_seconds": round(sum(item["duration_seconds"] for item in section_voiceovers), 3),
        "sections": section_voiceovers,
    }


def _run_checked(cmd: list[str], label: str) -> None:
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or "no command output"
        raise RuntimeError(f"{label} failed:\n{detail}")


async def _run_ffmpeg(cmd: list[str], label: str) -> None:
    await asyncio.to_thread(_run_checked, cmd, label)


def probe_media_duration(path: str | Path) -> float:
    result = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or "no command output"
        raise RuntimeError(f"ffprobe duration failed for {path}:\n{detail}")
    duration = float(result.stdout.strip())
    if duration <= 0:
        raise ValueError(f"Media has invalid duration {duration}: {path}")
    return duration


async def _run_ffprobe_duration(path: str | Path) -> float:
    return await asyncio.to_thread(probe_media_duration, path)


# ---------------------------------------------------------------------------
# Crossfade duration in seconds for blending between scenes
# ---------------------------------------------------------------------------
CROSSFADE_DURATION = 0.5
MAX_AUDIO_OVERRUN_EXTENSION_SECONDS = 1.0
AUDIO_TRIM_FADE_SECONDS = 0.35


def _format_seconds(seconds: float) -> str:
    return f"{seconds:.3f}"


def planned_final_duration_seconds(videos: list[dict[str, Any]]) -> float | None:
    requested: list[float] = []
    for video in videos:
        try:
            duration = float(video["duration_seconds"])
        except (KeyError, TypeError, ValueError):
            return None
        if duration <= 0:
            return None
        requested.append(duration)
    if not requested:
        return None
    crossfade = min(CROSSFADE_DURATION, min(requested) * 0.4) if len(requested) > 1 else 0.0
    return max(0.1, sum(requested) - crossfade * max(len(requested) - 1, 0))


def _build_xfade_filter(durations: list[float], crossfade: float) -> tuple[str, str]:
    """Build ffmpeg xfade + acrossfade filter graphs for N videos.

    Returns (video_filter, audio_filter) strings.

    The xfade filter chains pairs of inputs sequentially:
      [0:v][1:v] xfade=... [vfade01];
      [vfade01][2:v] xfade=... [vfade012];
      ...
    Same for audio with acrossfade.
    """
    n = len(durations)
    if n < 2:
        raise ValueError("Need at least 2 videos for crossfade")

    v_parts: list[str] = []
    a_parts: list[str] = []

    # Track the cumulative offset where each transition starts.
    # The first transition happens at (duration_0 - crossfade).
    # Each subsequent one accounts for previous crossfades shrinking the timeline.
    offset = durations[0] - crossfade

    for i in range(1, n):
        # Input labels
        if i == 1:
            v_in1 = "[0:v]"
            a_in1 = "[0:a]"
        else:
            v_in1 = f"[vfade{i - 1}]"
            a_in1 = f"[afade{i - 1}]"

        v_in2 = f"[{i}:v]"
        a_in2 = f"[{i}:a]"

        # Output labels
        if i == n - 1:
            v_out = "[vout]"
            a_out = "[aout]"
        else:
            v_out = f"[vfade{i}]"
            a_out = f"[afade{i}]"

        v_parts.append(
            f"{v_in1}{v_in2}xfade=transition=fade:duration={crossfade}:offset={offset:.4f}{v_out}"
        )
        a_parts.append(
            f"{a_in1}{a_in2}acrossfade=d={crossfade}:c1=tri:c2=tri{a_out}"
        )

        # Next offset: add this clip's duration minus one crossfade
        offset += durations[i] - crossfade

    video_filter = ";".join(v_parts)
    audio_filter = ";".join(a_parts)
    return video_filter, audio_filter


def _even(value: int) -> int:
    return value if value % 2 == 0 else value + 1


def target_frame_size(ctx: ProjectContext) -> tuple[int, int]:
    base = int(str(ctx.resolution or "720p").rstrip("p") or "720")
    if ctx.aspect_ratio == "9:16":
        return _even(base), _even(round(base * 16 / 9))
    if ctx.aspect_ratio == "1:1":
        return _even(base), _even(base)
    return _even(round(base * 16 / 9)), _even(base)


async def normalize_scene_video_for_stitch(ctx: ProjectContext, source: str | Path, output: str | Path) -> Path:
    width, height = target_frame_size(ctx)
    output_path = Path(output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    await _run_ffmpeg(
        [
            "ffmpeg", "-y",
            "-i", str(Path(source).resolve()),
            "-vf",
            (
                f"scale={width}:{height}:force_original_aspect_ratio=increase,"
                f"crop={width}:{height},"
                "fps=30,settb=AVTB,setpts=PTS-STARTPTS,format=yuv420p"
            ),
            "-c:v", "libx264", "-preset", "fast",
            "-crf", "18",
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            "-an",
            str(output_path),
        ],
        "normalize scene video for stitch",
    )
    await _run_ffprobe_duration(output_path)
    return output_path


async def stitch_assets(
    ctx: ProjectContext,
    videos: list[dict[str, Any]],
    voiceover: dict[str, Any],
    *,
    target_duration_seconds: float | int | None = None,
) -> str:
    """Stitch scene videos together with smooth crossfade transitions, then overlay voiceover.

    Uses ffmpeg xfade filter for seamless visual blending between scenes
    instead of hard cuts from the concat demuxer.
    """
    final = ctx.project_dir / "final.mp4"
    n = len(videos)
    planned_duration = planned_final_duration_seconds(videos)

    if n == 0:
        raise ValueError("No videos to stitch")

    normalized_dir = ctx.project_dir / "normalized"
    reset_provider_output_dir(normalized_dir)
    normalized_paths = [
        await normalize_scene_video_for_stitch(
            ctx,
            video["path"],
            normalized_dir / f"scene_{index + 1:02d}.mp4",
        )
        for index, video in enumerate(videos)
    ]

    # --- Step 1: Crossfade the scene videos into one seamless clip ---
    merged = ctx.project_dir / "merged.mp4"

    if n == 1:
        shutil.copyfile(normalized_paths[0], merged)
    else:
        # Probe actual durations for accurate xfade offsets
        durations = [await _run_ffprobe_duration(path) for path in normalized_paths]
        logger.info("Scene durations for crossfade: %s", durations)

        # Build input args
        input_args: list[str] = []
        for path in normalized_paths:
            input_args.extend(["-i", str(path.resolve())])

        # Build video xfade chain
        crossfade = min(CROSSFADE_DURATION, min(durations) * 0.4)
        video_filter, _ = _build_xfade_filter(durations, crossfade)

        # We don't use acrossfade on source audio since scenes have no audio;
        # instead just output the xfaded video
        filter_complex = video_filter

        cmd = [
            "ffmpeg", "-y",
            *input_args,
            "-filter_complex", filter_complex,
            "-map", "[vout]",
            "-c:v", "libx264", "-preset", "fast",
            "-crf", "18",
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            "-an",
            str(merged),
        ]
        logger.info("Crossfade ffmpeg command: %s", " ".join(cmd))
        await _run_ffmpeg(cmd, "crossfade ffmpeg stitch")

    merged_duration = await _run_ffprobe_duration(merged)
    voiceover_duration = await _run_ffprobe_duration(voiceover["path"])
    if planned_duration is None:
        planned_duration = merged_duration
    if target_duration_seconds is not None:
        output_duration = float(target_duration_seconds)
    elif voiceover_duration > planned_duration and voiceover_duration - planned_duration <= MAX_AUDIO_OVERRUN_EXTENSION_SECONDS:
        output_duration = voiceover_duration
    else:
        output_duration = planned_duration
    output_duration = max(0.1, output_duration)
    pad_duration = max(0.0, output_duration - merged_duration)
    audio_filter = "apad"
    if voiceover_duration > output_duration:
        fade_duration = min(AUDIO_TRIM_FADE_SECONDS, output_duration / 2)
        fade_start = max(0.0, output_duration - fade_duration)
        audio_filter = (
            f"atrim=0:{_format_seconds(output_duration)},"
            "asetpts=PTS-STARTPTS,"
            f"afade=t=out:st={_format_seconds(fade_start)}:d={_format_seconds(fade_duration)},"
            "apad"
        )
        logger.info(
            "Trimming voiceover %.3fs to stitched video target %.3fs with fade-out for %s",
            voiceover_duration,
            output_duration,
            ctx.project_id,
        )
    timed = ctx.project_dir / "merged_timed.mp4"
    await _run_ffmpeg(
        [
            "ffmpeg", "-y",
            "-i", str(merged),
            "-vf", (
                "tpad=stop_mode=clone:"
                f"stop_duration={_format_seconds(pad_duration)},"
                f"trim=duration={_format_seconds(output_duration)},setpts=PTS-STARTPTS"
            ),
            "-c:v", "libx264", "-preset", "fast",
            "-crf", "18",
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            "-an",
            str(timed),
        ],
        "target-duration ffmpeg normalize",
    )

    # --- Step 2: Overlay voiceover audio onto the merged video ---
    await _run_ffmpeg(
        [
            "ffmpeg", "-y",
            "-i", str(timed),
            "-i", voiceover["path"],
            "-map", "0:v:0",
            "-map", "1:a:0",
            "-c:v", "copy",
            "-af", audio_filter,
            "-c:a", "aac", "-b:a", "192k",
            "-t", _format_seconds(output_duration),
            "-movflags", "+faststart",
            str(final),
        ],
        "voiceover mux ffmpeg",
    )

    for intermediate in (merged, timed):
        try:
            intermediate.unlink()
        except OSError:
            pass

    logger.info("Final video saved: %s", final)
    return str(final)


async def _mux_section(
    ctx: ProjectContext,
    normalized_video: Path,
    audio_path: str,
    audio_duration: float,
    output: Path,
) -> Path:
    """Mux one normalized (silent) scene video with its section audio.

    The output is clamped to exactly ``audio_duration``: if the video is
    shorter the last frame is frozen (tpad=stop_mode=clone); if longer it is
    trimmed. This makes each section self-contained — its video length equals
    its spoken length — so section boundaries are exact and concatenation can
    never drift audio out of sync with footage.
    """
    video_duration = await _run_ffprobe_duration(normalized_video)
    pad_duration = max(0.0, audio_duration - video_duration)
    await _run_ffmpeg(
        [
            "ffmpeg", "-y",
            "-i", str(normalized_video.resolve()),
            "-i", str(Path(audio_path).resolve()),
            "-vf", (
                "tpad=stop_mode=clone:"
                f"stop_duration={_format_seconds(pad_duration)},"
                f"trim=duration={_format_seconds(audio_duration)},setpts=PTS-STARTPTS"
            ),
            "-map", "0:v:0",
            "-map", "1:a:0",
            "-c:v", "libx264", "-preset", "fast",
            "-crf", "18",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
            "-t", _format_seconds(audio_duration),
            "-movflags", "+faststart",
            str(output),
        ],
        "per-section mux ffmpeg",
    )
    return output


async def stitch_assets_per_section(
    ctx: ProjectContext,
    scenes: list[dict[str, Any]],
) -> str:
    """Stitch scenes where each carries its own audio, then hard-cut concat.

    ``scenes`` items must contain::

        {"video_path": str, "audio_path": str, "audio_duration_seconds": float}

    Each scene's video is normalized, then muxed with its own section audio and
    clamped to that audio's duration. The per-section MP4s are concatenated with
    the concat demuxer (hard cuts). Because every section's video length equals
    its measured spoken length and each carries its own audio, audio and video
    stay locked together regardless of duration estimates or dropped sections.
    """
    n = len(scenes)
    if n == 0:
        raise ValueError("No scenes to stitch")

    final = ctx.project_dir / "final.mp4"
    normalized_dir = ctx.project_dir / "normalized"
    reset_provider_output_dir(normalized_dir)
    sections_dir = ctx.project_dir / "muxed_sections"
    reset_provider_output_dir(sections_dir)

    muxed_paths: list[Path] = []
    for index, scene in enumerate(scenes):
        normalized = await normalize_scene_video_for_stitch(
            ctx,
            scene["video_path"],
            normalized_dir / f"scene_{index + 1:02d}.mp4",
        )
        muxed = await _mux_section(
            ctx,
            normalized,
            scene["audio_path"],
            float(scene["audio_duration_seconds"]),
            sections_dir / f"scene_{index + 1:02d}.mp4",
        )
        muxed_paths.append(muxed)

    if n == 1:
        shutil.copyfile(muxed_paths[0], final)
    else:
        concat_list = ctx.project_dir / "sections_concat.txt"
        concat_list.write_text(
            "".join(f"file '{p.resolve()}'\n" for p in muxed_paths),
            encoding="utf-8",
        )
        try:
            await _run_ffmpeg(
                [
                    "ffmpeg", "-y",
                    "-f", "concat", "-safe", "0",
                    "-i", str(concat_list.resolve()),
                    "-c:v", "libx264", "-preset", "fast",
                    "-crf", "18",
                    "-pix_fmt", "yuv420p",
                    "-r", "30",
                    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
                    "-movflags", "+faststart",
                    str(final),
                ],
                "per-section concat ffmpeg",
            )
        finally:
            try:
                concat_list.unlink()
            except OSError:
                pass

    logger.info("Final video saved (per-section): %s", final)
    return str(final)
