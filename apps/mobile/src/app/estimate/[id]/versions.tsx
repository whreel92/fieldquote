/**
 * Estimate version history + diff (§Phase 5.8).
 *
 * Loads the estimate to learn its job, then lists every version for that
 * job (newest first). The version this screen was opened from is marked
 * CURRENT. Tap two versions — or "Compare with current" on any row — and
 * the diff renders below: added lines (green), removed lines (red,
 * strikethrough), changed lines (before → after qty/total), and the
 * totals moving from → to. Superseded versions are read-only.
 */

import { colors, radii, spacing, touchTarget, typography } from '@fieldquote/ui';
import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AlertTriangle, ArrowRight, Check, ChevronLeft, Lock } from 'lucide-react-native';
import { useMemo, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EquipmentLabel, HeaderBand } from '@/components/header-band';
import { Button, Card } from '@/components/ui';
import { api, ApiError, type EstimateSummary } from '@/lib/api';

type DiffLine = { description: string; line_type: string; qty: string; total: string };
type DiffChange = { before: DiffLine; after: DiffLine };
type DiffResult = {
  from_version: number;
  to_version: number;
  added: DiffLine[];
  removed: DiffLine[];
  changed: DiffChange[];
  totals: { from: string; to: string };
};

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  approved: 'Approved',
  superseded: 'Superseded',
  generation_failed: 'Failed',
};

const STATUS_COLOR: Record<string, string> = {
  draft: colors.status.estimating,
  approved: colors.success,
  superseded: colors.textMuted,
  generation_failed: colors.danger,
};

function numeric(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
}

function money(value: unknown): string {
  const n = numeric(value);
  if (!Number.isFinite(n)) return '—';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function qtyText(value: unknown): string {
  const n = numeric(value);
  return Number.isFinite(n) ? String(n) : '—';
}

function dateText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Defensive parse of the diff envelope — the client type is untyped JSON. */
function parseDiffLine(raw: unknown): DiffLine {
  const rec = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    description: typeof rec['description'] === 'string' ? rec['description'] : '—',
    line_type: typeof rec['line_type'] === 'string' ? rec['line_type'] : 'standard',
    qty: typeof rec['qty'] === 'string' ? rec['qty'] : String(rec['qty'] ?? ''),
    total: typeof rec['total'] === 'string' ? rec['total'] : String(rec['total'] ?? ''),
  };
}

function parseDiff(raw: Record<string, unknown>): DiffResult {
  const totalsRec =
    raw['totals'] && typeof raw['totals'] === 'object'
      ? (raw['totals'] as Record<string, unknown>)
      : {};
  const changes = Array.isArray(raw['changed']) ? raw['changed'] : [];
  return {
    from_version: Number.isFinite(numeric(raw['from_version'])) ? numeric(raw['from_version']) : 0,
    to_version: Number.isFinite(numeric(raw['to_version'])) ? numeric(raw['to_version']) : 0,
    added: (Array.isArray(raw['added']) ? raw['added'] : []).map(parseDiffLine),
    removed: (Array.isArray(raw['removed']) ? raw['removed'] : []).map(parseDiffLine),
    changed: changes.map((entry) => {
      const rec = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
      return { before: parseDiffLine(rec['before']), after: parseDiffLine(rec['after']) };
    }),
    totals: {
      from:
        typeof totalsRec['from'] === 'string' ? totalsRec['from'] : String(totalsRec['from'] ?? ''),
      to: typeof totalsRec['to'] === 'string' ? totalsRec['to'] : String(totalsRec['to'] ?? ''),
    },
  };
}

export default function EstimateVersionsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  /** Up to two selected estimate ids, in tap order. */
  const [selected, setSelected] = useState<string[]>([]);

  const estimateQuery = useQuery({
    queryKey: ['estimate', id],
    queryFn: () => api.estimates.get(id),
    enabled: Boolean(id),
  });
  const jobId = estimateQuery.data?.job_id;

  const listQuery = useQuery({
    queryKey: ['estimates', jobId],
    queryFn: () => api.estimates.listForJob(jobId as string),
    enabled: Boolean(jobId),
  });

  const versions = useMemo(
    () => [...(listQuery.data ?? [])].sort((a, b) => b.version - a.version),
    [listQuery.data],
  );
  const byId = useMemo(() => new Map(versions.map((v) => [v.id, v])), [versions]);

  /** Diff always runs older → newer so added/removed read forward in time. */
  const diffPair = useMemo(() => {
    if (selected.length !== 2) return null;
    const [a, b] = [byId.get(selected[0] as string), byId.get(selected[1] as string)];
    if (!a || !b) return null;
    return a.version <= b.version ? ([a, b] as const) : ([b, a] as const);
  }, [selected, byId]);

  const diffQuery = useQuery({
    queryKey: ['estimate-diff', diffPair?.[0]?.id, diffPair?.[1]?.id],
    queryFn: async () => parseDiff(await api.estimates.diff(diffPair![0].id, diffPair![1].id)),
    enabled: Boolean(diffPair),
  });

  const toggleSelect = (versionId: string) => {
    setSelected((prev) => {
      if (prev.includes(versionId)) return prev.filter((v) => v !== versionId);
      if (prev.length >= 2) return [prev[1] as string, versionId];
      return [...prev, versionId];
    });
  };

  const compareWithCurrent = (versionId: string) => {
    setSelected(versionId === id ? [versionId] : [versionId, id]);
  };

  const goBack = () => {
    if (router.canGoBack()) router.back();
  };

  const hasSuperseded = versions.some((v) => v.status === 'superseded');
  const loading = estimateQuery.isPending || (Boolean(jobId) && listQuery.isPending);
  const failed = estimateQuery.isError || listQuery.isError;

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <View style={{ height: insets.top, backgroundColor: colors.ink }} />
      <View style={styles.backStrip}>
        <Pressable
          onPress={goBack}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={({ pressed }) => [styles.backButton, pressed && { opacity: 0.7 }]}
        >
          <ChevronLeft size={20} color={colors.textOnInk} />
          <Text style={styles.backText}>Back</Text>
        </Pressable>
      </View>
      <HeaderBand
        eyebrow="ESTIMATE"
        title="Version history"
        meta={
          versions.length > 0
            ? `${versions.length} version${versions.length === 1 ? '' : 's'}`
            : undefined
        }
      />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + spacing.xxl }]}
      >
        {loading ? (
          <Text style={styles.mutedCenter}>Loading versions…</Text>
        ) : failed ? (
          <Card>
            <View style={styles.iconTitleRow}>
              <AlertTriangle size={22} color={colors.warning} />
              <Text style={styles.blockTitle}>Could not load version history</Text>
            </View>
            <Text style={styles.bodyText}>
              {estimateQuery.error instanceof ApiError
                ? estimateQuery.error.message
                : listQuery.error instanceof ApiError
                  ? listQuery.error.message
                  : 'Check your connection and try again.'}
            </Text>
            <Button
              title="Try again"
              onPress={() => {
                void estimateQuery.refetch();
                void listQuery.refetch();
              }}
            />
          </Card>
        ) : versions.length === 0 ? (
          <Card>
            <Text style={styles.blockTitle}>No versions yet</Text>
            <Text style={styles.bodyText}>
              Versions appear here once this job has estimates. Editing an approved estimate forks a
              new draft version automatically.
            </Text>
          </Card>
        ) : (
          <>
            <Text style={styles.leadText}>
              Tap two versions to compare them, or jump straight to a comparison with the current
              version.
            </Text>
            {hasSuperseded ? (
              <View style={styles.readOnlyNote}>
                <Lock size={16} color={colors.textMuted} />
                <Text style={styles.readOnlyText}>
                  Superseded versions are read-only. Editing an approved estimate creates a new
                  draft version instead.
                </Text>
              </View>
            ) : null}

            <View style={styles.versionList}>
              {versions.map((version) => (
                <VersionRow
                  key={version.id}
                  version={version}
                  isCurrent={version.id === id}
                  isSelected={selected.includes(version.id)}
                  onToggle={() => toggleSelect(version.id)}
                  onCompareWithCurrent={
                    version.id === id ? undefined : () => compareWithCurrent(version.id)
                  }
                />
              ))}
            </View>

            {selected.length === 1 ? (
              <Text style={styles.selectHint}>Select one more version to compare.</Text>
            ) : null}
            {selected.length > 0 ? (
              <Button title="Clear selection" variant="secondary" onPress={() => setSelected([])} />
            ) : null}

            {diffPair ? (
              <DiffPanel
                fromLabel={`v${diffPair[0].version}`}
                toLabel={`v${diffPair[1].version}`}
                loading={diffQuery.isPending}
                error={
                  diffQuery.isError
                    ? diffQuery.error instanceof ApiError
                      ? diffQuery.error.message
                      : 'Could not compare these versions. Try again.'
                    : null
                }
                diff={diffQuery.data ?? null}
              />
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function VersionRow({
  version,
  isCurrent,
  isSelected,
  onToggle,
  onCompareWithCurrent,
}: {
  version: EstimateSummary;
  isCurrent: boolean;
  isSelected: boolean;
  onToggle: () => void;
  onCompareWithCurrent?: () => void;
}) {
  const statusColor = STATUS_COLOR[version.status] ?? colors.textMuted;
  return (
    <View style={[styles.versionCard, isCurrent && styles.versionCardCurrent]}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ selected: isSelected }}
        accessibilityLabel={`Version ${version.version}, ${STATUS_LABEL[version.status] ?? version.status}`}
        style={({ pressed }) => [styles.versionRow, pressed && { opacity: 0.8 }]}
      >
        <View style={[styles.selectCircle, isSelected && styles.selectCircleOn]}>
          {isSelected ? <Check size={14} color={colors.textOnPrimary} strokeWidth={3} /> : null}
        </View>
        <View style={styles.versionInfo}>
          <View style={styles.versionTopRow}>
            <Text style={styles.versionNumber}>v{version.version}</Text>
            <View style={[styles.statusChip, { borderColor: statusColor }]}>
              <Text style={[styles.statusChipText, { color: statusColor }]}>
                {(STATUS_LABEL[version.status] ?? version.status).toUpperCase()}
              </Text>
            </View>
            {isCurrent ? <EquipmentLabel text="CURRENT" color={colors.accentText} /> : null}
          </View>
          <Text style={styles.versionDate}>{dateText(version.created_at)}</Text>
        </View>
        <Text style={styles.versionTotal}>{money(version.totals?.['total'])}</Text>
      </Pressable>
      {onCompareWithCurrent ? (
        <Pressable
          onPress={onCompareWithCurrent}
          accessibilityRole="button"
          accessibilityLabel={`Compare version ${version.version} with current`}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          style={({ pressed }) => [styles.compareLink, pressed && { opacity: 0.7 }]}
        >
          <Text style={styles.compareLinkText}>Compare with current</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function DiffPanel({
  fromLabel,
  toLabel,
  loading,
  error,
  diff,
}: {
  fromLabel: string;
  toLabel: string;
  loading: boolean;
  error: string | null;
  diff: DiffResult | null;
}) {
  return (
    <View style={styles.diffCard}>
      <View style={styles.diffHeader}>
        <EquipmentLabel text="CHANGES" />
        <View style={styles.diffVersions}>
          <Text style={styles.diffVersionText}>{fromLabel}</Text>
          <ArrowRight size={16} color={colors.textMuted} />
          <Text style={styles.diffVersionText}>{toLabel}</Text>
        </View>
      </View>

      {loading ? (
        <Text style={styles.mutedCenter}>Comparing…</Text>
      ) : error ? (
        <Text style={styles.diffError}>{error}</Text>
      ) : diff ? (
        <>
          {diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0 ? (
            <Text style={styles.bodyText}>No line changes between these versions.</Text>
          ) : (
            <>
              <DiffSection label="ADDED" show={diff.added.length > 0}>
                {diff.added.map((line, index) => (
                  <View key={`added-${index}`} style={[styles.diffRow, styles.diffRowAdded]}>
                    <Text style={styles.diffSign}>+</Text>
                    <Text style={[styles.diffDesc, styles.diffDescAdded]}>
                      {line.description}
                      <Text style={styles.diffQty}> ×{qtyText(line.qty)}</Text>
                    </Text>
                    <Text style={[styles.diffTotal, styles.diffTotalAdded]}>
                      {money(line.total)}
                    </Text>
                  </View>
                ))}
              </DiffSection>
              <DiffSection label="REMOVED" show={diff.removed.length > 0}>
                {diff.removed.map((line, index) => (
                  <View key={`removed-${index}`} style={[styles.diffRow, styles.diffRowRemoved]}>
                    <Text style={styles.diffSignRemoved}>−</Text>
                    <Text style={[styles.diffDesc, styles.diffDescRemoved]}>
                      {line.description}
                      <Text style={styles.diffQty}> ×{qtyText(line.qty)}</Text>
                    </Text>
                    <Text style={[styles.diffTotal, styles.diffTotalRemoved]}>
                      {money(line.total)}
                    </Text>
                  </View>
                ))}
              </DiffSection>
              <DiffSection label="CHANGED" show={diff.changed.length > 0}>
                {diff.changed.map((change, index) => (
                  <View key={`changed-${index}`} style={styles.changedRow}>
                    <Text style={styles.diffDesc}>{change.after.description}</Text>
                    <View style={styles.changedDetail}>
                      {change.before.qty !== change.after.qty ? (
                        <View style={styles.changedPair}>
                          <Text style={styles.changedBefore}>×{qtyText(change.before.qty)}</Text>
                          <ArrowRight size={14} color={colors.textMuted} />
                          <Text style={styles.changedAfter}>×{qtyText(change.after.qty)}</Text>
                        </View>
                      ) : null}
                      <View style={styles.changedPair}>
                        <Text style={styles.changedBefore}>{money(change.before.total)}</Text>
                        <ArrowRight size={14} color={colors.textMuted} />
                        <Text style={styles.changedAfter}>{money(change.after.total)}</Text>
                      </View>
                    </View>
                  </View>
                ))}
              </DiffSection>
            </>
          )}
          <View style={styles.diffTotalsRow}>
            <Text style={styles.diffTotalsLabel}>Total</Text>
            <View style={styles.changedPair}>
              <Text style={styles.changedBefore}>{money(diff.totals.from)}</Text>
              <ArrowRight size={16} color={colors.textMuted} />
              <Text style={styles.diffTotalsTo}>{money(diff.totals.to)}</Text>
            </View>
          </View>
        </>
      ) : null}
    </View>
  );
}

function DiffSection({
  label,
  show,
  children,
}: {
  label: string;
  show: boolean;
  children: ReactNode;
}) {
  if (!show) return null;
  return (
    <View style={styles.diffSection}>
      <EquipmentLabel text={label} />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  backStrip: { backgroundColor: colors.ink, paddingHorizontal: spacing.md },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    alignSelf: 'flex-start',
    minHeight: 40,
    paddingTop: spacing.sm,
  },
  backText: {
    color: colors.textOnInk,
    fontSize: typography.size.sm,
    fontFamily: typography.family.medium,
  },
  scroll: { flex: 1 },
  body: {
    width: '100%',
    maxWidth: 640,
    alignSelf: 'center',
    padding: spacing.lg,
    gap: spacing.md,
  },
  mutedCenter: {
    color: colors.textMuted,
    fontSize: typography.size.md,
    fontFamily: typography.family.regular,
    textAlign: 'center',
    paddingVertical: spacing.lg,
  },
  leadText: {
    color: colors.textSecondary,
    fontSize: typography.size.sm,
    fontFamily: typography.family.regular,
    lineHeight: 20,
  },
  bodyText: {
    color: colors.textSecondary,
    fontSize: typography.size.md,
    fontFamily: typography.family.regular,
    lineHeight: 22,
  },
  iconTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  blockTitle: {
    flex: 1,
    color: colors.text,
    fontSize: typography.size.lg,
    fontFamily: typography.family.bold,
  },
  readOnlyNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    backgroundColor: colors.surfaceSunken,
    borderRadius: radii.md,
    padding: spacing.sm + 2,
  },
  readOnlyText: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: typography.size.xs,
    fontFamily: typography.family.regular,
    lineHeight: 18,
  },
  selectHint: {
    color: colors.textMuted,
    fontSize: typography.size.sm,
    fontFamily: typography.family.regular,
    textAlign: 'center',
  },

  // Version rows
  versionList: { gap: spacing.sm },
  versionCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  versionCardCurrent: { borderColor: colors.primary, borderWidth: 1.5 },
  versionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: touchTarget,
  },
  selectCircle: {
    width: 24,
    height: 24,
    borderRadius: radii.full,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  selectCircleOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  versionInfo: { flex: 1, gap: 2 },
  versionTopRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm },
  versionNumber: {
    color: colors.ink,
    fontSize: typography.size.lg,
    fontFamily: typography.family.mono,
  },
  statusChip: {
    borderWidth: 1,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
  },
  statusChipText: { fontSize: 10, fontFamily: typography.family.semibold, letterSpacing: 1 },
  versionDate: {
    color: colors.textMuted,
    fontSize: typography.size.xs,
    fontFamily: typography.family.regular,
  },
  versionTotal: {
    color: colors.text,
    fontSize: typography.size.md,
    fontFamily: typography.family.mono,
    textAlign: 'right',
  },
  compareLink: {
    alignSelf: 'flex-start',
    minHeight: 32,
    justifyContent: 'center',
    marginLeft: 24 + spacing.md,
  },
  compareLinkText: {
    color: colors.accentText,
    fontSize: typography.size.sm,
    fontFamily: typography.family.semibold,
  },

  // Diff panel
  diffCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.md,
  },
  diffHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  diffVersions: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  diffVersionText: {
    color: colors.ink,
    fontSize: typography.size.md,
    fontFamily: typography.family.mono,
  },
  diffError: {
    color: colors.danger,
    fontSize: typography.size.sm,
    fontFamily: typography.family.medium,
  },
  diffSection: { gap: spacing.xs },
  diffRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs + 2,
  },
  diffRowAdded: { backgroundColor: '#F0FDF4' },
  diffRowRemoved: { backgroundColor: '#FEF2F2' },
  diffSign: {
    color: colors.success,
    fontSize: typography.size.sm,
    fontFamily: typography.family.mono,
  },
  diffSignRemoved: {
    color: colors.danger,
    fontSize: typography.size.sm,
    fontFamily: typography.family.mono,
  },
  diffDesc: {
    flex: 1,
    color: colors.text,
    fontSize: typography.size.sm,
    fontFamily: typography.family.medium,
    lineHeight: 20,
  },
  diffDescAdded: { color: colors.success },
  diffDescRemoved: { color: colors.danger, textDecorationLine: 'line-through' },
  diffQty: {
    color: colors.textMuted,
    fontSize: typography.size.xs,
    fontFamily: typography.family.mono,
  },
  diffTotal: { fontSize: typography.size.sm, fontFamily: typography.family.mono },
  diffTotalAdded: { color: colors.success },
  diffTotalRemoved: { color: colors.danger, textDecorationLine: 'line-through' },
  changedRow: {
    gap: spacing.xs,
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceSunken,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs + 2,
  },
  changedDetail: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  changedPair: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  changedBefore: {
    color: colors.textMuted,
    fontSize: typography.size.sm,
    fontFamily: typography.family.mono,
    textDecorationLine: 'line-through',
  },
  changedAfter: {
    color: colors.text,
    fontSize: typography.size.sm,
    fontFamily: typography.family.mono,
  },
  diffTotalsRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingTop: spacing.sm,
    borderTopWidth: 2,
    borderTopColor: colors.ink,
  },
  diffTotalsLabel: {
    color: colors.ink,
    fontSize: typography.size.md,
    fontFamily: typography.family.bold,
  },
  diffTotalsTo: {
    color: colors.ink,
    fontSize: typography.size.lg,
    fontFamily: typography.family.mono,
  },
});
