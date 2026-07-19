import { colors, radii, spacing, typography, type JobStatus } from '@fieldquote/ui';
import { useQuery } from '@tanstack/react-query';
import { useRouter, type Href } from 'expo-router';
import { Camera } from 'lucide-react-native';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { EquipmentLabel, HeaderBand } from '@/components/header-band';
import { Button } from '@/components/ui';
import { api, type Job } from '@/lib/api';

/** Guided-capture routes are dynamic and not yet in the generated route typings. */
const href = (path: string) => path as Href;

/** Jobs that still need a site visit come first. */
const CAPTURE_PRIORITY: Record<string, number> = {
  lead: 0,
  estimating: 1,
  sent: 2,
  in_progress: 3,
  won: 4,
  complete: 5,
  paid: 6,
  lost: 7,
};

export default function CaptureTabScreen() {
  const router = useRouter();
  const jobsQuery = useQuery({ queryKey: ['jobs'], queryFn: api.jobs.list });
  const jobs = jobsQuery.data ?? [];

  const sorted = [...jobs].sort((a, b) => {
    const byStatus = (CAPTURE_PRIORITY[a.status] ?? 8) - (CAPTURE_PRIORITY[b.status] ?? 8);
    return byStatus !== 0 ? byStatus : b.created_at.localeCompare(a.created_at);
  });

  return (
    <View style={styles.container}>
      <HeaderBand
        eyebrow="On site"
        title="Capture"
        meta={jobs.length ? `${jobs.length}` : undefined}
      />
      {jobsQuery.data?.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>Nothing to capture yet</Text>
          <Text style={styles.emptyBody}>
            Photos and a voice note become a priced estimate. Create a job to start capturing.
          </Text>
          <Button title="Create a job" onPress={() => router.push('/job/new')} />
        </View>
      ) : (
        <FlatList
          data={sorted}
          keyExtractor={(item) => item.id}
          refreshControl={
            <RefreshControl
              refreshing={jobsQuery.isRefetching}
              onRefresh={() => void jobsQuery.refetch()}
            />
          }
          ListHeaderComponent={
            <View style={styles.listHeader}>
              <EquipmentLabel text="Pick a job to capture" />
            </View>
          }
          renderItem={({ item }) => (
            <CaptureJobRow job={item} onPress={() => router.push(href(`/capture/${item.id}`))} />
          )}
          ListFooterComponent={
            <View style={styles.footer}>
              <Button
                title="+ Create a job"
                variant="secondary"
                onPress={() => router.push('/job/new')}
              />
            </View>
          }
          ListEmptyComponent={
            jobsQuery.isLoading ? <Text style={styles.emptyBody}>Loading…</Text> : null
          }
          contentContainerStyle={styles.list}
        />
      )}
    </View>
  );
}

function CaptureJobRow({ job, onPress }: { job: Job; onPress: () => void }) {
  const rail = colors.status[job.status as JobStatus] ?? colors.textMuted;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`New capture for ${job.title}`}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={[styles.rail, { backgroundColor: rail }]} />
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {job.title}
        </Text>
        <Text style={styles.rowSub} numberOfLines={1}>
          {job.client_name ?? 'No client'}
          {job.address ? `  ·  ${job.address}` : ''}
        </Text>
      </View>
      <View style={styles.captureBadge}>
        <Camera size={16} color={colors.textOnPrimary} strokeWidth={2} />
        <Text style={styles.captureBadgeText}>Capture</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  list: {
    width: '100%',
    maxWidth: 720,
    alignSelf: 'center',
    padding: spacing.md,
    paddingBottom: spacing.xxl,
  },
  listHeader: { paddingTop: spacing.sm, paddingBottom: spacing.sm },
  footer: { paddingTop: spacing.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.sm,
    overflow: 'hidden',
    minHeight: 64,
  },
  rowPressed: { backgroundColor: colors.surfaceSunken },
  rail: { width: 5, alignSelf: 'stretch' },
  rowBody: {
    flex: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 4,
    justifyContent: 'center',
    gap: 2,
  },
  rowTitle: {
    fontSize: typography.size.md,
    fontFamily: typography.family.semibold,
    color: colors.text,
  },
  rowSub: {
    fontSize: typography.size.sm,
    fontFamily: typography.family.regular,
    color: colors.textMuted,
  },
  captureBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.primary,
    borderRadius: radii.full,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginRight: spacing.md,
  },
  captureBadgeText: {
    color: colors.textOnPrimary,
    fontSize: typography.size.sm,
    fontFamily: typography.family.semibold,
  },
  empty: {
    flex: 1,
    justifyContent: 'center',
    padding: spacing.lg,
    gap: spacing.md,
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
  },
  emptyTitle: {
    fontSize: typography.size.lg,
    fontFamily: typography.family.bold,
    color: colors.text,
    textAlign: 'center',
  },
  emptyBody: {
    fontSize: typography.size.sm,
    fontFamily: typography.family.regular,
    color: colors.textSecondary,
    textAlign: 'center',
  },
});
