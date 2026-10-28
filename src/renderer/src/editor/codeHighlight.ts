import { createLowlight, type LanguageFn } from 'lowlight'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import go from 'highlight.js/lib/languages/go'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import markdown from 'highlight.js/lib/languages/markdown'
import php from 'highlight.js/lib/languages/php'
import plaintext from 'highlight.js/lib/languages/plaintext'
import python from 'highlight.js/lib/languages/python'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'

export const FLOW_LANGUAGES = ['javascript', 'typescript', 'python', 'java', 'c', 'cpp', 'csharp', 'go', 'rust', 'php', 'ruby', 'kotlin', 'swift', 'bash'] as const

export const CODE_LANGUAGES = ['plaintext', 'mermaid', ...FLOW_LANGUAGES, 'json', 'html', 'css', 'sql', 'markdown'] as const

export const codeLowlight = createLowlight()

codeLowlight.register({
  bash: bash as LanguageFn,
  c: c as LanguageFn,
  cpp: cpp as LanguageFn,
  csharp: csharp as LanguageFn,
  css: css as LanguageFn,
  go: go as LanguageFn,
  html: xml as LanguageFn,
  java: java as LanguageFn,
  javascript: javascript as LanguageFn,
  json: json as LanguageFn,
  kotlin: kotlin as LanguageFn,
  markdown: markdown as LanguageFn,
  mermaid: plaintext as LanguageFn,
  php: php as LanguageFn,
  plaintext: plaintext as LanguageFn,
  python: python as LanguageFn,
  ruby: ruby as LanguageFn,
  rust: rust as LanguageFn,
  sql: sql as LanguageFn,
  swift: swift as LanguageFn,
  typescript: typescript as LanguageFn,
  xml: xml as LanguageFn,
})

export function isFlowchart(source: string): boolean {
  return /^\s*(?:%%[^\n]*\n\s*)*(?:flowchart|graph)\b/i.test(source)
}

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
