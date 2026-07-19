/**
 * Capture queue driver: persists captures locally the moment they're taken,
 * then syncs them (register → upload → complete) with retry/backoff.
 *
 * Usage:
 *   await enqueueCapture({jobId, kind, sourceUri, durationS})  // instant, offline-safe
 *   startSyncLoop()  // idempotent; kicks on app start and on network regain
 *   useCaptureQueue(jobId)  // zustand selector for UI sync-state
 */

import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Network from 'expo-network';
import { create } from 'zustand';

import { api } from '@/lib/api';

import {
  eligible,
  MAX_ATTEMPTS,
  nextStep,
  onStepFailure,
  onStepSuccess,
  recoverInFlight,
  retryItem,
  summarize,
  type QueueItem,
  type QueueSummary,
} from './core';
import { deleteItem, insertItem, listItems, updateItem } from './db';

const CAPTURE_DIR = `${FileSystem.documentDirectory}captures/`;

interface QueueStore {
  items: QueueItem[];
  refresh: () => Promise<void>;
}

export const useQueueStore = create<QueueStore>((set) => ({
  items: [],
  refresh: async () => {
    set({ items: await listItems() });
  },
}));

export function selectJobSummary(items: QueueItem[], jobId: string): QueueSummary {
  return summarize(items.filter((item) => item.jobId === jobId));
}

export function selectJobItems(items: QueueItem[], jobId: string): QueueItem[] {
  return items.filter((item) => item.jobId === jobId);
}

async function ensureDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(CAPTURE_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(CAPTURE_DIR, { intermediates: true });
  }
}

/**
 * Persist a fresh capture into app storage IMMEDIATELY and enqueue it.
 * Photos are downscaled (long edge 2048) with EXIF stripped for upload; the
 * processed copy is what we persist — the caller's original stays wherever
 * the camera wrote it until we delete it after processing succeeds.
 */
export async function enqueueCapture(input: {
  jobId: string;
  kind: 'photo' | 'audio';
  sourceUri: string;
  durationS?: number;
}): Promise<QueueItem> {
  await ensureDir();
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const extension = input.kind === 'photo' ? 'jpg' : 'm4a';
  const localUri = `${CAPTURE_DIR}${id}.${extension}`;

  if (input.kind === 'photo') {
    // Downscale to 2048 long edge; manipulator output strips EXIF (§Phase 4.5).
    const context = ImageManipulator.ImageManipulator.manipulate(input.sourceUri);
    context.resize({ width: 2048 });
    const image = await context.renderAsync();
    const saved = await image.saveAsync({
      compress: 0.85,
      format: ImageManipulator.SaveFormat.JPEG,
    });
    await FileSystem.moveAsync({ from: saved.uri, to: localUri });
  } else {
    await FileSystem.copyAsync({ from: input.sourceUri, to: localUri });
  }

  const item: QueueItem = {
    id,
    jobId: input.jobId,
    kind: input.kind,
    localUri,
    durationS: input.durationS ?? null,
    state: 'queued',
    remoteCaptureId: null,
    uploadUrl: null,
    uploadToken: null,
    attempts: 0,
    lastError: null,
    nextAttemptAt: 0,
    createdAt: Date.now(),
  };
  await insertItem(item);
  await useQueueStore.getState().refresh();
  void kickSync();
  return item;
}

export async function removeCapture(id: string): Promise<void> {
  const items = await listItems();
  const item = items.find((entry) => entry.id === id);
  if (item) {
    await FileSystem.deleteAsync(item.localUri, { idempotent: true });
    await deleteItem(id);
    await useQueueStore.getState().refresh();
  }
}

export async function retryCapture(id: string): Promise<void> {
  const items = await listItems();
  const item = items.find((entry) => entry.id === id);
  if (item) {
    await updateItem(retryItem(item));
    await useQueueStore.getState().refresh();
    void kickSync();
  }
}

// ── sync loop ────────────────────────────────────────────────────────────────

let syncing = false;
let started = false;
let wakeTimer: ReturnType<typeof setTimeout> | null = null;

async function performStep(item: QueueItem): Promise<QueueItem> {
  const step = nextStep(item);
  if (step === null) return item;
  if (step === 'register') {
    await updateItem({ ...item, state: 'registering' });
    const created = await api.captures.create(item.jobId, {
      kind: item.kind,
      duration_s: item.durationS != null ? String(item.durationS) : null,
    });
    return onStepSuccess(item, 'register', {
      remoteCaptureId: created.capture.id,
      uploadUrl: created.upload_url,
      uploadToken: created.upload_token,
    });
  }
  if (step === 'upload') {
    await updateItem({ ...item, state: 'uploading' });
    const result = await FileSystem.uploadAsync(item.uploadUrl as string, item.localUri, {
      httpMethod: 'PUT',
      headers: {
        Authorization: `Bearer ${item.uploadToken ?? ''}`,
        'Content-Type': item.kind === 'photo' ? 'image/jpeg' : 'audio/m4a',
      },
    });
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`upload failed with status ${result.status}`);
    }
    return onStepSuccess(item, 'upload');
  }
  await updateItem({ ...item, state: 'completing' });
  await api.captures.complete(item.remoteCaptureId as string);
  const synced = onStepSuccess(item, 'complete');
  // Sync confirmed — the local original can go (§Phase 4.5).
  await FileSystem.deleteAsync(item.localUri, { idempotent: true });
  return synced;
}

export async function runSyncPass(): Promise<void> {
  if (syncing) return;
  syncing = true;
  try {
    const network = await Network.getNetworkStateAsync();
    if (!network.isConnected) return;
    let items = (await listItems()).map(recoverInFlight);
    for (const item of eligible(items, Date.now())) {
      let current = item;
      // Drive one item all the way through so a single pass fully syncs it.
      for (let step = nextStep(current); step !== null; step = nextStep(current)) {
        try {
          current = await performStep(current);
          await updateItem(current);
        } catch (error) {
          current = onStepFailure(
            current,
            error instanceof Error ? error.message : String(error),
            Date.now(),
          );
          await updateItem(current);
          break;
        }
      }
      await useQueueStore.getState().refresh();
    }
    items = await listItems();
    const nextWake = Math.min(
      ...items
        .filter((item) => item.state === 'queued')
        .map((item) => Math.max(item.nextAttemptAt - Date.now(), 1_000)),
      Number.POSITIVE_INFINITY,
    );
    if (Number.isFinite(nextWake)) {
      if (wakeTimer) clearTimeout(wakeTimer);
      wakeTimer = setTimeout(() => void kickSync(), nextWake);
    }
  } finally {
    syncing = false;
    await useQueueStore.getState().refresh();
  }
}

export function kickSync(): Promise<void> {
  return runSyncPass();
}

/** Idempotent: call from the root layout. Re-kicks when connectivity returns. */
export function startSyncLoop(): void {
  if (started) return;
  started = true;
  void useQueueStore.getState().refresh();
  void runSyncPass();
  Network.addNetworkStateListener((state) => {
    if (state.isConnected) void kickSync();
  });
}

export { MAX_ATTEMPTS };
export type { QueueItem, QueueSummary };
