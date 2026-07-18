import { colors, radii, spacing, typography } from '@fieldquote/ui';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { supabase } from '@/lib/supabase';

export default function VerifyScreen() {
  const { email } = useLocalSearchParams<{ email: string }>();
  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const verify = async () => {
    if (!supabase || !email) return;
    setVerifying(true);
    setError(null);
    const { error: err } = await supabase.auth.verifyOtp({
      email,
      token: code.trim(),
      type: 'email',
    });
    setVerifying(false);
    if (err) {
      setError('That code didn’t work. Check it and try again.');
    }
    // On success the root layout's auth gate redirects to the tabs.
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Check your email</Text>
      <Text style={styles.subtitle}>We sent a 6-digit code to {email ?? 'your email'}.</Text>
      <TextInput
        style={styles.input}
        placeholder="123456"
        placeholderTextColor={colors.textMuted}
        keyboardType="number-pad"
        maxLength={6}
        value={code}
        onChangeText={setCode}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable
        style={[styles.button, (code.length !== 6 || verifying) && styles.buttonDisabled]}
        disabled={code.length !== 6 || verifying}
        onPress={verify}
      >
        {verifying ? (
          <ActivityIndicator color={colors.textOnPrimary} />
        ) : (
          <Text style={styles.buttonText}>Sign in</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: 'center',
    padding: spacing.lg,
    gap: spacing.md,
  },
  title: {
    fontSize: typography.size.xl,
    fontWeight: typography.weight.bold,
    color: colors.text,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: typography.size.md,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
    fontSize: typography.size.xl,
    color: colors.text,
    textAlign: 'center',
    letterSpacing: 8,
  },
  button: {
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    padding: spacing.md,
    alignItems: 'center',
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: {
    color: colors.textOnPrimary,
    fontSize: typography.size.md,
    fontWeight: typography.weight.semibold,
  },
  error: { color: colors.danger, fontSize: typography.size.sm, textAlign: 'center' },
});
