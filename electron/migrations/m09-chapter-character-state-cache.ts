import type Database from 'better-sqlite3'
import type { MigrationImplementation, SchemaReader } from './registry'

export const M09_CHAPTER_CHARACTER_STATE_CACHE_SQL = `
CREATE TABLE chapter_character_state_cache_meta (
 id TEXT PRIMARY KEY CHECK(id = 'main'),
 status TEXT NOT NULL CHECK(status IN ('ready','rebuild-required','invalid')),
 reason TEXT CHECK(reason IS NULL OR reason IN ('cas-conflict','continuity-incomplete','not-established')),
 snapshot_id TEXT,
 snapshot_hash TEXT,
 finalization_id TEXT,
 roster_revision INTEGER NOT NULL DEFAULT 0 CHECK(roster_revision >= 0),
 updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO chapter_character_state_cache_meta(id,status,reason) VALUES('main','invalid','not-established');
`

export function applyM09ChapterCharacterStateCache(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('CHAPTER_CHARACTER_STATE_MIGRATION_TRANSACTION_REQUIRED')
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chapter_character_state_cache_meta'").get()
    || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chapter_character_state_snapshots'").get()) {
    throw new Error('CHAPTER_CHARACTER_STATE_MIGRATION_SCHEMA_UNRECOGNIZED')
  }
  db.exec(M09_CHAPTER_CHARACTER_STATE_CACHE_SQL)
}

export function verifyM09ChapterCharacterStateCache(db: Database.Database): boolean {
  try {
    const columns = new Set((db.prepare('PRAGMA table_info(chapter_character_state_cache_meta)').all() as Array<{ name: string }>).map(column => column.name))
    const row = db.prepare("SELECT status,reason FROM chapter_character_state_cache_meta WHERE id='main'").get() as { status: string; reason: string } | undefined
    return ['id', 'status', 'reason', 'snapshot_id', 'snapshot_hash', 'finalization_id', 'roster_revision', 'updated_at']
      .every(column => columns.has(column)) && !!row && ['ready', 'rebuild-required', 'invalid'].includes(row.status)
  } catch {
    return false
  }
}

export function createM09Migration(deps: {
  database(reader: SchemaReader): Database.Database
  verifyKnownSchema(reader: SchemaReader): boolean
}): MigrationImplementation {
  return {
    id: 'M09', from: 9, to: 10, owner: 'I09',
    migrate: reader => applyM09ChapterCharacterStateCache(deps.database(reader)),
    verify: reader => deps.verifyKnownSchema(reader) && verifyM09ChapterCharacterStateCache(deps.database(reader)),
  }
}
