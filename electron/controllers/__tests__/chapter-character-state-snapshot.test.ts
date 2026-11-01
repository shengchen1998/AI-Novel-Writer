import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelProfile, ProjectSessionContext } from '../../../src/shared/ipc-channels'
import type { FinalizationResult } from '../../services/finalization-service'
import { registerGenerationController } from '../generation-controller'
import { registerDatabaseController } from '../db-controller'
import { registerFinalizationController } from '../finalization-controller'
import { ModelExecutionLeaseRegistry } from '../../services/model-execution-lease'
import { projectAccess } from '../../services/project-access'
import { createProjectDatabase, initProjectDatabase, closeProjectDatabase, getProjectDb } from '../../database'
import { exportPortableProject } from '../../services/project-archive-service'
import { restorePortableProject } from '../../services/project-restore-service'
import { readPortableRuntimeFreeze } from '../../services/portable-runtime-freeze'
import { ChapterCharacterStateSnapshotRepository } from '../../repositories/chapter-character-state-snapshot-repository'

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), globalRoot: '' }))
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler) } }))
vi.mock('../../services/app-data-locator', () => ({ getGlobalDataRoot: () => mocks.globalRoot }))
vi.mock('../kb-controller', () => ({ getEmbeddingConfig: () => null }))

const model: ModelProfile = {
  id: 'fixture', name: '合成模型', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1',
  baseUrl: 'https://api.openai.com/v1', apiKey: 'synthetic-only', maxTokens: 1024, temperature: 0.7, purposes: ['generation'],
}
const sender = { isDestroyed: () => false, send: vi.fn() }
const prose = '林岚在北塔受伤，周研仍留在旧站。'
let root: string
let session: ProjectSessionContext

beforeAll(() => {
  registerGenerationController({
    modelExecutionLeases: new ModelExecutionLeaseRegistry({ loadModel: () => model }),
    loadModel: () => model,
    applyProxyConfig: () => {},
  })
  registerDatabaseController()
  registerFinalizationController()
})

beforeEach(() => {
  const cache = path.resolve('.runtime/.cache/issue-6-character-state-snapshots')
  fs.mkdirSync(cache, { recursive: true })
  root = fs.mkdtempSync(path.join(cache, 'ipc-'))
  mocks.globalRoot = path.join(root, 'global')
  fs.mkdirSync(mocks.globalRoot)
  const project = projectAccess.createProject(root, '合成快照')
  createProjectDatabase(project.rootPath)
  initProjectDatabase(project.rootPath)
  getProjectDb()!.exec("INSERT INTO project_core(id,project_name,writing_language) VALUES('main','合成快照','zh-CN')")
  const lease = projectAccess.beginSession(project)
  session = { projectId: project.projectId, projectPath: project.rootPath, leaseId: lease.leaseId }
})

afterEach(() => {
  closeProjectDatabase()
  projectAccess.invalidateCurrentSession()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

async function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`missing IPC: ${channel}`)
  return await handler({ sender }, ...args, { ...session }) as T
}

function stream(content: string) {
  const fetch = vi.fn(async () => ({
    ok: true,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`))
        controller.close()
      },
    }),
  }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

function seedDraft(id = 1, version = 1, content = prose) {
  getProjectDb()!.prepare('INSERT INTO blueprints(chapter_number,title) VALUES(1,?)').run('北塔')
  getProjectDb()!.prepare('INSERT INTO contents(id,body) VALUES(?,?)').run(id, content)
  getProjectDb()!.prepare("INSERT INTO drafts(id,chapter_number,version,status,content_id,word_count) VALUES(?,1,?,'draft',?,12)").run(id, version, id)
}

function seedCharacter(characterId: string, name: string, fields: Record<string, string>, provenance: Record<string, unknown>) {
  getProjectDb()!.prepare(`INSERT INTO characters(
    character_id,name,cs_location,cs_power_level,cs_physical_state,cs_mental_state,cs_key_items,cs_recent_events,cs_provenance
  ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
    characterId, name, fields.location ?? '', fields.powerLevel ?? '', fields.physicalState ?? '',
    fields.mentalState ?? '', fields.keyItems ?? '', fields.recentEvents ?? '', JSON.stringify(provenance),
  )
  getProjectDb()!.prepare('INSERT INTO character_aliases(character_id,name,source_key,valid_from,valid_through) VALUES(?,?,?,0,NULL)')
    .run(characterId, name, 'seed')
}

async function finalize(draftId = 1, content = prose, contentRevision = 1) {
  return await invoke<FinalizationResult>('finalization:commit', {
    tabId: `draft:${draftId}`,
    projectPath: session.projectPath,
    projectSession: { ...session },
    draftId,
    chapterNumber: 1,
    chapterTitle: '北塔',
    content,
    contentRevision,
  })
}

async function commitChapterNotes(draftId: number) {
  const source = getProjectDb()!.prepare(`SELECT d.id AS draftId,o.finalization_id AS finalizationId,
    d.chapter_number AS chapterNumber,o.content_hash AS contentHash FROM drafts d
    JOIN finalization_outbox o ON o.draft_id=d.id WHERE d.id=?`).get(draftId)
  const { view: run } = await invoke<{
    view: { handle: { projectId: string; epoch: string; rootActionId: string; runId: string } }
  }>('finalization-generation:begin', { slot: { source, stepKey: 'chapter_notes' }, modelId: model.id })
  stream('林岚在北塔受伤。')
  const receipt = await invoke<{
    run: { artifacts: Array<{ artifactId: string; revision: number; textHash: string }> }
  }>('finalization-generation:execute', { handle: run.handle })
  const artifact = receipt.run.artifacts.at(-1)!
  await invoke('finalization-generation:commit', {
    handle: run.handle,
    artifact: { artifactId: artifact.artifactId, revision: artifact.revision, textHash: artifact.textHash },
  })
}

async function extractedCommit(draftId: number, updates: unknown[]) {
  const source = getProjectDb()!.prepare(`SELECT d.id AS draftId,o.finalization_id AS finalizationId,
    d.chapter_number AS chapterNumber,o.content_hash AS contentHash FROM drafts d
    JOIN finalization_outbox o ON o.draft_id=d.id WHERE d.id=?`).get(draftId) as {
      draftId: number; finalizationId: string; chapterNumber: number; contentHash: string
    }
  const { view: run } = await invoke<{
    view: { handle: { projectId: string; epoch: string; rootActionId: string; runId: string } }
  }>('finalization-generation:begin', { slot: { source, stepKey: 'character_cards' }, modelId: model.id })
  const fetch = stream(JSON.stringify({ updates }))
  const receipt = await invoke<{
    run: { artifacts: Array<{ artifactId: string; revision: number; textHash: string }> }
  }>('finalization-generation:execute', { handle: run.handle })
  const artifact = receipt.run.artifacts.at(-1)!
  const request = {
    handle: run.handle,
    artifact: { artifactId: artifact.artifactId, revision: artifact.revision, textHash: artifact.textHash },
  }
  return { request, fetch, source }
}

async function listSnapshots(characterId: string) {
  return await invoke<Array<Record<string, unknown>>>('finalized-character:list-state-snapshots', { characterId })
}

async function readSnapshot(snapshotId: string, characterId: string) {
  return await invoke<Record<string, unknown>>('finalized-character:read-state-snapshot', { snapshotId, characterId })
}

describe('first chapter character-state snapshot through real finalization and generation IPC', () => {
  it('reuses one extraction to append a complete time-scoped snapshot and reads it on demand', async () => {
    seedDraft()
    seedCharacter('character-lin', '林岚', {
      location: '旧站', powerLevel: '旧能力', mentalState: '未来心理', keyItems: '其他定稿物品', recentEvents: '旧事件',
    }, {
      location: { kind: 'author', chapterNumber: 0, revision: 1 },
      powerLevel: { kind: 'legacy', revision: 1 },
      mentalState: { kind: 'author', chapterNumber: 2, revision: 1 },
      keyItems: {
        kind: 'derived', revision: 1,
        source: { draftId: 99, finalizationId: 'other-finalization', chapterNumber: 1, contentHash: 'd'.repeat(64) },
        sourceOrder: { continuityEpoch: 'other:0', chapterNumber: 1, authoritativeFinalizationRevision: 1 },
      },
      recentEvents: { kind: 'legacy', revision: 1 },
    })
    seedCharacter('character-zhou', '周研', { recentEvents: '仍在旧站' }, {
      recentEvents: { kind: 'author', chapterNumber: 1, revision: 1 },
    })
    const finalized = await finalize()
    expect(finalized).toMatchObject({ success: true, committed: true, draftId: 1 })
    await commitChapterNotes(1)
    const extraction = await extractedCommit(1, [{
      characterId: 'character-lin',
      currentState: { powerLevel: '模型推断能力', physicalState: '受伤' },
      evidence: { start: 0, end: prose.length, text: prose },
    }])

    const effect = await invoke<Record<string, unknown>>('finalization-generation:commit', extraction.request)
    expect(effect).toMatchObject({ success: true, stepKey: 'character_cards', applied: 1 })
    expect(extraction.fetch).toHaveBeenCalledTimes(1)

    const summaries = await listSnapshots('character-lin')
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      chapterTitle: '北塔',
      source: {
        draftId: 1,
        finalizationId: finalized.finalizationId,
        chapterNumber: 1,
        contentHash: finalized.contentHash,
      },
      character: { characterId: 'character-lin', displayNameSnapshot: '林岚', aliases: ['林岚'], updatedAtChapter: 1 },
    })
    expect(summaries[0]!.character).not.toHaveProperty('fields')

    const detail = await readSnapshot(summaries[0]!.snapshotId as string, 'character-lin')
    const fields = Object.fromEntries((detail.character as { fields: Array<Record<string, unknown>> }).fields.map(field => [field.field, field]))
    expect(fields).toMatchObject({
      location: { value: '旧站', provenance: { kind: 'author', chapterNumber: 0 }, knownAtChapter: 0 },
      powerLevel: { value: '旧能力', provenance: { kind: 'legacy' }, knownAtChapter: null },
      physicalState: {
        value: '受伤', knownAtChapter: 1,
        provenance: { kind: 'derived', source: { finalizationId: finalized.finalizationId } },
        evidence: { start: 0, end: prose.length, text: prose },
      },
      mentalState: { value: '', knownAtChapter: null },
      keyItems: { value: '', knownAtChapter: null },
      recentEvents: { value: '旧事件', provenance: { kind: 'legacy' } },
    })

    const unchanged = await readSnapshot(summaries[0]!.snapshotId as string, 'character-zhou')
    expect(unchanged.character).toMatchObject({ characterId: 'character-zhou', displayNameSnapshot: '周研' })
    expect((unchanged.character as { fields: unknown[] }).fields).toHaveLength(6)
    expect((unchanged.character as { fields: Array<Record<string, unknown>> }).fields)
      .toContainEqual(expect.objectContaining({ field: 'recentEvents', value: '仍在旧站', provenance: { kind: 'author', chapterNumber: 1 } }))

    const replay = await invoke('finalization-generation:commit', extraction.request)
    expect(replay).toEqual(effect)
    expect(await listSnapshots('character-lin')).toEqual(summaries)
    expect(extraction.fetch).toHaveBeenCalledTimes(1)
    await expect(mocks.handlers.get('finalized-character:list-state-snapshots')!({ sender }, { characterId: 'character-lin' }, {
      ...session, leaseId: 'stale-lease',
    })).rejects.toThrow('GENERATION_PROJECT_SESSION_STALE')
  })

  it('keeps finalization committed after snapshot storage fails and retries the same artifact without duplicate history', async () => {
    seedDraft()
    seedCharacter('character-lin', '林岚', {}, {})
    await finalize()
    const extraction = await extractedCommit(1, [{
      characterId: 'character-lin',
      currentState: { physicalState: '受伤' },
      evidence: { start: 0, end: prose.length, text: prose },
    }])
    getProjectDb()!.exec(`CREATE TRIGGER reject_chapter_state_snapshot
      BEFORE INSERT ON chapter_character_state_snapshots
      BEGIN SELECT RAISE(ABORT,'SYNTHETIC_SNAPSHOT_FAILURE'); END`)

    await expect(invoke('finalization-generation:commit', extraction.request)).rejects.toThrow()
    expect(await listSnapshots('character-lin')).toEqual([])
    expect(await invoke('db:draft-get-full', 1, session.projectPath)).toMatchObject({ id: 1, status: 'finalized', content: prose })

    getProjectDb()!.exec('DROP TRIGGER reject_chapter_state_snapshot')
    await expect(invoke('finalization-generation:commit', extraction.request)).resolves.toMatchObject({ success: true, applied: 1 })
    expect(extraction.fetch).toHaveBeenCalledTimes(1)
    const saved = await listSnapshots('character-lin')
    expect(saved).toHaveLength(1)
    await invoke('finalization-generation:commit', extraction.request)
    expect(await listSnapshots('character-lin')).toEqual(saved)
    expect(extraction.fetch).toHaveBeenCalledTimes(1)
  })

  it('preserves the snapshot and source in a real backup copy without replaying its generation run', async () => {
    seedDraft()
    seedCharacter('character-lin', '林岚', {}, {})
    await finalize()
    const extraction = await extractedCommit(1, [{
      characterId: 'character-lin',
      currentState: { physicalState: '受伤' },
      evidence: { start: 0, end: prose.length, text: prose },
    }])
    await invoke('finalization-generation:commit', extraction.request)
    const [summary] = await listSnapshots('character-lin')
    const archivePath = path.join(root, 'snapshot.zip')
    const restoredRoot = path.join(root, 'restored-snapshot')
    await exportPortableProject({
      sourceProjectRoot: session.projectPath,
      projectSession: session,
      targetArchivePath: archivePath,
      attemptParentPath: root,
      assertCurrentContext: context => { expect(context).toEqual(session) },
      assets: { snapshot: () => ({ files: [], verifyUnchanged: () => {} }) },
    })

    await restorePortableProject({ archivePath, targetProjectRoot: restoredRoot })
    const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
    const restored = new Database(path.join(restoredRoot, '.ai-novel', 'project.db'), { readonly: true })
    try {
      expect(restored.pragma('user_version', { simple: true })).toBe(8)
      const restoredSummaries = ChapterCharacterStateSnapshotRepository.listForCharacter(restored, 'character-lin')
      expect(restoredSummaries).toEqual([summary])
      const detail = ChapterCharacterStateSnapshotRepository.readForCharacter(restored, summary!.snapshotId as string, 'character-lin')
      expect(detail).toMatchObject({
        source: { finalizationId: extraction.source.finalizationId, contentHash: extraction.source.contentHash },
      })
      expect(detail!.character.fields.find(field => field.field === 'physicalState')).toMatchObject({
        value: '受伤',
        provenance: { kind: 'derived', source: extraction.source },
        evidence: { start: 0, end: prose.length, text: prose },
      })
      expect(readPortableRuntimeFreeze(restoredRoot).isFrozen('generation_runs', extraction.request.handle.runId)).toBe(true)
    } finally {
      restored.close()
    }
    expect(extraction.fetch).toHaveBeenCalledTimes(1)
  })
})
