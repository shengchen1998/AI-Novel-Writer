import type Database from 'better-sqlite3'
import type { MigrationImplementation, SchemaReader } from './registry'

export const M08_CHAPTER_CHARACTER_STATE_CONTINUITY_SQL = `
ALTER TABLE chapter_character_state_snapshots ADD COLUMN predecessor_snapshot_id TEXT;
ALTER TABLE chapter_character_state_snapshots ADD COLUMN predecessor_hash TEXT;
ALTER TABLE chapter_character_state_snapshots ADD COLUMN input_hash TEXT;
ALTER TABLE chapter_character_state_snapshots ADD COLUMN continuity_generation INTEGER;
CREATE INDEX idx_chapter_character_state_snapshot_predecessor
 ON chapter_character_state_snapshots(predecessor_snapshot_id);
`

export function applyM08ChapterCharacterStateContinuity(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('CHAPTER_CHARACTER_STATE_MIGRATION_TRANSACTION_REQUIRED')
  const columns = db.prepare('PRAGMA table_info(chapter_character_state_snapshots)').all() as Array<{ name: string }>
  if (!columns.length || columns.some(column => ['predecessor_snapshot_id', 'predecessor_hash', 'input_hash', 'continuity_generation'].includes(column.name))) {
    throw new Error('CHAPTER_CHARACTER_STATE_MIGRATION_SCHEMA_UNRECOGNIZED')
  }
  db.exec(M08_CHAPTER_CHARACTER_STATE_CONTINUITY_SQL)
}

export function verifyM08ChapterCharacterStateContinuity(db: Database.Database): boolean {
  try {
    const columns = new Set((db.prepare('PRAGMA table_info(chapter_character_state_snapshots)').all() as Array<{ name: string }>).map(column => column.name))
    return ['predecessor_snapshot_id', 'predecessor_hash', 'input_hash', 'continuity_generation'].every(column => columns.has(column))
      && !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_chapter_character_state_snapshot_predecessor'").get()
  } catch {
    return false
  }
}

export function createM08Migration(deps: {
  database(reader: SchemaReader): Database.Database
  verifyKnownSchema(reader: SchemaReader): boolean
}): MigrationImplementation {
  return {
    id: 'M08', from: 8, to: 9, owner: 'I07',
    migrate: reader => applyM08ChapterCharacterStateContinuity(deps.database(reader)),
    verify: reader => deps.verifyKnownSchema(reader) && verifyM08ChapterCharacterStateContinuity(deps.database(reader)),
  }
}
