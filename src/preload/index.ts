import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { SettingsPatch, SyncProgress, UpdateStatus, ZentionApi } from '../shared/types'

const api: ZentionApi = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch: SettingsPatch) => ipcRenderer.invoke('settings:update', patch),
  revealSecret: (which) => ipcRenderer.invoke('settings:reveal', which),
  detectProxy: () => ipcRenderer.invoke('settings:detect-proxy'),
  listPages: () => ipcRenderer.invoke('pages:list'),
  readPage: (id) => ipcRenderer.invoke('pages:read', id),
  savePage: (id, body) => ipcRenderer.invoke('pages:save', id, body),
  createPage: (title, parentId) => ipcRenderer.invoke('pages:create', title, parentId),
  organizePage: (id, patch) => ipcRenderer.invoke('pages:organize', id, patch),
  renamePage: (id, title) => ipcRenderer.invoke('pages:rename', id, title),
  deletePage: (id) => ipcRenderer.invoke('pages:delete', id),
  pickImage: () => ipcRenderer.invoke('asset:pick'),
  saveImage: (payload) => ipcRenderer.invoke('asset:save', payload),
  aiComplete: (input, onDelta, onReset) => {
    if (!onDelta) return ipcRenderer.invoke('ai:complete', input)
    const streamId = crypto.randomUUID()
    const listener = (_event: Electron.IpcRendererEvent, payload: { streamId?: string; delta?: string; reset?: boolean }) => {
      if (payload.streamId !== streamId) return
      if (payload.reset) onReset?.()
      else if (payload.delta) onDelta(payload.delta)
    }
    ipcRenderer.on('ai:delta', listener)
    return ipcRenderer.invoke('ai:complete', { ...input, streamId }).finally(() => {
      ipcRenderer.removeListener('ai:delta', listener)
    })
  },
  aiImage: (input) => ipcRenderer.invoke('ai:image', input),
  testConnection: (input) => ipcRenderer.invoke('ai:test', input),
  githubLoginToken: (token) => ipcRenderer.invoke('github:token', token),
  githubLoginCli: () => ipcRenderer.invoke('github:cli'),
  ensureGithubCli: () => ipcRenderer.invoke('github:ensure'),
  onGithubEnv: (callback: (progress: SyncProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: SyncProgress) => callback(progress)
    ipcRenderer.on('github:env', listener)
    return () => ipcRenderer.removeListener('github:env', listener)
  },
  githubLogout: () => ipcRenderer.invoke('github:logout'),
  githubCreateRepo: (name) => ipcRenderer.invoke('github:create', name),
  githubLinkRepo: (fullName) => ipcRenderer.invoke('github:link', fullName),
  githubSync: () => ipcRenderer.invoke('github:sync'),
  onGithubProgress: (callback: (progress: SyncProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: SyncProgress) => callback(progress)
    ipcRenderer.on('github:progress', listener)
    return () => ipcRenderer.removeListener('github:progress', listener)
  },
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  exportMarkdown: (input) => ipcRenderer.invoke('export:markdown', input),
  exportPdf: (input) => ipcRenderer.invoke('export:pdf', input),
  pathForFile: (file) => webUtils.getPathForFile(file),
  readMarkdown: (filePath) => ipcRenderer.invoke('markdown:read', filePath),
  importMarkdown: (filePath) => ipcRenderer.invoke('markdown:import', filePath),
  saveMarkdown: (input) => ipcRenderer.invoke('markdown:save', input),
  saveMarkdownAs: (input) => ipcRenderer.invoke('markdown:save-as', input),
  saveExternalImage: (payload) => ipcRenderer.invoke('markdown:image', payload),
  onMarkdownOpen: (callback: (filePath: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, filePath: string) => callback(filePath)
    ipcRenderer.on('markdown:open', listener)
    return () => ipcRenderer.removeListener('markdown:open', listener)
  },
  takePendingMarkdown: () => ipcRenderer.invoke('markdown:pending'),
  onUpdate: (callback: (status: UpdateStatus) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: UpdateStatus) => callback(status)
    ipcRenderer.on('update:status', listener)
    return () => ipcRenderer.removeListener('update:status', listener)
  },
  installUpdate: () => ipcRenderer.invoke('update:install'),
}

contextBridge.exposeInMainWorld('zention', api)
