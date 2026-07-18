import { colors, radii, spacing, typography } from '@fieldquote/ui';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/state/auth';

export default function SettingsScreen() {
  const { signOut, session } = useAuth();
  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Settings</Text>
      <Text style={styles.subtitle}>
        Rates, branding, and team management ship in Phase 1 &amp; 8.
      </Text>
      {session ? (
        <Pressable style={styles.signOut} onPress={() => void signOut()}>
          <Text style={styles.signOutText}>Sign out</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    padding: spacing.lg,
    gap: spacing.md,
  },
  heading: {
    fontSize: typography.size.xl,
    fontWeight: typography.weight.bold,
    color: colors.text,
  },
  subtitle: { fontSize: typography.size.sm, color: colors.textSecondary },
  signOut: {
    marginTop: spacing.lg,
    borderColor: colors.danger,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
    alignItems: 'center',
  },
  signOutText: { color: colors.danger, fontWeight: typography.weight.semibold },
});
