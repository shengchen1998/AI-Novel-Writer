import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { CHARACTER_STATE_TEXT_FIELDS, type CharacterStateFieldProvenance, type CharacterStateTextField } from '../../src/shared/character-roster'
import type { FinalizedCharacterContext, FinalizedSourceIdentity } from '../../src/shared/finalized-continuity'
import type { ChapterCharacterStateSnapshotBaseline, ChapterCharacterStateSnapshotCharacter, ChapterCharacterStateCacheStatus } from '../../src/shared/chapter-character-state-snapshot'
import { decideDerivedPatch, type CharacterFieldSnapshot, type DerivedSourceOrder } from '../../src/shared/character-identity'
import { ChapterCharacterStateSnapshotRepository } from '../repositories/chapter-character-state-snapshot-repository'
import { refreshCharacterStateProjection } from '../repositories/character-roster-repository'

const STATE_COLUMNS: Record<CharacterStateTextField, string> = {
  location: 'cs_location', powerLevel: 'cs_power_level', physicalState: 'cs_physical_state',
  mentalState: 'cs_mental_state', keyItems: 'cs_key_items', recentEvents: 'cs_recent_events',
}

type StoredProvenance = CharacterStateFieldProvenance & { revision?: number; sourceOrder?: DerivedSourceOrder }
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

function currentRevision(provenance: StoredProvenance | undefined): number {
  const revision = provenance?.revision ?? 0
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('FINALIZED_CHARACTER_FIELD_REVISION_INVALID')
  return revision
}

function cacheFieldsMatch(db: Database.Database, context: FinalizedCharacterContext, originProjectId?: string): boolean {
  for (const character of context.characters) {
    const row = db.prepare('SELECT * FROM characters WHERE character_id=? AND retired=0').get(character.characterId) as Record<string, unknown> | undefined
    if (!row) return false
    const provenance = JSON.parse(String(row.cs_provenance || '{}')) as Record<string, StoredProvenance>
    for (const captured of character.fields) {
      const stored = provenance[captured.field]
      const value = String(row[STATE_COLUMNS[captured.field]] ?? '')
      const revision = currentRevision(stored)
      if (revision !== captured.revision || sha256(value) !== captured.valueHash) return false
      const fieldProvenance: CharacterStateFieldProvenance = stored?.kind === 'derived'
        ? { kind: 'derived', source: structuredClone(stored.source) }
        : stored?.kind === 'author' ? { kind: 'author', chapterNumber: stored.chapterNumber } : { kind: 'legacy' }
      const actual: CharacterFieldSnapshot = { ...captured, revision, value, valueHash: sha256(value), provenance: fieldProvenance,
        ...(stored?.sourceOrder ? { sourceOrder: structuredClone(stored.sourceOrder) } : {}) }
      if (fieldProvenance.kind === 'derived' && !db.prepare('SELECT 1 FROM drafts WHERE id=? AND chapter_number=?')
        .get(fieldProvenance.source.draftId, fieldProvenance.source.chapterNumber)) continue
      const decision = decideDerivedPatch(actual, { ...captured, baseFieldRevision: captured.revision, baseValueHash: captured.valueHash,
        baseProvenance: captured.provenance, source: context.source, sourceOrder: context.sourceOrder },
        { source: context.source, order: context.sourceOrder, originProjectId })
      if (decision === 'source-conflict' || decision === 'field-conflict') return false
    }
  }
  return true
}

function derivedSourceOrder(db: Database.Database, context: FinalizedCharacterContext, source: FinalizedSourceIdentity) {
  const draft = db.prepare("SELECT version FROM drafts WHERE id=? AND chapter_number=? AND status='finalized'")
    .get(source.draftId, source.chapterNumber) as { version: number } | undefined
  if (!draft) throw new Error('FINALIZED_CHARACTER_SOURCE_CONFLICT')
  const projection = db.prepare(`SELECT projection_generation FROM summary_snapshots
    WHERE draft_id=? AND source_finalization_id=? AND source_content_hash=?`).pluck()
    .get(source.draftId, source.finalizationId, source.contentHash) as number | undefined
  return {
    continuityEpoch: `${context.projectId}:${projection ?? context.projectionGeneration}`,
    chapterNumber: source.chapterNumber,
    authoritativeFinalizationRevision: draft.version,
  }
}

function targetField(
  db: Database.Database,
  context: FinalizedCharacterContext,
  latest: { source: FinalizedSourceIdentity; characters: ChapterCharacterStateSnapshotCharacter[] },
  row: Record<string, unknown>,
  provenance: Record<string, StoredProvenance>,
  field: CharacterStateTextField,
) {
  const actual = provenance[field]
  const revision = currentRevision(actual)
  const value = String(row[STATE_COLUMNS[field]] ?? '')
  const snapshot = latest.characters.find(character => character.characterId === row.character_id)?.fields.find(item => item.field === field)
  const actualKind = actual?.kind ?? 'legacy'
  const authorCurrent = actualKind === 'author'
  const protectedLegacy = actualKind === 'legacy' && value !== '' && snapshot?.provenance.kind === 'derived'
  if (authorCurrent || protectedLegacy || !snapshot && actualKind !== 'derived') {
    return { value, provenance: actual ?? { kind: 'legacy' as const }, revision, changed: false, applied: false }
  }
  if (!snapshot) {
    const nextProvenance: StoredProvenance = { kind: 'legacy', revision: revision + 1 }
    return { value: '', provenance: nextProvenance, revision: nextProvenance.revision, changed: value !== '' || actual?.kind !== 'legacy', applied: false }
  }
  const nextProvenance: StoredProvenance = snapshot.provenance.kind === 'derived'
    ? { kind: 'derived', source: structuredClone(snapshot.provenance.source), revision: revision + 1,
      sourceOrder: derivedSourceOrder(db, context, snapshot.provenance.source) }
    : snapshot.provenance.kind === 'author'
      ? { kind: 'author', chapterNumber: snapshot.provenance.chapterNumber, revision: revision + 1 }
      : { kind: 'legacy', revision: revision + 1 }
  const sameSource = actualKind === snapshot.provenance.kind && (snapshot.provenance.kind !== 'derived'
    || actual?.kind === 'derived' && JSON.stringify(actual.source) === JSON.stringify(snapshot.provenance.source))
  const changed = value !== snapshot.value || !sameSource
  if (!changed) return { value, provenance: actual ?? nextProvenance, revision, changed: false, applied: false }
  nextProvenance.revision = revision + 1
  return { value: snapshot.value, provenance: nextProvenance, revision: revision + 1, changed: true, applied: snapshot.provenance.kind === 'derived' }
}

export function refreshChapterCharacterStateCache(
  db: Database.Database,
  context: FinalizedCharacterContext,
  baseline: ChapterCharacterStateSnapshotBaseline | undefined,
  snapshotId: string | null,
  originProjectId?: string,
): { applied: number; unchanged: number; cacheStatus: ChapterCharacterStateCacheStatus['status']; cacheConflict: boolean } {
  return db.transaction(() => {
    const existing = ChapterCharacterStateSnapshotRepository.readCacheStatus(db)
    if (existing.status === 'ready' && existing.snapshotId === snapshotId) {
      return { applied: 0, unchanged: 0, cacheStatus: existing.status, cacheConflict: false }
    }
    const latest = ChapterCharacterStateSnapshotRepository.readLatestValidSnapshot(db)
    if (!snapshotId || !latest || latest.snapshotId !== snapshotId) {
      const status = ChapterCharacterStateSnapshotRepository.readCacheStatus(db).status
      return { applied: 0, unchanged: 0, cacheStatus: status, cacheConflict: false }
    }
    const rosterRevision = db.prepare("SELECT revision FROM character_roster_meta WHERE id='main'").pluck().get() as number
    const fieldsMatch = cacheFieldsMatch(db, context, originProjectId)
    if (!baseline || !Number.isSafeInteger(baseline.cacheRevision) || rosterRevision !== baseline.cacheRevision || !fieldsMatch) {
      ChapterCharacterStateSnapshotRepository.markCacheRebuildRequired(db, snapshotId, 'cas-conflict')
      return { applied: 0, unchanged: 0, cacheStatus: 'rebuild-required' as const, cacheConflict: true }
    }
    const rows = db.prepare('SELECT * FROM characters WHERE retired=0 ORDER BY character_id').all() as Record<string, unknown>[]
    let applied = 0
    let changedCharacters = 0
    for (const row of rows) {
      const provenance = JSON.parse(String(row.cs_provenance || '{}')) as Record<string, StoredProvenance>
      const nextProvenance = { ...provenance }
      let changed = false
      for (const field of CHARACTER_STATE_TEXT_FIELDS) {
        const target = targetField(db, context, latest, row, provenance, field)
        if (!target.changed) continue
        db.prepare(`UPDATE characters SET ${STATE_COLUMNS[field]}=? WHERE character_id=? AND retired=0`).run(target.value, row.character_id)
        nextProvenance[field] = target.provenance
        changed = true
        if (target.applied) applied++
      }
      if (changed) {
        db.prepare(`UPDATE characters SET cs_provenance=?,cs_updated_at_chapter=MAX(COALESCE(cs_updated_at_chapter,0),?),updated_at=datetime('now')
          WHERE character_id=? AND retired=0`).run(JSON.stringify(nextProvenance), latest.source.chapterNumber, row.character_id)
        changedCharacters++
      }
    }
    if (changedCharacters) refreshCharacterStateProjection(db)
    const committedRevision = db.prepare("SELECT revision FROM character_roster_meta WHERE id='main'").pluck().get() as number
    ChapterCharacterStateSnapshotRepository.markCacheReady(db, latest, committedRevision)
    return { applied, unchanged: 0, cacheStatus: 'ready' as const, cacheConflict: false }
  }).immediate()
}
