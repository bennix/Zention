import { citationIds } from '../../../shared/pages'

export async function citedContext(text: string): Promise<string> {
  const ids = citationIds(text)
  if (!ids.length) return ''
  const blocks: string[] = []
  for (const id of ids) {
    const result = await window.zention.readPage(id)
    if (!result.ok) continue
    const body = result.page.body.trim().slice(0, 6000)
    blocks.push(`### ${result.page.title}\n${body || '（空）'}`)
  }
  if (!blocks.length) return ''
  return `\n\n以下是 @ 指向的已有笔记，请据此回答：\n\n${blocks.join('\n\n')}`
}
