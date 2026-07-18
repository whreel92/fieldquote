import { colors, spacing, typography } from '@fieldquote/ui';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

/**
 * The panel rail — FieldQuote's signature header. Ink band, engraved-label
 * eyebrow (ALL CAPS, letter-spaced, like a lamacoid equipment tag), display
 * title, and the safety-orange rule. Screens under it stay quiet.
 */
export function HeaderBand({
  eyebrow,
  title,
  meta,
  children,
}: {
  eyebrow: string;
  title: string;
  meta?: string;
  children?: ReactNode;
}) {
  return (
    <View style={styles.band}>
      <View style={styles.inner}>
        <Text style={styles.eyebrow}>{eyebrow}</Text>
        <View style={styles.titleRow}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          {meta ? <Text style={styles.meta}>{meta}</Text> : null}
        </View>
        <View style={styles.rule} />
        {children}
      </View>
    </View>
  );
}

/** Engraved-tag label for section headers outside the band. */
export function EquipmentLabel({ text, color }: { text: string; color?: string }) {
  return <Text style={[styles.sectionLabel, color ? { color } : null]}>{text}</Text>;
}

const styles = StyleSheet.create({
  band: {
    backgroundColor: colors.ink,
    borderBottomWidth: 1,
    borderBottomColor: colors.inkBorder,
  },
  inner: {
    width: '100%',
    maxWidth: 720,
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    paddingBottom: spacing.lg,
    gap: spacing.sm,
  },
  eyebrow: {
    color: colors.primary,
    fontSize: typography.size.xs,
    fontFamily: typography.family.semibold,
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  title: {
    flexShrink: 1,
    color: colors.textOnInk,
    fontSize: typography.size.xl,
    fontFamily: typography.family.extrabold,
    letterSpacing: -0.5,
  },
  meta: {
    color: colors.textMuted,
    fontSize: typography.size.sm,
    fontFamily: typography.family.mono,
  },
  rule: { width: 40, height: 3, borderRadius: 2, backgroundColor: colors.primary },
  sectionLabel: {
    fontSize: typography.size.xs,
    fontFamily: typography.family.semibold,
    color: colors.textMuted,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
});
