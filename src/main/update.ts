import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { translate } from '../shared/i18n'
import { currentLocale } from './store'
import type { UpdateStatus } from '../shared/types'

function send(status: UpdateStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('update:status', status)
  }
}

let tracking = false
let listening = false

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
    send({ phase: 'current', version: info.version })
  })
  autoUpdater.on('download-progress', (progress) => {
    send({ phase: 'progress', percent: Math.round(progress.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => {
    tracking = true
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
    void autoUpdater.checkForUpdates()
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
  await autoUpdater.checkForUpdates()
}

export function installDownloadedUpdate(): void {
  autoUpdater.quitAndInstall(false, true)
}
