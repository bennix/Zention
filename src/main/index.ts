import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { completeChat, generateAndStoreImage, testConnection } from './ai'
import { detectProxy } from './proxy'
import { translate } from '../shared/i18n'
import { currentLocale } from './store'
import { createAndSync, foldRemoteCopies, linkAndSync, loginWithGhCli, loginWithToken, logoutGitHub, syncWorkspace } from './github'
import { ensureGh, watchGhSetup } from './ghEnv'
import { exportMarkdown, exportPdf } from './export'
import { decodeExternalToken, importMarkdownPage, readExternalMarkdown, resolveExternalImage, saveExternalAs, saveExternalImage, writeExternalMarkdown } from './external'
import { rebuildAppMenu, setMenuUpdateHandlers } from './menu'
import { applyUpdaterProxy, checkForAppUpdate, installDownloadedUpdate, setupAutoUpdate } from './update'
import {
  cleanUnusedAssets,
  createDatabase,
  createDatabaseRow,
  createPage,
  deletePage,
  listUnusedAssets,
  organizePage,
  initPaths,
  initStore,
  listPages,
  pickSafeExt,
  readPage,
  renamePage,
  resolveAssetPath,
  revealSecret,
  saveAsset,
  saveMedia,
  savePage,
  updateSettings,
  viewSettings,
} from './store'
import type { ChatInput, PagePatch, Result, SettingsPatch, SyncProgress } from '../shared/types'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'zention-asset',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      bypassCSP: true,
    },
  },
])

app.setName('Zention')
app.setPath('userData', path.join(app.getPath('appData'), 'Zention'))

let mainWindow: BrowserWindow | null = null

function messageOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  if (error.message !== 'fetch failed') return error.message
  const cause = error.cause
  const code = cause && typeof cause === 'object' && 'code' in cause ? String((cause as { code?: unknown }).code ?? '') : ''
  const nested = cause instanceof Error ? cause.message : ''
  const detail = [code, nested].filter((part) => part && part !== 'fetch failed').join(' ')
  return detail ? translate(currentLocale(), 'netFail', { detail }) : translate(currentLocale(), 'netFailBare')
}

async function guard<T extends Record<string, unknown>>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    const data = await fn()
    return { ok: true, ...data }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

function appIconFile(): string {
  const name = process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  const candidates = [
    path.join(process.resourcesPath, 'resources', name),
    path.join(app.getAppPath(), 'resources', name),
    path.join(__dirname, '../../resources', name),
  ]
  return candidates.find((file) => existsSync(file)) ?? candidates[0]
}

function createWindow(): void {
  const icon = appIconFile()
  if (process.platform === 'darwin' && app.dock && existsSync(icon)) app.dock.setIcon(icon)
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'Zention',
    icon,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#f6f5f4',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.on('did-finish-load', () => {
    if (!pendingMarkdown || !mainWindow) return
    mainWindow.webContents.send('markdown:open', pendingMarkdown)
  })
  if (process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
}

function emitSyncProgress(progress: SyncProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('github:progress', progress)
  }
}

function registerIpc(): void {
  ipcMain.handle('app:version', () => guard(async () => ({ version: app.getVersion() })))
  ipcMain.handle('update:check', () =>
    guard(async () => {
      await checkForAppUpdate()
      return {}
    }),
  )
  ipcMain.handle('update:install', () =>
    guard(async () => {
      installDownloadedUpdate()
      return {}
    }),
  )
  ipcMain.handle('settings:get', () => guard(async () => ({ settings: await viewSettings() })))
  ipcMain.handle('settings:update', (_event, patch: SettingsPatch) =>
    guard(async () => {
      const settings = await updateSettings(patch)
      if (patch.proxy !== undefined) await applyUpdaterProxy()
      if (patch.locale !== undefined) rebuildAppMenu()
      return { settings }
    }),
  )
  ipcMain.handle('settings:reveal', (_event, which: 'apiKey' | 'githubToken') =>
    guard(async () => ({ value: await revealSecret(which) })),
  )
  ipcMain.handle('settings:detect-proxy', () => guard(() => detectProxy()))
  ipcMain.handle('pages:list', () => guard(async () => ({ pages: await listPages() })))
  ipcMain.handle('pages:read', (_event, id: string) => guard(async () => ({ page: await readPage(id) })))
  ipcMain.handle('pages:save', (_event, id: string, body: string) =>
    guard(async () => {
      await savePage(id, body)
      return {}
    }),
  )
  ipcMain.handle('pages:create', (_event, title?: string, parentId?: string | null) =>
    guard(async () => {
      const page = await createPage(title, parentId)
      return { page, pages: await listPages() }
    }),
  )
  ipcMain.handle('pages:create-database', (_event, title?: string) =>
    guard(async () => {
      const page = await createDatabase(title)
      return { page, pages: await listPages() }
    }),
  )
  ipcMain.handle('pages:create-database-row', (_event, databaseId: string, title?: string) =>
    guard(async () => {
      const page = await createDatabaseRow(databaseId, title)
      return { page, pages: await listPages() }
    }),
  )
  ipcMain.handle('assets:unused', (event) =>
    guard(async () =>
      listUnusedAssets((progress) => {
        if (!event.sender.isDestroyed()) event.sender.send('assets:progress', progress)
      }),
    ),
  )
  ipcMain.handle('assets:clean-unused', (event) =>
    guard(async () =>
      cleanUnusedAssets(
        (abs) => shell.trashItem(abs),
        (progress) => {
          if (!event.sender.isDestroyed()) event.sender.send('assets:progress', progress)
        },
      ),
    ),
  )
  ipcMain.handle('pages:organize', (_event, id: string, patch: PagePatch) =>
    guard(async () => ({ pages: await organizePage(id, patch) })),
  )
  ipcMain.handle('pages:rename', (_event, id: string, title: string) =>
    guard(async () => ({ page: await renamePage(id, title) })),
  )
  ipcMain.handle('pages:delete', (_event, id: string) => guard(async () => ({ pages: await deletePage(id) })))
  ipcMain.handle('asset:pick', () =>
    guard(async () => {
      const options = {
        title: translate(currentLocale(), 'pickImageTitle'),
        properties: ['openFile'] as Array<'openFile'>,
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }],
      }
      const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || !result.filePaths[0]) return { path: null }
      const file = result.filePaths[0]
      const bytes = await import('node:fs').then((fs) => fs.promises.readFile(file))
      const ext = pickSafeExt(file)
      return { path: await saveAsset(bytes, ext) }
    }),
  )
  ipcMain.handle('asset:pick-media', (_event, kind: 'audio' | 'video' | 'any' = 'any') =>
    guard(async () => {
      const audio = { name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'] }
      const video = { name: 'Video', extensions: ['mp4', 'webm', 'mov', 'm4v'] }
      const filters =
        kind === 'audio' ? [audio] : kind === 'video' ? [video] : [{ name: 'Media', extensions: [...audio.extensions, ...video.extensions] }, audio, video]
      const options = {
        title: translate(currentLocale(), kind === 'audio' ? 'pickAudioTitle' : kind === 'video' ? 'pickVideoTitle' : 'pickMediaTitle'),
        properties: ['openFile'] as Array<'openFile'>,
        filters,
      }
      const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || !result.filePaths[0]) return { path: null }
      const file = result.filePaths[0]
      const bytes = await import('node:fs').then((fs) => fs.promises.readFile(file))
      const ext = pickSafeExt(file, 'media')
      return { path: await saveMedia(bytes, ext) }
    }),
  )
  ipcMain.handle('asset:save', (_event, payload: { base64: string; ext: string }) =>
    guard(async () => ({ path: await saveAsset(Buffer.from(payload.base64, 'base64'), payload.ext) })),
  )
  ipcMain.handle('ai:complete', (event, input: ChatInput & { streamId?: string }) =>
    guard(async () => {
      const { streamId, ...chat } = input
      const content = await completeChat(
        chat,
        (delta) => {
          if (streamId) event.sender.send('ai:delta', { streamId, delta })
        },
        () => {
          if (streamId) event.sender.send('ai:delta', { streamId, reset: true })
        },
      )
      return { content }
    }),
  )
  ipcMain.handle('ai:image', (_event, input: { prompt: string; model?: string; aspectRatio?: string }) =>
    guard(async () => ({ path: await generateAndStoreImage(input) })),
  )
  ipcMain.handle(
    'ai:test',
    (_event, input: { kind: 'key' | 'chat' | 'image'; apiKey?: string; baseUrl?: string; model?: string; proxy?: string }) =>
      guard(async () => ({ message: await testConnection(input) })),
  )
  ipcMain.handle('github:token', (_event, token: string) =>
    guard(async () => ({ settings: await loginWithToken(token) })),
  )
  ipcMain.handle('github:cli', () => guard(async () => ({ settings: await loginWithGhCli() })))
  ipcMain.handle('github:ensure', (event) =>
    guard(async () => {
      const stop = watchGhSetup((progress) => event.sender.send('github:env', progress))
      try {
        const env = await ensureGh()
        return { version: env.version, source: env.source }
      } finally {
        stop()
      }
    }),
  )
  ipcMain.handle('github:logout', () => guard(async () => ({ settings: await logoutGitHub() })))
  ipcMain.handle('github:create', (_event, name: string) => guard(() => createAndSync(name, emitSyncProgress)))
  ipcMain.handle('github:link', (_event, fullName: string) => guard(() => linkAndSync(fullName, emitSyncProgress)))
  ipcMain.handle('github:sync', (_event, direction: 'remote' | 'local') =>
    guard(async () => {
      try {
        if (direction !== 'remote' && direction !== 'local') throw new Error(translate(currentLocale(), 'syncChoose'))
        return await syncWorkspace(emitSyncProgress, direction)
      } catch (error) {
        console.error('[github-sync]', error instanceof Error ? error.message : error)
        throw error
      }
    }),
  )
  ipcMain.handle('export:markdown', (_event, input: { title: string; markdown: string }) =>
    guard(async () => {
      const saved = await exportMarkdown(mainWindow, input.title, input.markdown)
      if (!saved) return { canceled: true }
      return { canceled: false, file: saved.file, images: saved.images }
    }),
  )
  ipcMain.handle('export:pdf', (_event, input: { title: string; html: string }) =>
    guard(async () => {
      const saved = await exportPdf(mainWindow, input.title, input.html)
      if (!saved) return { canceled: true }
      return { canceled: false, file: saved.file }
    }),
  )
  ipcMain.handle('markdown:read', (_event, filePath: string) => guard(() => readExternalMarkdown(filePath)))
  ipcMain.handle('markdown:import', (_event, filePath: string) => guard(async () => ({ page: await importMarkdownPage(filePath) })))
  ipcMain.handle('markdown:save', (_event, input: { path: string; body: string }) =>
    guard(() => writeExternalMarkdown(input.path, input.body)),
  )
  ipcMain.handle('markdown:save-as', (_event, input: { body: string; suggestedName: string }) =>
    guard(async () => {
      const saved = await saveExternalAs(mainWindow, input.body, input.suggestedName)
      if (!saved) return { canceled: true }
      return { canceled: false, path: saved.path, name: saved.name }
    }),
  )
  ipcMain.handle('markdown:image', (_event, payload: { base64: string; ext: string }) =>
    guard(async () => ({ path: await saveExternalImage(Buffer.from(payload.base64, 'base64'), payload.ext) })),
  )
  ipcMain.handle('markdown:pending', () => {
    const file = pendingMarkdown
    pendingMarkdown = ''
    return file
  })
  ipcMain.handle('shell:open', (_event, url: string) =>
    guard(async () => {
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        throw new Error(translate(currentLocale(), 'ghBadLink'))
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error(translate(currentLocale(), 'ghWebOnly'))
      await shell.openExternal(parsed.toString())
      return {}
    }),
  )
}

let pendingMarkdown = ''

function deliverMarkdown(filePath: string): void {
  if (!/\.(md|markdown)$/i.test(filePath)) return
  pendingMarkdown = filePath
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send('markdown:open', filePath)
    mainWindow.show()
    mainWindow.focus()
  }
}

app.on('open-file', (event, filePath) => {
  event.preventDefault()
  deliverMarkdown(filePath)
})

const locked = app.requestSingleInstanceLock()
if (!locked) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const file = argv.find((arg) => /\.(md|markdown)$/i.test(arg) && !arg.startsWith('-'))
    if (file) deliverMarkdown(file)
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow()
      return
    }
    mainWindow.show()
    mainWindow.focus()
  })
}

app.whenReady().then(async () => {
  if (!locked) return
  if (!pendingMarkdown) {
    const fromArg = process.argv.find((arg) => /\.(md|markdown)$/i.test(arg) && existsSync(arg))
    if (fromArg) pendingMarkdown = fromArg
  }
  const userData = app.getPath('userData')
  initPaths(userData)
  await initStore()
  await foldRemoteCopies()
  protocol.handle('zention-asset', (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname === 'ext') {
        const token = decodeURIComponent(url.pathname).replace(/^\/+/, '')
        return net.fetch(pathToFileURL(resolveExternalImage(decodeExternalToken(token))).toString())
      }
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
      return net.fetch(pathToFileURL(resolveAssetPath(rel)).toString())
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
  registerIpc()
  setMenuUpdateHandlers({
    check: () => void checkForAppUpdate(),
    install: () => installDownloadedUpdate(),
  })
  createWindow()
  setupAutoUpdate()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
