/**
 * SQLite persistence for the capture queue. Every mutation is written before
 * the UI or network sees it — the DB is the source of truth so a force-quit
 * never loses state (§0.1.4).
 */

import * as SQLite from 'expo-sqlite';

import type { QueueItem, QueueItemState } from './core';

let db: SQLite.SQLiteDatabase | null = null;

async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!db) {
    db = await SQLite.openDatabaseAsync('capture-queue.db');
    await db.execAsync(`
      pragma journal_mode = WAL;
      create table if not exists queue_items (
        id text primary key,
        job_id text not null,
        kind text not null,
        local_uri text not null,
        duration_s real,
        state text not null,
        remote_capture_id text,
        upload_url text,
        upload_token text,
        attempts integer not null default 0,
        last_error text,
        next_attempt_at integer not null default 0,
        created_at integer not null
      );
      create index if not exists queue_items_job on queue_items (job_id);
    `);
  }
  return db;
}

interface Row {
  id: string;
  job_id: string;
  kind: string;
  local_uri: string;
  duration_s: number | null;
  state: string;
  remote_capture_id: string | null;
  upload_url: string | null;
  upload_token: string | null;
  attempts: number;
  last_error: string | null;
  next_attempt_at: number;
  created_at: number;
}

function fromRow(row: Row): QueueItem {
  return {
    id: row.id,
    jobId: row.job_id,
    kind: row.kind as QueueItem['kind'],
    localUri: row.local_uri,
    durationS: row.duration_s,
    state: row.state as QueueItemState,
    remoteCaptureId: row.remote_capture_id,
    uploadUrl: row.upload_url,
    uploadToken: row.upload_token,
    attempts: row.attempts,
    lastError: row.last_error,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
  };
}

export async function insertItem(item: QueueItem): Promise<void> {
  const database = await getDb();
  await database.runAsync(
    `insert into queue_items (id, job_id, kind, local_uri, duration_s, state,
       remote_capture_id, upload_url, upload_token, attempts, last_error,
       next_attempt_at, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    item.id,
    item.jobId,
    item.kind,
    item.localUri,
    item.durationS,
    item.state,
    item.remoteCaptureId,
    item.uploadUrl,
    item.uploadToken,
    item.attempts,
    item.lastError,
    item.nextAttemptAt,
    item.createdAt,
  );
}

export async function updateItem(item: QueueItem): Promise<void> {
  const database = await getDb();
  await database.runAsync(
    `update queue_items set state = ?, remote_capture_id = ?, upload_url = ?,
       upload_token = ?, attempts = ?, last_error = ?, next_attempt_at = ?
     where id = ?`,
    item.state,
    item.remoteCaptureId,
    item.uploadUrl,
    item.uploadToken,
    item.attempts,
    item.lastError,
    item.nextAttemptAt,
    item.id,
  );
}

export async function deleteItem(id: string): Promise<void> {
  const database = await getDb();
  await database.runAsync('delete from queue_items where id = ?', id);
}

export async function listItems(jobId?: string): Promise<QueueItem[]> {
  const database = await getDb();
  const rows = jobId
    ? await database.getAllAsync<Row>(
        'select * from queue_items where job_id = ? order by created_at',
        jobId,
      )
    : await database.getAllAsync<Row>('select * from queue_items order by created_at');
  return rows.map(fromRow);
}
