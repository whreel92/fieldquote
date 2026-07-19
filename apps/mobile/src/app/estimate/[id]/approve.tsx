/**
 * Review & Approve — THE legal control (§Phase 5.7).
 *
 * A section-by-section walk: Scope → Line items → Totals → Terms. Each
 * section is a full card the contractor must actively confirm before the
 * next unlocks. Only when all four are confirmed does the safety-orange
 * "Approve estimate" button enable. The server enforces the same four
 * confirmations; a 409 with `missing_confirmations` re-flags and re-locks
 * exactly those sections. Already-approved estimates land directly on the
 * approved state; superseded / failed estimates explain and link back.
 */

import { colors, radii, spacing, touchTarget, typography } from '@fieldquote/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AlertTriangle, Check, ChevronLeft, Lock } from 'lucide-react-native';
import { useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EquipmentLabel, HeaderBand } from '@/components/header-band';
import { Button, Card, ErrorText } from '@/components/ui';
import { api, ApiError, type EstimateDetail } from '@/lib/api';

type EstimateLine = EstimateDetail['lines'][number];
type SectionKey = 'scope' | 'lines' | 'totals' | 'terms';

const SECTION_ORDER: readonly SectionKey[] = ['scope', 'lines', 'totals', 'terms'];

const SECTION_META: Record<SectionKey, { step: string; title: string; confirmLabel: string }> = {
  scope: { step: '01', title: 'Scope of work', confirmLabel: 'The scope of work is accurate' },
  lines: { step: '02', title: 'Line items', confirmLabel: 'Every line and price is right' },
  totals: { step: '03', title: 'Totals & margin', confirmLabel: 'The totals are correct' },
  terms: { step: '04', title: 'Terms', confirmLabel: 'I’ve read the terms' },
};

const DISCLAIMER = (company: string) =>
  `This proposal is an estimate prepared and approved by ${company}, a licensed contractor, ` +
  'using FieldQuote software. Final pricing may vary based on site conditions discovered ' +
  'during work; changes will be documented in a written change order. Allowance items are ' +
  'budgetary placeholders. FieldQuote provides drafting software only and is not a party to ' +
  'this agreement.';

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

/** A line is "edited" when the engine totals carry any human overrides. */
function isEdited(line: EstimateLine): boolean {
  const overrides = line.totals?.['overrides'];
  if (Array.isArray(overrides)) return overrides.length > 0;
  if (overrides && typeof overrides === 'object') return Object.keys(overrides).length > 0;
  return false;
}

function isUnpricedAllowance(line: EstimateLine): boolean {
  if (line.line_type !== 'allowance') return false;
  const total = numeric(line.totals?.['total']);
  return !Number.isFinite(total) || total === 0;
}

export default function ApproveEstimateScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();

  const [confirmed, setConfirmed] = useState<Record<SectionKey, boolean>>({
    scope: false,
    lines: false,
    totals: false,
    terms: false,
  });
  /** Sections the server bounced back in a 409 missing_confirmations. */
  const [flagged, setFlagged] = useState<SectionKey[]>([]);
  const [justApproved, setJustApproved] = useState(false);
  const [proposalToken, setProposalToken] = useState<string | null>(null);
  const [proposalError, setProposalError] = useState<string | null>(null);

  const estimateQuery = useQuery({
    queryKey: ['estimate', id],
    queryFn: () => api.estimates.get(id),
    enabled: Boolean(id),
  });
  const companyQuery = useQuery({ queryKey: ['company'], queryFn: api.company.get });

  const approve = useMutation({
    mutationFn: () =>
      api.estimates.approve(id, { scope: true, lines: true, totals: true, terms: true }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['estimate', id], updated);
      void queryClient.invalidateQueries({ queryKey: ['estimates'] });
      setJustApproved(true);
    },
    onError: (err) => {
      if (!(err instanceof ApiError) || err.status !== 409) return;
      const missing = err.details['missing_confirmations'];
      const keys = Array.isArray(missing)
        ? missing.filter((k): k is SectionKey => SECTION_ORDER.includes(k as SectionKey))
        : [];
      if (keys.length > 0) {
        setFlagged(keys);
        setConfirmed((prev) => {
          const next = { ...prev };
          for (const key of keys) next[key] = false;
          return next;
        });
      }
    },
  });

  const createProposal = useMutation({
    mutationFn: () => api.estimates.createProposal(id),
    onSuccess: (proposal) => {
      setProposalToken(proposal.public_token);
      setProposalError(null);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409 && err.code === 'approval_required') {
        setProposalError('This estimate needs to be approved before a proposal can be created.');
      } else {
        setProposalError(
          err instanceof ApiError ? err.message : 'Could not create the proposal. Try again.',
        );
      }
    },
  });

  const toggleSection = (key: SectionKey) => {
    const index = SECTION_ORDER.indexOf(key);
    setConfirmed((prev) => {
      if (prev[key]) {
        // Un-confirming re-locks everything after it — the walk is sequential.
        const next = { ...prev };
        for (const later of SECTION_ORDER.slice(index)) next[later] = false;
        return next;
      }
      // Only the first unconfirmed section can be confirmed.
      const locked = SECTION_ORDER.slice(0, index).some((earlier) => !prev[earlier]);
      if (locked) return prev;
      return { ...prev, [key]: true };
    });
    setFlagged((prev) => prev.filter((k) => k !== key));
  };

  const goBack = () => {
    if (router.canGoBack()) router.back();
  };

  const estimate = estimateQuery.data;
  const confirmedCount = SECTION_ORDER.filter((k) => confirmed[k]).length;
  const allConfirmed = confirmedCount === SECTION_ORDER.length;
  const companyName = companyQuery.data?.name ?? '[Company]';

  // ── Loading / error shells ────────────────────────────────────────────────
  if (estimateQuery.isPending) {
    return (
      <Shell insets={insets} onBack={goBack} eyebrow="REVIEW & APPROVE" title="Approve estimate">
        <Text style={styles.mutedCenter}>Loading estimate…</Text>
      </Shell>
    );
  }
  if (estimateQuery.isError || !estimate) {
    return (
      <Shell insets={insets} onBack={goBack} eyebrow="REVIEW & APPROVE" title="Approve estimate">
        <Card>
          <View style={styles.iconTitleRow}>
            <AlertTriangle size={22} color={colors.warning} />
            <Text style={styles.blockTitle}>Could not load this estimate</Text>
          </View>
          <Text style={styles.bodyText}>
            {estimateQuery.error instanceof ApiError
              ? estimateQuery.error.message
              : 'Check your connection and try again.'}
          </Text>
          <Button title="Try again" onPress={() => void estimateQuery.refetch()} />
          <Button title="Back" variant="secondary" onPress={goBack} />
        </Card>
      </Shell>
    );
  }

  // ── Already approved (or approved just now) ───────────────────────────────
  if (estimate.status === 'approved') {
    return (
      <Shell
        insets={insets}
        onBack={goBack}
        eyebrow="ESTIMATE"
        title="Approved"
        meta={`v${estimate.version}`}
      >
        <View style={styles.successBlock}>
          <View style={styles.successCircle}>
            <Check size={32} color={colors.textOnPrimary} strokeWidth={3} />
          </View>
          <Text style={styles.successTitle}>Estimate approved</Text>
          <Text style={styles.successSub}>
            {justApproved
              ? 'Approved by you · just now'
              : `Version ${estimate.version} is approved and locked.`}
          </Text>
        </View>
        <Card>
          <EquipmentLabel text="NEXT STEP" />
          {proposalToken ? (
            <>
              <Text style={styles.blockTitle}>Proposal created</Text>
              <View style={styles.tokenBox}>
                <Text selectable style={styles.tokenText}>
                  {proposalToken}
                </Text>
              </View>
              <Text style={styles.hintText}>
                Share token for the hosted proposal — press and hold to copy. Sending by email and
                SMS arrives with proposals in Phase 6.
              </Text>
            </>
          ) : (
            <>
              <Button
                title="Create proposal"
                loading={createProposal.isPending}
                onPress={() => createProposal.mutate()}
              />
              <ErrorText message={proposalError} />
            </>
          )}
        </Card>
        <Button title="Back to estimate" variant="secondary" onPress={goBack} />
        <Text style={styles.footNote}>
          Editing an approved estimate creates a new draft version.
        </Text>
      </Shell>
    );
  }

  // ── Non-approvable statuses ───────────────────────────────────────────────
  if (estimate.status !== 'draft') {
    const reason =
      estimate.status === 'superseded'
        ? 'This version has been superseded by a newer one. Open the latest version to review and approve it.'
        : estimate.status === 'generation_failed'
          ? 'This estimate did not finish generating, so there is nothing to approve. Retry generation or build the estimate manually.'
          : `This estimate is ${estimate.status.replace(/_/g, ' ')} and cannot be approved.`;
    return (
      <Shell
        insets={insets}
        onBack={goBack}
        eyebrow="REVIEW & APPROVE"
        title="Approve estimate"
        meta={`v${estimate.version}`}
      >
        <Card>
          <View style={styles.iconTitleRow}>
            <Lock size={20} color={colors.textMuted} />
            <Text style={styles.blockTitle}>Not available for approval</Text>
          </View>
          <Text style={styles.bodyText}>{reason}</Text>
          <Button title="Back to estimate" variant="secondary" onPress={goBack} />
        </Card>
      </Shell>
    );
  }

  // ── The walk ──────────────────────────────────────────────────────────────
  const totals = estimate.totals ?? {};
  const marginRaw = totals['margin_check'];
  const margin =
    marginRaw && typeof marginRaw === 'object' ? (marginRaw as Record<string, unknown>) : null;
  const effectivePct = numeric(margin?.['effective_margin_pct']);
  const targetPct = numeric(margin?.['target_margin_pct']);
  const belowFloor = margin?.['below_floor'] === true;
  const belowTarget = margin?.['below_target'] === true;
  const hasUnpricedAllowance = estimate.lines.some(isUnpricedAllowance);

  const sectionState = (key: SectionKey) => {
    const index = SECTION_ORDER.indexOf(key);
    const locked = SECTION_ORDER.slice(0, index).some((earlier) => !confirmed[earlier]);
    return { locked, isConfirmed: confirmed[key], isFlagged: flagged.includes(key) };
  };

  return (
    <Shell
      insets={insets}
      onBack={goBack}
      eyebrow="REVIEW & APPROVE"
      title="Approve estimate"
      meta={`v${estimate.version} · ${confirmedCount}/4`}
    >
      <Text style={styles.leadText}>
        Walk every section before this estimate can leave the shop. Nothing is sent to the customer
        until you approve it here.
      </Text>

      {/* 01 — SCOPE */}
      <SectionCard
        sectionKey="scope"
        state={sectionState('scope')}
        onConfirm={() => toggleSection('scope')}
      >
        <Text style={styles.proseText}>
          {estimate.scope_prose?.trim() ||
            'No scope prose has been written for this estimate. The customer will only see the line items.'}
        </Text>
      </SectionCard>

      {/* 02 — LINE ITEMS */}
      <SectionCard
        sectionKey="lines"
        state={sectionState('lines')}
        onConfirm={() => toggleSection('lines')}
      >
        {estimate.lines.length === 0 ? (
          <Text style={styles.bodyText}>This estimate has no line items yet.</Text>
        ) : (
          <View style={styles.lineList}>
            {estimate.lines.map((line) => (
              <View key={line.id} style={styles.lineRow}>
                <View style={styles.lineLeft}>
                  <Text style={styles.lineDesc}>{line.description}</Text>
                  <View style={styles.badgeRow}>
                    <Text style={styles.lineQty}>×{qtyText(line.qty)}</Text>
                    {line.line_type === 'allowance' ? (
                      <Badge label="ALLOWANCE" tone="warning" />
                    ) : null}
                    {line.line_type === 'verify' || line.confidence === 'verify' ? (
                      <Badge label="VERIFY ON SITE" tone="accent" />
                    ) : null}
                    {isEdited(line) ? <Badge label="EDITED" tone="ink" /> : null}
                  </View>
                </View>
                <Text style={styles.lineTotal}>{money(line.totals?.['total'])}</Text>
              </View>
            ))}
          </View>
        )}
        {hasUnpricedAllowance ? (
          <View style={styles.cautionRow}>
            <AlertTriangle size={18} color={colors.warning} />
            <Text style={styles.cautionText}>
              You have unpriced allowances — the customer will see them as to-be-confirmed.
            </Text>
          </View>
        ) : null}
      </SectionCard>

      {/* 03 — TOTALS */}
      <SectionCard
        sectionKey="totals"
        state={sectionState('totals')}
        onConfirm={() => toggleSection('totals')}
      >
        <View style={styles.totalsRow}>
          <Text style={styles.totalsLabel}>Subtotal</Text>
          <Text style={styles.totalsValue}>{money(totals['subtotal'])}</Text>
        </View>
        <View style={styles.totalsRow}>
          <Text style={styles.totalsLabel}>Tax</Text>
          <Text style={styles.totalsValue}>{money(totals['tax'])}</Text>
        </View>
        <View style={styles.grandTotalRow}>
          <Text style={styles.grandTotalLabel}>Total</Text>
          <Text style={styles.grandTotalValue}>{money(totals['total'])}</Text>
        </View>
        {margin ? (
          belowFloor ? (
            <View style={styles.floorBanner}>
              <AlertTriangle size={18} color={colors.textOnPrimary} />
              <Text style={styles.floorBannerText}>
                Margin {Number.isFinite(effectivePct) ? `${effectivePct.toFixed(1)}%` : '—'} is
                below your floor. This job may lose money as priced.
              </Text>
            </View>
          ) : (
            <Text style={[styles.marginLine, belowTarget && styles.marginBelowTarget]}>
              Margin {Number.isFinite(effectivePct) ? `${effectivePct.toFixed(1)}%` : '—'} · target{' '}
              {Number.isFinite(targetPct) ? `${targetPct.toFixed(1)}%` : '—'}
              {belowTarget ? ' — below target' : ''}
            </Text>
          )
        ) : null}
      </SectionCard>

      {/* 04 — TERMS */}
      <SectionCard
        sectionKey="terms"
        state={sectionState('terms')}
        onConfirm={() => toggleSection('terms')}
      >
        <View style={styles.quoteBlock}>
          <Text style={styles.quoteText}>{DISCLAIMER(companyName)}</Text>
        </View>
        <Text style={styles.hintText}>Company terms are added in the proposal step.</Text>
      </SectionCard>

      <View style={styles.approveBlock}>
        <Text style={styles.progressText}>
          {allConfirmed
            ? 'All four sections confirmed.'
            : `${confirmedCount} of 4 sections confirmed.`}
        </Text>
        <Button
          title="Approve estimate"
          disabled={!allConfirmed}
          loading={approve.isPending}
          onPress={() => approve.mutate()}
        />
        <ErrorText
          message={
            approve.isError
              ? approve.error instanceof ApiError && approve.error.status === 409
                ? 'The server needs the highlighted sections re-confirmed before approval.'
                : approve.error instanceof ApiError
                  ? approve.error.message
                  : 'Could not approve the estimate. Try again.'
              : null
          }
        />
        <Text style={styles.footNote}>
          Approval unlocks sending. Until then, nothing reaches the customer.
        </Text>
      </View>
    </Shell>
  );
}

/** Ink header shell — safe-area strip, back row, HeaderBand, scrolling body. */
function Shell({
  insets,
  onBack,
  eyebrow,
  title,
  meta,
  children,
}: {
  insets: { top: number; bottom: number };
  onBack: () => void;
  eyebrow: string;
  title: string;
  meta?: string;
  children: ReactNode;
}) {
  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <View style={{ height: insets.top, backgroundColor: colors.ink }} />
      <View style={styles.backStrip}>
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={({ pressed }) => [styles.backButton, pressed && { opacity: 0.7 }]}
        >
          <ChevronLeft size={20} color={colors.textOnInk} />
          <Text style={styles.backText}>Back</Text>
        </Pressable>
      </View>
      <HeaderBand eyebrow={eyebrow} title={title} {...(meta !== undefined ? { meta } : {})} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + spacing.xxl }]}
      >
        {children}
      </ScrollView>
    </View>
  );
}

/** One step of the walk: locked stub, or full card with its confirm row. */
function SectionCard({
  sectionKey,
  state,
  onConfirm,
  children,
}: {
  sectionKey: SectionKey;
  state: { locked: boolean; isConfirmed: boolean; isFlagged: boolean };
  onConfirm: () => void;
  children: ReactNode;
}) {
  const meta = SECTION_META[sectionKey];

  if (state.locked) {
    return (
      <View style={[styles.sectionCard, styles.sectionLocked]}>
        <View style={styles.sectionHeader}>
          <Text style={styles.stepNumber}>{meta.step}</Text>
          <Text style={[styles.sectionTitle, styles.sectionTitleLocked]}>{meta.title}</Text>
          <Lock size={18} color={colors.textMuted} />
        </View>
        <Text style={styles.lockedHint}>Confirm the previous section to unlock.</Text>
      </View>
    );
  }

  return (
    <View style={[styles.sectionCard, state.isFlagged && styles.sectionFlagged]}>
      <View style={styles.sectionHeader}>
        <Text style={styles.stepNumber}>{meta.step}</Text>
        <Text style={styles.sectionTitle}>{meta.title}</Text>
        {state.isConfirmed ? (
          <View style={styles.confirmedDot}>
            <Check size={14} color={colors.textOnPrimary} strokeWidth={3} />
          </View>
        ) : null}
      </View>
      {state.isFlagged ? (
        <Text style={styles.flaggedText}>Please re-confirm this section.</Text>
      ) : null}
      {children}
      <Pressable
        onPress={onConfirm}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: state.isConfirmed }}
        accessibilityLabel={meta.confirmLabel}
        style={({ pressed }) => [styles.confirmRow, pressed && { opacity: 0.8 }]}
      >
        <View style={[styles.checkbox, state.isConfirmed && styles.checkboxChecked]}>
          {state.isConfirmed ? <Check size={16} color={colors.textOnInk} strokeWidth={3} /> : null}
        </View>
        <Text style={styles.confirmLabel}>{meta.confirmLabel}</Text>
      </Pressable>
    </View>
  );
}

function Badge({ label, tone }: { label: string; tone: 'warning' | 'accent' | 'ink' }) {
  return (
    <View
      style={[
        styles.badge,
        tone === 'warning' && styles.badgeWarning,
        tone === 'accent' && styles.badgeAccent,
        tone === 'ink' && styles.badgeInk,
      ]}
    >
      <Text
        style={[
          styles.badgeText,
          tone === 'warning' && { color: colors.warning },
          tone === 'accent' && { color: colors.accentText },
          tone === 'ink' && { color: colors.textOnInk },
        ]}
      >
        {label}
      </Text>
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
    paddingVertical: spacing.xl,
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

  // Section cards
  sectionCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  sectionLocked: { backgroundColor: colors.surfaceSunken, borderStyle: 'dashed' },
  sectionFlagged: { borderColor: colors.danger, borderWidth: 1.5 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  stepNumber: {
    color: colors.accentText,
    fontSize: typography.size.sm,
    fontFamily: typography.family.mono,
  },
  sectionTitle: {
    flex: 1,
    color: colors.text,
    fontSize: typography.size.md,
    fontFamily: typography.family.bold,
  },
  sectionTitleLocked: { color: colors.textMuted },
  lockedHint: {
    color: colors.textMuted,
    fontSize: typography.size.xs,
    fontFamily: typography.family.regular,
  },
  flaggedText: {
    color: colors.danger,
    fontSize: typography.size.sm,
    fontFamily: typography.family.medium,
  },
  proseText: {
    color: colors.text,
    fontSize: typography.size.md,
    fontFamily: typography.family.regular,
    lineHeight: 24,
  },

  // Confirm row
  confirmRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: touchTarget,
    marginTop: spacing.xs,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  checkbox: {
    width: 26,
    height: 26,
    borderRadius: radii.sm,
    borderWidth: 2,
    borderColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  checkboxChecked: { backgroundColor: colors.ink },
  confirmLabel: {
    flex: 1,
    color: colors.text,
    fontSize: typography.size.md,
    fontFamily: typography.family.semibold,
  },
  confirmedDot: {
    width: 22,
    height: 22,
    borderRadius: radii.full,
    backgroundColor: colors.success,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Line items
  lineList: { gap: 0 },
  lineRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.sm + 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  lineLeft: { flex: 1, gap: spacing.xs },
  lineDesc: {
    color: colors.text,
    fontSize: typography.size.sm,
    fontFamily: typography.family.medium,
    lineHeight: 20,
  },
  lineQty: {
    color: colors.textMuted,
    fontSize: typography.size.xs,
    fontFamily: typography.family.mono,
  },
  lineTotal: {
    color: colors.text,
    fontSize: typography.size.sm,
    fontFamily: typography.family.mono,
    textAlign: 'right',
  },
  badgeRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.xs },
  badge: { borderRadius: radii.sm, paddingHorizontal: spacing.sm, paddingVertical: 2 },
  badgeWarning: { backgroundColor: colors.warningBg },
  badgeAccent: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.accentText,
  },
  badgeInk: { backgroundColor: colors.ink },
  badgeText: { fontSize: 10, fontFamily: typography.family.semibold, letterSpacing: 1 },
  cautionRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    backgroundColor: colors.warningBg,
    borderRadius: radii.md,
    padding: spacing.sm + 2,
  },
  cautionText: {
    flex: 1,
    color: colors.warning,
    fontSize: typography.size.sm,
    fontFamily: typography.family.medium,
    lineHeight: 20,
  },

  // Totals
  totalsRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingVertical: spacing.xs,
  },
  totalsLabel: {
    color: colors.textSecondary,
    fontSize: typography.size.sm,
    fontFamily: typography.family.medium,
  },
  totalsValue: {
    color: colors.text,
    fontSize: typography.size.md,
    fontFamily: typography.family.mono,
  },
  grandTotalRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
    borderTopWidth: 2,
    borderTopColor: colors.ink,
  },
  grandTotalLabel: {
    color: colors.ink,
    fontSize: typography.size.md,
    fontFamily: typography.family.bold,
  },
  grandTotalValue: {
    color: colors.ink,
    fontSize: typography.size.xxl,
    fontFamily: typography.family.mono,
  },
  marginLine: {
    color: colors.textSecondary,
    fontSize: typography.size.sm,
    fontFamily: typography.family.medium,
  },
  marginBelowTarget: { color: colors.warning },
  floorBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    backgroundColor: colors.danger,
    borderRadius: radii.md,
    padding: spacing.sm + 2,
  },
  floorBannerText: {
    flex: 1,
    color: colors.textOnPrimary,
    fontSize: typography.size.sm,
    fontFamily: typography.family.semibold,
    lineHeight: 20,
  },

  // Terms
  quoteBlock: {
    borderLeftWidth: 3,
    borderLeftColor: colors.primary,
    backgroundColor: colors.surfaceSunken,
    borderRadius: radii.sm,
    padding: spacing.md,
  },
  quoteText: {
    color: colors.text,
    fontSize: typography.size.sm,
    fontFamily: typography.family.regular,
    lineHeight: 22,
  },
  hintText: {
    color: colors.textMuted,
    fontSize: typography.size.xs,
    fontFamily: typography.family.regular,
    lineHeight: 18,
  },

  // Approve block
  approveBlock: { gap: spacing.sm, marginTop: spacing.sm },
  progressText: {
    color: colors.textSecondary,
    fontSize: typography.size.sm,
    fontFamily: typography.family.medium,
    textAlign: 'center',
  },
  footNote: {
    color: colors.textMuted,
    fontSize: typography.size.xs,
    fontFamily: typography.family.regular,
    textAlign: 'center',
  },

  // Approved state
  successBlock: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.md },
  successCircle: {
    width: 64,
    height: 64,
    borderRadius: radii.full,
    backgroundColor: colors.success,
    alignItems: 'center',
    justifyContent: 'center',
  },
  successTitle: {
    color: colors.text,
    fontSize: typography.size.xl,
    fontFamily: typography.family.extrabold,
    letterSpacing: -0.5,
  },
  successSub: {
    color: colors.textSecondary,
    fontSize: typography.size.sm,
    fontFamily: typography.family.medium,
  },
  tokenBox: {
    backgroundColor: colors.surfaceSunken,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  tokenText: {
    color: colors.ink,
    fontSize: typography.size.sm,
    fontFamily: typography.family.mono,
  },
});
