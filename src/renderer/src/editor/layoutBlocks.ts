import { Node, mergeAttributes, type Editor, type JSONContent, type MarkdownToken } from '@tiptap/core'
import { beginAiHistory, tagAiHistory } from './aiHistory'
import { t } from '../i18n'

function childMarkdown(node: JSONContent, helpers: { renderChildren: (nodes: JSONContent | JSONContent[], separator?: string) => string }): string {
  return helpers.renderChildren(node.content ?? [])
}

function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w\u4e00-\u9fff-]/g, '')
    .slice(0, 64)
}

function toast(message: string): void {
  window.dispatchEvent(new CustomEvent('zention:toast', { detail: message }))
}

type TocDraft = { level: 1 | 2 | 3; text: string; before?: string }

const TOC_AI_SYSTEM =
  '你是笔记大纲助手。根据正文提出清晰的标题结构。只返回 JSON 数组，不要 Markdown 围栏，不要解释。每项形如 {"level":1或2或3,"text":"标题","before":"正文某段开头最多40字"}。before 用来把标题插到该段前面；无法定位时可省略 before。不要编造与正文无关的主题。最多 12 个标题。已有的标题不要重复。'

function extractTocJson(raw: string): TocDraft[] {
  const text = raw.trim()
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = (fenced?.[1] ?? text).trim()
  const start = body.indexOf('[')
  const end = body.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const parsed = JSON.parse(body.slice(start, end + 1)) as unknown
    if (!Array.isArray(parsed)) return []
    const out: TocDraft[] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const row = item as Record<string, unknown>
      const levelNum = Number(row.level)
      const level = levelNum === 1 || levelNum === 2 || levelNum === 3 ? levelNum : 2
      const title = String(row.text ?? '')
        .replace(/[\r\n]/g, ' ')
        .trim()
        .slice(0, 80)
      if (!title) continue
      const draft: TocDraft = { level, text: title }
      const before = String(row.before ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40)
      if (before) draft.before = before
      out.push(draft)
      if (out.length >= 12) break
    }
    return out
  } catch {
    return []
  }
}

function collectHeadings(editor: Editor): Array<{ level: number; text: string; id: string; pos: number }> {
  const headings: Array<{ level: number; text: string; id: string; pos: number }> = []
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'heading') return
    const text = node.textContent.trim()
    if (!text) return
    const id = `h-${slugify(text) || headings.length}`
    headings.push({ level: Number(node.attrs.level ?? 1), text, id, pos })
  })
  return headings
}

function headingElementAt(editor: Editor, pos: number): HTMLElement | null {
  try {
    const direct = editor.view.nodeDOM(pos)
    if (direct instanceof HTMLElement && /^H[1-6]$/.test(direct.tagName)) return direct
    const at = editor.view.domAtPos(Math.min(pos + 1, editor.state.doc.content.size))
    let current: globalThis.Node | null = at.node
    if (current.nodeType === globalThis.Node.TEXT_NODE) current = current.parentElement
    while (current && current instanceof HTMLElement && current !== editor.view.dom) {
      if (/^H[1-6]$/.test(current.tagName)) return current
      current = current.parentElement
    }
  } catch {
    /* ignore */
  }
  return null
}

function jumpToPos(editor: Editor, pos: number): void {
  const size = editor.state.doc.content.size
  if (pos < 0 || pos >= size) return
  const block = editor.state.doc.nodeAt(pos)
  const caret = block?.type.name === 'heading' ? Math.min(pos + 1, pos + block.nodeSize - 1) : Math.min(pos + 1, size)
  // Defer past ProseMirror's own mouse handlers on the TOC atom.
  window.setTimeout(() => {
    editor.chain().focus().setTextSelection(caret).run()
    const heading = headingElementAt(editor, pos)
    const scroller = editor.view.dom.closest('main')
    if (heading && scroller instanceof HTMLElement) {
      const top = heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 32
      scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
      heading.classList.add('toc-target-flash')
      window.setTimeout(() => heading.classList.remove('toc-target-flash'), 1100)
      return
    }
    if (heading) {
      heading.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
    try {
      editor.view.dispatch(editor.state.tr.scrollIntoView())
    } catch {
      /* ignore */
    }
  }, 0)
}

function notePlainForToc(editor: Editor): string {
  const parts: string[] = []
  editor.state.doc.forEach((node) => {
    if (node.type.name === 'tableOfContents') return
    const text = node.textContent.trim()
    if (text) parts.push(text)
  })
  return parts.join('\n\n').slice(0, 12000)
}

function existingHeadingTexts(editor: Editor): Set<string> {
  return new Set(collectHeadings(editor).map((item) => item.text))
}

function findAnchorPos(editor: Editor, before: string): number | null {
  const needle = before.trim()
  if (!needle) return null
  let found: number | null = null
  editor.state.doc.descendants((node, pos) => {
    if (found != null) return false
    if (!node.isTextblock || node.type.name === 'heading') return
    const text = node.textContent.replace(/\s+/g, ' ').trim()
    if (text.startsWith(needle) || text.includes(needle)) found = pos
  })
  return found
}

async function applyAiOutline(editor: Editor, tocPos: number): Promise<void> {
  const body = notePlainForToc(editor)
  if (body.length < 20) {
    toast(t('tocAiNone'))
    return
  }
  const known = [...existingHeadingTexts(editor)].slice(0, 24)
  const response = await window.zention.aiComplete({
    system: TOC_AI_SYSTEM,
    user: [known.length ? `已有标题：${known.join('、')}` : '正文里还没有标题。', '正文：', body].join('\n\n'),
  })
  if (!response.ok) {
    toast(response.error)
    return
  }
  const knownNow = existingHeadingTexts(editor)
  const drafts = extractTocJson(response.content).filter((item) => !knownNow.has(item.text))
  if (!drafts.length) {
    toast(t('tocAiBad'))
    return
  }
  const headingType = editor.schema.nodes.heading
  if (!headingType) return
  const composition = beginAiHistory()
  const anchored: Array<{ pos: number; node: ReturnType<typeof headingType.create> }> = []
  const fallback: TocDraft[] = []
  const usedAnchors = new Set<number>()
  for (const draft of drafts) {
    const node = headingType.create({ level: draft.level }, editor.schema.text(draft.text))
    const anchor = draft.before ? findAnchorPos(editor, draft.before) : null
    if (typeof anchor === 'number' && !usedAnchors.has(anchor)) {
      usedAnchors.add(anchor)
      anchored.push({ pos: anchor, node })
    } else {
      fallback.push(draft)
    }
  }
  let tr = editor.state.tr
  for (const item of anchored.sort((a, b) => b.pos - a.pos)) {
    tr = tr.insert(item.pos, item.node)
  }
  if (fallback.length) {
    const nodes = fallback.map((draft) => headingType.create({ level: draft.level }, editor.schema.text(draft.text)))
    tr = tr.insert(tocPos + 1, nodes)
  }
  const inserted = anchored.length + fallback.length
  tagAiHistory(tr, composition, true)
  editor.view.dispatch(tr)
  toast(inserted ? t('tocAiDone', { count: inserted }) : t('tocAiNone'))
}

export const TableOfContents = Node.create({
  name: 'tableOfContents',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  parseHTML: () => [{ tag: 'div[data-zention-toc]' }],
  renderHTML: () => ['div', { 'data-zention-toc': '', class: 'zention-toc' }],
  addNodeView() {
    return ({ editor, getPos }) => {
      const dom = document.createElement('div')
      dom.className = 'zention-toc'
      dom.dataset.zentionToc = ''
      let busy = false
      const render = () => {
        const headings = collectHeadings(editor)
        dom.innerHTML = ''
        const head = document.createElement('div')
        head.className = 'zention-toc-head'
        const title = document.createElement('strong')
        title.textContent = t('slashToc')
        const ai = document.createElement('button')
        ai.type = 'button'
        ai.className = 'quiet'
        ai.textContent = busy ? t('tocAiBusy') : t('tocAi')
        ai.disabled = busy
        ai.addEventListener('mousedown', (event) => event.preventDefault())
        ai.addEventListener('click', () => {
          if (busy) return
          const pos = typeof getPos === 'function' ? getPos() : undefined
          if (typeof pos !== 'number') return
          busy = true
          render()
          void applyAiOutline(editor, pos).finally(() => {
            busy = false
            render()
          })
        })
        head.appendChild(title)
        head.appendChild(ai)
        dom.appendChild(head)
        if (!headings.length) {
          const empty = document.createElement('p')
          empty.className = 'hint'
          empty.textContent = t('tocEmpty')
          dom.appendChild(empty)
          return
        }
        const list = document.createElement('ol')
        headings.forEach((item, index) => {
          const li = document.createElement('li')
          li.style.marginLeft = `${(item.level - 1) * 12}px`
          const btn = document.createElement('button')
          btn.type = 'button'
          btn.className = 'zention-toc-link'
          btn.textContent = item.text
          const go = (event: Event) => {
            event.preventDefault()
            event.stopPropagation()
            const latest = collectHeadings(editor)
            const target =
              latest[index]?.text === item.text ? latest[index] : latest.find((heading) => heading.text === item.text)
            jumpToPos(editor, target?.pos ?? item.pos)
          }
          // Handle on pointerdown: mousedown+preventDefault alone can swallow click inside atom nodes.
          btn.addEventListener('pointerdown', go)
          btn.addEventListener('click', go)
          li.appendChild(btn)
          list.appendChild(li)
        })
        dom.appendChild(list)
      }
      render()
      return {
        dom,
        stopEvent: (event) => {
          const target = event.target
          return target instanceof Element && Boolean(target.closest('.zention-toc-link, .zention-toc-head'))
        },
        update: () => {
          render()
          return true
        },
      }
    }
  },
  markdownTokenizer: {
    name: 'tableOfContents',
    level: 'block',
    start: (src) => src.indexOf('<!-- zention-toc -->'),
    tokenize(src) {
      if (!src.startsWith('<!-- zention-toc -->')) return undefined
      return { type: 'tableOfContents', raw: '<!-- zention-toc -->\n' } as MarkdownToken
    },
  },
  parseMarkdown: (_token, helpers) => helpers.createNode('tableOfContents'),
  renderMarkdown: () => '<!-- zention-toc -->\n\n',
})

export const Column = Node.create({
  name: 'column',
  content: 'block+',
  isolating: true,
  defining: true,
  parseHTML: () => [{ tag: 'div[data-zention-column]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-zention-column': '', class: 'zention-column' }), 0],
  renderMarkdown: (node, helpers) => `<div data-zention-column>\n\n${childMarkdown(node, helpers)}\n\n</div>\n`,
})

export const Columns = Node.create({
  name: 'columns',
  group: 'block',
  content: 'column+',
  defining: true,
  isolating: true,
  addAttributes: () => ({
    cols: {
      default: 2,
      parseHTML: (el) => Number((el as HTMLElement).getAttribute('data-cols') ?? 2) || 2,
      renderHTML: (attrs) => ({ 'data-cols': String(attrs.cols ?? 2) }),
    },
  }),
  parseHTML: () => [{ tag: 'div[data-zention-columns]' }],
  renderHTML: ({ HTMLAttributes, node }) => [
    'div',
    mergeAttributes(HTMLAttributes, {
      'data-zention-columns': '',
      class: 'zention-columns',
      'data-cols': String(node.attrs.cols ?? 2),
    }),
    0,
  ],
  renderMarkdown: (node, helpers) =>
    `<div data-zention-columns data-cols="${node.attrs?.cols ?? 2}" class="zention-columns">\n\n${childMarkdown(node, helpers)}\n\n</div>\n\n`,
  addCommands() {
    return {
      insertColumns:
        (cols: 2 | 3) =>
        ({ commands }) => {
          const columns = Array.from({ length: cols }, () => ({
            type: 'column',
            content: [{ type: 'paragraph' }],
          }))
          return commands.insertContent({ type: 'columns', attrs: { cols }, content: columns })
        },
    }
  },
})

export const ToggleBlock = Node.create({
  name: 'toggleBlock',
  group: 'block',
  content: 'block+',
  defining: true,
  isolating: true,
  addAttributes: () => ({
    level: { default: 2 },
    open: { default: true },
    title: { default: '' },
  }),
  parseHTML: () => [
    {
      tag: 'div[data-zention-toggle]',
      getAttrs: (el) => {
        const node = el as HTMLElement
        return {
          level: Number(node.getAttribute('data-level') ?? 2) || 2,
          open: node.getAttribute('data-open') !== 'false',
          title: node.getAttribute('data-title') ?? '',
        }
      },
    },
  ],
  renderHTML: ({ HTMLAttributes, node }) => [
    'div',
    mergeAttributes(HTMLAttributes, {
      'data-zention-toggle': '',
      class: 'zention-toggle',
      'data-level': String(node.attrs.level ?? 2),
      'data-open': node.attrs.open === false ? 'false' : 'true',
      'data-title': String(node.attrs.title ?? ''),
    }),
    0,
  ],
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement('div')
      dom.className = 'zention-toggle'
      dom.dataset.zentionToggle = ''
      const head = document.createElement('div')
      head.className = 'zention-toggle-head'
      const caret = document.createElement('button')
      caret.type = 'button'
      caret.className = 'zention-toggle-caret'
      caret.setAttribute('aria-label', t('toggleOpen'))
      const titleEl = document.createElement('input')
      titleEl.type = 'text'
      titleEl.className = 'zention-toggle-title'
      titleEl.maxLength = 80
      titleEl.spellcheck = false
      titleEl.autocomplete = 'off'
      const body = document.createElement('div')
      body.className = 'zention-toggle-body'
      const content = document.createElement('div')
      const defaultTitle = (level: number) => {
        if (level === 1) return t('slashToggleH1')
        if (level === 3) return t('slashToggleH3')
        return t('slashToggleH2')
      }
      const sync = () => {
        const open = node.attrs.open !== false
        const level = Number(node.attrs.level ?? 2) || 2
        dom.dataset.open = open ? 'true' : 'false'
        dom.dataset.level = String(level)
        caret.textContent = open ? '▾' : '▸'
        caret.setAttribute('aria-expanded', open ? 'true' : 'false')
        caret.setAttribute('aria-label', open ? t('toggleClose') : t('toggleOpen'))
        titleEl.readOnly = !editor.isEditable
        if (document.activeElement !== titleEl) {
          titleEl.value = String(node.attrs.title || defaultTitle(level))
        }
      }
      const commitTitle = () => {
        const next = titleEl.value.replace(/\s+/g, ' ').trim().slice(0, 80)
        const pos = typeof getPos === 'function' ? getPos() : undefined
        if (typeof pos !== 'number') return
        const level = Number(node.attrs.level ?? 2) || 2
        if (!next) {
          titleEl.value = String(node.attrs.title || defaultTitle(level))
          return
        }
        if (next === String(node.attrs.title ?? '')) return
        editor
          .chain()
          .command(({ tr }) => {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, title: next })
            return true
          })
          .run()
      }
      sync()
      caret.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        const pos = typeof getPos === 'function' ? getPos() : undefined
        if (typeof pos !== 'number') return
        editor
          .chain()
          .command(({ tr }) => {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, open: node.attrs.open === false })
            return true
          })
          .run()
      })
      titleEl.addEventListener('pointerdown', (event) => event.stopPropagation())
      titleEl.addEventListener('mousedown', (event) => event.stopPropagation())
      titleEl.addEventListener('click', (event) => event.stopPropagation())
      titleEl.addEventListener('keydown', (event) => {
        event.stopPropagation()
        if (event.key === 'Enter') {
          event.preventDefault()
          titleEl.blur()
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          titleEl.value = String(node.attrs.title || defaultTitle(Number(node.attrs.level ?? 2) || 2))
          titleEl.blur()
        }
      })
      titleEl.addEventListener('change', commitTitle)
      titleEl.addEventListener('blur', commitTitle)
      head.appendChild(caret)
      head.appendChild(titleEl)
      dom.appendChild(head)
      body.appendChild(content)
      dom.appendChild(body)
      return {
        dom,
        contentDOM: content,
        update: (updated) => {
          if (updated.type.name !== 'toggleBlock') return false
          node = updated
          sync()
          return true
        },
        stopEvent: (event) => {
          const target = event.target
          return target instanceof globalThis.Node && (titleEl === target || caret === target || caret.contains(target))
        },
        ignoreMutation: () => true,
      }
    }
  },
  renderMarkdown: (node, helpers) => {
    const title = String(node.attrs?.title ?? '').replace(/"/g, '')
    const open = node.attrs?.open === false ? 'false' : 'true'
    const level = Number(node.attrs?.level ?? 2) || 2
    return `<div data-zention-toggle data-level="${level}" data-open="${open}" data-title="${title}" class="zention-toggle">\n\n${childMarkdown(node, helpers)}\n\n</div>\n\n`
  },
  addCommands() {
    return {
      insertToggleBlock:
        (level: 1 | 2 | 3) =>
        ({ commands }) =>
          commands.insertContent({
            type: 'toggleBlock',
            attrs: { level, open: true, title: t(`slashToggleH${level}` as 'slashToggleH1') },
            content: [{ type: 'paragraph' }],
          }),
    }
  },
})

export const TabPane = Node.create({
  name: 'tabPane',
  content: 'block+',
  isolating: true,
  defining: true,
  addAttributes: () => ({
    title: { default: 'Tab' },
  }),
  parseHTML: () => [
    {
      tag: 'div[data-zention-tab]',
      getAttrs: (el) => ({ title: (el as HTMLElement).getAttribute('data-title') ?? 'Tab' }),
    },
  ],
  renderHTML: ({ HTMLAttributes, node }) => [
    'div',
    mergeAttributes(HTMLAttributes, {
      'data-zention-tab': '',
      'data-title': String(node.attrs.title ?? 'Tab'),
      class: 'zention-tab-panel',
    }),
    0,
  ],
  renderMarkdown: (node, helpers) =>
    `<div data-zention-tab data-title="${String(node.attrs?.title ?? 'Tab').replace(/"/g, '')}">\n\n${childMarkdown(node, helpers)}\n\n</div>\n`,
})

export const Tabs = Node.create({
  name: 'tabs',
  group: 'block',
  content: 'tabPane+',
  defining: true,
  isolating: true,
  addAttributes: () => ({
    active: { default: 0 },
  }),
  parseHTML: () => [{ tag: 'div[data-zention-tabs]' }],
  renderHTML: ({ HTMLAttributes }) => [
    'div',
    mergeAttributes(HTMLAttributes, { 'data-zention-tabs': '', class: 'zention-tabs' }),
    0,
  ],
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement('div')
      dom.className = 'zention-tabs'
      dom.dataset.zentionTabs = ''
      const bar = document.createElement('div')
      bar.className = 'zention-tabs-bar'
      const panels = document.createElement('div')
      panels.className = 'zention-tabs-panels'
      const syncBar = () => {
        bar.innerHTML = ''
        const active = Number(node.attrs.active ?? 0)
        node.forEach((child, _offset, index) => {
          const btn = document.createElement('button')
          btn.type = 'button'
          btn.textContent = String(child.attrs.title || t('tabsUntitled'))
          if (index === active) btn.classList.add('active')
          btn.addEventListener('click', () => {
            const pos = typeof getPos === 'function' ? getPos() : undefined
            if (typeof pos !== 'number') return
            editor
              .chain()
              .command(({ tr }) => {
                tr.setNodeMarkup(pos, undefined, { ...node.attrs, active: index })
                return true
              })
              .run()
          })
          btn.addEventListener('dblclick', () => {
            const next = window.prompt(t('tabsUntitled'), String(child.attrs.title ?? ''))
            if (next == null) return
            const pos = typeof getPos === 'function' ? getPos() : undefined
            if (typeof pos !== 'number') return
            let childPos = pos + 1
            for (let i = 0; i < index; i += 1) childPos += node.child(i).nodeSize
            editor
              .chain()
              .command(({ tr }) => {
                tr.setNodeMarkup(childPos, undefined, { ...child.attrs, title: next.trim().slice(0, 40) || t('tabsUntitled') })
                return true
              })
              .run()
          })
          bar.appendChild(btn)
        })
        const add = document.createElement('button')
        add.type = 'button'
        add.textContent = '+'
        add.title = t('tabsAdd')
        add.addEventListener('click', () => {
          const pos = typeof getPos === 'function' ? getPos() : undefined
          if (typeof pos !== 'number') return
          editor
            .chain()
            .focus()
            .insertContentAt(pos + node.nodeSize - 1, {
              type: 'tabPane',
              attrs: { title: `${t('tabsUntitled')} ${node.childCount + 1}` },
              content: [{ type: 'paragraph' }],
            })
            .run()
        })
        bar.appendChild(add)
        Array.from(panels.children).forEach((panel, index) => {
          if (panel instanceof HTMLElement) panel.hidden = index !== active
        })
      }
      syncBar()
      dom.appendChild(bar)
      dom.appendChild(panels)
      return {
        dom,
        contentDOM: panels,
        update: (updated) => {
          if (updated.type.name !== 'tabs') return false
          node = updated
          syncBar()
          return true
        },
      }
    }
  },
  renderMarkdown: (node, helpers) =>
    `<div data-zention-tabs class="zention-tabs">\n\n${childMarkdown(node, helpers)}\n\n</div>\n\n`,
  addCommands() {
    return {
      insertTabs:
        () =>
        ({ commands }) =>
          commands.insertContent({
            type: 'tabs',
            attrs: { active: 0 },
            content: [
              { type: 'tabPane', attrs: { title: `${t('tabsUntitled')} 1` }, content: [{ type: 'paragraph' }] },
              { type: 'tabPane', attrs: { title: `${t('tabsUntitled')} 2` }, content: [{ type: 'paragraph' }] },
            ],
          }),
    }
  },
})

function resolveButtonHref(href: string): { kind: 'page'; id: string } | { kind: 'url'; url: string } | { kind: 'hash'; hash: string } | null {
  const text = href.trim()
  if (!text) return null
  const page =
    text.match(/zention-page:([0-9a-f-]{36})/i)?.[1] ??
    text.match(/^@\[[^\]]*\]\(([0-9a-f-]{36})\)$/i)?.[1] ??
    (/^[0-9a-f-]{36}$/i.test(text) ? text : null)
  if (page) return { kind: 'page', id: page.toLowerCase() }
  if (text.startsWith('#')) return { kind: 'hash', hash: text.slice(1).trim() }
  if (/^(https?:|mailto:)/i.test(text)) return { kind: 'url', url: text }
  return { kind: 'url', url: text }
}

export const ActionButton = Node.create({
  name: 'actionButton',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes: () => ({
    label: { default: 'Button' },
    href: { default: '' },
  }),
  parseHTML: () => [
    {
      tag: 'div[data-zention-button]',
      getAttrs: (el) => {
        const node = el as HTMLElement
        return {
          label: node.getAttribute('data-label') ?? 'Button',
          href: node.getAttribute('data-href') ?? '',
        }
      },
    },
  ],
  renderHTML: ({ node }) => [
    'div',
    {
      'data-zention-button': '',
      'data-label': String(node.attrs.label ?? 'Button'),
      'data-href': String(node.attrs.href ?? ''),
      class: 'zention-button-wrap',
    },
  ],
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement('div')
      dom.className = 'zention-button-wrap'
      dom.dataset.zentionButton = ''
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'zention-button'
      const hint = document.createElement('small')
      const sync = () => {
        button.textContent = String(node.attrs.label || t('buttonLabel'))
        const href = String(node.attrs.href ?? '').trim()
        dom.dataset.label = button.textContent
        dom.dataset.href = href
        hint.textContent = href ? `${t('buttonLink')}: ${href}` : t('buttonHint')
      }
      sync()
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        const resolved = resolveButtonHref(String(node.attrs.href ?? ''))
        if (resolved?.kind === 'page') {
          window.dispatchEvent(new CustomEvent('zention:open-page', { detail: resolved.id }))
          return
        }
        if (resolved?.kind === 'url') {
          void window.zention.openExternal(resolved.url)
          return
        }
        if (resolved?.kind === 'hash') {
          const target = collectHeadings(editor).find((item) => slugify(item.text) === slugify(resolved.hash) || item.text === resolved.hash)
          if (target) jumpToPos(editor, target.pos)
          else toast(t('buttonLinkMissing'))
          return
        }
        const first = collectHeadings(editor)[0]
        if (first) {
          jumpToPos(editor, first.pos)
          return
        }
        const pos = typeof getPos === 'function' ? getPos() : undefined
        if (typeof pos !== 'number') return
        editor.chain().focus().insertContentAt(pos + node.nodeSize, { type: 'paragraph' }).run()
      })
      const openEdit = (event: Event) => {
        event.preventDefault()
        event.stopPropagation()
        const pos = typeof getPos === 'function' ? getPos() : undefined
        if (typeof pos !== 'number') return
        window.dispatchEvent(
          new CustomEvent('zention:edit-button', {
            detail: {
              pos,
              label: String(node.attrs.label ?? t('buttonLabel')),
              href: String(node.attrs.href ?? ''),
            },
          }),
        )
      }
      button.addEventListener('dblclick', openEdit)
      hint.addEventListener('click', openEdit)
      dom.appendChild(button)
      dom.appendChild(hint)
      return {
        dom,
        update: (updated) => {
          if (updated.type.name !== 'actionButton') return false
          node = updated
          sync()
          return true
        },
        stopEvent: (event) => {
          const target = event.target
          return target instanceof globalThis.Node && (button === target || button.contains(target) || hint === target)
        },
      }
    }
  },
  markdownTokenizer: {
    name: 'actionButton',
    level: 'block',
    start: (src) => src.indexOf('<!-- zention-button:'),
    tokenize(src) {
      const match = /^<!-- zention-button:([\s\S]*?) -->\n?/.exec(src)
      if (!match) return undefined
      let label = t('buttonLabel')
      let href = ''
      try {
        const parsed = JSON.parse(match[1] ?? '{}') as { label?: string; href?: string }
        if (parsed.label) label = String(parsed.label).slice(0, 40)
        if (parsed.href) href = String(parsed.href).slice(0, 500)
      } catch {
        /* keep default */
      }
      return { type: 'actionButton', raw: match[0], label, href } as MarkdownToken & { label: string; href: string }
    },
  },
  parseMarkdown: (token, helpers) => {
    const row = token as MarkdownToken & { label?: string; href?: string }
    return helpers.createNode('actionButton', {
      label: String(row.label ?? t('buttonLabel')),
      href: String(row.href ?? ''),
    })
  },
  renderMarkdown: (node) =>
    `<!-- zention-button:${JSON.stringify({
      label: String(node.attrs?.label ?? 'Button'),
      href: String(node.attrs?.href ?? ''),
    })} -->\n\n`,
  addCommands() {
    return {
      insertActionButton:
        () =>
        ({ commands }) =>
          commands.insertContent({ type: 'actionButton', attrs: { label: t('buttonLabel'), href: '' } }),
    }
  },
})

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    columns: {
      insertColumns: (cols: 2 | 3) => ReturnType
    }
    toggleBlock: {
      insertToggleBlock: (level: 1 | 2 | 3) => ReturnType
    }
    tabs: {
      insertTabs: () => ReturnType
    }
    actionButton: {
      insertActionButton: () => ReturnType
    }
  }
}
