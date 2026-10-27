import { app, dialog, BrowserWindow, shell } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { proxyRouteFor } from './proxy'
import { getSecrets, resolveAssetPath } from './store'

const IMAGE_RE = /!\[([^\]]*)\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+("[^"]*"|'[^']*'))?\s*\)/g
const MAX_IMAGE_BYTES = 12_000_000

function safeFileName(title: string, ext: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'untitled'
  return `${cleaned}.${ext}`
}

function withTitle(title: string, body: string): string {
  const heading = `# ${title.trim() || 'Untitled'}`
  const trimmed = body.replace(/^\uFEFF/, '').replace(/^\n+/, '').replace(/\s+$/, '')
  if (trimmed === heading || trimmed.startsWith(`${heading}\n`)) return `${trimmed}\n`
  return `${heading}\n\n${trimmed}\n`
}

function splitFenced(markdown: string): Array<{ code: boolean; text: string }> {
  const parts: Array<{ code: boolean; text: string }> = []
  const re = /```[\s\S]*?```/g
  let last = 0
  for (const match of markdown.matchAll(re)) {
    const index = match.index ?? 0
    if (index > last) parts.push({ code: false, text: markdown.slice(last, index) })
    parts.push({ code: true, text: match[0] })
    last = index + match[0].length
  }
  parts.push({ code: false, text: markdown.slice(last) })
  return parts
}

function localAssetRel(src: string): string | null {
  let value = src.trim()
  const marker = 'zention-asset://local/'
  if (value.startsWith(marker)) value = decodeURIComponent(value.slice(marker.length))
  value = value.replace(/\\/g, '/').replace(/^\.\//, '').split('?')[0]?.split('#')[0] ?? value
  const nested = value.match(/(?:^|\/)(assets\/[^/]+)$/)
  if (nested?.[1]) return nested[1]
  return null
}

function extFrom(src: string, contentType = ''): string {
  const fromPath = path.extname(src.split('?')[0] ?? '').slice(1).toLowerCase()
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(fromPath)) return fromPath === 'jpeg' ? 'jpg' : fromPath
  if (contentType.includes('png')) return 'png'
  if (contentType.includes('jpeg')) return 'jpg'
  if (contentType.includes('gif')) return 'gif'
  if (contentType.includes('webp')) return 'webp'
  if (contentType.includes('svg')) return 'svg'
  return 'png'
}

function mimeFor(ext: string): string {
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'svg') return 'image/svg+xml'
  return 'image/png'
}

async function download(url: string, redirects = 0): Promise<{ bytes: Buffer; type: string }> {
  if (redirects > 5) throw new Error(url)
  const target = new URL(url)
  const secrets = await getSecrets()
  const route = await proxyRouteFor(target.toString(), secrets.proxy)
  const transport = target.protocol === 'http:' ? http.request : https.request
  return new Promise((resolve, reject) => {
    const req = transport(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: { 'User-Agent': 'Zention', Accept: 'image/*,*/*' },
        ...(route.agent ? { agent: route.agent } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume()
          const next = new URL(res.headers.location, target).toString()
          download(next, redirects + 1).then(resolve, reject)
          return
        }
        const chunks: Buffer[] = []
        let received = 0
        res.on('data', (chunk: Buffer) => {
          received += chunk.length
          if (received > MAX_IMAGE_BYTES) {
            req.destroy()
            reject(new Error(url))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          if (status < 200 || status >= 300) {
            reject(new Error(url))
            return
          }
          const type = Array.isArray(res.headers['content-type']) ? res.headers['content-type'][0] : res.headers['content-type']
          resolve({ bytes: Buffer.concat(chunks), type: type ?? '' })
        })
        res.on('error', reject)
      },
    )
    req.setTimeout(20_000, () => {
      req.destroy()
      reject(new Error(url))
    })
    req.on('error', reject)
    req.end()
  })
}

async function materializeImage(src: string, assetsDir: string, used: Map<string, string>): Promise<string | null> {
  const cached = used.get(src)
  if (cached) return cached
  const bare = src.trim().replace(/^<|>$/g, '')
  let bytes: Buffer | null = null
  let ext = extFrom(bare)
  const rel = localAssetRel(bare)
  if (rel) {
    const abs = resolveAssetPath(rel)
    bytes = await fs.readFile(abs)
    ext = extFrom(abs)
  } else if (/^https?:\/\//i.test(bare)) {
    const fetched = await download(bare)
    bytes = fetched.bytes
    ext = extFrom(bare, fetched.type)
  } else if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(bare)) {
    const header = /^data:image\/([a-z0-9.+-]+);base64,/i.exec(bare)
    ext = extFrom('', header?.[1] ?? '')
    bytes = Buffer.from(bare.slice(header?.[0].length ?? 0), 'base64')
  }
  if (!bytes || bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null
  await fs.mkdir(assetsDir, { recursive: true })
  const stem = rel ? path.basename(rel, path.extname(rel)) : createHash('sha256').update(bare).digest('hex').slice(0, 12)
  let name = `${stem}.${ext}`
  let n = 2
  while (true) {
    try {
      await fs.access(path.join(assetsDir, name))
      const existing = await fs.readFile(path.join(assetsDir, name))
      if (existing.equals(bytes)) break
      name = `${stem}-${n}.${ext}`
      n += 1
    } catch {
      break
    }
  }
  await fs.writeFile(path.join(assetsDir, name), bytes)
  const next = `assets/${name}`
  used.set(src, next)
  return next
}

export async function writeMarkdownBundle(targetFile: string, title: string, markdown: string): Promise<number> {
  const assetsDir = path.join(path.dirname(targetFile), 'assets')
  const used = new Map<string, string>()
  const parts = splitFenced(withTitle(title, markdown))
  let images = 0
  const rewritten = []
  for (const part of parts) {
    if (part.code) {
      rewritten.push(part.text)
      continue
    }
    let cursor = 0
    let next = ''
    for (const match of part.text.matchAll(IMAGE_RE)) {
      const index = match.index ?? 0
      next += part.text.slice(cursor, index)
      cursor = index + match[0].length
      const alt = match[1] ?? ''
      const src = match[2] ?? ''
      const titleAttr = match[3] ? ` ${match[3]}` : ''
      try {
        const localized = await materializeImage(src, assetsDir, used)
        if (localized) {
          if (!used.has(`counted:${localized}`)) {
            images += 1
            used.set(`counted:${localized}`, localized)
          }
          next += `![${alt}](${localized}${titleAttr})`
          continue
        }
      } catch {
        // Keep the original link when a picture cannot be copied.
      }
      next += match[0]
    }
    next += part.text.slice(cursor)
    rewritten.push(next)
  }
  await fs.mkdir(path.dirname(targetFile), { recursive: true })
  await fs.writeFile(targetFile, rewritten.join(''), 'utf8')
  return images
}

function katexCss(): string {
  const candidates = [
    path.join(process.resourcesPath, 'app.asar.unpacked/node_modules/katex/dist'),
    path.join(app.getAppPath(), 'node_modules/katex/dist'),
    path.join(process.cwd(), 'node_modules/katex/dist'),
  ]
  const dist = candidates.find((dir) => existsSync(path.join(dir, 'katex.min.css')))
  if (!dist) return ''
  const css = readFileSync(path.join(dist, 'katex.min.css'), 'utf8')
  return css.replace(/url\((['"]?)fonts\/([^'")]+)\1\)/g, (_match, _quote: string, file: string) => {
    return `url(${pathToFileURL(path.join(dist, 'fonts', file)).href})`
  })
}

async function dataUrlFor(src: string): Promise<string | null> {
  const bare = src.trim()
  if (bare.startsWith('data:')) return bare
  const rel = localAssetRel(bare)
  let bytes: Buffer | null = null
  let ext = extFrom(bare)
  if (rel) {
    bytes = await fs.readFile(resolveAssetPath(rel))
    ext = extFrom(rel)
  } else if (/^https?:\/\//i.test(bare)) {
    const fetched = await download(bare)
    bytes = fetched.bytes
    ext = extFrom(bare, fetched.type)
  }
  if (!bytes || bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null
  return `data:${mimeFor(ext)};base64,${bytes.toString('base64')}`
}

async function embedHtmlImages(html: string): Promise<string> {
  const matches = [...html.matchAll(/<img\b[^>]*\bsrc="([^"]*)"/gi)]
  let next = html
  for (const match of matches) {
    const src = match[1] ?? ''
    if (!src || src.startsWith('data:')) continue
    try {
      const data = await dataUrlFor(src.replace(/&amp;/g, '&'))
      if (!data) continue
      next = next.replaceAll(`src="${src}"`, `src="${data}"`)
    } catch {
      // Leave the original address when the picture cannot be embedded.
    }
  }
  return next
}

function printDocument(title: string, html: string): string {
  const safeTitle = title.replace(/[<&]/g, (char) => (char === '<' ? '&lt;' : '&amp;'))
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${safeTitle}</title>
<style>
${katexCss()}
body { margin: 0; color: #2c2a26; font: 16px/1.6 "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Segoe UI", sans-serif; }
article { max-width: 720px; margin: 0 auto; }
h1 { font-size: 32px; line-height: 1.2; margin: 0 0 24px; }
img { max-width: 100%; height: auto; }
pre { background: #f6f4ef; padding: 12px 14px; border-radius: 8px; white-space: pre-wrap; }
code { font-family: "SF Mono", ui-monospace, monospace; font-size: 0.92em; }
table { border-collapse: collapse; width: 100%; }
td, th { border: 1px solid #e4e0d8; padding: 6px 8px; vertical-align: top; }
blockquote { margin: 0.8em 0; padding-left: 12px; border-left: 3px solid #0f7b6c; color: #444; }
.katex-display { margin: 0.8em 0; overflow: visible; }
img, .katex-display, pre, table { break-inside: avoid; }
</style>
</head>
<body><article><h1>${safeTitle}</h1>${html}</article></body>
</html>`
}

export async function writePdf(targetFile: string, title: string, html: string): Promise<void> {
  const document = printDocument(title, await embedHtmlImages(html))
  const temp = path.join(os.tmpdir(), `zention-pdf-${Date.now()}.html`)
  await fs.writeFile(temp, document, 'utf8')
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: { sandbox: false, webSecurity: false, contextIsolation: true },
  })
  try {
    await win.loadFile(temp)
    await win.webContents.executeJavaScript(
      `Promise.all([...(document.fonts ? [document.fonts.ready] : []), ...[...document.images].map((img) => img.complete ? null : new Promise((resolve) => { img.onload = img.onerror = () => resolve(null) }))].filter(Boolean))`,
      true,
    )
    const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { marginType: 'default' } })
    await fs.mkdir(path.dirname(targetFile), { recursive: true })
    await fs.writeFile(targetFile, pdf)
  } finally {
    if (!win.isDestroyed()) win.close()
    await fs.rm(temp, { force: true })
  }
}

export async function exportMarkdown(parent: BrowserWindow | null, title: string, markdown: string): Promise<{ file: string; images: number } | null> {
  const options = {
    defaultPath: safeFileName(title, 'md'),
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  }
  const picked = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
  if (picked.canceled || !picked.filePath) return null
  const images = await writeMarkdownBundle(picked.filePath, title, markdown)
  shell.showItemInFolder(picked.filePath)
  return { file: picked.filePath, images }
}

export async function exportPdf(parent: BrowserWindow | null, title: string, html: string): Promise<{ file: string } | null> {
  const options = {
    defaultPath: safeFileName(title, 'pdf'),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  }
  const picked = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
  if (picked.canceled || !picked.filePath) return null
  await writePdf(picked.filePath, title, html)
  shell.showItemInFolder(picked.filePath)
  return { file: picked.filePath }
}

