import { colors, radii, spacing, typography } from '@fieldquote/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button, Chip, ErrorText, Field } from '@/components/ui';
import { api, type Client } from '@/lib/api';

const JOB_TYPES: { code: string; label: string }[] = [
  { code: 'panel_upgrade', label: 'Panel Upgrade' },
  { code: 'ev_charger', label: 'EV Charger' },
  { code: 'service_call', label: 'Service Call' },
  { code: 'circuits_outlets', label: 'Circuits/Outlets' },
  { code: 'fixtures_fans', label: 'Fixtures/Fans' },
  { code: 'remodel', label: 'Remodel' },
  { code: 'generator', label: 'Generator' },
  { code: 'other', label: 'Other' },
];

export default function NewJobScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [typeCode, setTypeCode] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [clientSearch, setClientSearch] = useState('');
  const [selectedClient, setSelectedClient] = useState<Client | null>(null);

  const clientsQuery = useQuery({
    queryKey: ['clients', clientSearch],
    queryFn: () => api.clients.list(clientSearch || undefined),
  });

  const createClient = useMutation({
    mutationFn: () => api.clients.create({ name: clientSearch.trim() }),
    onSuccess: (client) => {
      setSelectedClient(client);
      void queryClient.invalidateQueries({ queryKey: ['clients'] });
    },
  });

  const createJob = useMutation({
    mutationFn: () =>
      api.jobs.create({
        title: title.trim(),
        client_id: selectedClient?.id ?? null,
        job_type_code: typeCode,
        address: address.trim() || null,
      }),
    onSuccess: async (job) => {
      await queryClient.invalidateQueries({ queryKey: ['jobs'] });
      router.replace(`/job/${job.id}`);
    },
  });

  const suggestions = (clientsQuery.data ?? []).slice(0, 5);
  const showCreateOption =
    clientSearch.trim().length > 1 &&
    !suggestions.some((c) => c.name.toLowerCase() === clientSearch.trim().toLowerCase());

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <Field
        label="Job title"
        placeholder="200A panel upgrade — Chen residence"
        value={title}
        onChangeText={setTitle}
      />

      <Text style={styles.label}>Job type</Text>
      <View style={styles.chipWrap}>
        {JOB_TYPES.map((t) => (
          <Chip
            key={t.code}
            label={t.label}
            selected={typeCode === t.code}
            onPress={() => setTypeCode(typeCode === t.code ? null : t.code)}
          />
        ))}
      </View>

      <Text style={styles.label}>Client</Text>
      {selectedClient ? (
        <View style={styles.selectedClient}>
          <Text style={styles.selectedClientName}>{selectedClient.name}</Text>
          <Pressable onPress={() => setSelectedClient(null)}>
            <Text style={styles.changeLink}>Change</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <Field
            label=""
            placeholder="Search or type a new client name…"
            value={clientSearch}
            onChangeText={setClientSearch}
          />
          {suggestions.map((c) => (
            <Pressable key={c.id} style={styles.suggestion} onPress={() => setSelectedClient(c)}>
              <Text style={styles.suggestionName}>{c.name}</Text>
              {c.phone ? <Text style={styles.suggestionSub}>{c.phone}</Text> : null}
            </Pressable>
          ))}
          {showCreateOption ? (
            <Pressable
              style={[styles.suggestion, styles.createNew]}
              onPress={() => createClient.mutate()}
            >
              <Text style={styles.createNewText}>+ Create client “{clientSearch.trim()}”</Text>
            </Pressable>
          ) : null}
        </>
      )}

      <Field
        label="Job address"
        placeholder="4112 E Cactus Rd, Phoenix, AZ"
        value={address}
        onChangeText={setAddress}
        hint="Autocomplete arrives with the geocode provider — free text for now."
      />

      <ErrorText message={createJob.isError ? 'Could not create the job. Try again.' : null} />
      <Button
        title="Create job"
        onPress={() => createJob.mutate()}
        loading={createJob.isPending}
        disabled={title.trim().length === 0}
      />
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
  label: {
    fontSize: typography.size.sm,
    fontFamily: typography.family.medium,
    color: colors.textSecondary,
  },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  selectedClient: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.primary,
    padding: spacing.md,
  },
  selectedClientName: {
    fontSize: typography.size.md,
    fontFamily: typography.family.medium,
    color: colors.text,
  },
  changeLink: { color: colors.accentText, fontSize: typography.size.sm },
  suggestion: {
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  suggestionName: { fontSize: typography.size.md, color: colors.text },
  suggestionSub: { fontSize: typography.size.xs, color: colors.textMuted },
  createNew: { borderStyle: 'dashed', borderColor: colors.primary },
  createNewText: { color: colors.accentText, fontSize: typography.size.sm },
});
