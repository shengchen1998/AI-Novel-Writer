import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { ModelProfile, ProjectSessionContext } from '../../../src/shared/ipc-channels'
import { parseCanonicalProjectManifest } from '../../../src/shared/project-format'
import { parseFinalizedCharacterStateResponse } from '../../../src/shared/finalized-continuity'
import type {
  ChapterCharacterStateContinuityEntry,
  ChapterCharacterStateSnapshotDetail,
  ChapterCharacterStateSnapshotDiff,
  ChapterCharacterStateSnapshotVersionSummary,
} from '../../../src/shared/chapter-character-state-snapshot'
import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { ChapterCharacterStateSnapshotRepository } from '../../repositories/chapter-character-state-snapshot-repository'
import { ChapterDeletionRepository } from '../../repositories/chapter-deletion-repository'
import { freezeFinalizedCharacterSnapshot, SummaryRepository } from '../../repositories/summary-repository'
import { ModelExecutionLeaseRegistry } from '../../services/model-execution-lease'
import { projectAccess } from '../../services/project-access'
import { readPortableRuntimeFreeze } from '../../services/portable-runtime-freeze'
import { parsePortableTransferAuthority } from '../../services/portable-transfer-authority'
import { adoptTransferredCharacterContinuityOnOpen } from '../../services/transferred-character-continuity'
import { restorePortableProject } from '../../services/project-restore-service'
import { WebDavBackupService } from '../../services/webdav-backup-service'
import { createProjectArchiveRoundtripFixture, type ProjectArchiveRoundtripFixture } from '../../../test/desktop/project-archive.fixture'
import { DavFixture } from '../../../test/helpers/webdav-fixture'
import { registerDatabaseController } from '../db-controller'
import { registerFinalizationController } from '../finalization-controller'
import { registerGenerationController } from '../generation-controller'

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), globalRoot: '' }))
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler) } }))
vi.mock('../../services/app-data-locator', () => ({ getGlobalDataRoot: () => mocks.globalRoot }))
vi.mock('../kb-controller', () => ({ getEmbeddingConfig: () => null }))

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const model: ModelProfile = {
  id: 'fixture', name: '合成模型', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1',
  baseUrl: 'https://api.openai.com/v1', apiKey: 'synthetic-only', maxTokens: 1024, temperature: 0.7, purposes: ['generation'],
}
const sender = { isDestroyed: () => false, send: vi.fn() }
let session: ProjectSessionContext
let fixture: ProjectArchiveRoundtripFixture | undefined

beforeAll(() => {
  registerGenerationController({
    modelExecutionLeases: new ModelExecutionLeaseRegistry({ loadModel: () => model }),
    loadModel: () => model,
    applyProxyConfig: () => {},
  })
  registerDatabaseController()
  registerFinalizationController()
})

afterEach(() => {
  closeProjectDatabase()
  projectAccess.invalidateCurrentSession()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  fixture?.dispose()
  fixture = undefined
})

async function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`missing IPC: ${channel}`)
  return await handler({ sender }, ...args, { ...session }) as T
}

function openProject(root: string): void {
  closeProjectDatabase()
  projectAccess.invalidateCurrentSession()
  const project = projectAccess.probeExistingProject(root)
  if (project.kind !== 'manifest') throw new Error('Expected a manifest project')
  initProjectDatabase(project.rootPath)
  adoptTransferredCharacterContinuityOnOpen({ database: getProjectDb()!, projectRoot: project.rootPath, projectId: project.projectId })
  const lease = projectAccess.beginSession(project)
  session = { projectId: project.projectId, projectPath: project.rootPath, leaseId: lease.leaseId }
}

async function createSnapshotFixture(): Promise<{ deletedSnapshotId: string }> {
  fixture = await createProjectArchiveRoundtripFixture()
  mocks.globalRoot = fixture.globalDataRoot
  const chapter21Body = '第21章定稿：林澈核对北门储物柜，随后本章被作者明确删除。'
  const database = new Database(fixture.sourceDatabasePath)
  try {
    database.pragma('foreign_keys = ON')
    database.transaction(() => {
      database.prepare("UPDATE continuity_projection_meta SET generation=1,stale_from_chapter=NULL WHERE id='main'").run()
      database.prepare('INSERT INTO contents(id,body) VALUES(21,?)').run(chapter21Body)
      database.prepare(`INSERT INTO drafts(
        id,chapter_number,version,status,source,content_id,word_count,source_dependencies
      ) VALUES(21,21,1,'finalized','write',21,?,'[]')`).run(Buffer.from(chapter21Body).length)
      database.prepare(`INSERT INTO finalization_outbox(
        finalization_id,draft_id,chapter_number,chapter_title,content_hash,content_revision,
        content_snapshot,target_file_name,publication_status,last_error
      ) VALUES('finalization-21',21,21,'第21章',?,1,?,'chapter-21.md','pending','')`).run(sha256(chapter21Body), chapter21Body)
      freezeFinalizedCharacterSnapshot(database, {
        draftId: 21,
        finalizationId: 'finalization-21',
        chapterNumber: 21,
        contentHash: sha256(chapter21Body),
      })
    })()
  } finally {
    database.close()
  }

  initProjectDatabase(fixture.sourceRoot)
  const db = getProjectDb()!
  for (let chapter = 1; chapter <= 21; chapter += 1) {
    const context = SummaryRepository.readFinalizedCharacterContext(chapter, {
      projectId: fixture.sourceProjectId,
      epoch: 'fixture-source-epoch',
    }, db)
    const updates = chapter === 20 ? [{
      characterId: fixture.characterId,
      currentState: { physicalState: fixture.chapter20Injury, keyItems: fixture.chapter20Clue },
      evidence: { start: 0, end: fixture.chapter20Body.length, text: fixture.chapter20Body },
    }] : []
    const response = parseFinalizedCharacterStateResponse(JSON.stringify({ updates }), context)
    SummaryRepository.commitFinalizedCharacterStates(context, response, db)
  }
  const deletedSnapshotId = ChapterCharacterStateSnapshotRepository.readForOperation(db, 'finalization:finalization-21')!.snapshotId
  ChapterDeletionRepository.begin({ operationId: 'delete-chapter-21-before-backup', draftId: 21, chapterNumber: 21 })
  ChapterDeletionRepository.markProjection('delete-chapter-21-before-backup', 'manuscript', 'completed')
  ChapterDeletionRepository.settle('delete-chapter-21-before-backup')
  closeProjectDatabase()
  return { deletedSnapshotId }
}

async function listSnapshots(): Promise<ChapterCharacterStateSnapshotVersionSummary[]> {
  return await invoke('finalized-character:list-state-snapshots', { characterId: fixture!.characterId })
}

describe('chapter character-state backup recovery', () => {
  it('preserves public history, field provenance, diffs and deletion boundaries in a direct restored copy without replay', async () => {
    const { deletedSnapshotId } = await createSnapshotFixture()
    openProject(fixture!.sourceRoot)
    const sourceSummaries = await listSnapshots()
    expect(sourceSummaries).toHaveLength(20)
    expect(sourceSummaries.every(snapshot => snapshot.validity === 'valid')).toBe(true)
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    await fixture!.exportArchive()
    await fixture!.restoreArchive()
    openProject(fixture!.targetRoot)

    const manifest = parseCanonicalProjectManifest(JSON.parse(fs.readFileSync(
      path.join(fixture!.targetStorage, 'project.json'), 'utf8',
    )))
    expect(manifest.projectId).toBe(fixture!.targetProjectId)
    expect(manifest.projectId).not.toBe(fixture!.sourceProjectId)
    const authority = parsePortableTransferAuthority(JSON.parse(fs.readFileSync(fixture!.transferAuthorityPath, 'utf8')))
    expect(authority).toMatchObject({ originProjectId: fixture!.sourceProjectId, targetProjectId: fixture!.targetProjectId })
    expect(fetch).not.toHaveBeenCalled()

    const restored = await listSnapshots()
    expect(restored).toEqual(sourceSummaries)
    const chapter19 = restored.find(snapshot => snapshot.source.chapterNumber === 19)!
    const chapter20 = restored.find(snapshot => snapshot.source.chapterNumber === 20)!
    expect(chapter20).toMatchObject({
      source: { finalizationId: fixture!.chapter20FinalizationId, contentHash: sha256(fixture!.chapter20Body) },
      baseline: { predecessor: { snapshotId: chapter19.snapshotId, snapshotHash: chapter19.snapshotHash } },
      continuityGeneration: 1,
    })
    const detail = await invoke<ChapterCharacterStateSnapshotDetail>('finalized-character:read-state-snapshot', {
      snapshotId: chapter20.snapshotId,
      characterId: fixture!.characterId,
    })
    expect(detail.character.fields).toHaveLength(6)
    expect(detail.character.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: 'physicalState', value: fixture!.chapter20Injury, knownAtChapter: 20,
        provenance: { kind: 'derived', source: expect.objectContaining({ finalizationId: fixture!.chapter20FinalizationId }) },
        evidence: { start: 0, end: fixture!.chapter20Body.length, text: fixture!.chapter20Body },
      }),
      expect.objectContaining({ field: 'location', value: fixture!.authorCharacterState, provenance: { kind: 'author', chapterNumber: 1 } }),
      expect.objectContaining({ field: 'mentalState', value: fixture!.legacyCharacterState, provenance: { kind: 'legacy' } }),
    ]))
    const diff = await invoke<ChapterCharacterStateSnapshotDiff>('finalized-character:compare-state-snapshots', {
      beforeSnapshotId: chapter19.snapshotId,
      afterSnapshotId: chapter20.snapshotId,
      characterId: fixture!.characterId,
    })
    expect(diff.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'physicalState', change: 'added', after: expect.objectContaining({ value: fixture!.chapter20Injury }) }),
      expect.objectContaining({ field: 'keyItems', change: 'added', after: expect.objectContaining({ value: fixture!.chapter20Clue }) }),
    ]))
    await expect(invoke('finalized-character:read-state-snapshot', {
      snapshotId: deletedSnapshotId,
      characterId: fixture!.characterId,
    })).resolves.toBeNull()
    const continuity = await invoke<ChapterCharacterStateContinuityEntry[]>('finalized-character:read-state-continuity')
    expect(continuity).toHaveLength(20)
    expect(continuity.every(entry => entry.status === 'valid')).toBe(true)
    await expect(invoke('finalized-character:read-state-cache')).resolves.toMatchObject({
      status: 'invalid', reason: 'continuity-incomplete',
    })
    await expect(invoke('finalized-character:list-state-rebuilds')).resolves.toEqual([])

    const guard = readPortableRuntimeFreeze(fixture!.targetRoot)
    expect(guard.isFrozen('generation_runs', 'run-old')).toBe(true)
    expect(guard.isFrozen('generation_attempts', 'attempt-unknown')).toBe(true)
    expect(guard.isFrozen('finalization_outbox', 'outbox-old')).toBe(true)
    expect(guard.isFrozen('recovery_candidates', 'candidate-old')).toBe(true)
    await expect(invoke('generation:resume', {
      projectId: fixture!.targetProjectId,
      epoch: 'source-epoch',
      rootActionId: 'root-old',
      runId: 'run-old',
    })).rejects.toThrow('GENERATION_RUN_IDENTITY_MISMATCH')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('roundtrips an immutable archive generation through WebDAV and rebuilds a restored gap only on confirmation', async () => {
    const { deletedSnapshotId } = await createSnapshotFixture()
    const f = fixture!
    openProject(f.sourceRoot)
    const sourceSummaries = await listSnapshots()
    const dav = new DavFixture()
    await dav.listen()
    try {
      await f.exportArchive()
      const generationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      const cloudBookId = 'character-state-roundtrip'
      const account = { endpoint: dav.baseUrl, username: 'writer', secret: 'loopback-secret' }
      const service = new WebDavBackupService({ generationIdFactory: () => generationId })
      await service.appendGeneration({
        account,
        cloudBookId,
        archivePath: f.archivePath,
        originProjectId: f.sourceProjectId,
        portableSnapshotGeneration: 'b01-roundtrip-generation',
        parentGenerationIds: [],
      })
      const downloaded = path.join(f.base, 'downloaded-from-webdav.ainovel')
      await service.downloadGeneration({ account, cloudBookId, generationId, targetArchivePath: downloaded })
      expect(fs.readFileSync(downloaded)).toEqual(fs.readFileSync(f.archivePath))

      const fetch = vi.fn()
      vi.stubGlobal('fetch', fetch)
      const restoredRoot = path.join(f.base, 'webdav-restored')
      await restorePortableProject({
        archivePath: downloaded,
        targetProjectRoot: restoredRoot,
        newProjectId: () => f.targetProjectId,
      })
      openProject(restoredRoot)
      expect(fetch).not.toHaveBeenCalled()
      expect(await listSnapshots()).toEqual(sourceSummaries)

      const replacement = f.prepareChapter20Replacement(getProjectDb()!)
      const finalized = await invoke<{ success: boolean; finalizationId: string; contentHash: string }>('finalization:commit', {
        tabId: `draft:${replacement.draftId}`,
        projectPath: session.projectPath,
        projectSession: { ...session },
        draftId: replacement.draftId,
        chapterNumber: replacement.commit.chapterNumber,
        chapterTitle: replacement.commit.chapterTitle,
        content: replacement.commit.content,
        contentRevision: replacement.commit.contentRevision,
      })
      expect(finalized.success).toBe(true)
      const gap = await invoke<ChapterCharacterStateContinuityEntry[]>('finalized-character:read-state-continuity')
      expect(gap).toHaveLength(20)
      expect(gap.slice(0, 19).every(entry => entry.status === 'valid')).toBe(true)
      expect(gap[19]).toMatchObject({
        source: { finalizationId: finalized.finalizationId },
        status: 'missing-snapshot',
        invalidatedByChange: true,
      })
      await expect(invoke('finalized-character:plan-state-rebuild', {})).resolves.toMatchObject({
        range: { startChapter: 20, endChapter: 20 },
        chapters: [{ source: { finalizationId: finalized.finalizationId } }],
      })
      expect(fetch).not.toHaveBeenCalled()

      const rebuiltPhysicalState = '恢复后重新提取：左肩已经包扎'
      const content = JSON.stringify({ updates: [{
        characterId: f.characterId,
        currentState: { physicalState: rebuiltPhysicalState },
        evidence: { start: 0, end: replacement.body.length, text: replacement.body },
      }] })
      const rebuildFetch = vi.fn(async () => ({
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`))
            controller.close()
          },
        }),
      }))
      vi.stubGlobal('fetch', rebuildFetch)
      const rebuilt = await invoke<{
        status: string
        completedChapters: number
        chapters: Array<{ snapshotId: string; predecessor: { snapshotId: string } }>
      }>('finalized-character:begin-state-rebuild', {
        rebuildId: '7ad8a6c5-84f2-4c4b-9f0d-e8df52f53662',
        modelId: model.id,
        endChapter: 20,
      })
      expect(rebuilt).toMatchObject({ status: 'completed', completedChapters: 1 })
      expect(rebuildFetch).toHaveBeenCalledTimes(1)

      const summaries = await listSnapshots()
      expect(summaries).toHaveLength(21)
      const chapter19 = summaries.find(snapshot => snapshot.source.chapterNumber === 19)!
      const original20 = summaries.find(snapshot => snapshot.source.finalizationId === f.chapter20FinalizationId)!
      const rebuilt20 = summaries.find(snapshot => snapshot.source.finalizationId === finalized.finalizationId)!
      expect(original20.validity).toBe('superseded')
      expect(rebuilt20).toMatchObject({
        validity: 'valid',
        source: { contentHash: finalized.contentHash },
        baseline: { predecessor: { snapshotId: chapter19.snapshotId, snapshotHash: chapter19.snapshotHash } },
        continuityGeneration: 3,
      })
      expect(rebuilt.chapters[0]).toMatchObject({
        snapshotId: rebuilt20.snapshotId,
        predecessor: { snapshotId: chapter19.snapshotId },
      })
      const detail = await invoke<ChapterCharacterStateSnapshotDetail>('finalized-character:read-state-snapshot', {
        snapshotId: rebuilt20.snapshotId,
        characterId: f.characterId,
      })
      expect(detail.character.fields).toEqual(expect.arrayContaining([
        expect.objectContaining({
          field: 'physicalState', value: rebuiltPhysicalState, knownAtChapter: 20,
          provenance: { kind: 'derived', source: expect.objectContaining({ finalizationId: finalized.finalizationId }) },
          evidence: { start: 0, end: replacement.body.length, text: replacement.body },
        }),
        expect.objectContaining({ field: 'keyItems', value: '' }),
      ]))
      await expect(invoke('finalized-character:read-state-cache')).resolves.toMatchObject({
        status: 'ready', snapshotId: rebuilt20.snapshotId,
      })
      await expect(invoke('finalized-character:read-state-snapshot', {
        snapshotId: deletedSnapshotId,
        characterId: f.characterId,
      })).resolves.toBeNull()
      expect(dav.files.get(`/dav/books/${cloudBookId}/generations/${generationId}/archive.ainovel`))
        .toEqual(fs.readFileSync(f.archivePath))
      expect(dav.requests.some(request => request.url.includes('latest'))).toBe(false)
    } finally {
      await dav.close()
    }
  })
})
