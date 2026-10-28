import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatus } from '../shared/types'

function send(status: UpdateStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('update:status', status)
  }
}

export function setupAutoUpdate(): void {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  let tracking = false
  autoUpdater.on('update-available', (info) => {
    tracking = true
    send({ phase: 'available', version: info.version })
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
  setTimeout(() => {
    void autoUpdater.checkForUpdates()
  }, 5000)
}

export function installDownloadedUpdate(): void {
  autoUpdater.quitAndInstall(false, true)
}
