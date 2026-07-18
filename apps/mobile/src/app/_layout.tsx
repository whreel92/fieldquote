import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack, useRouter, useSegments } from 'expo-router';
import { useEffect, useState } from 'react';

import { useAuth } from '@/state/auth';

const queryClient = new QueryClient();

function useProtectedRoute() {
  const { session, initialized, initialize } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    void initialize().then(() => setBooted(true));
  }, [initialize]);

  useEffect(() => {
    if (!booted || !initialized) return;
    const inAuthGroup = segments[0] === '(auth)';
    if (!session && !inAuthGroup) {
      router.replace('/(auth)/sign-in');
    } else if (session && inAuthGroup) {
      router.replace('/(tabs)/jobs');
    }
  }, [booted, initialized, session, segments, router]);
}

export default function RootLayout() {
  useProtectedRoute();
  return (
    <QueryClientProvider client={queryClient}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="(tabs)" />
      </Stack>
    </QueryClientProvider>
  );
}
