import { colors, spacing, typography } from '@fieldquote/ui';
import { StyleSheet, Text, View } from 'react-native';

export function PlaceholderScreen({ title, phase }: { title: string; phase: string }) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.subtitle}>Ships in {phase}.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  title: {
    fontSize: typography.size.lg,
    fontWeight: typography.weight.semibold,
    color: colors.text,
  },
  subtitle: { fontSize: typography.size.sm, color: colors.textMuted },
});
