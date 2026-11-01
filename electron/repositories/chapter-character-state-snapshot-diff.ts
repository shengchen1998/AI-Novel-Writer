import type {
  ChapterCharacterStateSnapshotDetail,
  ChapterCharacterStateSnapshotDiff,
  ChapterCharacterStateSnapshotDiffSide,
} from '../../src/shared/chapter-character-state-snapshot'
import { CHARACTER_STATE_TEXT_FIELDS } from '../../src/shared/character-roster'

function diffSide(detail: ChapterCharacterStateSnapshotDetail): ChapterCharacterStateSnapshotDiffSide {
  return {
    snapshotId: detail.snapshotId,
    source: detail.source,
    chapterTitle: detail.chapterTitle,
    validity: detail.validity,
    character: {
      characterId: detail.character.characterId,
      displayNameSnapshot: detail.character.displayNameSnapshot,
      aliases: detail.character.aliases,
      updatedAtChapter: detail.character.updatedAtChapter,
      involved: detail.character.involved,
      changedFields: [...detail.character.changedFields],
    },
  }
}

export function compareCharacterStateSnapshots(
  before: ChapterCharacterStateSnapshotDetail,
  after: ChapterCharacterStateSnapshotDetail,
): ChapterCharacterStateSnapshotDiff {
  return {
    before: diffSide(before),
    after: diffSide(after),
    fields: CHARACTER_STATE_TEXT_FIELDS.map(field => {
      const beforeField = before.character.fields.find(candidate => candidate.field === field)!
      const afterField = after.character.fields.find(candidate => candidate.field === field)!
      const change = beforeField.value === afterField.value ? 'unchanged'
        : beforeField.value === '' ? 'added' : afterField.value === '' ? 'cleared' : 'changed'
      return { field, change, before: beforeField, after: afterField }
    }),
  }
}
