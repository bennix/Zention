import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { translate, type MessageKey } from '../shared/i18n'
import type { SyncProgress } from '../shared/types'
import { proxyRouteFor } from './proxy'
import { appDataRoot, currentLocale, getSecrets } from './store'

export interface GhEnvironment {
  path: string
  version: string
  source: 'system' | 'app'
}

type Reporter = (progress: SyncProgress) => void

const listeners = new Set<Reporter>()
let inflight: Promise<GhEnvironment> | null = null

function text(key: MessageKey, vars?: Record<string, string | number>): string {
  return translate(currentLocale(), key, vars)
}

function emit(percent: number, key: MessageKey, vars?: Record<string, string | number>): void {
  const progress = { percent, text: text(key, vars) }
  for (const listener of listeners) listener(progress)
}

export function ensureGh(): Promise<GhEnvironment> {
  if (!inflight) {
    inflight = installGh().finally(() => {
      inflight = null
      listeners.clear()
    })
  }
  return inflight
}

export function watchGhSetup(listener: Reporter): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function assetSuffix(): string | null {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'amd64' : process.arch === 'ia32' ? '386' : ''
  if (!arch) return null
  if (process.platform === 'darwin') return `macOS_${arch}.zip`
  if (process.platform === 'linux') return `linux_${arch}.tar.gz`
  if (process.platform === 'win32') return `windows_${arch}.zip`
  return null
}

function searchDirs(): string[] {
  const home = os.homedir()
  const extras =
    process.platform === 'darwin'
      ? ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
      : process.platform === 'linux'
        ? ['/usr/local/bin', '/usr/bin', path.join(home, '.local/bin'), '/home/linuxbrew/.linuxbrew/bin']
        : [
            path.join(process.env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI'),
            path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'GitHub CLI'),
            path.join(process.env.LOCALAPPDATA || '', 'GitHub CLI'),
          ]
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  return [...new Set([...extras, ...pathDirs].filter(Boolean))]
}

async function versionOf(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 8000 }, (error, stdout) => {
      if (error) {
        resolve(null)
        return
      }
      const match = /gh version\s+(\S+)/i.exec(stdout)
      resolve(match?.[1] ?? stdout.trim().split('\n')[0] ?? '')
    })
  })
}

async function findSystemGh(): Promise<GhEnvironment | null> {
  const name = process.platform === 'win32' ? 'gh.exe' : 'gh'
  for (const dir of searchDirs()) {
    const candidate = path.join(dir, name)
    try {
      await fs.access(candidate)
    } catch {
      continue
    }
    const version = await versionOf(candidate)
    if (version) return { path: candidate, version, source: 'system' }
  }
  return null
}

async function managedGh(): Promise<GhEnvironment | null> {
  const bin = path.join(appDataRoot(), 'bin', process.platform === 'win32' ? 'gh.exe' : 'gh')
  const version = await versionOf(bin)
  if (!version) return null
  return { path: bin, version, source: 'app' }
}

async function installGh(): Promise<GhEnvironment> {
  emit(8, 'ghEnvLooking')
  const existing = (await findSystemGh()) ?? (await managedGh())
  if (existing) {
    emit(100, existing.source === 'app' ? 'ghEnvApp' : 'ghEnvSystem', { version: existing.version })
    return existing
  }
  const suffix = assetSuffix()
  if (!suffix) throw new Error(text('ghEnvUnsupported', { platform: `${process.platform} ${process.arch}` }))
  emit(18, 'ghEnvDownloading', { percent: 0 })
  const release = await fetchJson('https://api.github.com/repos/cli/cli/releases/latest')
  const assets: Array<{ name?: string; browser_download_url?: string }> = Array.isArray(release.assets) ? release.assets : []
  const asset = assets.find((item) => typeof item?.name === 'string' && item.name.endsWith(suffix))
  const checksumAsset = assets.find((item) => typeof item?.name === 'string' && item.name.endsWith('_checksums.txt'))
  const downloadUrl = typeof asset?.browser_download_url === 'string' ? asset.browser_download_url : ''
  const assetName = asset?.name
  if (!downloadUrl || typeof assetName !== 'string') {
    throw new Error(text('ghEnvUnsupported', { platform: `${process.platform} ${process.arch}` }))
  }
  const archive = await fetchBuffer(downloadUrl, (received, total) => {
    const percent = total > 0 ? Math.min(78, 18 + Math.round((received / total) * 60)) : 40
    emit(percent, 'ghEnvDownloading', { percent })
  })
  if (typeof checksumAsset?.browser_download_url === 'string') {
    const checksums = (await fetchBuffer(checksumAsset.browser_download_url)).toString('utf8')
    const line = checksums.split(/\r?\n/).find((item) => item.includes(assetName))
    const expected = line?.split(/\s+/)[0]?.toLowerCase()
    const actual = createHash('sha256').update(archive).digest('hex')
    if (!expected || expected !== actual) throw new Error(text('ghEnvChecksum'))
  }
  emit(86, 'ghEnvExtracting')
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'zention-gh-'))
  try {
    const archivePath = path.join(temp, assetName)
    await fs.writeFile(archivePath, archive)
    await extract(archivePath, temp)
    const unpacked = await findBinary(temp)
    if (!unpacked) throw new Error(text('ghEnvFailed', { detail: assetName }))
    const destDir = path.join(appDataRoot(), 'bin')
    await fs.mkdir(destDir, { recursive: true })
    const dest = path.join(destDir, process.platform === 'win32' ? 'gh.exe' : 'gh')
    await fs.copyFile(unpacked, dest)
    if (process.platform !== 'win32') await fs.chmod(dest, 0o755)
    const version = await versionOf(dest)
    if (!version) throw new Error(text('ghEnvFailed', { detail: dest }))
    const ready = { path: dest, version, source: 'app' as const }
    emit(100, 'ghEnvApp', { version })
    return ready
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
}

async function extract(archive: string, dest: string): Promise<void> {
  const args = archive.endsWith('.tar.gz') ? ['-xzf', archive, '-C', dest] : ['-xf', archive, '-C', dest]
  await new Promise<void>((resolve, reject) => {
    execFile('tar', args, { timeout: 60_000 }, (error, _stdout, stderr) => {
      if (error) reject(new Error(text('ghEnvFailed', { detail: stderr.trim() || error.message })))
      else resolve()
    })
  })
}

async function findBinary(dir: string): Promise<string | null> {
  const wanted = process.platform === 'win32' ? 'gh.exe' : 'gh'
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = await findBinary(full)
      if (nested) return nested
    } else if (entry.name === wanted) {
      return full
    }
  }
  return null
}

async function fetchJson(url: string): Promise<any> {
  const body = await fetchBuffer(url, undefined, { Accept: 'application/vnd.github+json', 'User-Agent': 'Zention' })
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    throw new Error(text('ghEnvFailed', { detail: url }))
  }
}

async function fetchBuffer(
  url: string,
  onData?: (received: number, total: number) => void,
  headers?: Record<string, string>,
  redirects = 0,
): Promise<Buffer> {
  if (redirects > 5) throw new Error(text('ghEnvFailed', { detail: url }))
  const target = new URL(url)
  const secrets = await getSecrets()
  const route = await proxyRouteFor(target.toString(), secrets.proxy)
  const transport = target.protocol === 'http:' ? http.request : https.request
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (run: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      run()
    }
    const req = transport(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: { 'User-Agent': 'Zention', Accept: 'application/octet-stream', ...headers },
        ...(route.agent ? { agent: route.agent } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume()
          const next = new URL(res.headers.location, target).toString()
          fetchBuffer(next, onData, headers, redirects + 1).then(
            (body) => finish(() => resolve(body)),
            (error) => finish(() => reject(error)),
          )
          return
        }
        const chunks: Buffer[] = []
        let received = 0
        const total = Number(res.headers['content-length'] || 0)
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
          received += chunk.length
          onData?.(received, total)
        })
        res.on('end', () => {
          const body = Buffer.concat(chunks)
          if (status < 200 || status >= 300) {
            finish(() => reject(new Error(text('ghEnvFailed', { detail: `${status} ${body.toString('utf8').slice(0, 180)}` }))))
            return
          }
          finish(() => resolve(body))
        })
        res.on('error', (error) => finish(() => reject(new Error(text('ghEnvFailed', { detail: error.message })))))
      },
    )
    const timer = setTimeout(() => {
      req.destroy()
      finish(() => reject(new Error(text('netTimeout'))))
    }, 60_000)
    req.on('error', (error) => finish(() => reject(new Error(text('ghEnvFailed', { detail: error.message })))))
    req.end()
  })
}
