import { useState } from 'react'
import { ipc } from '../../../services/ipc-client'
import { useLocaleStore } from '../../../stores/locale-store'
import type {
  ChapterCharacterStateSnapshotDiff,
  ChapterCharacterStateSnapshotField,
  ChapterCharacterStateSnapshotVersionSummary,
} from '../../../shared/chapter-character-state-snapshot'
import type { PendingFinalizedCharacterStateCandidateSummary } from '../../../shared/finalized-continuity'
import { CHARACTER_STATE_FIELDS } from '../../editor/character-state-fields'
import { Button } from '../../ui/Button'
import { CharacterStateFieldContent, CharacterStateValidity } from './CharacterStateMetadata'

export default function CharacterStateVersionComparison({ characterId, summaries, pendingCandidates }: {
  characterId: string
  summaries: ChapterCharacterStateSnapshotVersionSummary[]
  pendingCandidates: PendingFinalizedCharacterStateCandidateSummary[]
}) {
  const text = useLocaleStore(s => s.text)
  const [beforeSnapshotId, setBeforeSnapshotId] = useState(summaries[0]?.snapshotId ?? '')
  const [afterSnapshotId, setAfterSnapshotId] = useState(summaries.at(-1)?.snapshotId ?? '')
  const [diff, setDiff] = useState<ChapterCharacterStateSnapshotDiff | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')

  const compare = async () => {
    setStatus('loading')
    setDiff(null)
    try {
      const result = await ipc.invoke('finalized-character:compare-state-snapshots', { beforeSnapshotId, afterSnapshotId, characterId })
      if (!result) throw new Error('SNAPSHOT_NOT_FOUND')
      setDiff(result)
      setStatus('ready')
    } catch {
      setStatus('error')
    }
  }

  const versionLabel = (summary: Pick<ChapterCharacterStateSnapshotVersionSummary, 'source' | 'chapterTitle'>) => text(
    `第 ${summary.source.chapterNumber} 章 · ${summary.chapterTitle} · ${summary.source.finalizationId}`,
    `Chapter ${summary.source.chapterNumber} · ${summary.chapterTitle} · ${summary.source.finalizationId}`,
  )
  const renderField = (label: string, field: ChapterCharacterStateSnapshotField, allFields: readonly ChapterCharacterStateSnapshotField[],
    finalizationId: string) => (
    <div className="cast-history-diff-side">
      <h4>{label}</h4>
      <CharacterStateFieldContent field={field} allFields={allFields} characterId={characterId}
        finalizationId={finalizationId} pendingCandidates={pendingCandidates} />
    </div>
  )

  return (
    <section className="cast-history-compare" aria-label={text('定稿版本比较', 'Finalization version comparison')}>
      <div className="cast-history-compare-controls">
        <label>
          {text('比较起点', 'Compare from')}
          <select aria-label={text('比较起点', 'Compare from')} value={beforeSnapshotId}
            disabled={status === 'loading'} onChange={event => setBeforeSnapshotId(event.target.value)}>
            {summaries.map(summary => <option key={summary.snapshotId} value={summary.snapshotId}>{versionLabel(summary)}</option>)}
          </select>
        </label>
        <label>
          {text('比较终点', 'Compare to')}
          <select aria-label={text('比较终点', 'Compare to')} value={afterSnapshotId}
            disabled={status === 'loading'} onChange={event => setAfterSnapshotId(event.target.value)}>
            {summaries.map(summary => <option key={summary.snapshotId} value={summary.snapshotId}>{versionLabel(summary)}</option>)}
          </select>
        </label>
        <Button variant="secondary" size="sm" disabled={status === 'loading' || !beforeSnapshotId || !afterSnapshotId}
          onClick={() => { void compare() }}>{text('比较字段', 'Compare fields')}</Button>
      </div>
      {status === 'loading' && <p role="status">{text('正在比较字段…', 'Comparing fields…')}</p>}
      {status === 'error' && <p role="alert">{text('字段差异这次没读出来，请重新比较。', 'The field differences could not be loaded. Try comparing again.')}</p>}
      {status === 'ready' && diff && (
        <div className="cast-history-diff" aria-label={text('版本字段差异', 'Version field differences')}>
          <header className="cast-history-diff-versions">
            {[diff.before, diff.after].map((side, index) => (
              <p key={side.snapshotId}>
                {index === 0 ? text('起点', 'From') : text('终点', 'To')}：{versionLabel(side)} · <CharacterStateValidity validity={side.validity} />
              </p>
            ))}
          </header>
          <div className="cast-history-fields">
            {CHARACTER_STATE_FIELDS.map(([field, zh, en]) => {
              const fieldDiff = diff.fields.find(candidate => candidate.field === field)
              if (!fieldDiff) return null
              const changeLabel = fieldDiff.change === 'added' ? text('新增', 'Added')
                : fieldDiff.change === 'changed' ? text('变化', 'Changed')
                  : fieldDiff.change === 'cleared' ? text('已清空', 'Cleared') : text('未变化', 'Unchanged')
              return (
                <section key={field} className="cast-history-field" data-change={fieldDiff.change}
                  aria-label={text(`${zh}差异`, `${en} difference`)}>
                  <h3>{text(zh, en)} · {changeLabel}</h3>
                  <div className="cast-history-diff-sides">
                    {renderField(text('起点', 'From'), fieldDiff.before, diff.fields.map(candidate => candidate.before),
                      diff.before.source.finalizationId)}
                    {renderField(text('终点', 'To'), fieldDiff.after, diff.fields.map(candidate => candidate.after),
                      diff.after.source.finalizationId)}
                  </div>
                </section>
              )
            })}
          </div>
        </div>
      )}
    </section>
  )
}
