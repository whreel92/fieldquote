import { colors, radii, spacing, typography, type JobStatus } from '@fieldquote/ui';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from 'react-native';

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

  const sections = STATUS_ORDER.map((status) => ({
    status,
    title: STATUS_LABEL[status],
    data: (jobsQuery.data ?? []).filter((j) => j.status === status),
  })).filter((s) => s.data.length > 0);

  return (
    <View style={styles.container}>
      {jobsQuery.data?.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No jobs yet</Text>
          <Text style={styles.emptyBody}>
            Create your first job — captures and estimates hang off it.
          </Text>
          <Button title="New job" onPress={() => router.push('/job/new')} />
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.id}
          refreshControl={
            <RefreshControl
              refreshing={jobsQuery.isRefetching}
              onRefresh={() => void jobsQuery.refetch()}
            />
          }
          renderSectionHeader={({ section }) => (
            <View style={styles.sectionHeader}>
              <View
                style={[
                  styles.dot,
                  { backgroundColor: colors.status[section.status as JobStatus] },
                ]}
              />
              <Text style={styles.sectionTitle}>
                {section.title} · {section.data.length}
              </Text>
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
      {jobsQuery.data && jobsQuery.data.length > 0 ? (
        <View style={styles.fabWrap}>
          <Button title="+ New job" onPress={() => router.push('/job/new')} />
        </View>
      ) : null}
    </View>
  );
}

function JobRow({ job, onPress }: { job: Job; onPress: () => void }) {
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <Text style={styles.rowTitle} numberOfLines={1}>
        {job.title}
      </Text>
      <Text style={styles.rowSub} numberOfLines={1}>
        {job.client_name ?? 'No client'}
        {job.address ? ` · ${job.address}` : ''}
      </Text>
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
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  sectionTitle: {
    fontSize: typography.size.sm,
    fontFamily: typography.family.semibold,
    color: colors.textSecondary,
  },
  row: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
    gap: 2,
  },
  rowTitle: {
    fontSize: typography.size.md,
    fontFamily: typography.family.medium,
    color: colors.text,
  },
  rowSub: { fontSize: typography.size.sm, color: colors.textMuted },
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
    fontFamily: typography.family.semibold,
    color: colors.text,
    textAlign: 'center',
  },
  emptyBody: { fontSize: typography.size.sm, color: colors.textSecondary, textAlign: 'center' },
  fabWrap: {
    position: 'absolute',
    bottom: spacing.lg,
    left: spacing.lg,
    right: spacing.lg,
    maxWidth: 480,
    alignSelf: 'center',
    width: '100%',
  },
});
