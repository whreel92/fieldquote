import { colors, radii, spacing, typography } from '@fieldquote/ui';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { BrandMark, FormScreen } from '@/components/screen';
import { Button, ErrorText, Field } from '@/components/ui';
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
      setError('Could not send the sign-in email. Check the address and try again.');
      return;
    }
    router.push({ pathname: '/(auth)/verify', params: { email: email.trim() } });
  };

  return (
    <FormScreen>
      <BrandMark tagline="Estimates that build themselves on site." />
      {isSupabaseConfigured ? (
        <>
          <Field
            label="Work email"
            placeholder="you@yourcompany.com"
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            value={email}
            onChangeText={setEmail}
            onSubmitEditing={() => void sendCode()}
          />
          <ErrorText message={error} />
          <Button
            title="Email me a sign-in link"
            onPress={() => void sendCode()}
            disabled={!email.includes('@')}
            loading={sending}
          />
          <Text style={styles.finePrint}>
            No password needed — we email you a one-time sign-in link.
          </Text>
        </>
      ) : (
        <View style={styles.notConfigured}>
          <Text style={styles.notConfiguredText}>
            Supabase isn&apos;t configured yet. Set EXPO_PUBLIC_SUPABASE_URL and
            EXPO_PUBLIC_SUPABASE_ANON_KEY (see docs/HUMAN_TODO.md), then restart.
          </Text>
        </View>
      )}
    </FormScreen>
  );
}

const styles = StyleSheet.create({
  finePrint: {
    fontSize: typography.size.xs,
    fontFamily: typography.family.regular,
    color: colors.textMuted,
    textAlign: 'center',
  },
  notConfigured: {
    backgroundColor: colors.surface,
    borderColor: colors.warning,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  notConfiguredText: {
    color: colors.textSecondary,
    fontSize: typography.size.sm,
    fontFamily: typography.family.regular,
  },
});
