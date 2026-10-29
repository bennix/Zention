import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { translate } from '../shared/i18n'
import { detectProxy, normalizeProxyUrl } from './proxy'
import { setMenuUpdateInstallable } from './menu'
import { currentLocale, getSecrets } from './store'
import type { UpdateStatus } from '../shared/types'

const UPDATE_PROBE = 'https://github.com/bennix/Zention/releases/latest'

function send(status: UpdateStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('update:status', status)
  }
}

let tracking = false
let listening = false

function proxyRulesFor(proxyUrl: string): string {
  const url = new URL(proxyUrl)
  if (url.protocol.startsWith('socks')) {
    const scheme = url.protocol === 'socks4:' ? 'socks4' : 'socks5'
    return `${scheme}://${url.hostname}:${url.port}`
  }
  return `http://${url.hostname}:${url.port}`
}

async function resolveUpdaterProxyUrl(): Promise<string> {
  const secrets = await getSecrets()
  if (secrets.proxy !== undefined) return normalizeProxyUrl(secrets.proxy)
  const detected = await detectProxy(UPDATE_PROBE)
  return detected.url
}

export async function applyUpdaterProxy(): Promise<void> {
  const proxyUrl = await resolveUpdaterProxyUrl()
  if (!proxyUrl) {
    await autoUpdater.netSession.setProxy({ mode: 'direct' })
    return
  }
  await autoUpdater.netSession.setProxy({
    mode: 'fixed_servers',
    proxyRules: proxyRulesFor(proxyUrl),
  })
}

function listenForUpdates(): void {
  if (listening) return
  listening = true
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-available', (info) => {
    tracking = true
    send({ phase: 'available', version: info.version })
  })
  autoUpdater.on('update-not-available', (info) => {
    setMenuUpdateInstallable(false)
    send({ phase: 'current', version: info.version })
  })
  autoUpdater.on('download-progress', (progress) => {
    send({ phase: 'progress', percent: Math.round(progress.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => {
    tracking = true
    setMenuUpdateInstallable(true)
    send({ phase: 'downloaded', version: info.version })
  })
  autoUpdater.on('error', (error) => {
    if (!tracking) return
    send({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
  })
}

export function setupAutoUpdate(): void {
  if (!app.isPackaged) return
  listenForUpdates()
  setTimeout(() => {
    tracking = true
    void (async () => {
      await applyUpdaterProxy()
      await autoUpdater.checkForUpdates()
    })()
  }, 5000)
}

export async function checkForAppUpdate(): Promise<void> {
  if (!app.isPackaged) {
    send({ phase: 'error', message: translate(currentLocale(), 'updateUnpackaged') })
    return
  }
  listenForUpdates()
  tracking = true
  send({ phase: 'checking' })
  await applyUpdaterProxy()
  await autoUpdater.checkForUpdates()
}

export function installDownloadedUpdate(): void {
  autoUpdater.quitAndInstall(false, true)
}
