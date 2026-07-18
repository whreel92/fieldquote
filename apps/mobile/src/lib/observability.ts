/**
 * Observability facade (FQ-D002). Sentry + PostHog activate when
 * EXPO_PUBLIC_SENTRY_DSN / EXPO_PUBLIC_POSTHOG_KEY are set (docs/HUMAN_TODO.md);
 * until then every call is a safe no-op so product code can instrument freely.
 * Event names must exist in docs/ANALYTICS_EVENTS.md before use.
 */

const sentryDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
const posthogKey = process.env.EXPO_PUBLIC_POSTHOG_KEY;

export function initObservability(): void {
  if (sentryDsn) {
    // Real wiring lands with the first configured DSN: @sentry/react-native init here.
    console.warn('Sentry DSN set but SDK wiring not installed yet (FQ-D002).');
  }
  if (posthogKey) {
    console.warn('PostHog key set but SDK wiring not installed yet (FQ-D002).');
  }
}

export function captureError(error: unknown, context?: Record<string, unknown>): void {
  if (!sentryDsn) {
    if (__DEV__) console.error('[captureError]', error, context);
    return;
  }
}

export function trackEvent(name: string, properties?: Record<string, unknown>): void {
  if (!posthogKey) {
    if (__DEV__) console.log('[trackEvent]', name, properties);
    return;
  }
}
