import { colors, typography } from '@fieldquote/ui';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';

import { BrandMark, FormScreen } from '@/components/screen';
import { Button, ErrorText, Field } from '@/components/ui';
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
    // On success the root layout's auth gate redirects onward.
  };

  return (
    <FormScreen>
      <BrandMark />
      <Text style={styles.title}>Check your email</Text>
      <Text style={styles.subtitle}>
        We sent a sign-in link to {email ?? 'you'} — tap it and you&apos;re in. Have a code instead?
        Enter it below.
      </Text>
      <Field
        label="Sign-in code"
        placeholder="12345678"
        keyboardType="number-pad"
        maxLength={8}
        value={code}
        onChangeText={setCode}
        onSubmitEditing={() => void verify()}
      />
      <ErrorText message={error} />
      <Button
        title="Sign in"
        onPress={() => void verify()}
        disabled={code.length < 6}
        loading={verifying}
      />
    </FormScreen>
  );
}

const styles = StyleSheet.create({
  title: {
    fontSize: typography.size.lg,
    fontFamily: typography.family.bold,
    color: colors.text,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: typography.size.sm,
    fontFamily: typography.family.regular,
    color: colors.textSecondary,
    textAlign: 'center',
  },
});
