# Local Video Composer

Production-shaped local workflow for turning one prompt into a finished MP4 with an OpenAI Agents SDK art-director runtime, Magic Hour image/video generation, Fish/Hume/ElevenLabs voiceover, and ffmpeg stitching.

This project is intentionally local-first. It has bounded in-process queues and provider recovery, but not a durable distributed queue, database, object storage, authentication, or cloud deployment layer. The local experience includes configuration checks, live streamed render status, deterministic output folders, direct ffmpeg errors, and a browser workspace.

See [`HANDOFF.md`](HANDOFF.md) for the effective runtime defaults, credential contract, architecture, known limitations, production migration direction, and verification record.

The backend is TypeScript end to end: a Fastify server built on the `@openai/agents` SDK.

## Structure

```text
server/src/index.ts          Fastify app: REST API, SSE event stream, media serving
server/src/agents.ts         Agent + tool definitions (@openai/agents, Zod schemas)
server/src/workflows.ts      Video plan, voiceover, image/video, and stitch workflows
server/src/youtubeShort.ts   YouTube search, ranking, transcripts, yt-dlp clip pipeline
server/src/media.ts          Magic Hour, Fish/Hume audio, and ffmpeg provider primitives
server/src/renderState.ts    JSON artifact and scene retry state helpers
server/src/prompts.ts        Prompt building, duration heuristics, search-query shaping
server/src/runners.ts        Streamed agent runs that publish live project events
server/tests/                Vitest contract tests for the ported pure logic
frontend/app/page.tsx        Composer + review workspace shell
frontend/components/         Chat workspace, scene timeline, live activity feed
dev.sh                       One-command local launcher
```

## Agent Design

The OpenAI agent owns the creative loop and render decisions. The server exposes a small `video_studio` namespace of bounded tools for safe provider calls, artifact writes, status inspection, retries, and stitching.

```ts
const videoAgent = new Agent({
  name: "Autonomous Video Art Director",
  tools: [...VIDEO_STUDIO_TOOLS, toolSearchTool()],
});
```

The agent moves through explicit production steps:

```text
draft_video_plan -> generate_voiceover
                 -> generate_scene_images -> animate_scene_videos
                 -> inspect_render_status / record_project_decision / retry_scene
                 -> stitch_final_video

After inspection:
regenerate_scene / revise_narration / replace_voiceover -> restitch_video
```

The provider primitives live in `server/src/media.ts`; the agent-facing tools wrap them in small, readable artifact steps. The tool schemas describe the visual contract directly: `image_prompt` is a stable cinematic keyframe, while `video_prompt` animates only what already exists in that keyframe. The agent also chooses Magic Hour image and image-to-video models when calling the media tools.

Persistent project memory lives in `project_state.json`, not in process memory, so the agent can inspect the current plan, scene assets, failures, user preferences, and recorded decisions across tool calls or backend restarts.

## Workflow

1. `POST /api/projects` validates local configuration and starts a render job.
2. The frontend subscribes to `GET /api/projects/{project_id}/events` (SSE) for live agent activity, and refreshes `GET /api/projects/{project_id}` when status events arrive.
3. The agent drafts and saves the creative plan.
4. Selected TTS voiceover and Magic Hour image generation run as separate bounded tool calls.
5. Magic Hour image-to-video runs for completed images, with scene-level retries available.
6. The agent records important creative/retry choices into project memory.
7. The agent inspects status, retries failed scenes if useful, then asks ffmpeg to stitch `final.mp4`.
8. After inspecting the output, the agent can patch one part with `regenerate_scene`, `revise_narration`, or `replace_voiceover`, then verify by calling `restitch_video`.
9. `POST /api/projects/{project_id}/messages` queues a follow-up agent turn against the existing project state.

If one scene video fails, the renderer stitches the successful scene videos into a marked partial MP4 instead of leaving you with no video.

Generated assets are written under:

```text
outputs/<project_id>/plan.json
outputs/<project_id>/status.json
outputs/<project_id>/project_state.json
outputs/<project_id>/manifest.json
outputs/<project_id>/images.json
outputs/<project_id>/videos.json
outputs/<project_id>/voiceover.json
outputs/<project_id>/images/<scene_id>/output-*.jpg
outputs/<project_id>/videos/<scene_id>/output-*.mp4
outputs/<project_id>/voiceover/voiceover.mp3
outputs/<project_id>/token_output.json
outputs/<project_id>/final.mp4
```

`token_output.json` records only the OpenAI agent run token usage and estimated OpenAI token cost. Magic Hour, Fish/Hume audio, and ffmpeg costs are not included.

## Setup

Copy `.env.example` to a project-local `.env`, or provide credentials in the browser settings drawer. Process environment variables override project-local values. Request settings submitted by the browser override provider/model defaults for that project.
The browser settings drawer can also provide OpenAI, OpenRouter, Magic Hour, Fish Audio, Hume, and ElevenLabs keys per run. Request-supplied keys are kept transient and are not written into project state.

Required values:

```bash
OPENAI_API_KEY=
MAGIC_HOUR_API_KEY=
HUME_API_KEY=            # required by default; Hume is the default AUDIO_PROVIDER
FISH_AUDIO_API_KEY=      # required only when AUDIO_PROVIDER=fish
FISH_AUDIO_REFERENCE_ID= # required only when AUDIO_PROVIDER=fish
ELEVENLABS_API_KEY=      # required only when AUDIO_PROVIDER=elevenlabs
```

Useful defaults:

```bash
AGENT_MODEL_PROVIDER=openrouter
OPENROUTER_MODEL=deepseek/deepseek-v4-pro
OPENROUTER_MAX_TOKENS=12000
OPENAI_REASONING_EFFORT=low
OPENAI_VERBOSITY=low
AGENT_MODEL_INTENSITY=max
OUTPUT_DIR=outputs
MAGIC_HOUR_IMAGE_MODEL=nano-banana-2-lite
MAGIC_HOUR_IMAGE_RESOLUTION=1k
MAGIC_HOUR_IMAGE_STYLE_TOOL=general
MAGIC_HOUR_VIDEO_MODEL=minimax-h3
MAGIC_HOUR_VIDEO_AUDIO=false
AUDIO_PROVIDER=elevenlabs
FISH_AUDIO_MODEL=s2.1-pro
FISH_AUDIO_FORMAT=mp3
HUME_AUDIO_MODEL=octave-1
HUME_VOICE_DESCRIPTION=
HUME_VOICE_ID=
HUME_VOICE_NAME=
ELEVENLABS_AUDIO_MODEL=eleven_multilingual_v2
ELEVENLABS_VOICE_ID=    # preferred when the API key cannot list voices
ELEVENLABS_VOICE_NAME=brielle - podcast girl
```

ElevenLabs voice-name lookup uses the account voice list. If the API key lacks `voices_read`, paste the exact `ELEVENLABS_VOICE_ID` in the UI or environment.

Optional OpenRouter runtime:

```bash
AGENT_MODEL_PROVIDER=openrouter
OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_MODEL=openai/gpt-5.4
OPENROUTER_SITE_URL=http://localhost:3000
OPENROUTER_APP_NAME=Magic Agent
```

OpenRouter runs use the SDK's Chat Completions-compatible provider with a flat first-render/edit tool surface. The default OpenAI runtime keeps the Responses API namespace/deferred-tool setup.

Required local commands:

```bash
node   # 20.5+ (or 18.18+)
npm
ffmpeg
ffprobe
curl
yt-dlp # only for the YouTube clips workflow
```

## Run

```bash
./dev.sh
```

URLs:

- Frontend: `http://localhost:3000`
- Backend: `http://localhost:8000`
- Backend log: `.run-logs/backend.log`
- Frontend log: `.run-logs/frontend.log`

`dev.sh` binds both servers to `127.0.0.1` by default. Override `BACKEND_HOST`, `BACKEND_PORT`, `FRONTEND_HOST`, or `FRONTEND_PORT` in `.env` if needed.

## Verify

```bash
cd server && npm test && npm run typecheck
cd frontend && npm run build
```

## API

Start a project:

```bash
curl -sS http://localhost:8000/api/projects \
  -H 'content-type: application/json' \
  -d '{
    "prompt": "A cinematic launch video for a compact AI camera",
    "duration_seconds": 20,
    "scene_count": 4,
    "aspect_ratio": "9:16",
    "resolution": "720p"
  }'
```

Poll the returned `status_url` until `status` is `succeeded` or `failed`, or subscribe to the live stream:

```bash
curl -N http://localhost:8000/api/projects/<project_id>/events
```

The stream sends `status` events (stage, progress, message) and `agent_event` events (tool calls, tool outputs, agent messages, reasoning summaries) as the run progresses.

Send a follow-up message to the agent for an existing project:

```bash
curl -sS http://localhost:8000/api/projects/<project_id>/messages \
  -H 'content-type: application/json' \
  -d '{
    "message": "Scene 2 feels flat. Make the lighting more dramatic and restitch."
  }'
```

The message endpoint appends the user message to `project_state.json`, queues an agent turn, and returns the same pollable project status shape. The agent receives the current project state and can inspect, patch, regenerate, or restitch through the bounded `video_studio` tools.
