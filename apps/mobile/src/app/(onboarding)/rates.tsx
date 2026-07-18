import { explainerExample, type MarkupModel } from '@fieldquote/shared-types';
import { colors, spacing, typography } from '@fieldquote/ui';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button, Card, Chip, ErrorText, Field } from '@/components/ui';
import { api } from '@/lib/api';

const DEFAULTS = { labor: '125', helper: '65', margin: '45' };

export default function OnboardingRates() {
  const router = useRouter();
  const [labor, setLabor] = useState(DEFAULTS.labor);
  const [helper, setHelper] = useState(DEFAULTS.helper);
  const [pct, setPct] = useState(DEFAULTS.margin);
  const [model, setModel] = useState<MarkupModel>('margin');

  const pctNum = Number(pct) || 0;
  const validPct = model === 'margin' ? pctNum >= 0 && pctNum < 100 : pctNum >= 0;
  let example = '';
  if (validPct) example = explainerExample(model, pctNum);

  const save = useMutation({
    mutationFn: () =>
      api.rates.put({
        labor_rate: labor || DEFAULTS.labor,
        helper_rate: helper || null,
        target_margin_pct: pct || DEFAULTS.margin,
        tax_rate_pct: '0',
        markup_model: model,
        confirmed: true,
      }),
    onSuccess: () => router.push('/(onboarding)/tax'),
  });

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.step}>Step 2 of 4</Text>
      <Text style={styles.title}>Your rates</Text>
      <Text style={styles.subtitle}>
        These drive every price FieldQuote calculates. The AI never sets prices — your rates and
        your catalog do.
      </Text>

      <Field
        label="Your hourly labor rate ($/hr)"
        value={labor}
        onChangeText={setLabor}
        keyboardType="decimal-pad"
      />
      <Field
        label="Helper rate ($/hr, optional)"
        value={helper}
        onChangeText={setHelper}
        keyboardType="decimal-pad"
      />

      <View style={styles.chipRow}>
        <Chip label="Margin" selected={model === 'margin'} onPress={() => setModel('margin')} />
        <Chip label="Markup" selected={model === 'markup'} onPress={() => setModel('markup')} />
      </View>
      <Card>
        <Text style={styles.explainTitle}>
          {model === 'margin'
            ? 'Margin: profit as % of the price'
            : 'Markup: % added on top of cost'}
        </Text>
        <Text style={styles.explainBody}>
          {model === 'margin'
            ? 'At 50% margin, half of what the customer pays is your profit.'
            : 'At 50% markup, you add half the job cost on top. (50% markup ≈ 33% margin.)'}
        </Text>
        {example ? <Text style={styles.example}>{example}</Text> : null}
      </Card>
      <Field
        label={`Target ${model} %`}
        value={pct}
        onChangeText={setPct}
        keyboardType="decimal-pad"
        hint={model === 'margin' ? 'Must be under 100.' : undefined}
      />

      <ErrorText
        message={
          save.isError ? 'Could not save rates.' : !validPct ? 'Enter a valid percentage.' : null
        }
      />
      <Button
        title="Continue"
        onPress={() => save.mutate()}
        loading={save.isPending}
        disabled={!validPct}
      />
      <Button
        title="Skip — use typical defaults"
        variant="secondary"
        onPress={() => router.push('/(onboarding)/tax')}
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
  chipRow: { flexDirection: 'row', gap: spacing.sm },
  explainTitle: {
    fontSize: typography.size.sm,
    fontFamily: typography.family.semibold,
    color: colors.text,
  },
  explainBody: { fontSize: typography.size.sm, color: colors.textSecondary },
  example: {
    fontSize: typography.size.sm,
    fontFamily: typography.family.semibold,
    color: colors.accentText,
  },
});
