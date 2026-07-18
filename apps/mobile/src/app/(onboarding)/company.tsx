import { colors, spacing, typography } from '@fieldquote/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';

import { Button, ErrorText, Field } from '@/components/ui';
import { api } from '@/lib/api';

export default function OnboardingCompany() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [license, setLicense] = useState('');
  const [phone, setPhone] = useState('');

  const save = useMutation({
    mutationFn: () =>
      api.company.patch({
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(license.trim() ? { license_number: license.trim() } : {}),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['company'] });
      router.push('/(onboarding)/rates');
    },
  });

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.step}>Step 1 of 4</Text>
      <Text style={styles.title}>Your company</Text>
      <Text style={styles.subtitle}>
        This is what customers see on proposals. Everything here can be changed later in Settings —
        skip anything you don&apos;t have handy.
      </Text>
      <Field
        label="Company name"
        placeholder="Reel Electric LLC"
        value={name}
        onChangeText={setName}
      />
      <Field
        label="License #"
        placeholder="ROC-123456"
        value={license}
        onChangeText={setLicense}
        autoCapitalize="characters"
      />
      <Field
        label="Business phone"
        placeholder="480-555-0100"
        value={phone}
        onChangeText={setPhone}
        keyboardType="phone-pad"
      />
      <ErrorText message={save.isError ? 'Could not save. Check your connection.' : null} />
      <Button title="Continue" onPress={() => save.mutate()} loading={save.isPending} />
      <Button
        title="Skip for now"
        variant="secondary"
        onPress={() => router.push('/(onboarding)/rates')}
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
  title: { fontSize: typography.size.xl, fontFamily: typography.family.bold, color: colors.text },
  subtitle: { fontSize: typography.size.sm, color: colors.textSecondary },
});
