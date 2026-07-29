# YouTube Workflow Failures, Fixes, and Production Gaps

Date: 2026-06-09
Branch: evals
Scope: `youtube_clips` workflow only.

## Current Workflow Surface

The YouTube workflow takes a user prompt, drafts a multi-scene story/script, derives per-scene YouTube search hints, searches YouTube through either the YouTube Data API or yt-dlp, selects a clip/window per scene, generates voiceover, and stitches the final video with ffmpeg.

The `evals` branch also has a headless eval surface for comparing providers. The eval runner can take a JSONL prompt set, run each prompt through both `youtube_data_api` and `yt_dlp`, and write provider-level and scene-level artifacts such as selected candidates, failures, search attempts, transcript/window metadata, contact sheets, and timing.

## Failures Observed

### 1. Search recall failure

yt-dlp search has repeatedly produced weaker candidate pools than the YouTube Data API. In earlier deep-sea and ancient-coin tests, the correct visual material was either absent from the yt-dlp pool or buried below irrelevant candidates. Hydrating top results improved metadata, but it did not consistently solve relevance.

This is the main quality failure: the downstream selector can only choose from what search returns.

### 2. Transcript-window failure

Some good scene ideas are visual rather than spoken. For example, hints like "backstage Apple secrecy" or "audience reaction" may describe footage that does not appear in captions. In those cases transcript-aligned window selection can fail even when the broader video is usable.

Missing captions, bad auto-captions, and non-dialogue b-roll make this worse.

### 3. False-positive transcript match

Matching transcript text alone is not enough. A candidate can mention the right entity or phrase while showing the wrong source, wrong event, wrong year, wrong product, or a commentary overlay.

This showed up in OpenAI, Steve Jobs/iPhone, Saquon Barkley, ancient-coins, and deep-sea prompts.

### 4. Entity and source mismatch

The workflow has selected videos that are semantically adjacent but wrong for the scene:

- OpenAI scenes got generic AI tutorials, low-authority hype videos, or wrong-model coverage.
- Steve Jobs/iPhone scenes got generic keynote footage, memorial material, or modern iPhone videos.
- Saquon scenes got commentary, interviews, news recaps, or unrelated sports clips instead of game action.
- Ancient-coin scenes got modern coins, mining/clickbait artifacts, or non-coin archaeology.
- Deep-sea scenes got explainers, stock footage, myths, or generic shorts instead of research-aligned footage.

These are not download failures. They are ranking and acceptance failures.

### 5. Audio/video alignment failure

Before per-section voiceover, the workflow used global voiceover duration estimates and scene trimming. Crossfades and duration estimation could make the audio drift from the visible b-roll. This caused the user-visible problem where the narration and the current frame did not overlap well.

### 6. Provider and runtime failures

Operational failures still happen:

- Missing, invalid, or quota-exhausted YouTube Data API keys.
- yt-dlp search, hydration, transcript, or download failures.
- Empty candidate pools.
- Videos without usable captions.
- ffprobe/ffmpeg failures.
- Fish TTS or voiceover generation failures.

These failures need to be visible in artifacts instead of being hidden behind random fallback footage.

## Fixes and Guards Already Landed

### Provider control

The workflow now exposes provider selection so a run can explicitly use `youtube_data_api` or `yt_dlp`. The eval payload can disable provider fallback, which is important for fair benchmarking.

### Headless eval runner

`scripts/run_youtube_workflow_evals.py` can run prompt batches headlessly across both providers. It records project IDs, provider used, scene failures, search attempts, selected windows, timing, and contact-sheet paths.

This is the right surface for batch generation and post-run analysis.

### Per-section voiceover

The YouTube workflow now supports per-section voiceover generation and per-section stitching. Each scene can be locked to its own measured voiceover duration before final concatenation.

This directly addresses the earlier audio/video drift caused by global narration timing.

### Fail-loud clip selection

The workflow no longer treats a random clip window as an acceptable substitute when transcript or visual alignment is missing. Weak visual fallbacks are rejected instead of silently becoming completed scenes.

This means bad matches should now either fail loudly or become partials instead of being hidden as successful scenes.

### Metadata and mismatch guards

The branch has tests for rejecting common wrong-match classes across several benchmark domains:

- OpenAI model/source/product mismatch.
- Generic AI tutorials and low-authority OpenAI coverage.
- Unofficial or irrelevant OpenAI source material when an official/reputable source is required.
- Generic or wrong-year Steve Jobs/iPhone footage.
- Modern or non-ancient coin footage.
- Saquon interviews, commentary, news recaps, reaction overlays, and unrelated sports clips.
- Generic deep-sea explainers, stock footage, myth clips, and weak research-review footage.

These guards are useful, but they are still a patch over ranking weakness.

### Better Data API metadata handling

The Data API path attaches richer candidate metadata, including duration and snippet-derived fields, so downstream scoring has more context than the older flat yt-dlp search path.

### Review and comment loop

The local review UI can show generated videos and collect user comments. This is useful for building qualitative evidence, but it is not a production quality gate yet.

## Still Not Production Grade

### 1. Search relevance is not reliable enough

The largest remaining blocker is still search. If the provider returns irrelevant candidates, the selector either fails or picks a weak adjacent result. Hydrating top results did not fully solve this because the candidate pool itself can be wrong.

Production needs stronger query generation, provider-specific search strategy, and candidate reranking before download.

### 2. Search hints are not always retrieval-friendly

Scene descriptions can be visually correct but bad as YouTube queries. A scene like "audience reacts to the first iPhone demo" is clear to a human, but YouTube may surface commentary, modern retrospectives, or unrelated uploads.

The script generator should produce retrieval-aware hints, not only cinematic scene descriptions. That means hints should include concrete entities, event names, dates, source/channel preferences, and must-have/must-not-have constraints when appropriate.

### 3. Caption dependence is brittle

Transcript matching is valuable, but many useful b-roll clips are non-verbal or poorly captioned. The current pipeline still depends heavily on captions to find a good window.

Production needs a stronger visual verification path, likely using sampled frames/contact sheets and a cheap judge, without adding too much latency.

### 4. Provider choice is not yet intelligent

The UI/eval surface can force Data API or yt-dlp, but the workflow does not yet make a robust scene-by-scene provider decision. Data API often has better metadata and search semantics, while yt-dlp avoids quota limits but can return weaker pools.

Auto-routing should remain a follow-up until both providers are benchmarked on the same prompt set.

### 5. Current guards are too domain-specific

Many of the rejection rules are based on known benchmark failures. That is useful for preventing regressions, but it is not a general semantic ranking system.

Production needs a more general acceptance model or rubric that can reject wrong-source, wrong-event, wrong-entity, and wrong-format clips across arbitrary prompts.

### 6. Recovery is limited

When a scene fails, the workflow mostly surfaces the failure. That is better than silently using bad footage, but production also needs bounded recovery:

- Broaden or rewrite the query once.
- Try a stricter source/channel query when source matters.
- Retry transient download failures.
- Mark partials clearly when no acceptable clip exists.

Any recovery must stay inside the target end-to-end time budget.

### 7. Latency is not guaranteed

The desired target is under 50 seconds end-to-end per video. Search, metadata hydration, transcript fetch, download, TTS, and ffmpeg can all spike. The workflow needs timing budgets per stage and hard cutoffs.

Without stage-level SLOs, quality fixes can accidentally make the system too slow.

### 8. Eval quality is still partly manual

The review UI captures human comments, and the headless runner captures artifacts, but there is not yet an automated qualitative gate that says "this scene is visually aligned with this narration" with enough reliability.

The current branch is ready for benchmarking, not production deployment.

### 9. Source policy is unresolved

The workflow needs a clear product decision on what sources are allowed, preferred, or forbidden. For example, official OpenAI videos may be ideal for OpenAI scenes, but sports, news, creator commentary, and archival footage each need different source rules.

This should be explicit in generation and selection artifacts, not hidden in ad hoc scoring.

## Recommended Next Work

1. Run the current JSONL prompt set headlessly across `youtube_data_api` and `yt_dlp`.
2. Compare failures by scene, not just by final video.
3. Keep the current fail-loud behavior. Do not reintroduce random fallback footage.
4. Improve retrieval-aware search hints before adding heavier optimization systems.
5. Add one bounded retry path for failed scenes: rewrite/broaden query, then stop.
6. Add a cheap visual judge over sampled frames/contact sheets before calling a scene complete.
7. Leave broader semantic ranking, DSPy, and GEPA optimization as follow-up work after the provider benchmark is understood.

## Production Readiness Bar

The YouTube workflow should not be considered production grade until it can meet these minimum conditions:

- Bad matches fail loudly or become explicit partials.
- Scene-level artifacts explain why each clip was accepted or rejected.
- Provider behavior is benchmarked on the same prompt set.
- Per-video generation time is consistently within the target budget.
- The selector can reject wrong-source and wrong-event clips without prompt-specific hardcoding.
- The final video has narration/video alignment that is good enough without manual review for every run.
