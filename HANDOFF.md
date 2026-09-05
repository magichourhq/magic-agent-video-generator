# Magic Agent Engineering Handoff

This document describes the current local application, its runtime contracts,
credential handling, architecture, known limitations, and verification process.
It is written for an engineer receiving the repository without prior chat
history.

## Current Scope

Magic Agent accepts a natural-language request and optional image or audio
inputs, decides whether it needs clarification, builds a structured creative
plan, generates media, and assembles a final output. The primary workflow is a
multi-scene video pipeline. Standalone image generation, YouTube source-clip
assembly, project follow-up edits, and timeline edits are also represented.

The application is local-first. It is not yet a multi-tenant production
service. The current source of truth is the TypeScript implementation under
`server/` and `frontend/`; the former Python backend has been removed.

## Effective Defaults

There are two entry paths with different default sources:

1. The browser UI explicitly submits these defaults:
   - agent provider: `openrouter`
   - agent model: `deepseek/deepseek-v4-pro`
   - agent intensity: `max`
   - image model: `nano-banana-2-lite`
   - video model: `auto` (resolved by the server)
   - audio provider: `elevenlabs`
   - ElevenLabs voice name: `brielle - podcast girl`
2. A direct API request that omits provider fields uses environment values,
   then server defaults. Without an `.env`, those defaults are OpenAI
   `gpt-5.4`, Hume `octave-1`, Nano Banana 2 Lite, and MiniMax H3.

For a consistent handoff environment, copy `.env.example` and use its explicit
OpenRouter/DeepSeek and ElevenLabs defaults. Request fields sent by the UI take
precedence over environment defaults for that project.

## Credential Contract

Never commit real credentials. The repository ignores `.env`, generated
outputs, logs, frontend build output, and dependencies.

Required for the recommended generated-video path:

| Setting | Purpose | Requirement |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | DeepSeek planning through OpenRouter | Required when `AGENT_MODEL_PROVIDER=openrouter` |
| `MAGIC_HOUR_API_KEY` | Image and video provider operations | Required for generated media |
| `ELEVENLABS_API_KEY` | Narration and per-scene speech | Required when `AUDIO_PROVIDER=elevenlabs` |

Provider alternatives:

| Setting | Purpose | Requirement |
| --- | --- | --- |
| `OPENAI_API_KEY` | OpenAI agent runtime | Required when `AGENT_MODEL_PROVIDER=openai` |
| `HUME_API_KEY` | Hume Octave speech | Required when `AUDIO_PROVIDER=hume` |
| `FISH_AUDIO_API_KEY` | Fish Audio speech | Required when `AUDIO_PROVIDER=fish` |
| `FISH_AUDIO_REFERENCE_ID` | Fish Audio voice identity | Required when `AUDIO_PROVIDER=fish` |

YouTube workflow settings:

| Setting | Purpose | Requirement |
| --- | --- | --- |
| `YOUTUBE_API_KEY` or numbered aliases | YouTube Data API search | Required for YouTube clip search |
| `YOUTUBE_API_KEY_ALIASES` | Custom ordered key names | Optional |
| `OPENAI_API_KEY` | YouTube VLM verification and subagents | Optional but currently required to enable those quality stages |
| `YT_DLP_PATH` | Custom `yt-dlp` executable | Optional if `yt-dlp` is on `PATH` |

### Credential Precedence

1. Per-request `runtime_credentials`
2. Project credentials retained in the server process for follow-up turns
3. Process environment
4. Project-local `.env`

Environment variables override values loaded from `.env`. Request credentials
are retained only in an in-memory map. Project JSON stores boolean credential
availability, not secret values. A backend restart therefore loses
request-supplied credentials and follow-up edits require the client to send
them again.

The browser holds entered keys in component memory and sends them to the local
backend. A production deployment must use TLS and server-side secret storage;
it must not rely on users submitting long-lived provider credentials from the
browser.

## Architecture

### Entry And Transport

- `server/src/index.ts`: Fastify server, REST endpoints, SSE events, static
  media serving, request validation, and local CORS policy.
- `frontend/app/page.tsx`: project selection, project creation, follow-up
  messages, timeline edits, and YouTube review mode.
- `frontend/components/chat-workspace.tsx`: prompt composer, input uploads,
  project queue, artifact canvas, progress, activity, and editable timeline.
- `frontend/hooks/use-project.ts`: React Query mutations and status fallback
  polling.
- `frontend/hooks/use-project-events.ts`: live project status over SSE.

### Request Lifecycle

1. The UI uploads optional image/audio inputs to `POST /api/input-media`.
2. The UI submits `POST /api/projects` with the prompt, media references,
   generation settings, provider choices, and transient credentials.
3. `CreateProjectRequestSchema` validates the wire contract.
4. `classifyMagicHourRequest` chooses an implemented capability or returns
   clarification before paid provider work.
5. `queueProject` creates an isolated project directory and queues the run.
6. `runProject` creates the project context, builds the agent brief, executes
   the selected SDK/OpenRouter runtime, and persists token accounting.
7. A valid plan proceeds through voice, image, video, timeline, and stitch
   stages. A plan that fails deterministic validation cannot start paid visual
   generation.
8. Status and activity events are published to the frontend throughout the
   run.
9. The final manifest points to the generated MP4 or standalone image.

### Decision And Planning Layer

- `server/src/magicHourCapabilities.ts` performs request-level capability
  routing and minimum-information checks.
- `server/src/clarificationSlots.ts` identifies missing details for ambiguous
  requests.
- `server/src/creativeDecision.ts` infers format, platform, goal, speech mode,
  pacing, required beats, and creative intent.
- `server/src/prompts.ts` compiles generation constraints, duration and speech
  budgets, prompt interpretation, and the planning brief.
- `server/src/planReadiness.ts` verifies that the plan is complete enough to
  start paid work.
- `server/src/sceneContinuity.ts` validates chronology, physical state,
  recurring subjects, setting, screen direction, style, and scene handoffs.
- `server/src/sceneAudio.ts` validates spoken coverage, narration segmentation,
  and scene/audio alignment.
- `server/src/audioPerformance.ts` maps compact scene audio modes to safe
  provider performance settings.

The agent chooses creative content inside bounded schemas. Deterministic
validators own provider safety, duration limits, unsupported combinations,
speech/visual separation, and continuity requirements.

### Agent Runtime

- `server/src/agents.ts` defines agent tools and their Zod schemas.
- `server/src/agentRuntime.ts` selects OpenAI Responses or OpenRouter Chat
  Completions compatibility mode and configures model settings.
- `server/src/runners.ts` streams agent events, limits planning attempts,
  executes deterministic completion when an accepted plan exists, and records
  terminal status.
- `server/src/usageCost.ts` records agent token usage and estimated language
  model cost. It does not include media-provider cost.

The OpenAI runtime uses the Agents SDK Responses integration. OpenRouter uses
the SDK with an OpenAI-compatible Chat Completions provider and a flat tool
surface. Hosted OpenAI web search is not available in OpenRouter compatibility
mode.

### Media Pipeline

- `server/src/media.ts` contains Magic Hour requests, Hume/Fish/ElevenLabs TTS,
  provider polling/recovery, local media probes, FFmpeg normalization, and
  final assembly.
- `server/src/workflows.ts` provides the agent-facing workflow operations and
  artifact transitions.
- `server/src/timeline.ts` builds and validates the editable timeline.
- `server/src/mediaSync.ts` provides synchronous probing required during prompt
  preparation.
- `server/src/voices.ts` contains voice selection metadata and defaults.

Typical generated-video sequence:

```text
classify request
  -> compile creative brief
  -> draft and validate VideoPlan
  -> generate voiceover/per-scene speech
  -> generate scene keyframes
  -> animate scene videos
  -> recover submitted jobs where possible
  -> build/validate timeline
  -> normalize clips and hard-cut with FFmpeg
  -> mux voice/native audio
  -> verify duration and write manifest
```

Successful provider jobs are reused where possible. User-requested edits are
separate operations and may invalidate only the affected downstream artifacts.

### YouTube Workflow

- `server/src/youtubeShort.ts` handles search, key rotation, candidate
  metadata, transcript windows, visual rejection, downloads, and clip records.
- `server/src/youtubeSubagents.ts` optionally ranks and evaluates candidates.
- `server/src/prompts.ts` creates YouTube script/search guidance.

The YouTube path requires `yt-dlp` in addition to FFmpeg. YouTube review mode
uses `evals/youtube_workflow_eval_prompts.jsonl`, which is currently ignored by
Git and must be supplied separately or moved into a tracked location.

### State And Isolation

Every project has a unique directory under `outputs/<project_id>/`. Important
artifacts include:

```text
status.json
project_state.json
plan.json
voiceover.json
images.json
videos.json
timeline.json
failed_scenes.json
token_output.json
manifest.json
final.mp4
```

`server/src/renderState.ts` owns artifact reads/writes. The project scheduler
and provider limiters bound local concurrency. Project paths isolate artifacts,
but the scheduler, credential map, and active project registry are process
memory and are not shared across backend instances.

## Edit Contract

Follow-up messages use the existing project state. The agent can inspect the
render, revise narration, replace voiceover, regenerate or retry a scene, trim
or move timeline clips, set a final hold, and restitch. Successful unrelated
scene outputs should be preserved. Subjective engagement fixes are not
automatically re-rendered after a successful first generation.

## Known Limitations

### Production-Critical

1. **No authentication or tenant authorization.** Project IDs and media URLs
   are not protected by user ownership checks.
2. **Local static media exposure.** Fastify serves the entire output directory
   under `/media/`. Production needs authenticated object storage and signed
   URLs.
3. **Non-durable scheduling.** Queued and active jobs live in process memory.
   Restarting the server loses the queue and active registry.
4. **Non-durable request credentials.** Per-request keys are remembered only in
   memory and disappear on restart.
5. **Filesystem state is not transactional.** JSON artifact writes are local
   and there is no database transaction, distributed lock, or multi-instance
   coordination.
6. **No idempotency keys.** Repeating a project-creation request can create a
   second paid generation.
7. **No cancellation API.** Users cannot cancel queued or active provider work
   through the product.
8. **No user-level quotas or rate limiting.** Concurrency limits protect one
   process, not accounts or a deployment fleet.
9. **Provider cost is incomplete.** Token reports exclude Magic Hour and audio
   provider charges.
10. **Deployment secrets are not centralized.** The local browser-entry model
    is not appropriate for shared production infrastructure.

### Reliability And Operations

1. Provider recovery is bounded and cannot guarantee completion during an
   upstream outage, rejected prompt, exhausted credit balance, or permanently
   failed job.
2. Progress percentages represent workflow stages and known provider progress;
   they are not an exact cross-provider completion measurement.
3. Partial renders can be returned when scene generation fails. Consumers must
   inspect `failed_scene_count` and `render_status`, not only HTTP success.
4. Generated outputs have no retention policy and can fill local disk.
5. There is no centralized metrics, tracing backend, alerting, or dead-letter
   queue. Logs are local files/stdout.
6. Health checks validate FFmpeg and FFprobe, but do not currently require
   `yt-dlp` or a YouTube API key before accepting a YouTube workflow.
7. The review-batch fixture path points to an ignored file, so review mode is
   incomplete in a clean clone unless that file is supplied.
8. Paid-provider behavior is mostly mocked in automated tests. A real smoke
   generation remains a separate, credentialed acceptance test.

### Product And Quality

1. The Magic Hour capability catalog includes recognized tools whose backend
   wrappers remain `planned`. Those requests stop for input instead of making
   an unsafe provider call.
2. The deterministic fallback plan supports a conservative subset of
   UGC/product requests, not every cinematic or editing format.
3. Output quality remains probabilistic even when continuity and prompt
   validation pass. The system intentionally avoids an expensive automatic
   post-render subjective QA/re-render loop.
4. Voice-name lookup depends on provider account permissions. A fixed voice ID
   is more reliable than a name when list-voices permission is unavailable.
5. The pre-submit frontend clarification card is currently unreachable. The
   active behavior is backend classification followed by a text question and a
   normal follow-up message.
6. Model availability, accepted parameters, and provider duration limits may
   change independently of this repository.

## Production Migration Direction

Before multi-user deployment, replace the in-process scheduler and local JSON
state with a durable queue and database. Store generated media in object
storage, add authenticated tenancy and signed URLs, use a managed secret store,
add request idempotency and cancellation, and emit structured metrics/traces.
Workers should claim project-scoped jobs with leases so one failed worker can
resume from persisted provider job IDs without regenerating completed scenes.

## Local Verification

Prerequisites:

```text
Node.js 20.5+ (or 18.18+)
npm
ffmpeg
ffprobe
yt-dlp for YouTube workflows
```

Deterministic verification:

```bash
cd server
npm test
npm run typecheck

cd ../frontend
npm run build
```

Strict unused-code audit:

```bash
cd server
./node_modules/.bin/tsc --noEmit --noUnusedLocals true --noUnusedParameters true

cd ../frontend
./node_modules/.bin/tsc --noEmit --noUnusedLocals true --noUnusedParameters true
```

Launch:

```bash
./dev.sh
```

Then verify `GET http://localhost:8000/api/health`, create a project in the UI,
observe SSE progress, inspect all project artifacts, and confirm `final.mp4`
contains video and the expected audio stream.

## Handoff Acceptance Checklist

- [ ] The working tree is committed to a named handoff branch.
- [ ] The commit/tag used for handoff is recorded.
- [ ] No credential patterns are present in tracked files or Git history.
- [ ] `.env` remains ignored and contains no placeholder that resembles a real key.
- [ ] Server tests pass.
- [ ] Server strict type checking passes.
- [ ] Frontend production build passes.
- [ ] Frontend strict unused-code checking passes or each exception is documented.
- [ ] A clean-clone install succeeds with the documented Node version.
- [ ] A no-credit local API smoke test succeeds.
- [ ] A separately authorized paid generation succeeds for the recommended provider path.
- [ ] The YouTube review prompt set is included or review mode is explicitly excluded.
- [ ] Known production limitations are accepted by the receiving engineer.

## Verification Record

Verification date: 2026-09-02 (America/Toronto)

Repository state:

- Branch: `main`
- Remote: `origin` points to `sarptandoven/magic-agent-video-generator`
- The worktree contains substantial uncommitted application changes and
  deletions. This verification applies to the worktree, not only to `HEAD`.
- No commit or tag was created as part of this handoff preparation.

Results:

| Check | Result | Detail |
| --- | --- | --- |
| Recognized secret patterns in tracked files | PASS | No OpenAI/OpenRouter, ElevenLabs-style, Magic Hour, or GitHub token pattern found |
| Recognized secret patterns in Git history | PASS | No matching commit found across all refs |
| Recognized secret patterns in JSON/text/log outputs | PASS | No matching file under `outputs/` or `.run-logs/` |
| Local root `.env` | PASS | Absent; `.env` is ignored |
| Server tests | PASS | 30 files, 510 tests |
| Server typecheck | PASS | `npm run typecheck` |
| Server strict unused check | PASS | `tsc --noEmit --noUnusedLocals true --noUnusedParameters true` |
| Frontend production build | PASS | Next.js optimized build completed successfully |
| Frontend production serve | PASS | `/` returned HTTP 200 from the temporary production server |
| Frontend strict unused check | EXCEPTION | One unused `buildClarifyingQuestions` import in `chat-workspace.tsx`; normal production build passes |
| Server lockfile dry run | PASS | `npm ci --dry-run --ignore-scripts` resolved successfully |
| Frontend lockfile dry run | PASS | `npm ci --dry-run --ignore-scripts` resolved successfully |
| Diff whitespace validation | PASS | `git diff --check` |
| FFmpeg and FFprobe | PASS | Both commands are installed |
| `yt-dlp` | BLOCKED | Not installed on the verification host |
| YouTube review prompt set | PARTIAL | Present locally but ignored by Git |
| No-credit backend HTTP smoke | PASS | Health, queueing, persistence, clarification, and polling succeeded |
| Paid provider generation | NOT RUN | No local provider credentials were configured; this verification intentionally spent no credits |

The backend smoke used the deliberately vague prompt `make me stuff`. It was
accepted with HTTP 202, moved from `queued` to `succeeded/needs_input`, and
returned the clarification `Do you want an image, a video, or an edit of
uploaded media?` without attempting a provider call.

Before an actual handoff, the remaining acceptance work is to commit the exact
worktree on a named branch, install and verify `yt-dlp`, track or relocate the
YouTube review prompt set, decide whether to connect or remove the unreachable
frontend clarification-card path, and run one separately authorized paid
generation using the recommended provider configuration.
