import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import type { Editor, Range } from '@tiptap/core'
import { beginAiHistory, tagAiHistory } from '../editor/aiHistory'
import { instructionFor, rewritePrompt } from '../editor/rewrite'
import { buildExtensions } from '../editor/extensions'
import { latexFromModel, renderLatexToHtml } from '../editor/latex'
import { buildSlashItems, type SlashActions, type SlashController, type SlashMenuState, type SelectionSlashDetail } from '../editor/slash'
import { registerFlush } from '../flush'
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

type EquationImage = { mime: string; base64: string }

type Dialog =
  | { kind: 'insert'; instruction: string }
  | { kind: 'replace'; from: number; to: number; text: string; instruction: string }
  | { kind: 'image'; place: 'above' | 'below'; pos: number; prompt: string; aspect: string }
  | { kind: 'url' }
  | { kind: 'recognize'; at: number; image: EquationImage | null; previewUrl: string | null }
  | {
      kind: 'equation'
      pos: number
      kindName: 'inline' | 'block'
      latex: string
      instruction: string
      image: EquationImage | null
      previewUrl: string | null
    }

function emptyEquation(pos: number, kindName: 'inline' | 'block', latex: string): Dialog {
  return { kind: 'equation', pos, kindName, latex, instruction: '', image: null, previewUrl: null }
}

function imageFile(data: DataTransfer | null): File | null {
  if (!data) return null
  for (const item of data.items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile()
      if (file) return file
    }
  }
  for (const file of data.files) {
    if (file.type.startsWith('image/')) return file
  }
  return null
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

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary)
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
    if ((current?.kind === 'equation' || current?.kind === 'recognize') && current.previewUrl) URL.revokeObjectURL(current.previewUrl)
    dialogRef.current = null
    setDialog(null)
  }, [])

  const pasteEquationImage = useCallback(
    (file: File) => {
      const current = dialogRef.current
      if (!current || (current.kind !== 'equation' && current.kind !== 'recognize')) return
      if (!/^image\/(png|jpeg|jpg|gif|webp)$/i.test(file.type)) {
        onToast(t('toastImageType'))
        return
      }
      if (file.size > 8_000_000) {
        onToast(t('toastImageBig'))
        return
      }
      void (async () => {
        const base64 = await fileToBase64(file)
        const mime = file.type.toLowerCase() === 'image/jpg' ? 'image/jpeg' : file.type
        const previewUrl = URL.createObjectURL(file)
        const image = { mime, base64 }
        setDialog((prev) => {
          if (!prev || (prev.kind !== 'equation' && prev.kind !== 'recognize')) return prev
          if (prev.previewUrl) URL.revokeObjectURL(prev.previewUrl)
          const next = { ...prev, image, previewUrl }
          dialogRef.current = next
          return next
        })
      })()
    },
    [onToast],
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
    if (current.instruction.trim() || current.image) {
      setBusy(current.image ? t('busyRecognize') : t('busyFormula'))
      const response = await window.zention.aiComplete({
        system: EQUATION_SYSTEM,
        temperature: current.image ? 0.1 : 0.2,
        images: current.image ? [current.image] : undefined,
        user: [
          current.image ? '请把图片中的公式转成 LaTeX。' : '',
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
    if (!current || current.kind !== 'recognize' || !current.image) return
    setBusy(t('busyRecognize'))
    const response = await window.zention.aiComplete({
      system: EQUATION_SYSTEM,
      temperature: 0.1,
      images: [current.image],
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
    async (input: { system: string; user: string }, range: { from: number; to: number } | null, label: string) => {
      const editor = editorRef.current
      if (!editor) return
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
      try {
        const response = await window.zention.aiComplete(input, onDelta)
        if (queued) window.clearTimeout(queued)
        if (!response.ok) {
          if (acc.trim()) paint(true)
          fail(response.error)
          return
        }
        acc = response.content
        paint(true)
        const body = editorRef.current?.getMarkdown()
        if (body != null) flush(body)
      } finally {
        streamingRef.current = false
        setBusy('')
      }
    },
    [fail, flush],
  )

  const writeAtCursor = useCallback(
    async (instruction: string, source: string) => {
      await streamIntoPage(
        {
          system: REWRITE_SYSTEM,
          user: source ? `指令：${instruction}\n\n已有内容：\n${source}` : `指令：${instruction}`,
        },
        null,
        t('busyWrite'),
      )
    },
    [streamIntoPage],
  )

  const replaceRange = useCallback(
    async (from: number, to: number, text: string, instruction: string) => {
      await streamIntoPage(
        {
          system: REWRITE_SYSTEM,
          user: `指令：${rewritePrompt(instruction)}\n\n原文（Markdown，必须保留格式）：\n${text}`,
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
      setDialog({ kind: 'insert', instruction: '' })
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
      const next = { kind: 'recognize' as const, at: editor.state.selection.from, image: null, previewUrl: null }
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
      pasteEquationImage(detail.file)
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
  }, [onToast, pasteEquationImage])

  const pickSelection = (id: string) => {
    const detail = selection
    const current = editorRef.current
    setSelection(null)
    if (!detail || !current) return
    const source = detail.markdown || detail.text
    if (id === 'ai') setDialog({ kind: 'replace', from: detail.from, to: detail.to, text: source, instruction: '' })
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
          onPasteImage={pasteEquationImage}
          onRun={() => {
            const current = dialog
            if (!current) return
            if (current.kind === 'insert') {
              const source = editorRef.current?.state.doc.textBetween(
                Math.max(0, (editorRef.current?.state.selection.from ?? 0) - 4000),
                editorRef.current?.state.selection.from ?? 0,
                '\n',
              )
              setDialog(null)
              void writeAtCursor(current.instruction, source ?? '')
            } else if (current.kind === 'replace') {
              setDialog(null)
              void replaceRange(current.from, current.to, current.text, current.instruction)
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

function FormulaImageZone({
  dialog,
  onPasteImage,
}: {
  dialog: { image: EquationImage | null; previewUrl: string | null }
  onPasteImage: (file: File) => void
}) {
  const { t } = useI18n()
  return (
    <div
      className="paste-zone"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault()
        const file = imageFile(event.dataTransfer)
        if (file) onPasteImage(file)
      }}
    >
      {dialog.previewUrl ? <img src={dialog.previewUrl} alt="" /> : null}
      <span>{dialog.image ? t('eqReady') : t('eqPaste')}</span>
      <label className="file-btn">
        {t('pickImage')}
        <input
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) onPasteImage(file)
            event.target.value = ''
          }}
        />
      </label>
    </div>
  )
}

function DialogView({
  dialog,
  busy,
  onChange,
  onClose,
  onPasteImage,
  onRun,
}: {
  dialog: Dialog
  busy: string
  onChange: (dialog: Dialog) => void
  onClose: () => void
  onPasteImage: (file: File) => void
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
    if ((dialog.kind === 'equation' || dialog.kind === 'recognize') && dialog.image) return t('recognizeWrite')
    return t('send')
  })()
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal compact"
        onMouseDown={(event) => event.stopPropagation()}
        onPaste={(event) => {
          if (dialog.kind !== 'equation' && dialog.kind !== 'recognize') return
          const file = imageFile(event.clipboardData)
          if (!file) return
          event.preventDefault()
          onPasteImage(file)
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
          <textarea
            autoFocus
            rows={5}
            placeholder={t('promptPh')}
            value={dialog.instruction}
            onChange={(event) => onChange({ ...dialog, instruction: event.target.value })}
          />
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
            <FormulaImageZone dialog={dialog} onPasteImage={onPasteImage} />
          </>
        ) : null}
        {dialog.kind === 'recognize' ? (
          <>
            <p className="hint">{t('eqRecognizeHint')}</p>
            <FormulaImageZone dialog={dialog} onPasteImage={onPasteImage} />
          </>
        ) : null}
        <button
          type="submit"
          className="send-btn"
          disabled={
            !!busy ||
            ((dialog.kind === 'insert' || dialog.kind === 'replace') && !dialog.instruction.trim()) ||
            (dialog.kind === 'image' && !dialog.prompt.trim()) ||
            (dialog.kind === 'equation' && !dialog.latex.trim() && !dialog.instruction.trim() && !dialog.image) ||
            (dialog.kind === 'recognize' && !dialog.image)
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
