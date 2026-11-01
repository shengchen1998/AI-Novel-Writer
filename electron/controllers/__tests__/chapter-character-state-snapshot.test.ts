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
})
