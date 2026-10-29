import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  deletePage,
  pageDigest,
  readLocalPages,
  readSyncState,
  replaceWorkspace,
  saveNamedAsset,
  workspaceRoot,
  writePageFromRemote,
  writeSyncState,
  getSecrets,
  listSyncFiles,
  setGitHubRepo,
  setGitHubSession,
  viewSettings,
} from './store'
import { linksFromGithub, mergeOrganize, organizeKey, organizeOf, parsePageMarker, type PageOrganize } from '../shared/pages'
import { stripSyncedDatabaseTable } from '../shared/database'
import { mergeText } from './merge'
import { zenmuxFetch } from './ai'
import { translate, type MessageKey } from '../shared/i18n'
import { ensureGh } from './ghEnv'
import { currentLocale } from './store'
import type { GitHubRepo, GitHubUser, SettingsView, SyncDirection, SyncProgress } from '../shared/types'

export type SyncReporter = (progress: SyncProgress) => void

function report(onProgress: SyncReporter | undefined, percent: number, text: string): void {
  onProgress?.({ percent: Math.max(0, Math.min(100, Math.round(percent))), text })
}

function say(
  onProgress: SyncReporter | undefined,
  percent: number,
  key: MessageKey,
  vars?: Record<string, string | number>,
): void {
  report(onProgress, percent, translate(currentLocale(), key, vars))
}

interface GhResponse {
  ok: true
  data: any
}

async function gh(token: string, pathname: string, init: RequestInit = {}): Promise<any> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await zenmuxFetch(
      `https://api.github.com${pathname}`,
      {
        ...init,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'Zention',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
      },
      undefined,
      undefined,
      { transport: 'node', timeoutMs: 60_000, family: 4 },
    )
    const text = await response.text()
    let data: any = null
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        data = { message: text.slice(0, 300) }
      }
    }
    if (response.ok) return (data ?? {}) as GhResponse['data']
    const retry = [408, 429, 500, 502, 503, 504].includes(response.status) && attempt < 2
    if (!retry) throw new Error(translate(currentLocale(), 'ghHttp', { status: response.status, detail: data?.message || '' }))
    await sleep(1000 * 2 ** attempt)
  }
  throw new Error(translate(currentLocale(), 'netFailBare'))
}

function userFrom(data: any): GitHubUser {
  return {
    login: String(data.login ?? ''),
    name: String(data.name || data.login || ''),
    avatarUrl: String(data.avatar_url ?? ''),
  }
}

export async function loginWithToken(token: string): Promise<SettingsView> {
  const clean = token.trim()
  if (!clean) throw new Error(translate(currentLocale(), 'ghNeedToken'))
  const user = userFrom(await gh(clean, '/user'))
  return setGitHubSession(clean, user)
}

export async function loginWithGhCli(): Promise<SettingsView> {
  const env = await ensureGh()
  const token = await new Promise<string>((resolve, reject) => {
    execFile(env.path, ['auth', 'token'], { timeout: 15_000 }, (error, stdout, stderr) => {
      if (error || !stdout.trim()) reject(new Error(stderr.trim() || translate(currentLocale(), 'ghEnvNeedAuth')))
      else resolve(stdout.trim())
    })
  })
  return loginWithToken(token)
}

export async function logoutGitHub(): Promise<SettingsView> {
  return setGitHubSession('', null, null)
}

function repoName(input: string): string {
  const name = input.trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9._-]/g, '')
  if (!name) throw new Error(translate(currentLocale(), 'ghNeedName'))
  return name.slice(0, 100)
}

export async function createPrivateRepo(name: string): Promise<{ settings: SettingsView; url: string }> {
  const secrets = await getSecrets()
  if (!secrets.githubToken) throw new Error(translate(currentLocale(), 'ghNeedLogin'))
  const repoNameClean = repoName(name)
  const created = await gh(secrets.githubToken, '/user/repos', {
    method: 'POST',
    body: JSON.stringify({
      name: repoNameClean,
      private: true,
      auto_init: true,
      description: 'Zention notes',
    }),
  })
  const repo: GitHubRepo = {
    owner: created.owner.login,
    name: created.name,
    branch: created.default_branch || 'main',
  }
  const settings = await setGitHubRepo(repo)
  return { settings, url: created.html_url as string }
}

export async function linkRepo(fullName: string): Promise<{ settings: SettingsView; url: string }> {
  const secrets = await getSecrets()
  if (!secrets.githubToken) throw new Error(translate(currentLocale(), 'ghNeedLogin'))
  const [owner, name] = fullName.trim().split('/')
  if (!owner || !name) throw new Error(translate(currentLocale(), 'ghNeedFullName'))
  const data = await gh(secrets.githubToken, `/repos/${owner}/${name}`)
  const repo: GitHubRepo = { owner: data.owner.login, name: data.name, branch: data.default_branch || 'main' }
  const settings = await setGitHubRepo(repo)
  return { settings, url: data.html_url as string }
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let cursor = 0
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      out[index] = await fn(items[index]!, index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return out
}

function missingRef(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /GitHub (404|409)/.test(message)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseRemotePage(raw: string): { id: string | null; title: string; body: string; organize: PageOrganize | null } {
  const parsed = parsePageMarker(raw)
  const text = parsed.rest
  const heading = text.match(/^#\s+(.+)\r?\n+/)
  const title = heading?.[1]?.trim() || '未命名'
  const body = stripSyncedDatabaseTable(heading ? text.slice(heading[0].length) : text).replace(
    /\]\((?:\.\/|(?:\.\.\/)+)?assets\//g,
    '](assets/',
  )
  return { id: parsed.id, title, body, organize: parsed.organize }
}

async function blobBytes(token: string, owner: string, repo: string, sha: string): Promise<Buffer> {
  const data = await gh(token, `/repos/${owner}/${repo}/git/blobs/${sha}`)
  const content = String(data.content ?? '').replace(/\n/g, '')
  return Buffer.from(content, 'base64')
}

function canonicalTitle(title: string): string {
  return title.replace(/\s*（远程）\s*$/u, '').trim() || title.trim()
}

function isRemoteCopyTitle(title: string): boolean {
  return canonicalTitle(title) !== title.trim()
}

export async function foldRemoteCopies(): Promise<number> {
  const local = await readLocalPages()
  const hosts = new Map<string, (typeof local)[number]>()
  for (const page of local) {
    if (!isRemoteCopyTitle(page.title) && !hosts.has(canonicalTitle(page.title))) hosts.set(canonicalTitle(page.title), page)
  }
  let mergedCount = 0
  for (const copy of local) {
    if (!isRemoteCopyTitle(copy.title)) continue
    const base = canonicalTitle(copy.title)
    const host = hosts.get(base)
    if (!host || host.id === copy.id) {
      if (!host) {
        await writePageFromRemote({ id: copy.id, title: base, body: copy.body })
        hosts.set(base, { ...copy, title: base })
      }
      continue
    }
    const merged = mergeText(host.body, copy.body)
    if (merged !== host.body) {
      await writePageFromRemote({ id: host.id, title: host.title, body: merged })
      host.body = merged
      mergedCount += 1
    }
    await deletePage(copy.id)
  }
  return mergedCount
}

async function pullRemote(
  token: string,
  owner: string,
  repo: string,
  parent: string | null,
  onProgress?: SyncReporter,
): Promise<{ pulled: number; conflicts: number }> {
  const folded = await foldRemoteCopies()
  if (!parent) return { pulled: 0, conflicts: folded }
  say(onProgress, 24, 'syncReadRemote')
  const commit = await gh(token, `/repos/${owner}/${repo}/git/commits/${parent}`)
  const tree = await gh(token, `/repos/${owner}/${repo}/git/trees/${commit.tree.sha}?recursive=1`)
  const entries = (tree.tree ?? []) as Array<{ path?: string; type?: string; sha?: string }>
  const files = entries.filter((item) => item.type === 'blob' && item.path && item.sha)
  const state = await readSyncState()
  const local = await readLocalPages()
  const localById = new Map(local.map((page) => [page.id, page]))
  const seen = new Set<string>()
  const pendingPages: Array<{ rel: string; raw: string }> = []
  let pulled = 0
  let conflicts = folded
  let done = 0
  for (const item of files) {
    const rel = item.path!
    done += 1
    if (rel === '目录.md' || (!rel.startsWith('pages/') && !rel.startsWith('assets/'))) continue
    say(onProgress, 28 + (done / Math.max(files.length, 1)) * 24, 'syncFetchFile', { done, total: files.length, name: rel })
    const bytes = await blobBytes(token, owner, repo, item.sha!)
    if (rel.startsWith('assets/')) {
      const name = rel.slice('assets/'.length)
      if (name.includes('/') || name.startsWith('.')) continue
      await mergeAsset(name, bytes, state?.assets[name])
      continue
    }
    if (!rel.endsWith('.md')) continue
    pendingPages.push({ rel, raw: bytes.toString('utf8') })
  }
  const parsedPages = pendingPages.map((item) => ({ rel: item.rel, ...parseRemotePage(item.raw) }))
  const idByPath = new Map<string, string>()
  for (const parsed of parsedPages) if (parsed.id) idByPath.set(parsed.rel, parsed.id)
  for (const parsed of parsedPages) {
    parsed.body = linksFromGithub(parsed.body, parsed.rel, idByPath)
    const rel = parsed.rel
    let id = parsed.id && localById.has(parsed.id) ? parsed.id : null
    if (!id) {
      const sameTitle = local.filter((page) => page.title === parsed.title && !seen.has(page.id))
      if (sameTitle.length === 1) id = sameTitle[0]!.id
    }
    const digest = pageDigest(parsed.title, parsed.body, parsed.organize)
    if (!id || !localById.has(id)) {
      const base = canonicalTitle(parsed.title)
      const twin = local.find((page) => canonicalTitle(page.title) === base)
      if (twin) {
        const differed = twin.body !== parsed.body
        if (differed || parsed.organize) {
          const merged = differed ? mergeText(twin.body, parsed.body) : twin.body
          await writePageFromRemote({
            id: twin.id,
            title: canonicalTitle(twin.title),
            body: merged,
            ...(parsed.organize ? { organize: parsed.organize } : {}),
          })
          twin.body = merged
          twin.title = canonicalTitle(twin.title)
          if (differed) conflicts += 1
        }
        seen.add(twin.id)
        continue
      }
      const nextId = parsed.id && PAGE_ID.test(parsed.id) && !localById.has(parsed.id) ? parsed.id : randomUUID()
      await writePageFromRemote({ id: nextId, title: base, body: parsed.body, organize: parsed.organize })
      local.push({ id: nextId, title: base, body: parsed.body, digest: pageDigest(base, parsed.body, parsed.organize), organize: parsed.organize ?? organizeOf(null) })
      localById.set(nextId, local[local.length - 1]!)
      seen.add(nextId)
      pulled += 1
      continue
    }
    seen.add(id)
    const current = localById.get(id)!
    const last = state?.pages[id]
    const remoteChanged = last !== digest
    const localChanged = last !== current.digest
    if (current.digest === digest) continue
    if (remoteChanged && localChanged) {
      const merged = mergeText(current.body, parsed.body)
      const organize = parsed.organize ? mergeOrganize(current.organize, parsed.organize) : current.organize
      if (merged !== current.body || organizeKey(current.organize) !== organizeKey(organize)) {
        await writePageFromRemote({
          id,
          title: current.title,
          body: merged,
          organize,
        })
      }
      conflicts += 1
      continue
    }
    if (remoteChanged && !localChanged) {
      await writePageFromRemote({ id, title: parsed.title, body: parsed.body, organize: parsed.organize })
      current.title = parsed.title
      current.body = parsed.body
      current.digest = digest
      pulled += 1
    }
  }
  if (state) {
    for (const id of Object.keys(state.pages)) {
      if (seen.has(id)) continue
      const current = localById.get(id)
      if (current && current.digest === state.pages[id]) {
        await deletePage(id)
        pulled += 1
      }
    }
  }
  conflicts += await foldRemoteCopies()
  return { pulled, conflicts }
}

const PAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function mergeAsset(name: string, remote: Buffer, last: string | undefined): Promise<void> {
  const abs = path.join(workspaceRoot(), 'assets', name)
  let local: Buffer | null = null
  try {
    local = await fs.readFile(abs)
  } catch {
    local = null
  }
  const remoteHash = createHash('sha256').update(remote).digest('hex')
  if (!local) {
    await saveNamedAsset(name, remote)
    return
  }
  if (local.equals(remote)) return
  const localHash = createHash('sha256').update(local).digest('hex')
  if (last === localHash && last !== remoteHash) {
    await saveNamedAsset(name, remote)
    return
  }
  if (!last || (last !== localHash && last !== remoteHash)) {
    const ext = path.extname(name)
    const stem = path.basename(name, ext)
    await saveNamedAsset(`${stem}.remote${ext || '.png'}`, remote).catch(() => undefined)
  }
}

async function overwriteLocal(
  token: string,
  owner: string,
  repo: string,
  parent: string,
  onProgress?: SyncReporter,
): Promise<{ pageCount: number }> {
  say(onProgress, 24, 'syncReadRemote')
  const commit = await gh(token, `/repos/${owner}/${repo}/git/commits/${parent}`)
  const tree = await gh(token, `/repos/${owner}/${repo}/git/trees/${commit.tree.sha}?recursive=1`)
  const entries = (tree.tree ?? []) as Array<{ path?: string; type?: string; sha?: string }>
  const files = entries.filter((item) => item.type === 'blob' && item.path && item.sha)
  const pendingPages: Array<{ rel: string; raw: string }> = []
  const assets: Array<{ name: string; bytes: Buffer }> = []
  let done = 0
  for (const item of files) {
    const rel = item.path!
    done += 1
    if (rel === '目录.md' || (!rel.startsWith('pages/') && !rel.startsWith('assets/'))) continue
    say(onProgress, 28 + (done / Math.max(files.length, 1)) * 24, 'syncFetchFile', { done, total: files.length, name: rel })
    const bytes = await blobBytes(token, owner, repo, item.sha!)
    if (rel.startsWith('assets/')) {
      const name = rel.slice('assets/'.length)
      const ext = path.extname(name).slice(1).toLowerCase()
      if (name.includes('/') || name.startsWith('.') || !['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) continue
      assets.push({ name, bytes })
      continue
    }
    if (rel.endsWith('.md')) pendingPages.push({ rel, raw: bytes.toString('utf8') })
  }
  const parsedPages = pendingPages.map((item) => ({ rel: item.rel, ...parseRemotePage(item.raw) }))
  const idByPath = new Map<string, string>()
  for (const parsed of parsedPages) if (parsed.id) idByPath.set(parsed.rel, parsed.id)
  const used = new Set<string>()
  const pages: Array<{ id: string; title: string; body: string; organize: PageOrganize | null }> = []
  for (const parsed of parsedPages) {
    const body = linksFromGithub(parsed.body, parsed.rel, idByPath)
    let id = parsed.id && PAGE_ID.test(parsed.id) ? parsed.id.toLowerCase() : randomUUID()
    if (used.has(id)) id = randomUUID()
    used.add(id)
    pages.push({ id, title: canonicalTitle(parsed.title), body, organize: parsed.organize })
  }
  if (pages.length === 0) throw new Error(translate(currentLocale(), 'syncNoRemote'))
  say(onProgress, 70, 'syncPrepareUpload')
  await replaceWorkspace(pages, assets)
  const local = await readLocalPages()
  const snapshotPages: Record<string, string> = {}
  for (const page of local) snapshotPages[page.id] = page.digest
  const snapshotAssets: Record<string, string> = {}
  for (const asset of assets) snapshotAssets[asset.name] = createHash('sha256').update(asset.bytes).digest('hex')
  await writeSyncState({ commit: parent, pages: snapshotPages, assets: snapshotAssets })
  say(onProgress, 100, 'syncDoneAll', { count: pages.length })
  return { pageCount: pages.length }
}

export async function syncWorkspace(
  onProgress?: SyncReporter,
  direction?: SyncDirection,
): Promise<{ url: string; commit: string; pageCount: number; pulled: number; conflicts: number }> {
  const secrets = await getSecrets()
  const view = await viewSettings()
  if (!secrets.githubToken || !view.githubUser) throw new Error(translate(currentLocale(), 'ghNeedLogin'))
  const repo = view.githubRepo
  if (!repo) throw new Error(translate(currentLocale(), 'ghNeedRepo'))
  say(onProgress, 10, 'syncReadPages')
  const token = secrets.githubToken
  const base = `/repos/${repo.owner}/${repo.name}`
  say(onProgress, 14, 'syncConnect', { repo: `${repo.owner}/${repo.name}` })
  const info = await gh(token, base)
  const branch = info.default_branch || repo.branch || 'main'
  let parent: string | null = null
  for (let attempt = 0; attempt < 6; attempt += 1) {
    say(onProgress, 18, attempt === 0 ? 'syncReadBranch' : 'syncWaitBranch', { branch, attempt: attempt + 1 })
    try {
      const ref = await gh(token, `${base}/git/ref/heads/${branch}`)
      parent = ref.object.sha as string
      break
    } catch (error) {
      if (!missingRef(error) || attempt === 5) {
        if (!missingRef(error)) throw error
        parent = null
        break
      }
      await sleep(700)
    }
  }
  if (direction === 'remote') {
    if (!parent) throw new Error(translate(currentLocale(), 'syncNoRemote'))
    const replaced = await overwriteLocal(token, repo.owner, repo.name, parent, onProgress)
    return {
      url: `https://github.com/${repo.owner}/${repo.name}`,
      commit: parent,
      pageCount: replaced.pageCount,
      pulled: replaced.pageCount,
      conflicts: 0,
    }
  }
  const incoming = direction === 'local' ? { pulled: 0, conflicts: 0 } : await pullRemote(token, repo.owner, repo.name, parent, onProgress)
  say(onProgress, 54, 'syncPrepareUpload')
  const files = await listSyncFiles()
  const pageCount = files.filter((file) => file.path.startsWith('pages/')).length
  if (pageCount === 0) throw new Error(translate(currentLocale(), 'ghNoPages'))
  let uploaded = 0
  const blobs = await mapPool(files, 4, async (file) => {
    const blob = await gh(token, `${base}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: file.bytes.toString('base64'), encoding: 'base64' }),
    })
    uploaded += 1
    say(onProgress, 56 + (uploaded / files.length) * 32, 'syncUpload', {
      pages: pageCount,
      done: uploaded,
      total: files.length,
      name: file.label,
    })
    return { path: file.path, mode: '100644', type: 'blob', sha: blob.sha as string }
  })
  say(onProgress, 84, 'syncWriteTree')
  const tree = await gh(token, `${base}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ tree: blobs }),
  })
  say(onProgress, 91, 'syncCommit')
  const commit = await gh(token, `${base}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({
      message: `同步笔记（${pageCount} 个页面）`,
      tree: tree.sha,
      parents: parent ? [parent] : [],
    }),
  })
  say(onProgress, 96, 'syncUpdateBranch', { branch })
  if (parent) {
    try {
      await gh(token, `${base}/git/refs/heads/${branch}`, {
        method: 'PATCH',
        body: JSON.stringify({ sha: commit.sha }),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (direction !== 'local' || !/GitHub 422/.test(message)) throw error
      await gh(token, `${base}/git/refs/heads/${branch}`, {
        method: 'PATCH',
        body: JSON.stringify({ sha: commit.sha, force: true }),
      })
    }
  } else {
    try {
      await gh(token, `${base}/git/refs`, {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
      })
    } catch (error) {
      if (!/GitHub 422/.test(error instanceof Error ? error.message : String(error))) throw error
      await gh(token, `${base}/git/refs/heads/${branch}`, {
        method: 'PATCH',
        body: JSON.stringify({ sha: commit.sha }),
      })
    }
  }
  if (branch !== repo.branch) await setGitHubRepo({ ...repo, branch })
  const pages = await readLocalPages()
  const snapshotPages: Record<string, string> = {}
  for (const page of pages) snapshotPages[page.id] = page.digest
  const snapshotAssets: Record<string, string> = {}
  for (const file of files) {
    if (file.path.startsWith('assets/')) snapshotAssets[file.path.slice('assets/'.length)] = createHash('sha256').update(file.bytes).digest('hex')
  }
  await writeSyncState({ commit: commit.sha as string, pages: snapshotPages, assets: snapshotAssets })
  say(onProgress, 100, 'syncDoneAll', { count: pageCount })
  return {
    url: `https://github.com/${repo.owner}/${repo.name}`,
    commit: commit.sha as string,
    pageCount,
    pulled: incoming.pulled,
    conflicts: incoming.conflicts,
  }
}

async function syncAfter(
  prepare: () => Promise<{ settings: SettingsView; url: string }>,
  onProgress?: SyncReporter,
) {
  await prepare()
  const synced = await syncWorkspace(onProgress)
  return {
    settings: await viewSettings(),
    url: synced.url,
    commit: synced.commit,
    pageCount: synced.pageCount,
    pulled: synced.pulled,
    conflicts: synced.conflicts,
  }
}

export function createAndSync(name: string, onProgress?: SyncReporter) {
  return syncAfter(async () => {
    say(onProgress, 2, 'syncCreatingRepo')
    try {
      const created = await createPrivateRepo(name)
      say(onProgress, 8, 'syncRepoCreated')
      return created
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/already exists|422/i.test(message)) throw error
      const view = await viewSettings()
      if (!view.githubUser) throw error
      say(onProgress, 6, 'syncRepoExists')
      return linkRepo(`${view.githubUser.login}/${repoName(name)}`)
    }
  }, onProgress)
}

export function linkAndSync(fullName: string, onProgress?: SyncReporter) {
  return syncAfter(async () => {
    say(onProgress, 4, 'syncBinding')
    const linked = await linkRepo(fullName)
    say(onProgress, 8, 'syncBound')
    return linked
  }, onProgress)
}
