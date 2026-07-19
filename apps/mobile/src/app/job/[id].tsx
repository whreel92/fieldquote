import { colors, radii, spacing, typography, type JobStatus } from '@fieldquote/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button, Card, ErrorText } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { selectJobSummary, useQueueStore } from '@/lib/captureQueue';

/** Capture/generation routes are dynamic and not yet in the generated route typings. */
const href = (path: string) => path as Href;

const ESTIMATE_STATUS: Record<string, { label: string; color: string }> = {
  draft: { label: 'DRAFT', color: colors.warning },
  approved: { label: 'APPROVED', color: colors.success },
  superseded: { label: 'SUPERSEDED', color: colors.textMuted },
  generation_failed: { label: 'FAILED', color: colors.danger },
};

function estimateTotal(totals: Record<string, unknown> | null): string {
  const raw = totals?.['total'];
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return '—';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const STATUS_LABEL: Record<string, string> = {
  lead: 'Lead',
  estimating: 'Estimating',
  sent: 'Sent',
  won: 'Won',
  in_progress: 'In progress',
  complete: 'Complete',
  paid: 'Paid',
  lost: 'Lost',
};

export default function JobDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();

  const jobQuery = useQuery({
    queryKey: ['job', id],
    queryFn: () => api.jobs.get(id),
    enabled: Boolean(id),
  });

  const capturesQuery = useQuery({
    queryKey: ['captures', id],
    queryFn: () => api.captures.list(id),
    enabled: Boolean(id),
  });
  const estimatesQuery = useQuery({
    queryKey: ['estimates', id],
    queryFn: () => api.estimates.listForJob(id),
    enabled: Boolean(id),
  });
  const queueItems = useQueueStore((state) => state.items);
  const queueSummary = useMemo(() => selectJobSummary(queueItems, id ?? ''), [queueItems, id]);
  const uploadedCount = (capturesQuery.data ?? []).filter(
    (capture) => capture.upload_state === 'uploaded',
  ).length;

  const generate = useMutation({
    mutationFn: () => api.estimates.generate(id),
    onSuccess: () => router.push(href(`/generation/${id}`)),
  });

  const transition = useMutation({
    mutationFn: (to: string) => api.jobs.transition(id, to),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['job', id] });
      await queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
  });

  const job = jobQuery.data;
  if (!job) {
    return (
      <View style={styles.loading}>
        <Text style={styles.muted}>{jobQuery.isError ? 'Job not found.' : 'Loading…'}</Text>
      </View>
    );
  }

  const statusColor = colors.status[job.status as JobStatus] ?? colors.textMuted;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <Text style={styles.title}>{job.title}</Text>
      <View style={styles.statusRow}>
        <View style={[styles.dot, { backgroundColor: statusColor }]} />
        <Text style={[styles.statusText, { color: statusColor }]}>
          {STATUS_LABEL[job.status] ?? job.status}
        </Text>
      </View>

      <Card>
        <Text style={styles.cardLabel}>Client</Text>
        <Text style={styles.cardValue}>{job.client_name ?? 'No client attached'}</Text>
        <Text style={styles.cardLabel}>Address</Text>
        <Text style={styles.cardValue}>{job.address ?? '—'}</Text>
      </Card>

      {job.allowed_transitions.length > 0 ? (
        <Card>
          <Text style={styles.cardLabel}>Move to</Text>
          <View style={styles.transitionRow}>
            {job.allowed_transitions.map((t) => (
              <View key={t} style={styles.transitionButton}>
                <Button
                  title={STATUS_LABEL[t] ?? t}
                  variant={t === 'lost' ? 'danger' : 'secondary'}
                  onPress={() => transition.mutate(t)}
                  loading={transition.isPending && transition.variables === t}
                />
              </View>
            ))}
          </View>
          <ErrorText
            message={
              transition.isError
                ? transition.error instanceof ApiError
                  ? transition.error.message
                  : 'Could not update status.'
                : null
            }
          />
        </Card>
      ) : null}

      <Card>
        <Text style={styles.cardLabel}>Captures</Text>
        <Text style={styles.cardValue}>
          {uploadedCount === 0 && queueSummary.total === 0
            ? 'No captures yet'
            : `${uploadedCount} synced`}
        </Text>
        {queueSummary.label ? <Text style={styles.queueLabel}>{queueSummary.label}</Text> : null}
        {uploadedCount === 0 && queueSummary.total === 0 ? (
          <Text style={styles.muted}>
            Photos and a voice note from the site become the estimate.
          </Text>
        ) : null}
        <View style={styles.captureActions}>
          <View style={styles.captureActionButton}>
            <Button title="Capture" onPress={() => router.push(href(`/capture/${id}`))} />
          </View>
          {uploadedCount >= 1 ? (
            <View style={styles.captureActionButton}>
              <Button
                title="Generate estimate"
                variant="secondary"
                loading={generate.isPending}
                onPress={() => generate.mutate()}
              />
            </View>
          ) : null}
        </View>
        <ErrorText
          message={
            generate.isError
              ? generate.error instanceof ApiError && generate.error.status === 409
                ? 'Captures are still syncing — they upload automatically when you’re back online. Try again once they land.'
                : generate.error instanceof ApiError
                  ? generate.error.message
                  : 'Could not start generation. Try again.'
              : null
          }
        />
      </Card>

      <Card>
        <Text style={styles.cardLabel}>Estimates</Text>
        {(estimatesQuery.data ?? []).length === 0 ? (
          <Text style={styles.muted}>
            {estimatesQuery.isPending
              ? 'Loading estimates…'
              : 'No estimates yet. Capture the site, then generate one.'}
          </Text>
        ) : (
          (estimatesQuery.data ?? []).map((estimate) => {
            const chip = ESTIMATE_STATUS[estimate.status] ?? {
              label: estimate.status.toUpperCase(),
              color: colors.textMuted,
            };
            return (
              <Pressable
                key={estimate.id}
                onPress={() => router.push(href(`/estimate/${estimate.id}`))}
                accessibilityRole="button"
                accessibilityLabel={`Open estimate version ${estimate.version}`}
                style={({ pressed }) => [styles.estimateRow, pressed && { opacity: 0.7 }]}
              >
                <Text style={styles.estimateVersion}>v{estimate.version}</Text>
                <View style={[styles.estimateChip, { borderColor: chip.color }]}>
                  <Text style={[styles.estimateChipText, { color: chip.color }]}>{chip.label}</Text>
                </View>
                <Text style={styles.estimateTotal}>
                  {estimateTotal(estimate.totals as Record<string, unknown> | null)}
                </Text>
              </Pressable>
            );
          })
        )}
      </Card>

      {(
        [
          ['Proposals', 'Send, e-sign & deposits arrive in Phase 6.'],
          ['Invoices', 'Invoicing arrives in Phase 7.'],
        ] as const
      ).map(([section, note]) => (
        <Card key={section}>
          <Text style={styles.cardLabel}>{section}</Text>
          <Text style={styles.muted}>{note}</Text>
        </Card>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.bg },
  container: {
    width: '100%',
    maxWidth: 640,
    alignSelf: 'center',
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: spacing.xxl,
  },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  title: { fontSize: typography.size.xl, fontFamily: typography.family.bold, color: colors.text },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dot: { width: 10, height: 10, borderRadius: 5 },
  statusText: { fontSize: typography.size.sm, fontFamily: typography.family.semibold },
  cardLabel: {
    fontSize: typography.size.xs,
    fontFamily: typography.family.semibold,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  cardValue: { fontSize: typography.size.md, color: colors.text },
  transitionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  transitionButton: { minWidth: 130, borderRadius: radii.md },
  muted: { fontSize: typography.size.sm, color: colors.textMuted },
  queueLabel: {
    fontSize: typography.size.sm,
    fontFamily: typography.family.mono,
    color: colors.textSecondary,
  },
  captureActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  captureActionButton: { flexGrow: 1, minWidth: 140 },
  estimateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 44,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  estimateVersion: {
    fontSize: typography.size.sm,
    fontFamily: typography.family.mono,
    color: colors.text,
    minWidth: 32,
  },
  estimateChip: {
    borderWidth: 1.5,
    borderRadius: radii.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  estimateChipText: {
    fontSize: 10,
    fontFamily: typography.family.semibold,
    letterSpacing: 1,
  },
  estimateTotal: {
    flex: 1,
    textAlign: 'right',
    fontSize: typography.size.sm,
    fontFamily: typography.family.mono,
    color: colors.text,
  },
});
