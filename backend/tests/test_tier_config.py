"""Phase 2.1 (May 2026) — backend reads from the shared canonical tier
config at `shared/tier-config.json`. Pin the contract so a future PR
that edits the JSON without regenerating PR-time outputs gets caught.
"""
from app.services import tier_config


def test_loads_four_v4_tiers():
    tiers = tier_config.all_tiers()
    assert len(tiers) == 4
    ids = [t["id"] for t in tiers]
    assert ids == ["T1_SCOUT", "T2_SIGNAL", "T3_CHANGEMAKER", "T4_LIFEKEEPER"]


def test_each_tier_has_required_keys():
    for t in tier_config.all_tiers():
        for key in ("id", "order", "emoji", "label", "i18n_key", "color", "ring_gradient", "criterion"):
            assert key in t, f"tier {t.get('id')} missing {key!r}"
        assert "start" in t["ring_gradient"] and "end" in t["ring_gradient"]


def test_tier_by_id_returns_v4_tier():
    t = tier_config.tier_by_id("T4_LIFEKEEPER")
    assert t is not None
    assert t["emoji"] == "🦸"
    assert t["label"] == "Lifekeeper"


def test_tier_by_id_translates_legacy_aliases():
    # Pre-V4 badge_level values map through legacy_aliases. A device
    # row mid-rollout still carrying "HERO" should resolve to the V4
    # Lifekeeper metadata so the LinkedIn share page renders correctly.
    for legacy, expected_v4 in [
        ("HERO", "T4_LIFEKEEPER"),
        ("GUARDIAN", "T3_CHANGEMAKER"),
        ("CONTRIBUTOR", "T3_CHANGEMAKER"),
        ("HELPER", "T2_SIGNAL"),
        ("NEWCOMER", "T1_SCOUT"),
        ("TRUSTED", "T4_LIFEKEEPER"),
    ]:
        t = tier_config.tier_by_id(legacy)
        assert t is not None, f"legacy alias {legacy!r} did not resolve"
        assert t["id"] == expected_v4, (
            f"legacy {legacy!r} should map to {expected_v4}, "
            f"got {t['id']}"
        )


def test_tier_by_id_returns_none_for_unknown():
    assert tier_config.tier_by_id("GOLD_HERO") is None
    assert tier_config.tier_by_id("") is None
    assert tier_config.tier_by_id(None) is None  # type: ignore[arg-type]


def test_label_emoji_pair_defaults_lifekeeper_for_unknown():
    """Same fallback the pre-Phase-2.1 _TIER_LABELS used in share.py —
    OG rendering must stay safe even if the config-load fails."""
    emoji, label = tier_config.label_emoji_pair("WHATEVER_NEW_TIER")
    assert (emoji, label) == ("🦸", "Lifekeeper")


def test_share_endpoint_still_uses_canonical_config():
    """Pin that the share endpoint's `_TIER_LABELS` is now sourced
    from the canonical config — not a separate hand-coded copy that
    can drift."""
    from app.api.endpoints import share
    expected = {
        t["id"]: (t["emoji"], t["label"])
        for t in tier_config.all_tiers()
    }
    assert share._TIER_LABELS == expected
