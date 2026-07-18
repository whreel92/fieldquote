import { colors, spacing, typography } from '@fieldquote/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button, Card, ErrorText, Field } from '@/components/ui';
import { api, type Company } from '@/lib/api';

export default function BrandingScreen() {
  const company = useQuery({ queryKey: ['company'], queryFn: api.company.get });
  if (!company.data) {
    return (
      <View style={styles.loading}>
        {company.isError ? (
          <Text style={styles.loadingText}>Couldn&apos;t load company info.</Text>
        ) : (
          <ActivityIndicator color={colors.primary} />
        )}
      </View>
    );
  }
  return <BrandingForm initial={company.data} />;
}

function BrandingForm({ initial }: { initial: Company }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(initial.name);
  const [license, setLicense] = useState(initial.license_number ?? '');
  const [phone, setPhone] = useState(initial.phone ?? '');
  const [email, setEmail] = useState(initial.email ?? '');
  const [address, setAddress] = useState(initial.address ?? '');

  const save = useMutation({
    mutationFn: () =>
      api.company.patch({
        name: name.trim() || undefined,
        license_number: license.trim() || null,
        phone: phone.trim() || null,
        email: email.trim() || null,
        address: address.trim() || null,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['company'] }),
  });

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <Field label="Company name" value={name} onChangeText={setName} />
      <Field
        label="License #"
        value={license}
        onChangeText={setLicense}
        autoCapitalize="characters"
      />
      <Field label="Phone" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
      <Field
        label="Email"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoCapitalize="none"
      />
      <Field label="Business address" value={address} onChangeText={setAddress} />
      <Card>
        <Text style={styles.note}>
          Logo upload lands with proposal branding (Phase 6) — the API endpoint is already live.
        </Text>
      </Card>
      <ErrorText message={save.isError ? 'Could not save changes.' : null} />
      <Button
        title={save.isSuccess ? 'Saved ✓' : 'Save'}
        onPress={() => save.mutate()}
        loading={save.isPending}
        disabled={name.trim().length === 0}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.bg },
  container: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  loadingText: { color: colors.textSecondary, fontSize: typography.size.sm },
  note: { fontSize: typography.size.sm, color: colors.textMuted },
});
