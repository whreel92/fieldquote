import { colors, spacing, typography } from '@fieldquote/ui';
import { ScrollView, StyleSheet, Text } from 'react-native';

import { Card } from '@/components/ui';

/** Mirrors docs/LEGAL_COPY.md — the non-removable proposal disclaimer. */
const DISCLAIMER =
  'This proposal is an estimate prepared and approved by [Your Company], a licensed ' +
  'contractor, using FieldQuote software. Final pricing may vary based on site conditions ' +
  'discovered during work; changes will be documented in a written change order. Allowance ' +
  'items are budgetary placeholders. FieldQuote provides drafting software only and is not a ' +
  'party to this agreement.';

export default function LegalScreen() {
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <Text style={styles.heading}>Proposal disclaimer</Text>
      <Text style={styles.body}>
        Every proposal you send includes this disclaimer. It protects you (estimates can change with
        site conditions) and makes clear the contract is between you and your customer. It
        can&apos;t be removed.
      </Text>
      <Card>
        <Text style={styles.disclaimer}>{DISCLAIMER}</Text>
      </Card>
      <Text style={styles.footnote}>
        Draft copy — attorney review before launch (tracked in the project&apos;s legal checklist).
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.bg },
  container: { padding: spacing.lg, gap: spacing.md },
  heading: { fontSize: typography.size.lg, fontFamily: typography.family.bold, color: colors.text },
  body: { fontSize: typography.size.sm, color: colors.textSecondary },
  disclaimer: { fontSize: typography.size.sm, color: colors.text, fontStyle: 'italic' },
  footnote: { fontSize: typography.size.xs, color: colors.textMuted },
});
