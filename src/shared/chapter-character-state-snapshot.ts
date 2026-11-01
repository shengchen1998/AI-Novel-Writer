import type { CharacterStateFieldProvenance, CharacterStateTextField } from './character-roster'
import type { FinalizedCharacterEvidence, FinalizedSourceIdentity } from './finalized-continuity'

export const CHAPTER_CHARACTER_STATE_SNAPSHOT_SCHEMA_VERSION = 1 as const

export interface ChapterCharacterStateSnapshotField {
  field: CharacterStateTextField
  value: string
  provenance: CharacterStateFieldProvenance
  knownAtChapter: number | null
  evidence?: FinalizedCharacterEvidence
}

export interface ChapterCharacterStateSnapshotCharacterSummary {
  characterId: string
  displayNameSnapshot: string
  aliases: string[]
  updatedAtChapter: number
}

export interface ChapterCharacterStateSnapshotCharacter extends ChapterCharacterStateSnapshotCharacterSummary {
  fields: ChapterCharacterStateSnapshotField[]
}

export interface ChapterCharacterStateSnapshotPredecessor {
  snapshotId: string
  snapshotHash: string
  source: FinalizedSourceIdentity
}

export interface ChapterCharacterStateSnapshotBaseline {
  kind: 'roster' | 'snapshot'
  predecessor: ChapterCharacterStateSnapshotPredecessor | null
  characters: ChapterCharacterStateSnapshotCharacter[]
  inputHash: string
  continuityGeneration: number
  cacheRevision: number
}

export interface ChapterCharacterStateCacheStatus {
  status: 'ready' | 'rebuild-required' | 'invalid'
  reason: 'cas-conflict' | 'continuity-incomplete' | 'not-established' | null
  snapshotId: string | null
  source: FinalizedSourceIdentity | null
}

export function chapterCharacterStatePromptCards(baseline: ChapterCharacterStateSnapshotBaseline) {
  return baseline.characters.map(character => ({
    characterId: character.characterId,
    name: character.displayNameSnapshot,
    aliases: character.aliases,
    fields: character.fields.map(field => ({ field: field.field, value: field.value, provenance: field.provenance })),
  }))
}

export interface ChapterCharacterStateSnapshotSummary {
  snapshotId: string
  status: 'valid' | 'invalid'
  source: FinalizedSourceIdentity
  chapterTitle: string
  snapshotHash: string
  createdAt: string
  baseline: Omit<ChapterCharacterStateSnapshotBaseline, 'characters' | 'inputHash' | 'continuityGeneration' | 'cacheRevision'>
  inputHash: string | null
  continuityGeneration: number | null
  character: ChapterCharacterStateSnapshotCharacterSummary
}

export type ChapterCharacterStateSnapshotValidity = 'valid' | 'superseded' | 'invalid' | 'waiting-predecessor'

export interface ChapterCharacterStateSnapshotVersionSummary extends ChapterCharacterStateSnapshotSummary {
  validity: ChapterCharacterStateSnapshotValidity
}

export type ChapterCharacterStateSnapshotDetail = Omit<ChapterCharacterStateSnapshotVersionSummary, 'character'> & {
  character: ChapterCharacterStateSnapshotCharacter
}

export type ChapterCharacterStateSnapshotFieldChange = 'added' | 'changed' | 'cleared' | 'unchanged'

export interface ChapterCharacterStateSnapshotDiffSide {
  snapshotId: string
  source: FinalizedSourceIdentity
  chapterTitle: string
  validity: ChapterCharacterStateSnapshotValidity
  character: ChapterCharacterStateSnapshotCharacterSummary
}

export interface ChapterCharacterStateSnapshotFieldDiff {
  field: CharacterStateTextField
  change: ChapterCharacterStateSnapshotFieldChange
  before: ChapterCharacterStateSnapshotField
  after: ChapterCharacterStateSnapshotField
}

export interface ChapterCharacterStateSnapshotDiff {
  before: ChapterCharacterStateSnapshotDiffSide
  after: ChapterCharacterStateSnapshotDiffSide
  fields: ChapterCharacterStateSnapshotFieldDiff[]
}

export interface ChapterCharacterStateContinuityEntry {
  source: FinalizedSourceIdentity
  chapterTitle: string
  status: 'valid' | 'missing-snapshot' | 'invalid-snapshot' | 'waiting-predecessor'
  snapshot?: Omit<ChapterCharacterStateSnapshotSummary, 'character' | 'createdAt'>
  predecessorGapChapterNumber?: number
}
