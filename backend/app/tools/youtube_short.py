from __future__ import annotations

import asyncio
import base64
import copy
import glob
import html
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from dotenv import dotenv_values

from .media import ProjectContext

ROOT = Path(__file__).resolve().parents[3]
SHARED_ENV = Path("/Users/tanmay/Magic Hour ML role/.env")
YOUTUBE_API_KEY_NAMES = ("YOUTUBE_API_KEY_1", "YOUTUBE_API_KEY_2", "YOUTUBE_API_KEY_3", "YOUTUBE_API_KEY")
YOUTUBE_API_KEY_VALIDATION_VIDEO_ID = "dQw4w9WgXcQ"
SEARCH_CANDIDATE_LIMIT = 20
TRANSCRIPT_CANDIDATE_LIMIT = 8
MIN_TRANSCRIPT_WINDOW_SCORE = 2.0
MIN_VISUAL_FALLBACK_SCORE = 3.0
MAX_VISUAL_FALLBACK_DURATION_SECONDS = 600.0
SECTION_QUERY_TOKEN_LIMIT = 10
BACKUP_SEARCH_MIN_SCENE_SCORE = 5.0
AUTO_YOUTUBE_SEARCH_PROVIDER = "auto"
YOUTUBE_DATA_API_PROVIDER = "youtube_data_api"
YT_DLP_SEARCH_PROVIDER = "yt_dlp"
DEFAULT_YOUTUBE_SEARCH_PROVIDER = YOUTUBE_DATA_API_PROVIDER
# yt-dlp search was dropped for recall quality; legacy "auto"/"yt_dlp" values
# are still accepted from old payloads but always coerce to the Data API.
YOUTUBE_SEARCH_PROVIDERS = {AUTO_YOUTUBE_SEARCH_PROVIDER, YOUTUBE_DATA_API_PROVIDER, YT_DLP_SEARCH_PROVIDER}
# YouTube Data API videoCategoryId values the script planner may target.
YOUTUBE_VIDEO_CATEGORY_IDS = {
    "film_animation": "1",
    "autos_vehicles": "2",
    "music": "10",
    "pets_animals": "15",
    "sports": "17",
    "travel_events": "19",
    "gaming": "20",
    "people_blogs": "22",
    "comedy": "23",
    "entertainment": "24",
    "news_politics": "25",
    "howto_style": "26",
    "education": "27",
    "science_technology": "28",
}
YOUTUBE_SEARCH_ORDERS = {"relevance", "date", "viewCount", "rating"}
YOUTUBE_VIDEO_DURATIONS = {"short", "medium", "long"}
YOUTUBE_URL_VIDEO_ID_PATTERN = re.compile(
    r"(?:youtube\.com/(?:watch\?(?:[^#\s]*&)?v=|shorts/|embed/|live/)|youtu\.be/)([A-Za-z0-9_-]{11})"
)
PLANNER_WEB_SEARCH_PROVIDER = "planner_web_search"
# Verified/official channels get a soft score boost in candidate ranking.
# These are channels with YouTube verification badges (or equivalent authority)
# across diverse categories — not limited to tech.
VERIFIED_CHANNEL_NAMES: set[str] = {
    # Tech / AI
    "openai", "anthropic", "google", "google deepmind", "nvidia",
    "microsoft", "apple", "meta", "amazon web services", "ibm",
    # News / Media
    "bbc news", "cnn", "reuters", "associated press", "the new york times",
    "the wall street journal", "bloomberg television", "cnbc", "al jazeera english",
    "the guardian", "nbc news", "abc news", "cbs news", "fox news",
    "sky news", "vice news", "vox", "the verge",
    # Science / Education
    "nasa", "national geographic", "ted", "ted-ed", "veritasium",
    "kurzgesagt – in a nutshell", "vsauce", "minutephysics", "smarter every day",
    "khan academy", "crashcourse", "3blue1brown",
    # Sports
    "nba", "nfl", "espn", "premier league", "ufc", "formula 1",
    "olympics", "nhl", "mlb",
    # Entertainment / Music
    "netflix", "hbo", "disney", "warner bros. pictures", "universal pictures",
    "sony pictures entertainment", "a24",
    # Business / Finance
    "goldman sachs", "jpmorgan chase", "tesla", "spacex",
    "y combinator", "harvard business review",
}
VERIFIED_CHANNEL_SCORE_BOOST = 4.0
# yt-dlp network safety net: bound each call so one stalled download/probe
# cannot hang the whole generation run. These are per-call ceilings, NOT a
# run-abort deadline — runs are never killed mid-generation.
YT_DLP_SOCKET_TIMEOUT_SECONDS = 15
YT_DLP_SUBPROCESS_TIMEOUT_SECONDS = 120
_WORKING_YOUTUBE_API_KEY: str | None = None
_VIDEO_DURATION_CACHE: dict[str, float] = {}
_TRANSCRIPT_ENTRIES_CACHE: dict[str, list[dict[str, Any]]] = {}
RECENT_QUERY_PATTERN = re.compile(
    r"\b(latest|today|tonight|current|breaking|news)\b",
    re.IGNORECASE,
)
HISTORICAL_QUERY_PATTERN = re.compile(
    r"\b(19\d{2}|20\d{2}|season|career|history|historic|classic|highlights?|recap|documentary|throwback)\b",
    re.IGNORECASE,
)
NEWS_CATEGORY_QUERY_PATTERN = re.compile(
    r"\b(shooting|election|war|attack|trial|lawsuit|earnings|weather|emergency|press|briefing|political)\b",
    re.IGNORECASE,
)
UNRELATED_ENTERTAINMENT_PATTERN = re.compile(
    r"\b(?:anime|manhwa|manga|recap|episode|chapter|paranormal|nether|gameplay|minecraft|roblox|podcast|talking-head)\b|動漫|诡异|熱血",
    re.IGNORECASE,
)
OPENAI_COMPETITOR_PATTERN = re.compile(r"\b(?:anthropic|claude|gemini|grok|llama|meta)\b", re.IGNORECASE)
OPENAI_MODEL_TERM_PATTERN = re.compile(r"\b(?:chatgpt|gpt)\s*[- ]?\s*(\d+(?:\.\d+)?[a-z]?)\b", re.IGNORECASE)
OPENAI_REASONING_MODEL_TERM_PATTERN = re.compile(
    r"\bo\s*[- ]?\s*(?:1(?:[- ]?(?:pro|mini))?|3|4(?:[- ]?mini)?)\b",
    re.IGNORECASE,
)
OPENAI_PRODUCT_QUERY_PATTERN = re.compile(
    r"\b(?:gpt\s*[- ]?\s*(?:\d+(?:\.\d+)?[a-z]?|[a-z][a-z0-9-]*)|o\s*[- ]?\s*(?:1(?:[- ]?(?:pro|mini))?|3|4(?:[- ]?mini)?)|codex|chatgpt(?:\s+atlas)?|sora|agentkit|dall-e)\b",
    re.IGNORECASE,
)
OPENAI_TUTORIAL_PATTERN = re.compile(
    r"\b(?:api\s*key|tutorial|how\s+to|walkthrough|beginners?|course|build\s+your\s+first)\b",
    re.IGNORECASE,
)
OPENAI_HYPE_COVERAGE_PATTERN = re.compile(
    r"\b(?:shocked|mind[- ]?blowing|insane|crazy|huge\s+upgrade|just\s+got\s+a|slashed|game[- ]?chang(?:ing|er))\b",
    re.IGNORECASE,
)
OPENAI_REPUTABLE_SOURCE_PATTERN = re.compile(
    r"\b(?:openai|microsoft|visual\s+studio\s+code|reuters|the\s+verge|techcrunch|cnbc|bloomberg|associated\s+press|ap\s+news|wall\s+street\s+journal|wsj|wired)\b",
    re.IGNORECASE,
)
OPENAI_NAMED_REPUTABLE_SOURCE_PATTERN = re.compile(
    r"\b(?:reuters|the\s+verge|techcrunch|cnbc|bloomberg|associated\s+press|ap\s+news|wall\s+street\s+journal|wsj|wired)\b",
    re.IGNORECASE,
)
OPENAI_LOW_AUTHORITY_COVERAGE_PATTERN = re.compile(
    r"\b(?:ai\s+(?:horizon|daily|with|news|clips?|updates?|show)|horizon\s+daily|arun\s+show|generated|stock|commentary|deep\s+dive|beyond\s+the\s+hype|is\s+here|most\s+powerful)\b",
    re.IGNORECASE,
)
OPENAI_CAREER_INTERVIEW_PATTERN = re.compile(r"\b(?:career|job\s*interview|jobinterview|resume|hiring)\b", re.IGNORECASE)
MODERN_IPHONE_PATTERN = re.compile(r"\biphone\s*(?:[2-9]|1[0-9])\b", re.IGNORECASE)
KEYNOTE_COMMENTARY_PATTERN = re.compile(r"\b(?:podcast|chronicles?|commentary|breakdown|explained)\b", re.IGNORECASE)
ANCIENT_COIN_EVIDENCE_PATTERN = re.compile(
    r"\b(?:coins?|numismatic|numismatics|denarius|drachma|solidus|roman|greek|byzantine|medieval|classical)\b",
    re.IGNORECASE,
)
ANCIENT_COIN_CLICKBAIT_PATTERN = re.compile(
    r"(?:\bminers?\s+found\b|\b350\s+million\b|#\s*(?:facts?|mystery)\b|\bmystery\s+shorts?\b)",
    re.IGNORECASE,
)
ANCIENT_COIN_MODERN_US_CURRENCY_PATTERN = re.compile(
    r"\b(?:one\s+dollar|u\.?s\.?|united\s+states|eagle\s+dollar|silver\s+dollars?|everyday\s+circulation|pocket\s+change)\b",
    re.IGNORECASE,
)
UNRELATED_SUBMARINE_EXPLAINER_PATTERN = re.compile(
    r"\b(?:military\s+secrets?|submarines?|hydrophones?)\b",
    re.IGNORECASE,
)
SPORTS_ACTION_QUERY_PATTERN = re.compile(
    r"\b(?:highlights?|touchdowns?|rushing|yards?|hurdle|run|runs|game|season|tape)\b",
    re.IGNORECASE,
)
SPORTS_COMMENTARY_INTERVIEW_PATTERN = re.compile(
    r"\b(?:post[-\s]?interview|interview|talking[-\s]?head|news|rumors?|reactors?|reacting|reaction|chat\s+sports|podcast|sit\s+or\s+play|sit\s+week|ending\s+chase|chase\s+for|resting|nfl\s+24h\s+online|snap\s+n\s+shove|national\s+voice|player\s+photos?)\b",
    re.IGNORECASE,
)
GPT4O_MINI_PATTERN = re.compile(r"\bgpt\s*[- ]?\s*4o\s*[- ]?\s*mini\b", re.IGNORECASE)
GENERIC_FACTOID_CLIP_PATTERN = re.compile(
    r"(?:\btop\s*\d+\b|#\s*(?:facts?|animals?|wildlife)\b|\bfactpaw\b)",
    re.IGNORECASE,
)
DEEP_SEA_CREATURE_QUERY_PATTERN = re.compile(
    r"\b(?:deep\s+sea|bioluminescent|jellyfish|squid|creatures?|underwater)\b",
    re.IGNORECASE,
)
DEEP_SEA_DRAMATIZED_STOCK_PATTERN = re.compile(
    r"\b(?:mythveil|morgawr|terrified|sea[-\s]?monster|fictional|cryptid|stock[-\s]?style|stock\s+footage|generated|"
    r"deep\s+ocean\s+enigma\s+lab|beyond\s+the\s+abyss)\b",
    re.IGNORECASE,
)
STOCK_OR_WATERMARK_SOURCE_PATTERN = re.compile(
    r"\b(?:"
    r"stock\s+(?:footage|video|videos|clips?|library|media|preview)|"
    r"(?:footage|video)\s+stock|"
    r"royalty[-\s]?free|copyright[-\s]?free|no\s+copyright|"
    r"watermark(?:ed)?|"
    r"visustock|clever\s+stock|naturefootage|shutterstock|pond5|storyblocks|videvo|"
    r"pixabay|pexels|istock|adobe\s+stock|envato\s+elements|motion\s+elements|videezy"
    r")\b",
    re.IGNORECASE,
)
VTT_TIMESTAMP_PATTERN = re.compile(
    r"(?P<start>\d{2}:\d{2}(?::\d{2})?[\.,]\d{3})\s+-->\s+"
    r"(?P<end>\d{2}:\d{2}(?::\d{2})?[\.,]\d{3})"
)
YOUTUBE_ISO_DURATION_PATTERN = re.compile(
    r"^P(?:(?P<days>\d+)D)?(?:T(?:(?P<hours>\d+)H)?(?:(?P<minutes>\d+)M)?(?:(?P<seconds>\d+)S)?)?$"
)
SECRET_QUERY_PARAM_PATTERN = re.compile(r"([?&](?:key|api_key|token|access_token)=)[^&\s\"'<>]+", re.IGNORECASE)
GOOGLE_API_KEY_PATTERN = re.compile(r"AIza[0-9A-Za-z_-]+")
QUERY_CHANNEL_STOPWORDS = {
    "about",
    "announcement",
    "and",
    "are",
    "broll",
    "briefing",
    "but",
    "can",
    "clips",
    "current",
    "demo",
    "developer",
    "footage",
    "for",
    "free",
    "from",
    "generic",
    "has",
    "have",
    "into",
    "its",
    "latest",
    "launch",
    "local",
    "major",
    "near",
    "news",
    "off",
    "official",
    "onto",
    "our",
    "press",
    "product",
    "reputable",
    "roll",
    "scene",
    "scenes",
    "shot",
    "shots",
    "short",
    "stock",
    "that",
    "the",
    "their",
    "then",
    "there",
    "these",
    "this",
    "those",
    "through",
    "today",
    "tonight",
    "toward",
    "towards",
    "was",
    "were",
    "where",
    "which",
    "while",
    "who",
    "with",
    "without",
    "update",
    "video",
    "videos",
}
VISUAL_GENERIC_TOKENS = QUERY_CHANNEL_STOPWORDS | {
    "barkley",  # handled as a required named entity with saquon below
    "clip",
    "clips",
    "close",
    "explainer",
    "highlight",
    "highlights",
    "minute",
    "minutes",
    "reel",
    "shorts",
    "source",
    "sources",
    "vertical",
}
QUERY_VARIANT_STOPWORDS = (VISUAL_GENERIC_TOKENS - {"demo"}) | {
    "about",
    "and",
    "from",
    "latest",
    "news",
    "official",
    "openai",
    "or",
    "product",
    "real",
    "reputable",
    "source",
    "sources",
    "the",
    "using",
}
OPENAI_VISUAL_FALLBACK_GENERIC_TOKENS = VISUAL_GENERIC_TOKENS | {
    "chatgpt",
    "gpt",
    "latest",
    "news",
    "official",
    "openai",
    "product",
    "reputable",
}


def _env_value(*keys: str) -> str | None:
    local_env = dotenv_values(ROOT / ".env")
    shared_env = dotenv_values(SHARED_ENV)
    for key in keys:
        value = os.environ.get(key) or local_env.get(key) or shared_env.get(key)
        if value:
            return str(value)
    return None


def _redact_secret_text(value: str) -> str:
    redacted = SECRET_QUERY_PARAM_PATTERN.sub(r"\1[redacted]", value)
    return GOOGLE_API_KEY_PATTERN.sub("[redacted]", redacted)


def _candidate_youtube_api_keys() -> list[tuple[str, str]]:
    candidates: list[tuple[str, str]] = []
    seen_values: set[str] = set()
    configured_names = os.environ.get("YOUTUBE_API_KEY_ALIASES")
    key_names = tuple(
        name.strip()
        for name in configured_names.split(",")
        if name.strip()
    ) if configured_names else YOUTUBE_API_KEY_NAMES
    for key_name in key_names:
        value = _env_value(key_name)
        if not value or value in seen_values:
            continue
        candidates.append((key_name, value))
        seen_values.add(value)
    return candidates


def _ordered_youtube_api_keys() -> list[tuple[str, str]]:
    candidates = _candidate_youtube_api_keys()
    if not _WORKING_YOUTUBE_API_KEY:
        return candidates
    preferred: tuple[str, str] | None = None
    rest: list[tuple[str, str]] = []
    for key_name, api_key in candidates:
        if api_key == _WORKING_YOUTUBE_API_KEY:
            preferred = (key_name, api_key)
        else:
            rest.append((key_name, api_key))
    if preferred is None:
        return candidates
    return [preferred, *rest]


def _youtube_client_for_key(api_key: str) -> Any:
    import googleapiclient.discovery

    return googleapiclient.discovery.build("youtube", "v3", developerKey=api_key)


def _youtube_data_api_failure_message(exc: Exception) -> str:
    message = str(exc)
    content = getattr(exc, "content", None)
    if isinstance(content, bytes):
        try:
            payload = json.loads(content.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            payload = None
        if isinstance(payload, dict):
            error = payload.get("error")
            if isinstance(error, dict):
                message = str(error.get("message") or message)
                errors = error.get("errors")
                if isinstance(errors, list):
                    reasons = [
                        str(item.get("reason"))
                        for item in errors
                        if isinstance(item, dict) and item.get("reason")
                    ]
                    if reasons:
                        message = f"{message} ({', '.join(reasons)})"
    return _redact_secret_text(message)


def _is_youtube_api_key_working(api_key: str) -> tuple[bool, str | None]:
    try:
        response = (
            _youtube_client_for_key(api_key)
            .videos()
            .list(part="id", id=YOUTUBE_API_KEY_VALIDATION_VIDEO_ID)
            .execute()
        )
    except Exception as exc:
        return False, _youtube_data_api_failure_message(exc)
    if response.get("items"):
        return True, None
    return False, "YouTube Data API key validation returned no public video metadata."


def _youtube_api_key() -> str:
    global _WORKING_YOUTUBE_API_KEY
    if _WORKING_YOUTUBE_API_KEY:
        return _WORKING_YOUTUBE_API_KEY

    candidates = _candidate_youtube_api_keys()
    if not candidates:
        raise RuntimeError("Missing YOUTUBE_API_KEY_1, YOUTUBE_API_KEY_2, YOUTUBE_API_KEY_3, or YOUTUBE_API_KEY for YouTube clip search.")

    errors: list[str] = []
    for key_name, api_key in candidates:
        working, error = _is_youtube_api_key_working(api_key)
        if working:
            _WORKING_YOUTUBE_API_KEY = api_key
            return api_key
        errors.append(f"{key_name}: {error or 'validation failed'}")

    raise RuntimeError(f"No working YouTube Data API key configured. {'; '.join(errors)}")


def _youtube_client() -> Any:
    return _youtube_client_for_key(_youtube_api_key())


def _looks_factual_query(query: str) -> bool:
    if not RECENT_QUERY_PATTERN.search(query):
        return False
    if HISTORICAL_QUERY_PATTERN.search(query) and not re.search(
        r"\b(latest|today|tonight|current|breaking|update)\b",
        query,
        re.IGNORECASE,
    ):
        return False
    return True


def _should_merge_literal_relevance_for_factual_query(query: str) -> bool:
    return bool(OPENAI_PRODUCT_QUERY_PATTERN.search(query))


def _requires_strict_recent_openai_results(query: str) -> bool:
    return bool(
        re.search(r"\bopenai\b", query, re.IGNORECASE)
        and re.search(r"\b(?:latest|today|tonight|current|breaking|recent)\b", query, re.IGNORECASE)
    )


def _needs_news_category(query: str) -> bool:
    if re.search(r"\b(openai|product|demo|launch|introducing|sports?|season|highlights?)\b", query, re.IGNORECASE):
        return False
    return bool(NEWS_CATEGORY_QUERY_PATTERN.search(query))


def _query_entity_tokens(query: str) -> list[str]:
    tokens: list[str] = []
    for token in re.findall(r"[A-Za-z0-9]+", query):
        lowered = token.lower()
        if (len(lowered) < 3 and not re.fullmatch(r"(?:[a-z]\d|\d[a-z])", lowered)) or lowered in QUERY_CHANNEL_STOPWORDS:
            continue
        if lowered not in tokens:
            tokens.append(lowered)
    return tokens


def _normalized_token(value: str) -> str:
    token = value.lower()
    if len(token) > 4 and token.endswith("ies"):
        return f"{token[:-3]}y"
    if len(token) > 3 and token.endswith("s"):
        return token[:-1]
    return token


def _normalized_token_set(text: str) -> set[str]:
    return {_normalized_token(token) for token in _query_entity_tokens(text)}


def _candidate_text(candidate: dict[str, Any]) -> str:
    return " ".join(
        str(candidate.get(field) or "")
        for field in ("title", "channel_title", "description")
    )


def _requires_official_openai_source(query_lower: str) -> bool:
    if "official" not in query_lower:
        return False
    if re.search(r"\bofficial\s+or\s+reputable\b|\breputable\b", query_lower, re.IGNORECASE):
        return False
    return bool(re.search(r"\b(?:openai|chatgpt|gpt|codex)\b", query_lower, re.IGNORECASE))


def _stock_or_watermarked_source_rejection_reason(candidate: dict[str, Any]) -> str | None:
    if STOCK_OR_WATERMARK_SOURCE_PATTERN.search(_candidate_text(candidate)):
        return "metadata looks like stock or watermarked source"
    return None


def _candidate_field_rejection_reason(query: str, candidate: dict[str, Any]) -> str | None:
    query_lower = query.lower()
    candidate_text = _candidate_text(candidate)
    candidate_lower = candidate_text.lower()
    channel = str(candidate.get("channel_title") or "").strip().lower()
    stock_rejection = _stock_or_watermarked_source_rejection_reason(candidate)
    if stock_rejection:
        return stock_rejection
    if (
        _requires_official_openai_source(query_lower)
        and channel != "openai"
    ):
        return "metadata does not match required official OpenAI source"
    if (
        re.search(r"\b(?:openai|chatgpt|gpt|codex)\b", query_lower, re.IGNORECASE)
        and OPENAI_PRODUCT_QUERY_PATTERN.search(query)
        and not OPENAI_REPUTABLE_SOURCE_PATTERN.search(channel)
        and OPENAI_LOW_AUTHORITY_COVERAGE_PATTERN.search(candidate_text)
    ):
        return "metadata does not match reputable OpenAI source"
    requested_reputable_sources = {
        match.group(0).lower()
        for match in OPENAI_NAMED_REPUTABLE_SOURCE_PATTERN.finditer(query)
    }
    if requested_reputable_sources and not OPENAI_NAMED_REPUTABLE_SOURCE_PATTERN.search(candidate_text):
        return "metadata does not match requested reputable source"
    if (
        re.search(r"\b(?:openai|chatgpt|gpt|codex)\b", query_lower, re.IGNORECASE)
        and re.search(r"\b(?:demo|camera|desktop|voice|launch|update)\b", query_lower, re.IGNORECASE)
        and OPENAI_CAREER_INTERVIEW_PATTERN.search(candidate_text)
        and not OPENAI_CAREER_INTERVIEW_PATTERN.search(query)
    ):
        return "metadata looks like career/interview content, not an OpenAI product demo"
    if (
        re.search(r"\b(?:steve\s+jobs|macworld|keynote)\b", query_lower, re.IGNORECASE)
        and KEYNOTE_COMMENTARY_PATTERN.search(candidate_text)
        and not re.search(r"\b(?:introduces?|unveils?|demo|presentation|iphone)\b", candidate_lower, re.IGNORECASE)
    ):
        return "metadata looks like podcast or commentary, not keynote footage"
    return None


def _canonical_openai_reasoning_model_term(raw: str) -> str:
    compact = re.sub(r"[\s_-]+", "", raw.lower())
    if compact == "o4mini":
        return "o4-mini"
    if compact == "o1pro":
        return "o1-pro"
    if compact == "o1mini":
        return "o1-mini"
    return compact


def _openai_model_terms(text: str) -> set[str]:
    terms = {f"gpt-{match.lower()}" for match in OPENAI_MODEL_TERM_PATTERN.findall(text)}
    terms.update(_canonical_openai_reasoning_model_term(match.group(0)) for match in OPENAI_REASONING_MODEL_TERM_PATTERN.finditer(text))
    return terms


def _has_unrelated_entertainment_terms(query: str, candidate_text: str) -> bool:
    return bool(UNRELATED_ENTERTAINMENT_PATTERN.search(candidate_text)) and not bool(
        UNRELATED_ENTERTAINMENT_PATTERN.search(query)
    )


def _has_openai_source_mismatch(query: str, candidate_text: str) -> bool:
    if not re.search(r"\b(?:openai|chatgpt|gpt)\b", query, re.IGNORECASE):
        return False
    if OPENAI_COMPETITOR_PATTERN.search(candidate_text) and not OPENAI_COMPETITOR_PATTERN.search(query):
        return True
    query_models = _openai_model_terms(query)
    candidate_models = _openai_model_terms(candidate_text)
    return bool(query_models and candidate_models and query_models.isdisjoint(candidate_models))


def _candidate_score(query: str, candidate: dict[str, Any]) -> float:
    query_lower = query.lower()
    title = str(candidate.get("title") or "").lower()
    channel = str(candidate.get("channel_title") or "").lower()
    description = str(candidate.get("description") or "").lower()
    candidate_text = _candidate_text(candidate)
    entity_tokens = _query_entity_tokens(query)
    wants_official = _requires_official_openai_source(query_lower)
    score = 0.0
    for token in entity_tokens:
        if token in channel:
            score += 5.0
        if token in title:
            score += 1.5
        if token in description:
            score += 0.5
    if wants_official and any(token in channel for token in entity_tokens):
        score += 8.0
    if wants_official and "openai" in query_lower and channel.strip() == "openai":
        score += 12.0
    if channel.strip() in VERIFIED_CHANNEL_NAMES:
        score += VERIFIED_CHANNEL_SCORE_BOOST
    if "shorts" in title or "#short" in title:
        score -= 3.0
    if re.search(r"\b(memorial|tribute)\b", title):
        score -= 12.0
    if "reaction" in title and "reaction" not in query_lower:
        score -= 8.0
    if _has_unrelated_entertainment_terms(query_lower, candidate_text):
        score -= 18.0
    if _has_openai_source_mismatch(query_lower, candidate_text):
        score -= 16.0
    query_years = set(re.findall(r"\b(?:19|20)\d{2}\b", query_lower))
    title_years = set(re.findall(r"\b(?:19|20)\d{2}\b", title))
    if query_years and title_years and not (query_years & title_years):
        score -= 8.0
    if "iphone" in query_lower and ({"2007"} & query_years or "first iphone" in query_lower):
        if re.search(r"\biphone\s*(?:[2-9]|1[0-9])\b", title):
            score -= 20.0
    return score


def _required_entity_rejection_reason(query: str, candidate_text: str) -> str | None:
    query_lower = query.lower()
    candidate_lower = candidate_text.lower()
    if (
        re.search(r"\bgpt\s*[- ]?\s*4o\b", query, re.IGNORECASE)
        and not GPT4O_MINI_PATTERN.search(query)
        and GPT4O_MINI_PATTERN.search(candidate_text)
    ):
        return "metadata does not match required OpenAI model"
    query_models = _openai_model_terms(query)
    if query_models and query_models.isdisjoint(_openai_model_terms(candidate_text)):
        return "metadata does not match required OpenAI model"
    if re.search(r"\b(?:openai|chatgpt|gpt|codex)\b", query_lower, re.IGNORECASE) and OPENAI_TUTORIAL_PATTERN.search(
        candidate_text
    ) and not OPENAI_TUTORIAL_PATTERN.search(query):
        return "metadata looks like generic OpenAI tutorial"
    if (
        re.search(r"\b(?:openai|chatgpt|gpt|codex)\b", query_lower, re.IGNORECASE)
        and OPENAI_HYPE_COVERAGE_PATTERN.search(candidate_text)
    ):
        return "metadata looks like hype OpenAI coverage"
    if re.search(r"\b(?:openai|chatgpt|gpt|codex)\b", query_lower, re.IGNORECASE) and not re.search(
        r"\b(?:openai|chatgpt|gpt|codex)\b",
        candidate_lower,
        re.IGNORECASE,
    ):
        return "metadata does not match required OpenAI subject"
    if (
        re.search(r"\b(?:before\s+the\s+iphone|physical\s+keyboards?|2006)\b", query_lower, re.IGNORECASE)
        and MODERN_IPHONE_PATTERN.search(candidate_text)
    ):
        return "metadata looks like modern iPhone footage"
    if (
        re.search(r"\b(?:steve\s+jobs|macworld|keynote)\b", query_lower, re.IGNORECASE)
        and re.search(r"\b(?:2007|macworld|iphone)\b", query_lower, re.IGNORECASE)
        and re.search(r"\b(?:memorial|tribute|celebrating\s+steve|october\s+5)\b", candidate_lower, re.IGNORECASE)
    ):
        return "metadata does not match required 2007 Macworld keynote footage"
    if re.search(r"\bdesktop\s+app\b", query_lower, re.IGNORECASE) and not re.search(
        r"\b(?:desktop|mac\s*app|windows\s*app|chatgpt\s*app)\b",
        candidate_lower,
        re.IGNORECASE,
    ):
        return "metadata does not match required desktop app scene"
    if "iphone" in query_lower and "steve jobs" in query_lower:
        has_jobs = re.search(r"\b(?:steve|jobs)\b", candidate_lower, re.IGNORECASE)
        has_iphone_context = re.search(r"\b(?:iphone|macworld)\b", candidate_lower, re.IGNORECASE)
        if not has_jobs or not has_iphone_context:
            return "metadata does not match required iPhone keynote subject"
    if re.search(r"\b(?:saquon|barkley)\b", query_lower, re.IGNORECASE) and not re.search(
        r"\b(?:saquon|barkley)\b",
        candidate_lower,
        re.IGNORECASE,
    ):
        return "metadata does not match required Saquon Barkley subject"
    if (
        re.search(r"\b(?:saquon|barkley)\b", query_lower, re.IGNORECASE)
        and SPORTS_ACTION_QUERY_PATTERN.search(query)
        and SPORTS_COMMENTARY_INTERVIEW_PATTERN.search(candidate_text)
    ):
        return "metadata looks like sports commentary or interview"
    if DEEP_SEA_CREATURE_QUERY_PATTERN.search(query) and DEEP_SEA_DRAMATIZED_STOCK_PATTERN.search(candidate_text):
        return "metadata looks like dramatized or stock deep-sea footage"
    if DEEP_SEA_CREATURE_QUERY_PATTERN.search(query) and GENERIC_FACTOID_CLIP_PATTERN.search(candidate_text):
        return "metadata looks like generic factoid clip"
    if (
        re.search(r"\b(?:researchers?|reviewing|review|scientists?|lab)\b", query_lower, re.IGNORECASE)
        and UNRELATED_SUBMARINE_EXPLAINER_PATTERN.search(candidate_text)
        and not re.search(r"\b(?:researchers?|research|scientists?|science|laboratory)\b", candidate_lower, re.IGNORECASE)
    ):
        return "metadata does not match required research scene"
    if (
        re.search(r"\b(?:reviewing|review|replay|monitor|frames?|ship\s+lab|research\s+vessel)\b", query_lower, re.IGNORECASE)
        and re.search(r"\b(?:researchers?|scientists?)\b", query_lower, re.IGNORECASE)
        and not re.search(
            r"\b(?:reviewing|review|replay|monitor|screen|frames?|footage|video|lab|laboratory|vessel|ship|deck|aboard|control\s+room)\b",
            candidate_lower,
            re.IGNORECASE,
        )
    ):
        return "metadata does not match required research review scene"
    if re.search(r"\b(?:researchers?|scientists?|lab)\b", query_lower, re.IGNORECASE) and not re.search(
        r"\b(?:researchers?|research|scientists?|science|lab|laboratory)\b",
        candidate_lower,
        re.IGNORECASE,
    ):
        return "metadata does not match required research scene"
    if re.search(r"\bancient coins?\b", query_lower, re.IGNORECASE):
        if ANCIENT_COIN_CLICKBAIT_PATTERN.search(candidate_text):
            return "metadata does not match required ancient coin subject"
        if ANCIENT_COIN_MODERN_US_CURRENCY_PATTERN.search(candidate_text):
            return "metadata does not match required ancient coin subject"
        if not ANCIENT_COIN_EVIDENCE_PATTERN.search(candidate_text):
            return "metadata does not match required ancient coin subject"
        if not re.search(
            r"\b(?:ancient|roman|greek|medieval|byzantine|archaeolog|artifact|artefact|numismatic|numismatics|classical)\b",
            candidate_lower,
            re.IGNORECASE,
        ):
            return "metadata does not match required ancient coin subject"
    return None


def _metadata_specificity_rejection_reason(section: Any, candidate: dict[str, Any], *, strict_overlap: bool = True) -> str | None:
    search_hint = str(getattr(section, "search_hint", "") or "")
    context = _section_context_text(section)
    candidate_text = _candidate_text(candidate)
    required_rejection = _required_entity_rejection_reason(context, candidate_text)
    if required_rejection:
        return required_rejection
    field_rejection = _candidate_field_rejection_reason(context, candidate)
    if field_rejection:
        return field_rejection
    if not strict_overlap:
        return None

    query_tokens = {
        token
        for token in _normalized_token_set(search_hint)
        if token not in VISUAL_GENERIC_TOKENS
    }
    if len(query_tokens) < 4:
        return None
    candidate_tokens = _normalized_token_set(candidate_text)
    overlap = query_tokens & candidate_tokens
    minimum_overlap = 2 if len(query_tokens) >= 6 else 1
    if len(overlap) < minimum_overlap:
        return (
            "metadata does not match search intent: "
            f"matched {len(overlap)} of {len(query_tokens)} specific token(s)"
        )
    return None


def _rank_video_candidates(query: str, candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(candidates, key=lambda candidate: _candidate_score(query, candidate), reverse=True)


def _normalize_youtube_search_provider(search_provider: str | None) -> str:
    provider = (search_provider or DEFAULT_YOUTUBE_SEARCH_PROVIDER).strip()
    if provider not in YOUTUBE_SEARCH_PROVIDERS:
        raise ValueError(f"Unsupported YouTube search provider: {provider}")
    return YOUTUBE_DATA_API_PROVIDER


def _compact_query(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def _section_context_text(section: Any) -> str:
    return _compact_query(
        " ".join(
            str(value or "")
            for value in (
                getattr(section, "dialogue", ""),
                getattr(section, "search_hint", ""),
            )
        )
    )


def _canonical_openai_product_term(term: str) -> str:
    compacted = re.sub(r"\s+", " ", term).strip()
    lowered = compacted.lower()
    if lowered.startswith("gpt"):
        suffix = re.sub(r"^gpt\s*[- ]?\s*", "", compacted, flags=re.IGNORECASE)
        return f"GPT-{suffix}"
    if lowered == "codex":
        return "Codex"
    if lowered.startswith("chatgpt atlas"):
        return "ChatGPT Atlas"
    if lowered == "chatgpt":
        return "ChatGPT"
    if lowered == "sora":
        return "Sora"
    if lowered == "agentkit":
        return "AgentKit"
    if lowered == "dall-e":
        return "DALL-E"
    return compacted


def _compact_openai_query_variant(text: str) -> str | None:
    matches = list(OPENAI_PRODUCT_QUERY_PATTERN.finditer(text))
    if not matches:
        return None
    product = _canonical_openai_product_term(matches[-1].group(0))
    tail = text[matches[-1].end() :]
    action_tokens: list[str] = []
    for token in re.findall(r"[A-Za-z0-9]+", tail):
        if len(token) < 3:
            continue
        normalized = _normalized_token(token)
        if normalized in QUERY_VARIANT_STOPWORDS or normalized in {"chatgpt", "gpt"}:
            continue
        if token.lower() not in action_tokens:
            action_tokens.append(token.lower())
    query = _compact_query(" ".join(["OpenAI", product, *action_tokens[:6]]))
    return query if query.lower() != _compact_query(text).lower() else None


def _compact_section_query_variant(section: Any) -> str | None:
    context = _section_context_text(section)
    tokens = _query_entity_tokens(context)
    if not tokens:
        return None
    query = _compact_query(" ".join(tokens[:SECTION_QUERY_TOKEN_LIMIT]))
    primary = _compact_query(str(getattr(section, "search_hint", "") or ""))
    if not query or query.lower() == primary.lower():
        return None
    return query


def _section_backoff_search_hint_variants(section: Any) -> list[str]:
    variants: list[str] = []
    for text in (
        str(getattr(section, "search_hint", "") or ""),
        _section_context_text(section),
    ):
        variant = _compact_openai_query_variant(text)
        if not variant:
            continue
        if variant.lower() == str(getattr(section, "search_hint", "") or "").strip().lower():
            continue
        if variant.lower() not in {item.lower() for item in variants}:
            variants.append(variant)
    generic_variant = _compact_section_query_variant(section)
    if generic_variant and generic_variant.lower() not in {item.lower() for item in variants}:
        variants.append(generic_variant)
    return variants


def _section_with_candidate_urls(section: Any, urls: list[str]) -> Any:
    if hasattr(section, "model_copy"):
        return section.model_copy(update={"candidate_video_urls": urls})
    cloned = copy.copy(section)
    setattr(cloned, "candidate_video_urls", urls)
    return cloned


def _web_search_video_urls_for_section(section: Any) -> list[str]:
    return []


def _section_with_search_hint(section: Any, search_hint: str) -> Any:
    if hasattr(section, "model_copy"):
        return section.model_copy(update={"search_hint": search_hint})
    cloned = copy.copy(section)
    setattr(cloned, "search_hint", search_hint)
    return cloned


def _section_search_params(section: Any) -> dict[str, Any]:
    """Translate agent-provided scene targeting fields into search.list params.

    The script planner sets these per scene so retrieval intent (recency,
    category, captions, clip length) is explicit instead of inferred from
    query-text heuristics.
    """
    params: dict[str, Any] = {}
    order = str(getattr(section, "search_order", "") or "").strip()
    if order in YOUTUBE_SEARCH_ORDERS:
        params["order"] = order
    for field, api_key in (("published_after", "publishedAfter"), ("published_before", "publishedBefore")):
        raw = str(getattr(section, field, "") or "").strip()
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
            params[api_key] = f"{raw}T00:00:00Z"
        elif re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", raw):
            params[api_key] = raw
    video_duration = str(getattr(section, "video_duration", "") or "").strip()
    if video_duration in YOUTUBE_VIDEO_DURATIONS:
        params["videoDuration"] = video_duration
    category = str(getattr(section, "video_category", "") or "").strip()
    if category in YOUTUBE_VIDEO_CATEGORY_IDS:
        params["videoCategoryId"] = YOUTUBE_VIDEO_CATEGORY_IDS[category]
    if bool(getattr(section, "require_captions", False)):
        params["videoCaption"] = "closedCaption"
    return params


def _section_candidate_video_ids(section: Any) -> list[str]:
    """Video IDs from planner-provided YouTube URLs (found via web search)."""
    urls = getattr(section, "candidate_video_urls", None) or []
    video_ids: list[str] = []
    for url in urls:
        match = YOUTUBE_URL_VIDEO_ID_PATTERN.search(str(url or ""))
        if match and match.group(1) not in video_ids:
            video_ids.append(match.group(1))
    return video_ids


def _planner_candidate_videos(section: Any) -> list[dict[str, Any]]:
    return _hydrate_candidate_video_ids(_section_candidate_video_ids(section), PLANNER_WEB_SEARCH_PROVIDER)


def _hydrate_candidate_video_ids(video_ids: list[str], provider: str) -> list[dict[str, Any]]:
    """Validate and hydrate video IDs via videos.list (1 quota unit).

    Hallucinated or dead IDs simply do not come back from the API, so this also
    acts as validation. Returns the same candidate shape as Data API search.
    """
    if not video_ids:
        return []
    try:
        response = _youtube_video_details_response(video_ids[:5])
    except Exception:
        return []
    candidates: list[dict[str, Any]] = []
    for item in response.get("items", []):
        if not isinstance(item, dict):
            continue
        video_id = str(item.get("id") or "")
        if not video_id:
            continue
        snippet = item.get("snippet") if isinstance(item.get("snippet"), dict) else {}
        content_details = item.get("contentDetails") if isinstance(item.get("contentDetails"), dict) else {}
        candidate: dict[str, Any] = {
            "video_id": video_id,
            "title": snippet.get("title"),
            "channel_title": snippet.get("channelTitle"),
            "published_at": snippet.get("publishedAt"),
            "description": snippet.get("description"),
        }
        duration = _parse_youtube_duration_seconds(str(content_details.get("duration") or ""))
        if duration:
            candidate["duration_seconds"] = duration
            _VIDEO_DURATION_CACHE[video_id] = duration
        tags = snippet.get("tags")
        if isinstance(tags, list):
            candidate["tags"] = [str(tag) for tag in tags if isinstance(tag, str)]
        candidates.append(candidate)
    return _annotate_search_candidates(
        candidates,
        requested_provider=provider,
        used_provider=provider,
        attempts=[{"provider": provider, "query": ",".join(video_ids), "result_count": len(candidates)}],
    )





def _section_channel_hint(section: Any) -> str:
    return _compact_query(str(getattr(section, "channel_hint", "") or ""))


def _section_search_queries(section: Any) -> list[str]:
    primary = _compact_query(str(getattr(section, "search_hint", "") or ""))
    channel_hint = _section_channel_hint(section)
    if channel_hint and channel_hint.lower() not in primary.lower():
        primary = _compact_query(f"{primary} {channel_hint}")
    context = _section_context_text(section)
    focused = " ".join(_query_entity_tokens(context)[:SECTION_QUERY_TOKEN_LIMIT])
    if focused and primary and _looks_factual_query(primary) and not RECENT_QUERY_PATTERN.search(focused):
        focused = f"latest {focused}"
    queries: list[str] = []
    for query in (primary, focused):
        if query and query.lower() not in {item.lower() for item in queries}:
            queries.append(query)
    return queries


def _section_candidate_score(section: Any, candidate: dict[str, Any]) -> float:
    dialogue = str(getattr(section, "dialogue", "") or "")
    score = _candidate_score(_section_context_text(section), candidate) + (_candidate_score(dialogue, candidate) * 1.25)
    channel_hint = _section_channel_hint(section)
    if channel_hint:
        channel_title = str(candidate.get("channel_title") or "")
        hint_tokens = _normalized_token_set(channel_hint)
        if hint_tokens and hint_tokens <= _normalized_token_set(channel_title):
            score += 6.0
    return score


def _candidate_is_web_sourced(candidate: dict[str, Any]) -> bool:
    return candidate.get("_search_provider") == PLANNER_WEB_SEARCH_PROVIDER


def _visual_fallback_rejection_reason(section: Any, candidate: dict[str, Any], score: float) -> str | None:
    query = _section_context_text(section)
    candidate_text = _candidate_text(candidate)
    stock_rejection = _stock_or_watermarked_source_rejection_reason(candidate)
    if stock_rejection:
        return stock_rejection
    if _has_unrelated_entertainment_terms(query, candidate_text):
        return "candidate looks like unrelated entertainment or recap content"
    if _has_openai_source_mismatch(query, candidate_text):
        return "candidate conflicts with the requested OpenAI source or model"
    if _candidate_is_web_sourced(candidate):
        # Web-search candidates were relevance-vetted by live search ranking,
        # so skip the strict token-overlap guards (highlight/b-roll titles
        # rarely echo the hint). But the model sometimes hallucinates video
        # ids that resolve to unrelated uploads, so require at least one
        # shared token between scene context and the hydrated metadata.
        context_tokens = {
            token
            for token in _normalized_token_set(_section_context_text(section))
            if token not in VISUAL_GENERIC_TOKENS
        }
        if context_tokens and not (context_tokens & _normalized_token_set(candidate_text)):
            return "web-sourced candidate metadata shares no tokens with the scene"
        return None
    metadata_rejection = _metadata_specificity_rejection_reason(section, candidate)
    if metadata_rejection:
        return metadata_rejection
    if re.search(r"\b(?:openai|chatgpt|gpt|codex)\b", query, re.IGNORECASE):
        required_tokens = {
            token
            for token in _normalized_token_set(str(getattr(section, "search_hint", "") or ""))
            if token not in OPENAI_VISUAL_FALLBACK_GENERIC_TOKENS
        }
        if required_tokens:
            candidate_tokens = _normalized_token_set(candidate_text)
            overlap = required_tokens & candidate_tokens
            if not overlap:
                return "metadata does not match search intent: missing " + ", ".join(sorted(required_tokens)[:3])
    if score < MIN_VISUAL_FALLBACK_SCORE:
        return f"candidate score too weak: {score:g}"
    return None


def _visual_fallback_window(total_duration: float, wanted_duration: float) -> tuple[float, float]:
    wanted = min(float(wanted_duration), float(total_duration))
    latest_start = max(0.0, float(total_duration) - wanted)
    if latest_start <= 0:
        return 0.0, round(float(total_duration), 3)
    start = min(latest_start, max(4.0, float(total_duration) * 0.18))
    return round(start, 3), round(min(float(total_duration), start + wanted), 3)


def _truthy_env(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _visual_verifier_enabled() -> bool:
    return _truthy_env(_env_value("YOUTUBE_VISUAL_VERIFY", "YOUTUBE_VISUAL_VERIFY_ENABLED"))


def _ffprobe_clip_duration(path: Path) -> float | None:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        capture_output=True,
        text=True,
        timeout=15,
    )
    if result.returncode != 0:
        return None
    try:
        duration = float(result.stdout.strip())
    except ValueError:
        return None
    return duration if duration > 0 else None


def _extract_visual_verification_frames(clip_path: str, output_dir: Path) -> list[Path]:
    path = Path(clip_path)
    duration = _ffprobe_clip_duration(path) or 5.0
    frames: list[Path] = []
    for index, offset in enumerate((0.2, 0.5, 0.8), start=1):
        frame_path = output_dir / f"verify_{index}.jpg"
        result = subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-ss",
                f"{max(0.0, duration * offset):.3f}",
                "-i",
                str(path),
                "-frames:v",
                "1",
                "-vf",
                "scale='min(640,iw)':-2",
                "-q:v",
                "4",
                str(frame_path),
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode == 0 and frame_path.exists() and frame_path.stat().st_size > 0:
            frames.append(frame_path)
    return frames


def _image_data_uri(path: Path) -> str:
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:image/jpeg;base64,{encoded}"


def _response_output_text(response: Any) -> str:
    output_text = getattr(response, "output_text", None)
    if isinstance(output_text, str) and output_text.strip():
        return output_text
    chunks: list[str] = []
    for item in getattr(response, "output", []) or []:
        for content in getattr(item, "content", []) or []:
            text = getattr(content, "text", None)
            if isinstance(text, str):
                chunks.append(text)
    return "\n".join(chunks)


def _openai_visual_match_judgment(
    section: Any,
    candidate: dict[str, Any],
    clip_path: str,
    window_match: dict[str, Any],
) -> dict[str, Any]:
    api_key = _env_value("OPENAI_API_KEY")
    if not api_key:
        return {"match": False, "reason": "OPENAI_API_KEY is not configured for visual verification"}
    with tempfile.TemporaryDirectory(prefix="yt-visual-verify-") as tmp:
        frames = _extract_visual_verification_frames(clip_path, Path(tmp))
        if not frames:
            return {"match": False, "reason": "could not extract verification frames"}
        from openai import OpenAI

        prompt = (
            "You are verifying whether downloaded YouTube clip frames visibly match a narrated section. "
            "Reject if the frames mainly show a title card, podcast art, presenter/reactor overlay, generic UI, "
            "unrelated news package, stock footage, or a different event/product than requested. "
            "Accept only when the visible footage itself supports the narration and search hint.\n\n"
            f"Narration: {getattr(section, 'dialogue', '')}\n"
            f"Search hint: {getattr(section, 'search_hint', '')}\n"
            f"YouTube title: {candidate.get('title')}\n"
            f"YouTube channel: {candidate.get('channel_title')}\n"
            f"Transcript/window text: {window_match.get('text')}\n\n"
            "Return JSON with keys: match (boolean), reason (short string)."
        )
        content: list[dict[str, Any]] = [{"type": "input_text", "text": prompt}]
        content.extend({"type": "input_image", "image_url": _image_data_uri(frame), "detail": "low"} for frame in frames)
        response = OpenAI(api_key=api_key).responses.create(
            model=_env_value("YOUTUBE_VISUAL_VERIFY_MODEL", "OPENAI_MODEL") or "gpt-5.4",
            input=[{"role": "user", "content": content}],
            max_output_tokens=180,
            text={
                "format": {
                    "type": "json_schema",
                    "name": "youtube_visual_match",
                    "strict": True,
                    "schema": {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {
                            "match": {"type": "boolean"},
                            "reason": {"type": "string"},
                        },
                        "required": ["match", "reason"],
                    },
                }
            },
            timeout=float(_env_value("YOUTUBE_VISUAL_VERIFY_TIMEOUT_SECONDS") or 45),
        )
    raw_text = _response_output_text(response)
    try:
        parsed = json.loads(raw_text)
    except json.JSONDecodeError:
        return {"match": False, "reason": f"visual verifier returned invalid JSON: {raw_text[:120]}"}
    return {"match": bool(parsed.get("match")), "reason": str(parsed.get("reason") or "visual mismatch")}


def _clip_visual_rejection_reason(
    section: Any,
    candidate: dict[str, Any],
    clip_path: str,
    window_match: dict[str, Any],
) -> str | None:
    if not _visual_verifier_enabled():
        return None
    try:
        judgment = _openai_visual_match_judgment(section, candidate, clip_path, window_match)
    except Exception as exc:
        return f"visual verifier failed: {_redact_secret_text(str(exc))}"
    if judgment.get("match") is True:
        return None
    reason = str(judgment.get("reason") or "visible frames do not match narration")
    return f"visual verifier mismatch: {reason}"


def _rank_section_candidates(section: Any, candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(candidates, key=lambda candidate: _section_candidate_score(section, candidate), reverse=True)


def _dedupe_candidates(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    deduped: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for candidate in candidates:
        video_id = str(candidate.get("video_id") or "")
        if not video_id or video_id in seen_ids:
            continue
        deduped.append(candidate)
        seen_ids.add(video_id)
    return deduped


def _search_section_video_candidates(
    section: Any,
    limit: int = SEARCH_CANDIDATE_LIMIT,
    search_provider: str = DEFAULT_YOUTUBE_SEARCH_PROVIDER,
) -> list[dict[str, Any]]:
    _normalize_youtube_search_provider(search_provider)
    queries = _section_search_queries(section)
    if not queries:
        return []
    search_params = _section_search_params(section)

    def search(query: str) -> list[dict[str, Any]]:
        if search_params:
            return _search_video_candidates_with_provider(query, limit, search_params=search_params)
        return _search_video_candidates(query, limit)

    # Planner web-search candidates lead the pool; when they already rank
    # strongly, skip search.list entirely (hydration costs 1 unit vs 100).
    candidates = _planner_candidate_videos(section)
    ranked = _rank_section_candidates(section, _dedupe_candidates(candidates))
    if ranked and _section_candidate_score(section, ranked[0]) >= BACKUP_SEARCH_MIN_SCENE_SCORE:
        return ranked

    candidates.extend(search(queries[0]))
    ranked = _rank_section_candidates(section, _dedupe_candidates(candidates))
    if len(queries) > 1 and (not ranked or _section_candidate_score(section, ranked[0]) < BACKUP_SEARCH_MIN_SCENE_SCORE):
        candidates.extend(search(queries[1]))
        ranked = _rank_section_candidates(section, _dedupe_candidates(candidates))
    if not ranked:
        web_urls = _web_search_video_urls_for_section(section)
        if web_urls:
            web_section = _section_with_candidate_urls(section, web_urls)
            candidates.extend(_planner_candidate_videos(web_section))
            ranked = _rank_section_candidates(section, _dedupe_candidates(candidates))
    return ranked


def _search_params(
    query: str,
    limit: int,
    *,
    factual: bool,
    published_after: str | None,
    overrides: dict[str, Any] | None = None,
) -> dict[str, Any]:
    params: dict[str, Any] = {
        "part": "snippet",
        "type": "video",
        "q": query,
        "maxResults": limit,
        "order": "date" if factual else "relevance",
    }
    if factual and published_after:
        params["publishedAfter"] = published_after
    if factual and published_after and _needs_news_category(query):
        params["videoCategoryId"] = "25"
    if overrides:
        params.update(overrides)
    return params


def _search_response_for_key(
    api_key: str,
    query: str,
    limit: int,
    *,
    factual: bool,
    published_after: str | None,
    overrides: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return _youtube_client_for_key(api_key).search().list(
        **_search_params(query, limit, factual=factual, published_after=published_after, overrides=overrides)
    ).execute()


def _search_response(
    query: str,
    limit: int,
    *,
    factual: bool,
    published_after: str | None,
    overrides: dict[str, Any] | None = None,
) -> dict[str, Any]:
    global _WORKING_YOUTUBE_API_KEY
    errors: list[str] = []
    keys = _ordered_youtube_api_keys()
    if not keys:
        raise RuntimeError("Missing YOUTUBE_API_KEY_1, YOUTUBE_API_KEY_2, YOUTUBE_API_KEY_3, or YOUTUBE_API_KEY for YouTube clip search.")
    for key_name, api_key in keys:
        try:
            if overrides:
                response = _search_response_for_key(api_key, query, limit, factual=factual, published_after=published_after, overrides=overrides)
            else:
                response = _search_response_for_key(api_key, query, limit, factual=factual, published_after=published_after)
        except Exception as exc:
            if _WORKING_YOUTUBE_API_KEY == api_key:
                _WORKING_YOUTUBE_API_KEY = None
            errors.append(f"{key_name}: {_youtube_data_api_failure_message(exc)}")
            continue
        _WORKING_YOUTUBE_API_KEY = api_key
        response["_youtube_api_key_alias"] = key_name
        return response
    raise RuntimeError(f"All configured YouTube Data API keys failed search.list. {'; '.join(errors)}")


def _published_after_iso(days: int = 45) -> str:
    from datetime import datetime, timedelta, timezone

    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(timespec="seconds").replace("+00:00", "Z")


def _youtube_response_candidates(response: dict[str, Any]) -> list[dict[str, Any]]:
    items = response.get("items", [])
    return [
        {
            "video_id": item["id"]["videoId"],
            "title": item.get("snippet", {}).get("title"),
            "channel_title": item.get("snippet", {}).get("channelTitle"),
            "published_at": item.get("snippet", {}).get("publishedAt"),
            "description": item.get("snippet", {}).get("description"),
            "youtube_api_key_alias": response.get("_youtube_api_key_alias"),
        }
        for item in items
        if item.get("id", {}).get("videoId")
    ]


def _parse_youtube_duration_seconds(value: str | None) -> float | None:
    if not value:
        return None
    match = YOUTUBE_ISO_DURATION_PATTERN.fullmatch(value)
    if not match:
        return None
    days = int(match.group("days") or 0)
    hours = int(match.group("hours") or 0)
    minutes = int(match.group("minutes") or 0)
    seconds = int(match.group("seconds") or 0)
    total = days * 86400 + hours * 3600 + minutes * 60 + seconds
    return float(total) if total > 0 else None


def _youtube_video_details_response(video_ids: list[str]) -> dict[str, Any]:
    return _youtube_client().videos().list(
        part="snippet,statistics,contentDetails",
        id=",".join(video_ids),
    ).execute()


def _parse_youtube_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _attach_youtube_data_api_video_details(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    video_ids = [str(candidate.get("video_id") or "") for candidate in candidates if candidate.get("video_id")]
    if not video_ids:
        return candidates
    try:
        response = _youtube_video_details_response(video_ids[:50])
    except Exception:
        return candidates
    details_by_id: dict[str, dict[str, Any]] = {}
    for item in response.get("items", []):
        if not isinstance(item, dict):
            continue
        video_id = str(item.get("id") or "")
        if not video_id:
            continue
        updates: dict[str, Any] = {}
        snippet = item.get("snippet") if isinstance(item.get("snippet"), dict) else {}
        statistics = item.get("statistics") if isinstance(item.get("statistics"), dict) else {}
        content_details = item.get("contentDetails") if isinstance(item.get("contentDetails"), dict) else {}

        duration = _parse_youtube_duration_seconds(str(content_details.get("duration") or ""))
        if duration:
            updates["duration_seconds"] = duration
            _VIDEO_DURATION_CACHE[video_id] = duration
        tags = snippet.get("tags")
        if isinstance(tags, list):
            updates["tags"] = [str(tag) for tag in tags if isinstance(tag, str)]
        view_count = _parse_youtube_int(statistics.get("viewCount"))
        if view_count is not None:
            updates["view_count"] = view_count
        comment_count = _parse_youtube_int(statistics.get("commentCount"))
        if comment_count is not None:
            updates["comment_count"] = comment_count
        for field in ("definition", "dimension"):
            value = content_details.get(field)
            if value:
                updates[field] = value
        if updates:
            details_by_id[video_id] = updates
    for candidate in candidates:
        video_id = str(candidate.get("video_id") or "")
        if video_id in details_by_id:
            candidate.update(details_by_id[video_id])
    return candidates


def _youtube_data_api_search_candidates(
    query: str,
    limit: int = 5,
    search_params: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    if search_params:
        # The script planner stated its retrieval intent explicitly; trust it.
        # If the filtered search comes back empty, retry once with the filters
        # relaxed so an over-constrained scene still gets a candidate pool.
        try:
            response = _search_response(query, limit, factual=False, published_after=None, overrides=search_params)
            candidates = _youtube_response_candidates(response)
            if not candidates:
                # Drop every filter including order: date-ordering itself can
                # starve recall on evergreen topics.
                response = _search_response(query, limit, factual=False, published_after=None)
                candidates = _youtube_response_candidates(response)
        except Exception as exc:
            raise RuntimeError(_youtube_data_api_failure_message(exc)) from exc
        candidates = _attach_youtube_data_api_video_details(_dedupe_candidates(candidates))
        return _rank_video_candidates(query, candidates)

    # Legacy heuristic path for callers without planner-provided params.
    factual = _looks_factual_query(query)
    published_after = _published_after_iso() if factual else None
    strict_recent_openai = factual and _requires_strict_recent_openai_results(query)
    try:
        response = _search_response(query, limit, factual=factual, published_after=published_after)
        candidates = _youtube_response_candidates(response)
        if factual and not strict_recent_openai and (not candidates or _should_merge_literal_relevance_for_factual_query(query)):
            try:
                relaxed_response = _search_response(query, limit, factual=False, published_after=None)
            except Exception:
                if not candidates:
                    raise
            else:
                candidates.extend(_youtube_response_candidates(relaxed_response))
    except Exception as exc:
        raise RuntimeError(_youtube_data_api_failure_message(exc)) from exc
    candidates = _attach_youtube_data_api_video_details(_dedupe_candidates(candidates))
    return _rank_video_candidates(query, candidates)


def _search_attempt(
    *,
    provider: str,
    query: str,
    limit: int,
    started_at: float,
    result_count: int = 0,
    error: str | None = None,
) -> dict[str, Any]:
    attempt: dict[str, Any] = {
        "provider": provider,
        "query": query,
        "limit": limit,
        "duration_ms": round((time.perf_counter() - started_at) * 1000, 2),
        "result_count": result_count,
    }
    if error:
        attempt["error"] = _redact_secret_text(error)
    return attempt


def _annotate_search_candidates(
    candidates: list[dict[str, Any]],
    *,
    requested_provider: str,
    used_provider: str,
    attempts: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    benchmark = {
        "requested_provider": requested_provider,
        "used_provider": used_provider,
        "attempts": attempts,
    }
    return [
        {
            **candidate,
            "_search_provider": used_provider,
            "_search_benchmark": benchmark,
        }
        for candidate in candidates
    ]


def _search_video_candidates_with_provider(
    query: str,
    limit: int = 5,
    search_provider: str = DEFAULT_YOUTUBE_SEARCH_PROVIDER,
    *,
    search_params: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    requested_provider = _normalize_youtube_search_provider(search_provider)
    attempts: list[dict[str, Any]] = []
    started_at = time.perf_counter()
    try:
        if search_params:
            candidates = _youtube_data_api_search_candidates(query, limit, search_params=search_params)
        else:
            candidates = _youtube_data_api_search_candidates(query, limit)
    except Exception as exc:
        attempts.append(
            _search_attempt(
                provider=YOUTUBE_DATA_API_PROVIDER,
                query=query,
                limit=limit,
                started_at=started_at,
                error=str(exc),
            )
        )
        return []
    attempts.append(
        _search_attempt(
            provider=YOUTUBE_DATA_API_PROVIDER,
            query=query,
            limit=limit,
            started_at=started_at,
            result_count=len(candidates),
        )
    )
    return _annotate_search_candidates(
        candidates,
        requested_provider=requested_provider,
        used_provider=YOUTUBE_DATA_API_PROVIDER,
        attempts=attempts,
    )


def _search_video_candidates(query: str, limit: int = 5) -> list[dict[str, Any]]:
    return _search_video_candidates_with_provider(query, limit)


def _search_video_ids(query: str, limit: int = 5) -> list[str]:
    return [candidate["video_id"] for candidate in _search_video_candidates(query, limit)]


def _yt_dlp_command() -> list[str]:
    return [sys.executable, "-m", "yt_dlp"]


def _video_duration(video_id: str) -> float:
    cached = _VIDEO_DURATION_CACHE.get(video_id)
    if cached is not None:
        return cached
    result = subprocess.check_output(
        [
            *_yt_dlp_command(),
            "--socket-timeout", str(YT_DLP_SOCKET_TIMEOUT_SECONDS),
            "--print", "duration",
            f"https://www.youtube.com/watch?v={video_id}",
        ],
        text=True,
        timeout=YT_DLP_SUBPROCESS_TIMEOUT_SECONDS,
    ).strip()
    try:
        duration = float(result)
    except ValueError as exc:
        raise RuntimeError(f"Could not read duration for YouTube video {video_id}: {result}") from exc
    _VIDEO_DURATION_CACHE[video_id] = duration
    return duration


def _candidate_duration(candidate: dict[str, Any]) -> float:
    video_id = str(candidate["video_id"])
    raw_duration = candidate.get("duration_seconds")
    if raw_duration is not None:
        try:
            duration = float(raw_duration)
        except (TypeError, ValueError):
            duration = 0.0
        if duration > 0:
            _VIDEO_DURATION_CACHE[video_id] = duration
            return duration
    return _video_duration(video_id)


def _parse_vtt_timestamp(value: str) -> float:
    parts = value.replace(",", ".").split(":")
    if len(parts) == 3:
        hours, minutes, seconds = parts
        return int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    if len(parts) == 2:
        minutes, seconds = parts
        return int(minutes) * 60 + float(seconds)
    return float(parts[0])


def _clean_vtt_text(text: str) -> str:
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def _parse_vtt_entries(path: Path) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    current_start: float | None = None
    current_end: float | None = None
    current_lines: list[str] = []

    def flush() -> None:
        nonlocal current_start, current_end, current_lines
        if current_start is None or current_end is None:
            current_lines = []
            return
        text = _clean_vtt_text(" ".join(current_lines))
        if text:
            entries.append({"start": current_start, "end": current_end, "text": text})
        current_start = None
        current_end = None
        current_lines = []

    for raw_line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw_line.strip()
        if not line:
            flush()
            continue
        match = VTT_TIMESTAMP_PATTERN.search(line)
        if match:
            flush()
            current_start = _parse_vtt_timestamp(match.group("start"))
            current_end = _parse_vtt_timestamp(match.group("end"))
            current_lines = []
            continue
        if current_start is not None and not line.startswith(("WEBVTT", "Kind:", "Language:", "NOTE")):
            current_lines.append(line)
    flush()
    return entries


def _transcript_entries(video_id: str) -> list[dict[str, Any]]:
    if video_id in _TRANSCRIPT_ENTRIES_CACHE:
        return [dict(entry) for entry in _TRANSCRIPT_ENTRIES_CACHE[video_id]]

    with tempfile.TemporaryDirectory() as temp_dir:
        output_template = str(Path(temp_dir) / "%(id)s.%(ext)s")
        command = [
            *_yt_dlp_command(),
            f"https://www.youtube.com/watch?v={video_id}",
            "--skip-download",
            "--write-subs",
            "--write-auto-subs",
            "--sub-langs",
            "en.*",
            "--sub-format",
            "vtt",
            "-o",
            output_template,
            "--quiet",
            "--no-warnings",
        ]
        result = subprocess.run(command, capture_output=True, text=True)
        if result.returncode != 0:
            _TRANSCRIPT_ENTRIES_CACHE[video_id] = []
            return []
        entries: list[dict[str, Any]] = []
        for path in sorted(Path(temp_dir).glob("*.vtt")):
            entries.extend(_parse_vtt_entries(path))
        _TRANSCRIPT_ENTRIES_CACHE[video_id] = entries
        return [dict(entry) for entry in entries]


def _transcript_query_tokens(section: Any) -> set[str]:
    text = " ".join(
        str(value or "")
        for value in (
            getattr(section, "dialogue", ""),
            getattr(section, "search_hint", ""),
        )
    )
    return set(_query_entity_tokens(text))


def _pick_transcript_window(
    video_id: str,
    total_duration: float,
    wanted_duration: float,
    section: Any,
) -> tuple[float, float, dict[str, Any]] | None:
    tokens = _transcript_query_tokens(section)
    if not tokens:
        return None
    entries = _transcript_entries(video_id)
    best_entry: dict[str, Any] | None = None
    best_score = 0.0
    for entry in entries:
        entry_tokens = set(_query_entity_tokens(str(entry.get("text") or "")))
        if not entry_tokens:
            continue
        overlap = tokens & entry_tokens
        score = float(len(overlap))
        if score > best_score:
            best_score = score
            best_entry = entry
    if best_entry is None or best_score <= 0:
        return None

    wanted = min(float(wanted_duration), float(total_duration))
    cue_start = float(best_entry["start"])
    start = min(max(0.0, cue_start), max(0.0, float(total_duration) - wanted))
    end = min(float(total_duration), start + wanted)
    return (
        round(start, 3),
        round(end, 3),
        {
            "source": "transcript",
            "score": best_score,
            "text": str(best_entry.get("text") or ""),
            "cue_start_seconds": round(float(best_entry["start"]), 3),
            "cue_end_seconds": round(float(best_entry["end"]), 3),
        },
    )


def _download_clip(
    video_id: str,
    start: float,
    duration: float,
    *,
    out_dir: str,
    proxy_url: str | None = None,
) -> str:
    output_dir = Path(out_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    end = round(start + duration, 3)
    start_label = str(start).replace(".", "_")
    template = str(output_dir / f"{start_label}_%(id)s.%(ext)s")
    command = [
        *_yt_dlp_command(),
        f"https://www.youtube.com/watch?v={video_id}",
        "--socket-timeout",
        str(YT_DLP_SOCKET_TIMEOUT_SECONDS),
        "--download-sections",
        f"*{start}-{end}",
        "-f",
        "mp4",
        "-o",
        template,
        "--quiet",
        "--no-playlist",
        "--no-mtime",
    ]
    if proxy_url:
        command += ["--proxy", proxy_url]
    subprocess.run(command, check=True, timeout=YT_DLP_SUBPROCESS_TIMEOUT_SECONDS)
    files = sorted(glob.glob(str(output_dir / f"{start_label}_{video_id}.*")))
    if not files:
        raise RuntimeError(f"No clip downloaded for YouTube video {video_id}")
    return str(Path(files[0]).resolve())


def _search_provider_for_candidate(candidate: dict[str, Any], requested_provider: str) -> str:
    benchmark = candidate.get("_search_benchmark")
    if isinstance(benchmark, dict):
        used_provider = benchmark.get("used_provider")
        if isinstance(used_provider, str) and used_provider:
            return used_provider
        attempts = benchmark.get("attempts")
        if isinstance(attempts, list) and attempts:
            provider = attempts[-1].get("provider") if isinstance(attempts[-1], dict) else None
            if isinstance(provider, str) and provider:
                return provider
    provider = candidate.get("_search_provider")
    return str(provider or requested_provider)


def _download_section_clip(
    ctx: ProjectContext,
    section: Any,
    proxy_url: str | None = None,
    search_provider: str = DEFAULT_YOUTUBE_SEARCH_PROVIDER,
    _attempted_hints: set[str] | None = None,
) -> dict[str, Any]:
    search_provider = _normalize_youtube_search_provider(search_provider)
    scene_id = f"scene_{int(section.section)}"
    attempted_hints = set(_attempted_hints or set())
    attempted_hints.add(str(getattr(section, "search_hint", "") or "").strip().lower())
    candidates = _search_section_video_candidates(section, search_provider=search_provider)
    if not candidates:
        raise RuntimeError(f"No YouTube video found for search hint: {section.search_hint}")

    if not str(getattr(section, "dialogue", "") or "").strip():
        raise RuntimeError(f"No dialogue available for transcript-aligned YouTube window: {section.search_hint}")

    failures: list[str] = []
    for candidate in candidates[:TRANSCRIPT_CANDIDATE_LIMIT]:
        video_id = candidate["video_id"]
        metadata_rejection = _metadata_specificity_rejection_reason(section, candidate, strict_overlap=False)
        if metadata_rejection:
            failures.append(f"{video_id}: metadata rejected: {metadata_rejection}")
            continue
        try:
            total_duration = _candidate_duration(candidate)
        except Exception as exc:
            failures.append(f"{video_id}: duration failed: {_redact_secret_text(str(exc))}")
            continue

        transcript_window = _pick_transcript_window(video_id, total_duration, section.duration_seconds, section)
        if transcript_window is None:
            failures.append(f"{video_id}: no transcript match")
            continue

        start, end, window_match = transcript_window
        score = float(window_match.get("score") or 0.0)
        if score < MIN_TRANSCRIPT_WINDOW_SCORE:
            failures.append(f"{video_id}: transcript match too weak: {score:g}")
            continue
        out_dir = ctx.project_dir / "youtube_clips" / scene_id
        try:
            downloaded = _download_clip(
                video_id,
                start,
                end - start,
                out_dir=str(out_dir),
                proxy_url=proxy_url,
            )
        except Exception as exc:
            failures.append(f"{video_id}: download failed: {_redact_secret_text(str(exc))}")
            continue
        visual_rejection = _clip_visual_rejection_reason(section, candidate, downloaded, window_match)
        if visual_rejection:
            failures.append(f"{video_id}: {visual_rejection}")
            continue
        return {
            "scene_id": scene_id,
            "path": str(Path(downloaded).resolve()),
            "prompt": section.search_hint,
            "model": "youtube-clips",
            "resolution": ctx.resolution,
            "audio": False,
            "duration_seconds": section.duration_seconds,
            "source": "youtube",
            "search_hint": section.search_hint,
            "video_id": video_id,
            "youtube_url": f"https://www.youtube.com/watch?v={video_id}",
            "youtube_title": candidate.get("title"),
            "youtube_channel": candidate.get("channel_title"),
            "youtube_published_at": candidate.get("published_at"),
            "youtube_api_key_alias": candidate.get("youtube_api_key_alias"),
            "youtube_search_provider_requested": search_provider,
            "youtube_search_provider": _search_provider_for_candidate(candidate, search_provider),
            "youtube_search_benchmark": candidate.get("_search_benchmark"),
            "start_seconds": start,
            "end_seconds": end,
            "window_source": window_match.get("source"),
            "window_match": window_match,
        }

    for candidate in candidates[:TRANSCRIPT_CANDIDATE_LIMIT]:
        video_id = candidate["video_id"]
        fallback_score = _section_candidate_score(section, candidate)
        fallback_rejection = _visual_fallback_rejection_reason(section, candidate, fallback_score)
        if fallback_rejection:
            failures.append(f"{video_id}: fallback rejected: {fallback_rejection}")
            continue
        try:
            total_duration = _candidate_duration(candidate)
        except Exception as exc:
            failures.append(f"{video_id}: fallback duration failed: {_redact_secret_text(str(exc))}")
            continue
        if total_duration > MAX_VISUAL_FALLBACK_DURATION_SECONDS:
            failures.append(f"{video_id}: fallback rejected: video is too long for visual fallback without transcript")
            continue
        start, end = _visual_fallback_window(total_duration, section.duration_seconds)
        out_dir = ctx.project_dir / "youtube_clips" / scene_id
        try:
            downloaded = _download_clip(
                video_id,
                start,
                end - start,
                out_dir=str(out_dir),
                proxy_url=proxy_url,
            )
        except Exception as exc:
            failures.append(f"{video_id}: fallback download failed: {_redact_secret_text(str(exc))}")
            continue
        fallback_match = {
            "source": "visual_fallback",
            "score": round(fallback_score, 3),
            "text": str(candidate.get("title") or ""),
            "cue_start_seconds": round(start, 3),
            "cue_end_seconds": round(end, 3),
        }
        visual_rejection = _clip_visual_rejection_reason(section, candidate, downloaded, fallback_match)
        if visual_rejection:
            failures.append(f"{video_id}: {visual_rejection}")
            continue
        return {
            "scene_id": scene_id,
            "path": str(Path(downloaded).resolve()),
            "prompt": section.search_hint,
            "model": "youtube-clips",
            "resolution": ctx.resolution,
            "audio": False,
            "duration_seconds": section.duration_seconds,
            "source": "youtube",
            "search_hint": section.search_hint,
            "video_id": video_id,
            "youtube_url": f"https://www.youtube.com/watch?v={video_id}",
            "youtube_title": candidate.get("title"),
            "youtube_channel": candidate.get("channel_title"),
            "youtube_published_at": candidate.get("published_at"),
            "youtube_api_key_alias": candidate.get("youtube_api_key_alias"),
            "youtube_search_provider_requested": search_provider,
            "youtube_search_provider": _search_provider_for_candidate(candidate, search_provider),
            "youtube_search_benchmark": candidate.get("_search_benchmark"),
            "start_seconds": round(start, 3),
            "end_seconds": round(end, 3),
            "window_source": "visual_fallback",
            "window_match": fallback_match,
        }

    for retry_hint in _section_backoff_search_hint_variants(section):
        retry_key = retry_hint.strip().lower()
        if retry_key in attempted_hints:
            continue
        retry_section = _section_with_search_hint(section, retry_hint)
        try:
            return _download_section_clip(
                ctx,
                retry_section,
                proxy_url=proxy_url,
                search_provider=search_provider,
                _attempted_hints=attempted_hints,

            )
        except RuntimeError as exc:
            failures.append(f"{retry_hint}: {_redact_secret_text(str(exc))}")

    tried = "; ".join(failures) if failures else "no candidates tried"
    raise RuntimeError(f"No transcript-aligned YouTube window found for search hint: {section.search_hint}. Tried: {tried}")


async def download_youtube_clip_assets(
    ctx: ProjectContext,
    sections: list[Any],
    proxy_url: str | None = None,
    search_provider: str = DEFAULT_YOUTUBE_SEARCH_PROVIDER,
) -> list[dict[str, Any] | BaseException]:
    search_provider = _normalize_youtube_search_provider(search_provider)

    def download_call(section: Any) -> Any:
        if not getattr(section, "candidate_video_urls", None):
            urls = _web_search_video_urls_for_section(section)
            if urls:
                section = _section_with_candidate_urls(section, urls)
        return asyncio.to_thread(_download_section_clip, ctx, section, proxy_url, search_provider)

    return await asyncio.gather(
        *(download_call(section) for section in sections),
        return_exceptions=True,
    )
