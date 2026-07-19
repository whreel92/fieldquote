/**
 * Estimate generation streaming screen (Phase 4.4).
 *
 * The caller has already POSTed /jobs/{id}/estimates/generate. This screen
 * listens on Supabase Realtime channel `job:{jobId}` for broadcast events
 * (`generation.started`, `scope.partial`, `estimate.ready`,
 * `generation.failed`) and, because Realtime may not be configured in dev,
 * polls `GET /jobs/{id}/estimates` every 3s as the guaranteed fallback.
 * Whichever signal lands first wins; a settled guard makes the race safe.
 */

import { colors, radii, spacing, typography } from '@fieldquote/ui';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AlertTriangle } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EquipmentLabel, HeaderBand } from '@/components/header-band';
import { Button, Card } from '@/components/ui';
import { api, ApiError, type EstimateDetail } from '@/lib/api';
import { supabase } from '@/lib/supabase';

type EstimateLine = EstimateDetail['lines'][number];
type Phase = 'working' | 'ready' | 'failed';

const POLL_INTERVAL_MS = 3000;
const STATUS_LINE_INTERVAL_MS = 4000;
const WORKING_TIMEOUT_MS = 3 * 60 * 1000;
const LINE_STAGGER_MS = 120;
const TOTAL_COUNT_MS = 800;

/** Cosmetic pacing only — rotates while the worker does its real job. */
const STATUS_LINES = [
  'Listening to your notes…',
  'Reading the photos…',
  'Matching to your catalog…',
  'Pricing line items…',
] as const;

const GENERIC_FAIL_REASON =
  'Something went wrong while building this estimate. Your photos and notes are safe.';
const TIMEOUT_FAIL_REASON =
  'This is taking longer than expected. Your captures are safe — try again, or build the estimate yourself.';
const FAIL_TITLE = 'We could not finish this estimate';

function numeric(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
}

function money(value: unknown): string {
  const n = numeric(value);
  if (!Number.isFinite(n)) return '—';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function GenerationScreen() {
  const { jobId } = useLocalSearchParams<{ jobId: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [phase, setPhase] = useState<Phase>('working');
  const [prose, setProse] = useState('');
  const [estimate, setEstimate] = useState<EstimateDetail | null>(null);
  const [failReason, setFailReason] = useState<string | null>(null);
  const [statusIndex, setStatusIndex] = useState(0);

  /** True once we've committed to ready/failed — first signal wins the race. */
  const settledRef = useRef(false);
  /** Highest estimate version present at mount (or last retry): only newer versions count. */
  const baselineVersionRef = useRef<number | null>(null);
  const pollBusyRef = useRef(false);
  const proseScrollRef = useRef<ScrollView>(null);
  const [pulse] = useState(() => new Animated.Value(1));

  const settleFailed = useCallback((reason: string) => {
    if (settledRef.current) return;
    settledRef.current = true;
    setFailReason(reason);
    setPhase('failed');
  }, []);

  const settleReady = useCallback(async (estimateId: string) => {
    if (settledRef.current) return;
    settledRef.current = true;
    try {
      const detail = await api.estimates.get(estimateId);
      setEstimate(detail);
      setPhase('ready');
    } catch (err) {
      setFailReason(err instanceof ApiError ? err.message : GENERIC_FAIL_REASON);
      setPhase('failed');
    }
  }, []);

  // Realtime: subscribe once per job; polling below covers dev environments
  // where Realtime is not configured. `settledRef` resolves the race.
  useEffect(() => {
    if (!supabase || !jobId) return;
    const client = supabase;
    const channel = client
      .channel(`job:${jobId}`)
      .on('broadcast', { event: 'scope.partial' }, (message) => {
        const text = (message.payload as Record<string, unknown> | undefined)?.text;
        if (typeof text === 'string' && !settledRef.current) setProse((p) => p + text);
      })
      .on('broadcast', { event: 'estimate.ready' }, (message) => {
        const id = (message.payload as Record<string, unknown> | undefined)?.estimate_id;
        if (typeof id === 'string') void settleReady(id);
      })
      .on('broadcast', { event: 'generation.failed' }, (message) => {
        const reason = (message.payload as Record<string, unknown> | undefined)?.reason;
        settleFailed(typeof reason === 'string' && reason ? reason : GENERIC_FAIL_REASON);
      })
      .subscribe();
    return () => {
      void client.removeChannel(channel);
    };
  }, [jobId, settleReady, settleFailed]);

  // Polling fallback. First successful fetch records the baseline (estimates
  // that already existed); only versions above it are treated as the result.
  useEffect(() => {
    if (!jobId || phase !== 'working') return;
    let cancelled = false;

    const poll = async () => {
      if (pollBusyRef.current || settledRef.current) return;
      pollBusyRef.current = true;
      try {
        const list = await api.estimates.listForJob(jobId);
        if (cancelled || settledRef.current) return;
        if (baselineVersionRef.current === null) {
          baselineVersionRef.current = list.reduce((max, e) => Math.max(max, e.version), 0);
          return;
        }
        const fresh = list.filter((e) => e.version > (baselineVersionRef.current ?? 0));
        const draft = fresh.find((e) => e.status === 'draft');
        if (draft) {
          void settleReady(draft.id);
          return;
        }
        const failed = fresh.find((e) => e.status === 'generation_failed');
        if (failed) {
          // Bump the baseline so a retry never re-trips on this failed version.
          baselineVersionRef.current = Math.max(baselineVersionRef.current ?? 0, failed.version);
          let reason = GENERIC_FAIL_REASON;
          try {
            const detail = await api.estimates.get(failed.id);
            const err = detail.ai_output?.['error'];
            if (typeof err === 'string' && err) reason = err;
          } catch {
            // keep the generic user-safe reason
          }
          settleFailed(reason);
        }
      } catch {
        // transient network error — keep polling
      } finally {
        pollBusyRef.current = false;
      }
    };

    void poll(); // immediate run establishes the baseline
    const interval = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [jobId, phase, settleReady, settleFailed]);

  // A "working" state that exceeds 3 minutes becomes the failure card.
  useEffect(() => {
    if (phase !== 'working') return;
    const timer = setTimeout(() => settleFailed(TIMEOUT_FAIL_REASON), WORKING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [phase, settleFailed]);

  // Rotating status lines — cosmetic pacing.
  useEffect(() => {
    if (phase !== 'working') return;
    const timer = setInterval(
      () => setStatusIndex((i) => (i + 1) % STATUS_LINES.length),
      STATUS_LINE_INTERVAL_MS,
    );
    return () => clearInterval(timer);
  }, [phase]);

  // Pulsing safety-orange rule.
  useEffect(() => {
    if (phase !== 'working') {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.3,
          duration: 900,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: 900,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [phase, pulse]);

  const retry = useCallback(async () => {
    if (!jobId) return;
    settledRef.current = false;
    setProse('');
    setEstimate(null);
    setFailReason(null);
    setStatusIndex(0);
    setPhase('working');
    try {
      // Re-baseline so the estimate that just failed is never mistaken for the
      // new run's result, then queue a fresh generation.
      const list = await api.estimates.listForJob(jobId);
      baselineVersionRef.current = list.reduce((max, e) => Math.max(max, e.version), 0);
      await api.estimates.generate(jobId);
    } catch (err) {
      settleFailed(err instanceof ApiError ? err.message : GENERIC_FAIL_REASON);
    }
  }, [jobId, settleFailed]);

  const exitToJob = useCallback(() => {
    // Phase 5: route to estimate editor
    router.replace(`/job/${jobId}`);
  }, [router, jobId]);

  // ── Failure card ─────────────────────────────────────────────────────────
  if (phase === 'failed') {
    return (
      <View style={[styles.failScreen, { paddingTop: insets.top + spacing.xl }]}>
        <StatusBar style="dark" />
        <Card>
          <View style={styles.failHeader}>
            <AlertTriangle size={28} color={colors.warning} />
            <Text style={styles.failTitle}>{FAIL_TITLE}</Text>
          </View>
          <Text style={styles.failReason}>{failReason ?? GENERIC_FAIL_REASON}</Text>
          <View style={styles.failActions}>
            <Button title="Try again" onPress={() => void retry()} />
            <Button title="Build manually" variant="secondary" onPress={exitToJob} />
          </View>
        </Card>
      </View>
    );
  }

  // ── Ready: prose settles, lines stagger in, total counts up ──────────────
  if (phase === 'ready' && estimate) {
    const totalDelay = estimate.lines.length * LINE_STAGGER_MS + 300;
    const totalAmount = numeric(estimate.totals?.['total']);
    return (
      <View style={styles.readyScreen}>
        <StatusBar style="light" />
        <View style={{ height: insets.top, backgroundColor: colors.ink }} />
        <HeaderBand eyebrow="ESTIMATE READY" title="Draft estimate" meta={`v${estimate.version}`} />
        <ScrollView
          style={styles.readyScroll}
          contentContainerStyle={[styles.readyBody, { paddingBottom: insets.bottom + spacing.xl }]}
        >
          {estimate.scope_prose ? (
            <>
              <EquipmentLabel text="SCOPE OF WORK" />
              <Text style={styles.readyProse}>{estimate.scope_prose}</Text>
            </>
          ) : null}
          <EquipmentLabel text="LINE ITEMS" />
          <View style={styles.lineList}>
            {estimate.lines.map((line, index) => (
              <LineRow key={line.id} line={line} index={index} />
            ))}
          </View>
          <View style={styles.totalRow}>
            <EquipmentLabel text="TOTAL" />
            {Number.isFinite(totalAmount) ? (
              <TotalCounter amount={totalAmount} delay={totalDelay} />
            ) : (
              <Text style={styles.totalValue}>—</Text>
            )}
          </View>
          <Button title="Review estimate" onPress={exitToJob} />
          <Text style={styles.draftNote}>
            This is a draft. Nothing goes to the customer until you review and approve it.
          </Text>
        </ScrollView>
      </View>
    );
  }

  // ── Working: ink full-bleed, pulsing rule, streaming scope prose ─────────
  return (
    <View
      style={[
        styles.workingScreen,
        { paddingTop: insets.top + spacing.xl, paddingBottom: insets.bottom + spacing.lg },
      ]}
    >
      <StatusBar style="light" />
      <Text style={styles.eyebrow}>GENERATING ESTIMATE</Text>
      <Text style={styles.workingTitle}>Building your estimate</Text>
      <Animated.View style={[styles.pulseRule, { opacity: pulse }]} />
      <Text style={styles.statusLine}>{STATUS_LINES[statusIndex]}</Text>
      <ScrollView
        ref={proseScrollRef}
        style={styles.proseScroll}
        contentContainerStyle={styles.proseContent}
        onContentSizeChange={() => proseScrollRef.current?.scrollToEnd({ animated: true })}
      >
        {prose ? (
          <Text style={styles.streamProse}>
            {prose}
            <Text style={styles.caret}>▌</Text>
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

/** One estimate line, fading in on a ~120ms stagger. */
function LineRow({ line, index }: { line: EstimateLine; index: number }) {
  const [anim] = useState(() => new Animated.Value(0));

  useEffect(() => {
    Animated.timing(anim, {
      toValue: 1,
      duration: 240,
      delay: index * LINE_STAGGER_MS,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [anim, index]);

  const isAllowance = line.line_type === 'allowance';
  const isVerify = line.line_type === 'verify' || line.confidence === 'verify';

  return (
    <Animated.View
      style={[
        styles.lineRow,
        {
          opacity: anim,
          transform: [
            { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) },
          ],
        },
      ]}
    >
      <View style={styles.lineLeft}>
        <Text style={styles.lineDesc}>{line.description}</Text>
        {isAllowance ? (
          <View style={[styles.badge, styles.badgeAllowance]}>
            <Text style={[styles.badgeText, styles.badgeAllowanceText]}>ALLOWANCE</Text>
          </View>
        ) : isVerify ? (
          <View style={[styles.badge, styles.badgeVerify]}>
            <Text style={[styles.badgeText, styles.badgeVerifyText]}>VERIFY ON SITE</Text>
          </View>
        ) : null}
      </View>
      <Text style={styles.linePrice}>{money(line.totals?.['total'])}</Text>
    </Animated.View>
  );
}

/** Counts the total up from $0 over ~800ms in the meter-readout mono face. */
function TotalCounter({ amount, delay }: { amount: number; delay: number }) {
  const [anim] = useState(() => new Animated.Value(0));
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    const id = anim.addListener(({ value }) => setDisplay(value));
    Animated.timing(anim, {
      toValue: amount,
      duration: TOTAL_COUNT_MS,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false, // JS listener drives a text value, not a style
    }).start(() => setDisplay(amount));
    return () => anim.removeListener(id);
  }, [anim, amount, delay]);

  return <Text style={styles.totalValue}>{money(display)}</Text>;
}

const styles = StyleSheet.create({
  // Working phase — ink full-bleed
  workingScreen: {
    flex: 1,
    backgroundColor: colors.ink,
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  eyebrow: {
    color: colors.primary,
    fontSize: typography.size.xs,
    fontFamily: typography.family.semibold,
    letterSpacing: 2,
  },
  workingTitle: {
    color: colors.textOnInk,
    fontSize: typography.size.xl,
    fontFamily: typography.family.extrabold,
    letterSpacing: -0.5,
  },
  pulseRule: {
    width: 40,
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.primary,
    marginVertical: spacing.xs,
  },
  statusLine: {
    color: colors.textOnInk,
    opacity: 0.75,
    fontSize: typography.size.sm,
    fontFamily: typography.family.medium,
  },
  proseScroll: { flex: 1, marginTop: spacing.md },
  proseContent: { paddingBottom: spacing.lg },
  streamProse: {
    color: colors.textOnInk,
    fontSize: typography.size.md,
    fontFamily: typography.family.regular,
    lineHeight: 26,
  },
  caret: { color: colors.primary },

  // Ready phase
  readyScreen: { flex: 1, backgroundColor: colors.bg },
  readyScroll: { flex: 1 },
  readyBody: {
    width: '100%',
    maxWidth: 640,
    alignSelf: 'center',
    padding: spacing.lg,
    gap: spacing.md,
  },
  readyProse: {
    color: colors.text,
    fontSize: typography.size.md,
    fontFamily: typography.family.regular,
    lineHeight: 24,
  },
  lineList: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
  },
  lineRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.sm + 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  lineLeft: { flex: 1, gap: spacing.xs, alignItems: 'flex-start' },
  lineDesc: {
    color: colors.text,
    fontSize: typography.size.sm,
    fontFamily: typography.family.medium,
    lineHeight: 20,
  },
  linePrice: {
    color: colors.text,
    fontSize: typography.size.sm,
    fontFamily: typography.family.mono,
    textAlign: 'right',
  },
  badge: {
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  badgeAllowance: { backgroundColor: colors.warningBg },
  badgeAllowanceText: { color: colors.warning },
  badgeVerify: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.accentText,
  },
  badgeVerifyText: { color: colors.accentText },
  badgeText: {
    fontSize: 10,
    fontFamily: typography.family.semibold,
    letterSpacing: 1,
  },
  totalRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
    borderTopWidth: 2,
    borderTopColor: colors.ink,
  },
  totalValue: {
    color: colors.ink,
    fontSize: typography.size.xxl,
    fontFamily: typography.family.mono,
  },
  draftNote: {
    color: colors.textMuted,
    fontSize: typography.size.xs,
    fontFamily: typography.family.regular,
    textAlign: 'center',
  },

  // Failure phase
  failScreen: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingHorizontal: spacing.lg,
    justifyContent: 'center',
  },
  failHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  failTitle: {
    flex: 1,
    color: colors.text,
    fontSize: typography.size.lg,
    fontFamily: typography.family.bold,
  },
  failReason: {
    color: colors.textSecondary,
    fontSize: typography.size.md,
    fontFamily: typography.family.regular,
    lineHeight: 22,
  },
  failActions: { gap: spacing.sm, marginTop: spacing.sm },
});
