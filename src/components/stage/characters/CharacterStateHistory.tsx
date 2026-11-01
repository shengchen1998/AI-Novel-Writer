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
import { EmptyState } from '../../ui/EmptyState'
import { Notice } from '../../ui/Notice'
import CharacterStateContinuity from './CharacterStateContinuity'
import { CharacterStateFieldContent, CharacterStateImpact, CharacterStateValidity } from './CharacterStateMetadata'
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

  const retryList = () => {
    setListStatus('loading')
    setReload(value => value + 1)
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
            <Button variant="secondary" size="sm" onClick={retryList}>{text('重新读取', 'Retry')}</Button>
          </div>
        )}
        {listStatus === 'ready' && summaries.length === 0 && (
          <EmptyState
            heading={text('还没有章节状态快照', 'No chapter state snapshots yet')}
            description={text('完成定稿并生成角色状态后，可在这里查看历史。', 'Finalize a chapter and generate its character state to see the history here.')}
            action={<Button variant="secondary" size="sm" onClick={retryList}>{text('重新读取', 'Retry')}</Button>}
          />
        )}
        {listStatus === 'ready' && summaries.length > 0 && (
          <ul className="cast-history-list">
            {summaries.map(summary => (
              <li key={summary.snapshotId}>
                <Button
                  variant="secondary"
                  size="sm"
                  className="cast-history-item"
                  aria-pressed={detail?.snapshotId === summary.snapshotId}
                  disabled={detailStatus === 'loading'}
                  onClick={() => { void openSnapshot(summary.snapshotId) }}
                >
                  <span>
                    {text(
                      `第 ${summary.source.chapterNumber} 章 · ${summary.chapterTitle} · ${summary.source.finalizationId}`,
                      `Chapter ${summary.source.chapterNumber} · ${summary.chapterTitle} · ${summary.source.finalizationId}`,
                    )}
                    <span className="cast-history-validity"> · <CharacterStateValidity validity={summary.validity} /></span>
                  </span>
                  <CharacterStateImpact character={summary.character} />
                </Button>
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
              <CharacterStateImpact character={detail.character} />
            </header>
            {detail.unresolved && detail.unresolved.length > 0 && (
              <section className="cast-history-source cast-history-unresolved" aria-label={text('未解析身份', 'Unresolved identities')}>
                <h3>{text('未解析身份', 'Unresolved identities')}</h3>
                <p>{text('未写入角色状态；请在角色建议中确认身份。', 'Not written to character state. Confirm the identity in character suggestions.')}</p>
                <ul>
                  {detail.unresolved.map(occurrence => (
                    <li key={occurrence.selectionKey}>
                      <span>{occurrence.displayName || occurrence.originalText || text('未命名身份', 'Unnamed identity')}</span>
                      <span className="cast-history-validity">
                        {occurrence.reason === 'ambiguous'
                          ? text('身份歧义', 'Ambiguous identity')
                          : occurrence.reason === 'unknown-id'
                            ? text('未知身份', 'Unknown identity')
                            : occurrence.reason === 'name-only'
                              ? text('姓名未确认', 'Name not confirmed')
                              : text('旧身份未绑定', 'Legacy identity not bound')}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {detail.status === 'invalid' && (
              <Notice tone="danger" title={text(
                '快照已失效，仅作历史查看，不作为当前派生状态。',
                'Invalid snapshot: kept for history only and not used as current derived state.',
              )} />
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
                  : detail.baseline.kind === 'snapshot'
                    ? text('前驱快照已随删章移除', 'Predecessor snapshot was removed with its chapter')
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
                    <CharacterStateFieldContent field={snapshotField} characterId={characterId}
                      finalizationId={detail.source.finalizationId} pendingCandidates={pendingCandidates} />
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
