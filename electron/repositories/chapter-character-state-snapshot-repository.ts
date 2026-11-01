import { isDeepStrictEqual } from 'node:util'
import type Database from 'better-sqlite3'
import type {
  ChapterCharacterStateSnapshotBaseline,
  ChapterCharacterStateCacheStatus,
  ChapterCharacterStateSnapshotCharacter,
  ChapterCharacterStateContinuityEntry,
  ChapterCharacterStateSnapshotDetail,
  ChapterCharacterStateSnapshotDiff,
  ChapterCharacterStateSnapshotPredecessor,
  ChapterCharacterStateSnapshotVersionSummary,
} from '../../src/shared/chapter-character-state-snapshot'
import { CHARACTER_STATE_TEXT_FIELDS } from '../../src/shared/character-roster'
import type {
  FinalizedCharacterContext,
  FinalizedCharacterStateOccurrence,
  FinalizedCharacterStateUpdate,
  FinalizedSourceIdentity,
} from '../../src/shared/finalized-continuity'
import * as cache from './chapter-character-state-cache-repository'
import * as continuity from './chapter-character-state-continuity'
import * as codec from './chapter-character-state-snapshot-codec'
import { compareCharacterStateSnapshots } from './chapter-character-state-snapshot-diff'

export class ChapterCharacterStateSnapshotRepository {
  static captureBaseline(context: FinalizedCharacterContext, db: Database.Database): ChapterCharacterStateSnapshotBaseline | null {
    return continuity.captureBaseline(context, db)
  }

  static appendInitial(
    context: FinalizedCharacterContext,
    updates: FinalizedCharacterStateUpdate[],
    db: Database.Database,
    unresolved: FinalizedCharacterStateOccurrence[],
    frozenBaseline?: ChapterCharacterStateSnapshotBaseline,
    operationId = codec.operationIdFor(context.source),
  ): string | null {
    if (context.identityStatus !== 'bound') return null
    const source = db.prepare(`SELECT chapter_title AS chapterTitle,content_snapshot AS contentSnapshot,
      content_hash AS contentHash FROM finalization_outbox WHERE finalization_id=?`).get(context.source.finalizationId) as {
        chapterTitle: string; contentSnapshot: string; contentHash: string
      } | undefined
    if (!source || source.contentHash !== context.source.contentHash || codec.sha256(source.contentSnapshot) !== context.source.contentHash
      || source.contentSnapshot !== context.content) throw new Error('CHAPTER_CHARACTER_STATE_SNAPSHOT_SOURCE_CHANGED')
    const snapshotId = codec.snapshotIdFor(operationId)
    const existing = codec.readPayload(db, snapshotId)
    if (existing) {
      if (existing.payload.operationId !== operationId || codec.sha256(JSON.stringify(existing.payload)) !== existing.snapshotHash) {
        throw new Error('CHAPTER_CHARACTER_STATE_SNAPSHOT_INVALID')
      }
      return snapshotId
    }
    const baseline = frozenBaseline ?? continuity.captureBaseline(context, db)
    if (!baseline) return null
    const payload = codec.buildPayload(context, updates, source.chapterTitle, baseline, unresolved, operationId)
    const snapshotHash = codec.sha256(JSON.stringify(payload))
    codec.insertPayload(db, payload, snapshotId, snapshotHash)
    const saved = codec.readPayload(db, snapshotId)
    if (!saved || saved.snapshotHash !== snapshotHash || !isDeepStrictEqual(saved.payload, payload)
      || codec.sha256(JSON.stringify(saved.payload)) !== snapshotHash) throw new Error('CHAPTER_CHARACTER_STATE_SNAPSHOT_READ_BACK_FAILED')
    return snapshotId
  }

  static readForOperation(db: Database.Database, operationId: string): {
    snapshotId: string
    inputHash: string | null
    predecessor: ChapterCharacterStateSnapshotPredecessor | null
  } | null {
    const row = db.prepare('SELECT * FROM chapter_character_state_snapshots WHERE operation_id=?').get(operationId) as codec.SnapshotRow | undefined
    if (!row) return null
    const saved = codec.readPayload(db, row.snapshot_id)
    if (!saved || saved.payload.operationId !== operationId || codec.sha256(JSON.stringify(saved.payload)) !== row.snapshot_hash) {
      throw new Error('CHAPTER_CHARACTER_STATE_SNAPSHOT_INVALID')
    }
    return { snapshotId: row.snapshot_id, inputHash: row.input_hash, predecessor: codec.baselineFromRow(db, row).predecessor }
  }

  static listForCharacter(db: Database.Database, characterId: string): ChapterCharacterStateSnapshotVersionSummary[] {
    const rows = db.prepare(`SELECT s.*,c.character_id,c.display_name_snapshot,c.aliases_json,c.updated_at_chapter,c.involved,c.changed_fields_json
      FROM chapter_character_state_snapshots s
      JOIN chapter_character_state_snapshot_characters c ON c.snapshot_id=s.snapshot_id
      WHERE c.character_id=? ORDER BY s.chapter_number,s.created_at,s.snapshot_id`).all(characterId) as Array<codec.SnapshotRow & codec.CharacterRow>
    const validityBySnapshot = continuity.readValidityBySnapshot(db)
    return rows.map(row => codec.versionSummaryFromRows(db, row, validityBySnapshot))
  }

  static readForCharacter(db: Database.Database, snapshotId: string, characterId: string): ChapterCharacterStateSnapshotDetail | null {
    const row = db.prepare(`SELECT s.*,c.character_id,c.display_name_snapshot,c.aliases_json,c.updated_at_chapter,c.involved,c.changed_fields_json
      FROM chapter_character_state_snapshots s
      JOIN chapter_character_state_snapshot_characters c ON c.snapshot_id=s.snapshot_id
      WHERE s.snapshot_id=? AND c.character_id=?`).get(snapshotId, characterId) as (codec.SnapshotRow & codec.CharacterRow) | undefined
    if (!row) return null
    const character = codec.readCharacter(db, snapshotId, characterId)
    const saved = codec.readPayload(db, snapshotId)
    if (!character || character.fields.length !== CHARACTER_STATE_TEXT_FIELDS.length || !saved) {
      throw new Error('CHAPTER_CHARACTER_STATE_SNAPSHOT_INVALID')
    }
    return {
      ...codec.versionSummaryFromRows(db, row, continuity.readValidityBySnapshot(db)),
      character,
      unresolved: saved.payload.unresolved ?? [],
    }
  }

  static compareForCharacter(
    db: Database.Database,
    beforeSnapshotId: string,
    afterSnapshotId: string,
    characterId: string,
  ): ChapterCharacterStateSnapshotDiff | null {
    const before = this.readForCharacter(db, beforeSnapshotId, characterId)
    const after = this.readForCharacter(db, afterSnapshotId, characterId)
    return before && after ? compareCharacterStateSnapshots(before, after) : null
  }

  static readContinuity(db: Database.Database): ChapterCharacterStateContinuityEntry[] {
    return continuity.readContinuity(db)
  }

  static readLatestValidSnapshot(db: Database.Database): {
    snapshotId: string
    snapshotHash: string
    source: FinalizedSourceIdentity
    characters: ChapterCharacterStateSnapshotCharacter[]
  } | null {
    return continuity.readLatestValidSnapshot(db)
  }

  static readCacheStatus(db: Database.Database): ChapterCharacterStateCacheStatus {
    return cache.readCacheStatus(db)
  }

  static markCacheRebuildRequired(db: Database.Database, snapshotId: string | null, reason: 'cas-conflict' | 'continuity-incomplete'): void {
    cache.markCacheRebuildRequired(db, snapshotId, reason)
  }

  static markCacheReady(db: Database.Database, snapshot: { snapshotId: string; snapshotHash: string; source: FinalizedSourceIdentity }, rosterRevision: number): void {
    cache.markCacheReady(db, snapshot, rosterRevision)
  }
}
