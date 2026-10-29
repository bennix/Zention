export const ZENMUX_BASE_URL = 'https://zenmux.ai/api/v1'
export const ZENMUX_VERTEX_BASE = 'https://zenmux.ai/api/vertex-ai/v1'
export const ZENMUX_INVITE_URL = 'https://zenmux.ai/invite/GBQMC5'

export const DEFAULT_CHAT_MODELS = [
  'anthropic/claude-sonnet-4.6',
  'z-ai/glm-5v-turbo',
  'openai/gpt-5.4',
] as const

/** Union of the image models used by GenOffice and RedDream. */
export const DEFAULT_IMAGE_MODELS = [
  'openai/gpt-image-2',
  'google/gemini-3-pro-image-preview',
  'google/gemini-3.1-flash-image',
  'google/gemini-3-pro-image',
  'qwen/qwen-image-2.0-pro',
  'z-ai/glm-image',
] as const

export interface UpdateStatus {
  phase: 'available' | 'progress' | 'downloaded' | 'error'
  version?: string
  percent?: number
  message?: string
}

export interface PageMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  parentId?: string | null
  folder?: boolean
  group?: string
  tags?: string[]
}

export interface PagePatch {
  parentId?: string | null
  folder?: boolean
  group?: string
  tags?: string[]
}

export interface PageData extends PageMeta {
  body: string
}

export interface GitHubUser {
  login: string
  name: string
  avatarUrl: string
}

export interface GitHubRepo {
  owner: string
  name: string
  branch: string
}

export interface SettingsView {
  hasApiKey: boolean
  baseUrl: string
  chatModels: string[]
  chatModel: string
  imageModels: string[]
  imageModel: string
  proxy: string
  proxyConfigured: boolean
  locale: string
  inviteUrl: string
  githubUser: GitHubUser | null
  githubRepo: GitHubRepo | null
}

export interface SyncProgress {
  percent: number
  text: string
}

export interface SettingsPatch {
  apiKey?: string
  clearApiKey?: boolean
  baseUrl?: string
  chatModels?: string[]
  chatModel?: string
  imageModels?: string[]
  imageModel?: string
  proxy?: string
  locale?: string
}

export interface ChatImage {
  mime: string
  base64: string
}

export interface ChatInput {
  system: string
  user: string
  model?: string
  images?: ChatImage[]
}

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string }

export interface ZentionApi {
  getSettings(): Promise<Result<{ settings: SettingsView }>>
  updateSettings(patch: SettingsPatch): Promise<Result<{ settings: SettingsView }>>
  revealSecret(which: 'apiKey' | 'githubToken'): Promise<Result<{ value: string }>>
  detectProxy(): Promise<Result<{ url: string; label: string; kind: 'direct' | 'http' | 'socks'; endpoint: string }>>
  listPages(): Promise<Result<{ pages: PageMeta[] }>>
  readPage(id: string): Promise<Result<{ page: PageData }>>
  savePage(id: string, body: string): Promise<Result<Record<string, never>>>
  createPage(title?: string, parentId?: string | null): Promise<Result<{ page: PageData; pages: PageMeta[] }>>
  organizePage(id: string, patch: PagePatch): Promise<Result<{ pages: PageMeta[] }>>
  renamePage(id: string, title: string): Promise<Result<{ page: PageMeta }>>
  deletePage(id: string): Promise<Result<{ pages: PageMeta[] }>>
  pickImage(): Promise<Result<{ path: string | null }>>
  saveImage(payload: { base64: string; ext: string }): Promise<Result<{ path: string }>>
  aiComplete(input: ChatInput, onDelta?: (delta: string) => void, onReset?: () => void): Promise<Result<{ content: string }>>
  aiImage(input: {
    prompt: string
    model?: string
    aspectRatio?: string
  }): Promise<Result<{ path: string }>>
  testConnection(input: {
    kind: 'key' | 'chat' | 'image'
    apiKey?: string
    baseUrl?: string
    model?: string
    proxy?: string
  }): Promise<Result<{ message: string }>>
  githubLoginToken(token: string): Promise<Result<{ settings: SettingsView }>>
  githubLoginCli(): Promise<Result<{ settings: SettingsView }>>
  ensureGithubCli(): Promise<Result<{ version: string; source: 'system' | 'app' }>>
  onGithubEnv(callback: (progress: SyncProgress) => void): () => void
  githubLogout(): Promise<Result<{ settings: SettingsView }>>
  githubCreateRepo(name: string): Promise<Result<{ settings: SettingsView; url: string; commit: string; pageCount: number; pulled: number; conflicts: number }>>
  githubLinkRepo(fullName: string): Promise<Result<{ settings: SettingsView; url: string; commit: string; pageCount: number; pulled: number; conflicts: number }>>
  githubSync(): Promise<Result<{ url: string; commit: string; pageCount: number; pulled: number; conflicts: number }>>
  onGithubProgress(callback: (progress: SyncProgress) => void): () => void
  openExternal(url: string): Promise<Result<Record<string, never>>>
  exportMarkdown(input: { title: string; markdown: string }): Promise<Result<{ canceled: boolean; file?: string; images?: number }>>
  exportPdf(input: { title: string; html: string }): Promise<Result<{ canceled: boolean; file?: string }>>
  pathForFile(file: File): string
  readMarkdown(filePath: string): Promise<Result<{ path: string; name: string; body: string }>>
  importMarkdown(filePath: string): Promise<Result<{ page: PageData }>>
  saveMarkdown(input: { path: string; body: string }): Promise<Result<{ path: string; name: string }>>
  saveMarkdownAs(input: { body: string; suggestedName: string }): Promise<Result<{ canceled: boolean; path?: string; name?: string }>>
  saveExternalImage(payload: { base64: string; ext: string }): Promise<Result<{ path: string }>>
  onMarkdownOpen(callback: (filePath: string) => void): () => void
  takePendingMarkdown(): Promise<string>
  onUpdate(callback: (status: UpdateStatus) => void): () => void
  installUpdate(): Promise<Result<Record<string, never>>>
}
