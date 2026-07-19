/**
 * Options builder (§Phase 5.6) — promote one line into good/better/best.
 *
 * Opened with `?lineId=`. Pre-fills three tiers from the line: good keeps
 * the current description and total, better suggests +25%, best +50% —
 * every label and total editable. Best can be dropped (minimum two
 * tiers); a radio picks the tier that counts toward the estimate total.
 * Save calls `api.estimates.buildOptions` and returns to the editor.
 */

import { colors, radii, spacing, touchTarget, typography } from '@fieldquote/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AlertTriangle, Check, ChevronLeft, Plus, Trash2 } from 'lucide-react-native';
import { useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EquipmentLabel, HeaderBand } from '@/components/header-band';
import { Button, Card, ErrorText } from '@/components/ui';
import { api, ApiError, type EstimateDetail } from '@/lib/api';

type EstimateLine = EstimateDetail['lines'][number];
type Tier = 'good' | 'better' | 'best';

type TierForm = { label: string; total: string };
type TierEdits = Partial<Record<Tier, Partial<TierForm>>>;
type FormState = {
  tiers: Record<Tier, TierForm>;
  includeBest: boolean;
  selected: Tier;
};

const TIER_ORDER: readonly Tier[] = ['good', 'better', 'best'];
const TIER_TITLE: Record<Tier, string> = { good: 'Good', better: 'Better', best: 'Best' };

function numeric(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value.replace(/[$,]/g, ''));
  return NaN;
}

function money(value: unknown): string {
  const n = numeric(value);
  if (!Number.isFinite(n)) return '—';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Suggested tiers from the line — good keeps the line, better +25%, best +50%. */
function defaultTiers(line: EstimateLine): Record<Tier, TierForm> {
  const base = numeric(line.totals?.['total']);
  const safeBase = Number.isFinite(base) && base > 0 ? base : 0;
  return {
    good: { label: line.description, total: safeBase.toFixed(2) },
    better: { label: 'Better', total: (safeBase * 1.25).toFixed(2) },
    best: { label: 'Best', total: (safeBase * 1.5).toFixed(2) },
  };
}

export default function OptionsBuilderScreen() {
  const { id, lineId } = useLocalSearchParams<{ id: string; lineId: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();

  // The form is derived: suggested tiers from the line + the user's sparse
  // edits on top. No effect-seeded state — defaults exist the moment the
  // line loads, and edits survive refetches.
  const [edits, setEdits] = useState<TierEdits>({});
  const [includeBest, setIncludeBest] = useState(true);
  const [selectedTier, setSelectedTier] = useState<Tier>('good');

  const estimateQuery = useQuery({
    queryKey: ['estimate', id],
    queryFn: () => api.estimates.get(id),
    enabled: Boolean(id),
  });

  const estimate = estimateQuery.data;
  const line = estimate?.lines.find((candidate) => candidate.id === lineId);

  const form: FormState | null = line
    ? {
        tiers: (() => {
          const defaults = defaultTiers(line);
          return {
            good: { ...defaults.good, ...edits.good },
            better: { ...defaults.better, ...edits.better },
            best: { ...defaults.best, ...edits.best },
          };
        })(),
        includeBest,
        selected: selectedTier,
      }
    : null;

  const save = useMutation({
    mutationFn: (state: FormState) => {
      const activeTiers = TIER_ORDER.filter((tier) => tier !== 'best' || state.includeBest);
      return api.estimates.buildOptions(id, lineId, {
        tiers: activeTiers.map((tier) => ({
          tier,
          label: state.tiers[tier].label.trim(),
          total: numeric(state.tiers[tier].total).toFixed(2),
        })),
        selected: state.selected,
      });
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(['estimate', id], updated);
      void queryClient.invalidateQueries({ queryKey: ['estimate', id] });
      if (router.canGoBack()) router.back();
    },
  });

  const goBack = () => {
    if (router.canGoBack()) router.back();
  };

  const setTierField = (tier: Tier, field: keyof TierForm, value: string) => {
    setEdits((prev) => ({ ...prev, [tier]: { ...prev[tier], [field]: value } }));
  };

  const setSelected = (tier: Tier) => {
    setSelectedTier(tier);
  };

  const toggleBest = (include: boolean) => {
    setIncludeBest(include);
    if (!include) setSelectedTier((prev) => (prev === 'best' ? 'good' : prev));
  };

  const activeTiers = form ? TIER_ORDER.filter((tier) => tier !== 'best' || form.includeBest) : [];
  const formValid =
    form !== null &&
    activeTiers.every((tier) => {
      const entry = form.tiers[tier];
      const total = numeric(entry.total);
      return entry.label.trim().length > 0 && Number.isFinite(total) && total >= 0;
    });

  // ── Loading / error / not-found shells ────────────────────────────────────
  let content: ReactNode;
  if (estimateQuery.isPending) {
    content = <Text style={styles.mutedCenter}>Loading line…</Text>;
  } else if (estimateQuery.isError || !estimate) {
    content = (
      <Card>
        <View style={styles.iconTitleRow}>
          <AlertTriangle size={22} color={colors.warning} />
          <Text style={styles.blockTitle}>Could not load the estimate</Text>
        </View>
        <Text style={styles.bodyText}>
          {estimateQuery.error instanceof ApiError
            ? estimateQuery.error.message
            : 'Check your connection and try again.'}
        </Text>
        <Button title="Try again" onPress={() => void estimateQuery.refetch()} />
        <Button title="Back" variant="secondary" onPress={goBack} />
      </Card>
    );
  } else if (!lineId || !line) {
    content = (
      <Card>
        <View style={styles.iconTitleRow}>
          <AlertTriangle size={22} color={colors.warning} />
          <Text style={styles.blockTitle}>Line not found</Text>
        </View>
        <Text style={styles.bodyText}>
          This line is no longer on the estimate. Head back to the editor and pick a line to build
          options from.
        </Text>
        <Button title="Back to estimate" variant="secondary" onPress={goBack} />
      </Card>
    );
  } else if (form) {
    content = (
      <>
        <Card>
          <EquipmentLabel text="BASE LINE" />
          <Text style={styles.baseDesc}>{line.description}</Text>
          <Text style={styles.baseTotal}>{money(line.totals?.['total'])}</Text>
          <Text style={styles.hintText}>
            Only the selected tier counts toward the total; the customer can pick on the proposal.
          </Text>
        </Card>

        {activeTiers.map((tier) => (
          <TierCard
            key={tier}
            tier={tier}
            form={form.tiers[tier]}
            isSelected={form.selected === tier}
            onSelect={() => setSelected(tier)}
            onLabelChange={(value) => setTierField(tier, 'label', value)}
            onTotalChange={(value) => setTierField(tier, 'total', value)}
            onRemove={tier === 'best' ? () => toggleBest(false) : undefined}
          />
        ))}

        {!form.includeBest ? (
          <Pressable
            onPress={() => toggleBest(true)}
            accessibilityRole="button"
            accessibilityLabel="Add a Best tier"
            style={({ pressed }) => [styles.addTierRow, pressed && { opacity: 0.8 }]}
          >
            <Plus size={18} color={colors.accentText} />
            <Text style={styles.addTierText}>Add a “Best” tier</Text>
          </Pressable>
        ) : null}

        <Button
          title="Save options"
          disabled={!formValid}
          loading={save.isPending}
          onPress={() => save.mutate(form)}
        />
        <ErrorText
          message={
            save.isError
              ? save.error instanceof ApiError && save.error.status === 409
                ? 'This estimate is approved and locked. Fork a new draft version to change options.'
                : save.error instanceof ApiError
                  ? save.error.message
                  : 'Could not save the options. Try again.'
              : null
          }
        />
        <Text style={styles.footNote}>
          Good, better and best render as selectable tiers on the customer proposal.
        </Text>
      </>
    );
  } else {
    content = <Text style={styles.mutedCenter}>Preparing tiers…</Text>;
  }

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
        eyebrow="OPTIONS BUILDER"
        title="Good · Better · Best"
        {...(estimate ? { meta: `v${estimate.version}` } : {})}
      />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + spacing.xxl }]}
        keyboardShouldPersistTaps="handled"
      >
        {content}
      </ScrollView>
    </View>
  );
}

function TierCard({
  tier,
  form,
  isSelected,
  onSelect,
  onLabelChange,
  onTotalChange,
  onRemove,
}: {
  tier: Tier;
  form: TierForm;
  isSelected: boolean;
  onSelect: () => void;
  onLabelChange: (value: string) => void;
  onTotalChange: (value: string) => void;
  onRemove?: () => void;
}) {
  const labelInvalid = form.label.trim().length === 0;
  const totalInvalid = !Number.isFinite(numeric(form.total)) || numeric(form.total) < 0;

  return (
    <View style={[styles.tierCard, isSelected && styles.tierCardSelected]}>
      <View style={styles.tierHeader}>
        <Pressable
          onPress={onSelect}
          accessibilityRole="radio"
          accessibilityState={{ selected: isSelected }}
          accessibilityLabel={`Select the ${TIER_TITLE[tier]} tier`}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={({ pressed }) => [styles.radioRow, pressed && { opacity: 0.8 }]}
        >
          <View style={[styles.radioOuter, isSelected && styles.radioOuterOn]}>
            {isSelected ? <Check size={13} color={colors.textOnPrimary} strokeWidth={3} /> : null}
          </View>
          <Text style={styles.tierTitle}>{TIER_TITLE[tier]}</Text>
          {isSelected ? (
            <EquipmentLabel text="COUNTS TOWARD TOTAL" color={colors.accentText} />
          ) : null}
        </Pressable>
        {onRemove ? (
          <Pressable
            onPress={onRemove}
            accessibilityRole="button"
            accessibilityLabel="Remove the Best tier"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={({ pressed }) => [styles.removeButton, pressed && { opacity: 0.7 }]}
          >
            <Trash2 size={18} color={colors.textMuted} />
          </Pressable>
        ) : null}
      </View>

      <View style={styles.fieldBlock}>
        <Text style={styles.fieldLabel}>Label</Text>
        <TextInput
          value={form.label}
          onChangeText={onLabelChange}
          placeholder={`${TIER_TITLE[tier]} option`}
          placeholderTextColor={colors.textMuted}
          accessibilityLabel={`${TIER_TITLE[tier]} tier label`}
          style={[styles.input, labelInvalid && styles.inputInvalid]}
        />
        {labelInvalid ? <Text style={styles.fieldError}>Give this tier a label.</Text> : null}
      </View>

      <View style={styles.fieldBlock}>
        <Text style={styles.fieldLabel}>Price</Text>
        <View style={[styles.moneyInputWrap, totalInvalid && styles.inputInvalid]}>
          <Text style={styles.moneyPrefix}>$</Text>
          <TextInput
            value={form.total}
            onChangeText={onTotalChange}
            keyboardType="decimal-pad"
            placeholder="0.00"
            placeholderTextColor={colors.textMuted}
            accessibilityLabel={`${TIER_TITLE[tier]} tier price`}
            style={styles.moneyInput}
          />
        </View>
        {totalInvalid ? <Text style={styles.fieldError}>Enter a valid amount.</Text> : null}
      </View>
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
  baseDesc: {
    color: colors.text,
    fontSize: typography.size.md,
    fontFamily: typography.family.medium,
    lineHeight: 22,
  },
  baseTotal: {
    color: colors.ink,
    fontSize: typography.size.xl,
    fontFamily: typography.family.mono,
  },
  hintText: {
    color: colors.textMuted,
    fontSize: typography.size.xs,
    fontFamily: typography.family.regular,
    lineHeight: 18,
  },

  // Tier cards
  tierCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  tierCardSelected: { borderColor: colors.primary, borderWidth: 1.5 },
  tierHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  radioRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
    minHeight: 32,
  },
  radioOuter: {
    width: 24,
    height: 24,
    borderRadius: radii.full,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  radioOuterOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  tierTitle: {
    color: colors.text,
    fontSize: typography.size.md,
    fontFamily: typography.family.bold,
  },
  removeButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fieldBlock: { gap: spacing.xs },
  fieldLabel: {
    fontSize: typography.size.sm,
    fontFamily: typography.family.medium,
    color: colors.textSecondary,
  },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1.5,
    borderRadius: radii.md,
    minHeight: touchTarget,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    fontSize: typography.size.md,
    fontFamily: typography.family.regular,
    color: colors.text,
  },
  inputInvalid: { borderColor: colors.danger },
  moneyInputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1.5,
    borderRadius: radii.md,
    minHeight: touchTarget,
    paddingHorizontal: spacing.md,
    gap: spacing.xs,
  },
  moneyPrefix: {
    color: colors.textMuted,
    fontSize: typography.size.md,
    fontFamily: typography.family.mono,
  },
  moneyInput: {
    flex: 1,
    minHeight: touchTarget - 4,
    fontSize: typography.size.md,
    fontFamily: typography.family.mono,
    color: colors.text,
  },
  fieldError: {
    color: colors.danger,
    fontSize: typography.size.xs,
    fontFamily: typography.family.medium,
  },

  // Add tier
  addTierRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: touchTarget,
    borderRadius: radii.md,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  addTierText: {
    color: colors.accentText,
    fontSize: typography.size.md,
    fontFamily: typography.family.semibold,
  },
  footNote: {
    color: colors.textMuted,
    fontSize: typography.size.xs,
    fontFamily: typography.family.regular,
    textAlign: 'center',
  },
});
