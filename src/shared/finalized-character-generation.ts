import type { MainGenerationRunHandle } from '../services/generation/generation-runtime'
import type { FinalizedCharacterContext, FinalizedCharacterStateCommitReceipt, FinalizedCharacterStateDecisionReceipt,
  FinalizedCharacterStateDecisionRequest, FinalizedCharacterStateOccurrence, PendingFinalizedCharacterStateCandidate,
  PendingFinalizedCharacterStateCandidateSummary } from './finalized-continuity'

export interface FinalizedCharacterArtifact {
  artifactId: string
  revision: number
  textHash: string
}
export interface FinalizedCharacterGenerationCommit {
  contextId: string
  handle: MainGenerationRunHandle
  artifact: FinalizedCharacterArtifact
}
export interface FinalizedCharacterGenerationReceipt extends FinalizedCharacterStateCommitReceipt {
  unresolved: FinalizedCharacterStateOccurrence[]
  proposalBatchId?: string
}
export interface FinalizedCharacterGenerationChannels {
  'finalized-character:read-context': {
    args: [{ draftId: number }]
    return: {
      contextId: string
      context: FinalizedCharacterContext
      characterStateBaseline: import('./chapter-character-state-snapshot').ChapterCharacterStateSnapshotBaseline | null
      originProjectId?: string
    }
  }
  'finalized-character:commit': { args: [FinalizedCharacterGenerationCommit]; return: FinalizedCharacterGenerationReceipt }
  'finalized-character:list-state-candidates': { args: []; return: PendingFinalizedCharacterStateCandidateSummary[] }
  'finalized-character:read-state-candidate': { args: [{ draftId: number; candidateKey: string }]; return: PendingFinalizedCharacterStateCandidate }
  'finalized-character:decide-state-candidate': { args: [FinalizedCharacterStateDecisionRequest]; return: FinalizedCharacterStateDecisionReceipt }
  'finalized-character:list-state-snapshots': {
    args: [{ characterId: string }]
    return: import('./chapter-character-state-snapshot').ChapterCharacterStateSnapshotSummary[]
  }
  'finalized-character:read-state-snapshot': {
    args: [{ snapshotId: string; characterId: string }]
    return: import('./chapter-character-state-snapshot').ChapterCharacterStateSnapshotDetail | null
  }
  'finalized-character:read-state-continuity': {
    args: []
    return: import('./chapter-character-state-snapshot').ChapterCharacterStateContinuityEntry[]
  }
  'finalized-character:read-state-cache': {
    args: []
    return: import('./chapter-character-state-snapshot').ChapterCharacterStateCacheStatus
  }
}
