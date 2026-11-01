import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelProfile, ProjectSessionContext } from '../../../src/shared/ipc-channels'
import type { FinalizationResult } from '../../services/finalization-service'
import { registerGenerationController } from '../generation-controller'
import { registerDatabaseController } from '../db-controller'
import { registerFinalizationController } from '../finalization-controller'
import { registerChapterLifecycleController } from '../chapter-lifecycle-controller'
import { ModelExecutionLeaseRegistry } from '../../services/model-execution-lease'
import { projectAccess } from '../../services/project-access'
import { createProjectDatabase, initProjectDatabase, closeProjectDatabase, getProjectDb } from '../../database'
import { exportPortableProject } from '../../services/project-archive-service'
import { restorePortableProject } from '../../services/project-restore-service'
import { readPortableRuntimeFreeze } from '../../services/portable-runtime-freeze'
import { ChapterCharacterStateSnapshotRepository } from '../../repositories/chapter-character-state-snapshot-repository'
import { invalidateContinuityProjectionFrom } from '../../repositories/summary-repository'
import { refreshCharacterIdentityProjection } from '../../repositories/character-roster-repository'

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
  registerChapterLifecycleController()
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
  const fetch = vi.fn(async (url: unknown, init?: { body?: string }) => {
    void url
    void init
    return {
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`))
          controller.close()
        },
      }),
    }
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

function streamResponses(contents: string[]) {
  let index = 0
  const fetch = vi.fn(async (url: unknown, init?: { body?: string }) => {
    void url
    void init
    const content = contents[Math.min(index++, contents.length - 1)]!
    return {
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`))
          controller.close()
        },
      }),
    }
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

function seedDraft(id = 1, version = 1, content = prose, chapterNumber = 1, chapterTitle = '北塔') {
  getProjectDb()!.prepare('INSERT INTO blueprints(chapter_number,title) VALUES(?,?)').run(chapterNumber, chapterTitle)
  getProjectDb()!.prepare('INSERT INTO contents(id,body) VALUES(?,?)').run(id, content)
  getProjectDb()!.prepare("INSERT INTO drafts(id,chapter_number,version,status,content_id,word_count) VALUES(?,?,?,'draft',?,12)").run(id, chapterNumber, version, id)
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

async function finalize(draftId = 1, content = prose, contentRevision = 1, chapterNumber = 1, chapterTitle = '北塔') {
  return await invoke<FinalizationResult>('finalization:commit', {
    tabId: `draft:${draftId}`,
    projectPath: session.projectPath,
    projectSession: { ...session },
    draftId,
    chapterNumber,
    chapterTitle,
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

  it('inherits the nearest earlier valid snapshot with its original field provenance and evidence', async () => {
    const firstProse = '林岚在北塔受伤。'
    const secondProse = '林岚抵达南桥。'
    seedCharacter('character-lin', '林岚', {}, {})
    seedDraft(1, 1, firstProse)
    seedDraft(2, 1, secondProse, 2, '南桥')
    await finalize(1, firstProse)
    const firstExtraction = await extractedCommit(1, [{
      characterId: 'character-lin',
      currentState: { physicalState: '受伤' },
      evidence: { start: 0, end: firstProse.length, text: firstProse },
    }])
    await invoke('finalization-generation:commit', firstExtraction.request)
    const [first] = await listSnapshots('character-lin')

    await finalize(2, secondProse, 1, 2, '南桥')
    const secondExtraction = await extractedCommit(2, [{
      characterId: 'character-lin',
      currentState: { location: '南桥' },
      evidence: { start: 0, end: secondProse.length, text: secondProse },
    }])
    await invoke('finalization-generation:commit', secondExtraction.request)
    const summaries = await listSnapshots('character-lin')
    const second = summaries.find(item => (item.source as { chapterNumber: number }).chapterNumber === 2)!

    expect(first).toMatchObject({
      baseline: { kind: 'roster', predecessor: null },
      continuityGeneration: 0,
    })
    expect(second).toMatchObject({
      baseline: {
        kind: 'snapshot',
        predecessor: {
          snapshotId: first!.snapshotId,
          snapshotHash: first!.snapshotHash,
          source: { chapterNumber: 1, finalizationId: firstExtraction.source.finalizationId },
        },
      },
      continuityGeneration: 0,
    })
    for (const summary of [first!, second]) expect(summary.inputHash).toMatch(/^[a-f0-9]{64}$/)
    expect(second.inputHash).not.toBe(first!.inputHash)

    const firstDetail = await readSnapshot(first!.snapshotId as string, 'character-lin')
    const secondDetail = await readSnapshot(second.snapshotId as string, 'character-lin')
    const inherited = (detail: Record<string, unknown>) => (detail.character as { fields: Array<Record<string, unknown>> }).fields
      .find(field => field.field === 'physicalState')
    expect(inherited(secondDetail)).toEqual(inherited(firstDetail))
    expect(inherited(secondDetail)).toMatchObject({
      value: '受伤',
      knownAtChapter: 1,
      provenance: { kind: 'derived', source: { chapterNumber: 1, finalizationId: firstExtraction.source.finalizationId } },
      evidence: { start: 0, end: firstProse.length, text: firstProse },
    })
  })

  it('freezes an out-of-order chapter baseline before extraction without future or unfinalized values', async () => {
    const firstProse = '第一章：林岚在北塔受伤。'
    const secondProse = '第二章：林岚练习控火。'
    const thirdProse = '第三章：林岚带着未来物品抵达南桥。'
    seedCharacter('character-lin', '林岚', { mentalState: '未来心理' }, {
      mentalState: { kind: 'author', chapterNumber: 3, revision: 1 },
    })
    seedDraft(1, 1, firstProse)
    seedDraft(2, 1, secondProse, 2, '练习')
    seedDraft(3, 1, thirdProse, 3, '南桥')
    getProjectDb()!.prepare('UPDATE blueprints SET characters=? WHERE chapter_number=2').run(JSON.stringify(['未来细纲人物']))
    await finalize(1, firstProse)
    const first = await extractedCommit(1, [{
      characterId: 'character-lin', currentState: { physicalState: '第一章伤势' },
      evidence: { start: 0, end: firstProse.length, text: firstProse },
    }])
    await invoke('finalization-generation:commit', first.request)

    await finalize(3, thirdProse, 1, 3, '南桥')
    const third = await extractedCommit(3, [{
      characterId: 'character-lin', currentState: { physicalState: '第三章状态', keyItems: '未来物品' },
      evidence: { start: 0, end: thirdProse.length, text: thirdProse },
    }])
    await invoke('finalization-generation:commit', third.request)
    const [firstSummary] = await listSnapshots('character-lin')

    await finalize(2, secondProse, 1, 2, '练习')
    const prepared = await invoke<{ characterStateBaseline?: {
      characters: Array<{ fields: Array<{ field: string; value: string }> }>
    } }>('finalized-character:read-context', { draftId: 2 })
    const preparedFields = prepared.characterStateBaseline?.characters[0]?.fields
    expect(preparedFields?.find(field => field.field === 'physicalState')?.value).toBe('第一章伤势')
    expect(preparedFields?.find(field => field.field === 'keyItems')?.value).toBe('')
    const second = await extractedCommit(2, [{
      characterId: 'character-lin', currentState: { powerLevel: '第二章能力' },
      evidence: { start: 0, end: secondProse.length, text: secondProse },
    }])
    const requestBody = String((second.fetch.mock.calls[0]![1] as { body: string }).body)
    expect(requestBody).toContain('第一章伤势')
    expect(requestBody).not.toContain('第三章状态')
    expect(requestBody).not.toContain('未来物品')
    expect(requestBody).not.toContain('未来心理')
    expect(requestBody).not.toContain('未来细纲人物')
    await invoke('finalization-generation:commit', second.request)

    const summaries = await listSnapshots('character-lin')
    const secondSummary = summaries.find(item => (item.source as { chapterNumber: number }).chapterNumber === 2)!
    expect(secondSummary.baseline).toMatchObject({
      kind: 'snapshot', predecessor: { snapshotId: firstSummary!.snapshotId, source: { chapterNumber: 1 } },
    })
    const detail = await readSnapshot(secondSummary.snapshotId as string, 'character-lin')
    const fields = Object.fromEntries((detail.character as { fields: Array<Record<string, unknown>> }).fields.map(field => [field.field, field]))
    expect(fields).toMatchObject({
      physicalState: { value: '第一章伤势', knownAtChapter: 1 },
      keyItems: { value: '', knownAtChapter: null },
      mentalState: { value: '', knownAtChapter: null },
      powerLevel: { value: '第二章能力', knownAtChapter: 2 },
    })
  })

  it('reports a predecessor gap without dispatching or rolling back the later finalization', async () => {
    const firstProse = '第一章已经定稿。'
    const secondProse = '第二章也已经定稿。'
    seedCharacter('character-lin', '林岚', {}, {})
    seedDraft(1, 1, firstProse)
    seedDraft(2, 1, secondProse, 2, '后续')
    await finalize(1, firstProse)
    await finalize(2, secondProse, 1, 2, '后续')
    const source = getProjectDb()!.prepare(`SELECT d.id AS draftId,o.finalization_id AS finalizationId,
      d.chapter_number AS chapterNumber,o.content_hash AS contentHash FROM drafts d
      JOIN finalization_outbox o ON o.draft_id=d.id WHERE d.id=2`).get()
    const fetch = stream(JSON.stringify({ updates: [] }))

    await expect(invoke('finalization-generation:begin', {
      slot: { source, stepKey: 'character_cards' }, modelId: model.id,
    })).rejects.toThrow('GENERATION_FINALIZATION_PREDECESSOR_REQUIRED')
    expect(fetch).not.toHaveBeenCalled()
    await expect(invoke('finalized-character:read-state-continuity')).resolves.toEqual([
      expect.objectContaining({ source: expect.objectContaining({ chapterNumber: 1 }), status: 'missing-snapshot' }),
      expect.objectContaining({
        source: expect.objectContaining({ chapterNumber: 2 }),
        status: 'waiting-predecessor',
        predecessorGapChapterNumber: 1,
      }),
    ])
    expect(await invoke('db:draft-get-full', 2, session.projectPath)).toMatchObject({ id: 2, status: 'finalized', content: secondProse })

    const first = await extractedCommit(1, [])
    await invoke('finalization-generation:commit', first.request)
    expect(first.fetch).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
    await expect(invoke('finalized-character:read-state-continuity')).resolves.toEqual([
      expect.objectContaining({ source: expect.objectContaining({ chapterNumber: 1 }), status: 'valid' }),
      expect.objectContaining({ source: expect.objectContaining({ chapterNumber: 2 }), status: 'missing-snapshot' }),
    ])
  })

  it('does not move the latest cache backward for a historical chapter snapshot', async () => {
    const firstProse = '第一章林岚在北塔。'
    const secondProse = '第二章林岚经过旧站。'
    const thirdProse = '第三章林岚抵达南桥。'
    seedCharacter('character-lin', '林岚', {}, {})
    seedDraft(1, 1, firstProse)
    seedDraft(2, 1, secondProse, 2, '旧站')
    seedDraft(3, 1, thirdProse, 3, '南桥')
    await finalize(1, firstProse)
    await commitChapterNotes(1)
    const first = await extractedCommit(1, [{
      characterId: 'character-lin', currentState: { location: '北塔' },
      evidence: { start: 0, end: firstProse.length, text: firstProse },
    }])
    await invoke('finalization-generation:commit', first.request)
    await finalize(3, thirdProse, 1, 3, '南桥')
    await commitChapterNotes(3)
    const third = await extractedCommit(3, [{
      characterId: 'character-lin', currentState: { location: '南桥' },
      evidence: { start: 0, end: thirdProse.length, text: thirdProse },
    }])
    await invoke('finalization-generation:commit', third.request)
    const readCurrent = async () => await invoke<{
      entries: Array<{ currentState?: { location: string } }>
      currentDerivedFields: Record<string, string[]>
    }>('db:character-roster-read', session.projectPath)
    expect((await readCurrent()).entries[0]?.currentState?.location).toBe('南桥')

    await finalize(2, secondProse, 1, 2, '旧站')
    expect((await readCurrent()).currentDerivedFields['character-lin'] ?? []).toEqual([])
    const second = await extractedCommit(2, [{
      characterId: 'character-lin', currentState: { location: '旧站' },
      evidence: { start: 0, end: secondProse.length, text: secondProse },
    }])
    await invoke('finalization-generation:commit', second.request)

    await expect(invoke('finalized-character:read-state-continuity')).resolves.toEqual([
      expect.objectContaining({ source: expect.objectContaining({ chapterNumber: 1 }), status: 'valid' }),
      expect.objectContaining({ source: expect.objectContaining({ chapterNumber: 2 }), status: 'valid' }),
      expect.objectContaining({ source: expect.objectContaining({ chapterNumber: 3 }), status: 'invalid-snapshot' }),
    ])
    const current = await readCurrent()
    expect(current.entries[0]?.currentState?.location).toBe('南桥')
    expect(current.currentDerivedFields['character-lin'] ?? []).toEqual([])
    await expect(invoke('finalized-character:read-state-cache')).resolves.toMatchObject({ status: 'invalid', reason: 'continuity-incomplete' })
    const snapshots = await listSnapshots('character-lin')
    expect(snapshots).toHaveLength(3)
    expect(snapshots.find(item => (item.source as { chapterNumber: number }).chapterNumber === 3)).toMatchObject({ status: 'invalid' })
    const thirdSummary = snapshots.find(item => (item.source as { chapterNumber: number }).chapterNumber === 3)!
    await expect(readSnapshot(thirdSummary.snapshotId as string, 'character-lin')).resolves.toMatchObject({ status: 'invalid' })
    expect(first.fetch).toHaveBeenCalledTimes(1)
    expect(second.fetch).toHaveBeenCalledTimes(1)
    expect(third.fetch).toHaveBeenCalledTimes(1)
  })

  it('prioritizes applicable author fields and keeps candidate decisions out of immutable snapshots', async () => {
    const firstProse = '第一章林岚在北塔。'
    const secondProse = '第二章林岚抵达南桥。'
    seedCharacter('character-lin', '林岚', { powerLevel: '旧能力' }, { powerLevel: { kind: 'legacy', revision: 1 } })
    getProjectDb()!.transaction(() => refreshCharacterIdentityProjection(getProjectDb()!))()
    seedDraft(1, 1, firstProse)
    seedDraft(2, 1, secondProse, 2, '南桥')
    await finalize(1, firstProse)
    await commitChapterNotes(1)
    const first = await extractedCommit(1, [{
      characterId: 'character-lin', currentState: { location: '北塔', powerLevel: '模型能力' },
      evidence: { start: 0, end: firstProse.length, text: firstProse },
    }])
    await invoke('finalization-generation:commit', first.request)
    const [firstSummary] = await listSnapshots('character-lin')
    const firstDetail = await readSnapshot(firstSummary!.snapshotId as string, 'character-lin')
    expect(firstDetail.character).toMatchObject({ fields: expect.arrayContaining([
      expect.objectContaining({ field: 'location', value: '北塔', provenance: expect.objectContaining({ kind: 'derived' }) }),
      expect.objectContaining({ field: 'powerLevel', value: '旧能力', provenance: expect.objectContaining({ kind: 'legacy' }) }),
    ]) })
    const [legacySummary] = await invoke<Array<{ draftId: number; candidateKey: string }>>('finalized-character:list-state-candidates')
    const legacyCandidate = await invoke<Record<string, unknown>>('finalized-character:read-state-candidate', {
      draftId: legacySummary!.draftId, candidateKey: legacySummary!.candidateKey,
    })
    await invoke('finalized-character:decide-state-candidate', {
      draftId: legacySummary!.draftId, candidateKey: legacySummary!.candidateKey,
      characterId: 'character-lin', field: 'powerLevel',
      expectedFieldRevision: legacyCandidate.expectedFieldRevision, expectedFieldValueHash: legacyCandidate.expectedFieldValueHash,
      operationId: 'decline-legacy-state', decision: 'decline',
    })
    expect(await readSnapshot(firstSummary!.snapshotId as string, 'character-lin')).toEqual(firstDetail)

    const roster = await invoke<{
      revision: number
      identityRevision: number
      schemaVersion: 1
      entries: Array<Record<string, unknown>>
    }>('db:character-roster-read', session.projectPath)
    const entry = roster.entries.find(item => item.characterId === 'character-lin')!
    await invoke('db:character-roster-commit', {
      operationId: 'author-before-second-chapter', expectedRevision: roster.revision, expectedIdentityRevision: roster.identityRevision,
      schemaVersion: roster.schemaVersion, intent: 'manual_edit',
      entries: [{ ...entry, currentState: { ...(entry.currentState as Record<string, unknown>), location: '作者南桥', updatedAtChapter: 2 } }],
    }, session.projectPath)
    await finalize(2, secondProse, 1, 2, '南桥')
    await commitChapterNotes(2)
    const second = await extractedCommit(2, [{
      characterId: 'character-lin', currentState: { location: '模型南桥' },
      evidence: { start: 0, end: secondProse.length, text: secondProse },
    }])
    await invoke('finalization-generation:commit', second.request)
    const summaries = await listSnapshots('character-lin')
    const secondSummary = summaries.find(item => (item.source as { chapterNumber: number }).chapterNumber === 2)!
    const secondDetail = await readSnapshot(secondSummary.snapshotId as string, 'character-lin')
    expect(secondDetail.character).toMatchObject({ fields: expect.arrayContaining([
      expect.objectContaining({ field: 'location', value: '作者南桥', knownAtChapter: 2,
        provenance: expect.objectContaining({ kind: 'author', chapterNumber: 2 }) }),
      expect.objectContaining({ field: 'powerLevel', value: '旧能力', provenance: expect.objectContaining({ kind: 'legacy' }) }),
    ]) })
    const [authorSummary] = await invoke<Array<{ draftId: number; candidateKey: string }>>('finalized-character:list-state-candidates')
    const authorCandidate = await invoke<Record<string, unknown>>('finalized-character:read-state-candidate', {
      draftId: authorSummary!.draftId, candidateKey: authorSummary!.candidateKey,
    })
    await invoke('finalized-character:decide-state-candidate', {
      draftId: authorSummary!.draftId, candidateKey: authorSummary!.candidateKey,
      characterId: 'character-lin', field: 'location',
      expectedFieldRevision: authorCandidate.expectedFieldRevision, expectedFieldValueHash: authorCandidate.expectedFieldValueHash,
      operationId: 'accept-author-state', decision: 'accept',
    })

    const current = await invoke<{
      entries: Array<{ currentState?: { location: string; powerLevel: string; provenance?: Record<string, unknown> } }>
    }>('db:character-roster-read', session.projectPath)
    expect(current.entries[0]?.currentState).toMatchObject({
      location: '模型南桥', powerLevel: '旧能力', provenance: { location: { kind: 'author', chapterNumber: 2 } },
    })
    expect(await readSnapshot(firstSummary!.snapshotId as string, 'character-lin')).toEqual(firstDetail)
    expect(await readSnapshot(secondSummary.snapshotId as string, 'character-lin')).toEqual(secondDetail)
    await expect(invoke('finalized-character:list-state-candidates')).resolves.toEqual([])
    expect(first.fetch).toHaveBeenCalledTimes(1)
    expect(second.fetch).toHaveBeenCalledTimes(1)
  })

  it('applies a later author edit to the latest cache without touching history or calling a model', async () => {
    seedDraft()
    seedCharacter('character-lin', '林岚', {}, {})
    getProjectDb()!.transaction(() => refreshCharacterIdentityProjection(getProjectDb()!))()
    await finalize()
    const extraction = await extractedCommit(1, [{
      characterId: 'character-lin', currentState: { physicalState: '受伤' },
      evidence: { start: 0, end: prose.length, text: prose },
    }])
    await invoke('finalization-generation:commit', extraction.request)
    const [before] = await listSnapshots('character-lin')
    const beforeDetail = await readSnapshot(before!.snapshotId as string, 'character-lin')
    const roster = await invoke<{
      revision: number
      identityRevision: number
      schemaVersion: 1
      entries: Array<Record<string, unknown>>
    }>('db:character-roster-read', session.projectPath)
    const entry = roster.entries.find(item => item.characterId === 'character-lin')!
    const currentState = entry.currentState as Record<string, unknown>
    const authorEdit = await invoke<{ success: boolean; error?: string }>('db:character-roster-commit', {
      operationId: 'author-after-snapshot', expectedRevision: roster.revision, expectedIdentityRevision: roster.identityRevision,
      schemaVersion: roster.schemaVersion, intent: 'manual_edit',
      entries: [{ ...entry, currentState: { ...currentState, location: '作者后改南桥', updatedAtChapter: 1 } }],
    }, session.projectPath)
    expect(authorEdit.error).toBeUndefined()

    const current = await invoke<{
      entries: Array<{ characterId?: string; currentState?: { location: string; physicalState: string; provenance?: Record<string, unknown> } }>
    }>('db:character-roster-read', session.projectPath)
    expect(current.entries[0]?.currentState).toMatchObject({
      location: '作者后改南桥', physicalState: '受伤', provenance: { location: { kind: 'author', chapterNumber: 1 } },
    })
    await expect(invoke('finalized-character:read-state-cache')).resolves.toMatchObject({ status: 'ready', snapshotId: before!.snapshotId })
    expect(await readSnapshot(before!.snapshotId as string, 'character-lin')).toEqual(beforeDetail)
    expect(await listSnapshots('character-lin')).toEqual([before])
    expect(extraction.fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps the verified snapshot and author edit when the latest-cache CAS conflicts', async () => {
    seedDraft()
    seedCharacter('character-lin', '林岚', {}, {})
    getProjectDb()!.transaction(() => refreshCharacterIdentityProjection(getProjectDb()!))()
    await finalize()
    const extraction = await extractedCommit(1, [{
      characterId: 'character-lin',
      currentState: { physicalState: '受伤' },
      evidence: { start: 0, end: prose.length, text: prose },
    }])
    const roster = await invoke<{
      revision: number
      identityRevision: number
      schemaVersion: 1
      entries: Array<Record<string, unknown>>
    }>('db:character-roster-read', session.projectPath)
    const entry = roster.entries.find(item => item.characterId === 'character-lin')!
    const authorState = {
      location: '作者改到南桥', powerLevel: '', physicalState: '', mentalState: '', keyItems: '', recentEvents: '', updatedAtChapter: 1,
    }
    const authorEdit = await invoke<{ success: boolean; error?: string }>('db:character-roster-commit', {
      operationId: 'author-during-character-commit', expectedRevision: roster.revision,
      expectedIdentityRevision: roster.identityRevision, schemaVersion: roster.schemaVersion, intent: 'manual_edit',
      entries: [{ ...entry, currentState: authorState }],
    }, session.projectPath)
    expect(authorEdit.error).toBeUndefined()
    expect(authorEdit).toMatchObject({ success: true })

    const effect = await invoke<Record<string, unknown>>('finalization-generation:commit', extraction.request)
    expect(effect).toMatchObject({ success: true, cacheStatus: 'rebuild-required', cacheConflict: true })
    const [snapshot] = await listSnapshots('character-lin')
    expect(snapshot).toBeTruthy()
    const detail = await readSnapshot(snapshot!.snapshotId as string, 'character-lin')
    expect(detail.character).toMatchObject({ fields: expect.arrayContaining([
      expect.objectContaining({ field: 'physicalState', value: '受伤', provenance: expect.objectContaining({ kind: 'derived' }) }),
      expect.objectContaining({ field: 'location', value: '', provenance: expect.objectContaining({ kind: 'legacy' }) }),
    ]) })
    await expect(invoke('finalized-character:read-state-cache')).resolves.toMatchObject({
      status: 'rebuild-required', reason: 'cas-conflict', snapshotId: snapshot!.snapshotId,
    })
    const current = await invoke<{
      entries: Array<{ characterId?: string; currentState?: { location: string; physicalState: string } }>
      currentDerivedFields: Record<string, string[]>
    }>('db:character-roster-read', session.projectPath)
    expect(current.entries.find(item => item.characterId === 'character-lin')?.currentState).toMatchObject({
      location: '作者改到南桥', physicalState: '',
    })
    expect(current.currentDerivedFields['character-lin'] ?? []).toEqual([])
    expect(extraction.fetch).toHaveBeenCalledTimes(1)

    await expect(invoke('finalization-generation:commit', extraction.request)).resolves.toEqual(effect)
    expect(await listSnapshots('character-lin')).toEqual([snapshot])
    expect(extraction.fetch).toHaveBeenCalledTimes(1)
  })

  it('invalidates and preserves the suffix after an early chapter is refinalized', async () => {
    const chapters = ['第一章旧正文。', '第二章正文。', '第三章正文。']
    seedCharacter('character-lin', '林岚', {}, {})
    chapters.forEach((content, index) => seedDraft(index + 1, 1, content, index + 1, `第${index + 1}章`))
    const extractions = []
    for (const [index, content] of chapters.entries()) {
      const chapterNumber = index + 1
      await finalize(chapterNumber, content, 1, chapterNumber, `第${chapterNumber}章`)
      const extraction = await extractedCommit(chapterNumber, [])
      extractions.push(extraction)
      await invoke('finalization-generation:commit', extraction.request)
    }
    const before = await listSnapshots('character-lin')
    expect(before).toHaveLength(3)
    expect(before.every(snapshot => snapshot.validity === 'valid')).toBe(true)

    const revised = '第一章新正文，后续状态必须重建。'
    getProjectDb()!.prepare('INSERT INTO contents(id,body) VALUES(4,?)').run(revised)
    getProjectDb()!.prepare("INSERT INTO drafts(id,chapter_number,version,status,content_id,word_count) VALUES(4,1,2,'draft',4,12)").run()
    await finalize(4, revised, 1, 1, '第一章新稿')

    await expect(invoke('finalized-character:read-state-continuity')).resolves.toEqual([
      expect.objectContaining({ source: expect.objectContaining({ chapterNumber: 1 }), status: 'missing-snapshot', invalidatedByChange: true }),
      expect.objectContaining({ source: expect.objectContaining({ chapterNumber: 2 }), status: 'waiting-predecessor', predecessorGapChapterNumber: 1, invalidatedByChange: true }),
      expect.objectContaining({ source: expect.objectContaining({ chapterNumber: 3 }), status: 'waiting-predecessor', predecessorGapChapterNumber: 1, invalidatedByChange: true }),
    ])
    const retained = await listSnapshots('character-lin')
    expect(retained).toHaveLength(3)
    expect(retained.map(snapshot => [snapshot.snapshotId, snapshot.snapshotHash])).toEqual(before.map(snapshot => [snapshot.snapshotId, snapshot.snapshotHash]))
    expect(retained.map(snapshot => snapshot.validity)).toEqual(['superseded', 'waiting-predecessor', 'waiting-predecessor'])
    await expect(invoke('finalized-character:read-state-cache')).resolves.toMatchObject({ status: 'invalid', reason: 'continuity-incomplete' })

    const replacement = await extractedCommit(4, [])
    await invoke('finalization-generation:commit', replacement.request)
    await expect(invoke('finalized-character:read-state-continuity')).resolves.toEqual([
      expect.objectContaining({ source: expect.objectContaining({ chapterNumber: 1 }), status: 'valid' }),
      expect.objectContaining({ source: expect.objectContaining({ chapterNumber: 2 }), status: 'invalid-snapshot', invalidatedByChange: true }),
      expect.objectContaining({ source: expect.objectContaining({ chapterNumber: 3 }), status: 'waiting-predecessor', predecessorGapChapterNumber: 2, invalidatedByChange: true }),
    ])
    expect(await listSnapshots('character-lin')).toHaveLength(4)
    for (const extraction of [...extractions, replacement]) expect(extraction.fetch).toHaveBeenCalledTimes(1)
  })

  it('uses the same invalidation watermark when an earlier finalization is inserted', async () => {
    seedCharacter('character-lin', '林岚', {}, {})
    seedDraft(1, 1, '第一章正文。', 1, '第一章')
    seedDraft(2, 1, '后来补上的第二章。', 2, '第二章')
    seedDraft(3, 1, '第三章正文。', 3, '第三章')
    for (const draftId of [1, 3]) {
      await finalize(draftId, draftId === 1 ? '第一章正文。' : '第三章正文。', 1, draftId, `第${draftId}章`)
      const extraction = await extractedCommit(draftId, [])
      await invoke('finalization-generation:commit', extraction.request)
    }
    const generation = getProjectDb()!.prepare("SELECT generation FROM continuity_projection_meta WHERE id='main'").pluck().get()

    await finalize(2, '后来补上的第二章。', 1, 2, '第二章')

    expect(getProjectDb()!.prepare("SELECT generation FROM continuity_projection_meta WHERE id='main'").pluck().get()).toBe((generation as number) + 1)
    await expect(invoke('finalized-character:read-state-continuity')).resolves.toEqual([
      expect.objectContaining({ source: expect.objectContaining({ chapterNumber: 1 }), status: 'valid' }),
      expect.objectContaining({ source: expect.objectContaining({ chapterNumber: 2 }), status: 'missing-snapshot', invalidatedByChange: true }),
      expect.objectContaining({ source: expect.objectContaining({ chapterNumber: 3 }), status: 'waiting-predecessor', predecessorGapChapterNumber: 2, invalidatedByChange: true }),
    ])
  })

  it('keeps chapter-order writes on the shared invalidation path without skipping a predecessor', async () => {
    seedCharacter('character-lin', '林岚', {}, {})
    for (const chapterNumber of [1, 2, 3]) {
      const content = `第${chapterNumber}章正文。`
      seedDraft(chapterNumber, 1, content, chapterNumber, `第${chapterNumber}章`)
      await finalize(chapterNumber, content, 1, chapterNumber, `第${chapterNumber}章`)
      const extraction = await extractedCommit(chapterNumber, [])
      await invoke('finalization-generation:commit', extraction.request)
    }

    getProjectDb()!.transaction(() => {
      getProjectDb()!.prepare('UPDATE drafts SET chapter_number=99 WHERE id=2').run()
      getProjectDb()!.prepare('UPDATE drafts SET chapter_number=2 WHERE id=3').run()
      getProjectDb()!.prepare('UPDATE drafts SET chapter_number=3 WHERE id=2').run()
      getProjectDb()!.prepare('UPDATE finalization_outbox SET chapter_number=3 WHERE draft_id=2').run()
      getProjectDb()!.prepare('UPDATE finalization_outbox SET chapter_number=2 WHERE draft_id=3').run()
      invalidateContinuityProjectionFrom(getProjectDb()!, 2)
    }).immediate()

    await expect(invoke('finalized-character:read-state-continuity')).resolves.toEqual([
      expect.objectContaining({ source: expect.objectContaining({ chapterNumber: 1 }), status: 'valid' }),
      expect.objectContaining({ source: expect.objectContaining({ chapterNumber: 2, draftId: 3 }), status: 'invalid-snapshot', invalidatedByChange: true }),
      expect.objectContaining({ source: expect.objectContaining({ chapterNumber: 3, draftId: 2 }), status: 'waiting-predecessor', predecessorGapChapterNumber: 2, invalidatedByChange: true }),
    ])
    expect(await listSnapshots('character-lin')).toHaveLength(3)
    const laterSource = getProjectDb()!.prepare(`SELECT d.id AS draftId,o.finalization_id AS finalizationId,
      d.chapter_number AS chapterNumber,o.content_hash AS contentHash FROM drafts d
      JOIN finalization_outbox o ON o.draft_id=d.id WHERE d.id=2`).get()
    const fetch = stream(JSON.stringify({ updates: [] }))
    await expect(invoke('finalization-generation:begin', {
      slot: { source: laterSource, stepKey: 'character_cards' }, modelId: model.id,
    })).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('appends same-chapter versions without reviving the superseded snapshot while the replacement is pending or fails', async () => {
    const revisedProse = '林岚在北塔康复，周研仍留在旧站。'
    seedDraft()
    seedCharacter('character-lin', '林岚', {}, {})
    const firstFinalization = await finalize()
    const firstExtraction = await extractedCommit(1, [{
      characterId: 'character-lin',
      currentState: { physicalState: '受伤' },
      evidence: { start: 0, end: prose.length, text: prose },
    }])
    await invoke('finalization-generation:commit', firstExtraction.request)
    const [first] = await listSnapshots('character-lin')
    expect(first).toMatchObject({ source: { finalizationId: firstFinalization.finalizationId }, validity: 'valid' })

    getProjectDb()!.prepare('INSERT INTO contents(id,body) VALUES(2,?)').run(revisedProse)
    getProjectDb()!.prepare("INSERT INTO drafts(id,chapter_number,version,status,content_id,word_count) VALUES(2,1,2,'draft',2,12)").run()
    const secondFinalization = await finalize(2, revisedProse)
    expect(secondFinalization.finalizationId).not.toBe(firstFinalization.finalizationId)
    expect(await listSnapshots('character-lin')).toEqual([
      expect.objectContaining({ snapshotId: first!.snapshotId, validity: 'superseded' }),
    ])
    await expect(invoke('finalized-character:read-state-continuity')).resolves.toEqual([
      expect.objectContaining({ source: expect.objectContaining({ finalizationId: secondFinalization.finalizationId }), status: 'missing-snapshot' }),
    ])

    const secondExtraction = await extractedCommit(2, [{
      characterId: 'character-lin',
      currentState: { physicalState: '康复' },
      evidence: { start: 0, end: revisedProse.length, text: revisedProse },
    }])
    getProjectDb()!.exec(`CREATE TRIGGER reject_revised_chapter_state_snapshot
      BEFORE INSERT ON chapter_character_state_snapshots
      BEGIN SELECT RAISE(ABORT,'SYNTHETIC_REVISED_SNAPSHOT_FAILURE'); END`)
    await expect(invoke('finalization-generation:commit', secondExtraction.request)).rejects.toThrow()
    expect(await listSnapshots('character-lin')).toEqual([
      expect.objectContaining({ snapshotId: first!.snapshotId, validity: 'superseded' }),
    ])

    getProjectDb()!.exec('DROP TRIGGER reject_revised_chapter_state_snapshot')
    await invoke('finalization-generation:commit', secondExtraction.request)
    await invoke('finalization-generation:commit', secondExtraction.request)
    const versions = await listSnapshots('character-lin')
    expect(versions).toHaveLength(2)
    expect(versions).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: expect.objectContaining({ finalizationId: firstFinalization.finalizationId }), validity: 'superseded' }),
      expect.objectContaining({ source: expect.objectContaining({ finalizationId: secondFinalization.finalizationId }), validity: 'valid' }),
    ]))
    expect(new Set(versions.map(version => version.snapshotId)).size).toBe(2)
    expect(secondExtraction.fetch).toHaveBeenCalledTimes(1)
  })

  it('compares any two versions on demand with field changes, provenance, evidence, timing, and validity', async () => {
    const revisedProse = '林岚在北塔御火，伤势已经康复，保持警觉。'
    seedDraft()
    seedCharacter('character-lin', '林岚', {}, {})
    const firstFinalization = await finalize()
    const firstExtraction = await extractedCommit(1, [{
      characterId: 'character-lin',
      currentState: { location: '北塔', powerLevel: '觉醒', physicalState: '受伤' },
      evidence: { start: 0, end: prose.length, text: prose },
    }])
    await invoke('finalization-generation:commit', firstExtraction.request)
    const [first] = await listSnapshots('character-lin')

    getProjectDb()!.prepare('INSERT INTO contents(id,body) VALUES(2,?)').run(revisedProse)
    getProjectDb()!.prepare("INSERT INTO drafts(id,chapter_number,version,status,content_id,word_count) VALUES(2,1,2,'draft',2,12)").run()
    const secondFinalization = await finalize(2, revisedProse)
    const secondExtraction = await extractedCommit(2, [{
      characterId: 'character-lin',
      currentState: { location: '北塔', powerLevel: '御火', physicalState: '', mentalState: '警觉' },
      evidence: { start: 0, end: revisedProse.length, text: revisedProse },
    }])
    await invoke('finalization-generation:commit', secondExtraction.request)
    const versions = await listSnapshots('character-lin')
    const second = versions.find(version => version.snapshotId !== first!.snapshotId)!

    const diff = await invoke<{
      before: { validity: string; character: { characterId: string; displayNameSnapshot: string } }
      after: { validity: string; character: { characterId: string; displayNameSnapshot: string } }
      fields: Array<{ field: string; change: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }>
    }>('finalized-character:compare-state-snapshots', {
      beforeSnapshotId: first!.snapshotId,
      afterSnapshotId: second.snapshotId,
      characterId: 'character-lin',
    })
    expect(diff.before).toMatchObject({ validity: 'superseded', character: { characterId: 'character-lin', displayNameSnapshot: '林岚' } })
    expect(diff.after).toMatchObject({ validity: 'valid', character: { characterId: 'character-lin', displayNameSnapshot: '林岚' } })
    const fields = Object.fromEntries(diff.fields.map(field => [field.field, field]))
    expect(fields.mentalState).toMatchObject({
      change: 'added', before: { value: '' },
      after: {
        value: '警觉', knownAtChapter: 1,
        provenance: { kind: 'derived', source: { finalizationId: secondFinalization.finalizationId } },
        evidence: { text: revisedProse },
      },
    })
    expect(fields.powerLevel).toMatchObject({
      change: 'changed',
      before: { value: '觉醒', provenance: { kind: 'derived', source: { finalizationId: firstFinalization.finalizationId } } },
      after: { value: '御火', knownAtChapter: 1, provenance: { kind: 'derived', source: { finalizationId: secondFinalization.finalizationId } } },
    })
    expect(fields.physicalState).toMatchObject({
      change: 'cleared',
      before: { value: '受伤', knownAtChapter: 1, evidence: { text: prose } },
      after: { value: '', knownAtChapter: null, provenance: { kind: 'legacy' } },
    })
    expect(fields.location).toMatchObject({
      change: 'unchanged',
      before: { value: '北塔', knownAtChapter: 1, provenance: { kind: 'derived', source: { finalizationId: firstFinalization.finalizationId } } },
      after: { value: '北塔', knownAtChapter: 1, provenance: { kind: 'derived', source: { finalizationId: secondFinalization.finalizationId } } },
    })
    expect(diff.fields).toHaveLength(6)
    expect(versions.every(version => !('fields' in (version.character as Record<string, unknown>)))).toBe(true)
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
      expect(restored.pragma('user_version', { simple: true })).toBe(10)
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

  it('explicitly rebuilds from the first gap with frozen predecessors and idempotent run retries', async () => {
    seedCharacter('character-lin', '林岚', {}, {})
    seedDraft(1, 1, '第一章林岚在北塔。', 1, '北塔')
    seedDraft(2, 1, '第二章林岚抵达南桥。', 2, '南桥')
    await finalize(1, '第一章林岚在北塔。', 1, 1, '北塔')
    await finalize(2, '第二章林岚抵达南桥。', 1, 2, '南桥')
    const fetch = stream(JSON.stringify({ updates: [] }))

    const plan = await invoke<{
      range: { startChapter: number; endChapter: number }
      chapters: Array<{ source: { chapterNumber: number }; chapterTitle: string }>
    }>('finalized-character:plan-state-rebuild', {})
    expect(plan).toMatchObject({ range: { startChapter: 1, endChapter: 2 }, chapters: [
      { source: { chapterNumber: 1 }, chapterTitle: '北塔' },
      { source: { chapterNumber: 2 }, chapterTitle: '南桥' },
    ] })
    expect(fetch).not.toHaveBeenCalled()
    await expect(invoke('finalized-character:read-state-cache')).resolves.toMatchObject({ status: 'invalid' })

    const request = { rebuildId: '6b7f1ee6-596f-4b0b-a49b-e157c8d208aa', modelId: model.id, endChapter: 2 }
    const rebuilt = await invoke<{
      status: string
      completedChapters: number
      nextChapterNumber: number | null
      chapters: Array<{ status: string; snapshotId?: string; inputHash?: string; predecessor?: { snapshotId: string } }>
    }>('finalized-character:begin-state-rebuild', request)
    expect(rebuilt).toMatchObject({ status: 'completed', completedChapters: 2, nextChapterNumber: null })
    expect(rebuilt.chapters.map(chapter => chapter.status)).toEqual(['completed', 'completed'])
    expect(fetch).toHaveBeenCalledTimes(2)

    const snapshots = await listSnapshots('character-lin')
    expect(snapshots).toHaveLength(2)
    expect(snapshots.map(snapshot => snapshot.validity)).toEqual(['valid', 'valid'])
    expect(rebuilt.chapters[0]).toMatchObject({ snapshotId: snapshots[0]!.snapshotId, inputHash: snapshots[0]!.inputHash })
    expect(rebuilt.chapters[1]).toMatchObject({
      snapshotId: snapshots[1]!.snapshotId,
      inputHash: snapshots[1]!.inputHash,
      predecessor: { snapshotId: snapshots[0]!.snapshotId },
    })
    expect(snapshots[1]!.baseline).toMatchObject({ predecessor: { snapshotId: snapshots[0]!.snapshotId } })
    await expect(invoke('finalized-character:read-state-cache')).resolves.toMatchObject({ status: 'ready', snapshotId: snapshots[1]!.snapshotId })

    await expect(invoke('finalized-character:begin-state-rebuild', request)).resolves.toEqual(rebuilt)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(await listSnapshots('character-lin')).toEqual(snapshots)
  })

  it('keeps committed rebuild chapters after a failure and resumes from the checkpoint', async () => {
    seedCharacter('character-lin', '林岚', {}, {})
    seedDraft(1, 1, '第一章林岚在北塔。', 1, '北塔')
    seedDraft(2, 1, '第二章林岚抵达南桥。', 2, '南桥')
    await finalize(1, '第一章林岚在北塔。', 1, 1, '北塔')
    await finalize(2, '第二章林岚抵达南桥。', 1, 2, '南桥')
    const rebuildId = 'c5e59af2-c420-4b5f-bb67-e527c06c31d8'
    const first = streamResponses([JSON.stringify({ updates: [] }), '不是 JSON'])
    await expect(invoke('finalized-character:begin-state-rebuild', { rebuildId, modelId: model.id })).rejects.toThrow()
    expect(first).toHaveBeenCalledTimes(2)

    const [failed] = await invoke<Array<Record<string, unknown>>>('finalized-character:list-state-rebuilds')
    expect(failed).toMatchObject({ rebuildId, status: 'failed', completedChapters: 1, nextChapterNumber: 2, canResume: true })
    const committed = await listSnapshots('character-lin')
    expect(committed).toHaveLength(1)
    expect(committed[0]).toMatchObject({ source: { chapterNumber: 1 }, validity: 'valid' })
    await expect(invoke('finalized-character:read-state-cache')).resolves.toMatchObject({ status: 'invalid' })

    const retry = stream(JSON.stringify({ updates: [] }))
    await expect(invoke('finalized-character:resume-state-rebuild', { rebuildId })).resolves.toMatchObject({
      rebuildId, status: 'completed', completedChapters: 2, nextChapterNumber: null,
    })
    expect(retry).toHaveBeenCalledTimes(1)
    const snapshots = await listSnapshots('character-lin')
    expect(snapshots).toHaveLength(2)
    expect(snapshots[0]).toEqual(committed[0])
    expect(snapshots[1]!.baseline).toMatchObject({ predecessor: { snapshotId: committed[0]!.snapshotId } })
    await expect(invoke('finalized-character:read-state-cache')).resolves.toMatchObject({ status: 'ready', snapshotId: snapshots[1]!.snapshotId })
  })

  it('appends a new rebuild run and re-extracts from its new predecessor instead of replaying old patches', async () => {
    const firstProse = '第一章林岚在北塔。'
    const secondProse = '第二章林岚抵达南桥。'
    const revisedProse = '第一章新稿林岚抵达重建北塔。'
    const update = (location: string, content: string) => JSON.stringify({ updates: [{
      characterId: 'character-lin', currentState: { location },
      evidence: { start: 0, end: content.length, text: content },
    }] })
    seedCharacter('character-lin', '林岚', {}, {})
    seedDraft(1, 1, firstProse, 1, '北塔')
    seedDraft(2, 1, secondProse, 2, '南桥')
    await finalize(1, firstProse, 1, 1, '北塔')
    await finalize(2, secondProse, 1, 2, '南桥')
    const firstFetch = streamResponses([update('旧北塔', firstProse), JSON.stringify({ updates: [] })])
    await invoke('finalized-character:begin-state-rebuild', { rebuildId: '2c87d0cd-cf57-4508-a5b0-eb5f9d490aaa', modelId: model.id })
    expect(firstFetch).toHaveBeenCalledTimes(2)
    const before = await listSnapshots('character-lin')

    getProjectDb()!.prepare('INSERT INTO contents(id,body) VALUES(3,?)').run(revisedProse)
    getProjectDb()!.prepare("INSERT INTO drafts(id,chapter_number,version,status,content_id,word_count) VALUES(3,1,2,'draft',3,12)").run()
    const revised = await finalize(3, revisedProse, 1, 1, '新北塔')
    const secondFetch = streamResponses([update('重建北塔', revisedProse), JSON.stringify({ updates: [] })])
    await expect(invoke('finalized-character:begin-state-rebuild', {
      rebuildId: '14f2ea16-e33e-4a04-938f-1f21171d0a4b', modelId: model.id,
    })).resolves.toMatchObject({ status: 'completed', completedChapters: 2 })
    expect(secondFetch).toHaveBeenCalledTimes(2)
    expect(String((secondFetch.mock.calls[1]![1] as { body: string }).body)).toContain('重建北塔')

    const after = await listSnapshots('character-lin')
    expect(after).toHaveLength(4)
    const added = after.filter(snapshot => !before.some(old => old.snapshotId === snapshot.snapshotId))
    expect(added).toHaveLength(2)
    expect(added.map(snapshot => snapshot.validity)).toEqual(['valid', 'valid'])
    expect(after.filter(snapshot => before.some(old => old.snapshotId === snapshot.snapshotId)).map(snapshot => snapshot.validity))
      .toEqual(['superseded', 'superseded'])
    expect(added[1]!.baseline).toMatchObject({ predecessor: { snapshotId: added[0]!.snapshotId } })
    const detail = await readSnapshot(added[1]!.snapshotId as string, 'character-lin')
    expect(detail.character).toMatchObject({ fields: expect.arrayContaining([
      expect.objectContaining({ field: 'location', value: '重建北塔', knownAtChapter: 1,
        provenance: expect.objectContaining({ kind: 'derived', source: expect.objectContaining({ finalizationId: revised.finalizationId }) }) }),
    ]) })
    await expect(invoke('finalized-character:read-state-cache')).resolves.toMatchObject({ status: 'ready', snapshotId: added[1]!.snapshotId })
  })

  it('does not move the current cache when only a historical rebuild range completes', async () => {
    const chapters = ['第一章林岚在北塔。', '第二章林岚经过旧站。', '第三章林岚抵达南桥。']
    const update = (location: string, content: string) => JSON.stringify({ updates: [{
      characterId: 'character-lin', currentState: { location },
      evidence: { start: 0, end: content.length, text: content },
    }] })
    seedCharacter('character-lin', '林岚', {}, {})
    chapters.forEach((content, index) => seedDraft(index + 1, 1, content, index + 1, `第${index + 1}章`))
    for (const [index, content] of chapters.entries()) await finalize(index + 1, content, 1, index + 1, `第${index + 1}章`)
    const first = streamResponses(chapters.map((content, index) => update(['北塔', '旧站', '南桥'][index]!, content)))
    await invoke('finalized-character:begin-state-rebuild', { rebuildId: '3f66f42f-2f0b-442b-b47c-e71916de2f0f', modelId: model.id })
    expect(first).toHaveBeenCalledTimes(3)
    const readCurrent = async () => await invoke<{
      entries: Array<{ currentState?: { location: string } }>
      currentDerivedFields: Record<string, string[]>
    }>('db:character-roster-read', session.projectPath)
    expect((await readCurrent()).entries[0]?.currentState?.location).toBe('南桥')

    const revised = '第一章新稿林岚重建北塔。'
    getProjectDb()!.prepare('INSERT INTO contents(id,body) VALUES(4,?)').run(revised)
    getProjectDb()!.prepare("INSERT INTO drafts(id,chapter_number,version,status,content_id,word_count) VALUES(4,1,2,'draft',4,12)").run()
    await finalize(4, revised, 1, 1, '新北塔')
    const historical = streamResponses([update('重建北塔', revised), update('重建旧站', chapters[1]!)])
    await expect(invoke('finalized-character:begin-state-rebuild', {
      rebuildId: 'e42f42bc-f8a8-4b14-b64e-12f2d012296b', modelId: model.id, endChapter: 2,
    })).resolves.toMatchObject({ status: 'completed', completedChapters: 2, range: { startChapter: 1, endChapter: 2 } })
    expect(historical).toHaveBeenCalledTimes(2)
    await expect(invoke('finalized-character:read-state-cache')).resolves.toMatchObject({ status: 'invalid', reason: 'continuity-incomplete' })
    expect((await readCurrent()).entries[0]?.currentState?.location).toBe('南桥')
    expect((await readCurrent()).currentDerivedFields['character-lin'] ?? []).toEqual([])

    const latest = stream(update('重建南桥', chapters[2]!))
    await invoke('finalized-character:begin-state-rebuild', { rebuildId: '1f4f2f0f-84cf-493b-a0f5-153f5073d1c4', modelId: model.id })
    expect(latest).toHaveBeenCalledTimes(1)
    expect((await readCurrent()).entries[0]?.currentState?.location).toBe('重建南桥')
    await expect(invoke('finalized-character:read-state-cache')).resolves.toMatchObject({ status: 'ready' })
  })

  it('cancels an in-flight rebuild without rolling back or starting the next chapter', async () => {
    seedCharacter('character-lin', '林岚', {}, {})
    for (const chapterNumber of [1, 2, 3]) {
      const content = `第${chapterNumber}章正文。`
      seedDraft(chapterNumber, 1, content, chapterNumber, `第${chapterNumber}章`)
      await finalize(chapterNumber, content, 1, chapterNumber, `第${chapterNumber}章`)
    }
    const rebuildId = '73a3d526-e4a3-4a53-9e3f-cf47c1165e3f'
    let calls = 0
    let secondStarted!: () => void
    const second = new Promise<void>(resolve => { secondStarted = resolve })
    const fetch = vi.fn(async (url: unknown, init?: { body?: string; signal?: AbortSignal }) => {
      void url
      void init
      calls++
      if (calls === 2) {
        secondStarted()
        return await new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('已取消', 'AbortError')), { once: true })
        })
      }
      const content = JSON.stringify({ updates: [] })
      return {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`))
            controller.close()
          },
        }),
      }
    })
    vi.stubGlobal('fetch', fetch)
    const pending = invoke<Record<string, unknown>>('finalized-character:begin-state-rebuild', { rebuildId, modelId: model.id })
    await second
    await expect(invoke('finalized-character:cancel-state-rebuild', { rebuildId })).resolves.toMatchObject({
      rebuildId, status: 'cancelled', completedChapters: 1, nextChapterNumber: 2, canResume: false,
    })
    await expect(pending).resolves.toMatchObject({ rebuildId, status: 'cancelled', completedChapters: 1, nextChapterNumber: 2 })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(await listSnapshots('character-lin')).toHaveLength(1)
    await expect(invoke('finalized-character:read-state-cache')).resolves.toMatchObject({ status: 'invalid' })

    const retry = stream(JSON.stringify({ updates: [] }))
    await expect(invoke('finalized-character:resume-state-rebuild', { rebuildId })).resolves.toMatchObject({ status: 'cancelled' })
    expect(retry).not.toHaveBeenCalled()
    expect(await listSnapshots('character-lin')).toHaveLength(1)
  })

  it('reopens a failed rebuild without automatic dispatch and resumes with the new project session', async () => {
    seedCharacter('character-lin', '林岚', {}, {})
    seedDraft(1, 1, '第一章林岚在北塔。', 1, '北塔')
    seedDraft(2, 1, '第二章林岚抵达南桥。', 2, '南桥')
    await finalize(1, '第一章林岚在北塔。', 1, 1, '北塔')
    await finalize(2, '第二章林岚抵达南桥。', 1, 2, '南桥')
    const rebuildId = '31f2aa8b-8c8f-4a17-a3f0-fbe3dc0db0f7'
    const first = streamResponses([JSON.stringify({ updates: [] }), '无效提取'])
    await expect(invoke('finalized-character:begin-state-rebuild', { rebuildId, modelId: model.id })).rejects.toThrow()
    expect(first).toHaveBeenCalledTimes(2)

    closeProjectDatabase()
    projectAccess.invalidateCurrentSession()
    const reopened = projectAccess.probeExistingProject(session.projectPath)
    if (reopened.kind !== 'manifest') throw new Error('Expected a manifest project')
    initProjectDatabase(reopened.rootPath)
    session = { ...session, leaseId: projectAccess.beginSession(reopened).leaseId }
    const retry = stream(JSON.stringify({ updates: [] }))
    await expect(invoke('finalized-character:list-state-rebuilds')).resolves.toEqual([
      expect.objectContaining({ rebuildId, status: 'failed', completedChapters: 1, nextChapterNumber: 2, canResume: true }),
    ])
    expect(retry).not.toHaveBeenCalled()

    await expect(invoke('finalized-character:resume-state-rebuild', { rebuildId })).resolves.toMatchObject({
      rebuildId, status: 'completed', completedChapters: 2, nextChapterNumber: null,
    })
    expect(retry).toHaveBeenCalledTimes(1)
    expect(await listSnapshots('character-lin')).toHaveLength(2)
    await expect(mocks.handlers.get('finalized-character:resume-state-rebuild')!({ sender }, { rebuildId }, {
      ...session, leaseId: 'stale-lease',
    })).rejects.toThrow('GENERATION_PROJECT_SESSION_STALE')
  })

  it('offers the latest chapter for an explicit rebuild when only the cache needs repair', async () => {
    seedDraft()
    seedCharacter('character-lin', '林岚', {}, {})
    getProjectDb()!.transaction(() => refreshCharacterIdentityProjection(getProjectDb()!))()
    await finalize()
    const extraction = await extractedCommit(1, [])
    const roster = await invoke<{ revision: number; identityRevision: number; schemaVersion: 1; entries: Array<Record<string, unknown>> }>(
      'db:character-roster-read', session.projectPath,
    )
    const entry = roster.entries.find(item => item.characterId === 'character-lin')!
    await invoke('db:character-roster-commit', {
      operationId: 'author-before-cache-rebuild', expectedRevision: roster.revision, expectedIdentityRevision: roster.identityRevision,
      schemaVersion: roster.schemaVersion, intent: 'manual_edit',
      entries: [{ ...entry, currentState: { location: '作者保留地点', powerLevel: '', physicalState: '', mentalState: '', keyItems: '', recentEvents: '', updatedAtChapter: 1 } }],
    }, session.projectPath)
    await expect(invoke('finalization-generation:commit', extraction.request)).resolves.toMatchObject({ cacheStatus: 'rebuild-required', cacheConflict: true })
    await expect(invoke('finalized-character:read-state-continuity')).resolves.toEqual([
      expect.objectContaining({ status: 'valid', source: expect.objectContaining({ chapterNumber: 1 }) }),
    ])
    await expect(invoke('finalized-character:plan-state-rebuild', {})).resolves.toMatchObject({ range: { startChapter: 1, endChapter: 1 } })

    const rebuild = stream(JSON.stringify({ updates: [] }))
    await expect(invoke('finalized-character:begin-state-rebuild', {
      rebuildId: '3dd4f879-356f-44c3-a580-e9ae14a7ef0c', modelId: model.id,
    })).resolves.toMatchObject({ status: 'completed', completedChapters: 1 })
    expect(rebuild).toHaveBeenCalledTimes(1)
    expect(await listSnapshots('character-lin')).toHaveLength(2)
    await expect(invoke('finalized-character:read-state-cache')).resolves.toMatchObject({ status: 'ready' })
    const current = await invoke<{ entries: Array<{ currentState?: { location: string } }> }>('db:character-roster-read', session.projectPath)
    expect(current.entries[0]?.currentState?.location).toBe('作者保留地点')
  })

  it('keeps known snapshots and identity proposals when other occurrences are unknown or ambiguous', async () => {
    seedDraft()
    seedCharacter('character-lin', '林岚', {}, {})
    seedCharacter('character-zhou', '周研', {}, {})
    seedCharacter('character-zhou-twin', '周研', {}, {})
    await finalize()
    const extraction = await extractedCommit(1, [
      {
        characterId: 'character-lin', name: '林岚', currentState: { physicalState: '受伤' },
        evidence: { start: 0, end: prose.length, text: prose },
      },
      {
        characterId: 'character-unknown', name: '陌生人', currentState: { location: '南桥' },
        evidence: { start: 0, end: prose.length, text: prose },
      },
      {
        characterId: 'character-zhou', name: '周研', currentState: { location: '旧站' },
        evidence: { start: 0, end: prose.length, text: prose },
      },
    ])

    const effect = await invoke<Record<string, unknown>>('finalization-generation:commit', extraction.request)
    expect(effect).toMatchObject({
      success: true,
      proposalBatchId: expect.any(String),
      unresolved: [
        expect.objectContaining({ reason: 'unknown-id', displayName: '陌生人' }),
        expect.objectContaining({ reason: 'ambiguous', displayName: '周研' }),
      ],
    })
    const [summary] = await listSnapshots('character-lin')
    expect(summary).toBeTruthy()
    const detail = await readSnapshot(summary!.snapshotId as string, 'character-lin')
    expect(detail.character).toMatchObject({
      characterId: 'character-lin',
      fields: expect.arrayContaining([expect.objectContaining({ field: 'physicalState', value: '受伤' })]),
    })
    expect(detail.unresolved).toEqual([
      expect.objectContaining({ reason: 'unknown-id', displayName: '陌生人', candidateIds: [] }),
      expect.objectContaining({ reason: 'ambiguous', displayName: '周研', candidateIds: ['character-zhou', 'character-zhou-twin'] }),
    ])
    await expect(invoke('character-proposal:list-pending-finalized')).resolves.toEqual([
      expect.objectContaining({ finalizationId: extraction.source.finalizationId }),
    ])
    const roster = await invoke<{ entries: Array<{ characterId: string }> }>('db:character-roster-read', session.projectPath)
    expect(roster.entries.map(entry => entry.characterId)).not.toContain('character-unknown')
  })

  it('deletes every snapshot version and identity source with its chapter while retaining invalid later history', async () => {
    const firstProse = '第一章旧正文，林岚受伤。'
    const revisedProse = '第一章新正文，林岚康复。'
    const laterProse = '第二章林岚抵达南桥。'
    seedCharacter('character-lin', '林岚', {}, {})
    seedDraft(1, 1, firstProse)
    const firstFinalization = await finalize(1, firstProse)
    const first = await extractedCommit(1, [{
      characterId: 'character-unknown', name: '陌生人', currentState: { location: '北塔' },
      evidence: { start: 0, end: firstProse.length, text: firstProse },
    }])
    await invoke('finalization-generation:commit', first.request)
    getProjectDb()!.prepare('INSERT INTO contents(id,body) VALUES(2,?)').run(revisedProse)
    getProjectDb()!.prepare("INSERT INTO drafts(id,chapter_number,version,status,content_id,word_count) VALUES(2,1,2,'draft',2,12)").run()
    const revisedFinalization = await finalize(2, revisedProse, 1, 1, '北塔修订')
    const revised = await extractedCommit(2, [])
    await invoke('finalization-generation:commit', revised.request)
    seedDraft(3, 1, laterProse, 2, '南桥')
    const laterFinalization = await finalize(3, laterProse, 1, 2, '南桥')
    const later = await extractedCommit(3, [])
    await invoke('finalization-generation:commit', later.request)
    const before = await listSnapshots('character-lin')
    expect(before).toHaveLength(3)
    getProjectDb()!.prepare("INSERT INTO post_process_runs(id,trigger_source_type,trigger_source_id) VALUES('chapter-1-no-kb','chapter_finalize',?)")
      .run(`finalization:${revisedFinalization.finalizationId}`)

    const deletion = await invoke<Record<string, unknown>>('chapter:delete-finalized', {
      draftId: 2, chapterNumber: 1,
    }, session.projectPath)
    expect(deletion).toMatchObject({ success: true, committed: true, operation: { status: 'completed' } })
    await expect(invoke('chapter:delete-finalized', { draftId: 2, chapterNumber: 1 }, session.projectPath)).resolves.toEqual(deletion)

    const remaining = await listSnapshots('character-lin')
    expect(remaining).toHaveLength(1)
    expect(remaining[0]).toMatchObject({
      source: { finalizationId: laterFinalization.finalizationId },
      validity: 'invalid',
    })
    for (const snapshot of before.filter(item => (item.source as { chapterNumber: number }).chapterNumber === 1)) {
      await expect(readSnapshot(snapshot.snapshotId as string, 'character-lin')).resolves.toBeNull()
    }
    await expect(readSnapshot(remaining[0]!.snapshotId as string, 'character-lin')).resolves.toMatchObject({
      status: 'invalid', unresolved: [],
    })
    await expect(invoke('finalized-character:read-state-continuity')).resolves.toEqual([
      expect.objectContaining({
        source: expect.objectContaining({ chapterNumber: 2 }),
        status: 'invalid-snapshot', invalidatedByChange: true,
      }),
    ])
    const deletedFinalizationIds = [firstFinalization.finalizationId, revisedFinalization.finalizationId]
    const deletedSnapshotIds = before.filter(item => (item.source as { chapterNumber: number }).chapterNumber === 1)
      .map(item => item.snapshotId as string)
    const proposalIds = [
      ...deletedFinalizationIds.map(id => `fcs:${id}`),
      ...deletedSnapshotIds.map(id => `fcu:${id}`),
    ]
    const proposalRows = getProjectDb()!.prepare(`SELECT proposal_id FROM character_identity_proposals
      WHERE proposal_id IN (${proposalIds.map(() => '?').join(',')})`).all(...proposalIds)
    expect(proposalRows).toEqual([])
    for (const table of ['chapter_character_state_snapshots', 'chapter_character_state_snapshot_characters', 'chapter_character_state_snapshot_fields']) {
      expect(getProjectDb()!.prepare(`SELECT COUNT(*) FROM ${table} WHERE snapshot_id IN (${deletedSnapshotIds.map(() => '?').join(',')})`)
        .pluck().get(...deletedSnapshotIds)).toBe(0)
    }
    expect(getProjectDb()!.pragma('foreign_key_check')).toEqual([])
  })

  it('preserves historical names and aliases across rename and merge-delete retirement without reviving the old ID', async () => {
    const firstProse = '第一章林岚在北塔受伤。'
    const secondProse = '第二章林岚抵达南桥。'
    seedCharacter('character-old', '林岚', {}, {})
    seedCharacter('character-survivor', '林澜', {}, {})
    getProjectDb()!.transaction(() => refreshCharacterIdentityProjection(getProjectDb()!))()
    seedDraft(1, 1, firstProse)
    await finalize(1, firstProse)
    const first = await extractedCommit(1, [{
      characterId: 'character-old', currentState: { physicalState: '受伤' },
      evidence: { start: 0, end: firstProse.length, text: firstProse },
    }])
    await invoke('finalization-generation:commit', first.request)
    const [oldSummary] = await listSnapshots('character-old')
    const oldDetail = await readSnapshot(oldSummary!.snapshotId as string, 'character-old')
    expect(oldDetail.character).toMatchObject({ displayNameSnapshot: '林岚', aliases: ['林岚'] })
    type Roster = {
      revision: number
      identityRevision: number
      schemaVersion: 1
      entries: Array<Record<string, unknown> & { characterId: string; name: string }>
    }
    const beforeRename = await invoke<Roster>('db:character-roster-read', session.projectPath)
    await invoke('db:character-roster-commit', {
      operationId: 'rename-old-character', expectedRevision: beforeRename.revision,
      expectedIdentityRevision: beforeRename.identityRevision, schemaVersion: beforeRename.schemaVersion, intent: 'manual_edit',
      entries: beforeRename.entries.map(entry => entry.characterId === 'character-old' ? { ...entry, name: '林岚新' } : entry),
      renames: [{ characterId: 'character-old', newName: '林岚新' }],
    }, session.projectPath)
    expect(await readSnapshot(oldSummary!.snapshotId as string, 'character-old')).toEqual(oldDetail)

    const beforeMerge = await invoke<Roster>('db:character-roster-read', session.projectPath)
    const survivor = beforeMerge.entries.find(entry => entry.characterId === 'character-survivor')!
    const merge = await invoke<{ success: boolean; error?: string }>('db:character-roster-commit', {
      operationId: 'merge-delete-old-character', expectedRevision: beforeMerge.revision,
      expectedIdentityRevision: beforeMerge.identityRevision, schemaVersion: beforeMerge.schemaVersion, intent: 'manual_edit',
      entries: [{ ...survivor, name: '林岚' }],
      renames: [{ characterId: 'character-survivor', newName: '林岚' }],
    }, session.projectPath)
    expect(merge.error).toBeUndefined()
    expect(await readSnapshot(oldSummary!.snapshotId as string, 'character-old')).toEqual(oldDetail)

    seedDraft(2, 1, secondProse, 2, '南桥')
    await finalize(2, secondProse, 1, 2, '南桥')
    const second = await extractedCommit(2, [])
    await invoke('finalization-generation:commit', second.request)
    const current = await invoke<Roster>('db:character-roster-read', session.projectPath)
    expect(current.entries.map(entry => entry.characterId)).toEqual(['character-survivor'])
    expect(current.entries[0]!.name).toBe('林岚')
    expect(await listSnapshots('character-old')).toEqual([oldSummary])
    expect(await listSnapshots('character-survivor')).toHaveLength(2)
    await expect(invoke('finalized-character:read-state-cache')).resolves.toMatchObject({ status: 'ready' })
    expect(second.fetch).toHaveBeenCalledTimes(1)
  })

  it('fails the whole extraction when any occurrence has no determinable identity', async () => {
    seedDraft()
    seedCharacter('character-lin', '林岚', {}, {})
    await finalize()
    const extraction = await extractedCommit(1, [
      {
        characterId: 'character-lin', currentState: { physicalState: '受伤' },
        evidence: { start: 0, end: prose.length, text: prose },
      },
      {
        currentState: { location: '南桥' },
        evidence: { start: 0, end: prose.length, text: prose },
      },
    ])

    await expect(invoke('finalization-generation:commit', extraction.request))
      .rejects.toThrow('FINALIZED_CHARACTER_IDENTITY_REQUIRED')
    expect(await listSnapshots('character-lin')).toEqual([])
    await expect(invoke('character-proposal:list-pending-finalized')).resolves.toEqual([])
    await expect(invoke('db:draft-get-full', 1, session.projectPath)).resolves.toMatchObject({ status: 'finalized', content: prose })
    const roster = await invoke<{ entries: Array<{ currentState?: { physicalState: string } }> }>(
      'db:character-roster-read', session.projectPath,
    )
    expect(roster.entries[0]?.currentState?.physicalState ?? '').toBe('')
  })

  it('creates a rewrite draft for old prose and appends a new snapshot only after refinalization', async () => {
    const oldProse = '林岚在北塔受伤。'
    const currentProse = '林岚在北塔康复。'
    seedCharacter('character-lin', '林岚', {}, {})
    seedDraft(1, 1, oldProse)
    await finalize(1, oldProse)
    const first = await extractedCommit(1, [{
      characterId: 'character-lin', currentState: { physicalState: '受伤' },
      evidence: { start: 0, end: oldProse.length, text: oldProse },
    }])
    await invoke('finalization-generation:commit', first.request)
    const [firstSummary] = await listSnapshots('character-lin')
    const firstDetail = await readSnapshot(firstSummary!.snapshotId as string, 'character-lin')
    getProjectDb()!.prepare('INSERT INTO contents(id,body) VALUES(2,?)').run(currentProse)
    getProjectDb()!.prepare("INSERT INTO drafts(id,chapter_number,version,status,content_id,word_count) VALUES(2,1,2,'draft',2,12)").run()
    await finalize(2, currentProse)
    const second = await extractedCommit(2, [{
      characterId: 'character-lin', currentState: { physicalState: '康复' },
      evidence: { start: 0, end: currentProse.length, text: currentProse },
    }])
    await invoke('finalization-generation:commit', second.request)

    const oldDraft = await invoke<{ content: string }>('db:draft-get-full', 1, session.projectPath)
    const nextVersion = await invoke<number>('db:draft-next-version', 1, session.projectPath)
    const rollback = await invoke<{ success: boolean; id?: number }>('db:draft-create', {
      chapterNumber: 1, version: nextVersion, source: 'rewrite', content: oldDraft.content, wordCount: 12,
    }, session.projectPath)
    expect(rollback).toMatchObject({ success: true, id: expect.any(Number) })
    expect(await listSnapshots('character-lin')).toHaveLength(2)
    const beforeRefinalization = await invoke<{ entries: Array<{ currentState?: { physicalState: string } }> }>(
      'db:character-roster-read', session.projectPath,
    )
    expect(beforeRefinalization.entries[0]?.currentState?.physicalState).toBe('康复')
    await expect(invoke('db:draft-get-full', rollback.id, session.projectPath)).resolves.toMatchObject({
      status: 'draft', source: 'rewrite', content: oldProse,
    })

    const rollbackFinalization = await finalize(rollback.id, oldProse, 1, 1, '北塔回退')
    expect(await listSnapshots('character-lin')).toHaveLength(2)
    const third = await extractedCommit(rollback.id!, [{
      characterId: 'character-lin', currentState: { physicalState: '受伤' },
      evidence: { start: 0, end: oldProse.length, text: oldProse },
    }])
    await invoke('finalization-generation:commit', third.request)
    const versions = await listSnapshots('character-lin')
    expect(versions).toHaveLength(3)
    expect(versions.filter(version => version.validity === 'valid')).toEqual([
      expect.objectContaining({ source: expect.objectContaining({ finalizationId: rollbackFinalization.finalizationId }) }),
    ])
    expect(versions.filter(version => version.validity === 'superseded')).toHaveLength(2)
    const thirdSummary = versions.find(version => (version.source as { finalizationId: string }).finalizationId === rollbackFinalization.finalizationId)!
    const thirdDetail = await readSnapshot(thirdSummary.snapshotId as string, 'character-lin')
    expect(thirdSummary.snapshotId).not.toBe(firstSummary!.snapshotId)
    expect(thirdDetail.character).toMatchObject({
      fields: expect.arrayContaining([expect.objectContaining({
        field: 'physicalState', value: '受伤',
        provenance: expect.objectContaining({ kind: 'derived', source: expect.objectContaining({ finalizationId: rollbackFinalization.finalizationId }) }),
      })]),
    })
    expect(await readSnapshot(firstSummary!.snapshotId as string, 'character-lin')).toEqual({
      ...firstDetail,
      status: 'invalid',
      validity: 'superseded',
    })
  })
})
