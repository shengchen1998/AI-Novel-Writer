import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ChapterCharacterStateRebuildPlan, ChapterCharacterStateRebuildStatus } from '../../../shared/chapter-character-state-rebuild'
import { displayedErrorMessage } from '../../../i18n/app-errors'
import { ipc } from '../../../services/ipc-client'
import { isGenerationModel, preferredGenerationModelId } from '../../../services/workflows/chapter-write-launch'
import { randomUUID } from '../../../utils/id'
import { pluralEn } from '../../../shared/plural-en'
import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { captureProjectSession, isProjectSessionCurrent } from '../../project-session-gate'
import { Button } from '../../ui/Button'
import { InlineConfirm } from '../../ui/InlineConfirm'
import { Notice } from '../../ui/Notice'

export default function CharacterStateRebuild() {
  const text = useLocaleStore(s => s.text)
  const project = useProjectStore(s => s.currentProject)
  const sessionKey = project ? `${project.id}:${project.sessionLease}` : 'inactive'
  const models = useLLMStore(s => s.models)
  const defaultModelId = useLLMStore(s => s.defaultModelId)
  const generationModels = models.filter(isGenerationModel)
  const preferredModelId = preferredGenerationModelId(generationModels, defaultModelId)
  const [plan, setPlan] = useState<ChapterCharacterStateRebuildPlan | null>(null)
  const [runs, setRuns] = useState<ChapterCharacterStateRebuildStatus[]>([])
  const [readySession, setReadySession] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [endChapter, setEndChapter] = useState<number | null>(null)
  const [modelId, setModelId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const busyRef = useRef(false)
  const ids = { model: useId(), end: useId() }

  const load = useCallback(async () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session) return
    try {
      const [nextPlan, nextRuns] = await Promise.all([
        ipc.invokeWithProjectSession(session, 'finalized-character:plan-state-rebuild', {}),
        ipc.invokeWithProjectSession(session, 'finalized-character:list-state-rebuilds'),
      ])
      const current = useProjectStore.getState().currentProject
      if (!isProjectSessionCurrent(session) || !current || `${current.id}:${current.sessionLease}` !== sessionKey) return
      setPlan(nextPlan)
      setRuns(nextRuns)
      setError(null)
      setReadySession(sessionKey)
    } catch (failure) {
      if (isProjectSessionCurrent(session)) {
        setError(displayedErrorMessage(useLocaleStore.getState().locale, failure, text('无法读取章节状态重建。', 'Could not load chapter-state rebuilds.')))
        setReadySession(sessionKey)
      }
    }
  }, [sessionKey, text])

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0)
    const off = ipc.on('generation:snapshot', snapshot => {
      if (['completed', 'failed', 'cancelled'].includes(snapshot.status) && !busyRef.current) void load()
    })
    return () => { clearTimeout(timer); off() }
  }, [load])

  const act = async (kind: 'begin' | 'resume' | 'cancel', rebuildId: string, targetEndChapter?: number) => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || busyRef.current) return
    setBusy(true)
    busyRef.current = true
    setError(null)
    try {
      if (kind === 'begin') {
        await ipc.invokeWithProjectSession(session, 'finalized-character:begin-state-rebuild', {
          rebuildId, modelId: modelId ?? preferredModelId ?? '', ...(targetEndChapter !== undefined ? { endChapter: targetEndChapter } : {}),
        })
      } else if (kind === 'resume') {
        await ipc.invokeWithProjectSession(session, 'finalized-character:resume-state-rebuild', { rebuildId })
      } else {
        await ipc.invokeWithProjectSession(session, 'finalized-character:cancel-state-rebuild', { rebuildId })
      }
      if (isProjectSessionCurrent(session)) setConfirming(false)
      await load()
    } catch (failure) {
      if (isProjectSessionCurrent(session)) {
        setError(displayedErrorMessage(useLocaleStore.getState().locale, failure, text('章节状态重建失败。', 'Chapter-state rebuild failed.')))
        await load()
      }
    } finally {
      busyRef.current = false
      if (isProjectSessionCurrent(session)) setBusy(false)
    }
  }

  if (readySession !== sessionKey) return <p className="run-note" role="status">{text('正在读取重建状态…', 'Loading rebuild status…')}</p>
  if (!plan && runs.length === 0 && !error) return null
  const selectedModelId = modelId ?? preferredModelId
  const selectedEnd = endChapter ?? plan?.range.endChapter ?? null
  const chapters = plan?.chapters.filter(chapter => selectedEnd !== null && chapter.source.chapterNumber <= selectedEnd) ?? []
  return (
    <section className="run-recovery" aria-label={text('章节状态重建', 'Chapter-state rebuild')}>
      {error && <Notice tone="danger" title={error} />}
      {runs.map(run => (
        <article className="run-card" data-state={run.status === 'failed' ? 'failed' : run.status === 'completed' ? 'completed' : 'recoverable'} key={run.rebuildId}>
          <header className="run-card-heading">
            <p className="run-card-kicker">{text('章节状态重建', 'Chapter-state rebuild')}</p>
            <h3 className="run-card-title">{text(
              `第 ${run.range.startChapter} 至 ${run.range.endChapter} 章`,
              `Chapters ${run.range.startChapter}–${run.range.endChapter}`,
            )}</h3>
          </header>
          <p className="run-note">{text(`已完成 ${run.completedChapters}/${run.chapters.length} 章`,
            `${run.completedChapters}/${run.chapters.length} ${pluralEn(run.chapters.length, 'chapter')} complete`)}</p>
          <progress max={run.chapters.length} value={run.completedChapters} aria-label={text('重建进度', 'Rebuild progress')} />
          {run.nextChapterNumber !== null && run.status !== 'completed' && (
            <p className="run-note">{text(`断点：下一章为第 ${run.nextChapterNumber} 章`, `Checkpoint: next is chapter ${run.nextChapterNumber}.`)}</p>
          )}
          {run.status === 'failed' && <Notice tone="danger" title={text('重建失败，已完成进度已保留。', 'Rebuild failed; completed chapters are preserved.')} />}
          {run.status === 'cancelled' && <p className="run-note">{text('重建已取消，已完成进度已保留。', 'Rebuild cancelled; completed chapters are preserved.')}</p>}
          {run.status === 'completed' && <Notice tone="ok" title={text('重建完成。', 'Rebuild complete.')} />}
          {run.sourceStatus === 'conflict' && <Notice tone="danger" title={text('定稿来源已变化，请重新确认重建范围。', 'Finalized sources changed; review a new rebuild range.')} />}
          <ol className="run-note">
            {run.chapters.map(chapter => <li key={chapter.source.finalizationId}>{text(
              `第 ${chapter.source.chapterNumber} 章 · ${chapter.chapterTitle} · ${chapterStatus(chapter.status, 'zh')}`,
              `Chapter ${chapter.source.chapterNumber} · ${chapter.chapterTitle} · ${chapterStatus(chapter.status, 'en')}`,
            )}</li>)}
          </ol>
          <div className="run-card-buttons">
            {run.canResume && run.nextChapterNumber !== null && (
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => void act('resume', run.rebuildId)}>
                {text(`从第 ${run.nextChapterNumber} 章继续重建`, `Resume rebuild at chapter ${run.nextChapterNumber}`)}
              </Button>
            )}
            {run.status === 'running' && <Button variant="text" size="sm" disabled={busy} onClick={() => void act('cancel', run.rebuildId)}>{text('取消重建', 'Cancel rebuild')}</Button>}
          </div>
        </article>
      ))}
      {plan && !confirming && (
        <Button ref={triggerRef} variant="secondary" size="sm" disabled={busy} onClick={() => {
          setEndChapter(plan.range.endChapter)
          setConfirming(true)
        }}>{text('重建章节状态…', 'Rebuild chapter state…')}</Button>
      )}
      {plan && confirming && selectedEnd !== null && (
        <div className="run-card">
          <p className="run-note">{text(
            `重建范围：第 ${plan.range.startChapter} 至 ${selectedEnd} 章 · ${chapters.map(chapter => chapter.chapterTitle).join('、')}`,
            `Rebuild range: chapters ${plan.range.startChapter}–${selectedEnd} · ${chapters.map(chapter => chapter.chapterTitle).join(', ')}`,
          )}</p>
          <div className="pi-field">
            <label htmlFor={ids.model}>{text('本次模型', 'Model for this rebuild')}</label>
            <select id={ids.model} className="pi-input" value={selectedModelId ?? ''} disabled={busy || generationModels.length === 0}
              onChange={event => setModelId(event.target.value || null)}>
              <option value="" disabled>{text('请选择生成模型', 'Select a generation model')}</option>
              {generationModels.map(model => <option key={model.id} value={model.id}>{model.name || model.modelName}</option>)}
            </select>
          </div>
          <div className="pi-field">
            <label htmlFor={ids.end}>{text('重建到第几章', 'Last chapter to rebuild')}</label>
            <select id={ids.end} className="pi-input" value={selectedEnd} disabled={busy} onChange={event => setEndChapter(Number(event.target.value))}>
              {plan.chapters.map(chapter => <option key={chapter.source.finalizationId} value={chapter.source.chapterNumber}>
                {text(`第 ${chapter.source.chapterNumber} 章 · ${chapter.chapterTitle}`, `Chapter ${chapter.source.chapterNumber} · ${chapter.chapterTitle}`)}
              </option>)}
            </select>
          </div>
          {selectedModelId ? (
            <InlineConfirm
              message={text(
                `将重新提取 ${chapters.length} 章并逐章调用模型；已完成的章节会保留。`,
                `Re-extract ${chapters.length} ${chapters.length === 1 ? 'chapter' : 'chapters'} with one model call per chapter; completed chapters are preserved.`,
              )}
              confirmLabel={text('确认重建并调用模型', 'Confirm rebuild and model calls')}
              cancelLabel={text('取消', 'Cancel')}
              returnFocusRef={triggerRef}
              onCancel={() => setConfirming(false)}
              onConfirm={() => void act('begin', randomUUID(), selectedEnd)}
            />
          ) : <Notice tone="danger" title={text('请先在设置中配置生成模型。', 'Configure a generation model in Settings first.')} />}
        </div>
      )}
    </section>
  )
}

function chapterStatus(status: ChapterCharacterStateRebuildStatus['chapters'][number]['status'], locale: 'zh' | 'en'): string {
  const labels = {
    pending: ['等待', 'Pending'], running: ['进行中', 'Running'], failed: ['失败', 'Failed'],
    cancelled: ['已取消', 'Cancelled'], completed: ['已完成', 'Complete'],
  } as const
  return labels[status][locale === 'zh' ? 0 : 1]
}
