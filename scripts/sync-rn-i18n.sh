#!/usr/bin/env bash
# scripts/sync-rn-i18n.sh — copy PWA locale JSONs into the RN companion.
#
# May 2026 — RN ↔ PWA parity Phase 0 (foundations). The PWA's
# mobile-app/src/i18n/ is the single source of truth for all
# user-facing strings across both clients. This script copies every
# JSON file there into crisp-mobile/services/i18n/ so RN never falls
# behind. Run after any i18n change on the PWA side.
#
# Idempotent. Diffs every locale; reports added / changed / removed.
#
# Usage:
#   bash scripts/sync-rn-i18n.sh                  (interactive — confirms)
#   bash scripts/sync-rn-i18n.sh --force          (no prompt)
#   bash scripts/sync-rn-i18n.sh --dry-run        (preview only)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PWA_I18N="$REPO_ROOT/mobile-app/src/i18n"
RN_I18N="$REPO_ROOT/crisp-mobile/services/i18n"

if [ ! -d "$PWA_I18N" ]; then
    echo "ERROR: PWA i18n directory not found at $PWA_I18N" >&2
    exit 1
fi
if [ ! -d "$RN_I18N" ]; then
    echo "ERROR: RN i18n directory not found at $RN_I18N" >&2
    exit 1
fi

DRY_RUN=0
FORCE=0
ALLOW_KEY_LOSS=0
for arg in "$@"; do
    case "$arg" in
        --dry-run)        DRY_RUN=1 ;;
        --force)          FORCE=1 ;;
        --allow-key-loss) ALLOW_KEY_LOSS=1 ;;
        *) echo "Unknown flag: $arg" >&2; exit 2 ;;
    esac
done

# ── Key-loss guard (Jun 2026) ────────────────────────────────────────────────
# This script REPLACES the RN packs with the PWA packs. If the RN packs have
# accumulated keys the PWA source lacks, a sync silently DELETES them — which
# broke the V4CaptureScreen jest contract (22 failures) when
# v4_cap_tips_eyebrow / v4_cap_tip_impact existed only on the RN side.
# Compare en.json key sets BEFORE any copy: RN-only keys abort the sync (even
# with --force — that flag only skips the interactive prompt). Fix by adding
# the keys to mobile-app/src/i18n/ (the canonical registry for BOTH clients)
# or deleting them from the RN packs; --allow-key-loss overrides deliberately.
RN_ONLY_KEYS=$(jq -r --slurpfile pwa "$PWA_I18N/en.json" \
    '(keys - ($pwa[0] | keys)) | map(select(. != "__meta__")) | .[]' \
    "$RN_I18N/en.json")
if [ -n "$RN_ONLY_KEYS" ] && [ "$ALLOW_KEY_LOSS" -eq 0 ]; then
    echo "✗ ABORT: the RN packs contain keys missing from the PWA source." >&2
    echo "  Syncing would permanently DELETE these keys from the RN packs:" >&2
    # SC2001-clean line prefixing: prefix the first line, then replace every
    # newline with newline + prefix (no sed subshell needed).
    echo "    - ${RN_ONLY_KEYS//$'\n'/$'\n'    - }" >&2
    echo "" >&2
    echo "  Fix: add them to mobile-app/src/i18n/*.json (all 22 locales — the" >&2
    echo "  canonical string registry for both clients), or delete them from" >&2
    echo "  crisp-mobile/services/i18n/ if truly dead. Re-run after." >&2
    echo "  To proceed anyway (data loss!): --allow-key-loss" >&2
    exit 1
fi

# May 2026 — SC2012 fix: `ls` output isn't safe to parse when filenames
# contain spaces / newlines / special chars. `find` is the deterministic
# replacement; -mindepth 1 -maxdepth 1 emulates a flat directory listing,
# -type f matches only regular files, -name "*.json" filters to locales.
# Piping to `wc -l` of `-print` (newline-terminated) is safe for our
# repo's filenames (no spaces/newlines), but the migration is the
# permanent shell-hygiene fix per the no-suppression policy.
echo "PWA  → $PWA_I18N ($(find "$PWA_I18N" -mindepth 1 -maxdepth 1 -type f -name '*.json' 2>/dev/null | wc -l | tr -d ' ') locales, $(jq -r 'keys | length' "$PWA_I18N/en.json") keys)"
echo "RN   → $RN_I18N ($(find "$RN_I18N" -mindepth 1 -maxdepth 1 -type f -name '*.json' 2>/dev/null | wc -l | tr -d ' ') locales, $(jq -r 'keys | length' "$RN_I18N/en.json") keys)"
echo

ADDED=()
CHANGED=()
UNCHANGED=()

for src in "$PWA_I18N"/*.json; do
    locale=$(basename "$src")
    dst="$RN_I18N/$locale"
    if [ ! -f "$dst" ]; then
        ADDED+=("$locale")
    elif ! cmp -s "$src" "$dst"; then
        CHANGED+=("$locale")
    else
        UNCHANGED+=("$locale")
    fi
done

# Note any locales present in RN but missing from PWA — those would be
# orphan files (probably stale). Don't auto-delete; just warn.
ORPHANS=()
for dst in "$RN_I18N"/*.json; do
    locale=$(basename "$dst")
    src="$PWA_I18N/$locale"
    [ -f "$src" ] || ORPHANS+=("$locale")
done

echo "Summary:"
echo "  to add:       ${#ADDED[@]}    ${ADDED[*]:-<none>}"
echo "  to update:    ${#CHANGED[@]}    ${CHANGED[*]:-<none>}"
echo "  unchanged:    ${#UNCHANGED[@]}"
if [ "${#ORPHANS[@]}" -gt 0 ]; then
    echo "  orphan in RN:  ${#ORPHANS[@]}    ${ORPHANS[*]} (review manually)"
fi
echo

if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] no files written."
    exit 0
fi

if [ "$FORCE" -eq 0 ] && [ "$(( ${#ADDED[@]} + ${#CHANGED[@]} ))" -gt 0 ]; then
    printf "Proceed? [y/N] "
    read -r ans
    case "$ans" in [Yy]*) ;; *) echo "aborted."; exit 0 ;; esac
fi

for locale in "${ADDED[@]+"${ADDED[@]}"}" "${CHANGED[@]+"${CHANGED[@]}"}"; do
    cp "$PWA_I18N/$locale" "$RN_I18N/$locale"
    echo "  ✓ wrote $locale"
done

echo
echo "done. Sync complete: $((${#ADDED[@]} + ${#CHANGED[@]})) files written, $(jq -r 'keys | length' "$RN_I18N/en.json") keys per locale."
echo "Next: bump RN i18n.ts LOCALES array if new locales were added."
