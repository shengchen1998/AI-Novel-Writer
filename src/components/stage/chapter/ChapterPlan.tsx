import { useEffect, useRef, useState } from 'react'
import { blueprintWritePrefill } from '../../../services/workflows/chapter-write-launch'
import type { EditorTab } from '../../../stores/editor-store'
import { useDraftStore } from '../../../stores/draft-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { navigate } from '../../../stores/navigation/navigation-intents'
import { useStageStore } from '../../../stores/navigation/stage-store'
import { openBuiltinEditor } from '../../../stores/open-builtin-editor'
import { useProjectStore } from '../../../stores/project-store'
import { ipc } from '../../../services/ipc-client'
import { displayedErrorMessage } from '../../../i18n/app-errors'
import { captureProjectSession, isProjectSessionCurrent } from '../../project-session-gate'
import { Button } from '../../ui/Button'
import { Notice } from '../../ui/Notice'
import { toast } from '../../ui/Toast'
import { useStageView } from '../use-stage-work'
import WriteChapterPopover from '../write/WriteChapterPopover'
import { openDraftInChapterView, swapChapterTab } from './chapter-tab-routing'
import ChapterHead from './ChapterHead'
import DeletionCleanupNotices from './DeletionCleanupNotices'
import ReplacementImpactNotices from './ReplacementImpactNotices'
import { useChapterBlueprint } from './use-chapter-blueprint'
import { pluralEn } from '../../../shared/plural-en'

/**
 * 待写章的单章视图：本章蓝图只读展示，AI 按蓝图写，作者也可以从空白正文开始。
 * 这一章有了稿（写完了，或在别处写好）就在这个标签的位置换成那一稿。
 */
export default function ChapterPlan({ tab, chapterNumber, projectKey }: { tab: EditorTab; chapterNumber: number; projectKey: string }) {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const focus = useStageStore(s => s.focus)
  const wordsPerChapter = useProjectStore(s => s.currentProject?.novelConfig.wordsPerChapter)
  const { blueprint, failed: blueprintFailed, reload: reloadBlueprint } = useChapterBlueprint(chapterNumber, projectKey)
  const { chapters } = useStageView()
  const row = chapters.find(candidate => candidate.number === chapterNumber)
  const draft = row?.draft ?? null
  const [creatingAuthorDraft, setCreatingAuthorDraft] = useState(false)
  const creatingAuthorDraftRef = useRef(false)

  useEffect(() => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!draft || !session) return
    void swapChapterTab(tab.id, () => openDraftInChapterView(draft, row?.title ?? '', session))
  }, [draft, row?.title, tab.id])

  // 没有蓝图就没有写作按钮来接手写作请求；留着它，等这一章补上蓝图后会在蓝图页突然弹出写作弹层。页面开着之后才到的请求也一样。
  const writeRequest = useStageStore(s => s.writeRequest)
  useEffect(() => {
    if (blueprint === null && writeRequest?.chapterNumber === chapterNumber) useStageStore.setState({ writeRequest: null })
  }, [blueprint, chapterNumber, writeRequest])

  const editBlueprint = () => openBuiltinEditor('chapter-card-editor', text('章节蓝图', 'Chapter blueprint'), 'chapter-card', undefined, chapterNumber)
  const target = wordsPerChapter && wordsPerChapter > 0 ? wordsPerChapter.toLocaleString(locale) : null

  const createAuthorDraft = async () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || row?.running || creatingAuthorDraftRef.current) return
    creatingAuthorDraftRef.current = true
    setCreatingAuthorDraft(true)
    const refreshChapterDrafts = () => useDraftStore.getState().loadChapterDrafts(chapterNumber, session.projectPath, session)
    try {
      const created = await ipc.invokeWithProjectSession(session, 'db:draft-create', {
        chapterNumber, version: 1, source: 'author', content: '', wordCount: 0, sourceDependencies: [], onlyWhenChapterEmpty: true,
      }, session.projectPath)
      if (!created.success || created.id === undefined) {
        const failure = new Error(created.error || text('创建作者草稿失败', 'Could not create the author draft'))
        await refreshChapterDrafts()
        throw failure
      }
      await refreshChapterDrafts()
      if (!isProjectSessionCurrent(session)) return
      const draft = useDraftStore.getState().draftsByChapter[chapterNumber]?.find(candidate => candidate.id === created.id)
      if (!draft) throw new Error(text('创建后没能读到作者草稿，请重新打开本章', 'The author draft was created but could not be read. Reopen this chapter.'))
      await swapChapterTab(tab.id, () => openDraftInChapterView(draft, row?.title ?? '', session))
    } catch (error) {
      toast.error(displayedErrorMessage(useLocaleStore.getState().locale, error, text('创建作者草稿失败', 'Could not create the author draft')))
    } finally {
      creatingAuthorDraftRef.current = false
      setCreatingAuthorDraft(false)
    }
  }

  return (
    <div className="stage-ch" data-focus={focus || undefined}>
      <div className="stage-ch-scroll">
        <article className="stage-ch-page">
          <ChapterHead
            chapterNumber={chapterNumber}
            role={blueprint?.role}
            title={blueprint?.title ?? row?.title ?? ''}
            step={0}
            focus={focus}
            version={(
              <span className="stage-ch-version stage-ch-version-chip">
                {target ? text(`尚无草稿 · 目标 ${target} 字`, `No draft yet · target ${target} ${pluralEn(wordsPerChapter ?? 0, 'word')}`) : text('尚无草稿', 'No draft yet')}
              </span>
            )}
          />
          <div className="stage-ch-actions">
            {blueprint && <WriteChapterPopover chapterNumber={chapterNumber} blueprint={blueprintWritePrefill(blueprint)} label={text('AI 写作', 'AI writing')} align="start" />}
            <Button variant={blueprint ? 'secondary' : 'primary'} disabled={creatingAuthorDraft || row?.running} aria-busy={creatingAuthorDraft} onClick={() => void createAuthorDraft()}>{creatingAuthorDraft ? text('正在创建…', 'Creating…') : text('自己写', 'Write it myself')}</Button>
            <span className="stage-ch-hint">
              {blueprint
                ? row?.running
                  ? text('这一章正在写，完成后会在这里换成草稿', 'This chapter is being written; the draft replaces this page when it is done')
                  : text('AI 按本章蓝图写作，也可以自己从空白正文开始', 'AI writes from this chapter’s blueprint, or you can start with a blank page')
                : text('从空白正文开始，输入或粘贴后按现有方式保存', 'Start with a blank page; type or paste, then save as usual')}
            </span>
          </div>
          <div className="stage-ch-notices">
            <DeletionCleanupNotices projectKey={projectKey} chapterNumber={chapterNumber} />
            <ReplacementImpactNotices projectKey={projectKey} chapterNumber={chapterNumber} showOwn={false} />
            {row?.running && (
              <Notice
                tone="info"
                title={text('正在写这一章', 'Writing this chapter')}
                actions={<Button variant="secondary" size="sm" onClick={() => navigate({ kind: 'run', facet: 'output' })}>{text('查看运行', 'Open run')}</Button>}
              />
            )}
            {blueprintFailed && (
              <Notice
                tone="warn"
                title={text('读取本章蓝图失败', 'Could not read this chapter’s blueprint')}
                actions={<Button variant="secondary" size="sm" onClick={reloadBlueprint}>{text('重新读取', 'Read again')}</Button>}
              >
                {text('写作此章按本章蓝图写，读到之后才能开始。', 'Writing follows this chapter’s blueprint, so it can start once the blueprint is read.')}
              </Notice>
            )}
            {blueprint === null && (
              <Notice
                tone="warn"
                title={text('这一章还没有蓝图', 'This chapter has no blueprint yet')}
                actions={<Button variant="secondary" size="sm" onClick={editBlueprint}>{text('去蓝图规划', 'Plan it in the blueprint')}</Button>}
              >
                {text('写作此章按蓝图写，先在蓝图里规划这一章。', 'Writing follows the blueprint, so plan this chapter there first.')}
              </Notice>
            )}
          </div>
          {blueprint && (
            <section className="stage-ch-plan" aria-label={text('本章蓝图', 'Chapter blueprint')}>
              <div className="stage-ch-plan-head">
                <h2 className="stage-ch-plan-title">{text('本章蓝图', 'Chapter blueprint')}<small>{text('只读 · 写作以此为准', 'Read-only · writing follows it')}</small></h2>
                <Button variant="text" size="sm" onClick={editBlueprint}>{text('在蓝图中编辑', 'Edit in blueprint')}</Button>
              </div>
              <dl className="stage-ch-plan-grid">
                <dt>{text('定位', 'Role')}</dt><dd>{blueprint.role || '—'}</dd>
                <dt>{text('出场角色', 'Characters')}</dt>
                <dd>{blueprint.characters.length > 0
                  ? <span className="stage-ch-chips">{blueprint.characters.map(name => <span key={name} className="stage-ch-chip">{name}</span>)}</span>
                  : '—'}</dd>
                <dt>{text('本章目的', 'Purpose')}</dt><dd>{blueprint.purpose || '—'}</dd>
                <dt>{text('关键事件', 'Key events')}</dt><dd>{blueprint.keyEvents || '—'}</dd>
                {blueprint.userGuidance && <><dt>{text('作者指导', 'Author guidance')}</dt><dd>{blueprint.userGuidance}</dd></>}
              </dl>
            </section>
          )}
          {blueprint && !row?.running && (
            <div className="stage-ch-blank">
              <b>{text('这一章还是空白', 'This chapter is still blank')}</b>
              {text('点「AI 写作」按上面的蓝图生成，或点「自己写」从空白正文开始。', 'Choose “AI writing” to draft from the blueprint above, or “Write it myself” to start with a blank page.')}
            </div>
          )}
        </article>
      </div>
    </div>
  )
}
