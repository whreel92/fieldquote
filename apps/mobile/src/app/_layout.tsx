import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { Stack, useRouter, useSegments } from 'expo-router';
import { useEffect, useState } from 'react';

import { api } from '@/lib/api';
import { initObservability } from '@/lib/observability';
import { useAuth } from '@/state/auth';

initObservability();

const queryClient = new QueryClient();

function useProtectedRoute() {
  const { session, initialized, initialize } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  const [booted, setBooted] = useState(false);

  const companyQuery = useQuery({
    queryKey: ['company'],
    queryFn: api.company.get,
    enabled: Boolean(session),
  });

  useEffect(() => {
    void initialize().then(() => setBooted(true));
  }, [initialize]);

  useEffect(() => {
    if (!booted || !initialized) return;
    const group = segments[0] as string | undefined;
    if (!session) {
      if (group !== '(auth)') router.replace('/(auth)/sign-in');
      return;
    }
    if (companyQuery.data === undefined) return; // still loading company
    const onboarded = Boolean(companyQuery.data.settings.onboarded);
    if (!onboarded && group !== '(onboarding)') {
      router.replace('/(onboarding)/company');
    } else if (onboarded && (group === '(auth)' || group === '(onboarding)')) {
      router.replace('/(tabs)/jobs');
    }
  }, [booted, initialized, session, segments, router, companyQuery.data]);
}

function RootNavigator() {
  useProtectedRoute();
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(onboarding)" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="job/new" options={{ headerShown: true, title: 'New job' }} />
      <Stack.Screen name="job/[id]" options={{ headerShown: true, title: 'Job' }} />
      <Stack.Screen name="settings/rates" options={{ headerShown: true, title: 'Rates' }} />
      <Stack.Screen name="settings/branding" options={{ headerShown: true, title: 'Branding' }} />
      <Stack.Screen name="settings/legal" options={{ headerShown: true, title: 'Legal' }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <RootNavigator />
    </QueryClientProvider>
  );
}
