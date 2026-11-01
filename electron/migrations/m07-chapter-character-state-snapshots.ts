import type Database from 'better-sqlite3'
import type { MigrationImplementation, SchemaReader } from './registry'

export const M07_CHAPTER_CHARACTER_STATE_SNAPSHOT_SQL = `
CREATE TABLE chapter_character_state_snapshots (
 snapshot_id TEXT PRIMARY KEY,
 operation_id TEXT NOT NULL UNIQUE,
 finalization_id TEXT NOT NULL REFERENCES finalization_outbox(finalization_id) ON DELETE CASCADE,
 draft_id INTEGER NOT NULL,
 chapter_number INTEGER NOT NULL CHECK(chapter_number > 0),
 chapter_title TEXT NOT NULL,
 content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
 schema_version INTEGER NOT NULL CHECK(schema_version = 1),
 snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash) = 64),
 unresolved_json TEXT NOT NULL DEFAULT '[]',
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_chapter_character_state_snapshot_source
 ON chapter_character_state_snapshots(finalization_id,draft_id,chapter_number);
CREATE TABLE chapter_character_state_snapshot_characters (
 snapshot_id TEXT NOT NULL REFERENCES chapter_character_state_snapshots(snapshot_id) ON DELETE CASCADE,
 character_id TEXT NOT NULL,
 display_name_snapshot TEXT NOT NULL,
 aliases_json TEXT NOT NULL,
 updated_at_chapter INTEGER NOT NULL CHECK(updated_at_chapter >= 0),
 involved INTEGER NOT NULL DEFAULT 0 CHECK(involved IN (0,1)),
 changed_fields_json TEXT NOT NULL DEFAULT '[]',
 PRIMARY KEY(snapshot_id,character_id)
);
CREATE INDEX idx_chapter_character_state_snapshot_character
 ON chapter_character_state_snapshot_characters(character_id,snapshot_id);
CREATE TABLE chapter_character_state_snapshot_fields (
 snapshot_id TEXT NOT NULL,
 character_id TEXT NOT NULL,
 field TEXT NOT NULL CHECK(field IN ('location','powerLevel','physicalState','mentalState','keyItems','recentEvents')),
 value TEXT NOT NULL,
 provenance_kind TEXT NOT NULL CHECK(provenance_kind IN ('author','derived','legacy')),
 known_at_chapter INTEGER CHECK(known_at_chapter IS NULL OR known_at_chapter >= 0),
 provenance_json TEXT NOT NULL,
 evidence_json TEXT,
 PRIMARY KEY(snapshot_id,character_id,field),
 FOREIGN KEY(snapshot_id,character_id)
  REFERENCES chapter_character_state_snapshot_characters(snapshot_id,character_id) ON DELETE CASCADE
);
CREATE TRIGGER chapter_character_state_snapshots_no_update
BEFORE UPDATE ON chapter_character_state_snapshots
BEGIN
 SELECT RAISE(ABORT,'CHAPTER_CHARACTER_STATE_SNAPSHOT_IMMUTABLE');
END;
CREATE TRIGGER chapter_character_state_snapshot_characters_no_update
BEFORE UPDATE ON chapter_character_state_snapshot_characters
BEGIN
 SELECT RAISE(ABORT,'CHAPTER_CHARACTER_STATE_SNAPSHOT_IMMUTABLE');
END;
CREATE TRIGGER chapter_character_state_snapshot_fields_no_update
BEFORE UPDATE ON chapter_character_state_snapshot_fields
BEGIN
 SELECT RAISE(ABORT,'CHAPTER_CHARACTER_STATE_SNAPSHOT_IMMUTABLE');
END;
`

export function applyM07ChapterCharacterStateSnapshots(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('CHAPTER_CHARACTER_STATE_MIGRATION_TRANSACTION_REQUIRED')
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='finalization_outbox'").get()) {
    throw new Error('CHAPTER_CHARACTER_STATE_MIGRATION_SCHEMA_UNRECOGNIZED')
  }
  db.exec(M07_CHAPTER_CHARACTER_STATE_SNAPSHOT_SQL)
}

export function verifyM07ChapterCharacterStateSnapshots(db: Database.Database): boolean {
  try {
    if (db.pragma('foreign_keys', { simple: true }) !== 1 || (db.pragma('foreign_key_check') as unknown[]).length) return false
    const tables = [
      'chapter_character_state_snapshots',
      'chapter_character_state_snapshot_characters',
      'chapter_character_state_snapshot_fields',
    ]
    const triggers = [
      'chapter_character_state_snapshots_no_update',
      'chapter_character_state_snapshot_characters_no_update',
      'chapter_character_state_snapshot_fields_no_update',
    ]
    return tables.every(name => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))
      && triggers.every(name => db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name))
  } catch {
    return false
  }
}

export function createM07Migration(deps: {
  database(reader: SchemaReader): Database.Database
  verifyKnownSchema(reader: SchemaReader): boolean
}): MigrationImplementation {
  return {
    id: 'M07', from: 7, to: 8, owner: 'I06',
    migrate: reader => applyM07ChapterCharacterStateSnapshots(deps.database(reader)),
    verify: reader => deps.verifyKnownSchema(reader) && verifyM07ChapterCharacterStateSnapshots(deps.database(reader)),
  }
}
