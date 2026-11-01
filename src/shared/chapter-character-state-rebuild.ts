import type { FinalizedSourceIdentity } from './finalized-continuity'
import type { FinalizationGenerationContext } from './finalization-generation'
import type { ChapterCharacterStateCacheStatus, ChapterCharacterStateSnapshotPredecessor } from './chapter-character-state-snapshot'

export const CHAPTER_CHARACTER_STATE_REBUILD_OPERATION = 'chapter-character-state-rebuild' as const

export interface ChapterCharacterStateRebuildPlan {
  range: { startChapter: number; endChapter: number }
  chapters: Array<{ source: FinalizedSourceIdentity; chapterTitle: string }>
}

export interface ChapterCharacterStateRebuildManifest {
  version: 1
  rebuildId: string
  plan: ChapterCharacterStateRebuildPlan
  extraction: FinalizationGenerationContext
}

export type ChapterCharacterStateRebuildChapterStatus = 'pending' | 'running' | 'failed' | 'cancelled' | 'completed'

export interface ChapterCharacterStateRebuildChapter {
  source: FinalizedSourceIdentity
  chapterTitle: string
  status: ChapterCharacterStateRebuildChapterStatus
  snapshotId: string | null
  inputHash: string | null
  predecessor: ChapterCharacterStateSnapshotPredecessor | null
}

export interface ChapterCharacterStateRebuildStatus {
  rebuildId: string
  modelId: string
  range: ChapterCharacterStateRebuildPlan['range']
  status: 'ready' | 'running' | 'failed' | 'cancelled' | 'completed'
  sourceStatus: 'current' | 'conflict'
  completedChapters: number
  nextChapterNumber: number | null
  canResume: boolean
  chapters: ChapterCharacterStateRebuildChapter[]
  cache: ChapterCharacterStateCacheStatus
  failureCode?: string
}
