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

export interface ChapterCharacterStateSnapshotSummary {
  snapshotId: string
  source: FinalizedSourceIdentity
  chapterTitle: string
  snapshotHash: string
  createdAt: string
  character: ChapterCharacterStateSnapshotCharacterSummary
}

export type ChapterCharacterStateSnapshotDetail = Omit<ChapterCharacterStateSnapshotSummary, 'character'> & {
  character: ChapterCharacterStateSnapshotCharacter
}
