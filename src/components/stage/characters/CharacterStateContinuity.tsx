import { useEffect, useState } from 'react'
import { ipc } from '../../../services/ipc-client'
import { useLocaleStore } from '../../../stores/locale-store'
import type { ChapterCharacterStateCacheStatus, ChapterCharacterStateContinuityEntry } from '../../../shared/chapter-character-state-snapshot'

export default function CharacterStateContinuity() {
  const text = useLocaleStore(s => s.text)
  const [entries, setEntries] = useState<ChapterCharacterStateContinuityEntry[]>([])
  const [cache, setCache] = useState<ChapterCharacterStateCacheStatus | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    let active = true
    void ipc.invoke('finalized-character:read-state-continuity').then(result => {
      if (!active) return
      setEntries(result)
      setStatus('ready')
    }).catch(() => {
      if (active) setStatus('error')
    })
    void ipc.invoke('finalized-character:read-state-cache').then(result => {
      if (active) setCache(result)
    }).catch(() => {
      if (active) setCache(null)
    })
    return () => { active = false }
  }, [])

  if (status === 'loading') {
    return <p className="run-note" role="status">{text('正在读取章节状态链…', 'Loading chapter-state continuity…')}</p>
  }
  if (status === 'error') {
    return <p className="run-note" data-tone="danger" role="alert">{text('章节状态链暂时无法读取。', 'Chapter-state continuity could not be loaded.')}</p>
  }
  if (entries.length === 0) return null
  const latestValid = [...entries].reverse().find(entry => entry.status === 'valid' && entry.snapshot)
  const predecessor = latestValid?.snapshot?.baseline.predecessor
  const invalidated = entries.filter(entry => entry.invalidatedByChange)
  const invalidationStart = invalidated[0]?.source.chapterNumber
  const invalidationEnd = invalidated.at(-1)?.source.chapterNumber
  return (
    <section className="cast-continuity" aria-label={text('章节状态连续性', 'Chapter-state continuity')}>
      {invalidationStart !== undefined && invalidationEnd !== undefined && (
        <p className="run-note" data-tone="danger">{invalidationStart === invalidationEnd
          ? text(`失效范围：第 ${invalidationStart} 章；旧快照保留为历史。`, `Invalidated range: chapter ${invalidationStart}; previous snapshots are retained as history.`)
          : text(`失效范围：第 ${invalidationStart} 至 ${invalidationEnd} 章；旧快照保留为历史。`, `Invalidated range: chapters ${invalidationStart}–${invalidationEnd}; previous snapshots are retained as history.`)}</p>
      )}
      {cache?.status === 'rebuild-required' && (
        <p className="run-note" data-tone="danger">{text(
          '缓存待重建；章节快照和作者编辑已保留，当前派生状态不可用。',
          'Cache rebuild required. Chapter snapshots and author edits are preserved; current derived state is unavailable.',
        )}</p>
      )}
      {cache?.status === 'invalid' && (
        <p className="run-note" data-tone="danger">{text(
          '连续状态链尚未到达最新定稿，当前派生缓存不可用。',
          'The continuous state chain has not reached the latest finalization; the current derived cache is unavailable.',
        )}</p>
      )}
      {latestValid?.snapshot && (
        <div>
          <p className="run-note">{text(
            `当前基线：第 ${latestValid.source.chapterNumber} 章 · ${latestValid.chapterTitle}`,
            `Current baseline: chapter ${latestValid.source.chapterNumber} · ${latestValid.chapterTitle}`,
          )}</p>
          <p className="run-note">{predecessor
            ? text(`继承第 ${predecessor.source.chapterNumber} 章快照`, `Inherited from the chapter ${predecessor.source.chapterNumber} snapshot`)
            : text('角色名单初始基线', 'Initial roster baseline')}</p>
        </div>
      )}
      {entries.filter(entry => entry.status !== 'valid').map(entry => (
        <p className="run-note" data-tone={entry.status === 'valid' ? undefined : 'danger'} key={entry.source.finalizationId}>
          {entry.status === 'waiting-predecessor' && text(
            `第 ${entry.source.chapterNumber} 章等待前驱：第 ${entry.predecessorGapChapterNumber} 章缺少有效快照。`,
            `Chapter ${entry.source.chapterNumber} is waiting for its predecessor: chapter ${entry.predecessorGapChapterNumber} has no valid snapshot.`,
          )}
          {entry.status === 'missing-snapshot' && text(
            `第 ${entry.source.chapterNumber} 章缺少角色状态快照。`,
            `Chapter ${entry.source.chapterNumber} has no character-state snapshot.`,
          )}
          {entry.status === 'invalid-snapshot' && text(
            `第 ${entry.source.chapterNumber} 章快照与当前连续基线不一致。`,
            `The chapter ${entry.source.chapterNumber} snapshot does not match the current continuous baseline.`,
          )}
        </p>
      ))}
    </section>
  )
}
