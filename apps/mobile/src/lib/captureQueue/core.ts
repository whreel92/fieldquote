/**
 * Offline capture queue — pure state machine.
 *
 * Rule §0.1.4: a dead zone must never lose a capture. Files are persisted to
 * app storage the instant they're taken; this module tracks each item through
 * registration → upload → completion with retry/backoff. It is pure logic:
 * all side effects (SQLite, filesystem, network) are injected, so the state
 * machine is fully unit-testable and survives kill-and-relaunch by
 * construction (state lives in SQLite, never only in memory).
 *
 * Item lifecycle:
 *   queued → registering → uploading → completing → synced
 * Any step may fail → back to `queued` with attempts+1 and backoff; after
 * MAX_ATTEMPTS the item parks as `failed` (manual retry resets it).
 */

export type QueueItemState =
  'queued' | 'registering' | 'uploading' | 'completing' | 'synced' | 'failed';

export interface QueueItem {
  id: string; // local uuid
  jobId: string;
  kind: 'photo' | 'audio';
  localUri: string; // persisted copy in app storage (kept until synced)
  durationS: number | null;
  state: QueueItemState;
  remoteCaptureId: string | null;
  uploadUrl: string | null;
  uploadToken: string | null;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: number; // epoch ms; 0 = immediately eligible
  createdAt: number;
}

export const MAX_ATTEMPTS = 8;
const BASE_DELAY_MS = 2_000;
const MAX_DELAY_MS = 5 * 60_000;

/** Exponential backoff with a cap: 2s, 4s, 8s … 5min. */
export function backoffMs(attempts: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1), MAX_DELAY_MS);
}

export function isTerminal(state: QueueItemState): boolean {
  return state === 'synced';
}

/** Items eligible for a sync step right now, oldest first. */
export function eligible(items: QueueItem[], now: number): QueueItem[] {
  return items
    .filter(
      (item) =>
        (item.state === 'queued' ||
          // Crash recovery: in-flight states with no live worker are stale —
          // the driver resets them on startup, but treat them as eligible too.
          item.state === 'registering' ||
          item.state === 'uploading' ||
          item.state === 'completing') &&
        item.nextAttemptAt <= now,
    )
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** The next step for an item (which side effect the driver must perform). */
export function nextStep(item: QueueItem): 'register' | 'upload' | 'complete' | null {
  if (item.state === 'synced' || item.state === 'failed') return null;
  if (item.remoteCaptureId === null || item.uploadUrl === null) return 'register';
  if (item.state !== 'completing') return 'upload';
  return 'complete';
}

export function onStepSuccess(
  item: QueueItem,
  step: 'register' | 'upload' | 'complete',
  payload?: { remoteCaptureId: string; uploadUrl: string; uploadToken: string },
): QueueItem {
  switch (step) {
    case 'register':
      return {
        ...item,
        state: 'uploading',
        remoteCaptureId: payload?.remoteCaptureId ?? item.remoteCaptureId,
        uploadUrl: payload?.uploadUrl ?? item.uploadUrl,
        uploadToken: payload?.uploadToken ?? item.uploadToken,
        lastError: null,
      };
    case 'upload':
      return { ...item, state: 'completing', lastError: null };
    case 'complete':
      return { ...item, state: 'synced', lastError: null };
  }
}

export function onStepFailure(item: QueueItem, error: string, now: number): QueueItem {
  const attempts = item.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    return { ...item, state: 'failed', attempts, lastError: error, nextAttemptAt: 0 };
  }
  return {
    ...item,
    // A failed upload restarts from the upload step (registration is kept);
    // a failed registration restarts from scratch. Both go through `queued`.
    state: 'queued',
    attempts,
    lastError: error,
    nextAttemptAt: now + backoffMs(attempts),
  };
}

/** Manual retry from the UI: failed → queued, immediately eligible. */
export function retryItem(item: QueueItem): QueueItem {
  if (item.state !== 'failed') return item;
  return { ...item, state: 'queued', attempts: 0, lastError: null, nextAttemptAt: 0 };
}

/** Crash recovery on app start: anything mid-flight goes back to queued
 *  without consuming an attempt (the work may or may not have happened —
 *  registration and completion are idempotent server-side, and re-upload
 *  to a signed URL simply overwrites). */
export function recoverInFlight(item: QueueItem): QueueItem {
  if (item.state === 'registering' || item.state === 'uploading' || item.state === 'completing') {
    return { ...item, state: 'queued', nextAttemptAt: 0 };
  }
  return item;
}

export interface QueueSummary {
  total: number;
  synced: number;
  pending: number;
  failed: number;
  /** "3 photos syncing…" style label, or null when idle. */
  label: string | null;
}

export function summarize(items: QueueItem[]): QueueSummary {
  const synced = items.filter((item) => item.state === 'synced').length;
  const failed = items.filter((item) => item.state === 'failed').length;
  const pending = items.length - synced - failed;
  let label: string | null = null;
  if (pending > 0) {
    const pendingItems = items.filter((item) => item.state !== 'synced' && item.state !== 'failed');
    const photos = pendingItems.filter((item) => item.kind === 'photo').length;
    const audio = pendingItems.length - photos;
    const parts: string[] = [];
    if (photos > 0) parts.push(`${photos} photo${photos === 1 ? '' : 's'}`);
    if (audio > 0) parts.push(`${audio} voice note${audio === 1 ? '' : 's'}`);
    label = `${parts.join(' + ')} syncing…`;
  } else if (failed > 0) {
    label = `${failed} capture${failed === 1 ? '' : 's'} failed to sync`;
  }
  return { total: items.length, synced, pending, failed, label };
}
