import {
  cleanDbViews,
  cleanPropDefs,
  type DbView,
  type PropDef,
} from './database'

export interface PageOrganize {
  parentId: string | null
  folder: boolean
  group: string
  tags: string[]
  kind?: 'page' | 'database'
  schema?: PropDef[]
  views?: DbView[]
  activeViewId?: string
  props?: Record<string, unknown>
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

function cleanLooseProps(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = key.trim().slice(0, 40)
    if (!id) continue
    if (typeof value === 'boolean' || typeof value === 'number') out[id] = value
    else if (Array.isArray(value)) {
      const list = value.map((item) => String(item).trim().slice(0, 40)).filter(Boolean).slice(0, 12)
      if (list.length) out[id] = list
    } else if (value != null && String(value).trim()) {
      out[id] = String(value).slice(0, 500)
    }
  }
  return Object.keys(out).length ? out : undefined
}

export function organizeOf(
  page:
    | {
        parentId?: string | null
        folder?: boolean
        group?: string
        tags?: string[]
        kind?: string
        schema?: unknown
        views?: unknown
        activeViewId?: string
        props?: unknown
      }
    | null
    | undefined,
): PageOrganize {
  const parent = page?.parentId?.trim().toLowerCase() ?? ''
  const kind = page?.kind === 'database' ? 'database' : undefined
  const schema = cleanPropDefs(page?.schema)
  const views = cleanDbViews(page?.views)
  const org: PageOrganize = {
    parentId: PAGE_ID_RE.test(parent) ? parent : null,
    folder: page?.folder === true || kind === 'database',
    group: cleanGroup(page?.group),
    tags: cleanTags(page?.tags),
  }
  if (kind) {
    org.kind = kind
    if (schema.length) org.schema = schema
    if (views.length) org.views = views
    const active = String(page?.activeViewId ?? '').trim().slice(0, 40)
    if (active) org.activeViewId = active
  }
  const props = cleanLooseProps(page?.props)
  if (props) org.props = props
  return org
}

export function organizeKey(org: PageOrganize): string {
  const payload: Record<string, unknown> = {}
  if (org.parentId) payload.parentId = org.parentId
  if (org.folder) payload.folder = true
  if (org.group) payload.group = org.group
  if (org.tags.length) payload.tags = org.tags
  if (org.kind === 'database') payload.kind = 'database'
  if (org.schema?.length) payload.schema = org.schema
  if (org.views?.length) payload.views = org.views
  if (org.activeViewId) payload.activeViewId = org.activeViewId
  if (org.props && Object.keys(org.props).length) payload.props = org.props
  if (Object.keys(payload).length === 0) return ''
  return JSON.stringify(payload)
}

export function markerFor(
  id: string,
  page: {
    parentId?: string | null
    folder?: boolean
    group?: string
    tags?: string[]
    kind?: string
    schema?: PropDef[]
    views?: DbView[]
    activeViewId?: string
    props?: Record<string, unknown>
  },
): string {
  const key = organizeKey(organizeOf(page))
  return key ? `<!-- zention:${id} ${key} -->` : `<!-- zention:${id} -->`
}

/** Parse leading `<!-- zention:uuid {...} -->`, supporting nested JSON in the payload. */
export function parsePageMarker(raw: string): {
  id: string | null
  organize: PageOrganize | null
  rest: string
} {
  const text = raw.replace(/^\uFEFF/, '')
  const prefix = text.match(/^<!--\s*zention:([0-9a-f-]{36})/i)
  if (!prefix || prefix.index !== 0) return { id: null, organize: null, rest: text }
  const id = prefix[1]!.toLowerCase()
  let cursor = prefix[0].length
  while (text[cursor] === ' ' || text[cursor] === '\t') cursor += 1
  let organize: PageOrganize | null = null
    if (text[cursor] === '{') {
    const end = jsonObjectEnd(text, cursor)
    if (end < 0) return { id: null, organize: null, rest: text }
    try {
      organize = organizeOf(JSON.parse(text.slice(cursor, end + 1)) as PageOrganize)
    } catch {
      organize = null
    }
    cursor = end + 1
  }
  while (text[cursor] === ' ' || text[cursor] === '\t') cursor += 1
  if (text.slice(cursor, cursor + 3) !== '-->') return { id: null, organize: null, rest: text }
  cursor += 3
  return { id, organize, rest: text.slice(cursor).replace(/^\s+/, '') }
}

function jsonObjectEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

export function mergeOrganize(local: PageOrganize, remote: PageOrganize): PageOrganize {
  const schema = mergePropDefs(local.schema, remote.schema)
  const views = local.views?.length ? local.views : remote.views
  const tags = [...local.tags]
  for (const tag of remote.tags) if (!tags.includes(tag)) tags.push(tag)
  return organizeOf({
    parentId: local.parentId ?? remote.parentId,
    folder: local.folder || remote.folder,
    group: local.group || remote.group,
    tags,
    kind: local.kind === 'database' || remote.kind === 'database' ? 'database' : undefined,
    schema,
    views,
    activeViewId: local.activeViewId || remote.activeViewId,
    props: { ...(remote.props ?? {}), ...(local.props ?? {}) },
  })
}

function mergePropDefs(local?: PropDef[], remote?: PropDef[]): PropDef[] | undefined {
  const map = new Map<string, PropDef>()
  for (const def of remote ?? []) map.set(def.id, { ...def })
  for (const def of local ?? []) {
    const prev = map.get(def.id)
    if (!prev) {
      map.set(def.id, { ...def })
      continue
    }
    const options = [...(prev.options ?? []), ...(def.options ?? [])].filter((item, index, all) => all.indexOf(item) === index).slice(0, 24)
    const next: PropDef = { ...prev, ...def }
    if (next.type === 'select' || next.type === 'multiSelect') next.options = options
    else delete next.options
    map.set(def.id, next)
  }
  const list = cleanPropDefs([...map.values()])
  return list.length ? list : undefined
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
