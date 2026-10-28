import { Extension, type Editor, type JSONContent, type Range } from '@tiptap/core'
import { Fragment, type Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Suggestion } from '@tiptap/suggestion'
import type { SuggestionProps } from '@tiptap/suggestion'
import { t } from '../i18n'

export interface SlashItem {
  id: string
  label: string
  keywords: string[]
  run: (editor: Editor, range: Range) => void
}

export interface SlashMenuState {
  items: SlashItem[]
  clientRect: DOMRect | null
  command: (item: SlashItem) => void
}

export interface SlashController {
  onOpen(state: SlashMenuState): void
  onUpdate(state: SlashMenuState): void
  onKeyDown(event: KeyboardEvent): boolean
  onClose(): void
}

export interface SelectionSlashDetail {
  text: string
  markdown: string
  from: number
  to: number
  left: number
  top: number
  bottom: number
  spansBlocks: boolean
}

function selectionMarkdown(editor: Editor, from: number, to: number, plain: string): string {
  const manager = editor.markdown
  if (!manager) return plain
  try {
    const slice = editor.state.doc.slice(from, to)
    const content = slice.content.toJSON() as JSONContent[]
    const markdown = manager.serialize({ type: 'doc', content }).trim()
    return markdown || plain
  } catch {
    return plain
  }
}

function textblocksBetween(doc: PMNode, from: number, to: number): Array<{ pos: number; node: PMNode }> {
  const blocks: Array<{ pos: number; node: PMNode }> = []
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return
    const contentStart = pos + 1
    const contentEnd = pos + node.nodeSize - 1
    if (contentStart < to && contentEnd > from) blocks.push({ pos, node })
    return false
  })
  return blocks
}

function needsJoinSpace(prev: PMNode, next: PMNode): boolean {
  const left = prev.textContent
  const right = next.textContent
  if (!left || !right || /\s$/.test(left) || /^\s/.test(right)) return false
  return !(/[\u3400-\u9fff]$/.test(left) && /^[\u3400-\u9fff]/.test(right))
}

const MERGE_SIBLINGS = new Set(['paragraph', 'heading', 'blockquote', 'codeBlock', 'bulletList', 'orderedList', 'taskList', 'listItem', 'taskItem'])

export function mergeSelectionIntoBlock(editor: Editor, from: number, to: number): boolean {
  const { doc, schema } = editor.state
  const paragraph = schema.nodes.paragraph
  if (!paragraph || from >= to) return false
  const blocks = textblocksBetween(doc, from, to)
  const first = blocks[0]
  const last = blocks[blocks.length - 1]
  if (!first || !last || blocks.length < 2) return false
  const $from = doc.resolve(first.pos + 1)
  const $to = doc.resolve(last.pos + 1)
  let start = -1
  let end = -1
  let parentName = ''
  for (let depth = 1; depth <= Math.min($from.depth, $to.depth); depth += 1) {
    if ($from.node(depth - 1) !== $to.node(depth - 1) || $from.index(depth - 1) === $to.index(depth - 1)) continue
    start = $from.before(depth)
    end = $to.after(depth)
    parentName = $from.node(depth - 1).type.name
    break
  }
  if (start < 0) return false
  for (let pos = start; pos < end; ) {
    const node = doc.nodeAt(pos)
    if (!node || !MERGE_SIBLINGS.has(node.type.name)) return false
    pos += node.nodeSize
  }
  const inlines: PMNode[] = []
  for (const block of blocks) {
    if (block.pos < start || block.pos >= end) continue
    const chunk: PMNode[] = []
    block.node.forEach((child) => {
      if (child.isInline) chunk.push(child)
    })
    if (!chunk.length) continue
    const prev = inlines[inlines.length - 1]
    const head = chunk[0]
    if (prev && head && needsJoinSpace(prev, head)) inlines.push(schema.text(' '))
    inlines.push(...chunk)
  }
  if (!inlines.length) return false
  const body = paragraph.create(null, inlines)
  const listItem = parentName === 'taskList' ? schema.nodes.taskItem : parentName === 'bulletList' || parentName === 'orderedList' ? schema.nodes.listItem : null
  const merged = listItem ? listItem.create(parentName === 'taskList' ? { checked: false } : null, body) : body
  return editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.replaceWith(start, end, merged)
      const pos = Math.min(tr.mapping.map(start) + 1, tr.doc.content.size)
      tr.setSelection(TextSelection.near(tr.doc.resolve(pos)))
      return true
    })
    .run()
}

function siblingsAllowed(doc: PMNode, start: number, end: number): boolean {
  for (let pos = start; pos < end; ) {
    const node = doc.nodeAt(pos)
    if (!node || !MERGE_SIBLINGS.has(node.type.name)) return false
    pos += node.nodeSize
  }
  return true
}

function replaceWithCode(editor: Editor, start: number, end: number, content: PMNode | PMNode[]): boolean {
  const fragment = Fragment.from(content)
  const { doc } = editor.state
  const $start = doc.resolve(start)
  if (!$start.parent.canReplace($start.index(), doc.resolve(end).index(), fragment)) return false
  return editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.replaceWith(start, end, fragment)
      let codeAt = start
      tr.doc.nodesBetween(start, start + fragment.size, (node, pos) => {
        if (node.type.name !== 'codeBlock') return
        codeAt = pos
        return false
      })
      const inside = Math.min(codeAt + 1, tr.doc.content.size)
      tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(1, inside))))
      return true
    })
    .run()
}

export function selectionToCodeBlock(editor: Editor, from: number, to: number): boolean {
  const { doc, schema } = editor.state
  const codeBlock = schema.nodes.codeBlock
  if (!codeBlock || from >= to) return false
  const blocks = textblocksBetween(doc, from, to)
  const first = blocks[0]
  const last = blocks[blocks.length - 1]
  if (!first || !last) return false
  const text = blocks.map((block) => block.node.textContent).join('\n')
  const code = text ? codeBlock.create(null, schema.text(text)) : codeBlock.create()
  if (blocks.length === 1) {
    if (editor.chain().focus().setTextSelection({ from, to }).setCodeBlock().run()) return true
    const itemName = editor.isActive('taskItem') ? 'taskItem' : editor.isActive('listItem') ? 'listItem' : null
    if (itemName && editor.chain().focus().setTextSelection({ from, to }).liftListItem(itemName).setCodeBlock().run()) return true
  }
  const $from = doc.resolve(first.pos + 1)
  const $to = doc.resolve(last.pos + 1)
  for (let depth = 1; depth <= Math.min($from.depth, $to.depth); depth += 1) {
    if ($from.node(depth - 1) !== $to.node(depth - 1) || $from.index(depth - 1) === $to.index(depth - 1)) continue
    const parent = $from.node(depth - 1)
    const start = $from.before(depth)
    const end = $to.after(depth)
    if (!siblingsAllowed(doc, start, end)) return false
    if (parent.type.contentMatch.matchType(codeBlock)) return replaceWithCode(editor, start, end, code)
    const nestedItem = parent.type.name === 'listItem' || parent.type.name === 'taskItem'
    const list = nestedItem ? $from.node(depth - 2) : parent
    if (list.type.name !== 'bulletList' && list.type.name !== 'orderedList' && list.type.name !== 'taskList') return false
    const itemDepth = nestedItem ? depth - 1 : depth
    const listStart = $from.before(itemDepth - 1)
    const fromIndex = $from.index(itemDepth - 1)
    const toIndex = $to.index(itemDepth - 1)
    const before: PMNode[] = []
    const after: PMNode[] = []
    for (let index = 0; index < list.childCount; index += 1) {
      if (index < fromIndex) before.push(list.child(index))
      else if (index > toIndex) after.push(list.child(index))
    }
    const pieces: PMNode[] = []
    if (before.length) pieces.push(list.type.create(list.attrs, before))
    pieces.push(code)
    if (after.length) {
      const startAt = list.type.name === 'orderedList' ? Number(list.attrs.start ?? 1) + toIndex + 1 : null
      pieces.push(list.type.create(startAt == null ? list.attrs : { ...list.attrs, start: startAt }, after))
    }
    return replaceWithCode(editor, listStart, listStart + list.nodeSize, pieces)
  }
  return false
}

function chain(editor: Editor, range: Range) {
  return editor.chain().focus().deleteRange(range)
}

function liftFromList(editor: Editor): void {
  for (let guard = 0; guard < 8; guard += 1) {
    const itemName = editor.isActive('taskItem') ? 'taskItem' : editor.isActive('listItem') ? 'listItem' : null
    if (!itemName) return
    if (!editor.chain().focus().liftListItem(itemName).run()) return
  }
}

function blockChain(editor: Editor, range: Range) {
  editor.chain().focus().deleteRange(range).run()
  liftFromList(editor)
  return editor.chain().focus()
}

export interface SlashActions {
  aiContinue: (editor: Editor, range: Range) => void
  aiInstruct: (editor: Editor, range: Range) => void
  imageAbove: (editor: Editor, range: Range) => void
  imageBelow: (editor: Editor, range: Range) => void
  pickImage: (editor: Editor, range: Range) => void
  networkImage: (editor: Editor, range: Range) => void
  recognizeFormula: (editor: Editor, range: Range) => void
}

export function buildSlashItems(actions: SlashActions): SlashItem[] {
  return [
    { id: 'paragraph', label: t('slashParagraph'), keywords: ['text', 'p', '段落'], run: (e, r) => void blockChain(e, r).setParagraph().run() },
    { id: 'h1', label: t('slashH1'), keywords: ['heading', '标题'], run: (e, r) => void blockChain(e, r).setHeading({ level: 1 }).run() },
    { id: 'h2', label: t('slashH2'), keywords: ['heading', '标题'], run: (e, r) => void blockChain(e, r).setHeading({ level: 2 }).run() },
    { id: 'h3', label: t('slashH3'), keywords: ['heading', '标题'], run: (e, r) => void blockChain(e, r).setHeading({ level: 3 }).run() },
    { id: 'bullet', label: t('slashBullet'), keywords: ['list', 'ul'], run: (e, r) => void chain(e, r).toggleBulletList().run() },
    { id: 'ordered', label: t('slashOrdered'), keywords: ['list', 'ol'], run: (e, r) => void chain(e, r).toggleOrderedList().run() },
    { id: 'task', label: t('slashTask'), keywords: ['todo', 'checkbox', '任务'], run: (e, r) => void chain(e, r).toggleTaskList().run() },
    { id: 'quote', label: t('slashQuote'), keywords: ['blockquote'], run: (e, r) => void blockChain(e, r).toggleBlockquote().run() },
    { id: 'code', label: t('slashCode'), keywords: ['codeblock'], run: (e, r) => void blockChain(e, r).toggleCodeBlock().run() },
    {
      id: 'math',
      label: t('slashMath'),
      keywords: ['latex', 'katex', '公式', 'equation', '$$'],
      run: (e, r) => void chain(e, r).insertContent('$$\nE = mc^2\n$$\n', { contentType: 'markdown' }).run(),
    },
    {
      id: 'inline-math',
      label: t('slashInlineMath'),
      keywords: ['latex', '公式', '$'],
      run: (e, r) => void chain(e, r).insertContent('$x$', { contentType: 'markdown' }).run(),
    },
    {
      id: 'mermaid',
      label: t('slashMermaid'),
      keywords: ['diagram', 'flowchart', '图表', 'mermaid'],
      run: (e, r) =>
        void chain(e, r)
          .insertContent('```mermaid\nflowchart LR\n  A[开始] --> B[结束]\n```\n', { contentType: 'markdown' })
          .run(),
    },
    {
      id: 'table',
      label: t('slashTable'),
      keywords: ['grid', '表'],
      run: (e, r) => void blockChain(e, r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    },
    { id: 'hr', label: t('slashHr'), keywords: ['divider', 'hr'], run: (e, r) => void blockChain(e, r).setHorizontalRule().run() },
    {
      id: 'image-file',
      label: t('slashImage'),
      keywords: ['image', 'picture', '图片', '文件'],
      run: (e, r) => actions.pickImage(e, r),
    },
    {
      id: 'image-url',
      label: t('slashImageUrl'),
      keywords: ['image', 'url', '图片', '链接'],
      run: (e, r) => actions.networkImage(e, r),
    },
    { id: 'ai-continue', label: t('slashContinue'), keywords: ['ai', 'continue', '续写'], run: (e, r) => actions.aiContinue(e, r) },
    { id: 'ai', label: t('slashAi'), keywords: ['ai', '指令', '改写'], run: (e, r) => actions.aiInstruct(e, r) },
    {
      id: 'recognize-formula',
      label: t('slashRecognize'),
      keywords: ['ai', 'ocr', '公式', '图片', '识别', 'latex', '截图'],
      run: (e, r) => actions.recognizeFormula(e, r),
    },
    {
      id: 'ai-image-above',
      label: t('slashImageAbove'),
      keywords: ['ai', 'image', '生图', '图片', '上方'],
      run: (e, r) => actions.imageAbove(e, r),
    },
    {
      id: 'ai-image-below',
      label: t('slashImageBelow'),
      keywords: ['ai', 'image', '生图', '图片', '下方'],
      run: (e, r) => actions.imageBelow(e, r),
    },
  ]
}

export function filterSlashItems(items: SlashItem[], query: string): SlashItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return items
  return items.filter(
    (item) => item.id.includes(q) || item.label.toLowerCase().includes(q) || item.keywords.some((word) => word.includes(q)),
  )
}

export const SlashCommand = Extension.create<{ controller: SlashController | null; items: () => SlashItem[] }>({
  name: 'slashCommand',
  addOptions() {
    return { controller: null, items: () => [] }
  },
  addProseMirrorPlugins() {
    const getController = () => this.options.controller
    const toState = (props: SuggestionProps<SlashItem>): SlashMenuState => ({
      items: props.items,
      clientRect: props.clientRect?.() ?? null,
      command: (item) => props.command(item),
    })
    return [
      Suggestion<SlashItem>({
        editor: this.editor,
        char: '/',
        pluginKey: new PluginKey('slashCommand'),
        allowSpaces: false,
        allow: ({ state, range }) => {
          const parent = state.doc.resolve(range.from).parent
          return !parent.type.spec.code
        },
        command: ({ editor, range, props }) => props.run(editor, range),
        items: ({ query }) => filterSlashItems(this.options.items(), query),
        render: () => ({
          onStart: (props) => getController()?.onOpen(toState(props)),
          onUpdate: (props) => getController()?.onUpdate(toState(props)),
          onKeyDown: (props) => getController()?.onKeyDown(props.event) ?? false,
          onExit: () => getController()?.onClose(),
        }),
      }),
    ]
  },
})

export const SelectionSlash = Extension.create({
  name: 'selectionSlash',
  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      new Plugin({
        key: new PluginKey('selectionSlash'),
        props: {
          handleKeyDown(view, event) {
            if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return false
            const { from, to, empty } = view.state.selection
            if (empty) return false
            if (view.state.doc.resolve(from).parent.type.spec.code) return false
            const text = view.state.doc.textBetween(from, to, '\n').trim()
            if (!text) return false
            const coords = view.coordsAtPos(to)
            const detail: SelectionSlashDetail = {
              text,
              markdown: selectionMarkdown(editor, from, to, text),
              from,
              to,
              left: coords.left,
              top: coords.top,
              bottom: coords.bottom,
              spansBlocks: textblocksBetween(view.state.doc, from, to).length > 1,
            }
            window.dispatchEvent(new CustomEvent('zention:selection-slash', { detail }))
            return true
          },
        },
      }),
    ]
  },
})
