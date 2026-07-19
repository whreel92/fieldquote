/**
 * Guided capture flow (§Phase 4.1–4.4). Full-bleed dark screen: job-type
 * chips → guided shot list → camera → offline-safe queue → generate.
 * Every photo is persisted locally via `enqueueCapture` the instant the
 * shutter fires — a dead zone must never lose a capture (§0.1.4).
 */

import { colors, radii, spacing, touchTarget, typography } from '@fieldquote/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Image } from 'expo-image';
import { useNetworkState } from 'expo-network';
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import {
  Camera,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  CloudOff,
  Mic,
  RefreshCw,
  Sparkles,
  TriangleAlert,
  X,
} from 'lucide-react-native';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { api, ApiError } from '@/lib/api';
import {
  enqueueCapture,
  removeCapture,
  retryCapture,
  selectJobItems,
  selectJobSummary,
  useQueueStore,
  type QueueItem,
} from '@/lib/captureQueue';
import { JOB_TYPE_CHIPS, SHOT_LISTS, type Shot } from '@/lib/shotLists';

/** Dictation + generation routes are built in parallel and not yet in the
 *  generated route typings — cast through Href until they land. */
const href = (path: string) => path as Href;

type GenState = 'idle' | 'pending' | 'waiting_sync';

export default function GuidedCaptureScreen() {
  const { jobId } = useLocalSearchParams<{ jobId: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();

  const network = useNetworkState();
  const offline = network.isConnected === false;

  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);

  const jobQuery = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => api.jobs.get(jobId),
    enabled: Boolean(jobId),
  });
  const job = jobQuery.data;

  // ── job type + shot list ──────────────────────────────────────────────────
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const jobType = selectedType ?? job?.job_type_code ?? 'other';
  const shotList = SHOT_LISTS[jobType] ?? SHOT_LISTS.other;
  const shots = shotList.shots;

  const [shotIndex, setShotIndex] = useState(0);
  /** shot key → queue item id, or 'skipped'. */
  const [shotDone, setShotDone] = useState<Record<string, string>>({});
  const currentShot: Shot | undefined = shotIndex < shots.length ? shots[shotIndex] : undefined;

  const patchJobType = useMutation({
    mutationFn: (code: string) => api.jobs.patch(jobId, { job_type_code: code }),
    onSuccess: async (updated) => {
      queryClient.setQueryData(['job', jobId], updated);
      await queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
  });

  const onSelectType = (code: string) => {
    if (code === jobType) return;
    setSelectedType(code);
    setShotIndex(0);
    setShotDone({});
    // Best-effort persist — the local shot list already switched; if the
    // device is offline the PATCH simply fails and the choice stays local.
    patchJobType.mutate(code);
  };

  // ── offline queue state ───────────────────────────────────────────────────
  const items = useQueueStore((state) => state.items);
  const jobItems = useMemo(() => selectJobItems(items, jobId ?? ''), [items, jobId]);
  const summary = useMemo(() => selectJobSummary(items, jobId ?? ''), [items, jobId]);
  const photos = useMemo(
    () =>
      jobItems.filter((item) => item.kind === 'photo').sort((a, b) => a.createdAt - b.createdAt),
    [jobItems],
  );
  const failedItems = jobItems.filter((item) => item.state === 'failed');
  const [showFailed, setShowFailed] = useState(false);

  // ── shutter ───────────────────────────────────────────────────────────────
  const [saving, setSaving] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);

  const onShutter = async () => {
    if (saving || !jobId) return;
    setSaving(true);
    try {
      const photo = await cameraRef.current?.takePictureAsync();
      if (!photo) return;
      // Persist to app storage + queue IMMEDIATELY — offline-safe by design.
      const item = await enqueueCapture({ jobId, kind: 'photo', sourceUri: photo.uri });
      setStorageError(null);
      if (currentShot) {
        const key = currentShot.key;
        setShotDone((prev) => ({ ...prev, [key]: item.id }));
        setShotIndex((index) => index + 1);
      }
    } catch {
      setStorageError(
        "Couldn't save that photo. Your device may be out of storage — free up space and try again.",
      );
    } finally {
      setSaving(false);
    }
  };

  const onSkipShot = () => {
    if (!currentShot) return;
    const key = currentShot.key;
    setShotDone((prev) => ({ ...prev, [key]: 'skipped' }));
    setShotIndex((index) => index + 1);
  };

  /** Retake: drop the queued copy and reopen its shot. Synced photos are
   *  already on the server, so they lock in (no orphaned server captures). */
  const onRetake = async (item: QueueItem) => {
    if (item.state === 'synced') return;
    await removeCapture(item.id);
    const entry = Object.entries(shotDone).find(([, value]) => value === item.id);
    if (entry) {
      const [key] = entry;
      setShotDone((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      const index = shots.findIndex((shot) => shot.key === key);
      if (index >= 0) setShotIndex(index);
    }
  };

  // ── generate ──────────────────────────────────────────────────────────────
  const [genState, setGenState] = useState<GenState>('idle');
  const [genError, setGenError] = useState<string | null>(null);
  // Derived, not synced: the moment the queue drains, Generate re-enables.
  const waitingSync = genState === 'waiting_sync' && (summary.pending > 0 || summary.failed > 0);

  const onGenerate = async () => {
    if (!jobId) return;
    setGenError(null);
    setGenState('pending');
    try {
      await api.estimates.generate(jobId);
      setGenState('idle');
      router.push(href(`/generation/${jobId}`));
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        if (summary.pending > 0 || summary.failed > 0) {
          setGenState('waiting_sync');
        } else {
          // Server has no synced captures and nothing is queued locally.
          setGenState('idle');
          setGenError(error.message);
        }
      } else {
        setGenState('idle');
        setGenError(
          error instanceof ApiError ? error.message : 'Could not start generation. Try again.',
        );
      }
    }
  };

  const doneCount = Object.keys(shotDone).length;
  const canGenerate = summary.total > 0 && !waitingSync && genState !== 'pending';

  // ── camera pane by permission state ───────────────────────────────────────
  let cameraPane: ReactNode;
  if (!permission) {
    cameraPane = (
      <View style={styles.permissionPane}>
        <Text style={styles.permissionBody}>Checking camera…</Text>
      </View>
    );
  } else if (permission.granted) {
    cameraPane = (
      <View style={styles.cameraWrap}>
        <CameraView ref={cameraRef} style={styles.camera} facing="back" />
        <View style={styles.shutterRow} pointerEvents="box-none">
          <Pressable
            onPress={() => void onShutter()}
            disabled={saving}
            accessibilityRole="button"
            accessibilityLabel="Take photo"
            style={({ pressed }) => [
              styles.shutter,
              pressed && styles.shutterPressed,
              saving && styles.shutterSaving,
            ]}
          >
            <View style={styles.shutterInner} />
          </Pressable>
        </View>
      </View>
    );
  } else if (permission.canAskAgain) {
    cameraPane = (
      <View style={styles.permissionPane}>
        <Camera size={32} color={colors.textMuted} strokeWidth={1.5} />
        <Text style={styles.permissionTitle}>Camera access needed</Text>
        <Text style={styles.permissionBody}>
          Job-site photos are what the estimate is built from. FieldQuote only uses the camera while
          you capture.
        </Text>
        <Pressable
          onPress={() => void requestPermission()}
          accessibilityRole="button"
          accessibilityLabel="Allow camera access"
          style={({ pressed }) => [styles.permissionButton, pressed && { opacity: 0.85 }]}
        >
          <Text style={styles.permissionButtonText}>Allow camera</Text>
        </Pressable>
      </View>
    );
  } else {
    cameraPane = (
      <View style={styles.permissionPane}>
        <Camera size={32} color={colors.textMuted} strokeWidth={1.5} />
        <Text style={styles.permissionTitle}>Camera is turned off</Text>
        <Text style={styles.permissionBody}>
          Camera access is blocked for FieldQuote. Enable it in your device settings to capture
          job-site photos — voice notes still work without it.
        </Text>
        <Pressable
          onPress={() => void Linking.openSettings()}
          accessibilityRole="button"
          accessibilityLabel="Open settings"
          style={({ pressed }) => [styles.permissionButton, pressed && { opacity: 0.85 }]}
        >
          <Text style={styles.permissionButtonText}>Open settings</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      {/* ── top bar ── */}
      <View style={styles.topBar}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={({ pressed }) => [styles.backButton, pressed && { opacity: 0.7 }]}
        >
          <ChevronLeft size={24} color={colors.textOnInk} strokeWidth={2} />
        </Pressable>
        <View style={styles.topBarTitles}>
          <Text style={styles.eyebrow}>Capture</Text>
          <Text style={styles.jobTitle} numberOfLines={1}>
            {job?.title ?? '…'}
          </Text>
        </View>
        <Text style={styles.shotCounter}>
          {doneCount}/{shots.length}
        </Text>
      </View>

      {offline ? (
        <View style={styles.offlineBanner}>
          <CloudOff size={16} color={colors.textOnInk} strokeWidth={2} />
          <Text style={styles.offlineText}>
            Offline — captures are saved on this phone and sync automatically.
          </Text>
        </View>
      ) : null}

      {/* ── job-type chips ── */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chipScroll}
        contentContainerStyle={styles.chipRow}
      >
        {JOB_TYPE_CHIPS.map((chip) => {
          const selected = chip.code === jobType;
          return (
            <Pressable
              key={chip.code}
              onPress={() => onSelectType(chip.code)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
              style={({ pressed }) => [
                styles.typeChip,
                selected && styles.typeChipSelected,
                pressed && { opacity: 0.85 },
              ]}
            >
              <Text style={[styles.typeChipText, selected && styles.typeChipTextSelected]}>
                {chip.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {/* ── shot guide ── */}
      <View style={styles.guide}>
        <View style={styles.dotsRow}>
          {shots.map((shot, index) => {
            const state = shotDone[shot.key];
            return (
              <View
                key={shot.key}
                style={[
                  styles.dot,
                  state === 'skipped' && styles.dotSkipped,
                  state && state !== 'skipped' && styles.dotDone,
                  index === shotIndex && styles.dotCurrent,
                ]}
              />
            );
          })}
        </View>
        {currentShot ? (
          <View style={styles.guideRow}>
            <View style={styles.guideText}>
              <Text style={styles.shotLabel}>{currentShot.label}</Text>
              <Text style={styles.shotHint}>{currentShot.hint}</Text>
            </View>
            <Pressable
              onPress={onSkipShot}
              accessibilityRole="button"
              accessibilityLabel={`Skip ${currentShot.label}`}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              style={({ pressed }) => [styles.skipButton, pressed && { opacity: 0.7 }]}
            >
              <Text style={styles.skipText}>Skip</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.guideRow}>
            <View style={styles.guideText}>
              <Text style={styles.shotLabel}>Shot list complete</Text>
              <Text style={styles.shotHint}>Add any extra angles that tell the story.</Text>
            </View>
          </View>
        )}
        {currentShot?.safetyNote ? (
          <View style={styles.safetyRow}>
            <TriangleAlert size={16} color={colors.warning} strokeWidth={2} />
            <Text style={styles.safetyText}>{currentShot.safetyNote}</Text>
          </View>
        ) : null}
      </View>

      {/* ── camera ── */}
      {cameraPane}

      {/* ── thumbnails ── */}
      {photos.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.thumbScroll}
          contentContainerStyle={styles.thumbRow}
        >
          {photos.map((item) => (
            <Pressable
              key={item.id}
              onPress={() => void onRetake(item)}
              disabled={item.state === 'synced'}
              accessibilityRole="button"
              accessibilityLabel={item.state === 'synced' ? 'Photo synced' : 'Retake this photo'}
              style={({ pressed }) => [styles.thumb, pressed && { opacity: 0.8 }]}
            >
              {item.state === 'synced' ? (
                <View style={styles.thumbSynced}>
                  <Check size={18} color={colors.success} strokeWidth={2.5} />
                </View>
              ) : (
                <>
                  <Image
                    source={{ uri: item.localUri }}
                    style={styles.thumbImage}
                    contentFit="cover"
                  />
                  <View style={styles.thumbBadge}>
                    {item.state === 'failed' ? (
                      <TriangleAlert size={12} color={colors.danger} strokeWidth={2.5} />
                    ) : (
                      <X size={12} color={colors.textOnInk} strokeWidth={2.5} />
                    )}
                  </View>
                </>
              )}
            </Pressable>
          ))}
        </ScrollView>
      ) : null}

      {/* ── sync status strip ── */}
      {summary.label || summary.total > 0 ? (
        <View style={styles.syncStrip}>
          <Pressable
            onPress={() => failedItems.length > 0 && setShowFailed((value) => !value)}
            accessibilityRole={failedItems.length > 0 ? 'button' : 'text'}
            style={styles.syncHeader}
          >
            <Text style={[styles.syncText, summary.failed > 0 && styles.syncTextFailed]}>
              {summary.label ??
                `${summary.synced} capture${summary.synced === 1 ? '' : 's'} synced`}
            </Text>
            {failedItems.length > 0 ? (
              showFailed ? (
                <ChevronUp size={16} color={colors.danger} strokeWidth={2} />
              ) : (
                <ChevronDown size={16} color={colors.danger} strokeWidth={2} />
              )
            ) : null}
          </Pressable>
          {showFailed
            ? failedItems.map((item) => (
                <View key={item.id} style={styles.failedRow}>
                  <Text style={styles.failedText} numberOfLines={1}>
                    {item.kind === 'photo' ? 'Photo' : 'Voice note'} didn’t sync
                  </Text>
                  <Pressable
                    onPress={() => void retryCapture(item.id)}
                    accessibilityRole="button"
                    accessibilityLabel="Retry sync"
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    style={({ pressed }) => [styles.retryButton, pressed && { opacity: 0.7 }]}
                  >
                    <RefreshCw size={14} color={colors.primary} strokeWidth={2} />
                    <Text style={styles.retryText}>Retry</Text>
                  </Pressable>
                </View>
              ))
            : null}
        </View>
      ) : null}

      {storageError ? (
        <View style={styles.errorBanner}>
          <TriangleAlert size={16} color={colors.warning} strokeWidth={2} />
          <Text style={styles.errorBannerText}>{storageError}</Text>
          <Pressable
            onPress={() => setStorageError(null)}
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <X size={16} color={colors.warning} strokeWidth={2} />
          </Pressable>
        </View>
      ) : null}

      {waitingSync ? (
        <View style={styles.errorBanner}>
          <CloudOff size={16} color={colors.warning} strokeWidth={2} />
          <Text style={styles.errorBannerText}>
            Still syncing — captures upload automatically when you’re back online. Generation
            unlocks the moment they land.
          </Text>
        </View>
      ) : null}
      {genError ? <Text style={styles.genError}>{genError}</Text> : null}

      {/* ── actions ── */}
      <View style={styles.actions}>
        <Pressable
          onPress={() => router.push(href(`/dictate/${jobId}`))}
          accessibilityRole="button"
          accessibilityLabel="Add voice note"
          style={({ pressed }) => [styles.voiceButton, pressed && styles.voiceButtonPressed]}
        >
          <Mic size={18} color={colors.textOnInk} strokeWidth={2} />
          <Text style={styles.voiceButtonText}>Voice note</Text>
        </Pressable>
        <Pressable
          onPress={() => void onGenerate()}
          disabled={!canGenerate}
          accessibilityRole="button"
          accessibilityLabel="Review and generate estimate"
          style={({ pressed }) => [
            styles.generateButton,
            pressed && styles.generateButtonPressed,
            !canGenerate && styles.generateButtonDisabled,
          ]}
        >
          <Sparkles size={18} color={colors.textOnPrimary} strokeWidth={2} />
          <Text style={styles.generateButtonText}>
            {waitingSync
              ? 'Generate anyway when synced'
              : genState === 'pending'
                ? 'Starting…'
                : 'Review & Generate'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ink },

  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  backButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.full,
  },
  topBarTitles: { flex: 1, gap: 1 },
  eyebrow: {
    color: colors.primary,
    fontSize: typography.size.xs,
    fontFamily: typography.family.semibold,
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  jobTitle: {
    color: colors.textOnInk,
    fontSize: typography.size.md,
    fontFamily: typography.family.bold,
  },
  shotCounter: {
    color: colors.textMuted,
    fontSize: typography.size.sm,
    fontFamily: typography.family.mono,
  },

  offlineBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.inkDeep,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.inkBorder,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  offlineText: {
    flex: 1,
    color: colors.textOnInk,
    fontSize: typography.size.xs,
    fontFamily: typography.family.medium,
  },

  chipScroll: { flexGrow: 0 },
  chipRow: {
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  typeChip: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radii.full,
    borderWidth: 1.5,
    borderColor: colors.inkBorder,
  },
  typeChipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  typeChipText: {
    color: colors.textMuted,
    fontSize: typography.size.sm,
    fontFamily: typography.family.medium,
  },
  typeChipTextSelected: { color: colors.textOnPrimary, fontFamily: typography.family.semibold },

  guide: {
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    gap: spacing.sm,
  },
  dotsRow: { flexDirection: 'row', gap: spacing.xs + 2, alignItems: 'center' },
  dot: {
    width: 8,
    height: 8,
    borderRadius: radii.full,
    backgroundColor: colors.inkBorder,
  },
  dotDone: { backgroundColor: colors.success },
  dotSkipped: { backgroundColor: colors.textMuted },
  dotCurrent: {
    width: 10,
    height: 10,
    backgroundColor: colors.primary,
  },
  guideRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  guideText: { flex: 1, gap: 1 },
  shotLabel: {
    color: colors.textOnInk,
    fontSize: typography.size.md,
    fontFamily: typography.family.semibold,
  },
  shotHint: {
    color: colors.textMuted,
    fontSize: typography.size.sm,
    fontFamily: typography.family.regular,
  },
  skipButton: {
    borderWidth: 1.5,
    borderColor: colors.inkBorder,
    borderRadius: radii.full,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
  },
  skipText: {
    color: colors.textMuted,
    fontSize: typography.size.sm,
    fontFamily: typography.family.semibold,
  },
  safetyRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    backgroundColor: colors.warningBg,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm + 4,
    paddingVertical: spacing.sm,
  },
  safetyText: {
    flex: 1,
    color: colors.warning,
    fontSize: typography.size.xs,
    fontFamily: typography.family.medium,
    lineHeight: 16,
  },

  cameraWrap: {
    flex: 1,
    marginHorizontal: spacing.md,
    borderRadius: radii.lg,
    overflow: 'hidden',
    backgroundColor: colors.inkDeep,
  },
  camera: { flex: 1 },
  shutterRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: spacing.md,
    alignItems: 'center',
  },
  shutter: {
    width: 68,
    height: 68,
    borderRadius: radii.full,
    borderWidth: 4,
    borderColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterPressed: { transform: [{ scale: 0.94 }] },
  shutterSaving: { opacity: 0.5 },
  shutterInner: {
    width: 52,
    height: 52,
    borderRadius: radii.full,
    backgroundColor: colors.surface,
  },

  permissionPane: {
    flex: 1,
    marginHorizontal: spacing.md,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.inkBorder,
    backgroundColor: colors.inkDeep,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
    gap: spacing.sm,
  },
  permissionTitle: {
    color: colors.textOnInk,
    fontSize: typography.size.md,
    fontFamily: typography.family.bold,
    textAlign: 'center',
  },
  permissionBody: {
    color: colors.textMuted,
    fontSize: typography.size.sm,
    fontFamily: typography.family.regular,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 300,
  },
  permissionButton: {
    marginTop: spacing.sm,
    minHeight: touchTarget,
    justifyContent: 'center',
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingHorizontal: spacing.lg,
  },
  permissionButtonText: {
    color: colors.textOnPrimary,
    fontSize: typography.size.md,
    fontFamily: typography.family.semibold,
  },

  thumbScroll: { flexGrow: 0, marginTop: spacing.sm },
  thumbRow: { gap: spacing.sm, paddingHorizontal: spacing.md },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: radii.sm,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.inkBorder,
    backgroundColor: colors.inkDeep,
  },
  thumbImage: { width: '100%', height: '100%' },
  thumbSynced: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  thumbBadge: {
    position: 'absolute',
    top: 2,
    right: 2,
    width: 18,
    height: 18,
    borderRadius: radii.full,
    backgroundColor: 'rgba(15, 23, 42, 0.75)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  syncStrip: {
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    gap: spacing.xs,
  },
  syncHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  syncText: {
    color: colors.textMuted,
    fontSize: typography.size.xs,
    fontFamily: typography.family.mono,
  },
  syncTextFailed: { color: colors.danger },
  failedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  failedText: {
    flex: 1,
    color: colors.textMuted,
    fontSize: typography.size.xs,
    fontFamily: typography.family.regular,
  },
  retryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  retryText: {
    color: colors.primary,
    fontSize: typography.size.xs,
    fontFamily: typography.family.semibold,
  },

  errorBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    backgroundColor: colors.warningBg,
    borderRadius: radii.sm,
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.sm + 4,
    paddingVertical: spacing.sm,
  },
  errorBannerText: {
    flex: 1,
    color: colors.warning,
    fontSize: typography.size.xs,
    fontFamily: typography.family.medium,
    lineHeight: 16,
  },
  genError: {
    color: colors.danger,
    fontSize: typography.size.sm,
    fontFamily: typography.family.medium,
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
  },

  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm + 4,
    paddingBottom: spacing.sm,
  },
  voiceButton: {
    flex: 1,
    minHeight: touchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderRadius: radii.md,
    borderWidth: 1.5,
    borderColor: colors.inkBorder,
  },
  voiceButtonPressed: { backgroundColor: colors.inkPressed },
  voiceButtonText: {
    color: colors.textOnInk,
    fontSize: typography.size.md,
    fontFamily: typography.family.semibold,
  },
  generateButton: {
    flex: 1.5,
    minHeight: touchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderRadius: radii.md,
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.sm,
  },
  generateButtonPressed: { backgroundColor: colors.primaryPressed },
  generateButtonDisabled: { opacity: 0.45 },
  generateButtonText: {
    flexShrink: 1,
    color: colors.textOnPrimary,
    fontSize: typography.size.md,
    fontFamily: typography.family.semibold,
    textAlign: 'center',
  },
});
