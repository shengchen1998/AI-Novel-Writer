import { useEffect, useState } from 'react'
import { ipc } from '../../../services/ipc-client'
import { useLocaleStore } from '../../../stores/locale-store'
import type { ChapterCharacterStateContinuityEntry } from '../../../shared/chapter-character-state-snapshot'

export default function CharacterStateContinuity() {
  const text = useLocaleStore(s => s.text)
  const [entries, setEntries] = useState<ChapterCharacterStateContinuityEntry[]>([])
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
  return (
    <section className="cast-continuity" aria-label={text('章节状态连续性', 'Chapter-state continuity')}>
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
