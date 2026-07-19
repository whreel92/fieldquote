/**
 * Capture queue state machine tests (§0.1.7 — capture queue must be tested).
 * The core is pure, so these cover exactly the logic that guarantees a dead
 * zone never loses a capture: retry/backoff, crash recovery, terminal states.
 */

import { describe, expect, it } from 'vitest';

import {
  backoffMs,
  eligible,
  MAX_ATTEMPTS,
  nextStep,
  onStepFailure,
  onStepSuccess,
  recoverInFlight,
  retryItem,
  summarize,
  type QueueItem,
} from './core';

function item(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'a1',
    jobId: 'job1',
    kind: 'photo',
    localUri: 'file:///captures/a1.jpg',
    durationS: null,
    state: 'queued',
    remoteCaptureId: null,
    uploadUrl: null,
    uploadToken: null,
    attempts: 0,
    lastError: null,
    nextAttemptAt: 0,
    createdAt: 1000,
    ...overrides,
  };
}

describe('lifecycle', () => {
  it('walks register → upload → complete → synced', () => {
    let current = item();
    expect(nextStep(current)).toBe('register');
    current = onStepSuccess(current, 'register', {
      remoteCaptureId: 'r1',
      uploadUrl: 'https://u',
      uploadToken: 't',
    });
    expect(current.state).toBe('uploading');
    expect(nextStep(current)).toBe('upload');
    current = onStepSuccess(current, 'upload');
    expect(current.state).toBe('completing');
    expect(nextStep(current)).toBe('complete');
    current = onStepSuccess(current, 'complete');
    expect(current.state).toBe('synced');
    expect(nextStep(current)).toBeNull();
  });

  it('keeps registration when only the upload failed', () => {
    let current = onStepSuccess(item(), 'register', {
      remoteCaptureId: 'r1',
      uploadUrl: 'https://u',
      uploadToken: 't',
    });
    current = onStepFailure(current, 'network down', 10_000);
    expect(current.state).toBe('queued');
    expect(current.remoteCaptureId).toBe('r1');
    // resumes at upload, not from scratch
    expect(nextStep(current)).toBe('upload');
  });
});

describe('retry & backoff', () => {
  it('backs off exponentially with a 5-minute cap', () => {
    expect(backoffMs(1)).toBe(2_000);
    expect(backoffMs(2)).toBe(4_000);
    expect(backoffMs(3)).toBe(8_000);
    expect(backoffMs(20)).toBe(300_000);
  });

  it('failure schedules the next attempt in the future', () => {
    const failed = onStepFailure(item(), 'boom', 50_000);
    expect(failed.attempts).toBe(1);
    expect(failed.nextAttemptAt).toBe(52_000);
    expect(failed.lastError).toBe('boom');
  });

  it('parks as failed after MAX_ATTEMPTS and manual retry revives it', () => {
    let current = item({ attempts: MAX_ATTEMPTS - 1 });
    current = onStepFailure(current, 'still down', 0);
    expect(current.state).toBe('failed');
    // failed items are not auto-eligible
    expect(eligible([current], Number.MAX_SAFE_INTEGER)).toHaveLength(0);
    const revived = retryItem(current);
    expect(revived.state).toBe('queued');
    expect(revived.attempts).toBe(0);
    expect(eligible([revived], Date.now())).toHaveLength(1);
  });

  it('retryItem is a no-op on non-failed items', () => {
    const synced = item({ state: 'synced' });
    expect(retryItem(synced)).toBe(synced);
  });
});

describe('eligibility & ordering', () => {
  it('respects nextAttemptAt', () => {
    const soon = item({ id: 'soon', nextAttemptAt: 10_000 });
    expect(eligible([soon], 9_999)).toHaveLength(0);
    expect(eligible([soon], 10_000)).toHaveLength(1);
  });

  it('returns oldest first', () => {
    const older = item({ id: 'older', createdAt: 1 });
    const newer = item({ id: 'newer', createdAt: 2 });
    expect(eligible([newer, older], Date.now()).map((entry) => entry.id)).toEqual([
      'older',
      'newer',
    ]);
  });

  it('never returns synced items', () => {
    expect(eligible([item({ state: 'synced' })], Date.now())).toHaveLength(0);
  });
});

describe('crash recovery (kill-and-relaunch must not lose data)', () => {
  it.each(['registering', 'uploading', 'completing'] as const)(
    'resets in-flight state %s back to queued without consuming an attempt',
    (state) => {
      const recovered = recoverInFlight(item({ state, attempts: 2 }));
      expect(recovered.state).toBe('queued');
      expect(recovered.attempts).toBe(2);
      expect(recovered.nextAttemptAt).toBe(0);
    },
  );

  it('leaves settled states alone', () => {
    for (const state of ['queued', 'synced', 'failed'] as const) {
      expect(recoverInFlight(item({ state })).state).toBe(state);
    }
  });
});

describe('summary label', () => {
  it('describes pending mix', () => {
    const summary = summarize([
      item({ id: '1', kind: 'photo' }),
      item({ id: '2', kind: 'photo' }),
      item({ id: '3', kind: 'photo', state: 'uploading' }),
      item({ id: '4', kind: 'audio' }),
      item({ id: '5', state: 'synced' }),
    ]);
    expect(summary.pending).toBe(4);
    expect(summary.label).toBe('3 photos + 1 voice note syncing…');
  });

  it('reports failures when nothing is pending', () => {
    const summary = summarize([item({ state: 'failed' }), item({ id: '2', state: 'synced' })]);
    expect(summary.failed).toBe(1);
    expect(summary.label).toBe('1 capture failed to sync');
  });

  it('is null when fully synced', () => {
    expect(summarize([item({ state: 'synced' })]).label).toBeNull();
    expect(summarize([]).label).toBeNull();
  });
});
