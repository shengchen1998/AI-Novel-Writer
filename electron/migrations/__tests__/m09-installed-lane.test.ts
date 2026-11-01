import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
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
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 9)
  db.prepare('INSERT INTO contents(id,body) VALUES(1,?)').run('既有正文')
  db.prepare("INSERT INTO drafts(id,chapter_number,version,status,content_id,word_count) VALUES(1,1,1,'finalized',1,4)").run()
  db.prepare(`INSERT INTO finalization_outbox(
    finalization_id,draft_id,chapter_number,chapter_title,content_hash,content_revision,content_snapshot,target_file_name,publication_status
  ) VALUES('final-1',1,1,'第一章',?,1,'既有正文','chapter-1.txt','published')`).run('a'.repeat(64))
  db.prepare(`INSERT INTO chapter_character_state_snapshots(
    snapshot_id,operation_id,finalization_id,draft_id,chapter_number,chapter_title,content_hash,schema_version,snapshot_hash,
    predecessor_snapshot_id,predecessor_hash,input_hash,continuity_generation
  ) VALUES('snapshot-1','finalization:final-1','final-1',1,1,'第一章',?,1,?,NULL,NULL,?,0)`).run('a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64))
  return db
}

describe('installed M09 lane', () => {
  it('creates an invalid cache marker without rewriting snapshots or calling a model', () => {
    const db = fixture()
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    try {
      const result = migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 10)
      expect(CURRENT_DESKTOP_SCHEMA_VERSION).toBe(10)
      expect(result.completedSteps).toEqual(['M09'])
      expect(db.prepare('SELECT body FROM contents').pluck().get()).toBe('既有正文')
      expect(db.prepare('SELECT snapshot_hash,input_hash FROM chapter_character_state_snapshots').get()).toEqual({
        snapshot_hash: 'b'.repeat(64), input_hash: 'c'.repeat(64),
      })
      expect(db.prepare('SELECT status,reason,snapshot_id,roster_revision FROM chapter_character_state_cache_meta').get()).toEqual({
        status: 'invalid', reason: 'not-established', snapshot_id: null, roster_revision: 0,
      })
      expect(fetch).not.toHaveBeenCalled()
      expect(verifySchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 10).version).toBe(10)
      expect(migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 10).completedSteps).toEqual([])
      db.prepare("UPDATE chapter_character_state_cache_meta SET status='ready',reason=NULL,snapshot_id='snapshot-1',snapshot_hash=?,finalization_id='final-1' WHERE id='main'")
        .run('b'.repeat(64))
      expect(verifySchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 10).version).toBe(10)
    } finally {
      vi.unstubAllGlobals()
      db.close()
    }
  })

  it('rolls back a failed M09 verification without changing the v9 schema', () => {
    const db = fixture()
    try {
      const registry = getDesktopMigrationRegistry(), before = sqliteSchemaFingerprint(db)
      const rejected = createMigrationRegistry(registry.implementations.map(step => step.id === 'M09'
        ? { ...step, verify: () => false } : step), registry.recognizedSchemas)
      expect(() => migrateSchema(new SqliteSchemaAdapter(db), rejected, 10)).toThrow('MIGRATION_VERIFICATION_FAILED')
      expect(db.pragma('user_version', { simple: true })).toBe(9)
      expect(sqliteSchemaFingerprint(db)).toBe(before)
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chapter_character_state_cache_meta'").get()).toBeUndefined()
      expect(db.prepare('SELECT snapshot_hash FROM chapter_character_state_snapshots').pluck().get()).toBe('b'.repeat(64))
    } finally { db.close() }
  })
})
