import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import { safeStorage } from 'electron'
import { normalizeLocale, translate, type MessageKey } from '../shared/i18n'
import { currentLocale, setCurrentLocale } from './locale'
export { currentLocale }
import { normalizeProxyUrl } from './proxy'
import { defaultDatabaseSchema, defaultDatabaseViews } from '../shared/database'
import { linksForGithub, markerFor, mergeOrganize, organizeKey, organizeOf, type PageOrganize } from '../shared/pages'
import { syncedDatabaseTable } from '../shared/database'
import {
  DEFAULT_CHAT_MODELS,
  DEFAULT_IMAGE_MODELS,
  ZENMUX_BASE_URL,
  ZENMUX_INVITE_URL,
  type GitHubRepo,
  type GitHubUser,
  type PageData,
  type PageMeta,
  type PagePatch,
  type SettingsPatch,
  type SettingsView,
  type AssetScanProgress,
} from '../shared/types'

interface DiskSettings {
  apiKeyEnc?: string
  baseUrl?: string
  chatModels?: string[]
  chatModel?: string
  imageModels?: string[]
  imageModel?: string
  proxy?: string
  locale?: string
  githubTokenEnc?: string
  githubUser?: GitHubUser | null
  githubRepo?: GitHubRepo | null
  githubSync?: GitHubSyncState | null
}

export interface GitHubSyncState {
  commit: string
  pages: Record<string, string>
  assets: Record<string, string>
}

interface IndexFile {
  pages: PageMeta[]
}

let userDataDir = ''
let workspaceDir = ''

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])

export function initPaths(userData: string): void {
  userDataDir = userData
  workspaceDir = path.join(userData, 'workspace')
}

export function workspaceRoot(): string {
  return workspaceDir
}

export function appDataRoot(): string {
  return userDataDir
}

function pagesDir(): string {
  return path.join(workspaceDir, 'pages')
}

function assetsDir(): string {
  return path.join(workspaceDir, 'assets')
}

function indexPath(): string {
  return path.join(workspaceDir, 'index.json')
}

function settingsPath(): string {
  return path.join(userDataDir, 'settings.json')
}

function pageFile(id: string): string {
  assertId(id)
  return path.join(pagesDir(), `${id}.md`)
}

export function assertId(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error(translate(currentLocale(), 'pageInvalid'))
  }
}

function seal(plain: string): string {
  if (!plain) return ''
  if (safeStorage.isEncryptionAvailable()) {
    return `enc:${safeStorage.encryptString(plain).toString('base64')}`
  }
  return `plain:${Buffer.from(plain, 'utf8').toString('base64')}`
}

function openSecret(stored?: string): string {
  if (!stored) return ''
  try {
    if (stored.startsWith('enc:')) {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
    }
    if (stored.startsWith('plain:')) {
      return Buffer.from(stored.slice(6), 'base64').toString('utf8')
    }
  } catch {
    return ''
  }
  return ''
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch {
    return null
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

function crc32(buf: Buffer): number {
  let c = ~0
  for (const byte of buf) {
    c ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
  }
  return ~c >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** Small local sample so the first page can show a file image offline. */
function samplePng(): Buffer {
  const width = 480
  const height = 160
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1)
    raw[row] = 0
    for (let x = 0; x < width; x += 1) {
      const i = row + 1 + x * 4
      const band = x < width / 3 ? [15, 123, 108] : x < (width * 2) / 3 ? [47, 111, 168] : [184, 112, 42]
      raw[i] = band[0]!
      raw[i + 1] = band[1]!
      raw[i + 2] = band[2]!
      raw[i + 3] = 255
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

const WELCOME = [
  '输入 `/` 呼出命令。选中一段文字后再按 `/`，可以让 AI 按你的指令改写，或根据这段文字在上方、下方插入配图。',
  '',
  '行内公式 $a^2+b^2=c^2$。',
  '',
  '$$',
  '\\int_{0}^{1} x^{2} \\, dx = \\frac{1}{3}',
  '$$',
  '',
  '```mermaid',
  'flowchart LR',
  '  A[选中文字] --> B[AI 改写]',
  '  A --> C[上下方插图]',
  '```',
  '',
  '本地文件：',
  '',
  '![本地图片](assets/welcome.png)',
  '',
  '网络图片：',
  '',
  '![网络图片](https://picsum.photos/seed/zention/640/240)',
].join('\n')

function normalizeModels(list: string[] | undefined, fallback: readonly string[]): string[] {
  const next = (list ?? []).map((item) => item.trim()).filter(Boolean)
  const unique = [...new Set(next)]
  return unique.length > 0 ? unique : [...fallback]
}

async function readDisk(): Promise<DiskSettings> {
  const disk = (await readJson<DiskSettings>(settingsPath())) ?? {}
  setCurrentLocale(disk.locale)
  return disk
}

async function writeDisk(disk: DiskSettings): Promise<void> {
  await writeJson(settingsPath(), disk)
}

export async function initStore(): Promise<void> {
  await fs.mkdir(pagesDir(), { recursive: true })
  await fs.mkdir(assetsDir(), { recursive: true })
  const index = await readJson<IndexFile>(indexPath())
  if (!index?.pages?.length) {
    const page = await createPageRecord('开始使用', WELCOME)
    await writeJson(indexPath(), { pages: [page] })
  }
  const sample = path.join(assetsDir(), 'welcome.png')
  try {
    await fs.access(sample)
  } catch {
    await fs.writeFile(sample, samplePng())
  }
}

export async function getSecrets(): Promise<{ apiKey: string; baseUrl: string; chatModel: string; imageModel: string; githubToken: string; proxy?: string }> {
  const disk = await readDisk()
  const chatModels = normalizeModels(disk.chatModels, DEFAULT_CHAT_MODELS)
  const imageModels = normalizeModels(disk.imageModels, DEFAULT_IMAGE_MODELS)
  return {
    apiKey: openSecret(disk.apiKeyEnc),
    baseUrl: (disk.baseUrl || ZENMUX_BASE_URL).replace(/\/+$/, ''),
    chatModel: disk.chatModel && chatModels.includes(disk.chatModel) ? disk.chatModel : chatModels[0]!,
    imageModel: disk.imageModel && imageModels.includes(disk.imageModel) ? disk.imageModel : imageModels[0]!,
    githubToken: openSecret(disk.githubTokenEnc),
    ...(disk.proxy !== undefined ? { proxy: disk.proxy } : {}),
  }
}

export async function viewSettings(): Promise<SettingsView> {
  const disk = await readDisk()
  const secrets = await getSecrets()
  const chatModels = normalizeModels(disk.chatModels, DEFAULT_CHAT_MODELS)
  const imageModels = normalizeModels(disk.imageModels, DEFAULT_IMAGE_MODELS)
  return {
    hasApiKey: Boolean(secrets.apiKey),
    baseUrl: secrets.baseUrl,
    chatModels,
    chatModel: secrets.chatModel,
    imageModels,
    imageModel: secrets.imageModel,
    proxy: disk.proxy ?? '',
    proxyConfigured: disk.proxy !== undefined,
    locale: normalizeLocale(disk.locale),
    inviteUrl: ZENMUX_INVITE_URL,
    githubUser: disk.githubUser ?? null,
    githubRepo: disk.githubRepo ?? null,
  }
}

export async function updateSettings(patch: SettingsPatch): Promise<SettingsView> {
  const disk = await readDisk()
  if (patch.clearApiKey) disk.apiKeyEnc = ''
  if (patch.apiKey?.trim()) disk.apiKeyEnc = seal(patch.apiKey.trim())
  if (patch.baseUrl !== undefined) {
    disk.baseUrl = patch.baseUrl.trim().replace(/\/+$/, '') || ZENMUX_BASE_URL
  }
  if (patch.chatModels) disk.chatModels = normalizeModels(patch.chatModels, DEFAULT_CHAT_MODELS)
  if (patch.imageModels) disk.imageModels = normalizeModels(patch.imageModels, DEFAULT_IMAGE_MODELS)
  if (patch.chatModel) disk.chatModel = patch.chatModel.trim()
  if (patch.imageModel) disk.imageModel = patch.imageModel.trim()
  if (patch.locale !== undefined) disk.locale = normalizeLocale(patch.locale)
  if (patch.proxy !== undefined) {
    try {
      disk.proxy = normalizeProxyUrl(patch.proxy)
    } catch (error) {
      const key = error instanceof Error ? error.message : ''
      if (key === 'errProxy' || key === 'errProxyScheme' || key === 'errProxyPort') {
        throw new Error(translate(normalizeLocale(disk.locale), key as MessageKey))
      }
      throw error
    }
  }
  await writeDisk(disk)
  return viewSettings()
}

export async function revealSecret(which: 'apiKey' | 'githubToken'): Promise<string> {
  const secrets = await getSecrets()
  return which === 'apiKey' ? secrets.apiKey : secrets.githubToken
}

export async function setGitHubSession(token: string, user: GitHubUser | null, repo?: GitHubRepo | null): Promise<SettingsView> {
  const disk = await readDisk()
  disk.githubTokenEnc = token ? seal(token) : ''
  disk.githubUser = user
  if (repo !== undefined) disk.githubRepo = repo
  if (!token) {
    disk.githubRepo = null
    disk.githubSync = null
  }
  await writeDisk(disk)
  return viewSettings()
}

export async function setGitHubRepo(repo: GitHubRepo | null): Promise<SettingsView> {
  const disk = await readDisk()
  disk.githubRepo = repo
  await writeDisk(disk)
  return viewSettings()
}

async function readIndex(): Promise<PageMeta[]> {
  const index = await readJson<IndexFile>(indexPath())
  return index?.pages ?? []
}

async function writeIndex(pages: PageMeta[]): Promise<void> {
  await writeJson(indexPath(), { pages })
}

async function createPageRecord(title: string, body: string, id = randomUUID()): Promise<PageMeta> {
  assertId(id)
  const now = Date.now()
  const page: PageMeta = { id, title: title.trim() || '未命名', createdAt: now, updatedAt: now }
  await fs.writeFile(pageFile(page.id), body, 'utf8')
  return page
}

export async function listPages(): Promise<PageMeta[]> {
  return readIndex()
}

export async function readPage(id: string): Promise<PageData> {
  const pages = await readIndex()
  const meta = pages.find((page) => page.id === id)
  if (!meta) throw new Error(translate(currentLocale(), 'pageMissing'))
  const body = await fs.readFile(pageFile(id), 'utf8')
  return { ...meta, body }
}

export async function savePage(id: string, body: string): Promise<void> {
  if (body.length > 5_000_000) throw new Error(translate(currentLocale(), 'pageBig'))
  const pages = await readIndex()
  const meta = pages.find((page) => page.id === id)
  if (!meta) throw new Error(translate(currentLocale(), 'pageMissing'))
  const tmp = `${pageFile(id)}.tmp`
  await fs.writeFile(tmp, body, 'utf8')
  await fs.rename(tmp, pageFile(id))
  meta.updatedAt = Date.now()
  await writeIndex(pages)
}

export async function createPage(title = '未命名', parentId?: string | null): Promise<PageData> {
  const meta = await createPageRecord(title, '')
  const pages = await readIndex()
  if (parentId) {
    const parent = pages.find((page) => page.id === parentId)
    if (parent) {
      parent.folder = true
      meta.parentId = parent.id
      if (parent.kind === 'database') {
        meta.props = { status: '待办' }
      }
    }
  }
  pages.unshift(meta)
  await writeIndex(pages)
  return { ...meta, body: '' }
}

export async function createDatabase(title = '未命名数据库'): Promise<PageData> {
  const meta = await createPageRecord(title, '')
  meta.kind = 'database'
  meta.folder = true
  meta.schema = defaultDatabaseSchema()
  meta.views = defaultDatabaseViews()
  meta.activeViewId = 'table'
  const pages = await readIndex()
  pages.unshift(meta)
  await writeIndex(pages)
  return { ...meta, body: '' }
}

export async function createDatabaseRow(databaseId: string, title = '未命名'): Promise<PageData> {
  const pages = await readIndex()
  const database = pages.find((page) => page.id === databaseId)
  if (!database || database.kind !== 'database') throw new Error(translate(currentLocale(), 'pageMissing'))
  return createPage(title, databaseId)
}

function childIds(pages: PageMeta[], id: string): Set<string> {
  const out = new Set<string>()
  const stack = pages.filter((page) => page.parentId === id).map((page) => page.id)
  while (stack.length) {
    const current = stack.pop()
    if (!current || out.has(current)) continue
    out.add(current)
    for (const page of pages) if (page.parentId === current) stack.push(page.id)
  }
  return out
}

function applyOrganize(meta: PageMeta, org: PageOrganize): void {
  if (org.parentId) meta.parentId = org.parentId
  else delete meta.parentId
  if (org.folder) meta.folder = true
  else delete meta.folder
  if (org.group) meta.group = org.group
  else delete meta.group
  if (org.tags.length) meta.tags = org.tags
  else delete meta.tags
  if (org.kind === 'database') meta.kind = 'database'
  else delete meta.kind
  if (org.schema?.length) meta.schema = org.schema
  else delete meta.schema
  if (org.views?.length) meta.views = org.views
  else delete meta.views
  if (org.activeViewId) meta.activeViewId = org.activeViewId
  else delete meta.activeViewId
  if (org.props && Object.keys(org.props).length) meta.props = org.props
  else delete meta.props
}

export async function organizePage(id: string, patch: PagePatch): Promise<PageMeta[]> {
  const pages = await readIndex()
  const meta = pages.find((page) => page.id === id)
  if (!meta) throw new Error(translate(currentLocale(), 'pageMissing'))
  const next = organizeOf(meta)
  if (patch.folder !== undefined) next.folder = patch.folder
  if (patch.group !== undefined) next.group = cleanStoredGroup(patch.group)
  if (patch.tags !== undefined) next.tags = organizeOf({ tags: patch.tags }).tags
  if (patch.kind !== undefined) next.kind = patch.kind === 'database' ? 'database' : undefined
  if (patch.schema !== undefined) next.schema = patch.schema
  if (patch.views !== undefined) next.views = patch.views
  if (patch.activeViewId !== undefined) next.activeViewId = patch.activeViewId || undefined
  if (patch.props !== undefined) next.props = patch.props
  if (next.kind === 'database') next.folder = true
  if (patch.parentId !== undefined) {
    if (!patch.parentId) next.parentId = null
    else {
      const parent = pages.find((page) => page.id === patch.parentId)
      if (!parent || parent.id === id || childIds(pages, id).has(parent.id)) throw new Error(translate(currentLocale(), 'badParent'))
      let depth = 0
      let cursor: PageMeta | undefined = parent
      const seen = new Set<string>()
      while (cursor?.parentId && !seen.has(cursor.id) && depth < 12) {
        seen.add(cursor.id)
        depth += 1
        cursor = pages.find((page) => page.id === cursor?.parentId)
      }
      if (depth >= 8) throw new Error(translate(currentLocale(), 'badParent'))
      parent.folder = true
      next.parentId = parent.id
    }
  }
  if (!next.folder && pages.some((page) => page.parentId === id)) throw new Error(translate(currentLocale(), 'folderHasChildren'))
  applyOrganize(meta, next)
  meta.updatedAt = Date.now()
  await writeIndex(pages)
  return pages
}

function cleanStoredGroup(group: string): string {
  return organizeOf({ group }).group
}

export async function renamePage(id: string, title: string): Promise<PageMeta> {
  const pages = await readIndex()
  const meta = pages.find((page) => page.id === id)
  if (!meta) throw new Error(translate(currentLocale(), 'pageMissing'))
  meta.title = title.trim().slice(0, 120) || '未命名'
  meta.updatedAt = Date.now()
  await writeIndex(pages)
  return meta
}

export async function deletePage(id: string): Promise<PageMeta[]> {
  const all = await readIndex()
  const parentId = all.find((page) => page.id === id)?.parentId ?? null
  let pages = all
    .filter((page) => page.id !== id)
    .map((page) => {
      if (page.parentId !== id) return page
      const next = { ...page }
      if (parentId && parentId !== id) next.parentId = parentId
      else delete next.parentId
      return next
    })
  await fs.rm(pageFile(id), { force: true })
  if (pages.length === 0) {
    const blank = await createPageRecord('未命名', '')
    pages = [blank]
  }
  await writeIndex(pages)
  return pages
}

export function pickSafeExt(file: string): string {
  const ext = path.extname(file).slice(1).toLowerCase()
  if (!IMAGE_EXT.has(ext)) throw new Error(translate(currentLocale(), 'imageBad'))
  return ext
}

export async function saveAsset(bytes: Buffer, ext: string): Promise<string> {
  const clean = ext.toLowerCase().replace(/^\./, '')
  if (!IMAGE_EXT.has(clean)) throw new Error(translate(currentLocale(), 'imageBad'))
  const name = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}.${clean === 'jpeg' ? 'jpg' : clean}`
  await fs.writeFile(path.join(assetsDir(), name), bytes)
  return `assets/${name}`
}

/** Collect `assets/…` filenames referenced by markdown/html in workspace notes. */
function collectAssetNames(body: string, used: Set<string>): void {
  const pattern = /(?:\(|["'=])(?:\.\/|(?:\.\.\/)*)?assets\/([^)"'\s?#]+)/gi
  for (const match of body.matchAll(pattern)) {
    let name = match[1] ?? ''
    try {
      name = decodeURIComponent(name)
    } catch {
      /* keep raw */
    }
    name = path.basename(name.replace(/\\/g, '/'))
    if (name && !name.startsWith('.')) used.add(name)
  }
}

async function runPool<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  if (!items.length) return
  let index = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index]
      index += 1
      await task(current)
    }
  })
  await Promise.all(workers)
}

export async function listUnusedAssets(
  onProgress?: (progress: AssetScanProgress) => void,
): Promise<{ unused: string[]; total: number; used: number }> {
  const pages = await readIndex()
  const used = new Set<string>()
  let lastSent = 0
  let phase: AssetScanProgress['phase'] = 'pages'
  let phaseStarted = Date.now()
  const report = (next: AssetScanProgress['phase'], done: number, total: number, force = false) => {
    if (!onProgress) return
    const now = Date.now()
    if (next !== phase) {
      phase = next
      phaseStarted = now
      lastSent = 0
    }
    if (!force && done !== total && now - lastSent < 80) return
    lastSent = now
    const seconds = Math.max((now - phaseStarted) / 1000, 0.05)
    onProgress({ phase: next, done, total, perSecond: Math.round(done / seconds) })
  }
  let done = 0
  report('pages', 0, pages.length, true)
  await runPool(pages, 32, async (page) => {
    const body = await fs.readFile(pageFile(page.id), 'utf8').catch(() => '')
    collectAssetNames(body, used)
    done += 1
    report('pages', done, pages.length)
  })
  report('pages', pages.length, pages.length, true)
  const entries = await fs.readdir(assetsDir(), { withFileTypes: true }).catch(() => [])
  const images = entries.filter((entry) => {
    if (!entry.isFile() || entry.name.startsWith('.')) return false
    return IMAGE_EXT.has(path.extname(entry.name).slice(1).toLowerCase())
  })
  const unused: string[] = []
  report('assets', 0, images.length, true)
  images.forEach((entry, index) => {
    if (!used.has(entry.name)) unused.push(entry.name)
    report('assets', index + 1, images.length)
  })
  report('assets', images.length, images.length, true)
  unused.sort((a, b) => a.localeCompare(b))
  return { unused, total: images.length, used: images.length - unused.length }
}

export async function cleanUnusedAssets(
  trash: (absolutePath: string) => Promise<void>,
  onProgress?: (progress: AssetScanProgress) => void,
): Promise<{ deleted: string[]; kept: number }> {
  const { unused, used } = await listUnusedAssets(onProgress)
  const deleted: string[] = []
  const started = Date.now()
  let lastSent = 0
  const report = (done: number, force = false) => {
    if (!onProgress) return
    const now = Date.now()
    if (!force && done !== unused.length && now - lastSent < 80) return
    lastSent = now
    const seconds = Math.max((now - started) / 1000, 0.05)
    onProgress({ phase: 'trash', done, total: unused.length, perSecond: Math.round(done / seconds) })
  }
  report(0, true)
  for (const name of unused) {
    const base = path.basename(name)
    if (base !== name || base.startsWith('.')) continue
    await trash(path.join(assetsDir(), base))
    deleted.push(base)
    report(deleted.length)
  }
  report(unused.length, true)
  return { deleted, kept: used }
}

export function resolveAssetPath(rel: string): string {
  const normalized = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '')
  const full = path.resolve(workspaceDir, normalized)
  const root = path.resolve(workspaceDir)
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error(translate(currentLocale(), 'badPath'))
  return full
}

export function pageDigest(title: string, body: string, organize?: PageOrganize | null): string {
  const key = organize ? organizeKey(organize) : ''
  const payload = key ? `${title}\n${key}\n${body}` : `${title}\n${body}`
  return createHash('sha256').update(payload).digest('hex')
}

export async function readSyncState(): Promise<GitHubSyncState | null> {
  const disk = await readDisk()
  const state = disk.githubSync
  if (!state?.commit || !state.pages || !state.assets) return null
  return state
}

export async function writeSyncState(state: GitHubSyncState): Promise<void> {
  const disk = await readDisk()
  disk.githubSync = state
  await writeDisk(disk)
}

export async function readLocalPages(): Promise<Array<{ id: string; title: string; body: string; digest: string; organize: PageOrganize }>> {
  const pages = await readIndex()
  const out = []
  for (const page of pages) {
    const body = await fs.readFile(pageFile(page.id), 'utf8').catch(() => '')
    const title = page.title.replace(/\r?\n/g, ' ').trim() || '未命名'
    const organize = organizeOf(page)
    out.push({ id: page.id, title, body, digest: pageDigest(title, body, organize), organize })
  }
  return out
}

export async function replaceWorkspace(
  pages: Array<{ id: string; title: string; body: string; organize: PageOrganize | null }>,
  assets: Array<{ name: string; bytes: Buffer }>,
): Promise<void> {
  const existing = await readIndex()
  const previous = new Map(existing.map((page) => [page.id, page]))
  const now = Date.now()
  const next: PageMeta[] = []
  for (const page of pages) {
    assertId(page.id)
    const title = page.title.replace(/\r?\n/g, ' ').trim().slice(0, 120) || '未命名'
    const prior = previous.get(page.id)
    const meta: PageMeta = {
      id: page.id,
      title,
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
    }
    applyOrganize(meta, page.organize ?? { parentId: null, folder: false, group: '', tags: [] })
    await fs.writeFile(pageFile(page.id), page.body, 'utf8')
    next.push(meta)
  }
  if (next.length === 0) {
    next.push(await createPageRecord('未命名', ''))
  }
  const keep = new Set(next.map((page) => page.id))
  for (const name of await fs.readdir(pagesDir()).catch(() => [] as string[])) {
    if (!name.endsWith('.md')) continue
    const id = name.slice(0, -3)
    if (!keep.has(id)) await fs.rm(path.join(pagesDir(), name), { force: true })
  }
  await writeIndex(next)
  const keepAssets = new Set<string>()
  for (const asset of assets) {
    await saveNamedAsset(asset.name, asset.bytes)
    keepAssets.add(asset.name)
  }
  for (const name of await fs.readdir(assetsDir()).catch(() => [] as string[])) {
    if (name.startsWith('.') || keepAssets.has(name)) continue
    await fs.rm(path.join(assetsDir(), name), { force: true })
  }
}

export async function writePageFromRemote(input: { id: string; title: string; body: string; organize?: PageOrganize | null }): Promise<'created' | 'updated'> {
  assertId(input.id)
  const title = input.title.replace(/\r?\n/g, ' ').trim().slice(0, 120) || '未命名'
  const pages = await readIndex()
  const existing = pages.find((page) => page.id === input.id)
  await fs.writeFile(pageFile(input.id), input.body, 'utf8')
  if (existing) {
    existing.title = title
    existing.updatedAt = Date.now()
    if (input.organize) applyOrganize(existing, input.organize)
    await writeIndex(pages)
    return 'updated'
  }
  const now = Date.now()
  const created: PageMeta = { id: input.id, title, createdAt: now, updatedAt: now }
  if (input.organize) applyOrganize(created, input.organize)
  pages.unshift(created)
  await writeIndex(pages)
  return 'created'
}

export async function saveNamedAsset(name: string, bytes: Buffer): Promise<void> {
  const base = path.basename(name)
  if (base !== name || base.startsWith('.') || !IMAGE_EXT.has(path.extname(base).slice(1).toLowerCase())) {
    throw new Error(translate(currentLocale(), 'imageBad'))
  }
  await fs.writeFile(path.join(assetsDir(), base), bytes)
}

function pageSlug(title: string, id: string, used: Set<string>): string {
  const cleaned = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || '未命名'
  const slug = used.has(cleaned) ? `${cleaned}-${id.slice(0, 8)}` : cleaned
  used.add(slug)
  return slug
}

function pageTitleOf(page: PageMeta): string {
  return page.title.replace(/\r?\n/g, ' ').trim() || '未命名'
}

function ancestry(pages: PageMeta[], page: PageMeta): PageMeta[] {
  const byId = new Map(pages.map((item) => [item.id, item]))
  const chain: PageMeta[] = []
  const seen = new Set<string>()
  let cursor: PageMeta | undefined = page
  while (cursor?.parentId && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    const parent = byId.get(cursor.parentId)
    if (!parent) break
    chain.unshift(parent)
    cursor = parent
  }
  return chain
}

function repoPaths(pages: PageMeta[]): Map<string, string> {
  const ids = new Set(pages.map((page) => page.id))
  const usedByParent = new Map<string, Set<string>>()
  const slugById = new Map<string, string>()
  for (const page of pages) {
    const parentKey = page.parentId && ids.has(page.parentId) ? page.parentId : ''
    const used = usedByParent.get(parentKey) ?? new Set<string>()
    usedByParent.set(parentKey, used)
    slugById.set(page.id, pageSlug(pageTitleOf(page), page.id, used))
  }
  const paths = new Map<string, string>()
  for (const page of pages) {
    const folders = ancestry(pages, page).map((parent) => slugById.get(parent.id) ?? parent.id)
    paths.set(page.id, ['pages', ...folders, `${slugById.get(page.id) ?? page.id}.md`].join('/'))
  }
  return paths
}

function catalogLines(pages: PageMeta[], paths: Map<string, string>, parentId: string | null, depth: number): string[] {
  const ids = new Set(pages.map((page) => page.id))
  const siblings = pages.filter((page) => (page.parentId && ids.has(page.parentId) ? page.parentId : null) === parentId)
  const bare = siblings.filter((page) => !page.group)
  const groups = new Map<string, PageMeta[]>()
  for (const page of siblings) {
    if (!page.group) continue
    const list = groups.get(page.group) ?? []
    list.push(page)
    groups.set(page.group, list)
  }
  const lines: string[] = []
  const emit = (page: PageMeta, level: number) => {
    const title = pageTitleOf(page)
    const tags = (page.tags ?? []).map((tag) => `#${tag}`).join(' ')
    const href = paths.get(page.id) ?? ''
    lines.push(`${'  '.repeat(level)}- [${title}](${href})${page.kind === 'database' ? ' · 数据库' : ''}${tags ? ` ${tags}` : ''}`)
    lines.push(...catalogLines(pages, paths, page.id, level + 1))
  }
  for (const page of bare) emit(page, depth)
  for (const [name, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh'))) {
    lines.push(`${'  '.repeat(depth)}- ${name}`)
    for (const page of list) emit(page, depth + 1)
  }
  return lines
}

export async function listSyncFiles(): Promise<Array<{ path: string; bytes: Buffer; label: string }>> {
  const pages = await readIndex()
  const files: Array<{ path: string; bytes: Buffer; label: string }> = []
  const paths = repoPaths(pages)
  const catalog = ['# 目录', '', `共 ${pages.length} 个页面。`, '', ...catalogLines(pages, paths, null, 0), '']
  for (const page of pages) {
    const body = await fs.readFile(pageFile(page.id), 'utf8').catch(() => '')
    const title = pageTitleOf(page)
    const rel = paths.get(page.id) ?? `pages/${page.id}.md`
    const assetRoot = `${'../'.repeat(Math.max(rel.split('/').length - 1, 1))}assets/`
    const syncedBody = linksForGithub(
      body
        .replace(/^\uFEFF/, '')
        .replace(/^\n+/, '')
        .replace(/\]\((?:\.\/|(?:\.\.\/)+)?assets\//g, `](${assetRoot}`),
      rel,
      paths,
    )
    const grid =
      page.kind === 'database'
        ? syncedDatabaseTable(
            page.schema ?? [],
            pages
              .filter((row) => row.parentId === page.id)
              .map((row) => ({ id: row.id, title: pageTitleOf(row), props: row.props })),
          )
        : ''
    const content = `${markerFor(page.id, page)}\n# ${title}\n\n${grid}${syncedBody}`
    files.push({ path: rel, bytes: Buffer.from(content, 'utf8'), label: `页面「${title}」` })
  }
  files.unshift({ path: '目录.md', bytes: Buffer.from(`${catalog.join('\n')}\n`, 'utf8'), label: '目录' })
  const names = await fs.readdir(assetsDir()).catch(() => [] as string[])
  for (const name of names) {
    if (name.startsWith('.')) continue
    const abs = path.join(assetsDir(), name)
    const stat = await fs.stat(abs)
    if (!stat.isFile()) continue
    files.push({ path: `assets/${name}`, bytes: await fs.readFile(abs), label: `图片 ${name}` })
  }
  return files
}
