import type Database from 'better-sqlite3'
import type {
  ChapterCharacterStateSnapshotBaseline,
  ChapterCharacterStateSnapshotCharacter,
  ChapterCharacterStateContinuityEntry,
  ChapterCharacterStateSnapshotValidity,
} from '../../src/shared/chapter-character-state-snapshot'
import type { FinalizedCharacterContext, FinalizedSourceIdentity } from '../../src/shared/finalized-continuity'
import {
  baselineFromRow,
  initialFields,
  readPayload,
  readSnapshotRow,
  sha256,
  sourceFromRow,
  type SnapshotRow,
} from './chapter-character-state-snapshot-codec'

export function readContinuity(db: Database.Database): ChapterCharacterStateContinuityEntry[] {
  const sources = db.prepare(`SELECT d.id AS draft_id,d.chapter_number,o.finalization_id,o.content_hash,o.chapter_title
    FROM drafts d JOIN finalization_outbox o ON o.draft_id=d.id
    WHERE d.status='finalized' AND NOT EXISTS (
      SELECT 1 FROM drafts newer WHERE newer.chapter_number=d.chapter_number AND newer.status='finalized'
        AND (newer.version>d.version OR (newer.version=d.version AND newer.id>d.id))
    ) ORDER BY d.chapter_number`).all() as Array<Pick<SnapshotRow, 'draft_id' | 'chapter_number' | 'finalization_id' | 'content_hash' | 'chapter_title'>>
  const meta = db.prepare("SELECT generation,stale_from_chapter AS staleFromChapter FROM continuity_projection_meta WHERE id='main'")
    .get() as { generation: number; staleFromChapter: number | null }
  let chainValid = true
  let previousValid: SnapshotRow | undefined
  let gapChapterNumber: number | undefined
  const rebuildAuthority = new Map<string, number>()
  return sources.map((source, index) => {
    const rows = db.prepare('SELECT * FROM chapter_character_state_snapshots WHERE finalization_id=? ORDER BY rowid')
      .all(source.finalization_id) as SnapshotRow[]
    const rebuilds = rows.flatMap(row => {
      const rebuildId = /^rebuild:([0-9a-f-]{36}):/iu.exec(row.operation_id)?.[1]
      if (!rebuildId) return []
      let ordinal = rebuildAuthority.get(rebuildId)
      if (ordinal === undefined) {
        ordinal = (db.prepare(`SELECT rowid FROM generation_runs
          WHERE json_extract(binding_json,'$.sourceManifest.characterStateRebuild.rebuildId')=? ORDER BY rowid LIMIT 1`)
          .pluck().get(rebuildId) as number | undefined) ?? -1
        rebuildAuthority.set(rebuildId, ordinal)
      }
      return [{ rebuildId, ordinal }]
    })
    const preferred = rebuilds.sort((left, right) => right.ordinal - left.ordinal)[0]
    const row = preferred
      ? rows.find(candidate => candidate.operation_id === `rebuild:${preferred.rebuildId}:${source.finalization_id}`)
      : rows[0]
    let snapshot: ChapterCharacterStateContinuityEntry['snapshot']
    let valid = false
    if (row) {
      const generationCurrent = Number.isSafeInteger(row.continuity_generation) && row.continuity_generation! >= 0
        && row.continuity_generation! <= meta.generation && (row.continuity_generation === meta.generation
          || meta.staleFromChapter === null || row.chapter_number < meta.staleFromChapter)
      const predecessorMatches = chainValid && (previousValid
        ? row.predecessor_snapshot_id === previousValid.snapshot_id && row.predecessor_hash === previousValid.snapshot_hash
        : index === 0 && row.predecessor_snapshot_id === null && row.predecessor_hash === null)
      valid = /^[a-f0-9]{64}$/.test(row.snapshot_hash) && generationCurrent
        && /^[a-f0-9]{64}$/.test(row.input_hash ?? '') && predecessorMatches
      snapshot = {
        snapshotId: row.snapshot_id,
        status: valid ? 'valid' : 'invalid',
        source: sourceFromRow(row),
        chapterTitle: row.chapter_title,
        snapshotHash: row.snapshot_hash,
        baseline: baselineFromRow(db, row),
        inputHash: row.input_hash,
        continuityGeneration: row.continuity_generation,
      }
    }
    const waiting = !valid && !chainValid
    const status = valid ? 'valid' : waiting ? 'waiting-predecessor' : row ? 'invalid-snapshot' : 'missing-snapshot'
    const invalidatedByChange = !valid && meta.staleFromChapter !== null && source.chapter_number >= meta.staleFromChapter
    if (!valid && chainValid) gapChapterNumber = source.chapter_number
    chainValid = valid
    previousValid = valid ? row : undefined
    return {
      source: sourceFromRow(source as SnapshotRow),
      chapterTitle: source.chapter_title,
      status,
      ...(snapshot ? { snapshot } : {}),
      ...(waiting ? { predecessorGapChapterNumber: gapChapterNumber } : {}),
      ...(invalidatedByChange ? { invalidatedByChange: true } : {}),
    }
  })
}

export function readValidityBySnapshot(db: Database.Database): Map<string, ChapterCharacterStateSnapshotValidity> {
  const validity = new Map<string, ChapterCharacterStateSnapshotValidity>()
  for (const entry of readContinuity(db)) {
    if (entry.snapshot) validity.set(entry.snapshot.snapshotId,
      entry.status === 'valid' ? 'valid' : entry.status === 'waiting-predecessor' ? 'waiting-predecessor' : 'invalid')
  }
  return validity
}

export function captureBaseline(context: FinalizedCharacterContext, db: Database.Database): ChapterCharacterStateSnapshotBaseline | null {
  const previousFinalization = db.prepare(`SELECT o.finalization_id FROM drafts d JOIN finalization_outbox o ON o.draft_id=d.id
    WHERE d.status='finalized' AND d.chapter_number<? AND NOT EXISTS (
      SELECT 1 FROM drafts newer WHERE newer.chapter_number=d.chapter_number AND newer.status='finalized'
        AND (newer.version>d.version OR (newer.version=d.version AND newer.id>d.id))
    ) ORDER BY d.chapter_number DESC LIMIT 1`).pluck().get(context.source.chapterNumber) as string | undefined
  const previousEntry = previousFinalization
    ? readContinuity(db).find(entry => entry.source.finalizationId === previousFinalization)
    : undefined
  const previousRow = previousEntry?.status === 'valid' && previousEntry.snapshot
    ? readSnapshotRow(db, previousEntry.snapshot.snapshotId)
    : undefined
  if (previousFinalization && !previousRow) return null
  const previous = previousRow ? readPayload(db, previousRow.snapshot_id) : null
  if (previousRow && (!previous || sha256(JSON.stringify(previous.payload)) !== previous.snapshotHash)) {
    throw new Error('CHAPTER_CHARACTER_STATE_SNAPSHOT_PREDECESSOR_INVALID')
  }
  const predecessor = previousRow && previous ? {
    snapshotId: previousRow.snapshot_id,
    snapshotHash: previousRow.snapshot_hash,
    source: sourceFromRow(previousRow),
  } : null
  const characters = context.characters.map(character => {
    const inherited = previous?.payload.characters.find(item => item.characterId === character.characterId)
    const fields = inherited ? structuredClone(inherited.fields) : initialFields(context, character.characterId)
    for (const captured of character.fields) {
      if (captured.provenance.kind !== 'author' || captured.provenance.chapterNumber > context.source.chapterNumber) continue
      const index = fields.findIndex(field => field.field === captured.field)
      if (index < 0) throw new Error('CHAPTER_CHARACTER_STATE_SNAPSHOT_FIELD_MISSING')
      fields[index] = {
        field: captured.field,
        value: captured.value,
        provenance: { kind: 'author', chapterNumber: captured.provenance.chapterNumber },
        knownAtChapter: captured.provenance.chapterNumber,
      }
    }
    return {
      characterId: character.characterId,
      displayNameSnapshot: character.displayNameSnapshot,
      aliases: [...character.aliases],
      updatedAtChapter: inherited?.updatedAtChapter ?? 0,
      involved: false,
      changedFields: [],
      fields,
    }
  })
  const continuityGeneration = context.projectionGeneration
  const inputHash = sha256(JSON.stringify({ version: 1, source: context.source, continuityGeneration, predecessor, characters }))
  const cacheRevision = db.prepare("SELECT revision FROM character_roster_meta WHERE id='main'").pluck().get() as number
  return { kind: predecessor ? 'snapshot' : 'roster', predecessor, characters, inputHash, continuityGeneration, cacheRevision }
}

export function readLatestValidSnapshot(db: Database.Database): {
  snapshotId: string
  snapshotHash: string
  source: FinalizedSourceIdentity
  characters: ChapterCharacterStateSnapshotCharacter[]
} | null {
  const entries = readContinuity(db)
  const latest = entries.at(-1)
  if (!latest || entries.some(entry => entry.status !== 'valid') || !latest.snapshot) return null
  const row = readSnapshotRow(db, latest.snapshot.snapshotId)
  const saved = row ? readPayload(db, row.snapshot_id) : null
  if (!row || !saved || sha256(JSON.stringify(saved.payload)) !== row.snapshot_hash) return null
  return { snapshotId: row.snapshot_id, snapshotHash: row.snapshot_hash, source: sourceFromRow(row), characters: saved.payload.characters }
}
