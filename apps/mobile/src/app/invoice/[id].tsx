/**
 * Invoice detail (Phase 7). Loads api.invoices.detail(id): status, line
 * items, payments (incl. refunds as negative rows), and the actions that
 * matter per state:
 *   draft            → Send invoice
 *   sent/partial     → Share pay link + Remind (polite nudge, queued)
 *   paid/partial     → Refund (owner-level, double-confirmed)
 * Sent invoices are immutable — this screen never edits amounts.
 */

import { colors, radii, spacing, typography } from '@fieldquote/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { AlertCircle, Bell, ExternalLink, Share2 } from 'lucide-react-native';
import { useCallback } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EquipmentLabel } from '@/components/header-band';
import { Button, ErrorText } from '@/components/ui';
import { api, ApiError, type InvoiceDetail } from '@/lib/api';

const WEB_URL = process.env.EXPO_PUBLIC_WEB_URL ?? 'http://localhost:3000';

function money(value: string | null | undefined): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '$0.00';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function dateLabel(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function statusTone(status: string): { label: string; color: string; bg: string } {
  if (status === 'paid') return { label: 'Paid', color: colors.success, bg: '#DCFCE7' };
  if (status === 'draft')
    return { label: 'Draft', color: colors.textMuted, bg: colors.surfaceSunken };
  if (status === 'overdue') return { label: 'Overdue', color: colors.danger, bg: '#FEE2E2' };
  if (status === 'partial')
    return { label: 'Partial', color: colors.warning, bg: colors.warningBg };
  if (status === 'refunded')
    return { label: 'Refunded', color: colors.textMuted, bg: colors.surfaceSunken };
  return { label: 'Sent', color: colors.ink, bg: '#E0F2FE' };
}

const KIND_LABEL: Record<InvoiceDetail['kind'], string> = {
  deposit: 'Deposit',
  progress: 'Progress payment',
  final: 'Final balance',
};

export default function InvoiceDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['invoice', id],
    queryFn: () => api.invoices.detail(id),
    enabled: Boolean(id),
  });
  const invoice = query.data;

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['invoice', id] });
    void queryClient.invalidateQueries({ queryKey: ['money-summary'] });
  }, [queryClient, id]);

  const sendMutation = useMutation({
    mutationFn: () => api.invoices.send(id),
    onSuccess: refresh,
  });
  const remindMutation = useMutation({
    mutationFn: () => api.invoices.remind(id),
    onSuccess: () => {
      refresh();
      Alert.alert('Reminder queued', 'A polite payment reminder is on its way.');
    },
  });
  const refundMutation = useMutation({
    mutationFn: () => api.invoices.refund(id),
    onSuccess: refresh,
  });

  const confirmRefund = useCallback(() => {
    if (!invoice) return;
    Alert.alert(
      'Refund payment?',
      `This refunds ${money(invoice.amount_paid)} to the customer through Stripe. This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Refund',
          style: 'destructive',
          onPress: () => refundMutation.mutate(),
        },
      ],
    );
  }, [invoice, refundMutation]);

  const payUrl = invoice?.public_token ? `${WEB_URL}/i/${invoice.public_token}` : null;

  const shareLink = useCallback(() => {
    if (!payUrl || !invoice) return;
    void Share.share({
      message: `Invoice ${invoice.number} — pay online here: ${payUrl}`,
    });
  }, [payUrl, invoice]);

  const mutationError =
    [sendMutation, remindMutation, refundMutation]
      .map((m) => m.error)
      .find((e): e is Error => e instanceof Error) ?? null;

  if (query.isLoading) {
    return (
      <View style={[styles.container, styles.center]}>
        <ActivityIndicator color={colors.ink} />
      </View>
    );
  }

  if (query.isError || !invoice) {
    return (
      <View style={[styles.container, styles.center, { padding: spacing.lg }]}>
        <AlertCircle size={24} color={colors.danger} />
        <Text style={styles.errorTitle}>Couldn&apos;t load this invoice</Text>
        <Text style={styles.errorCopy}>
          {query.error instanceof ApiError ? query.error.message : 'Please try again.'}
        </Text>
        <Button title="Back" variant="secondary" onPress={() => router.back()} />
      </View>
    );
  }

  const tone = statusTone(invoice.status);
  const paid = Number(invoice.amount_paid);
  const payable = ['sent', 'partial', 'overdue'].includes(invoice.status);
  const due = dateLabel(invoice.due_at);

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.body}
        contentContainerStyle={[styles.bodyContent, { paddingBottom: insets.bottom + spacing.xxl }]}
      >
        {/* Status card */}
        <View style={styles.card}>
          <View style={styles.titleRow}>
            <Text style={styles.invoiceNumber}>{invoice.number}</Text>
            <View style={[styles.badge, { backgroundColor: tone.bg }]}>
              <Text style={[styles.badgeText, { color: tone.color }]}>{tone.label}</Text>
            </View>
          </View>
          <Text style={styles.metaText}>
            {KIND_LABEL[invoice.kind]} / {invoice.job_title ?? 'Job invoice'}
            {due ? ` / Due ${due}` : ''}
          </Text>
          <View style={styles.totalsBlock}>
            <TotalLine label="Total" value={money(invoice.total)} />
            {paid > 0 ? <TotalLine label="Paid" value={`-${money(invoice.amount_paid)}`} /> : null}
            <TotalLine label="Balance due" value={money(invoice.balance_due)} emphasized />
          </View>
        </View>

        {/* Line items */}
        <View style={styles.sectionHead}>
          <EquipmentLabel text="LINE ITEMS" />
        </View>
        <View style={styles.card}>
          {invoice.line_items.map((item, i) => (
            <View key={i} style={[styles.lineRow, i > 0 && styles.lineRowBorder]}>
              <Text style={styles.lineDesc}>{item.description ?? 'Invoice item'}</Text>
              <Text style={styles.lineAmount}>{money(item.amount)}</Text>
            </View>
          ))}
        </View>

        {/* Payments */}
        {invoice.payments.length > 0 ? (
          <>
            <View style={styles.sectionHead}>
              <EquipmentLabel text="PAYMENTS" />
            </View>
            <View style={styles.card}>
              {invoice.payments.map((p, i) => {
                const amount = Number(p.amount);
                const refund = p.status === 'refunded';
                const failed = p.status === 'failed';
                return (
                  <View key={p.id} style={[styles.lineRow, i > 0 && styles.lineRowBorder]}>
                    <View style={styles.paymentInfo}>
                      <Text style={styles.lineDesc}>
                        {refund ? 'Refund' : failed ? 'Failed payment' : 'Payment'}
                      </Text>
                      <Text style={styles.paymentMeta}>
                        {dateLabel(p.created_at) ?? ''}
                        {p.net && !refund ? ` / net ${money(p.net)}` : ''}
                      </Text>
                    </View>
                    <Text
                      style={[
                        styles.lineAmount,
                        refund && { color: colors.danger },
                        failed && { color: colors.textMuted },
                      ]}
                    >
                      {money(String(amount))}
                    </Text>
                  </View>
                );
              })}
            </View>
          </>
        ) : null}

        <ErrorText
          message={
            mutationError
              ? mutationError instanceof ApiError
                ? mutationError.message
                : 'Something went wrong. Please try again.'
              : null
          }
        />

        {/* Actions */}
        <View style={styles.actions}>
          {invoice.status === 'draft' ? (
            <Button
              title="Send invoice"
              onPress={() => sendMutation.mutate()}
              loading={sendMutation.isPending}
            />
          ) : null}
          {payable && payUrl ? (
            <>
              <ActionButton icon={Share2} label="Share pay link" onPress={shareLink} />
              <ActionButton
                icon={ExternalLink}
                label="Open pay page"
                onPress={() => void WebBrowser.openBrowserAsync(payUrl)}
              />
              <ActionButton
                icon={Bell}
                label={remindMutation.isPending ? 'Queuing reminder…' : 'Send a reminder'}
                onPress={() => remindMutation.mutate()}
                disabled={remindMutation.isPending}
              />
            </>
          ) : null}
          {paid > 0 ? (
            <Button
              title={refundMutation.isPending ? 'Refunding…' : 'Refund payment'}
              variant="danger"
              onPress={confirmRefund}
              disabled={refundMutation.isPending}
            />
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

function TotalLine({
  label,
  value,
  emphasized,
}: {
  label: string;
  value: string;
  emphasized?: boolean;
}) {
  return (
    <View style={styles.totalLine}>
      <Text style={[styles.totalLabel, emphasized && styles.totalLabelEm]}>{label}</Text>
      <Text style={[styles.totalValue, emphasized && styles.totalValueEm]}>{value}</Text>
    </View>
  );
}

function ActionButton({
  icon: Icon,
  label,
  onPress,
  disabled,
}: {
  icon: typeof Share2;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.actionBtn,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <Icon size={18} color={colors.ink} />
      <Text style={styles.actionText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.5 },
  body: { flex: 1 },
  bodyContent: {
    width: '100%',
    maxWidth: 720,
    alignSelf: 'center',
    padding: spacing.lg,
    gap: spacing.md,
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  invoiceNumber: {
    color: colors.text,
    fontFamily: typography.family.mono,
    fontSize: typography.size.lg,
  },
  badge: { borderRadius: radii.sm, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  badgeText: { fontFamily: typography.family.semibold, fontSize: typography.size.xs },
  metaText: {
    marginTop: spacing.xs,
    color: colors.textSecondary,
    fontFamily: typography.family.regular,
    fontSize: typography.size.xs,
  },
  totalsBlock: { marginTop: spacing.md, gap: spacing.xs },
  totalLine: { flexDirection: 'row', justifyContent: 'space-between' },
  totalLabel: {
    color: colors.textSecondary,
    fontFamily: typography.family.regular,
    fontSize: typography.size.sm,
  },
  totalLabelEm: { color: colors.text, fontFamily: typography.family.bold },
  totalValue: {
    color: colors.textSecondary,
    fontFamily: typography.family.mono,
    fontSize: typography.size.sm,
  },
  totalValueEm: {
    color: colors.text,
    fontFamily: typography.family.mono,
    fontSize: typography.size.lg,
  },
  sectionHead: { marginTop: spacing.sm },
  lineRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  lineRowBorder: { borderTopColor: colors.border, borderTopWidth: 1 },
  lineDesc: {
    flex: 1,
    color: colors.text,
    fontFamily: typography.family.medium,
    fontSize: typography.size.sm,
  },
  lineAmount: {
    color: colors.text,
    fontFamily: typography.family.mono,
    fontSize: typography.size.sm,
  },
  paymentInfo: { flex: 1, gap: 2 },
  paymentMeta: {
    color: colors.textMuted,
    fontFamily: typography.family.regular,
    fontSize: typography.size.xs,
  },
  actions: { gap: spacing.sm, marginTop: spacing.sm },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: 48,
    borderRadius: radii.md,
    borderColor: colors.border,
    borderWidth: 1,
    backgroundColor: colors.surface,
  },
  actionText: {
    color: colors.ink,
    fontFamily: typography.family.semibold,
    fontSize: typography.size.sm,
  },
  errorTitle: {
    color: colors.text,
    fontFamily: typography.family.bold,
    fontSize: typography.size.lg,
    textAlign: 'center',
  },
  errorCopy: {
    color: colors.textSecondary,
    fontFamily: typography.family.regular,
    fontSize: typography.size.sm,
    textAlign: 'center',
    marginBottom: spacing.md,
  },
});
