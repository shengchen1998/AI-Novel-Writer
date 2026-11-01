import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type Database from 'better-sqlite3'
import {
  CHAPTER_CHARACTER_STATE_SNAPSHOT_SCHEMA_VERSION,
  type ChapterCharacterStateSnapshotCharacter,
  type ChapterCharacterStateSnapshotCharacterSummary,
  type ChapterCharacterStateSnapshotDetail,
  type ChapterCharacterStateSnapshotField,
  type ChapterCharacterStateSnapshotSummary,
} from '../../src/shared/chapter-character-state-snapshot'
import { CHARACTER_STATE_TEXT_FIELDS, type CharacterStateFieldProvenance } from '../../src/shared/character-roster'
import type {
  FinalizedCharacterContext,
  FinalizedCharacterStateUpdate,
  FinalizedSourceIdentity,
} from '../../src/shared/finalized-continuity'

interface SnapshotPayload {
  version: typeof CHAPTER_CHARACTER_STATE_SNAPSHOT_SCHEMA_VERSION
  operationId: string
  source: FinalizedSourceIdentity
  chapterTitle: string
  characters: ChapterCharacterStateSnapshotCharacter[]
}

interface SnapshotRow {
  snapshot_id: string
  operation_id: string
  finalization_id: string
  draft_id: number
  chapter_number: number
  chapter_title: string
  content_hash: string
  snapshot_hash: string
  created_at: string
}

interface CharacterRow {
  snapshot_id: string
  character_id: string
  display_name_snapshot: string
  aliases_json: string
  updated_at_chapter: number
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

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const operationIdFor = (source: FinalizedSourceIdentity) => `finalization:${source.finalizationId}`
const snapshotIdFor = (operationId: string) => `chapter-character-state:${sha256(operationId)}`

function sourceFromRow(row: SnapshotRow): FinalizedSourceIdentity {
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
  }
}

function summaryFromRows(row: SnapshotRow & CharacterRow): ChapterCharacterStateSnapshotSummary {
  return {
    snapshotId: row.snapshot_id,
    source: sourceFromRow(row),
    chapterTitle: row.chapter_title,
    snapshotHash: row.snapshot_hash,
    createdAt: row.created_at,
    character: characterSummary(row),
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

function readCharacter(db: Database.Database, snapshotId: string, characterId: string): ChapterCharacterStateSnapshotCharacter | null {
  const row = db.prepare('SELECT * FROM chapter_character_state_snapshot_characters WHERE snapshot_id=? AND character_id=?')
    .get(snapshotId, characterId) as CharacterRow | undefined
  return row ? { ...characterSummary(row), fields: readFields(db, snapshotId, characterId) } : null
}

function readPayload(db: Database.Database, snapshotId: string): { payload: SnapshotPayload; snapshotHash: string } | null {
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
  return {
    payload: {
      version: CHAPTER_CHARACTER_STATE_SNAPSHOT_SCHEMA_VERSION,
      operationId: header.operation_id,
      source: sourceFromRow(header),
      chapterTitle: header.chapter_title,
      characters,
    },
    snapshotHash: header.snapshot_hash,
  }
}

function initialFields(context: FinalizedCharacterContext, characterId: string): ChapterCharacterStateSnapshotField[] {
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

function buildInitialPayload(context: FinalizedCharacterContext, updates: FinalizedCharacterStateUpdate[], chapterTitle: string): SnapshotPayload {
  const operationId = operationIdFor(context.source)
  const characters = context.characters.map(character => ({
    characterId: character.characterId,
    displayNameSnapshot: character.displayNameSnapshot,
    aliases: [...character.aliases],
    updatedAtChapter: context.source.chapterNumber,
    fields: initialFields(context, character.characterId),
  }))
  for (const update of updates) applyUpdate(context, characters, update)
  return {
    version: CHAPTER_CHARACTER_STATE_SNAPSHOT_SCHEMA_VERSION,
    operationId,
    source: structuredClone(context.source),
    chapterTitle,
    characters,
  }
}

function hasEarlierFinalization(db: Database.Database, chapterNumber: number): boolean {
  return db.prepare(`SELECT 1 FROM drafts d JOIN finalization_outbox o ON o.draft_id=d.id
    WHERE d.status='finalized' AND d.chapter_number<? AND NOT EXISTS (
      SELECT 1 FROM drafts newer WHERE newer.chapter_number=d.chapter_number AND newer.status='finalized'
        AND (newer.version>d.version OR (newer.version=d.version AND newer.id>d.id))
    ) LIMIT 1`).get(chapterNumber) !== undefined
}

function insertPayload(db: Database.Database, payload: SnapshotPayload, snapshotId: string, snapshotHash: string): void {
  db.prepare(`INSERT INTO chapter_character_state_snapshots(
    snapshot_id,operation_id,finalization_id,draft_id,chapter_number,chapter_title,content_hash,schema_version,snapshot_hash
  ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
    snapshotId, payload.operationId, payload.source.finalizationId, payload.source.draftId,
    payload.source.chapterNumber, payload.chapterTitle, payload.source.contentHash, payload.version, snapshotHash,
  )
  const characterInsert = db.prepare(`INSERT INTO chapter_character_state_snapshot_characters(
    snapshot_id,character_id,display_name_snapshot,aliases_json,updated_at_chapter
  ) VALUES(?,?,?,?,?)`)
  const fieldInsert = db.prepare(`INSERT INTO chapter_character_state_snapshot_fields(
    snapshot_id,character_id,field,value,provenance_kind,known_at_chapter,provenance_json,evidence_json
  ) VALUES(?,?,?,?,?,?,?,?)`)
  for (const character of payload.characters) {
    characterInsert.run(snapshotId, character.characterId, character.displayNameSnapshot,
      JSON.stringify(character.aliases), character.updatedAtChapter)
    for (const field of character.fields) {
      fieldInsert.run(snapshotId, character.characterId, field.field, field.value, field.provenance.kind,
        field.knownAtChapter, JSON.stringify(field.provenance), field.evidence ? JSON.stringify(field.evidence) : null)
    }
  }
}

export class ChapterCharacterStateSnapshotRepository {
  static appendInitial(
    context: FinalizedCharacterContext,
    updates: FinalizedCharacterStateUpdate[],
    db: Database.Database,
  ): string | null {
    if (context.identityStatus !== 'bound') return null
    const source = db.prepare(`SELECT chapter_title AS chapterTitle,content_snapshot AS contentSnapshot,
      content_hash AS contentHash FROM finalization_outbox WHERE finalization_id=?`).get(context.source.finalizationId) as {
        chapterTitle: string; contentSnapshot: string; contentHash: string
      } | undefined
    if (!source || source.contentHash !== context.source.contentHash || sha256(source.contentSnapshot) !== context.source.contentHash
      || source.contentSnapshot !== context.content) throw new Error('CHAPTER_CHARACTER_STATE_SNAPSHOT_SOURCE_CHANGED')
    const operationId = operationIdFor(context.source)
    const snapshotId = snapshotIdFor(operationId)
    const existing = readPayload(db, snapshotId)
    if (existing) {
      if (existing.payload.operationId !== operationId || sha256(JSON.stringify(existing.payload)) !== existing.snapshotHash) {
        throw new Error('CHAPTER_CHARACTER_STATE_SNAPSHOT_INVALID')
      }
      return snapshotId
    }
    const payload = buildInitialPayload(context, updates, source.chapterTitle)
    const snapshotHash = sha256(JSON.stringify(payload))
    if (hasEarlierFinalization(db, context.source.chapterNumber)) return null
    insertPayload(db, payload, snapshotId, snapshotHash)
    const saved = readPayload(db, snapshotId)
    if (!saved || saved.snapshotHash !== snapshotHash || !isDeepStrictEqual(saved.payload, payload)
      || sha256(JSON.stringify(saved.payload)) !== snapshotHash) throw new Error('CHAPTER_CHARACTER_STATE_SNAPSHOT_READ_BACK_FAILED')
    return snapshotId
  }

  static listForCharacter(db: Database.Database, characterId: string): ChapterCharacterStateSnapshotSummary[] {
    const rows = db.prepare(`SELECT s.*,c.character_id,c.display_name_snapshot,c.aliases_json,c.updated_at_chapter
      FROM chapter_character_state_snapshots s
      JOIN chapter_character_state_snapshot_characters c ON c.snapshot_id=s.snapshot_id
      WHERE c.character_id=? ORDER BY s.chapter_number,s.created_at,s.snapshot_id`).all(characterId) as Array<SnapshotRow & CharacterRow>
    return rows.map(summaryFromRows)
  }

  static readForCharacter(db: Database.Database, snapshotId: string, characterId: string): ChapterCharacterStateSnapshotDetail | null {
    const row = db.prepare(`SELECT s.*,c.character_id,c.display_name_snapshot,c.aliases_json,c.updated_at_chapter
      FROM chapter_character_state_snapshots s
      JOIN chapter_character_state_snapshot_characters c ON c.snapshot_id=s.snapshot_id
      WHERE s.snapshot_id=? AND c.character_id=?`).get(snapshotId, characterId) as (SnapshotRow & CharacterRow) | undefined
    if (!row) return null
    const character = readCharacter(db, snapshotId, characterId)
    if (!character || character.fields.length !== CHARACTER_STATE_TEXT_FIELDS.length) {
      throw new Error('CHAPTER_CHARACTER_STATE_SNAPSHOT_INVALID')
    }
    return { ...summaryFromRows(row), character }
  }
}
