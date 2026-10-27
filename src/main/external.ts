import { dialog, BrowserWindow } from 'electron'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { translate } from '../shared/i18n'
import type { PageData } from '../shared/types'
import { createPage, currentLocale, readPage, saveAsset, savePage } from './store'

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico'])
const MAX_BYTES = 5_000_000

let externalRoot = ''

function fail(key: 'notMarkdown' | 'pageBig' | 'pageMissing' | 'imageBad' | 'badPath' | 'errImageBig'): Error {
  return new Error(translate(currentLocale(), key))
}

function assertMarkdown(filePath: string): string {
  const abs = path.resolve(filePath)
  const ext = path.extname(abs).toLowerCase()
  if (ext !== '.md' && ext !== '.markdown') throw fail('notMarkdown')
  return abs
}

function insideRoot(abs: string, root: string): boolean {
  const base = path.resolve(root)
  const full = path.resolve(abs)
  return full === base || full.startsWith(base + path.sep)
}

function fromFileUrl(src: string): string {
  let rest = src.replace(/^file:\/\//i, '').replace(/[?#].*$/, '')
  if (rest.toLowerCase().startsWith('localhost')) rest = rest.slice('localhost'.length)
  if (!rest.startsWith('/') && !/^[A-Za-z]:/.test(rest)) rest = `/${rest}`
  try {
    rest = decodeURIComponent(rest)
  } catch {
    // Keep the original path when the percent encoding is incomplete.
  }
  if (/^\/[A-Za-z]:[\\/]/.test(rest)) rest = rest.slice(1)
  return rest
}

/** Markdown image destinations become a filesystem path beside the open file. */
export function localImagePath(raw: string): string {
  let src = raw.trim().replace(/^<|>$/g, '')
  if (!src || /^(https?:|data:|blob:|zention-asset:)/i.test(src)) throw fail('badPath')
  if (/^file:/i.test(src)) src = fromFileUrl(src)
  else if (src.startsWith('~/') || src === '~') src = path.join(os.homedir(), src.slice(src.startsWith('~/') ? 2 : 1))
  else if (src.includes('%')) {
    try {
      src = decodeURIComponent(src)
    } catch {
      // Keep the original path when the percent encoding is incomplete.
    }
  }
  if (process.platform !== 'win32') src = src.replace(/\\/g, '/')
  if (src.includes('\0')) throw fail('badPath')
  if (path.isAbsolute(src)) return path.resolve(src)
  if (!externalRoot) throw fail('badPath')
  return path.resolve(externalRoot, src)
}

export function resolveExternalImage(raw: string): string {
  const abs = localImagePath(raw)
  const ext = path.extname(abs).slice(1).toLowerCase()
  if (!IMAGE_EXT.has(ext)) throw fail('imageBad')
  return abs
}

export function decodeExternalToken(token: string): string {
  const padded = token.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64').toString('utf8')
}

export async function readExternalMarkdown(filePath: string): Promise<{ path: string; name: string; body: string }> {
  const abs = assertMarkdown(filePath)
  const stat = await fs.stat(abs)
  if (!stat.isFile()) throw fail('pageMissing')
  if (stat.size > MAX_BYTES) throw fail('pageBig')
  const body = (await fs.readFile(abs, 'utf8')).replace(/^\uFEFF/, '')
  externalRoot = path.dirname(abs)
  return { path: abs, name: path.basename(abs), body }
}

export async function writeExternalMarkdown(filePath: string, body: string): Promise<{ path: string; name: string }> {
  const abs = assertMarkdown(filePath)
  if (Buffer.byteLength(body) > MAX_BYTES) throw fail('pageBig')
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, body, 'utf8')
  externalRoot = path.dirname(abs)
  return { path: abs, name: path.basename(abs) }
}

async function copyRelativeImages(body: string, fromDir: string, toDir: string): Promise<void> {
  if (path.resolve(fromDir) === path.resolve(toDir)) return
  const re = /!\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)/g
  for (const match of body.matchAll(re)) {
    let from = ''
    try {
      from = localImagePath((match[1] ?? '').trim())
    } catch {
      continue
    }
    if (!insideRoot(from, fromDir)) continue
    const rel = path.relative(fromDir, from)
    if (!rel || rel.startsWith('..')) continue
    const ext = path.extname(from).slice(1).toLowerCase()
    if (!IMAGE_EXT.has(ext)) continue
    const to = path.join(toDir, rel)
    await fs.mkdir(path.dirname(to), { recursive: true })
    await fs.copyFile(from, to).catch(() => undefined)
  }
}

export async function saveExternalAs(
  parent: BrowserWindow | null,
  body: string,
  suggestedName: string,
): Promise<{ path: string; name: string } | null> {
  const fromDir = externalRoot
  const options = {
    defaultPath: suggestedName.endsWith('.md') ? suggestedName : `${suggestedName}.md`,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  }
  const picked = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
  if (picked.canceled || !picked.filePath) return null
  const target = picked.filePath.endsWith('.md') || picked.filePath.endsWith('.markdown') ? picked.filePath : `${picked.filePath}.md`
  await copyRelativeImages(body, fromDir, path.dirname(target))
  return writeExternalMarkdown(target, body)
}

const STORED_IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])

/** Copy a dropped Markdown file into the notes, including local pictures, so it stays and syncs. */
export async function importMarkdownPage(filePath: string): Promise<PageData> {
  const read = await readExternalMarkdown(filePath)
  const body = await rewriteLocalImages(read.body, path.dirname(read.path))
  const title = read.name.replace(/\.(md|markdown)$/i, '').replace(/[\r\n]/g, ' ').trim().slice(0, 120) || '未命名'
  const created = await createPage(title)
  await savePage(created.id, body)
  return readPage(created.id)
}

async function adoptImage(raw: string, root: string, copied: Map<string, string>): Promise<string | null> {
  const previous = externalRoot
  externalRoot = root
  let abs = ''
  try {
    abs = localImagePath(raw)
  } catch {
    return null
  } finally {
    externalRoot = previous
  }
  const ext = path.extname(abs).slice(1).toLowerCase()
  if (!STORED_IMAGE_EXT.has(ext)) return null
  const stat = await fs.stat(abs).catch(() => null)
  if (!stat?.isFile() || stat.size > 12_000_000) return null
  const known = copied.get(abs)
  if (known) return known
  try {
    const stored = await saveAsset(await fs.readFile(abs), ext)
    copied.set(abs, stored)
    return stored
  } catch {
    return null
  }
}

async function rewriteChunk(chunk: string, root: string, copied: Map<string, string>): Promise<string> {
  type Hit = { start: number; end: number; raw: string; alt: string; whole: boolean }
  const hits: Hit[] = []
  const md = /!\[([^\]]*)\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g
  for (const match of chunk.matchAll(md)) {
    hits.push({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      raw: (match[2] ?? '').trim().replace(/^<|>$/g, ''),
      alt: match[1] ?? '',
      whole: true,
    })
  }
  const html = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/gi
  for (const match of chunk.matchAll(html)) {
    const raw = match[1] ?? match[2] ?? ''
    const at = (match.index ?? 0) + match[0].lastIndexOf(raw)
    hits.push({ start: at, end: at + raw.length, raw, alt: '', whole: false })
  }
  hits.sort((a, b) => b.start - a.start)
  let out = chunk
  let cursor = Number.POSITIVE_INFINITY
  for (const hit of hits) {
    if (hit.end > cursor) continue
    cursor = hit.start
    const stored = await adoptImage(hit.raw, root, copied)
    if (!stored) continue
    const next = hit.whole ? `![${hit.alt}](${stored})` : stored
    out = `${out.slice(0, hit.start)}${next}${out.slice(hit.end)}`
  }
  return out
}

async function rewriteLocalImages(body: string, root: string): Promise<string> {
  const lines = body.split('\n')
  let fence: '`' | '~' | null = null
  const chunks: Array<{ code: boolean; lines: string[] }> = []
  let current: { code: boolean; lines: string[] } | null = null
  const pushLine = (line: string, code: boolean) => {
    if (!current || current.code !== code) {
      current = { code, lines: [] }
      chunks.push(current)
    }
    current.lines.push(line)
  }
  for (const line of lines) {
    const open = /^(```+|~~~+)/.exec(line)
    if (!fence && open) {
      fence = open[1].startsWith('`') ? '`' : '~'
      pushLine(line, true)
      continue
    }
    if (fence) {
      pushLine(line, true)
      if ((fence === '`' ? /^```+\s*$/ : /^~~~+\s*$/).test(line)) fence = null
      continue
    }
    pushLine(line, false)
  }
  const copied = new Map<string, string>()
  const rendered: string[] = []
  for (const chunk of chunks) {
    const text = chunk.lines.join('\n')
    rendered.push(chunk.code ? text : await rewriteChunk(text, root, copied))
  }
  return rendered.join('\n')
}

export async function saveExternalImage(bytes: Buffer, ext: string): Promise<string> {
  if (!externalRoot) throw fail('badPath')
  const clean = ext.toLowerCase().replace(/^\./, '')
  const normalized = clean === 'jpeg' ? 'jpg' : clean
  if (!IMAGE_EXT.has(clean)) throw fail('imageBad')
  if (bytes.length > 12_000_000) throw fail('errImageBig')
  const dir = path.join(externalRoot, 'assets')
  await fs.mkdir(dir, { recursive: true })
  const name = `${Date.now().toString(36)}-${createHash('sha256').update(bytes).digest('hex').slice(0, 8)}.${normalized}`
  await fs.writeFile(path.join(dir, name), bytes)
  return `assets/${name}`
}
