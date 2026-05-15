// ╭──────────────────────────────────────────────────────────────────╮
// │ AUTO-GENERATED — DO NOT EDIT BY HAND                            │
// │ Source: shared/tier-config.json                                  │
// │ Regenerate with: node scripts/sync-tier-config.mjs               │
// │ CI verifies with: node scripts/sync-tier-config.mjs --check      │
// ╰──────────────────────────────────────────────────────────────────╯

(function () {
    'use strict';
    const TIERS = [
    {
        "id": "T1_SCOUT",
        "order": 1,
        "emoji": "🌱",
        "label": "Scout",
        "i18n_key": "tier_t1_scout_label",
        "color": "#86efac",
        "ring_gradient": {
            "start": "#80EE98",
            "end": "#46DFB1"
        },
        "criterion": "Default — no submissions yet"
    },
    {
        "id": "T2_SIGNAL",
        "order": 2,
        "emoji": "📣",
        "label": "Signal",
        "i18n_key": "tier_t2_signal_label",
        "color": "#93c5fd",
        "ring_gradient": {
            "start": "#46DFB1",
            "end": "#09D1C7"
        },
        "criterion": "≥1 report submitted (any status) — one-time participation badge"
    },
    {
        "id": "T3_CHANGEMAKER",
        "order": 3,
        "emoji": "⚡",
        "label": "Changemaker",
        "i18n_key": "tier_t3_changemaker_label",
        "color": "#fbbf24",
        "ring_gradient": {
            "start": "#09D1C7",
            "end": "#15919B"
        },
        "criterion": "≥1 report dispatched (RESPONDING or RESOLVED) — analyst action required"
    },
    {
        "id": "T4_LIFEKEEPER",
        "order": 4,
        "emoji": "🦸",
        "label": "Lifekeeper",
        "i18n_key": "tier_t4_lifekeeper_label",
        "color": "#f0abfc",
        "ring_gradient": {
            "start": "#fcd34d",
            "end": "#f59e0b"
        },
        "criterion": "sum(lives_impacted) ≥ 1 across the device's reports — downstream impact required"
    }
];
    const TIERS_BY_ID = TIERS.reduce((acc, t) => { acc[t.id] = t; return acc; }, {});
    const LEGACY_ALIASES = {
    "$comment": "Pre-V4 badge_level values mapped to the V4 ladder. Used by clients that fetch /profile from a backend mid-rollout where the device row still carries the legacy value. NEVER surfaces as the dashboard's reporter_tier (the Phase 1.6 join filters to V4 ids only — see _attach_reporter_tier).",
    "NEWCOMER": "T1_SCOUT",
    "HELPER": "T2_SIGNAL",
    "CONTRIBUTOR": "T3_CHANGEMAKER",
    "TRUSTED": "T4_LIFEKEEPER",
    "GUARDIAN": "T3_CHANGEMAKER",
    "HERO": "T4_LIFEKEEPER"
};
    // Strip the $comment key so consumers don't see it.
    delete LEGACY_ALIASES.$comment;
    if (typeof window !== 'undefined') {
        window.CRISP_TIERS = TIERS;
        window.CRISP_TIERS_BY_ID = TIERS_BY_ID;
        window.CRISP_TIER_LEGACY_ALIASES = LEGACY_ALIASES;
    }
})();
