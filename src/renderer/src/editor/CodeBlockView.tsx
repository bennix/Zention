import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { NodeViewContent, NodeViewWrapper } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'
import { AttachmentBar, imageFiles, revokePromptImages, takePromptImages, type PromptImage } from '../components/Attachments'
import { beginAiHistory, tagAiHistory } from './aiHistory'
import { CODE_LANGUAGES, parseIndentedCode } from './codeHighlight'
import { subscribeCodeIndent, takeCodeIndent } from './codeIndent'
import { useI18n } from '../i18n'

function indentSystem(language: string | null): string {
  const rules = '不要增删语句，不要改标识符、字符串内容和注释文字。只把行首空白改成这种语言惯用的空格缩进。只返回代码本身，不要 Markdown 围栏，不要解释。'
  if (language && language !== 'plaintext') return `你只整理 ${language} 代码的缩进。${rules}`
  return `你先判断语言，再只整理缩进。第一行必须是 LANG:语言。语言只能是 javascript、typescript、python、json、bash、html、css、sql、markdown、mermaid、plaintext 之一。空一行后再写代码。${rules}`
}

function cleanMermaid(value: string): string {
  let source = value.trim()
  const fenced = source.match(/^```(?:mermaid)?\s*\n([\s\S]*?)\n```$/i)
  if (fenced?.[1]) source = fenced[1].trim()
  return source
}

export function CodeBlockView({ node, updateAttributes, editor, getPos }: NodeViewProps) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState(false)
  const [diagram, setDiagram] = useState('')
  const [renderError, setRenderError] = useState('')
  const [aiOpen, setAiOpen] = useState(false)
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiImages, setAiImages] = useState<PromptImage[]>([])
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState('')
  const [indentBusy, setIndentBusy] = useState(false)
  const [indentError, setIndentError] = useState('')
  const indenting = useRef(false)
  const renderId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const language = String(node.attrs.language ?? '') || 'plaintext'
  const isMermaid = language === 'mermaid'

  const formatIndent = useCallback(async () => {
    if (indenting.current) return
    const source = node.textContent
    if (!source.trim()) return
    const known = (CODE_LANGUAGES as readonly string[]).includes(language) && language !== 'plaintext' ? language : null
    indenting.current = true
    setIndentBusy(true)
    setIndentError('')
    try {
      const response = await window.zention.aiComplete({
        system: indentSystem(known),
        user: source,
      })
      if (!response.ok) {
        setIndentError(response.error)
        return
      }
      const pos = typeof getPos === 'function' ? getPos() : undefined
      const current = typeof pos === 'number' ? editor.state.doc.nodeAt(pos) : null
      const chosen = String(current?.attrs.language ?? '')
      const languageNow = (CODE_LANGUAGES as readonly string[]).includes(chosen) && chosen !== 'plaintext' ? chosen : known
      const parsed = parseIndentedCode(response.content, languageNow)
      if (!parsed || typeof pos !== 'number' || !current || current.type.name !== 'codeBlock' || current.textContent !== source) {
        setIndentError(t(parsed ? 'codeIndentMoved' : 'codeIndentEmpty'))
        return
      }
      const nextLanguage = parsed.language
      if (current.textContent !== parsed.code) {
        const composition = beginAiHistory()
        const replacement = current.type.create(
          { ...current.attrs, language: nextLanguage },
          editor.schema.text(parsed.code),
        )
        const tr = editor.state.tr.replaceWith(pos, pos + current.nodeSize, replacement)
        tagAiHistory(tr, composition, true)
        editor.view.dispatch(tr)
      } else if ((current.attrs.language ?? null) !== nextLanguage) {
        updateAttributes({ language: nextLanguage })
      }
    } finally {
      indenting.current = false
      setIndentBusy(false)
    }
  }, [editor, getPos, language, node, t, updateAttributes])

  useEffect(() => {
    const run = () => {
      const pos = typeof getPos === 'function' ? getPos() : undefined
      if (typeof pos !== 'number' || !takeCodeIndent(pos)) return
      void formatIndent()
    }
    run()
    return subscribeCodeIndent(run)
  }, [formatIndent, getPos])

  useEffect(() => {
    if (!isMermaid || editing || !node.textContent.trim()) return
    let cancelled = false
    // mermaid.render removes any node that already uses this id. Reusing the id
    // deletes the picture on screen, and an identical SVG string does not make React draw it again.
    const diagramId = `zention-mermaid-${renderId}-${crypto.randomUUID()}`
    void import('mermaid').then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme: 'neutral' })
      try {
        const result = await mermaid.render(diagramId, node.textContent)
        if (!cancelled) {
          setDiagram(result.svg)
          setRenderError('')
        }
      } catch (error) {
        if (!cancelled) {
          setDiagram('')
          setRenderError(error instanceof Error ? error.message : String(error))
        }
      }
    })
    return () => {
      cancelled = true
    }
  }, [editing, isMermaid, node.textContent, renderId])

  const copy = () => {
    void navigator.clipboard.writeText(node.textContent).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    })
  }

  const applyAi = async () => {
    if ((!aiPrompt.trim() && aiImages.length === 0) || aiBusy) return
    setAiBusy(true)
    setAiError('')
    const ask = aiPrompt.trim() || '请根据附上的图片修改。'
    const response = await window.zention.aiComplete({
      system:
        '你是 Mermaid 源码编辑器。只返回合法 Mermaid 源码，不要 Markdown 围栏，不要解释。可见标签使用用户的语言。不要 HTML、点击事件或外链。',
      images: aiImages.length ? aiImages.map(({ mime, base64 }) => ({ mime, base64 })) : undefined,
      user: `按指令修改下面的 Mermaid。\n\n指令：\n${ask}\n\n当前源码：\n${node.textContent}`,
    })
    setAiBusy(false)
    if (!response.ok) {
      setAiError(response.error)
      return
    }
    const source = cleanMermaid(response.content)
    if (!source) {
      setAiError(t('mermaidEmpty'))
      return
    }
    const pos = typeof getPos === 'function' ? getPos() : undefined
    if (typeof pos !== 'number') {
      setAiError(t('mermaidMoved'))
      return
    }
    const replacement = node.type.create(node.attrs, editor.schema.text(source))
    const tr = editor.state.tr.replaceWith(pos, pos + node.nodeSize, replacement)
    tagAiHistory(tr, beginAiHistory(), true)
    editor.view.dispatch(tr)
    setAiPrompt('')
    setAiImages((current) => {
      revokePromptImages(current)
      return []
    })
    setAiOpen(false)
    setEditing(false)
  }

  return (
    <NodeViewWrapper className={`md-codeblock${isMermaid ? ' md-mermaid-block' : ''}`}>
      <div className="md-codeblock-bar" contentEditable={false}>
        <select
          value={(CODE_LANGUAGES as readonly string[]).includes(language) ? language : 'plaintext'}
          onChange={(event) => updateAttributes({ language: event.target.value === 'plaintext' ? null : event.target.value })}
        >
          {CODE_LANGUAGES.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <button type="button" onClick={copy}>
          {copied ? t('codeCopied') : t('codeCopy')}
        </button>
        <button type="button" onClick={() => void formatIndent()} disabled={indentBusy || !node.textContent.trim()}>
          {indentBusy ? t('codeIndenting') : t('codeIndent')}
        </button>
        {isMermaid && (
          <button type="button" onClick={() => setEditing((value) => !value)}>
            {editing ? t('codePreview') : t('codeSource')}
          </button>
        )}
        {isMermaid && (
          <button
            type="button"
            onClick={() => {
              setAiOpen((open) => {
                if (open) {
                  setAiImages((current) => {
                    revokePromptImages(current)
                    return []
                  })
                }
                return !open
              })
            }}
          >
            {t('mermaidAi')}
          </button>
        )}
      </div>
      {isMermaid && aiOpen && (
        <div
          className="md-mermaid-ai"
          contentEditable={false}
          onPaste={(event) => {
            const files = imageFiles(event.clipboardData)
            if (!files.length) return
            event.preventDefault()
            event.stopPropagation()
            void takePromptImages(files, aiImages.length, setAiError, t).then((added) => {
              if (added.length) setAiImages((current) => [...current, ...added])
            })
          }}
        >
          <textarea
            value={aiPrompt}
            placeholder={t('mermaidPh')}
            onChange={(event) => setAiPrompt(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void applyAi()
            }}
          />
          <AttachmentBar
            images={aiImages}
            disabled={aiBusy}
            onToast={setAiError}
            onChange={setAiImages}
          />
          <button type="button" className="send-btn" onClick={() => void applyAi()} disabled={aiBusy || (!aiPrompt.trim() && aiImages.length === 0)}>
            {aiBusy ? t('sending') : t('send')}
          </button>
          <button
            type="button"
            onClick={() => {
              setAiImages((current) => {
                revokePromptImages(current)
                return []
              })
              setAiOpen(false)
            }}
            disabled={aiBusy}
          >
            {t('cancel')}
          </button>
          {aiError ? <p className="error">{aiError}</p> : null}
        </div>
      )}
      {indentError ? (
        <p className="error" contentEditable={false}>
          {indentError}
        </p>
      ) : null}
      {isMermaid && !editing && (
        <div className="md-mermaid-preview" contentEditable={false} onDoubleClick={() => setEditing(true)}>
          {renderError ? <p className="error">{renderError}</p> : null}
          {!renderError && diagram ? <div dangerouslySetInnerHTML={{ __html: diagram }} /> : null}
          {!renderError && !diagram ? <p className="muted">{t('mermaidDrawing')}</p> : null}
        </div>
      )}
      <pre style={isMermaid && !editing ? { display: 'none' } : undefined}>
        <NodeViewContent<'code'> as="code" />
      </pre>
    </NodeViewWrapper>
  )
}
