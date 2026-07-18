import { colors, spacing, typography } from '@fieldquote/ui';
import { StyleSheet, Text, View } from 'react-native';

import { HeaderBand } from '@/components/header-band';

export default function CaptureScreen() {
  return (
    <View style={styles.container}>
      <HeaderBand eyebrow="On site" title="Capture" />
      <View style={styles.body}>
        <Text style={styles.title}>Point, talk, done</Text>
        <Text style={styles.copy}>
          Photos and a voice note from the job site become a priced estimate. Capture arrives in
          Phase 4 — guided shot lists, dictation, and an offline queue that never loses a photo.
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
