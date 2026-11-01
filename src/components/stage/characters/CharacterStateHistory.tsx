import { useEffect, useState } from 'react'
import { ipc } from '../../../services/ipc-client'
import { useLocaleStore } from '../../../stores/locale-store'
import type {
  ChapterCharacterStateSnapshotDetail,
  ChapterCharacterStateSnapshotVersionSummary,
} from '../../../shared/chapter-character-state-snapshot'
import type { PendingFinalizedCharacterStateCandidateSummary } from '../../../shared/finalized-continuity'
import { CHARACTER_STATE_FIELDS } from '../../editor/character-state-fields'
import { Button } from '../../ui/Button'
import CharacterStateContinuity from './CharacterStateContinuity'
import CharacterStateVersionComparison from './CharacterStateVersionComparison'

export default function CharacterStateHistory({ characterId }: { characterId: string }) {
  const text = useLocaleStore(s => s.text)
  const [summaries, setSummaries] = useState<ChapterCharacterStateSnapshotVersionSummary[]>([])
  const [pendingCandidates, setPendingCandidates] = useState<PendingFinalizedCharacterStateCandidateSummary[]>([])
  const [listStatus, setListStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [detail, setDetail] = useState<ChapterCharacterStateSnapshotDetail | null>(null)
  const [detailStatus, setDetailStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let active = true
    void ipc.invoke('finalized-character:list-state-snapshots', { characterId }).then(result => {
      if (!active) return
      setSummaries(result)
      setListStatus('ready')
    }).catch(() => {
      if (active) setListStatus('error')
    })
    void ipc.invoke('finalized-character:list-state-candidates').then(result => {
      if (active) setPendingCandidates(result.filter(candidate => candidate.characterId === characterId))
    }).catch(() => {
      if (active) setPendingCandidates([])
    })
    return () => { active = false }
  }, [characterId, reload])

  const openSnapshot = async (snapshotId: string) => {
    setDetailStatus('loading')
    setDetail(null)
    try {
      const result = await ipc.invoke('finalized-character:read-state-snapshot', { snapshotId, characterId })
      if (!result) throw new Error('SNAPSHOT_NOT_FOUND')
      setDetail(result)
      setDetailStatus('ready')
    } catch {
      setDetailStatus('error')
    }
  }

  const sourceLabel = (kind: 'author' | 'derived' | 'legacy') => {
    if (kind === 'author') return text('作者输入', 'Author input')
    if (kind === 'derived') return text('定稿派生', 'Derived from finalized prose')
    return text('Legacy（来源未知）', 'Legacy · Unknown source')
  }
  const validityLabel = (validity: ChapterCharacterStateSnapshotVersionSummary['validity']) => {
    if (validity === 'valid') return text('当前有效', 'Currently valid')
    if (validity === 'superseded') return text('已取代', 'Superseded')
    if (validity === 'waiting-predecessor') return text('等待前驱', 'Waiting for predecessor')
    return text('已失效', 'Invalid')
  }

  return (
    <section className="cast-history" aria-label={text('章节状态快照', 'Chapter state snapshots')}>
      <CharacterStateContinuity />
      <div className="cast-history-index">
        <h2>{text('定稿历史', 'Finalization history')}</h2>
        {listStatus === 'loading' && <p role="status">{text('正在读取章节状态…', 'Loading chapter states…')}</p>}
        {listStatus === 'error' && (
          <div role="alert">
            <p>{text('章节状态这次没读出来，可以重新读取。', 'Chapter states could not be loaded. Try reading them again.')}</p>
            <Button variant="secondary" size="sm" onClick={() => {
              setListStatus('loading')
              setReload(value => value + 1)
            }}>{text('重新读取', 'Retry')}</Button>
          </div>
        )}
        {listStatus === 'ready' && summaries.length === 0 && <p>{text('还没有章节状态快照。', 'No chapter state snapshots yet.')}</p>}
        {listStatus === 'ready' && summaries.length > 0 && (
          <ul className="cast-history-list">
            {summaries.map(summary => (
              <li key={summary.snapshotId}>
                <button
                  type="button"
                  className="cast-history-item"
                  aria-pressed={detail?.snapshotId === summary.snapshotId}
                  disabled={detailStatus === 'loading'}
                  onClick={() => { void openSnapshot(summary.snapshotId) }}
                >
                  {text(
                    `第 ${summary.source.chapterNumber} 章 · ${summary.chapterTitle} · ${summary.source.finalizationId}`,
                    `Chapter ${summary.source.chapterNumber} · ${summary.chapterTitle} · ${summary.source.finalizationId}`,
                  )}
                  <span className="cast-history-validity"> · {validityLabel(summary.validity)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="cast-history-detail">
        {summaries.length > 1 && <CharacterStateVersionComparison key={summaries.map(summary => summary.snapshotId).join(':')}
          characterId={characterId} summaries={summaries} pendingCandidates={pendingCandidates} />}
        {detailStatus === 'idle' && summaries.length > 0 && <p>{text('选择一次定稿查看完整状态。', 'Choose a finalization to view its complete state.')}</p>}
        {detailStatus === 'loading' && <p role="status">{text('正在读取完整快照…', 'Loading the complete snapshot…')}</p>}
        {detailStatus === 'error' && <p role="alert">{text('完整快照这次没读出来，请重新选择。', 'The complete snapshot could not be loaded. Choose it again.')}</p>}
        {detailStatus === 'ready' && detail && (
          <>
            <header className="cast-history-heading">
              <h2>{text(`第 ${detail.source.chapterNumber} 章 · ${detail.chapterTitle}`, `Chapter ${detail.source.chapterNumber} · ${detail.chapterTitle}`)}</h2>
              <p>{detail.character.displayNameSnapshot}{detail.character.aliases.length > 0 ? ` · ${detail.character.aliases.join(' / ')}` : ''}</p>
            </header>
            {detail.status === 'invalid' && (
              <p className="run-note" data-tone="danger">{text(
                '快照已失效，仅作历史查看，不作为当前派生状态。',
                'Invalid snapshot: kept for history only and not used as current derived state.',
              )}</p>
            )}
            <section className="cast-history-source" aria-label={text('定稿来源', 'Finalization source')}>
              <h3>{text('定稿来源', 'Finalization source')}</h3>
              <dl>
                <dt>{text('草稿身份', 'Draft identity')}</dt><dd>{detail.source.draftId}</dd>
                <dt>{text('定稿收据', 'Finalization receipt')}</dt><dd><code>{detail.source.finalizationId}</code></dd>
                <dt>{text('正文哈希', 'Prose hash')}</dt><dd><code>{detail.source.contentHash}</code></dd>
                <dt>{text('状态基线', 'State baseline')}</dt>
                <dd>{detail.baseline.predecessor
                  ? text(
                    `继承第 ${detail.baseline.predecessor.source.chapterNumber} 章快照`,
                    `Inherited from the chapter ${detail.baseline.predecessor.source.chapterNumber} snapshot`,
                  )
                  : text('角色名单初始基线', 'Initial roster baseline')}</dd>
                <dt>{text('输入哈希', 'Input hash')}</dt>
                <dd>{detail.inputHash ? <code>{detail.inputHash}</code> : text('旧快照未记录', 'Not recorded in this older snapshot')}</dd>
                <dt>{text('连续性代际', 'Continuity generation')}</dt>
                <dd>{detail.continuityGeneration ?? text('旧快照未记录', 'Not recorded in this older snapshot')}</dd>
              </dl>
            </section>
            <div className="cast-history-fields">
              {CHARACTER_STATE_FIELDS.map(([field, zh, en]) => {
                const snapshotField = detail.character.fields.find(candidate => candidate.field === field)
                if (!snapshotField) return null
                return (
                  <section key={field} className="cast-history-field" aria-label={text(zh, en)}>
                    <h3>{text(zh, en)}</h3>
                    <p className="cast-history-value">{snapshotField.value || '—'}</p>
                    <p className="cast-history-meta">
                      <span>{sourceLabel(snapshotField.provenance.kind)}</span>
                      <span>{snapshotField.knownAtChapter === null
                        ? text('已知时点未知', 'Known time unknown')
                        : text(`已知时点：第 ${snapshotField.knownAtChapter} 章`, `Known at chapter ${snapshotField.knownAtChapter}`)}</span>
                      {pendingCandidates.some(candidate => candidate.finalizationId === detail.source.finalizationId
                        && candidate.characterId === characterId && candidate.field === field) && (
                        <span>{text('待确认', 'Pending confirmation')}</span>
                      )}
                    </p>
                    {snapshotField.provenance.kind === 'derived' && (
                      <p className="cast-history-field-source"><code>{snapshotField.provenance.source.finalizationId}</code></p>
                    )}
                    {snapshotField.evidence && (
                      <div className="cast-history-evidence">
                        <h4>{text('正文证据', 'Finalized prose evidence')}</h4>
                        <blockquote>{snapshotField.evidence.text}</blockquote>
                      </div>
                    )}
                  </section>
                )
              })}
            </div>
          </>
        )}
      </div>
    </section>
  )
}
