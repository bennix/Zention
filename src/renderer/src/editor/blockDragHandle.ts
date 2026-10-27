import { Extension } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { t } from '../i18n'

const GRIP_SVG =
  '<svg width="10" height="16" viewBox="0 0 10 16" aria-hidden="true">' +
  '<circle cx="2.5" cy="3" r="1.4" fill="currentColor"/><circle cx="7.5" cy="3" r="1.4" fill="currentColor"/>' +
  '<circle cx="2.5" cy="8" r="1.4" fill="currentColor"/><circle cx="7.5" cy="8" r="1.4" fill="currentColor"/>' +
  '<circle cx="2.5" cy="13" r="1.4" fill="currentColor"/><circle cx="7.5" cy="13" r="1.4" fill="currentColor"/>' +
  '</svg>'

const PLUS_SVG =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>'

function topLevelPosAt(view: EditorView, coords: { left: number; top: number }): number | null {
  const found = view.posAtCoords(coords)
  if (!found) return null
  const $pos = view.state.doc.resolve(found.inside >= 0 ? found.inside : found.pos)
  if ($pos.depth === 0 && found.inside >= 0) return found.inside
  return $pos.depth > 0 ? $pos.before(1) : null
}

export const BlockDragHandle = Extension.create({
  name: 'blockDragHandle',
  addProseMirrorPlugins() {
    return [dragHandlePlugin(this.editor)]
  },
})

function dragHandlePlugin(editor: Editor): Plugin {
  return new Plugin({
    key: new PluginKey('blockDragHandle'),
    view(view) {
      const container = view.dom.parentElement
      const handle = document.createElement('div')
      handle.className = 'md-block-gutter'
      handle.style.display = 'none'
      handle.setAttribute('contenteditable', 'false')

      const plus = document.createElement('button')
      plus.type = 'button'
      plus.className = 'md-gutter-btn md-gutter-plus'
      plus.innerHTML = PLUS_SVG
      plus.setAttribute('aria-label', t('gutterAdd'))

      const grip = document.createElement('button')
      grip.type = 'button'
      grip.className = 'md-gutter-btn md-gutter-grip'
      grip.draggable = true
      grip.innerHTML = GRIP_SVG
      grip.setAttribute('aria-label', t('gutterDrag'))

      handle.append(plus, grip)
      const menu = document.createElement('div')
      menu.className = 'md-block-menu'
      menu.style.display = 'none'
      if (container) {
        if (!container.style.position) container.style.position = 'relative'
        container.append(handle, menu)
      }

      let hoverPos: number | null = null
      let menuPos: number | null = null
      const hideHandle = () => {
        handle.style.display = 'none'
        hoverPos = null
      }
      const hideMenu = () => {
        menu.style.display = 'none'
        menuPos = null
      }
      const selectHovered = (): NodeSelection | null => {
        const pos = menuPos ?? hoverPos
        if (pos === null || pos >= view.state.doc.content.size || !view.state.doc.nodeAt(pos)) return null
        try {
          return NodeSelection.create(view.state.doc, pos)
        } catch {
          return null
        }
      }
      const onMouseMove = (event: MouseEvent) => {
        if (!view.editable || !container) return
        const pos = topLevelPosAt(view, { left: event.clientX, top: event.clientY })
        if (pos === null) return
        const dom = view.nodeDOM(pos)
        if (!(dom instanceof HTMLElement)) return hideHandle()
        const blockRect = dom.getBoundingClientRect()
        const containerRect = container.getBoundingClientRect()
        hoverPos = pos
        plus.setAttribute('aria-label', t('gutterAdd'))
        grip.setAttribute('aria-label', t('gutterDrag'))
        handle.style.display = 'flex'
        handle.style.top = `${blockRect.top - containerRect.top + container.scrollTop + 2}px`
        handle.style.left = `${blockRect.left - containerRect.left - 46}px`
      }
      const onDragStart = (event: DragEvent) => {
        hideMenu()
        if (!event.dataTransfer) return
        const selection = selectHovered()
        if (!selection) return event.preventDefault()
        view.dispatch(view.state.tr.setSelection(selection))
        view.dragging = { slice: selection.content(), move: true }
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', ' ')
        const dom = view.nodeDOM(selection.from)
        if (dom instanceof HTMLElement) {
          dom.classList.add('md-block-dragging')
          event.dataTransfer.setDragImage(dom, 0, 0)
        }
      }
      const clearDragging = () => {
        view.dom.querySelectorAll('.md-block-dragging').forEach((node) => node.classList.remove('md-block-dragging'))
      }
      const onPlusClick = () => {
        hideMenu()
        const selection = selectHovered()
        if (!selection) return
        const after = selection.to
        let tr = view.state.tr.insert(after, editor.schema.nodes.paragraph!.create())
        tr = tr.setSelection(TextSelection.near(tr.doc.resolve(after + 1)))
        view.dispatch(tr)
        view.focus()
        editor.commands.insertContent('/')
      }
      const runOnBlock = (run: () => void) => () => {
        const selection = selectHovered()
        hideMenu()
        if (!selection) return
        view.dispatch(view.state.tr.setSelection(selection))
        run()
        view.focus()
      }
      const items: Array<{ label: () => string; danger?: boolean; run: () => void }> = [
        { label: () => t('blockAdd'), run: onPlusClick },
        { label: () => t('blockUp'), run: runOnBlock(() => void editor.commands.moveBlockUp()) },
        { label: () => t('blockDown'), run: runOnBlock(() => void editor.commands.moveBlockDown()) },
        { label: () => t('blockCopy'), run: runOnBlock(() => void editor.commands.duplicateBlock()) },
        { label: () => t('blockDelete'), danger: true, run: runOnBlock(() => void editor.commands.deleteBlock()) },
      ]
      const openMenu = () => {
        if (hoverPos === null) return
        menuPos = hoverPos
        menu.replaceChildren(
          ...items.map((item) => {
            const button = document.createElement('button')
            button.type = 'button'
            button.className = `md-block-menu-item${item.danger ? ' danger' : ''}`
            button.textContent = item.label()
            button.addEventListener('click', item.run)
            return button
          }),
        )
        menu.style.display = 'block'
        menu.style.top = `${parseFloat(handle.style.top) + 26}px`
        menu.style.left = handle.style.left
      }
      let hideTimer: number | null = null
      const cancelHide = () => {
        if (hideTimer !== null) window.clearTimeout(hideTimer)
        hideTimer = null
      }
      const scheduleHide = () => {
        cancelHide()
        hideTimer = window.setTimeout(() => {
          hideTimer = null
          if (menu.style.display !== 'block') hideHandle()
        }, 250)
      }
      const onDocMouseDown = (event: MouseEvent) => {
        if (menu.style.display !== 'block') return
        if (event.target instanceof Node && (menu.contains(event.target) || handle.contains(event.target))) return
        hideMenu()
        if (!(event.target instanceof Node) || !view.dom.contains(event.target)) hideHandle()
      }
      view.dom.addEventListener('mousemove', onMouseMove)
      view.dom.addEventListener('mouseenter', cancelHide)
      view.dom.addEventListener('mouseleave', scheduleHide)
      handle.addEventListener('mouseenter', cancelHide)
      handle.addEventListener('mouseleave', scheduleHide)
      grip.addEventListener('dragstart', onDragStart)
      grip.addEventListener('dragend', clearDragging)
      view.dom.addEventListener('drop', clearDragging)
      grip.addEventListener('click', () => (menu.style.display === 'block' ? hideMenu() : openMenu()))
      plus.addEventListener('click', onPlusClick)
      document.addEventListener('mousedown', onDocMouseDown, true)
      return {
        update(_next, prev) {
          if (!prev.doc.eq(view.state.doc)) hideMenu()
        },
        destroy() {
          cancelHide()
          view.dom.removeEventListener('mousemove', onMouseMove)
          view.dom.removeEventListener('mouseenter', cancelHide)
          view.dom.removeEventListener('mouseleave', scheduleHide)
          document.removeEventListener('mousedown', onDocMouseDown, true)
          grip.removeEventListener('dragend', clearDragging)
          view.dom.removeEventListener('drop', clearDragging)
          clearDragging()
          handle.remove()
          menu.remove()
        },
      }
    },
  })
}
