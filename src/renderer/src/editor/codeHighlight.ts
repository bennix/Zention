import { createLowlight, type LanguageFn } from 'lowlight'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import plaintext from 'highlight.js/lib/languages/plaintext'
import python from 'highlight.js/lib/languages/python'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'

export const CODE_LANGUAGES = ['plaintext', 'mermaid', 'javascript', 'typescript', 'python', 'json', 'bash', 'html', 'css', 'sql', 'markdown'] as const

export const codeLowlight = createLowlight()

codeLowlight.register({
  bash: bash as LanguageFn,
  css: css as LanguageFn,
  html: xml as LanguageFn,
  javascript: javascript as LanguageFn,
  json: json as LanguageFn,
  markdown: markdown as LanguageFn,
  mermaid: plaintext as LanguageFn,
  plaintext: plaintext as LanguageFn,
  python: python as LanguageFn,
  sql: sql as LanguageFn,
  typescript: typescript as LanguageFn,
  xml: xml as LanguageFn,
})

export function parseIndentedCode(raw: string, known: string | null): { language: string | null; code: string } | null {
  let source = raw.replace(/^\uFEFF/, '').trim()
  let language = known && known !== 'plaintext' ? known : null
  const fenced = source.match(/^```([A-Za-z0-9#+.-]*)[^\n]*\n([\s\S]*?)\n?```$/)
  if (fenced) {
    const hinted = fenced[1]?.toLowerCase()
    if (!language && hinted && (CODE_LANGUAGES as readonly string[]).includes(hinted) && hinted !== 'plaintext') language = hinted
    source = fenced[2] ?? ''
  }
  const langLine = source.match(/^LANG:\s*([A-Za-z0-9#+.-]+)\s*\n([\s\S]*)$/)
  if (langLine) {
    const hinted = langLine[1]?.toLowerCase() ?? ''
    if (!language && (CODE_LANGUAGES as readonly string[]).includes(hinted)) language = hinted === 'plaintext' ? null : hinted
    source = (langLine[2] ?? '').replace(/^\n/, '')
  }
  const code = source.replace(/\s+$/, '')
  if (!code.trim()) return null
  return { language, code }
}
