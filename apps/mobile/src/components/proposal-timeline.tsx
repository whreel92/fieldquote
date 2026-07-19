import { colors, radii, spacing, typography } from '@fieldquote/ui';
import { Check, DollarSign, Eye, Send } from 'lucide-react-native';
import type { ComponentType } from 'react';
import { StyleSheet, Text, View } from 'react-native';

/**
 * The proposal lifecycle rail: Sent → Viewed → Signed → Deposit paid.
 * Shared by the composer's sent-summary and the job detail screen. Status is
 * conveyed by icon + label + detail copy, never color alone (field-use rule).
 */

type IconType = ComponentType<{ size?: number; color?: string }>;

export function fmtDateTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${date}, ${time}`;
}

export type ProposalTimelineProps = {
  sentAt: string | null;
  firstViewedAt: string | null;
  viewCount: number;
  signedAt: string | null;
  signerName?: string | null;
  depositPaid: boolean;
};

type Step = { key: string; label: string; detail: string; done: boolean; icon: IconType };

export function ProposalTimeline({
  sentAt,
  firstViewedAt,
  viewCount,
  signedAt,
  signerName,
  depositPaid,
}: ProposalTimelineProps) {
  const signedDetail = signedAt
    ? signerName
      ? `${signerName} · ${fmtDateTime(signedAt)}`
      : (fmtDateTime(signedAt) ?? 'Signed')
    : 'Awaiting signature';

  const steps: Step[] = [
    {
      key: 'sent',
      label: 'Sent',
      detail: fmtDateTime(sentAt) ?? 'Not sent yet',
      done: Boolean(sentAt),
      icon: Send,
    },
    {
      key: 'viewed',
      label: viewCount > 0 ? `Viewed (${viewCount})` : 'Viewed',
      detail: fmtDateTime(firstViewedAt) ?? 'Not opened yet',
      done: Boolean(firstViewedAt),
      icon: Eye,
    },
    {
      key: 'signed',
      label: 'Signed',
      detail: signedDetail,
      done: Boolean(signedAt),
      icon: Check,
    },
    {
      key: 'deposit',
      label: 'Deposit paid',
      detail: depositPaid ? 'Paid' : 'Awaiting deposit',
      done: depositPaid,
      icon: DollarSign,
    },
  ];

  return (
    <View style={styles.timeline}>
      {steps.map((step, i) => {
        const Icon = step.icon;
        const last = i === steps.length - 1;
        return (
          <View key={step.key} style={styles.stepRow}>
            <View style={styles.rail}>
              <View style={[styles.node, step.done ? styles.nodeDone : styles.nodePending]}>
                <Icon size={14} color={step.done ? colors.textOnInk : colors.textMuted} />
              </View>
              {!last ? (
                <View style={[styles.connector, step.done && styles.connectorDone]} />
              ) : null}
            </View>
            <View style={styles.stepText}>
              <Text style={[styles.stepLabel, !step.done && styles.stepLabelPending]}>
                {step.label}
              </Text>
              <Text style={styles.stepDetail}>{step.detail}</Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  timeline: { gap: 0 },
  stepRow: { flexDirection: 'row', gap: spacing.md },
  rail: { alignItems: 'center', width: 28 },
  node: {
    width: 28,
    height: 28,
    borderRadius: radii.full,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
  },
  nodeDone: { backgroundColor: colors.ink, borderColor: colors.ink },
  nodePending: { backgroundColor: colors.surface, borderColor: colors.border },
  connector: {
    flex: 1,
    width: 2,
    minHeight: 18,
    backgroundColor: colors.border,
    marginVertical: 2,
  },
  connectorDone: { backgroundColor: colors.ink },
  stepText: { flex: 1, paddingBottom: spacing.md, gap: 1 },
  stepLabel: {
    color: colors.text,
    fontSize: typography.size.sm,
    fontFamily: typography.family.semibold,
  },
  stepLabelPending: { color: colors.textMuted },
  stepDetail: {
    color: colors.textSecondary,
    fontSize: typography.size.xs,
    fontFamily: typography.family.mono,
  },
});
