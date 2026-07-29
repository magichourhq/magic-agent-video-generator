import pytest

from backend.app.tools import youtube_short


@pytest.fixture(autouse=True)
def _no_web_search_recovery(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep unit tests offline: the web-search recovery path makes a real
    OpenAI call whenever a candidate pool comes up empty. Tests that exercise
    recovery monkeypatch this function themselves."""
    monkeypatch.setattr(youtube_short, "_web_search_video_urls_for_section", lambda section: [])
