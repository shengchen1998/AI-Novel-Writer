import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { MainGenerationRunHandle } from '../../src/services/generation/generation-runtime'
import type { BeginGenerationRequest } from '../../src/shared/generation-owner-contract'
import type { FinalizedCharacterContext } from '../../src/shared/finalized-continuity'
import type { FinalizedCharacterStateDecisionRequest } from '../../src/shared/finalized-continuity'
import type { FinalizedCharacterGenerationCommit, FinalizedCharacterGenerationReceipt } from '../../src/shared/finalized-character-generation'
import { SummaryRepository } from '../repositories/summary-repository'
import { GenerationRunRepository, textHash } from '../repositories/generation-run-repository'
import type { CharacterProposalService } from './character-proposal-service'
import { proveFinalizedCharacterGeneration } from './finalized-character-generation-proof'
import { ChapterCharacterStateSnapshotRepository } from '../repositories/chapter-character-state-snapshot-repository'

export class FinalizedCharacterGeneration {
  private readonly contexts = new Map<string, {
    context: FinalizedCharacterContext
    characterStateBaseline: ReturnType<typeof ChapterCharacterStateSnapshotRepository.captureBaseline>
  }>()
  constructor(private readonly db: Database.Database, private readonly runs: GenerationRunRepository,
    private readonly scope: { projectId: string; epoch: string }, private readonly assertCurrent: () => void,
    private readonly transferOrigin: () => string | undefined = () => undefined) {}

  readContext(draftId: number) {
    this.assertCurrent()
    if (!Number.isSafeInteger(draftId) || draftId < 1) throw new Error('GENERATION_CHARACTER_DRAFT_INVALID')
    const context = SummaryRepository.readFinalizedCharacterContext(draftId, this.scope, this.db)
    const characterStateBaseline = ChapterCharacterStateSnapshotRepository.captureBaseline(context, this.db)
    const contextId = randomUUID()
    if (this.contexts.size >= 64) this.contexts.delete(this.contexts.keys().next().value!)
    this.contexts.set(contextId, structuredClone({ context, characterStateBaseline }))
    return { contextId, context: structuredClone(context), characterStateBaseline: structuredClone(characterStateBaseline),
      originProjectId: this.transferOrigin() }
  }

  listPendingStateCandidates() {
    this.assertCurrent()
    return SummaryRepository.listPendingFinalizedCharacterStateCandidates(this.db)
  }

  readPendingStateCandidate(request: { draftId: number; candidateKey: string }) {
    this.assertCurrent()
    return SummaryRepository.readPendingFinalizedCharacterStateCandidate(request.draftId, request.candidateKey, this.db)
  }

  decideStateCandidate(request: FinalizedCharacterStateDecisionRequest) {
    this.assertCurrent()
    return SummaryRepository.decideFinalizedCharacterStateCandidate(request, this.db)
  }

  listStateSnapshots(characterId: string) {
    this.assertCurrent()
    if (!characterId.trim()) throw new Error('FINALIZED_CHARACTER_IDENTITY_REQUIRED')
    return ChapterCharacterStateSnapshotRepository.listForCharacter(this.db, characterId)
  }

  readStateSnapshot(snapshotId: string, characterId: string) {
    this.assertCurrent()
    if (!snapshotId.trim() || !characterId.trim()) throw new Error('FINALIZED_CHARACTER_SNAPSHOT_INVALID')
    return ChapterCharacterStateSnapshotRepository.readForCharacter(this.db, snapshotId, characterId)
  }

  compareStateSnapshots(beforeSnapshotId: string, afterSnapshotId: string, characterId: string) {
    this.assertCurrent()
    if (!beforeSnapshotId.trim() || !afterSnapshotId.trim() || !characterId.trim()) {
      throw new Error('FINALIZED_CHARACTER_SNAPSHOT_INVALID')
    }
    return ChapterCharacterStateSnapshotRepository.compareForCharacter(this.db, beforeSnapshotId, afterSnapshotId, characterId)
  }

  readStateContinuity() {
    this.assertCurrent()
    return ChapterCharacterStateSnapshotRepository.readContinuity(this.db)
  }

  readStateCache() {
    this.assertCurrent()
    return ChapterCharacterStateSnapshotRepository.readCacheStatus(this.db)
  }

  /** A renderer cannot manufacture the identity/field snapshot placed in a generation manifest. */
  admit(selection: BeginGenerationRequest): string | undefined {
    this.assertCurrent()
    if (selection.operation !== 'finalized-character-state') {
      if (selection.finalizedCharacterContextId) throw new Error('GENERATION_CHARACTER_CONTEXT_INVALID')
      return undefined
    }
    const context = selection.finalizedCharacterContextId && this.contexts.get(selection.finalizedCharacterContextId)?.context
    if (!context || selection.output !== 'structured-data' || selection.chapterNumber !== context.source.chapterNumber
      || !isDeepStrictEqual(selection.selectedDraftIds, [])
      || !isDeepStrictEqual(selection.selectedFinalizedDraftIds, [context.source.draftId])
      || selection.authorInputs?.find(input => input.id === 'finalized-character-context')?.text !== JSON.stringify(context))
      throw new Error('GENERATION_CHARACTER_CONTEXT_REQUIRED')
    if (!isDeepStrictEqual(context, SummaryRepository.readFinalizedCharacterContext(context.source.draftId, this.scope, this.db)))
      throw new Error('GENERATION_CHARACTER_CONTEXT_CHANGED')
    return textHash(JSON.stringify(context))
  }

  commit(request: FinalizedCharacterGenerationCommit, characters: CharacterProposalService,
    assertSources: (handle: MainGenerationRunHandle) => void): FinalizedCharacterGenerationReceipt {
    this.assertCurrent()
    if (!request || Object.keys(request).some(key => !['contextId', 'handle', 'artifact'].includes(key)))
      throw new Error('GENERATION_CHARACTER_COMMIT_INVALID')
    if (this.runs.get(request.handle.runId).binding.sourceManifest.finalizationGenerationContext) throw new Error('GENERATION_FINALIZATION_ADMISSION_REQUIRED')
    const prepared = this.contexts.get(request.contextId)
    if (!prepared || request.handle.projectId !== this.scope.projectId || request.handle.epoch !== this.scope.epoch)
      throw new Error('GENERATION_CHARACTER_CONTEXT_REQUIRED')
    assertSources(request.handle)
    const proof = proveFinalizedCharacterGeneration(this.db, this.runs, this.scope.projectId, request.handle, request.artifact)
    if (!isDeepStrictEqual(proof.context, prepared.context)) throw new Error('GENERATION_CHARACTER_CONTEXT_MISMATCH')
    const receipt = SummaryRepository.commitFinalizedCharacterStates(prepared.context, proof.response, this.db, this.transferOrigin(),
      prepared.characterStateBaseline ?? undefined)
    // Nameless occurrences remain visible in the durable artifact; never invent a name for adoption.
    const batch = proof.response.unresolved.some(item => item.displayName.trim())
      ? characters.stage({ kind: 'finalized-generation', handle: request.handle, artifact: request.artifact }) : undefined
    return { ...receipt, unresolved: structuredClone(proof.response.unresolved), ...(batch ? { proposalBatchId: batch.proposalBatchId } : {}) }
  }

  close(): void { this.contexts.clear() }
}
