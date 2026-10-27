import { Extension, type Editor, type JSONContent, type Range } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
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
            }
            window.dispatchEvent(new CustomEvent('zention:selection-slash', { detail }))
            return true
          },
        },
      }),
    ]
  },
})
