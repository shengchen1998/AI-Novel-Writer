import type Database from 'better-sqlite3'
import { isDeepStrictEqual } from 'node:util'
import type { MainGenerationRunHandle } from '../../src/services/generation/generation-runtime'
import type { FinalizedCharacterArtifact, FinalizedCharacterGenerationReceipt } from '../../src/shared/finalized-character-generation'
import {
  CHAPTER_CHARACTER_STATE_REBUILD_OPERATION,
  type ChapterCharacterStateRebuildChapter,
  type ChapterCharacterStateRebuildManifest,
  type ChapterCharacterStateRebuildPlan,
  type ChapterCharacterStateRebuildStatus,
} from '../../src/shared/chapter-character-state-rebuild'
import type { GenerationTask } from '../../src/services/generation/generation-harness'
import { GenerationRunRepository, textHash, type DurableGenerationRun } from '../repositories/generation-run-repository'
import { ChapterCharacterStateSnapshotRepository } from '../repositories/chapter-character-state-snapshot-repository'
import { SummaryRepository } from '../repositories/summary-repository'
import { proveFinalizedCharacterGeneration } from './finalized-character-generation-proof'
import type { CharacterProposalService } from './character-proposal-service'

const REBUILD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export function chapterCharacterStateRebuildOperationId(rebuildId: string, finalizationId: string): string {
  return `rebuild:${rebuildId}:${finalizationId}`
}

export class ChapterCharacterStateRebuild {
  constructor(private readonly db: Database.Database, private readonly runs: GenerationRunRepository,
    private readonly projectId: string, private readonly characters: CharacterProposalService,
    private readonly transferOrigin: () => string | undefined = () => undefined) {}

  readPlan(endChapter?: number): ChapterCharacterStateRebuildPlan | null {
    if (endChapter !== undefined && (!Number.isSafeInteger(endChapter) || endChapter < 1)) {
      throw new Error('GENERATION_CHARACTER_STATE_REBUILD_RANGE_INVALID')
    }
    const continuity = ChapterCharacterStateSnapshotRepository.readContinuity(this.db)
    const first = continuity.findIndex(entry => entry.status !== 'valid')
    const cacheNeedsRepair = ChapterCharacterStateSnapshotRepository.readCacheStatus(this.db).status !== 'ready'
    const start = first >= 0 ? first : cacheNeedsRepair ? continuity.length - 1 : -1
    if (start < 0) return null
    const latest = continuity.at(-1)!.source.chapterNumber
    const target = endChapter ?? latest
    const end = continuity.findIndex(entry => entry.source.chapterNumber === target)
    if (end < start || end >= continuity.length) throw new Error('GENERATION_CHARACTER_STATE_REBUILD_RANGE_INVALID')
    const chapters = continuity.slice(start, end + 1).map(entry => ({ source: structuredClone(entry.source), chapterTitle: entry.chapterTitle }))
    return { range: { startChapter: chapters[0]!.source.chapterNumber, endChapter: chapters.at(-1)!.source.chapterNumber }, chapters }
  }

  findRoot(rebuildId: string): string | null {
    if (!REBUILD_ID.test(rebuildId)) throw new Error('GENERATION_CHARACTER_STATE_REBUILD_ID_INVALID')
    const rows = this.db.prepare(`SELECT DISTINCT root_action_id FROM generation_runs
      WHERE json_extract(binding_json,'$.sourceManifest.operation')=?
      AND json_extract(binding_json,'$.sourceManifest.characterStateRebuild.rebuildId')=?`).all(
      CHAPTER_CHARACTER_STATE_REBUILD_OPERATION, rebuildId,
    ) as Array<{ root_action_id: string }>
    if (rows.length > 1) throw new Error('GENERATION_CHARACTER_STATE_REBUILD_CONFLICT')
    return rows[0]?.root_action_id ?? null
  }

  private rootRuns(rootActionId: string): DurableGenerationRun[] {
    return (this.db.prepare('SELECT run_id FROM generation_runs WHERE root_action_id=? ORDER BY rowid').all(rootActionId) as Array<{ run_id: string }>)
      .map(row => this.runs.get(row.run_id))
  }

  readContext(run: DurableGenerationRun): ChapterCharacterStateRebuildManifest {
    const manifest = run.binding.sourceManifest
    const context = manifest.characterStateRebuild as ChapterCharacterStateRebuildManifest | undefined
    const task = manifest.characterStateRebuildTask as GenerationTask | undefined
    if (manifest.operation !== CHAPTER_CHARACTER_STATE_REBUILD_OPERATION || !context || context.version !== 1
      || !REBUILD_ID.test(context.rebuildId) || manifest.characterStateRebuildHash !== textHash(JSON.stringify(context))
      || !task || manifest.characterStateRebuildTaskHash !== textHash(JSON.stringify(task))
      || context.extraction.slot.stepKey !== 'character_cards'
      || !isDeepStrictEqual(context.extraction.slot.source, context.extraction.identity.source)
      || context.plan.chapters.length === 0
      || !context.plan.chapters.some(chapter => isDeepStrictEqual(chapter.source, context.extraction.slot.source))) {
      throw new Error('GENERATION_CHARACTER_STATE_REBUILD_CONTEXT_INVALID')
    }
    return structuredClone(context)
  }

  readPlanForRoot(rootActionId: string): { rebuildId: string; modelId: string; plan: ChapterCharacterStateRebuildPlan } {
    const first = this.rootRuns(rootActionId)[0]
    if (!first) throw new Error('GENERATION_CHARACTER_STATE_REBUILD_NOT_FOUND')
    const context = this.readContext(first)
    const modelId = (first.binding.sourceManifest.modelReceipt as { modelId?: string } | undefined)?.modelId
    if (!modelId) throw new Error('GENERATION_CHARACTER_STATE_REBUILD_CONTEXT_INVALID')
    return { rebuildId: context.rebuildId, modelId, plan: structuredClone(context.plan) }
  }

  findChapterRun(rootActionId: string, finalizationId: string): DurableGenerationRun | undefined {
    const matches = this.rootRuns(rootActionId).filter(run => this.readContext(run).extraction.slot.source.finalizationId === finalizationId)
    if (matches.length > 1) throw new Error('GENERATION_CHARACTER_STATE_REBUILD_CONFLICT')
    return matches[0]
  }

  require(handle: MainGenerationRunHandle): DurableGenerationRun {
    if (!handle || Object.keys(handle).some(key => !['projectId', 'epoch', 'rootActionId', 'runId'].includes(key))) {
      throw new Error('GENERATION_RUN_IDENTITY_MISMATCH')
    }
    const run = this.runs.get(handle.runId)
    this.readContext(run)
    if (handle.projectId !== this.projectId || run.binding.projectId !== this.projectId
      || handle.rootActionId !== run.rootActionId || handle.epoch !== run.binding.epoch) {
      throw new Error('GENERATION_RUN_IDENTITY_MISMATCH')
    }
    return run
  }

  task(run: DurableGenerationRun): GenerationTask {
    this.readContext(run)
    return structuredClone(run.binding.sourceManifest.characterStateRebuildTask as GenerationTask)
  }

  snapshotFor(rebuildId: string, finalizationId: string) {
    return ChapterCharacterStateSnapshotRepository.readForOperation(this.db, chapterCharacterStateRebuildOperationId(rebuildId, finalizationId))
  }

  snapshotForRun(run: DurableGenerationRun) {
    const context = this.readContext(run)
    return this.snapshotFor(context.rebuildId, context.extraction.slot.source.finalizationId)
  }

  private sourceCurrent(plan: ChapterCharacterStateRebuildPlan): boolean {
    const continuity = ChapterCharacterStateSnapshotRepository.readContinuity(this.db)
    return plan.chapters.every(chapter => continuity.some(entry => isDeepStrictEqual(entry.source, chapter.source)))
  }

  readStatus(rebuildId: string): ChapterCharacterStateRebuildStatus {
    const rootActionId = this.findRoot(rebuildId)
    if (!rootActionId) throw new Error('GENERATION_CHARACTER_STATE_REBUILD_NOT_FOUND')
    const { modelId, plan } = this.readPlanForRoot(rootActionId)
    const budget = this.runs.budget(rootActionId)
    const inFlight = budget.attempts.some(attempt => ['reserved', 'dispatch-marked'].includes(attempt.status))
    const sourceStatus = this.sourceCurrent(plan) ? 'current' : 'conflict'
    let failureCode: string | undefined
    const chapters: ChapterCharacterStateRebuildChapter[] = plan.chapters.map(chapter => {
      const snapshot = this.snapshotFor(rebuildId, chapter.source.finalizationId)
      if (snapshot) return { ...structuredClone(chapter), status: 'completed', ...snapshot }
      const run = this.findChapterRun(rootActionId, chapter.source.finalizationId)
      const attemptRow = run && this.db.prepare('SELECT attempt_id FROM generation_attempts WHERE run_id=? ORDER BY rowid DESC LIMIT 1')
        .pluck().get(run.runId) as string | undefined
      const receipt = attemptRow ? this.runs.receipt(attemptRow) : undefined
      const failed = !!receipt && (!!receipt.failureCode || !!receipt.unsavedTail
        || receipt.result?.finishReason !== undefined && receipt.result.finishReason !== 'stop'
        || receipt.result?.finishReason === 'stop' && !!receipt.artifact)
      if (failed && !failureCode) failureCode = receipt?.failureCode ?? 'GENERATION_CHARACTER_STATE_REBUILD_INCOMPLETE'
      const status = budget.root.status === 'cancelled' ? 'cancelled'
        : failed ? 'failed' : inFlight && run ? 'running' : 'pending'
      return { ...structuredClone(chapter), status, snapshotId: null, inputHash: null, predecessor: null }
    })
    const completedChapters = chapters.filter(chapter => chapter.status === 'completed').length
    const next = chapters.find(chapter => chapter.status !== 'completed')
    const status = completedChapters === chapters.length ? 'completed'
      : budget.root.status === 'cancelled' ? 'cancelled'
        : sourceStatus === 'conflict' || chapters.some(chapter => chapter.status === 'failed') ? 'failed'
          : inFlight ? 'running' : 'ready'
    return {
      rebuildId, modelId, range: structuredClone(plan.range), status, sourceStatus, completedChapters,
      nextChapterNumber: next?.source.chapterNumber ?? null,
      canResume: status !== 'completed' && status !== 'cancelled' && !inFlight && sourceStatus === 'current',
      chapters, cache: ChapterCharacterStateSnapshotRepository.readCacheStatus(this.db),
      ...(failureCode ? { failureCode } : {}),
    }
  }

  listStatuses(): ChapterCharacterStateRebuildStatus[] {
    const rows = this.db.prepare(`SELECT binding_json FROM generation_runs
      WHERE json_extract(binding_json,'$.sourceManifest.operation')=? ORDER BY rowid`).all(CHAPTER_CHARACTER_STATE_REBUILD_OPERATION) as Array<{ binding_json: string }>
    const ids = new Set<string>()
    for (const row of rows) {
      const manifest = JSON.parse(row.binding_json).sourceManifest.characterStateRebuild as { rebuildId?: string } | undefined
      if (manifest?.rebuildId) ids.add(manifest.rebuildId)
    }
    return [...ids].reverse().slice(0, 20).map(id => this.readStatus(id))
  }

  commit(handle: MainGenerationRunHandle, reference: FinalizedCharacterArtifact,
    assertSources: (run: DurableGenerationRun) => void): FinalizedCharacterGenerationReceipt & { snapshotId: string | null } {
    const run = this.require(handle)
    const context = this.readContext(run)
    const existing = this.snapshotForRun(run)
    if (existing) return { applied: 0, unchanged: 0, candidates: [], unresolved: [], snapshotId: existing.snapshotId }
    assertSources(run)
    const proof = proveFinalizedCharacterGeneration(this.db, this.runs, this.projectId, handle, reference)
    const operationId = chapterCharacterStateRebuildOperationId(context.rebuildId, context.extraction.slot.source.finalizationId)
    const receipt = SummaryRepository.commitFinalizedCharacterStates(proof.context, proof.response, this.db, this.transferOrigin(),
      context.extraction.characterStateBaseline, operationId, true)
    const snapshotId = this.snapshotForRun(run)?.snapshotId ?? null
    const batch = proof.response.unresolved.some(item => item.displayName.trim())
      ? this.characters.stage({ kind: 'finalized-generation', handle: proof.currentHandle, artifact: reference }) : undefined
    return { ...receipt, snapshotId, unresolved: structuredClone(proof.response.unresolved), ...(batch ? { proposalBatchId: batch.proposalBatchId } : {}) }
  }
}
