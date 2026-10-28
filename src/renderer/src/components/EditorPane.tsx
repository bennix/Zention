import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import type { Editor, Range } from '@tiptap/core'
import { beginAiHistory, tagAiHistory } from '../editor/aiHistory'
import { instructionFor, rewritePrompt } from '../editor/rewrite'
import { buildExtensions } from '../editor/extensions'
import { latexFromModel, renderLatexToHtml } from '../editor/latex'
import { codeBlockPos, requestCodeIndent } from '../editor/codeIndent'
import { buildSlashItems, mergeSelectionIntoBlock, selectionToCodeBlock, type SlashActions, type SlashController, type SlashMenuState, type SelectionSlashDetail } from '../editor/slash'
import { registerFlush } from '../flush'
import { AttachmentBar, imageFiles, revokePromptImages, takePromptImages, type PromptImage } from './Attachments'
import { SelectionMenu, SlashMenu, type SlashMenuHandle } from './Menus'
import { useI18n } from '../i18n'
import { decorateExportHtml } from '../exportHtml'

export type EditorExport = {
  markdown: () => string
  html: () => string
}

const REWRITE_SYSTEM =
  '你是笔记编辑器里的写作助手。只输出可以直接替换原文的 Markdown 正文。必须忠实保留原文的格式和结构，包括标题级别、列表、表格、引用、代码、链接、强调、换行和公式。不要解释，不要包裹代码围栏。公式继续使用 $...$ 或 $$...$$。'

const EQUATION_SYSTEM =
  '你是 LaTeX 公式助手。只输出公式源码，不要解释，不要 Markdown，不要代码围栏，不要用 $ 或 $$ 包裹。图片里有多个公式时，按阅读顺序用空行隔开。'

type Dialog =
  | { kind: 'insert'; instruction: string; images: PromptImage[] }
  | { kind: 'replace'; from: number; to: number; text: string; instruction: string; images: PromptImage[] }
  | { kind: 'image'; place: 'above' | 'below'; pos: number; prompt: string; aspect: string }
  | { kind: 'url' }
  | { kind: 'recognize'; at: number; images: PromptImage[] }
  | {
      kind: 'equation'
      pos: number
      kindName: 'inline' | 'block'
      latex: string
      instruction: string
      images: PromptImage[]
    }

function emptyEquation(pos: number, kindName: 'inline' | 'block', latex: string): Dialog {
  return { kind: 'equation', pos, kindName, latex, instruction: '', images: [] }
}

function promptPayload(images: PromptImage[]): Array<{ mime: string; base64: string }> {
  return images.map(({ mime, base64 }) => ({ mime, base64 }))
}

function markdownFromModel(raw: string): string {
  let text = raw.trim()
  const fence = text.match(/^```(?:markdown|md)?\s*([\s\S]*?)```$/i)
  if (fence?.[1]) text = fence[1].trim()
  return text
}

function plainBlocks(markdown: string): Array<{ type: 'paragraph'; content: Array<{ type: 'text'; text: string }> }> {
  return markdown
    .split(/\n{2,}/)
    .filter((block) => block.trim())
    .map((block) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: block }],
    }))
}

function replaceMarkdown(
  editor: Editor,
  from: number,
  to: number,
  markdown: string,
  composition: number,
  closeGroup: boolean,
): { from: number; to: number } | null {
  const size = editor.state.doc.content.size
  const start = Math.max(0, Math.min(from, size))
  const end = Math.max(start, Math.min(to, size))
  const before = size
  const chain = editor.chain().command(({ tr }) => {
    tagAiHistory(tr, composition, closeGroup)
    return true
  })
  const inserted = chain.insertContentAt({ from: start, to: end }, markdown, { contentType: 'markdown' }).run()
  if (!inserted) {
    const blocks = plainBlocks(markdown)
    if (blocks.length === 0) return null
    const fallback = editor.chain().command(({ tr }) => {
      tagAiHistory(tr, composition, closeGroup)
      return true
    })
    if (!fallback.insertContentAt({ from: start, to: end }, blocks).run()) return null
  }
  const added = editor.state.doc.content.size - before + (end - start)
  return { from: start, to: start + Math.max(0, added) }
}

function illustrate(text: string): string {
  return `根据下面的文字生成一幅清晰完整的插图。不要水印、字幕、Logo，不要畸形肢体。\n${text.trim()}`
}

function blockPoint(editor: Editor, pos: number, place: 'above' | 'below'): number {
  const safe = Math.max(0, Math.min(pos, editor.state.doc.content.size))
  const $pos = editor.state.doc.resolve(safe)
  if ($pos.depth < 1) return place === 'above' ? 0 : editor.state.doc.content.size
  return place === 'above' ? $pos.before(1) : $pos.after(1)
}

export function EditorPane({
  pageId,
  markdown,
  onChange,
  onToast,
  onNeedKey,
  exportHandle,
  external = false,
}: {
  pageId: string
  markdown: string
  onChange: (markdown: string) => void
  onToast: (message: string) => void
  onNeedKey: () => void
  exportHandle: { current: EditorExport | null }
  external?: boolean
}) {
  const { t } = useI18n()
  const [slash, setSlash] = useState<SlashMenuState | null>(null)
  const [selection, setSelection] = useState<SelectionSlashDetail | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [busy, setBusy] = useState('')
  const slashMenuRef = useRef<SlashMenuHandle>(null)
  const editorRef = useRef<Editor | null>(null)
  const dialogRef = useRef<Dialog | null>(null)
  dialogRef.current = dialog
  const actionsRef = useRef<SlashActions>(null!)
  const savedRef = useRef(markdown)
  const pendingRef = useRef<string | null>(null)
  const timerRef = useRef<number | null>(null)
  const pageIdRef = useRef(pageId)
  pageIdRef.current = pageId
  const externalRef = useRef(external)
  externalRef.current = external
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const streamingRef = useRef(false)
  if (exportHandle) {
    exportHandle.current = {
      markdown: () => editorRef.current?.getMarkdown() ?? markdown,
      html: () => decorateExportHtml(editorRef.current?.getHTML() ?? ''),
    }
  }

  const flush = useCallback((body: string) => {
    if (body === savedRef.current) return
    savedRef.current = body
    onChange(body)
  }, [onChange])

  const schedule = useCallback(
    (body: string) => {
      pendingRef.current = body
      if (timerRef.current) {
        if (streamingRef.current) return
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        if (pendingRef.current != null) flush(pendingRef.current)
      }, streamingRef.current ? 200 : 500)
    },
    [flush],
  )

  useEffect(() => {
    return registerFlush(async () => {
      if (timerRef.current) window.clearTimeout(timerRef.current)
      const body = editorRef.current?.getMarkdown()
      if (body == null || body === savedRef.current) return
      if (externalRef.current) {
        savedRef.current = body
        pendingRef.current = body
        onChangeRef.current(body)
        return
      }
      const result = await window.zention.savePage(pageIdRef.current, body)
      if (!result.ok) throw new Error(result.error)
      savedRef.current = body
      pendingRef.current = body
    })
  }, [])

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current)
      if (pendingRef.current != null) onChange(pendingRef.current)
    }
  }, [onChange])

  useEffect(() => {
    if (!external) return
    let settle = true
    const stop = () => {
      settle = false
    }
    const id = window.setTimeout(() => {
      if (!settle) return
      const body = editorRef.current?.getMarkdown()
      if (body != null) savedRef.current = body
    }, 30)
    window.addEventListener('beforeinput', stop, true)
    window.addEventListener('paste', stop, true)
    window.addEventListener('drop', stop, true)
    return () => {
      window.clearTimeout(id)
      window.removeEventListener('beforeinput', stop, true)
      window.removeEventListener('paste', stop, true)
      window.removeEventListener('drop', stop, true)
    }
  }, [external])

  const closeDialog = useCallback(() => {
    const current = dialogRef.current
    if (current && 'images' in current) revokePromptImages(current.images)
    dialogRef.current = null
    setDialog(null)
  }, [])

  const addDialogImages = useCallback(
    (files: File[]) => {
      const current = dialogRef.current
      if (!current || !('images' in current)) return
      void (async () => {
        const added = await takePromptImages(files, current.images.length, onToast, t)
        if (!added.length) return
        setDialog((prev) => {
          if (!prev || !('images' in prev)) return prev
          const next = { ...prev, images: [...prev.images, ...added] }
          dialogRef.current = next
          return next
        })
      })()
    },
    [onToast, t],
  )

  const fail = useCallback(
    (error: string) => {
      onToast(error)
      if (error.includes('API Key')) onNeedKey()
    },
    [onNeedKey, onToast],
  )

  const sendEquation = useCallback(async () => {
    const current = dialogRef.current
    if (!current || current.kind !== 'equation') return
    let latex = current.latex.trim()
    if (current.instruction.trim() || current.images.length) {
      setBusy(current.images.length ? t('busyRecognize') : t('busyFormula'))
      const response = await window.zention.aiComplete({
        system: EQUATION_SYSTEM,
        images: current.images.length ? promptPayload(current.images) : undefined,
        user: [
          current.images.length ? '请把图片中的公式转成 LaTeX。' : '',
          current.instruction.trim() ? `要求：${current.instruction.trim()}` : '整理并修正这个公式。',
          latex ? `已有公式：\n${latex}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      })
      setBusy('')
      if (!response.ok) {
        fail(response.error)
        return
      }
      latex = latexFromModel(response.content)
      if (!latex) {
        onToast(t('toastNoFormula'))
        return
      }
    }
    if (!latex) {
      onToast(t('toastNeedFormula'))
      return
    }
    const name = current.kindName === 'inline' ? 'inlineEquation' : 'blockEquation'
    const editor = editorRef.current
    if (!editor) return
    const composition = beginAiHistory()
    editor
      .chain()
      .focus()
      .setNodeSelection(current.pos)
      .command(({ tr }) => {
        tagAiHistory(tr, composition, true)
        return true
      })
      .updateAttributes(name, { latex })
      .run()
    closeDialog()
  }, [closeDialog, fail, onToast])

  const sendRecognize = useCallback(async () => {
    const current = dialogRef.current
    if (!current || current.kind !== 'recognize' || current.images.length === 0) return
    setBusy(t('busyRecognize'))
    const response = await window.zention.aiComplete({
      system: EQUATION_SYSTEM,
      images: promptPayload(current.images),
      user: '请把图片中的公式转成 LaTeX。',
    })
    setBusy('')
    if (!response.ok) {
      fail(response.error)
      return
    }
    const latex = latexFromModel(response.content)
    const parts = latex.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean)
    const editor = editorRef.current
    if (!latex || !editor || parts.length === 0) {
      onToast(t('toastNoRecognize'))
      return
    }
    const composition = beginAiHistory()
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tagAiHistory(tr, composition, true)
        return true
      })
      .insertContentAt(
        current.at,
        parts.map((item) => ({ type: 'blockEquation', attrs: { latex: item } })),
      )
      .run()
    closeDialog()
  }, [closeDialog, fail, onToast])

  const streamIntoPage = useCallback(
    async (input: { system: string; user: string; model?: string; images?: Array<{ mime: string; base64: string }> }, range: { from: number; to: number } | null, label: string) => {
      const editor = editorRef.current
      if (!editor) return false
      setBusy(label)
      streamingRef.current = true
      let acc = ''
      let from = range?.from ?? editor.state.selection.from
      let to = range?.to ?? from
      let queued = 0
      let opened = false
      const composition = beginAiHistory()
      const paint = (final: boolean) => {
        const current = editorRef.current
        const markdown = final ? markdownFromModel(acc) : acc
        if (!current || !markdown.trim()) return
        const next = replaceMarkdown(current, from, to, markdown, composition, !opened)
        if (!next) return
        opened = true
        from = next.from
        to = next.to
      }
      const onDelta = (delta: string) => {
        acc += delta
        if (queued) return
        queued = window.setTimeout(() => {
          queued = 0
          paint(false)
        }, 40)
      }
      const onReset = () => {
        acc = ''
        if (queued) window.clearTimeout(queued)
        queued = 0
      }
      try {
        const response = await window.zention.aiComplete(input, onDelta, onReset)
        if (queued) window.clearTimeout(queued)
        if (!response.ok) {
          if (acc.trim()) paint(true)
          fail(response.error)
          return false
        }
        acc = response.content
        paint(true)
        const body = editorRef.current?.getMarkdown()
        if (body != null) flush(body)
        return true
      } finally {
        streamingRef.current = false
        setBusy('')
      }
    },
    [fail, flush],
  )

  const writeAtCursor = useCallback(
    async (instruction: string, source: string, images: PromptImage[] = []) => {
      const ask = instruction.trim() || '请根据附上的图片来写。'
      await streamIntoPage(
        {
          system: REWRITE_SYSTEM,
          images: images.length ? promptPayload(images) : undefined,
          user: source ? `指令：${ask}\n\n已有内容：\n${source}` : `指令：${ask}`,
        },
        null,
        t('busyWrite'),
      )
    },
    [streamIntoPage],
  )

  const replaceRange = useCallback(
    async (from: number, to: number, text: string, instruction: string, images: PromptImage[] = []) => {
      const ask = instruction.trim() || '请根据附上的图片改写。'
      await streamIntoPage(
        {
          system: REWRITE_SYSTEM,
          images: images.length ? promptPayload(images) : undefined,
          user: `指令：${rewritePrompt(ask)}\n\n原文（Markdown，必须保留格式）：\n${text}`,
        },
        { from, to },
        t('busyRewrite'),
      )
    },
    [streamIntoPage],
  )

  const generateImage = useCallback(
    async (pos: number, place: 'above' | 'below', prompt: string, aspect: string) => {
      setBusy(t('busyImage'))
      const response = await window.zention.aiImage({ prompt, aspectRatio: aspect })
      setBusy('')
      const editor = editorRef.current
      if (!response.ok || !editor) {
        if (!response.ok) fail(response.error)
        return
      }
      const at = blockPoint(editor, pos, place)
      const composition = beginAiHistory()
      editor
        .chain()
        .focus()
        .command(({ tr }) => {
          tagAiHistory(tr, composition, true)
          return true
        })
        .insertContentAt(at, { type: 'image', attrs: { src: response.path, alt: prompt.slice(0, 80) } })
        .run()
    },
    [fail],
  )

  actionsRef.current = {
    aiContinue(editor, range) {
      const source = editor.state.doc.textBetween(Math.max(0, range.from - 4000), range.from, '\n')
      editor.chain().focus().deleteRange(range).run()
      void writeAtCursor('顺着上文续写一小段，不要重复原文。', source)
    },
    aiInstruct(editor, range) {
      editor.chain().focus().deleteRange(range).run()
      setDialog({ kind: 'insert', instruction: '', images: [] })
    },
    imageAbove(editor, range) {
      openImage(editor, range, 'above')
    },
    imageBelow(editor, range) {
      openImage(editor, range, 'below')
    },
    pickImage(editor, range) {
      editor.chain().focus().deleteRange(range).run()
      void window.zention.pickImage().then((result) => {
        if (!result.ok) onToast(result.error)
        else if (result.path) editorRef.current?.chain().focus().setImage({ src: result.path }).run()
      })
    },
    networkImage(editor, range) {
      editor.chain().focus().deleteRange(range).run()
      setDialog({ kind: 'url' })
    },
    recognizeFormula(editor, range) {
      editor.chain().focus().deleteRange(range).run()
      const next = { kind: 'recognize' as const, at: editor.state.selection.from, images: [] }
      dialogRef.current = next
      setDialog(next)
    },
  }

  function openImage(editor: Editor, range: Range, place: 'above' | 'below') {
    const text = editor.state.doc.resolve(range.from).parent.textContent.replace(/\//g, '').trim()
    editor.chain().focus().deleteRange(range).run()
    if (!text) {
      onToast(t('toastNoText'))
      return
    }
    setDialog({ kind: 'image', place, pos: editor.state.selection.from, prompt: illustrate(text), aspect: '16:9' })
  }

  const controller = useMemo<SlashController>(
    () => ({
      onOpen: (state) => setSlash(state),
      onUpdate: (state) => setSlash(state),
      onKeyDown: (event) => slashMenuRef.current?.handleKey(event) ?? false,
      onClose: () => setSlash(null),
    }),
    [],
  )

  const extensions = useMemo(
    () => buildExtensions({
      slashController: controller,
      slashItems: () => buildSlashItems(actionsRef.current),
      external,
    }),
    [controller, external],
  )

  const editor = useEditor({
    extensions,
    content: markdown,
    contentType: 'markdown',
    immediatelyRender: false,
    editorProps: {
      attributes: { class: 'page-editor', spellcheck: 'false' },
      handleClick(_view, _pos, event) {
        const href = (event.target as HTMLElement | null)?.closest('a')?.getAttribute('href')
        if (!href) return false
        event.preventDefault()
        void window.zention.openExternal(href)
        return true
      },
    },
    onUpdate: ({ editor: current }) => schedule(current.getMarkdown()),
  })

  useEffect(() => {
    editorRef.current = editor
  }, [editor])

  useEffect(() => {
    const onSelection = (event: Event) => setSelection((event as CustomEvent<SelectionSlashDetail>).detail)
    const onEquation = (event: Event) => {
      const detail = (event as CustomEvent<{ pos: number; latex: string; kind: 'inline' | 'block' }>).detail
      const next = emptyEquation(detail.pos, detail.kind, detail.latex)
      dialogRef.current = next
      setDialog(next)
    }
    const onEquationImage = (event: Event) => {
      const detail = (event as CustomEvent<{ pos: number; latex: string; kind: 'inline' | 'block'; file: File }>).detail
      const next = emptyEquation(detail.pos, detail.kind, detail.latex)
      dialogRef.current = next
      setDialog(next)
      addDialogImages([detail.file])
    }
    const onToastEvent = (event: Event) => onToast(String((event as CustomEvent).detail ?? ''))
    window.addEventListener('zention:selection-slash', onSelection)
    window.addEventListener('zention:edit-equation', onEquation)
    window.addEventListener('zention:equation-image', onEquationImage)
    window.addEventListener('zention:toast', onToastEvent)
    return () => {
      window.removeEventListener('zention:selection-slash', onSelection)
      window.removeEventListener('zention:edit-equation', onEquation)
      window.removeEventListener('zention:equation-image', onEquationImage)
      window.removeEventListener('zention:toast', onToastEvent)
    }
  }, [addDialogImages, onToast])

  const pickSelection = (id: string) => {
    const detail = selection
    const current = editorRef.current
    setSelection(null)
    if (!detail || !current) return
    const source = detail.markdown || detail.text
    if (id === 'ai') setDialog({ kind: 'replace', from: detail.from, to: detail.to, text: source, instruction: '', images: [] })
    const preset = instructionFor(id)
    if (preset) void replaceRange(detail.from, detail.to, source, preset)
    if (id === 'above' || id === 'below') {
      setDialog({
        kind: 'image',
        place: id === 'above' ? 'above' : 'below',
        pos: detail.from,
        prompt: illustrate(detail.text),
        aspect: '16:9',
      })
    }
    const chain = current.chain().focus().setTextSelection({ from: detail.from, to: detail.to })
    if (id === 'merge') mergeSelectionIntoBlock(current, detail.from, detail.to)
    if (id === 'code' && selectionToCodeBlock(current, detail.from, detail.to)) {
      const pos = codeBlockPos(current)
      const block = pos == null ? null : current.state.doc.nodeAt(pos)
      if (pos != null && block?.textContent.trim()) requestCodeIndent(pos)
    }
    if (id === 'h1') chain.setHeading({ level: 1 }).run()
    if (id === 'h2') chain.setHeading({ level: 2 }).run()
    if (id === 'quote') chain.toggleBlockquote().run()
    if (id === 'task') chain.toggleTaskList().run()
  }

  return (
    <div className="editor-wrap">
      <EditorContent editor={editor} />
      <SlashMenu ref={slashMenuRef} state={slash} onDismiss={() => setSlash(null)} />
      <SelectionMenu detail={selection} onPick={pickSelection} onClose={() => setSelection(null)} />
      {dialog ? (
        <DialogView
          dialog={dialog}
          busy={busy}
          onChange={setDialog}
          onClose={closeDialog}
          onPasteImage={addDialogImages}
          onToast={onToast}
          onRun={() => {
            const current = dialog
            if (!current) return
            if (current.kind === 'insert') {
              const source = editorRef.current?.state.doc.textBetween(
                Math.max(0, (editorRef.current?.state.selection.from ?? 0) - 4000),
                editorRef.current?.state.selection.from ?? 0,
                '\n',
              )
              const images = current.images
              closeDialog()
              void writeAtCursor(current.instruction, source ?? '', images)
            } else if (current.kind === 'replace') {
              const images = current.images
              closeDialog()
              void replaceRange(current.from, current.to, current.text, current.instruction, images)
            } else if (current.kind === 'image') {
              setDialog(null)
              void generateImage(current.pos, current.place, current.prompt, current.aspect)
            } else if (current.kind === 'url') {
              const input = document.getElementById('network-image-url') as HTMLInputElement | null
              const url = input?.value.trim() ?? ''
              setDialog(null)
              if (url) editorRef.current?.chain().focus().setImage({ src: url, alt: t('networkImage') }).run()
            } else if (current.kind === 'equation') {
              void sendEquation()
            } else if (current.kind === 'recognize') {
              void sendRecognize()
            }
          }}
        />
      ) : null}
      {busy ? <div className="busy">{busy}</div> : null}
    </div>
  )
}

function DialogView({
  dialog,
  busy,
  onChange,
  onClose,
  onPasteImage,
  onToast,
  onRun,
}: {
  dialog: Dialog
  busy: string
  onChange: (dialog: Dialog) => void
  onClose: () => void
  onPasteImage: (files: File[]) => void
  onToast: (message: string) => void
  onRun: () => void
}) {
  const { t } = useI18n()
  const title =
    dialog.kind === 'image'
      ? dialog.place === 'above'
        ? t('imageAboveTitle')
        : t('imageBelowTitle')
      : dialog.kind === 'url'
        ? t('networkImage')
        : dialog.kind === 'equation'
          ? t('editFormula')
          : dialog.kind === 'recognize'
            ? t('recognizeTitle')
            : t('aiPrompt')
  const sendText = (() => {
    if (busy) return busy
    if (dialog.kind === 'url') return t('insert')
    if ((dialog.kind === 'equation' || dialog.kind === 'recognize') && dialog.images.length) return t('recognizeWrite')
    return t('send')
  })()
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal compact"
        onMouseDown={(event) => event.stopPropagation()}
        onPaste={(event) => {
          if (!('images' in dialog)) return
          const files = imageFiles(event.clipboardData)
          if (!files.length) return
          event.preventDefault()
          onPasteImage(files)
        }}
        onSubmit={(event) => {
          event.preventDefault()
          onRun()
        }}
      >
        <header>
          <h2>{title}</h2>
          <button type="button" onClick={onClose}>
            {t('close')}
          </button>
        </header>
        {dialog.kind === 'insert' || dialog.kind === 'replace' ? (
          <>
            <textarea
              autoFocus
              rows={5}
              placeholder={t('promptPh')}
              value={dialog.instruction}
              onChange={(event) => onChange({ ...dialog, instruction: event.target.value })}
            />
            <AttachmentBar
              images={dialog.images}
              disabled={!!busy}
              onToast={onToast}
              onChange={(images) => onChange({ ...dialog, images })}
            />
          </>
        ) : null}
        {dialog.kind === 'image' ? (
          <>
            <textarea rows={6} value={dialog.prompt} onChange={(event) => onChange({ ...dialog, prompt: event.target.value })} />
            <label>
              {t('aspect')}
              <select value={dialog.aspect} onChange={(event) => onChange({ ...dialog, aspect: event.target.value })}>
                <option value="16:9">16:9</option>
                <option value="1:1">1:1</option>
                <option value="4:3">4:3</option>
                <option value="9:16">9:16</option>
              </select>
            </label>
          </>
        ) : null}
        {dialog.kind === 'url' ? <input id="network-image-url" autoFocus placeholder="https://" /> : null}
        {dialog.kind === 'equation' ? (
          <>
            <label>
              LaTeX
              <textarea rows={4} value={dialog.latex} onChange={(event) => onChange({ ...dialog, latex: event.target.value })} />
            </label>
            {dialog.latex.trim() ? (
              <div
                className="equation-preview"
                dangerouslySetInnerHTML={{ __html: renderLatexToHtml(dialog.latex, dialog.kindName === 'block') }}
              />
            ) : null}
            <label>
              {t('eqAiLabel')}
              <textarea
                rows={3}
                placeholder={t('formulaPh')}
                value={dialog.instruction}
                onChange={(event) => onChange({ ...dialog, instruction: event.target.value })}
              />
            </label>
            <AttachmentBar
              images={dialog.images}
              disabled={!!busy}
              onToast={onToast}
              onChange={(images) => onChange({ ...dialog, images })}
            />
          </>
        ) : null}
        {dialog.kind === 'recognize' ? (
          <>
            <p className="hint">{t('eqRecognizeHint')}</p>
            <AttachmentBar
              images={dialog.images}
              disabled={!!busy}
              onToast={onToast}
              onChange={(images) => onChange({ ...dialog, images })}
            />
          </>
        ) : null}
        <button
          type="submit"
          className="send-btn"
          disabled={
            !!busy ||
            ((dialog.kind === 'insert' || dialog.kind === 'replace') && !dialog.instruction.trim() && dialog.images.length === 0) ||
            (dialog.kind === 'image' && !dialog.prompt.trim()) ||
            (dialog.kind === 'equation' && !dialog.latex.trim() && !dialog.instruction.trim() && dialog.images.length === 0) ||
            (dialog.kind === 'recognize' && dialog.images.length === 0)
          }
        >
          {sendText}
        </button>
        <footer>
          <button type="button" onClick={onClose}>
            {t('cancel')}
          </button>
        </footer>
      </form>
    </div>
  )
}
