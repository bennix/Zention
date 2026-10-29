export interface PageOrganize {
  parentId: string | null
  folder: boolean
  group: string
  tags: string[]
}

export const PAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function cleanGroup(group: unknown): string {
  return String(group ?? '')
    .replace(/[\r\n{}]/g, ' ')
    .trim()
    .slice(0, 40)
}

export function cleanTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return []
  const out: string[] = []
  for (const tag of tags) {
    const text = String(tag)
      .replace(/[^\p{L}\p{N}\-_. ]/gu, '')
      .trim()
      .slice(0, 24)
    if (!text || out.includes(text)) continue
    out.push(text)
    if (out.length >= 12) break
  }
  return out
}

export function organizeOf(page: { parentId?: string | null; folder?: boolean; group?: string; tags?: string[] } | null | undefined): PageOrganize {
  const parent = page?.parentId?.trim().toLowerCase() ?? ''
  return {
    parentId: PAGE_ID_RE.test(parent) ? parent : null,
    folder: page?.folder === true,
    group: cleanGroup(page?.group),
    tags: cleanTags(page?.tags),
  }
}

export function organizeKey(org: PageOrganize): string {
  if (!org.parentId && !org.folder && !org.group && org.tags.length === 0) return ''
  return JSON.stringify({ parentId: org.parentId, folder: org.folder, group: org.group, tags: org.tags })
}

export function markerFor(id: string, page: { parentId?: string | null; folder?: boolean; group?: string; tags?: string[] }): string {
  const key = organizeKey(organizeOf(page))
  return key ? `<!-- zention:${id} ${key} -->` : `<!-- zention:${id} -->`
}

export function pageHref(id: string): string {
  return `zention-page:${id}`
}

export function pageIdFromHref(href: string): string | null {
  const match = href.match(/zention-page:([0-9a-f-]{36})/i)
  if (!match?.[1] || !PAGE_ID_RE.test(match[1])) return null
  return match[1].toLowerCase()
}

export function relativeRepoPath(fromFile: string, toFile: string): string {
  const fromDir = fromFile.split('/').slice(0, -1)
  const toParts = toFile.split('/')
  let shared = 0
  while (shared < fromDir.length && shared < toParts.length && fromDir[shared] === toParts[shared]) shared += 1
  const rel = [...fromDir.slice(shared).map(() => '..'), ...toParts.slice(shared)].join('/')
  return rel.startsWith('.') ? rel : `./${rel}`
}

export function resolveRepoPath(fromFile: string, href: string): string | null {
  const clean = href.split('#')[0]?.split('?')[0] ?? ''
  if (!clean.endsWith('.md') || /^(https?:|mailto:|zention-page:|zention-asset:)/i.test(clean)) return null
  const stack = fromFile.split('/').slice(0, -1)
  for (const part of clean.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') stack.pop()
    else {
      try {
        stack.push(decodeURIComponent(part))
      } catch {
        stack.push(part)
      }
    }
  }
  return stack.join('/')
}

export function linksForGithub(body: string, fromPath: string, pathById: Map<string, string>): string {
  return body.replace(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (full, href: string) => {
    const id = pageIdFromHref(href)
    if (!id) return full
    const target = pathById.get(id)
    if (!target) return full
    return `](${relativeRepoPath(fromPath, target)})`
  })
}

export function linksFromGithub(body: string, fromPath: string, idByPath: Map<string, string>): string {
  return body.replace(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (full, href: string) => {
    const direct = pageIdFromHref(href)
    if (direct) return `](${pageHref(direct)})`
    const abs = resolveRepoPath(fromPath, href)
    const id = abs ? idByPath.get(abs) : undefined
    return id ? `](${pageHref(id)})` : full
  })
}

export function mentionAt(value: string, cursor: number): { start: number; query: string } | null {
  const before = value.slice(0, cursor)
  const match = before.match(/(^|[\s\n])@([^\s@\[]*)$/)
  if (!match) return null
  const query = match[2] ?? ''
  return { start: before.length - query.length - 1, query }
}

export function citationIds(text: string): string[] {
  const ids: string[] = []
  const re = /@\[[^\]]{0,120}\]\(([0-9a-f-]{36})\)/gi
  for (const match of text.matchAll(re)) {
    const id = match[1]?.toLowerCase()
    if (id && PAGE_ID_RE.test(id) && !ids.includes(id)) ids.push(id)
  }
  return ids.slice(0, 8)
}
