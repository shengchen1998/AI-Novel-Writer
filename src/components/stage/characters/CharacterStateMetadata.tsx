import type {
  ChapterCharacterStateSnapshotCharacterSummary,
  ChapterCharacterStateSnapshotField,
  ChapterCharacterStateSnapshotValidity,
} from '../../../shared/chapter-character-state-snapshot'
import type { PendingFinalizedCharacterStateCandidateSummary } from '../../../shared/finalized-continuity'
import { useLocaleStore } from '../../../stores/locale-store'
import { CHARACTER_STATE_FIELDS } from '../../editor/character-state-fields'

export function CharacterStateValidity({ validity }: { validity: ChapterCharacterStateSnapshotValidity }) {
  const text = useLocaleStore(s => s.text)
  if (validity === 'valid') return text('当前有效', 'Currently valid')
  if (validity === 'superseded') return text('已取代', 'Superseded')
  if (validity === 'waiting-predecessor') return text('等待前驱', 'Waiting for predecessor')
  return text('已失效', 'Invalid')
}

export function CharacterStateImpact({ character }: { character: ChapterCharacterStateSnapshotCharacterSummary }) {
  const text = useLocaleStore(s => s.text)
  const changed = CHARACTER_STATE_FIELDS.filter(([field]) => character.changedFields.includes(field))
  const label = changed.length > 0
    ? text(
      `本章变化：${changed.map(([, zh]) => zh).join('、')}`,
      `Changed here: ${changed.map(([, , en]) => en).join(', ')}`,
    )
    : character.involved
      ? text('本章涉及，字段值未变化', 'Involved here; no field values changed')
      : text('本章未涉及', 'Not involved in this chapter')
  return <span className="cast-history-impact">{label}</span>
}

export function CharacterStateFieldContent({ field, characterId, finalizationId, pendingCandidates }: {
  field: ChapterCharacterStateSnapshotField
  characterId: string
  finalizationId: string
  pendingCandidates: PendingFinalizedCharacterStateCandidateSummary[]
}) {
  const text = useLocaleStore(s => s.text)
  const sourceLabel = field.provenance.kind === 'author'
    ? text('作者输入', 'Author input')
    : field.provenance.kind === 'derived'
      ? text('定稿派生', 'Derived from finalized prose')
      : text('Legacy（来源未知）', 'Legacy · Unknown source')
  return (
    <>
      <p className="cast-history-value">{field.value || '—'}</p>
      <p className="cast-history-meta">
        <span>{sourceLabel}</span>
        <span>{field.knownAtChapter === null
          ? text('已知时点未知', 'Known time unknown')
          : text(`已知时点：第 ${field.knownAtChapter} 章`, `Known at chapter ${field.knownAtChapter}`)}</span>
        {pendingCandidates.some(candidate => candidate.finalizationId === finalizationId
          && candidate.characterId === characterId && candidate.field === field.field) && (
          <span>{text('待确认', 'Pending confirmation')}</span>
        )}
      </p>
      {field.provenance.kind === 'derived' && (
        <p className="cast-history-field-source"><code>{field.provenance.source.finalizationId}</code></p>
      )}
      {field.evidence && (
        <div className="cast-history-evidence">
          <h4>{text('正文证据', 'Finalized prose evidence')}</h4>
          <blockquote>{field.evidence.text}</blockquote>
        </div>
      )}
    </>
  )
}
