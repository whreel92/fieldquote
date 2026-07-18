import {
  effectiveMarginPct,
  explainerExample,
  priceFromCost,
  type MarkupModel,
} from '@fieldquote/shared-types';
import { colors, spacing, typography } from '@fieldquote/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button, Card, Chip, ErrorText, Field } from '@/components/ui';
import { api, type Rates } from '@/lib/api';

export default function RatesSettingsScreen() {
  const rates = useQuery({ queryKey: ['rates'], queryFn: api.rates.get });
  if (!rates.data) {
    return (
      <View style={styles.loading}>
        {rates.isError ? (
          <Text style={styles.loadingText}>Couldn&apos;t load rates. Pull back and retry.</Text>
        ) : (
          <ActivityIndicator color={colors.primary} />
        )}
      </View>
    );
  }
  return <RatesForm initial={rates.data} />;
}

function RatesForm({ initial }: { initial: Rates }) {
  const queryClient = useQueryClient();
  const [labor, setLabor] = useState(String(Number(initial.labor_rate)));
  const [helper, setHelper] = useState(
    initial.helper_rate == null ? '' : String(Number(initial.helper_rate)),
  );
  const [pct, setPct] = useState(String(Number(initial.target_margin_pct)));
  const [tax, setTax] = useState(String(Number(initial.tax_rate_pct)));
  const [model, setModel] = useState<MarkupModel>(initial.markup_model as MarkupModel);

  const save = useMutation({
    mutationFn: () =>
      api.rates.put({
        labor_rate: labor || '0',
        helper_rate: helper ? helper : null,
        target_margin_pct: pct || '0',
        tax_rate_pct: tax || '0',
        markup_model: model,
        confirmed: true,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['rates'] }),
  });

  const pctNum = Number(pct) || 0;
  const validPct = model === 'margin' ? pctNum < 100 : true;
  const example = validPct ? explainerExample(model, pctNum) : '';
  const effective =
    validPct && model === 'markup'
      ? `That's a ${effectiveMarginPct(1000, priceFromCost(1000, 'markup', pctNum))}% effective margin.`
      : '';

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      {!initial.confirmed ? (
        <Card>
          <Text style={styles.warn}>
            You&apos;re on default rates — confirm your real numbers so estimates price correctly.
          </Text>
        </Card>
      ) : null}
      <Field
        label="Labor rate ($/hr)"
        value={labor}
        onChangeText={setLabor}
        keyboardType="decimal-pad"
      />
      <Field
        label="Helper rate ($/hr)"
        value={helper}
        onChangeText={setHelper}
        keyboardType="decimal-pad"
      />
      <View style={styles.chipRow}>
        <Chip label="Margin" selected={model === 'margin'} onPress={() => setModel('margin')} />
        <Chip label="Markup" selected={model === 'markup'} onPress={() => setModel('markup')} />
      </View>
      <Field
        label={`Target ${model} %`}
        value={pct}
        onChangeText={setPct}
        keyboardType="decimal-pad"
        hint={model === 'margin' ? 'Must be under 100.' : undefined}
      />
      <Field label="Sales tax %" value={tax} onChangeText={setTax} keyboardType="decimal-pad" />
      {example ? (
        <Card>
          <Text style={styles.example}>{example}</Text>
          {effective ? <Text style={styles.effectiveNote}>{effective}</Text> : null}
        </Card>
      ) : null}
      <ErrorText
        message={
          save.isError ? 'Could not save rates.' : !validPct ? 'Margin must be under 100%.' : null
        }
      />
      <Button
        title={save.isSuccess ? 'Saved ✓' : 'Save rates'}
        onPress={() => save.mutate()}
        loading={save.isPending}
        disabled={!validPct}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.bg },
  container: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  loadingText: { color: colors.textSecondary, fontSize: typography.size.sm },
  chipRow: { flexDirection: 'row', gap: spacing.sm },
  warn: { color: colors.warning, fontSize: typography.size.sm },
  example: {
    fontSize: typography.size.sm,
    fontFamily: typography.family.semibold,
    color: colors.accentText,
  },
  effectiveNote: { fontSize: typography.size.xs, color: colors.textSecondary },
});
