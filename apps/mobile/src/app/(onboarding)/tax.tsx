import { colors, spacing, typography } from '@fieldquote/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';

import { Button, ErrorText, Field } from '@/components/ui';
import { api } from '@/lib/api';

export default function OnboardingTax() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [tax, setTax] = useState('0');
  const [zip, setZip] = useState('');

  const rates = useQuery({ queryKey: ['rates'], queryFn: api.rates.get });

  const save = useMutation({
    mutationFn: async () => {
      const current = rates.data ?? (await api.rates.get());
      await api.rates.put({
        labor_rate: current.labor_rate,
        helper_rate: current.helper_rate,
        target_margin_pct: current.target_margin_pct,
        tax_rate_pct: tax || '0',
        markup_model: current.markup_model as 'margin' | 'markup',
        confirmed: current.confirmed,
      });
      if (zip.trim()) {
        const company = await api.company.get();
        await api.company.patch({
          settings: { ...company.settings, service_zip: zip.trim() },
        });
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['rates'] });
      router.push('/(onboarding)/done');
    },
  });

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.step}>Step 3 of 4</Text>
      <Text style={styles.title}>Tax & service area</Text>
      <Text style={styles.subtitle}>
        Sales tax applied to materials on estimates (many AZ contractors use 0 and price it in — ask
        your accountant). ZIP helps with regional material pricing later.
      </Text>
      <Field label="Sales tax %" value={tax} onChangeText={setTax} keyboardType="decimal-pad" />
      <Field
        label="Home-base ZIP"
        placeholder="85251"
        value={zip}
        onChangeText={setZip}
        keyboardType="number-pad"
        maxLength={10}
      />
      <ErrorText message={save.isError ? 'Could not save. Try again.' : null} />
      <Button title="Continue" onPress={() => save.mutate()} loading={save.isPending} />
      <Button
        title="Skip for now"
        variant="secondary"
        onPress={() => router.push('/(onboarding)/done')}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    backgroundColor: colors.bg,
    padding: spacing.lg,
    paddingTop: spacing.xxl,
    gap: spacing.md,
  },
  step: { fontSize: typography.size.sm, color: colors.textMuted },
  title: { fontSize: typography.size.xl, fontWeight: typography.weight.bold, color: colors.text },
  subtitle: { fontSize: typography.size.sm, color: colors.textSecondary },
});
