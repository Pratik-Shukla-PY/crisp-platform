// ╭──────────────────────────────────────────────────────────────────╮
// │ AUTO-GENERATED - DO NOT EDIT BY HAND                            │
// │ Source: shared/tier-config.json                                  │
// │ Regenerate with: node scripts/sync-tier-config.mjs               │
// │ CI verifies with: node scripts/sync-tier-config.mjs --check      │
// ╰──────────────────────────────────────────────────────────────────╯

export type TierId = "T1_SCOUT" | "T2_SIGNAL" | "T3_CHANGEMAKER" | "T4_LIFEKEEPER";

export interface TierConfig {
    id: TierId;
    order: number;
    emoji: string;
    label: string;
    i18n_key: string;
    color: string;
    ring_gradient: { start: string; end: string };
    criterion: string;
}

export const TIERS: TierConfig[] = [
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
        "criterion": "Default - no submissions yet"
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
        "criterion": "≥1 report submitted (any status) - one-time participation badge"
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
        "criterion": "≥1 report dispatched (RESPONDING or RESOLVED) - analyst action required"
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
        "criterion": "sum(lives_impacted) ≥ 1 across the device's reports - downstream impact required"
    }
] as const;

export const TIERS_BY_ID: Record<TierId, TierConfig> = TIERS.reduce(
    (acc, t) => { acc[t.id] = t; return acc; },
    {} as Record<TierId, TierConfig>,
);

export const LEGACY_TIER_ALIASES: Record<string, TierId> = {
    NEWCOMER: "T1_SCOUT",
    HELPER: "T2_SIGNAL",
    CONTRIBUTOR: "T3_CHANGEMAKER",
    TRUSTED: "T4_LIFEKEEPER",
    GUARDIAN: "T3_CHANGEMAKER",
    HERO: "T4_LIFEKEEPER",
};
