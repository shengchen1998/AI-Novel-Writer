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
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 8)
  db.prepare('INSERT INTO contents(id,body) VALUES(1,?)').run('既有正文')
  db.prepare("INSERT INTO drafts(id,chapter_number,version,status,content_id,word_count) VALUES(1,1,1,'finalized',1,4)").run()
  db.prepare(`INSERT INTO finalization_outbox(
    finalization_id,draft_id,chapter_number,chapter_title,content_hash,content_revision,content_snapshot,target_file_name,publication_status
  ) VALUES('final-1',1,1,'第一章',?,1,'既有正文','chapter-1.txt','published')`).run('a'.repeat(64))
  db.prepare(`INSERT INTO chapter_character_state_snapshots(
    snapshot_id,operation_id,finalization_id,draft_id,chapter_number,chapter_title,content_hash,schema_version,snapshot_hash
  ) VALUES('snapshot-1','finalization:final-1','final-1',1,1,'第一章',?,1,?)`).run('a'.repeat(64), 'b'.repeat(64))
  return db
}

describe('installed M08 lane', () => {
  it('adds continuity metadata without rewriting existing snapshots or backfilling inputs', () => {
    const db = fixture()
    try {
      const result = migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 9)
      expect(CURRENT_DESKTOP_SCHEMA_VERSION).toBe(10)
      expect(result.completedSteps).toEqual(['M08'])
      expect(db.prepare('SELECT body FROM contents').pluck().get()).toBe('既有正文')
      expect(db.prepare(`SELECT snapshot_hash,predecessor_snapshot_id,predecessor_hash,input_hash,continuity_generation
        FROM chapter_character_state_snapshots`).get()).toEqual({
        snapshot_hash: 'b'.repeat(64), predecessor_snapshot_id: null, predecessor_hash: null, input_hash: null, continuity_generation: null,
      })
      expect(db.prepare('SELECT COUNT(*) FROM chapter_character_state_snapshots').pluck().get()).toBe(1)
      expect(verifySchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 9).version).toBe(9)
      expect(migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 9).completedSteps).toEqual([])
      expect(() => db.prepare("UPDATE chapter_character_state_snapshots SET input_hash=? WHERE snapshot_id='snapshot-1'")
        .run('c'.repeat(64))).toThrow('CHAPTER_CHARACTER_STATE_SNAPSHOT_IMMUTABLE')
    } finally { db.close() }
  })

  it('rolls back a failed M08 verification without changing the v8 snapshot schema', () => {
    const db = fixture()
    try {
      const registry = getDesktopMigrationRegistry(), before = sqliteSchemaFingerprint(db)
      const rejected = createMigrationRegistry(registry.implementations.map(step => step.id === 'M08'
        ? { ...step, verify: () => false } : step), registry.recognizedSchemas)
      expect(() => migrateSchema(new SqliteSchemaAdapter(db), rejected, 9)).toThrow('MIGRATION_VERIFICATION_FAILED')
      expect(db.pragma('user_version', { simple: true })).toBe(8)
      expect(sqliteSchemaFingerprint(db)).toBe(before)
      expect(db.prepare('SELECT snapshot_hash FROM chapter_character_state_snapshots').pluck().get()).toBe('b'.repeat(64))
      expect(db.prepare("SELECT 1 FROM pragma_table_info('chapter_character_state_snapshots') WHERE name='input_hash'").get()).toBeUndefined()
    } finally { db.close() }
  })
})
