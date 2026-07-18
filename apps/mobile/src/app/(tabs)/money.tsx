import { colors, spacing, typography } from '@fieldquote/ui';
import { StyleSheet, Text, View } from 'react-native';

import { HeaderBand } from '@/components/header-band';

export default function MoneyScreen() {
  return (
    <View style={styles.container}>
      <HeaderBand eyebrow="Cash flow" title="Money" />
      <View style={styles.body}>
        <Text style={styles.title}>Nothing outstanding</Text>
        <Text style={styles.copy}>
          Deposits, invoices, and what&apos;s still owed show up here once proposals start going out
          — invoicing lands in Phase 7.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  body: {
    flex: 1,
    justifyContent: 'center',
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
    padding: spacing.lg,
    gap: spacing.sm,
  },
  title: {
    fontSize: typography.size.lg,
    fontFamily: typography.family.bold,
    color: colors.text,
    textAlign: 'center',
  },
  copy: {
    fontSize: typography.size.sm,
    fontFamily: typography.family.regular,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  },
});
