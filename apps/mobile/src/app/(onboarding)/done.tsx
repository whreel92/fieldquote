import { colors, spacing, typography } from '@fieldquote/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { StyleSheet, Text, View } from 'react-native';

import { Button, ErrorText } from '@/components/ui';
import { api } from '@/lib/api';

export default function OnboardingDone() {
  const queryClient = useQueryClient();

  const finish = useMutation({
    mutationFn: async () => {
      const company = await api.company.get();
      await api.company.patch({ settings: { ...company.settings, onboarded: true } });
    },
    onSuccess: async () => {
      // Root gate sees onboarded=true and routes to the tabs.
      await queryClient.invalidateQueries({ queryKey: ['company'] });
    },
  });

  return (
    <View style={styles.container}>
      <Text style={styles.emoji}>⚡</Text>
      <Text style={styles.title}>You&apos;re set up</Text>
      <Text style={styles.subtitle}>
        Create your first job from the Jobs tab. On-site capture and AI estimates arrive as the
        build progresses — anything you skipped is waiting in Settings.
      </Text>
      <ErrorText message={finish.isError ? 'Could not finish setup. Try again.' : null} />
      <Button title="Go to my jobs" onPress={() => finish.mutate()} loading={finish.isPending} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: 'center',
    padding: spacing.lg,
    gap: spacing.md,
  },
  emoji: { fontSize: 56, textAlign: 'center' },
  title: {
    fontSize: typography.size.xl,
    fontWeight: typography.weight.bold,
    color: colors.text,
    textAlign: 'center',
  },
  subtitle: { fontSize: typography.size.sm, color: colors.textSecondary, textAlign: 'center' },
});
