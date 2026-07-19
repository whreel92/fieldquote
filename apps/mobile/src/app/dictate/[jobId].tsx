import { colors, radii, spacing, touchTarget, typography } from '@fieldquote/ui';
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Check, Mic, Pause, Play, RotateCw, Trash2 } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EquipmentLabel, HeaderBand } from '@/components/header-band';
import { Button, ErrorText } from '@/components/ui';
import { meterToLevel, Waveform, WAVEFORM_SAMPLE_COUNT } from '@/components/waveform';
import {
  enqueueCapture,
  removeCapture,
  retryCapture,
  useQueueStore,
  type QueueItem,
} from '@/lib/captureQueue';

/** Hard stop — §Phase 4.2: on-device duration cap 5 min, warning at 4. */
const MAX_TAKE_MS = 5 * 60_000;
const WARN_AT_MS = 4 * 60_000;
/** Press shorter than this is a tap (toggle); longer engages hold-to-talk. */
const HOLD_THRESHOLD_MS = 250;

type Phase = 'idle' | 'recording' | 'paused';
type PermissionUiState = 'checking' | 'undetermined' | 'granted' | 'denied';

interface Take {
  queueId: string;
  /** Recorder's original cache file — survives queue cleanup, used for playback. */
  uri: string;
  durationS: number;
  number: number;
}

function formatClock(ms: number): string {
  const totalS = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(totalS / 60)}:${String(totalS % 60).padStart(2, '0')}`;
}

export default function DictateScreen() {
  const { jobId } = useLocalSearchParams<{ jobId: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true });
  const recorderState = useAudioRecorderState(recorder, 100);
  const player = useAudioPlayer();
  const playerStatus = useAudioPlayerStatus(player);
  const queueItems = useQueueStore((state) => state.items);

  const [permission, setPermission] = useState<PermissionUiState>('checking');
  const [phase, setPhase] = useState<Phase>('idle');
  const [pressMode, setPressMode] = useState<'tap' | 'hold' | null>(null);
  const [samples, setSamples] = useState<number[]>([]);
  const [takes, setTakes] = useState<Take[]>([]);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [cappedNotice, setCappedNotice] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const phaseRef = useRef<Phase>('idle');
  const durationRef = useRef(0);
  const busyRef = useRef(false);
  const cappingRef = useRef(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdEngaged = useRef(false);
  const takeCounter = useRef(1);

  const changePhase = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  // ── permissions + audio session ────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await AudioModule.getRecordingPermissionsAsync();
      if (cancelled) return;
      if (response.granted) setPermission('granted');
      else if (response.canAskAgain) setPermission('undetermined');
      else setPermission('denied');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (permission !== 'granted') return;
    void setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    return () => {
      void setAudioModeAsync({ allowsRecording: false });
    };
  }, [permission]);

  const requestPermission = useCallback(async () => {
    const response = await AudioModule.requestRecordingPermissionsAsync();
    if (response.granted) setPermission('granted');
    else if (response.canAskAgain) setPermission('undetermined');
    else setPermission('denied');
  }, []);

  // ── take lifecycle ─────────────────────────────────────────────────────────
  const startTake = useCallback(async () => {
    if (busyRef.current || phaseRef.current !== 'idle') return;
    busyRef.current = true;
    try {
      setError(null);
      setCappedNotice(false);
      setSamples([]);
      player.pause();
      setPlayingId(null);
      await recorder.prepareToRecordAsync();
      recorder.record();
      changePhase('recording');
    } catch {
      setError('Could not start recording. Try again.');
      setPressMode(null);
    } finally {
      busyRef.current = false;
    }
  }, [changePhase, player, recorder]);

  const togglePauseResume = useCallback(() => {
    if (phaseRef.current === 'recording') {
      recorder.pause();
      changePhase('paused');
    } else if (phaseRef.current === 'paused') {
      recorder.record();
      changePhase('recording');
    }
  }, [changePhase, recorder]);

  /**
   * Stop the open take and queue it for upload IMMEDIATELY (§0.1.4 — a dead
   * zone must never lose a capture; enqueueCapture persists to app storage
   * before any network is attempted).
   */
  const finalizeTake = useCallback(
    async (cappedAtLimit = false) => {
      if (busyRef.current || phaseRef.current === 'idle') return;
      busyRef.current = true;
      try {
        const durationS = Math.max(1, Math.round(durationRef.current / 1000));
        await recorder.stop();
        changePhase('idle');
        setPressMode(null);
        const uri = recorder.uri;
        if (!uri) {
          setError('The recording file was not available. Record the take again.');
          return;
        }
        const item = await enqueueCapture({ jobId, kind: 'audio', sourceUri: uri, durationS });
        setTakes((prev) => [
          ...prev,
          { queueId: item.id, uri, durationS, number: takeCounter.current++ },
        ]);
        if (cappedAtLimit) setCappedNotice(true);
      } catch {
        setError('Could not save that take. Record it again.');
      } finally {
        busyRef.current = false;
      }
    },
    [changePhase, jobId, recorder],
  );

  // Metering → waveform, duration tracking, and the 5:00 hard stop.
  useEffect(() => {
    durationRef.current = recorderState.durationMillis;
    if (phaseRef.current === 'recording' && recorderState.isRecording) {
      const level = meterToLevel(recorderState.metering ?? -160);
      setSamples((prev) => [...prev.slice(-(WAVEFORM_SAMPLE_COUNT - 1)), level]);
    }
    if (
      phaseRef.current !== 'idle' &&
      recorderState.durationMillis >= MAX_TAKE_MS &&
      !cappingRef.current
    ) {
      cappingRef.current = true;
      void finalizeTake(true).finally(() => {
        cappingRef.current = false;
      });
    }
  }, [recorderState, finalizeTake]);

  // ── record button: tap toggles, hold (≥250ms) records while held ───────────
  const onRecordPressIn = useCallback(() => {
    if (phaseRef.current !== 'idle') return; // open take → presses are taps only
    holdTimer.current = setTimeout(() => {
      holdTimer.current = null;
      holdEngaged.current = true;
      setPressMode('hold');
      void startTake();
    }, HOLD_THRESHOLD_MS);
  }, [startTake]);

  const onRecordPressOut = useCallback(() => {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    if (holdEngaged.current) {
      // Hold-to-talk: releasing the button saves the take.
      holdEngaged.current = false;
      void finalizeTake();
      return;
    }
    // Tap: start a take, or toggle pause/resume on the open one.
    if (phaseRef.current === 'idle') {
      setPressMode('tap');
      void startTake();
    } else {
      togglePauseResume();
    }
  }, [finalizeTake, startTake, togglePauseResume]);

  useEffect(
    () => () => {
      if (holdTimer.current) clearTimeout(holdTimer.current);
    },
    [],
  );

  // ── playback ───────────────────────────────────────────────────────────────
  const onPlayTake = useCallback(
    (take: Take) => {
      if (phaseRef.current !== 'idle') return; // no playback mid-take
      if (playingId === take.queueId) {
        if (playerStatus.playing) {
          player.pause();
        } else {
          const finished =
            playerStatus.didJustFinish ||
            (playerStatus.duration > 0 && playerStatus.currentTime >= playerStatus.duration);
          if (finished) void player.seekTo(0);
          player.play();
        }
        return;
      }
      player.replace(take.uri);
      player.play();
      setPlayingId(take.queueId);
    },
    [player, playerStatus, playingId],
  );

  const onDeleteTake = useCallback(
    (take: Take) => {
      Alert.alert(
        'Delete take?',
        `Take ${take.number} (${formatClock(take.durationS * 1000)}) will be removed from this job.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => {
              void (async () => {
                if (playingId === take.queueId) {
                  player.pause();
                  setPlayingId(null);
                }
                await removeCapture(take.queueId);
                setTakes((prev) => prev.filter((entry) => entry.queueId !== take.queueId));
              })();
            },
          },
        ],
      );
    },
    [player, playingId],
  );

  const onDone = useCallback(() => {
    void (async () => {
      if (phaseRef.current !== 'idle') await finalizeTake();
      router.back();
    })();
  }, [finalizeTake, router]);

  // ── render ─────────────────────────────────────────────────────────────────
  const nearCap = phase !== 'idle' && recorderState.durationMillis >= WARN_AT_MS;
  const caption =
    phase === 'recording'
      ? pressMode === 'hold'
        ? 'Recording — release to save'
        : 'Recording — tap to pause'
      : phase === 'paused'
        ? 'Paused — tap to resume'
        : 'Hold or tap to record';

  return (
    <View style={styles.screen}>
      <View style={[styles.headerWrap, { paddingTop: insets.top }]}>
        <HeaderBand
          eyebrow="Capture / Voice note"
          title="Dictation"
          meta={
            takes.length > 0 ? `${takes.length} take${takes.length === 1 ? '' : 's'}` : undefined
          }
        />
        <Pressable
          onPress={onDone}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Done"
          style={({ pressed }) => [
            styles.doneButton,
            { top: insets.top + spacing.lg },
            pressed && { opacity: 0.7 },
          ]}
        >
          <Text style={styles.doneText}>Done</Text>
        </Pressable>
      </View>

      {permission !== 'granted' ? (
        <PermissionGate
          state={permission}
          onRequest={() => {
            if (permission === 'denied') void Linking.openSettings();
            else void requestPermission();
          }}
        />
      ) : (
        <ScrollView
          style={styles.body}
          contentContainerStyle={[
            styles.bodyContent,
            { paddingBottom: spacing.xxl + insets.bottom },
          ]}
        >
          {cappedNotice ? (
            <View style={styles.amberBanner}>
              <Text style={styles.amberText}>Stopped at 5:00 — the take was saved below.</Text>
            </View>
          ) : null}
          {nearCap ? (
            <View style={styles.amberBanner}>
              <Text style={styles.amberText}>Recording will stop at 5 minutes.</Text>
            </View>
          ) : null}

          <View style={styles.recorderCard}>
            <View style={styles.clockRow}>
              <Text style={styles.clock}>
                {formatClock(phase === 'idle' ? 0 : recorderState.durationMillis)}
              </Text>
              <Text style={styles.clockCap}>/ 5:00</Text>
            </View>
            <Waveform samples={samples} active={phase === 'recording'} />
            <Text style={styles.caption}>{caption}</Text>
            <View style={styles.controlsRow}>
              <View style={styles.controlsSide} />
              <Pressable
                onPressIn={onRecordPressIn}
                onPressOut={onRecordPressOut}
                accessibilityRole="button"
                accessibilityLabel={
                  phase === 'recording'
                    ? 'Pause recording'
                    : phase === 'paused'
                      ? 'Resume recording'
                      : 'Record. Tap to start, or hold to record while pressed.'
                }
                style={({ pressed }) => [
                  styles.recordButton,
                  (pressed || phase === 'recording') && styles.recordButtonActive,
                ]}
              >
                {phase === 'recording' ? (
                  <Pause color={colors.textOnPrimary} size={34} />
                ) : (
                  <Mic color={colors.textOnPrimary} size={34} />
                )}
              </Pressable>
              <View style={styles.controlsSide}>
                {phase !== 'idle' && pressMode === 'tap' ? (
                  <Pressable
                    onPress={() => void finalizeTake()}
                    accessibilityRole="button"
                    accessibilityLabel="Save take"
                    style={({ pressed }) => [
                      styles.saveButton,
                      pressed && { backgroundColor: colors.surfaceSunken },
                    ]}
                  >
                    <Check color={colors.ink} size={18} />
                    <Text style={styles.saveText}>Save</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
            <Text style={styles.maxHint}>Max 5 minutes per take.</Text>
          </View>

          <ErrorText message={error} />

          {takes.length > 0 ? (
            <View style={styles.takesSection}>
              <EquipmentLabel text="Takes" />
              {takes.map((take) => (
                <TakeRow
                  key={take.queueId}
                  take={take}
                  item={queueItems.find((entry) => entry.id === take.queueId)}
                  playing={playingId === take.queueId && playerStatus.playing}
                  playbackDisabled={phase !== 'idle'}
                  onPlay={() => onPlayTake(take)}
                  onDelete={() => onDeleteTake(take)}
                />
              ))}
            </View>
          ) : (
            <Text style={styles.emptyHint}>
              Walk the job and talk — panel condition, runs, access, anything the estimate should
              know. Every take is saved on this phone first, then synced.
            </Text>
          )}
        </ScrollView>
      )}
    </View>
  );
}

function TakeRow({
  take,
  item,
  playing,
  playbackDisabled,
  onPlay,
  onDelete,
}: {
  take: Take;
  item: QueueItem | undefined;
  playing: boolean;
  playbackDisabled: boolean;
  onPlay: () => void;
  onDelete: () => void;
}) {
  // A missing queue row means it finished syncing and was cleaned up.
  const syncState: QueueItem['state'] = item?.state ?? 'synced';
  return (
    <View style={styles.takeCard}>
      <Pressable
        onPress={onPlay}
        disabled={playbackDisabled}
        accessibilityRole="button"
        accessibilityLabel={playing ? `Pause take ${take.number}` : `Play take ${take.number}`}
        style={({ pressed }) => [
          styles.playButton,
          pressed && { backgroundColor: colors.surfaceSunken },
          playbackDisabled && { opacity: 0.45 },
        ]}
      >
        {playing ? <Pause color={colors.ink} size={20} /> : <Play color={colors.ink} size={20} />}
      </Pressable>
      <View style={styles.takeInfo}>
        <Text style={styles.takeTitle}>Take {take.number}</Text>
        <Text style={styles.takeDuration}>{formatClock(take.durationS * 1000)}</Text>
      </View>
      <SyncBadge state={syncState} onRetry={() => void retryCapture(take.queueId)} />
      <Pressable
        onPress={onDelete}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`Delete take ${take.number}`}
        style={({ pressed }) => [styles.iconButton, pressed && { opacity: 0.6 }]}
      >
        <Trash2 color={colors.danger} size={20} />
      </Pressable>
    </View>
  );
}

function SyncBadge({ state, onRetry }: { state: QueueItem['state']; onRetry: () => void }) {
  if (state === 'failed') {
    return (
      <Pressable
        onPress={onRetry}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Retry sync"
        style={({ pressed }) => [styles.syncBadge, pressed && { opacity: 0.6 }]}
      >
        <RotateCw color={colors.danger} size={16} />
        <Text style={[styles.syncText, { color: colors.danger }]}>Retry</Text>
      </Pressable>
    );
  }
  if (state === 'synced') {
    return (
      <View style={styles.syncBadge}>
        <Check color={colors.success} size={16} />
        <Text style={[styles.syncText, { color: colors.success }]}>Synced</Text>
      </View>
    );
  }
  return (
    <View style={styles.syncBadge}>
      <ActivityIndicator size="small" color={colors.textMuted} />
      <Text style={styles.syncText}>Syncing…</Text>
    </View>
  );
}

function PermissionGate({
  state,
  onRequest,
}: {
  state: 'checking' | 'undetermined' | 'denied';
  onRequest: () => void;
}) {
  if (state === 'checking') {
    return (
      <View style={styles.gate}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  const denied = state === 'denied';
  return (
    <View style={styles.gate}>
      <View style={styles.gateIcon}>
        <Mic color={colors.ink} size={28} />
      </View>
      <Text style={styles.gateTitle}>
        {denied ? 'Microphone is turned off' : 'Microphone access'}
      </Text>
      <Text style={styles.gateCopy}>
        {denied
          ? 'FieldQuote needs the microphone to record voice notes. Turn it on in your phone settings, then come back.'
          : 'Dictate the job in your own words — panel condition, runs, access. Recordings stay on this phone until they sync.'}
      </Text>
      <View style={styles.gateButton}>
        <Button title={denied ? 'Open settings' : 'Allow microphone'} onPress={onRequest} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  headerWrap: { backgroundColor: colors.ink },
  doneButton: {
    position: 'absolute',
    right: spacing.lg,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  doneText: {
    color: colors.textOnInk,
    fontSize: typography.size.md,
    fontFamily: typography.family.semibold,
  },
  body: { flex: 1 },
  bodyContent: {
    width: '100%',
    maxWidth: 640,
    alignSelf: 'center',
    padding: spacing.lg,
    gap: spacing.md,
  },
  amberBanner: {
    backgroundColor: colors.warningBg,
    borderRadius: radii.md,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
  },
  amberText: {
    color: colors.warning,
    fontSize: typography.size.sm,
    fontFamily: typography.family.semibold,
  },
  recorderCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
    alignItems: 'center',
  },
  clockRow: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.xs },
  clock: {
    fontSize: typography.size.xxl,
    fontFamily: typography.family.mono,
    color: colors.ink,
    fontVariant: ['tabular-nums'],
  },
  clockCap: {
    fontSize: typography.size.sm,
    fontFamily: typography.family.mono,
    color: colors.textMuted,
  },
  caption: {
    fontSize: typography.size.sm,
    fontFamily: typography.family.medium,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  controlsRow: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
  },
  controlsSide: { flex: 1, alignItems: 'center' },
  recordButton: {
    width: 84,
    height: 84,
    borderRadius: radii.full,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordButtonActive: { backgroundColor: colors.primaryPressed },
  saveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: touchTarget,
    paddingHorizontal: spacing.md,
    borderRadius: radii.full,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  saveText: {
    color: colors.ink,
    fontSize: typography.size.sm,
    fontFamily: typography.family.semibold,
  },
  maxHint: {
    fontSize: typography.size.xs,
    fontFamily: typography.family.regular,
    color: colors.textMuted,
  },
  takesSection: { gap: spacing.sm },
  takeCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm + 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 4,
  },
  playButton: {
    width: touchTarget,
    height: touchTarget,
    borderRadius: radii.full,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  takeInfo: { flex: 1, gap: 2 },
  takeTitle: {
    fontSize: typography.size.md,
    fontFamily: typography.family.semibold,
    color: colors.text,
  },
  takeDuration: {
    fontSize: typography.size.sm,
    fontFamily: typography.family.mono,
    color: colors.textSecondary,
  },
  syncBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: 32,
  },
  syncText: {
    fontSize: typography.size.xs,
    fontFamily: typography.family.medium,
    color: colors.textMuted,
  },
  iconButton: {
    width: 40,
    height: touchTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyHint: {
    fontSize: typography.size.sm,
    fontFamily: typography.family.regular,
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 20,
    paddingHorizontal: spacing.md,
  },
  gate: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
    gap: spacing.sm,
  },
  gateIcon: {
    width: 64,
    height: 64,
    borderRadius: radii.full,
    backgroundColor: colors.surfaceSunken,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  gateTitle: {
    fontSize: typography.size.lg,
    fontFamily: typography.family.bold,
    color: colors.text,
    textAlign: 'center',
  },
  gateCopy: {
    fontSize: typography.size.sm,
    fontFamily: typography.family.regular,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 320,
  },
  gateButton: { alignSelf: 'stretch', maxWidth: 320, width: '100%', marginTop: spacing.sm },
});
