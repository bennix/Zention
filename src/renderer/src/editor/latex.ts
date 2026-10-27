import katex from 'katex'

/** Drop redundant `$` that are already inside math mode. Mirrors GenOffice. */
export function stripNestedMathDelimiters(tex: string): string {
  let output = ''
  for (let index = 0; index < tex.length; index += 1) {
    const character = tex[index] ?? ''
    if (character !== '$') {
      output += character
      continue
    }
    let backslashes = 0
    for (let cursor = index - 1; cursor >= 0 && tex[cursor] === '\\'; cursor -= 1) backslashes += 1
    if (backslashes % 2 === 1) output += character
  }
  return output
}

/** Keep only the formula when a model wraps it in fences or math delimiters. */
export function latexFromModel(raw: string): string {
  let text = raw.trim()
  const fence = text.match(/```(?:latex|tex)?\s*([\s\S]*?)```/i)
  if (fence?.[1]) text = fence[1].trim()
  text = text.replace(/^(?:latex|tex)\s*[:：]\s*/i, '')
  text = text.replace(/^\$\$([\s\S]*)\$\$$/, '$1').trim()
  text = text.replace(/^\\\[([\s\S]*)\\\]$/, '$1').trim()
  text = text.replace(/^\\\(([\s\S]*)\\\)$/, '$1').trim()
  text = text.replace(/^\$(.*)\$$/s, '$1').trim()
  return stripNestedMathDelimiters(text).trim()
}

export function renderLatexToHtml(tex: string, displayMode: boolean): string {
  const normalized = stripNestedMathDelimiters(tex).replace(/\\_/g, '_')
  return katex.renderToString(normalized, {
    displayMode,
    throwOnError: false,
    strict: 'ignore',
    trust: false,
    output: 'htmlAndMathml',
  })
}
