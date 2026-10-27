import { useEffect, useId, useState } from 'react'
import { NodeViewContent, NodeViewWrapper } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'
import { beginAiHistory, tagAiHistory } from './aiHistory'
import { useI18n } from '../i18n'

const LANGUAGES = ['plaintext', 'mermaid', 'javascript', 'typescript', 'python', 'json', 'bash', 'html', 'css', 'sql', 'markdown']

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
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState('')
  const renderId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const language = String(node.attrs.language ?? '') || 'plaintext'
  const isMermaid = language === 'mermaid'

  useEffect(() => {
    if (!isMermaid || editing || !node.textContent.trim()) return
    let cancelled = false
    void import('mermaid').then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme: 'neutral' })
      try {
        const result = await mermaid.render(`zention-mermaid-${renderId}`, node.textContent)
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
    if (!aiPrompt.trim() || aiBusy) return
    setAiBusy(true)
    setAiError('')
    const response = await window.zention.aiComplete({
      system:
        '你是 Mermaid 源码编辑器。只返回合法 Mermaid 源码，不要 Markdown 围栏，不要解释。可见标签使用用户的语言。不要 HTML、点击事件或外链。',
      user: `按指令修改下面的 Mermaid。\n\n指令：\n${aiPrompt.trim()}\n\n当前源码：\n${node.textContent}`,
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
    setAiOpen(false)
    setEditing(false)
  }

  return (
    <NodeViewWrapper className={`md-codeblock${isMermaid ? ' md-mermaid-block' : ''}`}>
      <div className="md-codeblock-bar" contentEditable={false}>
        <select
          value={LANGUAGES.includes(language) ? language : 'plaintext'}
          onChange={(event) => updateAttributes({ language: event.target.value === 'plaintext' ? null : event.target.value })}
        >
          {LANGUAGES.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <button type="button" onClick={copy}>
          {copied ? t('codeCopied') : t('codeCopy')}
        </button>
        {isMermaid && (
          <button type="button" onClick={() => setEditing((value) => !value)}>
            {editing ? t('codePreview') : t('codeSource')}
          </button>
        )}
        {isMermaid && (
          <button type="button" onClick={() => setAiOpen((value) => !value)}>
            {t('mermaidAi')}
          </button>
        )}
      </div>
      {isMermaid && aiOpen && (
        <div className="md-mermaid-ai" contentEditable={false}>
          <textarea
            value={aiPrompt}
            placeholder={t('mermaidPh')}
            onChange={(event) => setAiPrompt(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void applyAi()
            }}
          />
          <button type="button" className="send-btn" onClick={() => void applyAi()} disabled={aiBusy || !aiPrompt.trim()}>
            {aiBusy ? t('sending') : t('send')}
          </button>
          <button type="button" onClick={() => setAiOpen(false)} disabled={aiBusy}>
            {t('cancel')}
          </button>
          {aiError ? <p className="error">{aiError}</p> : null}
        </div>
      )}
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
