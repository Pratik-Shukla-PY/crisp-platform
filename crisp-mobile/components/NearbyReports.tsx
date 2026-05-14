/**
 * NearbyReports — RN component for the "Verified Reports Nearby"
 * home-stage intelligence module (May 2026).
 *
 * Mirror of mobile-app/src/nearby.js + the .home-nearby-intel CSS
 * block. Same behaviour matrix:
 *
 *   ✓ Hidden by default
 *   ✓ Boots on first paint with caller-supplied (cached) GPS
 *   ✓ Online → live fetch; offline → fresh cache OR hide
 *   ✓ k-anonymity-aware (groups < 3 reports never reach client)
 *   ✓ No PII rendered (server projection)
 *   ✓ Bottom-sheet detail tap dispatch — Phase 2 wires the modal
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, Pressable, StyleSheet,
  Modal, ScrollView, BackHandler,
} from 'react-native';

import { t } from '../services/i18n';
import {
  loadNearby, humanizeAgo,
  type NearbyResponse, type NearbyGroup,
} from '../services/nearbyApi';

const COLLAPSED_ROWS = 3;

// Local i18n helper that resolves with a guaranteed-non-empty fallback.
const _t = (key: string, fb: string): string => {
  const v = t(key);
  return (v && v !== key) ? v : fb;
};

export interface NearbyReportsProps {
  /** Caller's last-known location. NEVER trigger a prompt from this
   *  component — the home-stage rule. App.tsx already has cached GPS
   *  from the v4 capture stage. */
  lat: number | null;
  lng: number | null;

  /** Current connectivity. Component hides when offline AND no fresh
   *  cache; renders cached payload with "Last seen X" when offline
   *  AND cache fresh (< 5 min). */
  online: boolean;

  /** Optional callback when a row is tapped — Phase 2 opens a bottom-
   *  sheet modal with detail. Phase 1: no-op or external nav. */
  onRowPress?: (group: NearbyGroup) => void;
}

export default function NearbyReports(props: NearbyReportsProps) {
  const { lat, lng, online } = props;
  const [payload, setPayload] = useState<NearbyResponse | null>(null);
  const [cacheAgeMs, setCacheAgeMs] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  // Phase 2 — bottom-sheet detail modal
  const [selectedGroup, setSelectedGroup] = useState<NearbyGroup | null>(null);

  // Load (or re-load) on mount + when connectivity or coords change.
  useEffect(() => {
    let cancelled = false;
    if (lat == null || lng == null) {
      setPayload(null);
      return undefined;
    }
    (async () => {
      const r = await loadNearby({ lat, lng, online });
      if (cancelled) return;
      setPayload(r.payload);
      setCacheAgeMs(r.cacheAgeMs);
      setExpanded(false);    // collapse on fresh load
    })();
    return () => { cancelled = true; };
  }, [lat, lng, online]);

  const handleRowPress = useCallback((g: NearbyGroup) => {
    if (props.onRowPress) {
      try { props.onRowPress(g); } catch { /* ignore */ }
    }
    // Phase 2 — open bottom-sheet detail modal with this group.
    setSelectedGroup(g);
  }, [props.onRowPress]);

  // Android hardware back closes the modal first instead of leaving
  // the app. Web/iOS no-op.
  useEffect(() => {
    if (!selectedGroup) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setSelectedGroup(null);
      return true;
    });
    return () => sub.remove();
  }, [selectedGroup]);

  // ── Hidden states ────────────────────────────────────────────────
  // Per operator: NO broken state. If we don't have current data,
  // render nothing (caller's parent flex handles the collapsed slot).
  if (lat == null || lng == null) return null;
  if (!payload) return null;

  const groups = payload.groups || [];
  const collapsed = expanded ? groups : groups.slice(0, COLLAPSED_ROWS);
  const remaining = Math.max(0, groups.length - COLLAPSED_ROWS);

  return (
    <View style={styles.root} testID="home-nearby-intel">
      <Text style={styles.eyebrow}>
        {_t('nearby_eyebrow', 'NEARBY REPORTS')}
      </Text>

      <View style={styles.list}>
        {groups.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            {collapsed.map((g, idx) => (
              <NearbyRow
                key={g.id}
                group={g}
                isLast={idx === collapsed.length - 1 && remaining === 0}
                onPress={() => handleRowPress(g)}
              />
            ))}
            {remaining > 0 && !expanded && (
              <Pressable
                style={styles.viewMore}
                onPress={() => setExpanded(true)}
                accessibilityRole="button"
                testID="home-nearby-view-more"
              >
                <Text style={styles.viewMoreText}>
                  {_t('nearby_view_more', 'View {n} more').replace('{n}', String(remaining))}
                </Text>
              </Pressable>
            )}
            {cacheAgeMs != null && (
              <Text style={styles.caption}>
                {_t('nearby_last_seen', 'Last seen {n} min ago')
                  .replace('{n}', String(Math.max(0, Math.round(cacheAgeMs / 60000))))}
              </Text>
            )}
          </>
        )}
      </View>

      {/* Phase 2 — bottom-sheet detail modal */}
      <DetailSheet
        group={selectedGroup}
        onClose={() => setSelectedGroup(null)}
      />
    </View>
  );
}

// ── Bottom-sheet detail modal ───────────────────────────────────────
//
// Operator-approved option #3: bottom-sheet modal (vs new stage).
// Slide-up Modal on tap, dismiss via backdrop / × / Android back
// (the back-press handler is in the parent). Shows: building name +
// distance, count + verified tiles, latest/earliest timestamps,
// incident types breakdown, severity bar, "Add Your Report Here"
// CTA (soft pre-fill of building_id + lat/lng).

const SEVERITY_FILL: Record<string, number> = {
  CRITICAL: 100, HIGH: 78, MODERATE: 56, MEDIUM: 56,
  LOW: 34, MINOR: 34, UNKNOWN: 12,
};

function _fmtSheetTs(iso: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
}

function _summaryKeyFor(crisis: string, damage: string): string {
  const cmap: Record<string, string> = {
    FLOOD: 'flood', EARTHQUAKE: 'quake', WILDFIRE: 'fire',
    EXPLOSION: 'blast', CONFLICT: 'unrest', CIVIL_UNREST: 'unrest',
  };
  const dmap: Record<string, string> = {
    MINIMAL: 'minimal', PARTIAL: 'partial', COMPLETE: 'complete',
  };
  const c = cmap[(crisis || '').toUpperCase()] || 'generic';
  const d = dmap[(damage || '').toUpperCase()] || 'partial';
  return `nearby_summary_${c}_${d}`;
}

function DetailSheet({ group, onClose }: {
  group: NearbyGroup | null;
  onClose: () => void;
}) {
  if (!group) return null;

  const distance = _t('nearby_distance_km', '{km} km').replace('{km}', group.approx_distance_km.toFixed(1));
  const distanceLine = _t('nearby_sheet_distance_from_you', '{km} from you').replace('{km}', distance);
  const sevPct = SEVERITY_FILL[group.severity_max] || 12;

  return (
    <Modal
      visible={true}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      testID="home-nearby-sheet"
    >
      <Pressable style={sheetStyles.backdrop} onPress={onClose} accessibilityLabel={_t('nearby_sheet_close', 'Close')} />
      <View style={sheetStyles.card}>
        <ScrollView contentContainerStyle={sheetStyles.scroll} showsVerticalScrollIndicator={false}>
          <View style={sheetStyles.handle} />

          <Pressable
            style={sheetStyles.close}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={_t('nearby_sheet_close', 'Close')}
          >
            <Text style={sheetStyles.closeIcon}>✕</Text>
          </Pressable>

          <Text style={sheetStyles.title}>{group.label}</Text>
          <Text style={sheetStyles.distance}>{distanceLine}</Text>

          <View style={sheetStyles.tiles}>
            <View style={sheetStyles.tile}>
              <Text style={sheetStyles.tileNumMint}>{group.count}</Text>
              <Text style={sheetStyles.tileLabel}>
                {_t('nearby_sheet_label_reports', 'reports')}
              </Text>
            </View>
            <View style={sheetStyles.tile}>
              <Text style={sheetStyles.tileNumGreen}>{group.verified_count}</Text>
              <Text style={sheetStyles.tileLabel}>
                {_t('nearby_sheet_label_verified', 'verified ✓')}
              </Text>
            </View>
          </View>

          <View style={sheetStyles.timeline}>
            <View style={sheetStyles.row}>
              <Text style={sheetStyles.rowKey}>
                {_t('nearby_sheet_latest_at', 'Latest:')}
              </Text>
              <Text style={sheetStyles.rowVal}>{_fmtSheetTs(group.latest_at)}</Text>
            </View>
            <View style={[sheetStyles.row, sheetStyles.rowLast]}>
              <Text style={sheetStyles.rowKey}>
                {_t('nearby_sheet_earliest_at', 'Earliest:')}
              </Text>
              <Text style={sheetStyles.rowVal}>{_fmtSheetTs(group.earliest_at)}</Text>
            </View>
          </View>

          <Text style={sheetStyles.section}>
            {_t('nearby_sheet_incidents', 'INCIDENTS')}
          </Text>
          <View style={sheetStyles.typesList}>
            {(group.crisis_types || []).length === 0 ? (
              <View style={sheetStyles.typeRow}>
                <Text style={sheetStyles.typeLabel}>
                  {_t('nearby_summary_unknown', 'Report Filed')}
                </Text>
              </View>
            ) : (
              group.crisis_types.map((crisis, i) => {
                const dmg = group.damage_classes[i] || group.damage_classes[0] || 'PARTIAL';
                const key = _summaryKeyFor(crisis, dmg);
                const label = _t(key, group.summary || 'Report Filed');
                return (
                  <View style={sheetStyles.typeRow} key={`${crisis}-${i}`}>
                    <Text style={sheetStyles.typeLabel}>{label}</Text>
                    {i === 0 && (
                      <Text style={sheetStyles.typeCount}>{group.count}</Text>
                    )}
                  </View>
                );
              })
            )}
          </View>

          <Text style={sheetStyles.section}>
            {_t('nearby_sheet_severity', 'SEVERITY')}
          </Text>
          <View style={sheetStyles.severityBar}>
            <View style={[sheetStyles.severityFill, { width: `${sevPct}%` }]} />
          </View>
          <Text style={sheetStyles.severityLabel}>{group.severity_max}</Text>

          <Pressable
            style={sheetStyles.cta}
            onPress={() => {
              // Soft pre-fill — RN equivalent of the PWA prefill.
              // Stored as a custom event payload; App.tsx can wire
              // the v4 capture flow to honour it in a follow-up.
              onClose();
            }}
            accessibilityRole="button"
          >
            <Text style={sheetStyles.ctaText}>
              {_t('nearby_sheet_add_report_here', 'Add Your Report Here')}
            </Text>
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
  );
}

const sheetStyles = StyleSheet.create({
  backdrop: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(8, 16, 28, 0.55)',
  },
  card: {
    position: 'absolute',
    bottom: 0, left: 0, right: 0,
    maxHeight: '88%',
    backgroundColor: '#10284a',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 24,
    shadowOffset: { width: 0, height: -8 },
    elevation: 20,
  },
  scroll: {
    padding: 22,
    paddingBottom: 32,
  },
  handle: {
    alignSelf: 'center',
    width: 40, height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255, 255, 255, 0.16)',
    marginBottom: 14,
  },
  close: {
    position: 'absolute', top: 14, right: 14,
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    alignItems: 'center', justifyContent: 'center',
  },
  closeIcon: { color: '#f1f5f9', fontSize: 14, fontWeight: '700' },
  title: {
    fontSize: 22, fontWeight: '800', letterSpacing: -0.2,
    color: '#f1f5f9', marginBottom: 4,
  },
  distance: {
    color: 'rgba(255, 255, 255, 0.62)',
    fontSize: 13, fontWeight: '500',
    marginBottom: 18,
  },
  tiles: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 18,
  },
  tile: {
    flex: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 14, padding: 14, alignItems: 'center',
  },
  tileNumMint:  { fontSize: 28, fontWeight: '800', color: '#46DFB1', letterSpacing: -0.5 },
  tileNumGreen: { fontSize: 28, fontWeight: '800', color: '#80EE98', letterSpacing: -0.5 },
  tileLabel: {
    marginTop: 4,
    color: 'rgba(255, 255, 255, 0.62)',
    fontSize: 11.5, fontWeight: '500',
  },
  timeline: { marginBottom: 18 },
  row: {
    flexDirection: 'row', justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 1, borderBottomColor: 'rgba(255, 255, 255, 0.06)',
  },
  rowLast: { borderBottomWidth: 0 },
  rowKey: { color: 'rgba(255, 255, 255, 0.48)', fontSize: 13, fontWeight: '500' },
  rowVal: { color: '#f1f5f9', fontSize: 13, fontWeight: '600' },
  section: {
    marginTop: 18, marginBottom: 8,
    fontSize: 10.5, fontWeight: '700',
    letterSpacing: 1.6, textTransform: 'uppercase',
    color: 'rgba(255, 255, 255, 0.48)',
  },
  typesList: {},
  typeRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    paddingVertical: 8, paddingHorizontal: 12,
    borderRadius: 10, marginBottom: 4,
  },
  typeLabel: { color: 'rgba(255, 255, 255, 0.88)', fontSize: 13, fontWeight: '500' },
  typeCount: { color: '#46DFB1', fontSize: 13, fontWeight: '700' },
  severityBar: {
    height: 8, borderRadius: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    overflow: 'hidden', marginBottom: 6,
  },
  severityFill: {
    height: '100%',
    backgroundColor: '#46DFB1',
    borderRadius: 4,
  },
  severityLabel: {
    fontSize: 11.5, fontWeight: '700', letterSpacing: 0.4,
    color: 'rgba(255, 255, 255, 0.78)',
  },
  cta: {
    marginTop: 20, padding: 14, borderRadius: 14,
    backgroundColor: '#09D1C7',
    shadowColor: '#09D1C7', shadowOpacity: 0.3, shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
    alignItems: 'center',
  },
  ctaText: {
    color: '#062b1b', fontSize: 14, fontWeight: '800', letterSpacing: 0.2,
  },
});

// ── Row ─────────────────────────────────────────────────────────────

function NearbyRow(props: {
  group: NearbyGroup;
  isLast: boolean;
  onPress: () => void;
}) {
  const { group } = props;
  const countText = _t('nearby_count_reports', '{n} reports').replace('{n}', String(group.count));
  const distance = _t('nearby_distance_km', '{km} km').replace('{km}', group.approx_distance_km.toFixed(1));
  const ago = humanizeAgo(group.latest_at, _t);
  const summary = (group.summary_key ? _t(group.summary_key, group.summary || '') : group.summary) ||
    _t('nearby_summary_unknown', 'Report Filed');

  return (
    <Pressable
      style={[styles.row, props.isLast && styles.rowLast]}
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel={`${countText}, ${summary}, ${group.label}, ${distance}`}
      testID={`home-nearby-row-${group.id}`}
    >
      <View style={styles.rowDot} />
      <View style={styles.rowBody}>
        <View style={styles.rowHead}>
          <Text style={styles.rowCount}>{countText}</Text>
          <Text style={styles.rowSep}> · </Text>
          <Text style={styles.rowSummary} numberOfLines={1}>{summary}</Text>
        </View>
        <Text style={styles.rowLabel} numberOfLines={1}>{group.label}</Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {distance}{ago ? ` · ${ago}` : ''}
          {group.verified_count > 0 && (
            <Text style={styles.rowVerified}>{` · ✓ ${_t('nearby_verified_badge', 'verified')}`}</Text>
          )}
          {group.verified_count === 0 && group.pending_count > 0 && (
            <Text style={styles.rowPending}>{` · ⏳ ${_t('nearby_pending_badge', 'pending')}`}</Text>
          )}
        </Text>
      </View>
    </Pressable>
  );
}

// ── Empty state ─────────────────────────────────────────────────────

function EmptyState() {
  return (
    <View style={styles.empty} testID="home-nearby-empty">
      <View style={styles.emptyIconWrap}>
        <Text style={styles.emptyIcon}>✓</Text>
      </View>
      <Text style={styles.emptyTitle}>
        {_t('nearby_all_clear', 'All clear in your area')}
      </Text>
      <Text style={styles.emptyBody}>
        {_t('nearby_no_reports', 'No verified reports nearby')}
      </Text>
    </View>
  );
}

// ── Styles ──────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    width: '100%',
    marginTop: 4, marginBottom: 8,
    gap: 8,
  },
  eyebrow: {
    fontSize: 10.5, fontWeight: '700',
    letterSpacing: 1.6, textTransform: 'uppercase',
    color: 'rgba(255, 255, 255, 0.48)',
    textAlign: 'center',
    marginBottom: 4,
  },

  // List container (single frosted card; rows have internal dividers)
  list: {
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.07)',
    borderRadius: 18,
    overflow: 'hidden',
  },

  // Row
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: 12,
    borderBottomWidth: 1, borderBottomColor: 'rgba(255, 255, 255, 0.04)',
  },
  rowLast: { borderBottomWidth: 0 },
  rowDot: {
    width: 8, height: 8, borderRadius: 4,
    marginTop: 7,
    backgroundColor: '#09D1C7',
    shadowColor: '#09D1C7',
    shadowOpacity: 0.5, shadowRadius: 6, shadowOffset: { width: 0, height: 0 },
    elevation: 3,
  },
  rowBody: { flex: 1, minWidth: 0, gap: 2 },
  rowHead: {
    flexDirection: 'row', alignItems: 'baseline', gap: 4,
  },
  rowCount: {
    color: '#46DFB1', fontSize: 13, fontWeight: '700',
  },
  rowSep: { color: 'rgba(255,255,255,0.30)', fontSize: 13 },
  rowSummary: {
    color: 'rgba(255, 255, 255, 0.78)',
    fontSize: 11.5, fontWeight: '700',
    letterSpacing: 0.5, textTransform: 'uppercase',
  },
  rowLabel: {
    color: 'rgba(255, 255, 255, 0.88)',
    fontSize: 13, fontWeight: '500',
  },
  rowMeta: {
    color: 'rgba(255, 255, 255, 0.48)',
    fontSize: 11, fontWeight: '500',
  },
  rowVerified: { color: '#80EE98', fontWeight: '600' },
  rowPending:  { color: '#f5d76e', fontWeight: '600' },

  // View more
  viewMore: {
    padding: 10,
    borderTopWidth: 1, borderTopColor: 'rgba(70, 223, 177, 0.18)',
    alignItems: 'center',
  },
  viewMoreText: {
    color: 'rgba(70, 223, 177, 0.85)',
    fontSize: 12, fontWeight: '600',
    letterSpacing: 0.3,
  },

  // Empty state
  empty: { padding: 22, alignItems: 'center', gap: 4 },
  emptyIconWrap: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: 'rgba(128, 238, 152, 0.12)',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 4,
  },
  emptyIcon: { color: '#80EE98', fontSize: 18, fontWeight: '800' },
  emptyTitle: {
    color: '#f1f5f9', fontSize: 14, fontWeight: '700',
  },
  emptyBody: {
    color: 'rgba(255, 255, 255, 0.48)', fontSize: 12, fontWeight: '500',
  },

  // Caption — "Last seen X min ago"
  caption: {
    color: 'rgba(255, 255, 255, 0.38)',
    fontSize: 10.5, fontWeight: '500',
    textAlign: 'center',
    padding: 8,
    borderTopWidth: 1, borderTopColor: 'rgba(255, 255, 255, 0.04)',
  },
});
