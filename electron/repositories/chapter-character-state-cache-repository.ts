import type Database from 'better-sqlite3'
import type { ChapterCharacterStateCacheStatus } from '../../src/shared/chapter-character-state-snapshot'
import type { FinalizedSourceIdentity } from '../../src/shared/finalized-continuity'
import { readLatestValidSnapshot } from './chapter-character-state-continuity'
import { readSnapshotRow } from './chapter-character-state-snapshot-codec'

export function readCacheStatus(db: Database.Database): ChapterCharacterStateCacheStatus {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chapter_character_state_cache_meta'").get()) {
    return { status: 'invalid', reason: 'not-established', snapshotId: null, source: null }
  }
  const row = db.prepare(`SELECT status,reason,snapshot_id,snapshot_hash,finalization_id FROM chapter_character_state_cache_meta WHERE id='main'`)
    .get() as { status: 'ready' | 'rebuild-required' | 'invalid'; reason: 'cas-conflict' | 'continuity-incomplete' | 'not-established' | null
      snapshot_id: string | null; snapshot_hash: string | null; finalization_id: string | null } | undefined
  if (!row) return { status: 'invalid', reason: 'not-established', snapshotId: null, source: null }
  const latest = readLatestValidSnapshot(db)
  const source = latest?.source ?? null
  if (row.status === 'rebuild-required') {
    return { status: row.status, reason: row.reason ?? 'cas-conflict', snapshotId: row.snapshot_id, source }
  }
  if (row.status !== 'ready' || !latest || row.snapshot_id !== latest.snapshotId
    || row.snapshot_hash !== latest.snapshotHash || row.finalization_id !== latest.source.finalizationId) {
    return { status: 'invalid', reason: 'continuity-incomplete', snapshotId: row.snapshot_id, source }
  }
  return { status: 'ready', reason: null, snapshotId: latest.snapshotId, source: latest.source }
}

export function markCacheRebuildRequired(db: Database.Database, snapshotId: string | null, reason: 'cas-conflict' | 'continuity-incomplete'): void {
  const snapshot = snapshotId ? readSnapshotRow(db, snapshotId) : undefined
  db.prepare(`UPDATE chapter_character_state_cache_meta SET status='rebuild-required',reason=?,snapshot_id=?,snapshot_hash=?,finalization_id=?,
    updated_at=datetime('now') WHERE id='main'`).run(reason, snapshot?.snapshot_id ?? null, snapshot?.snapshot_hash ?? null, snapshot?.finalization_id ?? null)
}

export function markCacheReady(db: Database.Database, snapshot: { snapshotId: string; snapshotHash: string; source: FinalizedSourceIdentity }, rosterRevision: number): void {
  db.prepare(`UPDATE chapter_character_state_cache_meta SET status='ready',reason=NULL,snapshot_id=?,snapshot_hash=?,finalization_id=?,roster_revision=?,
    updated_at=datetime('now') WHERE id='main'`).run(snapshot.snapshotId, snapshot.snapshotHash, snapshot.source.finalizationId, rosterRevision)
}
