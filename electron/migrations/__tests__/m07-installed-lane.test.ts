import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { initializeLegacyBaselineSchema } from '../baseline-schema'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../desktop-registry'
import { createMigrationRegistry } from '../registry'
import { migrateSchema, verifySchema } from '../runner'
import { SqliteSchemaAdapter, sqliteSchemaFingerprint } from '../sqlite-schema-adapter'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')

function fixture() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys=ON')
  db.transaction(() => initializeLegacyBaselineSchema(db))()
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 7)
  db.prepare('INSERT INTO contents(id,body) VALUES(1,?)').run('v7 作者正文')
  return db
}

describe('installed M07 lane', () => {
  it('creates empty append-only snapshot storage without backfilling history', () => {
    const db = fixture()
    try {
      const before = db.prepare('SELECT body FROM contents').pluck().get()
      const result = migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 8)
      expect(CURRENT_DESKTOP_SCHEMA_VERSION).toBe(10)
      expect(result.completedSteps).toEqual(['M07'])
      expect(db.prepare('SELECT body FROM contents').pluck().get()).toBe(before)
      expect(db.prepare('SELECT COUNT(*) FROM chapter_character_state_snapshots').pluck().get()).toBe(0)
      expect(verifySchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 8).version).toBe(8)
      expect(migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 8).completedSteps).toEqual([])
    } finally { db.close() }
  })

  it('rejects content updates while allowing finalization deletion to cascade', () => {
    const db = fixture()
    try {
      migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 8)
      db.prepare("INSERT INTO drafts(id,chapter_number,version,status,content_id,word_count) VALUES(1,1,1,'finalized',1,7)").run()
      db.prepare(`INSERT INTO finalization_outbox(
        finalization_id,draft_id,chapter_number,chapter_title,content_hash,content_revision,content_snapshot,target_file_name,publication_status
      ) VALUES('final-1',1,1,'第一章',?,1,'v7 作者正文','chapter-1.txt','published')`).run('a'.repeat(64))
      db.prepare(`INSERT INTO chapter_character_state_snapshots(
        snapshot_id,operation_id,finalization_id,draft_id,chapter_number,chapter_title,content_hash,schema_version,snapshot_hash
      ) VALUES('snapshot-1','finalization:final-1','final-1',1,1,'第一章',?,1,?)`).run('a'.repeat(64), 'b'.repeat(64))
      db.prepare(`INSERT INTO chapter_character_state_snapshot_characters(
        snapshot_id,character_id,display_name_snapshot,aliases_json,updated_at_chapter
      ) VALUES('snapshot-1','character-1','林岚','["林岚"]',1)`).run()
      db.prepare(`INSERT INTO chapter_character_state_snapshot_fields(
        snapshot_id,character_id,field,value,provenance_kind,known_at_chapter,provenance_json,evidence_json
      ) VALUES('snapshot-1','character-1','location','北塔','derived',1,?,?)`).run(
        JSON.stringify({ kind: 'derived', source: { draftId: 1, finalizationId: 'final-1', chapterNumber: 1, contentHash: 'a'.repeat(64) } }),
        JSON.stringify({ start: 0, end: 3, text: '北塔。' }),
      )

      for (const statement of [
        "UPDATE chapter_character_state_snapshots SET chapter_title='改写' WHERE snapshot_id='snapshot-1'",
        "UPDATE chapter_character_state_snapshots SET unresolved_json='[{\"displayName\":\"改写\"}]' WHERE snapshot_id='snapshot-1'",
        "UPDATE chapter_character_state_snapshot_characters SET display_name_snapshot='改写' WHERE snapshot_id='snapshot-1'",
        "UPDATE chapter_character_state_snapshot_fields SET value='改写' WHERE snapshot_id='snapshot-1'",
      ]) {
        expect(() => db.prepare(statement).run()).toThrow('CHAPTER_CHARACTER_STATE_SNAPSHOT_IMMUTABLE')
      }

      db.prepare('DELETE FROM finalization_outbox WHERE finalization_id=?').run('final-1')
      expect(db.prepare('SELECT COUNT(*) FROM chapter_character_state_snapshots').pluck().get()).toBe(0)
      expect(db.prepare('SELECT COUNT(*) FROM chapter_character_state_snapshot_characters').pluck().get()).toBe(0)
      expect(db.prepare('SELECT COUNT(*) FROM chapter_character_state_snapshot_fields').pluck().get()).toBe(0)
    } finally { db.close() }
  })

  it('rolls back a failed M07 verification without changing v7 data or schema', () => {
    const db = fixture()
    try {
      const registry = getDesktopMigrationRegistry(), before = sqliteSchemaFingerprint(db)
      const rejected = createMigrationRegistry(registry.implementations.map(step => step.id === 'M07'
        ? { ...step, verify: () => false } : step), registry.recognizedSchemas)
      expect(() => migrateSchema(new SqliteSchemaAdapter(db), rejected, 8)).toThrow('MIGRATION_VERIFICATION_FAILED')
      expect(db.pragma('user_version', { simple: true })).toBe(7)
      expect(sqliteSchemaFingerprint(db)).toBe(before)
      expect(db.prepare('SELECT body FROM contents').pluck().get()).toBe('v7 作者正文')
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='chapter_character_state_snapshots'").get()).toBeUndefined()
    } finally { db.close() }
  })
})
