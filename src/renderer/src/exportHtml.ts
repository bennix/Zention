import { renderLatexToHtml } from './editor/latex'

export function decorateExportHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<div id="zention-export">${html}</div>`, 'text/html')
  doc.querySelectorAll('[data-latex]').forEach((node) => {
    const latex = node.getAttribute('data-latex') ?? ''
    const display = node.tagName === 'DIV' || node.classList.contains('md-equation-block')
    node.innerHTML = renderLatexToHtml(latex, display)
  })
  return doc.getElementById('zention-export')?.innerHTML ?? html
}
