import { colors, radii, spacing, typography } from '@fieldquote/ui';
import type { ReactNode } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

const isWeb = Platform.OS === 'web';

/**
 * Shell for form-style screens (auth, onboarding, settings forms).
 * Native: full-bleed phone layout. Web: centered card so desktop
 * windows don't stretch a phone UI edge-to-edge.
 */
export function FormScreen({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.scroll}>
      <View style={styles.panel}>
        {children}
        {footer}
      </View>
    </ScrollView>
  );
}

/** Typographic brand lockup — ink wordmark over a safety-orange rule. */
export function BrandMark({ tagline }: { tagline?: string }) {
  return (
    <View style={styles.brand}>
      <Text style={styles.wordmark}>FieldQuote</Text>
      <View style={styles.rule} />
      {tagline ? <Text style={styles.tagline}>{tagline}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: isWeb ? colors.surfaceSunken : colors.bg },
  scroll: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: isWeb ? spacing.lg : 0,
  },
  panel: {
    width: '100%',
    maxWidth: 440,
    alignSelf: 'center',
    gap: spacing.md,
    ...(isWeb
      ? {
          backgroundColor: colors.surface,
          borderRadius: radii.lg,
          borderWidth: 1,
          borderColor: colors.border,
          paddingHorizontal: spacing.xl,
          paddingVertical: spacing.xxl,
        }
      : {
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.xxl,
        }),
  },
  brand: { alignItems: 'center', gap: spacing.sm, marginBottom: spacing.lg },
  wordmark: {
    fontSize: typography.size.xxl,
    fontFamily: typography.family.extrabold,
    color: colors.ink,
    letterSpacing: -0.5,
  },
  rule: { width: 48, height: 4, borderRadius: radii.full, backgroundColor: colors.primary },
  tagline: {
    fontSize: typography.size.sm,
    fontFamily: typography.family.regular,
    color: colors.textSecondary,
    textAlign: 'center',
  },
});
