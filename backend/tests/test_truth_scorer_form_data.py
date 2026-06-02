"""B4 — credibility chain: Report.form_data (curated crisis-pack answers) is fed
into the truth-scorer prompt as community-curated ground truth, weighed by the
rubric, and flagged on the result so the dashboard can show it was considered.

The Claude client is mocked — these assert the wiring (what reaches the prompt +
what comes back), not Claude's judgement.
"""
import json
from datetime import datetime, timezone

from app.services.truth_scorer import TruthScorer, _format_curated_answers


# ── Claude client test double ──────────────────────────────────────────────
_FAKE_SCORE = {
    "scores": {"location_authenticity": 20, "damage_corroboration": 18,
               "description_coherence": 17, "data_quality": 15, "total": 0},
    "verdict": "LIKELY_AUTHENTIC",
    "satellite_scene_description": "rooftops + standing water",
    "photo_analysis": "flooded street",
    "key_findings": ["satellite confirms residential area", "water visible in photo"],
    "caveats": [],
    "reasoning": "consistent across sources",
}


class _FakeContent:
    def __init__(self, text):
        self.text = text


class _FakeResp:
    def __init__(self, text):
        self.content = [_FakeContent(text)]


class _FakeMessages:
    def __init__(self, capture):
        self._capture = capture

    async def create(self, **kwargs):
        # Capture the user content blocks so the test can inspect the prompt.
        msgs = kwargs.get("messages", [])
        self._capture["content"] = msgs[0].get("content", []) if msgs else []
        return _FakeResp(json.dumps(_FAKE_SCORE))


class _FakeClient:
    def __init__(self, capture):
        self.messages = _FakeMessages(capture)


def _context_text(capture):
    """The single REPORT CONTEXT text block sent to Claude."""
    for c in capture.get("content", []):
        if c.get("type") == "text" and "REPORT CONTEXT" in c.get("text", ""):
            return c["text"]
    return ""


# ── _format_curated_answers (pure) ──────────────────────────────────────────
def test_format_curated_answers_humanizes_and_skips_null():
    out = _format_curated_answers({
        "flames_visible": True,
        "debris_clearing_needed": False,
        "water_depth": "knee-high",
        "needs": ["food_water", "shelter"],
        "blank": None,
        "empty_list": [],
    })
    assert "Flames Visible: Yes" in out
    assert "Debris Clearing Needed: No" in out
    assert "Water Depth: knee-high" in out
    assert "Needs: Food Water, Shelter" in out
    assert "Blank" not in out          # null skipped
    assert "Empty List" not in out      # empty list skipped


def test_format_curated_answers_empty_returns_blank():
    assert _format_curated_answers(None) == ""
    assert _format_curated_answers({}) == ""
    assert _format_curated_answers("not a dict") == ""


# ── score() wiring with form_data ────────────────────────────────────────────
async def test_form_data_reaches_prompt_and_is_flagged(monkeypatch):
    capture = {}
    scorer = TruthScorer()
    monkeypatch.setattr(scorer, "_get_client", lambda: _FakeClient(capture))

    result = await scorer.score(
        report_id="r-curated",
        infrastructure_type="RESIDENTIAL",
        severity="SEVERE",
        description="street is flooded",
        transcription=None,
        report_dt=datetime(2026, 6, 1, tzinfo=timezone.utc),
        user_image_path=None,
        satellite_data={},
        form_data={"flames_visible": False, "water_depth": "knee-high", "blank": None},
        crisis_type="FLOOD",
        form_pack_id="pk-flood",
        form_pack_version=3,
    )

    ctx = _context_text(capture)
    assert "COMMUNITY-CURATED GROUND TRUTH" in ctx
    assert "Water Depth: knee-high" in ctx
    assert "Flames Visible: No" in ctx
    assert "Blank:" not in ctx                      # null answer skipped
    assert "confirmed FLOOD event" in ctx            # crisis_type woven into the block
    assert "Confirmed crisis type:  FLOOD" in ctx    # context line
    assert "pk-flood v3" in ctx                      # pack provenance tag

    assert result["form_data_considered"] is True
    assert any("Community-curated crisis-form answers" in f
               for f in result["key_findings"])
    # original findings preserved (note appended, not replaced)
    assert "satellite confirms residential area" in result["key_findings"]


async def test_no_form_data_no_curated_block(monkeypatch):
    capture = {}
    scorer = TruthScorer()
    monkeypatch.setattr(scorer, "_get_client", lambda: _FakeClient(capture))

    result = await scorer.score(
        report_id="r-default",
        infrastructure_type="RESIDENTIAL",
        severity="MINOR",
        description="default flow report",
        transcription=None,
        report_dt=datetime(2026, 6, 1, tzinfo=timezone.utc),
        user_image_path=None,
        satellite_data={},
        # no form_data / crisis_type → default flow
    )

    ctx = _context_text(capture)
    assert "COMMUNITY-CURATED GROUND TRUTH" not in ctx
    assert "Confirmed crisis type" not in ctx
    assert result["form_data_considered"] is False
    # findings untouched
    assert result["key_findings"] == _FAKE_SCORE["key_findings"]
