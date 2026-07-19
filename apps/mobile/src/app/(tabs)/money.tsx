import { colors, radii, spacing, typography } from '@fieldquote/ui';
import { useQuery } from '@tanstack/react-query';
import { useRouter, type Href } from 'expo-router';
import { AlertCircle, CheckCircle2, Clock3, DollarSign, RefreshCcw } from 'lucide-react-native';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { EquipmentLabel, HeaderBand } from '@/components/header-band';
import { api, ApiError, type Invoice } from '@/lib/api';

const href = (path: string) => path as Href;

function money(value: string | null | undefined): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '$0.00';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function dateLabel(iso: string | null): string {
  if (!iso) return 'No due date';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'No due date';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function statusTone(status: string): { label: string; color: string; bg: string } {
  if (status === 'paid') return { label: 'Paid', color: colors.success, bg: '#DCFCE7' };
  if (status === 'draft')
    return { label: 'Draft', color: colors.textMuted, bg: colors.surfaceSunken };
  if (status === 'overdue') return { label: 'Overdue', color: colors.danger, bg: '#FEE2E2' };
  if (status === 'partial')
    return { label: 'Partial', color: colors.warning, bg: colors.warningBg };
  return { label: 'Sent', color: colors.ink, bg: '#E0F2FE' };
}

function kindLabel(kind: Invoice['kind']): string {
  if (kind === 'deposit') return 'Deposit';
  if (kind === 'progress') return 'Progress';
  return 'Final';
}

export default function MoneyScreen() {
  const router = useRouter();
  const summary = useQuery({
    queryKey: ['money-summary'],
    queryFn: api.money.summary,
  });
  const invoices = summary.data?.invoices ?? [];

  return (
    <View style={styles.container}>
      <HeaderBand eyebrow="Cash flow" title="Money" meta={money(summary.data?.outstanding)} />
      <ScrollView
        style={styles.body}
        contentContainerStyle={styles.bodyContent}
        refreshControl={
          <RefreshControl
            refreshing={summary.isRefetching}
            onRefresh={() => void summary.refetch()}
          />
        }
      >
        {summary.isError ? (
          <View style={styles.errorBox}>
            <AlertCircle size={20} color={colors.danger} />
            <Text style={styles.errorText}>
              {summary.error instanceof ApiError
                ? summary.error.message
                : 'Could not load money summary.'}
            </Text>
            <Pressable
              onPress={() => void summary.refetch()}
              accessibilityRole="button"
              accessibilityLabel="Retry loading money summary"
              style={({ pressed }) => [styles.retryBtn, pressed && styles.pressed]}
            >
              <RefreshCcw size={16} color={colors.ink} />
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <View style={styles.metrics}>
              <Metric
                icon={DollarSign}
                label="Outstanding"
                value={money(summary.data?.outstanding)}
              />
              <Metric
                icon={CheckCircle2}
                label="Paid this month"
                value={money(summary.data?.paid_this_month)}
              />
              <Metric icon={Clock3} label="In transit" value={money(summary.data?.in_transit)} />
            </View>

            <View style={styles.sectionHead}>
              <EquipmentLabel text="INVOICES" />
              <Text style={styles.count}>{invoices.length}</Text>
            </View>

            {summary.isLoading ? (
              <View style={styles.skeletonList}>
                {[72, 72, 72].map((height, i) => (
                  <View key={i} style={[styles.skeleton, { height }]} />
                ))}
              </View>
            ) : invoices.length > 0 ? (
              <View style={styles.invoiceList}>
                {invoices.map((invoice) => (
                  <InvoiceRow
                    key={invoice.id}
                    invoice={invoice}
                    onPress={() => router.push(href(`/invoice/${invoice.id}`))}
                  />
                ))}
              </View>
            ) : (
              <View style={styles.empty}>
                <Text style={styles.emptyTitle}>Nothing outstanding</Text>
                <Text style={styles.emptyCopy}>Sent deposits and invoices will appear here.</Text>
              </View>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof DollarSign;
  label: string;
  value: string;
}) {
  return (
    <View style={styles.metric}>
      <View style={styles.metricIcon}>
        <Icon size={18} color={colors.ink} />
      </View>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

function InvoiceRow({ invoice, onPress }: { invoice: Invoice; onPress: () => void }) {
  const tone = statusTone(invoice.status);
  const firstLine = invoice.line_items[0]?.description ?? kindLabel(invoice.kind);
  const balance = Number(invoice.balance_due);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${invoice.number}, ${money(invoice.balance_due)} due`}
      style={({ pressed }) => [styles.invoice, pressed && styles.pressed]}
    >
      <View style={styles.invoiceTop}>
        <View style={styles.invoiceTitleWrap}>
          <Text style={styles.invoiceNumber}>{invoice.number}</Text>
          <Text style={styles.invoiceTitle} numberOfLines={1}>
            {invoice.job_title ?? 'Job invoice'}
          </Text>
        </View>
        <View style={[styles.badge, { backgroundColor: tone.bg }]}>
          <Text style={[styles.badgeText, { color: tone.color }]}>{tone.label}</Text>
        </View>
      </View>
      <View style={styles.invoiceBottom}>
        <Text style={styles.invoiceMeta}>
          {kindLabel(invoice.kind)} / {firstLine} / Due {dateLabel(invoice.due_at)}
        </Text>
        <Text style={styles.invoiceAmount}>
          {money(balance > 0 ? invoice.balance_due : invoice.total)}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  pressed: { opacity: 0.72 },
  body: { flex: 1 },
  bodyContent: {
    width: '100%',
    maxWidth: 720,
    alignSelf: 'center',
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
    gap: spacing.lg,
  },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  metric: {
    flexGrow: 1,
    flexBasis: 152,
    minHeight: 112,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  metricIcon: {
    width: 32,
    height: 32,
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceSunken,
    alignItems: 'center',
    justifyContent: 'center',
  },
  metricLabel: {
    color: colors.textMuted,
    fontFamily: typography.family.medium,
    fontSize: typography.size.xs,
  },
  metricValue: {
    color: colors.text,
    fontFamily: typography.family.mono,
    fontSize: typography.size.lg,
  },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  count: {
    color: colors.textMuted,
    fontFamily: typography.family.mono,
    fontSize: typography.size.xs,
  },
  invoiceList: { gap: spacing.sm },
  invoice: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  invoiceTop: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  invoiceTitleWrap: { flex: 1, minWidth: 0 },
  invoiceNumber: {
    color: colors.textMuted,
    fontFamily: typography.family.mono,
    fontSize: typography.size.xs,
  },
  invoiceTitle: {
    color: colors.text,
    fontFamily: typography.family.semibold,
    fontSize: typography.size.md,
  },
  badge: {
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  badgeText: {
    fontFamily: typography.family.semibold,
    fontSize: typography.size.xs,
  },
  invoiceBottom: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  invoiceMeta: {
    flex: 1,
    color: colors.textSecondary,
    fontFamily: typography.family.regular,
    fontSize: typography.size.xs,
    lineHeight: 18,
  },
  invoiceAmount: {
    color: colors.text,
    fontFamily: typography.family.mono,
    fontSize: typography.size.md,
    textAlign: 'right',
  },
  empty: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  emptyTitle: {
    color: colors.text,
    fontFamily: typography.family.bold,
    fontSize: typography.size.lg,
    textAlign: 'center',
  },
  emptyCopy: {
    color: colors.textSecondary,
    fontFamily: typography.family.regular,
    fontSize: typography.size.sm,
    textAlign: 'center',
    lineHeight: 20,
  },
  errorBox: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.lg,
    gap: spacing.sm,
    alignItems: 'center',
  },
  errorText: {
    color: colors.textSecondary,
    fontFamily: typography.family.regular,
    fontSize: typography.size.sm,
    textAlign: 'center',
  },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: 44,
    borderRadius: radii.md,
    borderColor: colors.border,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
  },
  retryText: {
    color: colors.ink,
    fontFamily: typography.family.semibold,
    fontSize: typography.size.sm,
  },
  skeletonList: { gap: spacing.sm },
  skeleton: { borderRadius: radii.md, backgroundColor: colors.surfaceSunken },
});
