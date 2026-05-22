"""B-G — OCR multi-layer PII detection: density heuristic + spaCy NER.

These are pure-Python unit tests on the helper functions. They run
without easyocr / MediaPipe / OffscreenCanvas — fast (~1 s) and
deterministic across environments.

Layers under test:

  Layer 1 (existing, regex):  PII_PATTERNS — Aadhaar, PAN, phone,
    DOB, passport, CC, SSN, email, long ID.
  Layer 2 (B-G, density):     _density_heuristic_is_pii — catches
    handwritten / license-plate text with >= 30% digit density and
    length >= 6.
  Layer 3 (B-G, NER):         _ner_is_pii — catches handwritten
    names + missed emails via spaCy en_core_web_sm. Falls back to
    return False if spaCy isn't installed (defensive).

Both new layers are env-gated so operators can disable in
environments where the false-positive cost is too high.
"""
from __future__ import annotations

import pytest


# ── Density heuristic ──────────────────────────────────────────────────


@pytest.mark.parametrize("text,expected", [
    # License plates → SHOULD blur
    ("MH04AB1234", True),    # 8/10 digits = 80%, len 10
    ("KA-01-AB-1234", True), # 6/13 digits (47%), len 13 — borderline pass
    # Handwritten IDs → SHOULD blur
    ("123456789", True),     # all digits
    ("ABC123456", True),     # 6/9 = 67%
    ("12-34-56-789", True),  # 8/12 = 67%
    # Pure short text → NO blur (too short)
    ("ID 1", False),         # length < 6
    ("123", False),
    # Pure alphabetic — NO blur
    ("HOSPITAL", False),
    ("EXIT", False),
    ("EVACUATION ROUTE", False),
    # Mixed but low digit density — NO blur
    ("Building One", False),  # 0/12 digits
    ("Block A", False),
])
def test_density_heuristic(text, expected):
    from app.services.pii_blur import _density_heuristic_is_pii
    assert _density_heuristic_is_pii(text) is expected, (
        f"density heuristic on {text!r}: expected {expected}"
    )


def test_density_heuristic_disabled_by_env(monkeypatch):
    """When CRISP_OCR_DENSITY_ENABLED=0, layer is bypassed (always False)."""
    from app.services.pii_blur import _density_heuristic_is_pii
    monkeypatch.setenv("CRISP_OCR_DENSITY_ENABLED", "0")
    # Even an obvious license plate returns False when disabled.
    assert _density_heuristic_is_pii("MH04AB1234") is False


# ── NER layer ──────────────────────────────────────────────────────────


def test_ner_returns_false_when_spacy_missing(monkeypatch):
    """If spaCy isn't installed, _ner_is_pii silently returns False —
    never raises. Defensive contract: NER is bonus, not required."""
    from app.services import pii_blur as pb

    # Reset memoization so we re-run the import attempt.
    monkeypatch.setattr(pb, "_nlp", None)
    monkeypatch.setattr(pb, "_nlp_attempted", False)

    # Force the import path to think spaCy is unavailable.
    import builtins
    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "spacy":
            raise ImportError("simulated: spacy not installed")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    # _get_nlp must return None; downstream callers must not raise.
    assert pb._get_nlp() is None
    assert pb._ner_is_pii("John Doe") is False


def test_ner_disabled_by_env(monkeypatch):
    """CRISP_OCR_NER_ENABLED=0 → layer always returns False."""
    from app.services import pii_blur as pb

    monkeypatch.setattr(pb, "_nlp", None)
    monkeypatch.setattr(pb, "_nlp_attempted", False)
    monkeypatch.setenv("CRISP_OCR_NER_ENABLED", "0")

    assert pb._get_nlp() is None
    assert pb._ner_is_pii("John Doe") is False


def test_ner_layer_with_spacy_if_available(monkeypatch):
    """When spaCy + en_core_web_sm ARE installed, _ner_is_pii catches
    PERSON entities. If model isn't downloaded, this test is skipped
    (env-dependent — informative when it runs, harmless when it can't)."""
    from app.services import pii_blur as pb

    monkeypatch.setattr(pb, "_nlp", None)
    monkeypatch.setattr(pb, "_nlp_attempted", False)

    try:
        import spacy  # noqa: F401
    except ImportError:
        pytest.skip("spaCy not installed in this env — layer is optional.")
    nlp = pb._get_nlp()
    if nlp is None:
        pytest.skip("en_core_web_sm not downloaded — `python -m spacy download en_core_web_sm`.")

    # Classic NER test — a name should fire PERSON.
    assert pb._ner_is_pii("John Doe") is True
    # A pure landmark should NOT fire.
    assert pb._ner_is_pii("EXIT") is False


# ── Memoization ────────────────────────────────────────────────────────


def test_get_nlp_memoizes_failure(monkeypatch):
    """Once _get_nlp() determines spaCy is unavailable, subsequent
    calls return None immediately without re-attempting the import.
    Without memoization, every OCR call would pay the import error
    cost (millisecond-scale, but adds up at burst-load)."""
    from app.services import pii_blur as pb

    monkeypatch.setattr(pb, "_nlp", None)
    monkeypatch.setattr(pb, "_nlp_attempted", False)

    import builtins
    real_import = builtins.__import__
    call_count = [0]

    def counting_import(name, *args, **kwargs):
        if name == "spacy":
            call_count[0] += 1
            raise ImportError("simulated")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", counting_import)

    # 3 successive calls
    pb._get_nlp()
    pb._get_nlp()
    pb._get_nlp()

    # Import attempt fires AT MOST once.
    assert call_count[0] <= 1, (
        f"_get_nlp() must memoize the failure path; got {call_count[0]} "
        f"attempts on 3 calls"
    )
