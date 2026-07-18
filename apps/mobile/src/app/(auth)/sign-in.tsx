import { colors, radii, spacing, typography } from '@fieldquote/ui';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { isSupabaseConfigured, supabase } from '@/lib/supabase';

export default function SignInScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendCode = async () => {
    if (!supabase) return;
    setSending(true);
    setError(null);
    const { error: err } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        shouldCreateUser: true,
        // Default Supabase emails carry a sign-in LINK (templates are locked
        // until custom SMTP lands — HUMAN_TODO). On web the link redirects
        // back here and signs in; the verify screen also accepts a code.
        ...(typeof window !== 'undefined' ? { emailRedirectTo: window.location.origin } : {}),
      },
    });
    setSending(false);
    if (err) {
      setError('Could not send the code. Check the address and try again.');
      return;
    }
    router.push({ pathname: '/(auth)/verify', params: { email: email.trim() } });
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>FieldQuote</Text>
      <Text style={styles.subtitle}>Estimates that build themselves on site.</Text>

      {isSupabaseConfigured ? (
        <>
          <TextInput
            style={styles.input}
            placeholder="you@yourcompany.com"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            value={email}
            onChangeText={setEmail}
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Pressable
            style={[styles.button, (!email.includes('@') || sending) && styles.buttonDisabled]}
            disabled={!email.includes('@') || sending}
            onPress={sendCode}
          >
            {sending ? (
              <ActivityIndicator color={colors.textOnPrimary} />
            ) : (
              <Text style={styles.buttonText}>Email me a sign-in code</Text>
            )}
          </Pressable>
        </>
      ) : (
        <View style={styles.notConfigured}>
          <Text style={styles.notConfiguredText}>
            Supabase isn&apos;t configured yet. Set EXPO_PUBLIC_SUPABASE_URL and
            EXPO_PUBLIC_SUPABASE_ANON_KEY (see docs/HUMAN_TODO.md), then restart.
          </Text>
        </View>
      )}
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
    fontSize: typography.size.xxl,
    fontFamily: typography.family.bold,
    color: colors.text,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: typography.size.md,
    color: colors.textSecondary,
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
    fontSize: typography.size.md,
    color: colors.text,
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
    fontFamily: typography.family.semibold,
  },
  error: { color: colors.danger, fontSize: typography.size.sm },
  notConfigured: {
    backgroundColor: colors.surface,
    borderColor: colors.warning,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  notConfiguredText: { color: colors.textSecondary, fontSize: typography.size.sm },
});
