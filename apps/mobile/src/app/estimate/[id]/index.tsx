/**
 * Estimate editor (Phase 5) — the most important screen in the app.
 *
 * State model: TanStack Query cache is the single source of truth
 * (['estimate', id]). Every mutation endpoint returns the FULL updated
 * EstimateDetail, which replaces the cache entry. Qty steps and deletes are
 * optimistic: the cache is patched locally first, the server response
 * reconciles it, and on failure the pre-mutation snapshot is restored and a
 * toast explains what happened.
 *
 * Editing an APPROVED estimate returns 409 `fork_required`: we prompt
 * "Edit a new version?", call fork, and router.replace to the new draft.
 */

import { colors, radii, spacing, touchTarget, typography } from '@fieldquote/ui';
import { FlashList } from '@shopify/flash-list';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AlertTriangle, Check, ChevronDown, ChevronUp, Minus, Plus, X } from 'lucide-react-native';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EquipmentLabel, HeaderBand } from '@/components/header-band';
import { Button, Chip, Field } from '@/components/ui';
import { api, ApiError, type EstimateDetail } from '@/lib/api';

type Line = EstimateDetail['lines'][number];
type Suggestion = { assembly_code: string | null; description: string; reason: string };
type OverrideField = 'qty' | 'unit_price' | 'labor_hours' | 'material_cost';

/** Routes built by parallel tasks (approve/options) aren't in typed routes yet. */
const href = (path: string) => path as Href;

// ── untyped-JSON helpers (line.totals / estimate.totals are unknown maps) ──

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

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

/** Compact number: "2.5", "2", never "2.50". */
function fmtNum(value: unknown): string {
  const n = numeric(value);
  if (!Number.isFinite(n)) return '—';
  return String(parseFloat(n.toFixed(2)));
}

function lineTotals(line: Line): Record<string, unknown> | null {
  return asRecord(line.totals);
}

function overriddenFields(line: Line): string[] {
  const overrides = asRecord(lineTotals(line)?.['overrides']);
  if (!overrides) return [];
  return Object.keys(overrides).filter((k) => Boolean(overrides[k]));
}

function isIncluded(line: Line): boolean {
  return lineTotals(line)?.['included'] !== false;
}

/** Cheap identity string for memoized rows — re-render only when these change. */
function lineRenderKey(line: Line): string {
  const t = lineTotals(line);
  return [
    line.qty,
    line.description,
    line.editable_note ?? '',
    line.line_type,
    line.confidence,
    String(t?.['total'] ?? ''),
    String(t?.['unit_price'] ?? ''),
    isIncluded(line) ? '1' : '0',
    overriddenFields(line).join(','),
  ].join('|');
}

// ── grouping ───────────────────────────────────────────────────────────────

type Row =
  { type: 'section'; key: string; title: string } | { type: 'line'; key: string; line: Line };

const GROUPS: { title: string; match: (l: Line) => boolean }[] = [
  {
    title: 'Labor & materials',
    match: (l) => l.line_type === 'standard' || l.line_type === 'discount',
  },
  { title: 'Allowances', match: (l) => l.line_type === 'allowance' },
  { title: 'Verify on site', match: (l) => l.line_type === 'verify' },
  { title: 'Options', match: (l) => l.line_type.startsWith('option_') },
];

function buildRows(lines: Line[]): Row[] {
  const rows: Row[] = [];
  for (const group of GROUPS) {
    const members = lines.filter(group.match).sort((a, b) => a.position - b.position);
    if (members.length === 0) continue;
    rows.push({ type: 'section', key: `section:${group.title}`, title: group.title });
    for (const line of members) rows.push({ type: 'line', key: line.id, line });
  }
  return rows;
}

const STATUS_CHIP: Record<string, { label: string; color: string }> = {
  draft: { label: 'DRAFT', color: colors.warning },
  approved: { label: 'APPROVED', color: colors.success },
  superseded: { label: 'SUPERSEDED', color: colors.textMuted },
  generation_failed: { label: 'GENERATION FAILED', color: colors.danger },
};

// ── screen ─────────────────────────────────────────────────────────────────

export default function EstimateEditorScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((message: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  const [proseOpen, setProseOpen] = useState(false);
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [marginOpen, setMarginOpen] = useState(false);

  const queryKey = useMemo(() => ['estimate', id] as const, [id]);

  const estimateQuery = useQuery({
    queryKey,
    queryFn: () => api.estimates.get(id),
    enabled: Boolean(id),
  });
  const estimate = estimateQuery.data;

  /** Every mutation returns the full EstimateDetail — replace the cache with it. */
  const applyDetail = useCallback(
    (detail: EstimateDetail) => {
      queryClient.setQueryData(queryKey, detail);
      void queryClient.invalidateQueries({ queryKey: ['estimates', detail.job_id] });
    },
    [queryClient, queryKey],
  );

  // ── fork_required (editing an approved version) ──────────────────────────

  const forkMutation = useMutation({
    mutationFn: () => api.estimates.fork(id),
    onSuccess: (next) => {
      queryClient.setQueryData(['estimate', next.id], next);
      void queryClient.invalidateQueries({ queryKey: ['estimates', next.job_id] });
      router.replace(href(`/estimate/${next.id}`));
    },
    onError: (err) =>
      showToast(err instanceof ApiError ? err.message : 'Could not create a new version.'),
  });
  const { mutate: mutateFork } = forkMutation;

  const promptFork = useCallback(() => {
    Alert.alert('This version is approved', 'This version is approved. Edit a new version?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Edit new version', onPress: () => mutateFork() },
    ]);
  }, [mutateFork]);

  const handleMutationError = useCallback(
    (err: unknown, fallback: string) => {
      if (
        err instanceof ApiError &&
        err.status === 409 &&
        err.details['code'] === 'fork_required'
      ) {
        promptFork();
        return;
      }
      showToast(err instanceof ApiError ? err.message : fallback);
    },
    [promptFork, showToast],
  );

  // ── line mutations ───────────────────────────────────────────────────────

  /** Qty stepper — optimistic: patch cache immediately, server reconciles, rollback on error. */
  const qtyMutation = useMutation({
    mutationFn: ({ lineId, qty }: { lineId: string; qty: string }) =>
      api.estimates.patchLine(id, lineId, { qty }),
    onMutate: async ({ lineId, qty }) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<EstimateDetail>(queryKey);
      if (previous) {
        queryClient.setQueryData<EstimateDetail>(queryKey, {
          ...previous,
          lines: previous.lines.map((l) => (l.id === lineId ? { ...l, qty } : l)),
        });
      }
      return { previous };
    },
    onSuccess: applyDetail,
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
      handleMutationError(err, 'Could not update quantity.');
    },
  });
  const { mutate: mutateQty } = qtyMutation;

  const stepQty = useCallback(
    (line: Line, delta: number) => {
      const current = numeric(line.qty);
      const next = Math.max(1, (Number.isFinite(current) ? current : 1) + delta);
      if (next === current) return;
      mutateQty({ lineId: line.id, qty: String(next) });
    },
    [mutateQty],
  );

  /** Per-field overrides from the detail sheet (qty / unit price / hours / material cost). */
  const patchFieldMutation = useMutation({
    mutationFn: ({
      lineId,
      field,
      value,
    }: {
      lineId: string;
      field: OverrideField;
      value: string;
    }) => {
      const body: {
        qty?: string;
        unit_price?: string;
        labor_hours?: string;
        material_cost?: string;
      } = {};
      body[field] = value;
      return api.estimates.patchLine(id, lineId, body);
    },
    onSuccess: (detail) => {
      applyDetail(detail);
      showToast('Line updated.');
    },
    onError: (err) => handleMutationError(err, 'Could not update the line.'),
  });

  /** Delete — optimistic removal with rollback. */
  const deleteMutation = useMutation({
    mutationFn: (lineId: string) => api.estimates.deleteLine(id, lineId),
    onMutate: async (lineId) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<EstimateDetail>(queryKey);
      if (previous) {
        queryClient.setQueryData<EstimateDetail>(queryKey, {
          ...previous,
          lines: previous.lines.filter((l) => l.id !== lineId),
        });
      }
      setSelectedLineId(null);
      return { previous };
    },
    onSuccess: applyDetail,
    onError: (err, _lineId, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
      handleMutationError(err, 'Could not delete the line.');
    },
  });

  const convertMutation = useMutation({
    mutationFn: ({ lineId, amount }: { lineId: string; amount: string }) =>
      api.estimates.convertAllowance(id, lineId, amount),
    onSuccess: (detail) => {
      applyDetail(detail);
      showToast('Allowance converted to a priced line.');
    },
    onError: (err) => handleMutationError(err, 'Could not convert the allowance.'),
  });

  const addLineMutation = useMutation({
    mutationFn: (body: Parameters<typeof api.estimates.addLine>[1]) =>
      api.estimates.addLine(id, body),
    onSuccess: (detail) => {
      applyDetail(detail);
      showToast('Line added.');
    },
    onError: (err) => handleMutationError(err, 'Could not add the line.'),
  });

  // ── estimate-level mutations ─────────────────────────────────────────────

  const marginMutation = useMutation({
    mutationFn: (pct: string) => api.estimates.patch(id, { margin_override_pct: pct }),
    onSuccess: (detail) => applyDetail(detail),
    onError: (err) => handleMutationError(err, 'Could not adjust the margin.'),
  });

  const suggestionsMutation = useMutation({
    mutationFn: () => api.estimates.suggestions(id),
  });
  const { mutate: mutateSuggestions } = suggestionsMutation;

  const proposalMutation = useMutation({
    mutationFn: () => api.estimates.createProposal(id),
    onSuccess: () => showToast('Proposal created — ready to compose and send.'),
    onError: (err) =>
      showToast(err instanceof ApiError ? err.message : 'Could not create a proposal.'),
  });

  // ── derived data ─────────────────────────────────────────────────────────

  const rows = useMemo(() => (estimate ? buildRows(estimate.lines) : []), [estimate]);
  const selectedLine = useMemo(
    () => estimate?.lines.find((l) => l.id === selectedLineId) ?? null,
    [estimate, selectedLineId],
  );
  const jobTypeCode = useMemo(() => {
    const code = asRecord(estimate?.ai_output)?.['job_type_code'];
    return typeof code === 'string' ? code : undefined;
  }, [estimate]);

  const openSheet = useCallback((lineId: string) => setSelectedLineId(lineId), []);
  const openSuggestions = useCallback(() => {
    setSuggestOpen(true);
    mutateSuggestions();
  }, [mutateSuggestions]);

  // ── loading / error states ───────────────────────────────────────────────

  if (!estimate) {
    return (
      <View style={styles.screen}>
        <StatusBar style="light" />
        <View style={{ height: insets.top, backgroundColor: colors.ink }} />
        <HeaderBand eyebrow="ESTIMATE" title="Estimate" />
        <View style={styles.stateBody}>
          {estimateQuery.isError ? (
            <>
              <Text style={styles.stateText}>
                {estimateQuery.error instanceof ApiError
                  ? estimateQuery.error.message
                  : 'Could not load this estimate.'}
              </Text>
              <Button title="Retry" onPress={() => void estimateQuery.refetch()} />
            </>
          ) : (
            <View style={styles.skeleton}>
              {[64, 24, 48, 48, 48, 48].map((height, i) => (
                <View key={i} style={[styles.skeletonBlock, { height }]} />
              ))}
            </View>
          )}
        </View>
      </View>
    );
  }

  const chip = STATUS_CHIP[estimate.status] ?? {
    label: estimate.status.toUpperCase(),
    color: colors.textMuted,
  };
  const totals = asRecord(estimate.totals);
  const marginCheck = asRecord(totals?.['margin_check']);
  const isFailed = estimate.status === 'generation_failed';
  const failReason = (() => {
    const err = asRecord(estimate.ai_output)?.['error'];
    return typeof err === 'string' && err
      ? err
      : 'Generation did not finish. You can build this estimate manually below.';
  })();

  const listHeader = (
    <View style={styles.listHeader}>
      {isFailed ? (
        <View style={styles.failCard}>
          <View style={styles.failTitleRow}>
            <AlertTriangle size={20} color={colors.danger} />
            <Text style={styles.failTitle}>We could not finish this estimate</Text>
          </View>
          <Text style={styles.failReason}>{failReason}</Text>
          <Button title="Build manually" variant="secondary" onPress={() => setAddOpen(true)} />
        </View>
      ) : null}
      {estimate.scope_prose ? (
        <View style={styles.proseBlock}>
          <EquipmentLabel text="SCOPE OF WORK" />
          <Text style={styles.prose} numberOfLines={proseOpen ? undefined : 4}>
            {estimate.scope_prose}
          </Text>
          <Pressable
            onPress={() => setProseOpen((v) => !v)}
            accessibilityRole="button"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={({ pressed }) => pressed && styles.pressed}
          >
            <Text style={styles.proseToggle}>{proseOpen ? 'Show less' : 'Read more'}</Text>
          </Pressable>
        </View>
      ) : null}
      {rows.length === 0 && !isFailed ? (
        <Text style={styles.emptyLines}>No line items yet. Add the first one below.</Text>
      ) : null}
    </View>
  );

  const listFooter = (
    <View style={styles.listFooter}>
      <Button title="Add line" variant="secondary" onPress={() => setAddOpen(true)} />
      <Button title="What am I forgetting?" variant="secondary" onPress={openSuggestions} />
    </View>
  );

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <View style={{ height: insets.top, backgroundColor: colors.ink }} />
      <HeaderBand
        eyebrow={`ESTIMATE / V${estimate.version}`}
        title="Estimate"
        meta={money(totals?.['total'])}
      >
        <View style={styles.headerRow}>
          <View style={[styles.statusChip, { borderColor: chip.color }]}>
            <Text style={[styles.statusChipText, { color: chip.color }]}>{chip.label}</Text>
          </View>
          <Pressable
            onPress={() => router.push(href(`/job/${estimate.job_id}`))}
            accessibilityRole="button"
            accessibilityLabel="View job"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={({ pressed }) => pressed && styles.pressed}
          >
            <Text style={styles.jobLink}>View job</Text>
          </Pressable>
        </View>
      </HeaderBand>

      <FlashList
        data={rows}
        keyExtractor={(row) => row.key}
        getItemType={(row) => row.type}
        renderItem={({ item }) =>
          item.type === 'section' ? (
            <View style={styles.sectionHeader}>
              <EquipmentLabel text={item.title.toUpperCase()} />
            </View>
          ) : (
            <LineRow line={item.line} onOpen={openSheet} onStepQty={stepQty} />
          )
        }
        ListHeaderComponent={listHeader}
        ListFooterComponent={listFooter}
        contentContainerStyle={styles.listContent}
      />

      <MarginPanel
        totals={totals}
        marginCheck={marginCheck}
        open={marginOpen}
        onToggle={() => setMarginOpen((v) => !v)}
        onCommitMargin={(pct) => marginMutation.mutate(pct)}
        saving={marginMutation.isPending}
      />

      {estimate.status === 'draft' || estimate.status === 'approved' ? (
        <View style={[styles.bottomBar, { paddingBottom: insets.bottom + spacing.sm }]}>
          {estimate.status === 'draft' ? (
            <Button
              title="Review & Approve"
              onPress={() => router.push(href(`/estimate/${estimate.id}/approve`))}
            />
          ) : (
            <View style={styles.approvedBar}>
              <View style={styles.approvedTag}>
                <Check size={18} color={colors.success} />
                <Text style={styles.approvedText}>Approved</Text>
              </View>
              <View style={styles.approvedActions}>
                <View style={styles.approvedButton}>
                  <Button
                    title="Create proposal"
                    loading={proposalMutation.isPending}
                    onPress={() => proposalMutation.mutate()}
                  />
                </View>
                <View style={styles.approvedButton}>
                  <Button
                    title="New version"
                    variant="secondary"
                    loading={forkMutation.isPending}
                    onPress={() => mutateFork()}
                  />
                </View>
              </View>
            </View>
          )}
        </View>
      ) : (
        <View style={[styles.bottomBar, { paddingBottom: insets.bottom + spacing.sm }]}>
          <Text style={styles.readOnlyNote}>
            {estimate.status === 'superseded'
              ? 'This version was superseded by a newer one.'
              : 'This estimate could not be generated — add lines to build it manually.'}
          </Text>
        </View>
      )}

      <LineDetailSheet
        key={selectedLine?.id ?? 'none'}
        line={selectedLine}
        onClose={() => setSelectedLineId(null)}
        onPatchField={(lineId, field, value) => patchFieldMutation.mutate({ lineId, field, value })}
        patchPending={patchFieldMutation.isPending}
        onDelete={(lineId) => {
          Alert.alert('Delete line', 'Remove this line from the estimate?', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Delete', style: 'destructive', onPress: () => deleteMutation.mutate(lineId) },
          ]);
        }}
        onConvert={(lineId, amount) => convertMutation.mutate({ lineId, amount })}
        convertPending={convertMutation.isPending}
        onBuildOptions={(lineId) => {
          setSelectedLineId(null);
          router.push(href(`/estimate/${estimate.id}/options?lineId=${lineId}`));
        }}
        showToast={showToast}
      />

      <AddLineModal
        visible={addOpen}
        jobType={jobTypeCode}
        onClose={() => setAddOpen(false)}
        onAdd={(body) => {
          addLineMutation.mutate(body);
          setAddOpen(false);
        }}
        showToast={showToast}
      />

      <SuggestionsSheet
        visible={suggestOpen}
        loading={suggestionsMutation.isPending}
        error={
          suggestionsMutation.isError
            ? suggestionsMutation.error instanceof ApiError
              ? suggestionsMutation.error.message
              : 'Suggestions are not available right now. Try again later.'
            : null
        }
        suggestions={suggestionsMutation.data?.suggestions ?? []}
        onClose={() => setSuggestOpen(false)}
        onAddAssembly={(code) => {
          addLineMutation.mutate({ assembly_code: code, qty: 1 });
          setSuggestOpen(false);
        }}
        onAddAllowance={(s) => {
          addLineMutation.mutate({
            description: s.description,
            line_type: 'allowance',
            qty: 1,
            editable_note: s.reason,
          });
          setSuggestOpen(false);
        }}
      />

      {toast ? (
        <View pointerEvents="none" style={[styles.toast, { bottom: insets.bottom + 96 }]}>
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      ) : null}
    </View>
  );
}

// ── line row ───────────────────────────────────────────────────────────────

const LineRow = memo(
  function LineRowInner({
    line,
    onOpen,
    onStepQty,
  }: {
    line: Line;
    onOpen: (lineId: string) => void;
    onStepQty: (line: Line, delta: number) => void;
  }) {
    const totals = lineTotals(line);
    const overrides = overriddenFields(line);
    const included = isIncluded(line);
    const isAllowance = line.line_type === 'allowance';
    const isVerify = line.line_type === 'verify' || line.confidence === 'verify';
    const hasStepper = line.line_type === 'standard' || line.line_type.startsWith('option_');

    return (
      <Pressable
        onPress={() => onOpen(line.id)}
        accessibilityRole="button"
        accessibilityLabel={`Line: ${line.description}`}
        style={({ pressed }) => [
          styles.row,
          !included && styles.rowExcluded,
          pressed && styles.pressed,
        ]}
      >
        <View style={styles.rowMain}>
          <View style={styles.rowLeft}>
            <Text style={styles.rowDesc}>{line.description}</Text>
            <View style={styles.badgeRow}>
              {isAllowance ? (
                <View style={[styles.badge, styles.badgeAllowance]}>
                  <Text style={[styles.badgeText, { color: colors.warning }]}>ALLOWANCE</Text>
                </View>
              ) : null}
              {isVerify ? (
                <View style={[styles.badge, styles.badgeVerify]}>
                  <Text style={[styles.badgeText, { color: colors.accentText }]}>
                    VERIFY ON SITE
                  </Text>
                </View>
              ) : null}
              {overrides.length > 0 ? (
                <View style={[styles.badge, styles.badgeAllowance]}>
                  <Text style={[styles.badgeText, { color: colors.warning }]}>EDITED</Text>
                </View>
              ) : null}
              {!included ? <Text style={styles.excludedLabel}>not selected</Text> : null}
            </View>
            {(isAllowance || isVerify) && line.editable_note ? (
              <Text style={styles.rowNote}>{line.editable_note}</Text>
            ) : null}
          </View>
          <Text style={styles.rowTotal}>{money(totals?.['total'])}</Text>
        </View>
        {hasStepper ? (
          <View style={styles.stepperRow}>
            <Pressable
              onPress={() => onStepQty(line, -1)}
              accessibilityRole="button"
              accessibilityLabel="Decrease quantity"
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              style={({ pressed }) => [styles.stepButton, pressed && styles.stepButtonPressed]}
            >
              <Minus size={16} color={colors.ink} />
            </Pressable>
            <Text style={styles.stepQty}>
              {fmtNum(line.qty)}
              {line.unit ? ` ${line.unit}` : ''}
            </Text>
            <Pressable
              onPress={() => onStepQty(line, 1)}
              accessibilityRole="button"
              accessibilityLabel="Increase quantity"
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              style={({ pressed }) => [styles.stepButton, pressed && styles.stepButtonPressed]}
            >
              <Plus size={16} color={colors.ink} />
            </Pressable>
            <Text style={styles.stepUnitPrice}>{money(totals?.['unit_price'])} ea</Text>
          </View>
        ) : null}
      </Pressable>
    );
  },
  (prev, next) =>
    prev.line.id === next.line.id && lineRenderKey(prev.line) === lineRenderKey(next.line),
);

// ── line detail sheet (THE MATH) ───────────────────────────────────────────

function LineDetailSheet({
  line,
  onClose,
  onPatchField,
  patchPending,
  onDelete,
  onConvert,
  convertPending,
  onBuildOptions,
  showToast,
}: {
  line: Line | null;
  onClose: () => void;
  onPatchField: (lineId: string, field: OverrideField, value: string) => void;
  patchPending: boolean;
  onDelete: (lineId: string) => void;
  onConvert: (lineId: string, amount: string) => void;
  convertPending: boolean;
  onBuildOptions: (lineId: string) => void;
  showToast: (message: string) => void;
}) {
  const [drafts, setDrafts] = useState<Partial<Record<OverrideField, string>>>({});
  const [convertAmount, setConvertAmount] = useState('');

  if (!line) return null;

  const totals = lineTotals(line);
  const breakdown = asRecord(totals?.['breakdown']);
  const overrides = overriddenFields(line);

  const modifierApps = asArray(breakdown?.['modifier_applications'])
    .map((m) => asRecord(m))
    .filter((m): m is Record<string, unknown> => m !== null);
  const materials = asArray(breakdown?.['materials'])
    .map((m) => asRecord(m))
    .filter((m): m is Record<string, unknown> => m !== null);

  const laborParts: string[] = [];
  if (breakdown && breakdown['base_labor_hours'] !== undefined) {
    laborParts.push(
      `base ${fmtNum(breakdown['base_labor_hours'])} × ${fmtNum(
        breakdown['company_override_mult'] ?? 1,
      )} override`,
    );
  }
  for (const m of modifierApps) {
    const delta = numeric(m['hours_after']) - numeric(m['hours_before']);
    const name = typeof m['name'] === 'string' ? m['name'] : String(m['code'] ?? 'modifier');
    laborParts.push(`${delta >= 0 ? '+' : '−'}${fmtNum(Math.abs(delta))} ${name}`);
  }
  const laborHeadline =
    breakdown && breakdown['total_labor_hours'] !== undefined
      ? `${fmtNum(breakdown['total_labor_hours'])} hrs × ${money(breakdown['labor_rate'])}/hr`
      : null;

  const applyField = (field: OverrideField, label: string) => {
    const raw = (drafts[field] ?? '').trim();
    const n = Number(raw);
    if (raw === '' || !Number.isFinite(n) || n < 0) {
      showToast(`Enter a valid ${label.toLowerCase()}.`);
      return;
    }
    onPatchField(line.id, field, raw);
  };

  const overrideRow = (field: OverrideField, label: string, current: string) => (
    <View style={styles.overrideRow} key={field}>
      <View style={styles.overrideLabelBlock}>
        <Text style={styles.overrideLabel}>{label}</Text>
        {overrides.includes(field) ? (
          <View style={[styles.badge, styles.badgeAllowance]}>
            <Text style={[styles.badgeText, { color: colors.warning }]}>EDITED</Text>
          </View>
        ) : null}
      </View>
      <TextInput
        style={styles.overrideInput}
        placeholder={current}
        placeholderTextColor={colors.textMuted}
        keyboardType="decimal-pad"
        accessibilityLabel={label}
        value={drafts[field] ?? ''}
        onChangeText={(v) => setDrafts((d) => ({ ...d, [field]: v }))}
      />
      <Pressable
        onPress={() => applyField(field, label)}
        disabled={patchPending}
        accessibilityRole="button"
        accessibilityLabel={`Apply ${label}`}
        style={({ pressed }) => [
          styles.applyButton,
          pressed && styles.stepButtonPressed,
          patchPending && styles.disabled,
        ]}
      >
        <Text style={styles.applyButtonText}>Apply</Text>
      </Pressable>
    </View>
  );

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.sheetOverlay}>
        <Pressable style={styles.sheetScrim} onPress={onClose} accessibilityLabel="Close" />
        <View style={styles.sheet}>
          <View style={styles.sheetHandleRow}>
            <View style={styles.sheetLeft}>
              <Text style={styles.sheetTitle}>{line.description}</Text>
              {line.assembly_code ? (
                <Text style={styles.sheetCode}>{line.assembly_code}</Text>
              ) : null}
            </View>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close"
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              style={({ pressed }) => pressed && styles.pressed}
            >
              <X size={22} color={colors.textSecondary} />
            </Pressable>
          </View>

          <ScrollView style={styles.sheetScroll} keyboardShouldPersistTaps="handled">
            {breakdown ? (
              <View style={styles.mathBlock}>
                <EquipmentLabel text="THE MATH" />
                {laborHeadline ? (
                  <Text style={styles.mathHeadline}>
                    {laborHeadline}
                    {laborParts.length > 0 ? (
                      <Text style={styles.mathDetail}> — {laborParts.join(', ')}</Text>
                    ) : null}
                  </Text>
                ) : null}
                <View style={styles.mathRow}>
                  <Text style={styles.mathLabel}>Labor</Text>
                  <Text style={styles.mathValue}>{money(breakdown['labor_cost'])}</Text>
                </View>
                {numeric(breakdown['helper_cost']) > 0 ? (
                  <View style={styles.mathRow}>
                    <Text style={styles.mathLabel}>Helper</Text>
                    <Text style={styles.mathValue}>{money(breakdown['helper_cost'])}</Text>
                  </View>
                ) : null}
                {materials.length > 0 ? (
                  <View style={styles.materialsTable}>
                    {materials.map((m, i) => (
                      <View style={styles.materialRow} key={`${String(m['sku'] ?? i)}-${i}`}>
                        <View style={styles.materialLeft}>
                          <Text style={styles.materialSku}>{String(m['sku'] ?? '')}</Text>
                          <Text style={styles.materialDesc} numberOfLines={2}>
                            {String(m['description'] ?? '')}
                          </Text>
                        </View>
                        <Text style={styles.materialQty}>×{fmtNum(m['qty'])}</Text>
                        <Text style={styles.materialExt}>{money(m['extended'])}</Text>
                      </View>
                    ))}
                  </View>
                ) : null}
                <View style={styles.mathRow}>
                  <Text style={styles.mathLabel}>Materials</Text>
                  <Text style={styles.mathValue}>{money(breakdown['material_cost'])}</Text>
                </View>
                <View style={[styles.mathRow, styles.mathTotalRow]}>
                  <Text style={styles.mathLabel}>
                    Cost {money(breakdown['cost_total'])} ·{' '}
                    {String(breakdown['pricing_model'] ?? '—')} {fmtNum(breakdown['pct_applied'])}%
                  </Text>
                  <Text style={styles.mathTotal}>{money(totals?.['total'])}</Text>
                </View>
              </View>
            ) : (
              <View style={styles.mathBlock}>
                <EquipmentLabel text="PRICE" />
                <View style={styles.mathRow}>
                  <Text style={styles.mathLabel}>
                    {fmtNum(line.qty)}
                    {line.unit ? ` ${line.unit}` : ''} × {money(totals?.['unit_price'])}
                  </Text>
                  <Text style={styles.mathTotal}>{money(totals?.['total'])}</Text>
                </View>
              </View>
            )}

            <View style={styles.overridesBlock}>
              <EquipmentLabel text="OVERRIDES" />
              {overrideRow('qty', 'Quantity', fmtNum(line.qty))}
              {overrideRow('unit_price', 'Unit price', fmtNum(totals?.['unit_price']))}
              {line.line_type === 'standard' || line.line_type.startsWith('option_')
                ? overrideRow('labor_hours', 'Labor hours', fmtNum(line.labor_hours))
                : null}
              {line.line_type === 'standard' || line.line_type.startsWith('option_')
                ? overrideRow('material_cost', 'Material cost', fmtNum(line.material_cost))
                : null}
              {patchPending ? <ActivityIndicator color={colors.accentText} /> : null}
            </View>

            {line.line_type === 'allowance' ? (
              <View style={styles.convertBlock}>
                <EquipmentLabel text="CONVERT TO PRICED LINE" />
                <Text style={styles.convertHint}>
                  Confirmed the details on site? Set the real amount and this stops being a
                  budgetary placeholder.
                </Text>
                <View style={styles.convertRow}>
                  <TextInput
                    style={[styles.overrideInput, styles.convertInput]}
                    placeholder={fmtNum(totals?.['total'])}
                    placeholderTextColor={colors.textMuted}
                    keyboardType="decimal-pad"
                    accessibilityLabel="Converted amount"
                    value={convertAmount}
                    onChangeText={setConvertAmount}
                  />
                  <Pressable
                    onPress={() => {
                      const n = Number(convertAmount.trim());
                      if (!Number.isFinite(n) || n <= 0) {
                        showToast('Enter the confirmed amount first.');
                        return;
                      }
                      onConvert(line.id, convertAmount.trim());
                    }}
                    disabled={convertPending}
                    accessibilityRole="button"
                    accessibilityLabel="Convert to priced line"
                    style={({ pressed }) => [
                      styles.applyButton,
                      pressed && styles.stepButtonPressed,
                      convertPending && styles.disabled,
                    ]}
                  >
                    <Text style={styles.applyButtonText}>
                      {convertPending ? 'Converting…' : 'Convert'}
                    </Text>
                  </Pressable>
                </View>
              </View>
            ) : null}

            <View style={styles.sheetActions}>
              {line.line_type === 'standard' ? (
                <Button
                  title="Make good / better / best"
                  variant="secondary"
                  onPress={() => onBuildOptions(line.id)}
                />
              ) : null}
              <Button title="Delete line" variant="danger" onPress={() => onDelete(line.id)} />
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// ── add line modal ─────────────────────────────────────────────────────────

function AddLineModal({
  visible,
  jobType,
  onClose,
  onAdd,
  showToast,
}: {
  visible: boolean;
  jobType: string | undefined;
  onClose: () => void;
  onAdd: (body: Parameters<typeof api.estimates.addLine>[1]) => void;
  showToast: (message: string) => void;
}) {
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [manual, setManual] = useState(false);
  const [manualDesc, setManualDesc] = useState('');
  const [manualPrice, setManualPrice] = useState('');
  const [manualType, setManualType] = useState<'standard' | 'allowance'>('standard');

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(timer);
  }, [q]);

  const searchQuery = useQuery({
    queryKey: ['assembly-search', debouncedQ, jobType],
    queryFn: () => api.catalog.searchAssemblies(debouncedQ, jobType),
    enabled: visible && !manual,
  });

  const submitManual = () => {
    if (!manualDesc.trim()) {
      showToast('Describe the line first.');
      return;
    }
    const price = Number(manualPrice.trim());
    if (!Number.isFinite(price) || price < 0) {
      showToast('Enter a valid price.');
      return;
    }
    onAdd({
      description: manualDesc.trim(),
      unit_price: manualPrice.trim(),
      line_type: manualType,
      qty: 1,
    });
    setManualDesc('');
    setManualPrice('');
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.sheetOverlay}>
        <Pressable style={styles.sheetScrim} onPress={onClose} accessibilityLabel="Close" />
        <View style={styles.sheet}>
          <View style={styles.sheetHandleRow}>
            <Text style={styles.sheetTitle}>Add line</Text>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close"
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              style={({ pressed }) => pressed && styles.pressed}
            >
              <X size={22} color={colors.textSecondary} />
            </Pressable>
          </View>

          <View style={styles.addModeRow}>
            <Chip label="Catalog" selected={!manual} onPress={() => setManual(false)} />
            <Chip label="Manual line" selected={manual} onPress={() => setManual(true)} />
          </View>

          {manual ? (
            <ScrollView style={styles.sheetScroll} keyboardShouldPersistTaps="handled">
              <View style={styles.manualForm}>
                <Field
                  label="Description"
                  placeholder="e.g. Patch drywall at panel"
                  value={manualDesc}
                  onChangeText={setManualDesc}
                />
                <Field
                  label="Unit price"
                  placeholder="0.00"
                  keyboardType="decimal-pad"
                  value={manualPrice}
                  onChangeText={setManualPrice}
                />
                <View style={styles.addModeRow}>
                  <Chip
                    label="Standard"
                    selected={manualType === 'standard'}
                    onPress={() => setManualType('standard')}
                  />
                  <Chip
                    label="Allowance"
                    selected={manualType === 'allowance'}
                    onPress={() => setManualType('allowance')}
                  />
                </View>
                <Button title="Add line" onPress={submitManual} />
              </View>
            </ScrollView>
          ) : (
            <>
              <TextInput
                style={[styles.overrideInput, styles.searchInput]}
                placeholder="Search assemblies — panel, EV, recessed…"
                placeholderTextColor={colors.textMuted}
                accessibilityLabel="Search assemblies"
                autoFocus
                value={q}
                onChangeText={setQ}
              />
              <ScrollView style={styles.sheetScroll} keyboardShouldPersistTaps="handled">
                {searchQuery.isPending ? (
                  <ActivityIndicator color={colors.accentText} style={styles.searchSpinner} />
                ) : searchQuery.isError ? (
                  <Text style={styles.searchEmpty}>Could not search the catalog. Try again.</Text>
                ) : (searchQuery.data?.items.length ?? 0) === 0 ? (
                  <Text style={styles.searchEmpty}>
                    {debouncedQ ? 'No assemblies match.' : 'Type to search the catalog.'}
                  </Text>
                ) : (
                  searchQuery.data?.items.map((item) => (
                    <Pressable
                      key={item.code}
                      onPress={() => onAdd({ assembly_code: item.code, qty: 1 })}
                      accessibilityRole="button"
                      accessibilityLabel={`Add ${item.name}`}
                      style={({ pressed }) => [styles.searchRow, pressed && styles.pressed]}
                    >
                      <View style={styles.searchRowLeft}>
                        <Text style={styles.searchName}>{item.name}</Text>
                        <Text style={styles.sheetCode}>{item.code}</Text>
                      </View>
                      <Text style={styles.searchHours}>{fmtNum(item.labor_hours)} hrs</Text>
                    </Pressable>
                  ))
                )}
              </ScrollView>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

// ── "What am I forgetting?" sheet ──────────────────────────────────────────

function SuggestionsSheet({
  visible,
  loading,
  error,
  suggestions,
  onClose,
  onAddAssembly,
  onAddAllowance,
}: {
  visible: boolean;
  loading: boolean;
  error: string | null;
  suggestions: Suggestion[];
  onClose: () => void;
  onAddAssembly: (code: string) => void;
  onAddAllowance: (s: Suggestion) => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.sheetOverlay}>
        <Pressable style={styles.sheetScrim} onPress={onClose} accessibilityLabel="Close" />
        <View style={styles.sheet}>
          <View style={styles.sheetHandleRow}>
            <Text style={styles.sheetTitle}>What am I forgetting?</Text>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close"
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              style={({ pressed }) => pressed && styles.pressed}
            >
              <X size={22} color={colors.textSecondary} />
            </Pressable>
          </View>
          <ScrollView style={styles.sheetScroll}>
            {loading ? (
              <View style={styles.suggestLoading}>
                <ActivityIndicator color={colors.accentText} />
                <Text style={styles.searchEmpty}>Checking your line items…</Text>
              </View>
            ) : error ? (
              <Text style={styles.searchEmpty}>{error}</Text>
            ) : suggestions.length === 0 ? (
              <Text style={styles.searchEmpty}>
                Nothing obvious is missing. You know the job best.
              </Text>
            ) : (
              suggestions.slice(0, 5).map((s, i) => (
                <View key={`${s.description}-${i}`} style={styles.suggestRow}>
                  <Text style={styles.searchName}>{s.description}</Text>
                  <Text style={styles.suggestReason}>{s.reason}</Text>
                  {s.assembly_code ? (
                    <Pressable
                      onPress={() => onAddAssembly(s.assembly_code as string)}
                      accessibilityRole="button"
                      accessibilityLabel={`Add ${s.description}`}
                      style={({ pressed }) => [
                        styles.applyButton,
                        pressed && styles.stepButtonPressed,
                      ]}
                    >
                      <Text style={styles.applyButtonText}>Add line</Text>
                    </Pressable>
                  ) : (
                    <Pressable
                      onPress={() => onAddAllowance(s)}
                      accessibilityRole="button"
                      accessibilityLabel={`Add ${s.description} as allowance`}
                      style={({ pressed }) => [
                        styles.applyButton,
                        pressed && styles.stepButtonPressed,
                      ]}
                    >
                      <Text style={styles.applyButtonText}>Add as allowance</Text>
                    </Pressable>
                  )}
                </View>
              ))
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// ── margin panel ───────────────────────────────────────────────────────────

function MarginPanel({
  totals,
  marginCheck,
  open,
  onToggle,
  onCommitMargin,
  saving,
}: {
  totals: Record<string, unknown> | null;
  marginCheck: Record<string, unknown> | null;
  open: boolean;
  onToggle: () => void;
  onCommitMargin: (pct: string) => void;
  saving: boolean;
}) {
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (commitTimer.current) clearTimeout(commitTimer.current);
    },
    [],
  );

  const targetPct = numeric(marginCheck?.['target_margin_pct']);
  const effectivePct = numeric(marginCheck?.['effective_margin_pct']);
  const belowFloor = marginCheck?.['below_floor'] === true;
  const belowTarget = marginCheck?.['below_target'] === true;

  // Pending stepper value is keyed to the server target it was based on: when
  // the PATCH response lands and target_margin_pct changes, the stale pending
  // value is ignored at render time — no state reset (and no effect) needed.
  const targetKey = Number.isFinite(targetPct) ? targetPct : -1;
  const [pendingReq, setPendingReq] = useState<{ value: number; base: number } | null>(null);
  const pending = pendingReq !== null && pendingReq.base === targetKey ? pendingReq.value : null;

  /** Stepper ±1% — debounced 400ms before PATCHing margin_override_pct. */
  const step = (delta: number) => {
    const base = pending ?? (Number.isFinite(targetPct) ? targetPct : 0);
    const next = Math.min(90, Math.max(0, Math.round(base + delta)));
    setPendingReq({ value: next, base: targetKey });
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => onCommitMargin(String(next)), 400);
  };

  if (!totals) return null;

  return (
    <View style={styles.marginPanel}>
      {belowFloor ? (
        <View style={[styles.marginBanner, styles.marginBannerFloor]}>
          <AlertTriangle size={14} color={colors.textOnPrimary} />
          <Text style={styles.marginBannerText}>Below your minimum margin floor</Text>
        </View>
      ) : belowTarget ? (
        <View style={[styles.marginBanner, styles.marginBannerTarget]}>
          <AlertTriangle size={14} color={colors.warning} />
          <Text style={[styles.marginBannerText, { color: colors.warning }]}>
            Below your target margin
          </Text>
        </View>
      ) : null}

      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityLabel={open ? 'Collapse margin panel' : 'Expand margin panel'}
        style={({ pressed }) => [styles.marginToggleRow, pressed && styles.pressed]}
      >
        <Text style={styles.marginToggleLabel}>
          Margin{' '}
          <Text style={styles.marginTogglePct}>
            {Number.isFinite(effectivePct) ? `${fmtNum(effectivePct)}%` : '—'}
          </Text>
        </Text>
        <View style={styles.marginToggleRight}>
          <Text style={styles.marginToggleTotal}>{money(totals['total'])}</Text>
          {open ? (
            <ChevronDown size={18} color={colors.textSecondary} />
          ) : (
            <ChevronUp size={18} color={colors.textSecondary} />
          )}
        </View>
      </Pressable>

      {open ? (
        <View style={styles.marginBody}>
          <View style={styles.marginStatsRow}>
            <View style={styles.marginStat}>
              <Text style={styles.marginStatLabel}>COST BASIS</Text>
              <Text style={styles.marginStatValue}>{money(marginCheck?.['cost_total'])}</Text>
            </View>
            <View style={styles.marginStat}>
              <Text style={styles.marginStatLabel}>PRICE</Text>
              <Text style={styles.marginStatValue}>{money(marginCheck?.['price_basis'])}</Text>
            </View>
            <View style={styles.marginStat}>
              <Text style={styles.marginStatLabel}>MARGIN</Text>
              <Text style={styles.marginBigPct}>
                {Number.isFinite(effectivePct) ? `${fmtNum(effectivePct)}%` : '—'}
              </Text>
            </View>
          </View>

          <View style={styles.marginStepperRow}>
            <Text style={styles.marginStatLabel}>
              TARGET {pending !== null ? `${pending}%` : `${fmtNum(targetPct)}%`}
              {pending !== null || saving ? ' · saving…' : ''}
            </Text>
            <View style={styles.marginStepperButtons}>
              <Pressable
                onPress={() => step(-1)}
                accessibilityRole="button"
                accessibilityLabel="Lower target margin"
                style={({ pressed }) => [styles.stepButton, pressed && styles.stepButtonPressed]}
              >
                <Minus size={16} color={colors.ink} />
              </Pressable>
              <Pressable
                onPress={() => step(1)}
                accessibilityRole="button"
                accessibilityLabel="Raise target margin"
                style={({ pressed }) => [styles.stepButton, pressed && styles.stepButtonPressed]}
              >
                <Plus size={16} color={colors.ink} />
              </Pressable>
            </View>
          </View>

          <View style={styles.totalsBlock}>
            <View style={styles.totalsRow}>
              <Text style={styles.totalsLabel}>Subtotal</Text>
              <Text style={styles.totalsValue}>{money(totals['subtotal'])}</Text>
            </View>
            <View style={styles.totalsRow}>
              <Text style={styles.totalsLabel}>Tax</Text>
              <Text style={styles.totalsValue}>{money(totals['tax'])}</Text>
            </View>
            <View style={[styles.totalsRow, styles.totalsGrand]}>
              <Text style={styles.totalsGrandLabel}>Total</Text>
              <Text style={styles.totalsGrandValue}>{money(totals['total'])}</Text>
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}

// ── styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.45 },

  // header
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.xs,
  },
  statusChip: {
    borderWidth: 1.5,
    borderRadius: radii.full,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 3,
    backgroundColor: colors.surface,
  },
  statusChipText: {
    fontSize: 11,
    fontFamily: typography.family.semibold,
    letterSpacing: 1,
  },
  jobLink: {
    color: colors.primary,
    fontSize: typography.size.sm,
    fontFamily: typography.family.semibold,
  },

  // loading / error
  stateBody: {
    flex: 1,
    padding: spacing.lg,
    gap: spacing.md,
    width: '100%',
    maxWidth: 640,
    alignSelf: 'center',
  },
  stateText: { color: colors.textSecondary, fontSize: typography.size.md, lineHeight: 22 },
  skeleton: { gap: spacing.sm },
  skeletonBlock: { backgroundColor: colors.surfaceSunken, borderRadius: radii.md },

  // list
  listContent: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },
  listHeader: { gap: spacing.sm, paddingTop: spacing.md },
  listFooter: { gap: spacing.sm, paddingTop: spacing.md },
  sectionHeader: { paddingTop: spacing.md, paddingBottom: spacing.xs },
  emptyLines: {
    color: colors.textMuted,
    fontSize: typography.size.sm,
    paddingVertical: spacing.md,
  },
  proseBlock: { gap: spacing.xs },
  prose: {
    color: colors.text,
    fontSize: typography.size.md,
    fontFamily: typography.family.regular,
    lineHeight: 24,
  },
  proseToggle: {
    color: colors.accentText,
    fontSize: typography.size.sm,
    fontFamily: typography.family.semibold,
    paddingVertical: spacing.xs,
  },
  failCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.danger,
    padding: spacing.md,
    gap: spacing.sm,
  },
  failTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  failTitle: {
    flex: 1,
    color: colors.text,
    fontSize: typography.size.md,
    fontFamily: typography.family.bold,
  },
  failReason: { color: colors.textSecondary, fontSize: typography.size.sm, lineHeight: 20 },

  // line rows
  row: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
    gap: spacing.sm,
  },
  rowExcluded: { opacity: 0.55 },
  rowMain: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  rowLeft: { flex: 1, gap: spacing.xs },
  rowDesc: {
    color: colors.text,
    fontSize: typography.size.sm,
    fontFamily: typography.family.medium,
    lineHeight: 20,
  },
  rowNote: {
    color: colors.textMuted,
    fontSize: typography.size.xs,
    fontFamily: typography.family.regular,
    lineHeight: 16,
  },
  rowTotal: {
    color: colors.text,
    fontSize: typography.size.md,
    fontFamily: typography.family.mono,
    textAlign: 'right',
  },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, alignItems: 'center' },
  badge: { borderRadius: radii.sm, paddingHorizontal: spacing.sm, paddingVertical: 2 },
  badgeAllowance: { backgroundColor: colors.warningBg },
  badgeVerify: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.accentText },
  badgeText: { fontSize: 10, fontFamily: typography.family.semibold, letterSpacing: 1 },
  excludedLabel: {
    color: colors.textMuted,
    fontSize: typography.size.xs,
    fontFamily: typography.family.medium,
  },
  stepperRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  stepButton: {
    width: 36,
    height: 36,
    borderRadius: radii.sm,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepButtonPressed: { backgroundColor: colors.surfaceSunken },
  stepQty: {
    minWidth: 48,
    textAlign: 'center',
    color: colors.text,
    fontSize: typography.size.sm,
    fontFamily: typography.family.mono,
  },
  stepUnitPrice: {
    flex: 1,
    textAlign: 'right',
    color: colors.textMuted,
    fontSize: typography.size.xs,
    fontFamily: typography.family.mono,
  },

  // sheets
  sheetOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(2, 6, 23, 0.5)' },
  sheetScrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  sheet: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    padding: spacing.lg,
    maxHeight: '85%',
    gap: spacing.md,
  },
  sheetHandleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  sheetLeft: { flex: 1, gap: 2 },
  sheetTitle: {
    flexShrink: 1,
    color: colors.text,
    fontSize: typography.size.lg,
    fontFamily: typography.family.bold,
  },
  sheetCode: {
    color: colors.textMuted,
    fontSize: typography.size.xs,
    fontFamily: typography.family.mono,
  },
  sheetScroll: { flexGrow: 0 },

  // the math
  mathBlock: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  mathHeadline: {
    color: colors.text,
    fontSize: typography.size.sm,
    fontFamily: typography.family.semibold,
    lineHeight: 20,
  },
  mathDetail: { color: colors.textSecondary, fontFamily: typography.family.regular },
  mathRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  mathLabel: { flex: 1, color: colors.textSecondary, fontSize: typography.size.sm },
  mathValue: {
    color: colors.text,
    fontSize: typography.size.sm,
    fontFamily: typography.family.mono,
  },
  mathTotalRow: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
    alignItems: 'baseline',
  },
  mathTotal: {
    color: colors.ink,
    fontSize: typography.size.lg,
    fontFamily: typography.family.mono,
  },
  materialsTable: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
    gap: spacing.sm,
  },
  materialRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  materialLeft: { flex: 1, gap: 1 },
  materialSku: {
    color: colors.textMuted,
    fontSize: 10,
    fontFamily: typography.family.mono,
    letterSpacing: 0.5,
  },
  materialDesc: { color: colors.text, fontSize: typography.size.xs, lineHeight: 16 },
  materialQty: {
    color: colors.textSecondary,
    fontSize: typography.size.xs,
    fontFamily: typography.family.mono,
  },
  materialExt: {
    minWidth: 64,
    textAlign: 'right',
    color: colors.text,
    fontSize: typography.size.xs,
    fontFamily: typography.family.mono,
  },

  // overrides
  overridesBlock: { gap: spacing.sm, marginBottom: spacing.md },
  overrideRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  overrideLabelBlock: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  overrideLabel: {
    color: colors.textSecondary,
    fontSize: typography.size.sm,
    fontFamily: typography.family.medium,
  },
  overrideInput: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1.5,
    borderRadius: radii.md,
    minHeight: touchTarget,
    paddingHorizontal: spacing.md,
    fontSize: typography.size.md,
    fontFamily: typography.family.mono,
    color: colors.text,
    width: 110,
    textAlign: 'right',
  },
  applyButton: {
    minHeight: touchTarget,
    justifyContent: 'center',
    borderRadius: radii.md,
    borderWidth: 1.5,
    borderColor: colors.ink,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.surface,
  },
  applyButtonText: {
    color: colors.ink,
    fontSize: typography.size.sm,
    fontFamily: typography.family.semibold,
  },
  convertBlock: { gap: spacing.sm, marginBottom: spacing.md },
  convertHint: { color: colors.textMuted, fontSize: typography.size.xs, lineHeight: 16 },
  convertRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  convertInput: { flex: 1 },
  sheetActions: { gap: spacing.sm, paddingBottom: spacing.lg },

  // add line
  addModeRow: { flexDirection: 'row', gap: spacing.sm },
  manualForm: { gap: spacing.md, paddingBottom: spacing.lg },
  searchInput: { width: '100%', textAlign: 'left' },
  searchSpinner: { marginVertical: spacing.md },
  searchEmpty: {
    color: colors.textMuted,
    fontSize: typography.size.sm,
    paddingVertical: spacing.md,
    textAlign: 'center',
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm + 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    minHeight: touchTarget,
  },
  searchRowLeft: { flex: 1, gap: 2 },
  searchName: {
    color: colors.text,
    fontSize: typography.size.sm,
    fontFamily: typography.family.medium,
  },
  searchHours: {
    color: colors.textSecondary,
    fontSize: typography.size.xs,
    fontFamily: typography.family.mono,
  },

  // suggestions
  suggestLoading: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.md },
  suggestRow: {
    gap: spacing.xs,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    alignItems: 'flex-start',
  },
  suggestReason: {
    color: colors.textMuted,
    fontSize: typography.size.xs,
    lineHeight: 16,
    marginBottom: spacing.xs,
  },

  // margin panel
  marginPanel: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  marginBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs + 2,
  },
  marginBannerFloor: { backgroundColor: colors.danger },
  marginBannerTarget: { backgroundColor: colors.warningBg },
  marginBannerText: {
    color: colors.textOnPrimary,
    fontSize: typography.size.xs,
    fontFamily: typography.family.semibold,
    letterSpacing: 0.5,
  },
  marginToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
    minHeight: touchTarget,
  },
  marginToggleLabel: {
    color: colors.textSecondary,
    fontSize: typography.size.sm,
    fontFamily: typography.family.medium,
  },
  marginTogglePct: { color: colors.text, fontFamily: typography.family.mono },
  marginToggleRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  marginToggleTotal: {
    color: colors.ink,
    fontSize: typography.size.md,
    fontFamily: typography.family.mono,
  },
  marginBody: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    gap: spacing.md,
  },
  marginStatsRow: { flexDirection: 'row', gap: spacing.md },
  marginStat: { flex: 1, gap: 2 },
  marginStatLabel: {
    color: colors.textMuted,
    fontSize: 10,
    fontFamily: typography.family.semibold,
    letterSpacing: 1,
  },
  marginStatValue: {
    color: colors.text,
    fontSize: typography.size.sm,
    fontFamily: typography.family.mono,
  },
  marginBigPct: {
    color: colors.ink,
    fontSize: typography.size.xl,
    fontFamily: typography.family.mono,
  },
  marginStepperRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  marginStepperButtons: { flexDirection: 'row', gap: spacing.sm },
  totalsBlock: { gap: spacing.xs },
  totalsRow: { flexDirection: 'row', justifyContent: 'space-between' },
  totalsLabel: { color: colors.textSecondary, fontSize: typography.size.sm },
  totalsValue: {
    color: colors.text,
    fontSize: typography.size.sm,
    fontFamily: typography.family.mono,
  },
  totalsGrand: {
    borderTopWidth: 1,
    borderTopColor: colors.ink,
    paddingTop: spacing.xs,
    alignItems: 'baseline',
  },
  totalsGrandLabel: {
    color: colors.text,
    fontSize: typography.size.sm,
    fontFamily: typography.family.semibold,
  },
  totalsGrandValue: {
    color: colors.ink,
    fontSize: typography.size.lg,
    fontFamily: typography.family.mono,
  },

  // bottom bar
  bottomBar: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  approvedBar: { gap: spacing.sm },
  approvedTag: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  approvedText: {
    color: colors.success,
    fontSize: typography.size.sm,
    fontFamily: typography.family.semibold,
  },
  approvedActions: { flexDirection: 'row', gap: spacing.sm },
  approvedButton: { flex: 1 },
  readOnlyNote: {
    color: colors.textMuted,
    fontSize: typography.size.sm,
    textAlign: 'center',
    paddingVertical: spacing.xs,
  },

  // toast
  toast: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    backgroundColor: colors.ink,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  toastText: {
    color: colors.textOnInk,
    fontSize: typography.size.sm,
    fontFamily: typography.family.medium,
    textAlign: 'center',
  },
});
