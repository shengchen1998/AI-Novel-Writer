import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  CHAPTER_CHARACTER_STATE_SNAPSHOT_SCHEMA_VERSION,
  type ChapterCharacterStateSnapshotBaseline,
  type ChapterCharacterStateSnapshotCharacter,
  type ChapterCharacterStateSnapshotCharacterSummary,
  type ChapterCharacterStateSnapshotField,
  type ChapterCharacterStateSnapshotSummary,
  type ChapterCharacterStateSnapshotValidity,
  type ChapterCharacterStateSnapshotVersionSummary,
} from '../../src/shared/chapter-character-state-snapshot'
import { CHARACTER_STATE_TEXT_FIELDS, type CharacterStateFieldProvenance } from '../../src/shared/character-roster'
import type {
  FinalizedCharacterContext,
  FinalizedCharacterStateOccurrence,
  FinalizedCharacterStateUpdate,
  FinalizedSourceIdentity,
} from '../../src/shared/finalized-continuity'

export interface SnapshotPayload {
  version: typeof CHAPTER_CHARACTER_STATE_SNAPSHOT_SCHEMA_VERSION
  operationId: string
  source: FinalizedSourceIdentity
  chapterTitle: string
  characters: ChapterCharacterStateSnapshotCharacter[]
  unresolved?: FinalizedCharacterStateOccurrence[]
  baseline?: ChapterCharacterStateSnapshotSummary['baseline']
  inputHash?: string
  continuityGeneration?: number
}

export interface SnapshotRow {
  snapshot_id: string
  operation_id: string
  finalization_id: string
  draft_id: number
  chapter_number: number
  chapter_title: string
  content_hash: string
  snapshot_hash: string
  unresolved_json: string
  created_at: string
  predecessor_snapshot_id: string | null
  predecessor_hash: string | null
  input_hash: string | null
  continuity_generation: number | null
}

export interface CharacterRow {
  snapshot_id: string
  character_id: string
  display_name_snapshot: string
  aliases_json: string
  updated_at_chapter: number
  involved: number
  changed_fields_json: string
}

interface FieldRow {
  snapshot_id: string
  character_id: string
  field: ChapterCharacterStateSnapshotField['field']
  value: string
  known_at_chapter: number | null
  provenance_json: string
  evidence_json: string | null
}

export const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
export const operationIdFor = (source: FinalizedSourceIdentity) => `finalization:${source.finalizationId}`
export const snapshotIdFor = (operationId: string) => `chapter-character-state:${sha256(operationId)}`

export function sourceFromRow(row: SnapshotRow): FinalizedSourceIdentity {
  return {
    draftId: row.draft_id,
    finalizationId: row.finalization_id,
    chapterNumber: row.chapter_number,
    contentHash: row.content_hash,
  }
}

function characterSummary(row: CharacterRow): ChapterCharacterStateSnapshotCharacterSummary {
  return {
    characterId: row.character_id,
    displayNameSnapshot: row.display_name_snapshot,
    aliases: JSON.parse(row.aliases_json) as string[],
    updatedAtChapter: row.updated_at_chapter,
    involved: row.involved === 1,
    changedFields: JSON.parse(row.changed_fields_json) as ChapterCharacterStateSnapshotField['field'][],
  }
}

export function readSnapshotRow(db: Database.Database, snapshotId: string): SnapshotRow | undefined {
  return db.prepare('SELECT * FROM chapter_character_state_snapshots WHERE snapshot_id=?').get(snapshotId) as SnapshotRow | undefined
}

export function baselineFromRow(db: Database.Database, row: SnapshotRow): ChapterCharacterStateSnapshotSummary['baseline'] {
  const predecessorRow = row.predecessor_snapshot_id ? readSnapshotRow(db, row.predecessor_snapshot_id) : undefined
  if (predecessorRow && predecessorRow.snapshot_hash !== row.predecessor_hash) {
    throw new Error('CHAPTER_CHARACTER_STATE_SNAPSHOT_PREDECESSOR_INVALID')
  }
  return {
    kind: row.predecessor_snapshot_id ? 'snapshot' : 'roster',
    predecessor: predecessorRow ? {
      snapshotId: predecessorRow.snapshot_id,
      snapshotHash: predecessorRow.snapshot_hash,
      source: sourceFromRow(predecessorRow),
    } : null,
  }
}

export function summaryFromRows(db: Database.Database, row: SnapshotRow & CharacterRow, status: 'valid' | 'invalid'): ChapterCharacterStateSnapshotSummary {
  return {
    snapshotId: row.snapshot_id,
    status,
    source: sourceFromRow(row),
    chapterTitle: row.chapter_title,
    snapshotHash: row.snapshot_hash,
    createdAt: row.created_at,
    baseline: baselineFromRow(db, row),
    inputHash: row.input_hash,
    continuityGeneration: row.continuity_generation,
    character: characterSummary(row),
  }
}

export function versionSummaryFromRows(
  db: Database.Database,
  row: SnapshotRow & CharacterRow,
  validityBySnapshot: Map<string, ChapterCharacterStateSnapshotValidity>,
): ChapterCharacterStateSnapshotVersionSummary {
  const validity = validityBySnapshot.get(row.snapshot_id) ?? 'superseded'
  return {
    ...summaryFromRows(db, row, validity === 'valid' ? 'valid' : 'invalid'),
    validity,
  }
}

function readFields(db: Database.Database, snapshotId: string, characterId?: string): ChapterCharacterStateSnapshotField[] {
  const rows = (characterId === undefined
    ? db.prepare('SELECT * FROM chapter_character_state_snapshot_fields WHERE snapshot_id=? ORDER BY character_id,field').all(snapshotId)
    : db.prepare('SELECT * FROM chapter_character_state_snapshot_fields WHERE snapshot_id=? AND character_id=? ORDER BY field').all(snapshotId, characterId)) as FieldRow[]
  return rows.map(row => ({
    field: row.field,
    value: row.value,
    provenance: JSON.parse(row.provenance_json) as CharacterStateFieldProvenance,
    knownAtChapter: row.known_at_chapter,
    ...(row.evidence_json ? { evidence: JSON.parse(row.evidence_json) as NonNullable<ChapterCharacterStateSnapshotField['evidence']> } : {}),
  }))
}

export function readCharacter(db: Database.Database, snapshotId: string, characterId: string): ChapterCharacterStateSnapshotCharacter | null {
  const row = db.prepare('SELECT * FROM chapter_character_state_snapshot_characters WHERE snapshot_id=? AND character_id=?')
    .get(snapshotId, characterId) as CharacterRow | undefined
  return row ? { ...characterSummary(row), fields: readFields(db, snapshotId, characterId) } : null
}

function readUnresolved(row: SnapshotRow): FinalizedCharacterStateOccurrence[] {
  try {
    const unresolved = JSON.parse(row.unresolved_json) as unknown
    if (!Array.isArray(unresolved)) throw new Error('CHAPTER_CHARACTER_STATE_SNAPSHOT_INVALID')
    return unresolved as FinalizedCharacterStateOccurrence[]
  } catch {
    throw new Error('CHAPTER_CHARACTER_STATE_SNAPSHOT_INVALID')
  }
}

export function readPayload(db: Database.Database, snapshotId: string): { payload: SnapshotPayload; snapshotHash: string } | null {
  const header = db.prepare('SELECT * FROM chapter_character_state_snapshots WHERE snapshot_id=?').get(snapshotId) as SnapshotRow | undefined
  if (!header) return null
  const rows = db.prepare('SELECT * FROM chapter_character_state_snapshot_characters WHERE snapshot_id=? ORDER BY character_id')
    .all(snapshotId) as CharacterRow[]
  const characters = rows.map(row => ({
    ...characterSummary(row),
    fields: CHARACTER_STATE_TEXT_FIELDS.map(field => {
      const stored = readFields(db, snapshotId, row.character_id).find(candidate => candidate.field === field)
      if (!stored) throw new Error('CHAPTER_CHARACTER_STATE_SNAPSHOT_INVALID')
      return stored
    }),
  }))
  const unresolved = readUnresolved(header)
  const continuity = header.input_hash === null || header.continuity_generation === null ? {} : {
    baseline: baselineFromRow(db, header),
    inputHash: header.input_hash,
    continuityGeneration: header.continuity_generation,
  }
  return {
    payload: {
      version: CHAPTER_CHARACTER_STATE_SNAPSHOT_SCHEMA_VERSION,
      operationId: header.operation_id,
      source: sourceFromRow(header),
      chapterTitle: header.chapter_title,
      characters,
      ...(unresolved ? { unresolved } : {}),
      ...continuity,
    },
    snapshotHash: header.snapshot_hash,
  }
}

export function initialFields(context: FinalizedCharacterContext, characterId: string): ChapterCharacterStateSnapshotField[] {
  const character = context.characters.find(item => item.characterId === characterId)
  if (!character) throw new Error('CHAPTER_CHARACTER_STATE_SNAPSHOT_IDENTITY_INVALID')
  return CHARACTER_STATE_TEXT_FIELDS.map(field => {
    const captured = character.fields.find(item => item.field === field)
    if (!captured) throw new Error('CHAPTER_CHARACTER_STATE_SNAPSHOT_FIELD_MISSING')
    if (captured.provenance.kind === 'author' && captured.provenance.chapterNumber <= context.source.chapterNumber) {
      return {
        field,
        value: captured.value,
        provenance: { kind: 'author', chapterNumber: captured.provenance.chapterNumber },
        knownAtChapter: captured.provenance.chapterNumber,
      }
    }
    if (captured.provenance.kind === 'legacy') {
      return { field, value: captured.value, provenance: { kind: 'legacy' }, knownAtChapter: null }
    }
    return { field, value: '', provenance: { kind: 'legacy' }, knownAtChapter: null }
  })
}

function applyUpdate(
  context: FinalizedCharacterContext,
  characters: ChapterCharacterStateSnapshotCharacter[],
  update: FinalizedCharacterStateUpdate,
): void {
  const character = characters.find(item => item.characterId === update.characterId)
  if (!character) throw new Error('CHAPTER_CHARACTER_STATE_SNAPSHOT_IDENTITY_INVALID')
  const evidence = update.evidence
  if (!Number.isSafeInteger(evidence.start) || !Number.isSafeInteger(evidence.end)
    || evidence.start < 0 || evidence.end <= evidence.start || evidence.end > context.content.length
    || context.content.slice(evidence.start, evidence.end) !== evidence.text) {
    throw new Error('CHAPTER_CHARACTER_STATE_SNAPSHOT_EVIDENCE_INVALID')
  }
  for (const field of CHARACTER_STATE_TEXT_FIELDS) {
    if (!Object.hasOwn(update.currentState, field)) continue
    const current = character.fields.find(item => item.field === field)!
    const value = update.currentState[field]!
    if (current.value === value) continue
    if (current.provenance.kind === 'author' || current.provenance.kind === 'legacy' && current.value !== '') continue
    Object.assign(current, {
      value,
      provenance: { kind: 'derived', source: structuredClone(context.source) },
      knownAtChapter: context.source.chapterNumber,
      evidence: structuredClone(evidence),
    })
  }
}

export function buildPayload(context: FinalizedCharacterContext, updates: FinalizedCharacterStateUpdate[], chapterTitle: string,
  baseline: ChapterCharacterStateSnapshotBaseline, unresolved: FinalizedCharacterStateOccurrence[],
  operationId = operationIdFor(context.source)): SnapshotPayload {
  const characters = structuredClone(baseline.characters)
  for (const update of updates) {
    const before = characters.find(item => item.characterId === update.characterId)?.fields.map(field => field.value)
    applyUpdate(context, characters, update)
    const character = characters.find(item => item.characterId === update.characterId)!
    const changedFields = new Set(character.changedFields)
    for (const [index, field] of character.fields.entries()) {
      if (before?.[index] !== field.value) changedFields.add(field.field)
    }
    character.involved = true
    character.changedFields = CHARACTER_STATE_TEXT_FIELDS.filter(field => changedFields.has(field))
    character.updatedAtChapter = context.source.chapterNumber
  }
  return {
    version: CHAPTER_CHARACTER_STATE_SNAPSHOT_SCHEMA_VERSION,
    operationId,
    source: structuredClone(context.source),
    chapterTitle,
    characters,
    unresolved: structuredClone(unresolved),
    baseline: { kind: baseline.kind, predecessor: structuredClone(baseline.predecessor) },
    inputHash: baseline.inputHash,
    continuityGeneration: baseline.continuityGeneration,
  }
}

export function insertPayload(db: Database.Database, payload: SnapshotPayload, snapshotId: string, snapshotHash: string): void {
  if (!payload.baseline || !payload.inputHash || payload.continuityGeneration === undefined) {
    throw new Error('CHAPTER_CHARACTER_STATE_SNAPSHOT_CONTINUITY_REQUIRED')
  }
  db.prepare(`INSERT INTO chapter_character_state_snapshots(
    snapshot_id,operation_id,finalization_id,draft_id,chapter_number,chapter_title,content_hash,schema_version,snapshot_hash,
    unresolved_json,predecessor_snapshot_id,predecessor_hash,input_hash,continuity_generation
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    snapshotId, payload.operationId, payload.source.finalizationId, payload.source.draftId,
    payload.source.chapterNumber, payload.chapterTitle, payload.source.contentHash, payload.version, snapshotHash,
    JSON.stringify(payload.unresolved ?? []), payload.baseline.predecessor?.snapshotId ?? null,
    payload.baseline.predecessor?.snapshotHash ?? null, payload.inputHash, payload.continuityGeneration,
  )
  const characterInsert = db.prepare(`INSERT INTO chapter_character_state_snapshot_characters(
    snapshot_id,character_id,display_name_snapshot,aliases_json,updated_at_chapter,involved,changed_fields_json
  ) VALUES(?,?,?,?,?,?,?)`)
  const fieldInsert = db.prepare(`INSERT INTO chapter_character_state_snapshot_fields(
    snapshot_id,character_id,field,value,provenance_kind,known_at_chapter,provenance_json,evidence_json
  ) VALUES(?,?,?,?,?,?,?,?)`)
  for (const character of payload.characters) {
    characterInsert.run(snapshotId, character.characterId, character.displayNameSnapshot,
      JSON.stringify(character.aliases), character.updatedAtChapter, character.involved ? 1 : 0, JSON.stringify(character.changedFields))
    for (const field of character.fields) {
      fieldInsert.run(snapshotId, character.characterId, field.field, field.value, field.provenance.kind,
        field.knownAtChapter, JSON.stringify(field.provenance), field.evidence ? JSON.stringify(field.evidence) : null)
    }
  }
}
