import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import { useI18n } from '../i18n'

type Pos = { top: number; left: number }

function tableRect(editor: Editor): DOMRect | null {
  const { view, state } = editor
  const $from = state.selection.$from
  let depth = $from.depth
  while (depth > 0 && $from.node(depth).type.name !== 'table') depth -= 1
  if (depth === 0) return null
  const dom = view.nodeDOM($from.before(depth))
  if (!(dom instanceof HTMLElement)) return null
  const wrap = dom.closest('.tableWrapper') ?? dom
  return wrap.getBoundingClientRect()
}

function place(rect: DOMRect, barH: number): Pos {
  const gap = 8
  const top = rect.top - barH - gap > 8 ? rect.top - barH - gap : rect.bottom + gap
  return {
    top,
    left: Math.min(Math.max(8, rect.left), window.innerWidth - 360),
  }
}

export function TableToolbar({ editor }: { editor: Editor | null }) {
  const { t } = useI18n()
  const barRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<Pos | null>(null)
  const [canMerge, setCanMerge] = useState(false)
  const [canSplit, setCanSplit] = useState(false)

  useEffect(() => {
    if (!editor) return
    const sync = () => {
      const active = editor.isActive('table')
      setOpen(active)
      setCanMerge(editor.can().mergeCells())
      setCanSplit(editor.can().splitCell())
      if (!active) {
        setPos(null)
        return
      }
      const rect = tableRect(editor)
      if (!rect) {
        setPos(null)
        return
      }
      const h = barRef.current?.offsetHeight || 40
      setPos(place(rect, h))
    }
    sync()
    editor.on('selectionUpdate', sync)
    editor.on('transaction', sync)
    const scroller = editor.view.dom.closest('main') ?? document
    scroller.addEventListener('scroll', sync, true)
    window.addEventListener('resize', sync)
    return () => {
      editor.off('selectionUpdate', sync)
      editor.off('transaction', sync)
      scroller.removeEventListener('scroll', sync, true)
      window.removeEventListener('resize', sync)
    }
  }, [editor])

  useLayoutEffect(() => {
    if (!editor || !open || !barRef.current) return
    const rect = tableRect(editor)
    if (!rect) return
    setPos(place(rect, barRef.current.offsetHeight))
  }, [editor, open, canMerge, canSplit])

  if (!editor || !open || !pos) return null

  const run = (fn: () => boolean) => {
    fn()
    editor.view.focus()
  }

  const removeTable = () => {
    const { selection } = editor.state
    if (selection instanceof NodeSelection && selection.node.type.name === 'table') {
      return editor.chain().focus().deleteSelection().run()
    }
    if (editor.chain().focus().deleteTable().run()) return true
    return editor.chain().focus().deleteBlock().run()
  }

  return (
    <div
      ref={barRef}
      className="table-toolbar"
      contentEditable={false}
      style={{ top: pos.top, left: pos.left }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <button type="button" onClick={() => run(() => editor.chain().focus().addRowBefore().run())}>
        {t('tableAddRowBefore')}
      </button>
      <button type="button" onClick={() => run(() => editor.chain().focus().addRowAfter().run())}>
        {t('tableAddRowAfter')}
      </button>
      <button type="button" onClick={() => run(() => editor.chain().focus().deleteRow().run())}>
        {t('tableDeleteRow')}
      </button>
      <span className="table-toolbar-sep" />
      <button type="button" onClick={() => run(() => editor.chain().focus().addColumnBefore().run())}>
        {t('tableAddColBefore')}
      </button>
      <button type="button" onClick={() => run(() => editor.chain().focus().addColumnAfter().run())}>
        {t('tableAddColAfter')}
      </button>
      <button type="button" onClick={() => run(() => editor.chain().focus().deleteColumn().run())}>
        {t('tableDeleteCol')}
      </button>
      <span className="table-toolbar-sep" />
      <button
        type="button"
        disabled={!canMerge}
        title={t('tableMergeHint')}
        onClick={() => run(() => editor.chain().focus().mergeCells().run())}
      >
        {t('tableMergeCells')}
      </button>
      <button
        type="button"
        disabled={!canSplit}
        title={t('tableSplitHint')}
        onClick={() => run(() => editor.chain().focus().splitCell().run())}
      >
        {t('tableSplitCell')}
      </button>
      <span className="table-toolbar-sep" />
      <button type="button" onClick={() => run(() => editor.chain().focus().toggleHeaderRow().run())}>
        {t('tableToggleHeader')}
      </button>
      <button type="button" className="danger" onClick={() => run(removeTable)}>
        {t('tableDelete')}
      </button>
    </div>
  )
}
