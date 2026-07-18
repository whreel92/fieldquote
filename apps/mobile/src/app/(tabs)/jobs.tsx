import { colors, radii, spacing, typography, type JobStatus } from '@fieldquote/ui';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from 'react-native';

import { EquipmentLabel, HeaderBand } from '@/components/header-band';
import { Button } from '@/components/ui';
import { api, type Job } from '@/lib/api';

const STATUS_ORDER: JobStatus[] = [
  'lead',
  'estimating',
  'sent',
  'won',
  'in_progress',
  'complete',
  'paid',
  'lost',
];

const STATUS_LABEL: Record<JobStatus, string> = {
  lead: 'Leads',
  estimating: 'Estimating',
  sent: 'Sent',
  won: 'Won',
  in_progress: 'In progress',
  complete: 'Complete',
  paid: 'Paid',
  lost: 'Lost',
};

export default function JobsScreen() {
  const router = useRouter();
  const jobsQuery = useQuery({ queryKey: ['jobs'], queryFn: api.jobs.list });
  const jobs = jobsQuery.data ?? [];

  const sections = STATUS_ORDER.map((status) => ({
    status,
    title: STATUS_LABEL[status],
    data: jobs.filter((j) => j.status === status),
  })).filter((s) => s.data.length > 0);

  return (
    <View style={styles.container}>
      <HeaderBand
        eyebrow="Pipeline"
        title="Jobs"
        meta={jobs.length ? `${jobs.length}` : undefined}
      />
      {jobsQuery.data?.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No jobs on the board</Text>
          <Text style={styles.emptyBody}>
            Every estimate starts with a job. Create the first one.
          </Text>
          <Button title="Create a job" onPress={() => router.push('/job/new')} />
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.id}
          stickySectionHeadersEnabled={false}
          refreshControl={
            <RefreshControl
              refreshing={jobsQuery.isRefetching}
              onRefresh={() => void jobsQuery.refetch()}
            />
          }
          renderSectionHeader={({ section }) => (
            <View style={styles.sectionHeader}>
              <EquipmentLabel
                text={`${section.title} · ${section.data.length}`}
                color={colors.status[section.status as JobStatus]}
              />
            </View>
          )}
          renderItem={({ item }) => (
            <JobRow job={item} onPress={() => router.push(`/job/${item.id}`)} />
          )}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            jobsQuery.isLoading ? <Text style={styles.emptyBody}>Loading…</Text> : null
          }
        />
      )}
      {jobs.length > 0 ? (
        <View style={styles.fabRow} pointerEvents="box-none">
          <View style={styles.fabWrap}>
            <Button title="+ New job" onPress={() => router.push('/job/new')} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

function JobRow({ job, onPress }: { job: Job; onPress: () => void }) {
  const rail = colors.status[job.status as JobStatus] ?? colors.textMuted;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={job.title}
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
    paddingBottom: 96,
  },
  sectionHeader: { paddingTop: spacing.md, paddingBottom: spacing.sm },
  row: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.sm,
    overflow: 'hidden',
    minHeight: 64,
  },
  rowPressed: { backgroundColor: colors.surfaceSunken },
  rail: { width: 5 },
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
  fabRow: {
    position: 'absolute',
    bottom: spacing.lg,
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
  },
  fabWrap: { width: '100%', maxWidth: 480 },
});
