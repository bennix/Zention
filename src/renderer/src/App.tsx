import { useCallback, useEffect, useRef, useState } from 'react'
import type { PageData, PageMeta, SettingsPatch, SettingsView, SyncProgress } from '../../shared/types'
import { call } from './call'
import { EditorPane, type EditorExport } from './components/EditorPane'
import { GithubDialog, SyncProgressView } from './components/GithubDialog'
import { SettingsDialog } from './components/SettingsDialog'
import { setExternalImages } from './editor/image'
import { flushNotes } from './flush'
import { setAppLocale, useI18n } from './i18n'

type ExternalDoc = {
  path: string
  name: string
  initial: string
  saved: string
  dirty: boolean
  revision: number
}

let pendingRequested = false

export default function App() {
  const [settings, setSettings] = useState<SettingsView | null>(null)
  const [pages, setPages] = useState<PageMeta[]>([])
  const [page, setPage] = useState<PageData | null>(null)
  const [title, setTitle] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [githubOpen, setGithubOpen] = useState(false)
  const [toast, setToast] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null)
  const [booting, setBooting] = useState(true)
  const [exportOpen, setExportOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const exportHandle = useRef<EditorExport | null>(null)
  const [external, setExternal] = useState<ExternalDoc | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const externalRef = useRef<ExternalDoc | null>(null)
  externalRef.current = external
  const saveExternalRef = useRef<() => void>(() => {})
  const saveAsRef = useRef<() => void>(() => {})
  const openMarkdownRef = useRef<(filePath: string) => void>(() => {})
  const importDroppedRef = useRef<(filePath: string) => void>(() => {})
  const dragDepth = useRef(0)
  const openingRef = useRef('')
  const { t, locale } = useI18n()

  const notify = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast((current) => (current === message ? '' : current)), 4200)
  }, [])

  const openPage = useCallback(async (id: string) => {
    const { page: next } = await call(window.zention.readPage(id))
    setPage(next)
    setTitle(next.title)
    localStorage.setItem('zention.page', id)
  }, [])

  const leaveExternal = useCallback(() => {
    if (externalRef.current?.dirty && !window.confirm(t('externalDirty'))) return false
    setExternalImages(false)
    setExternal(null)
    return true
  }, [t])

  useEffect(() => {
    void (async () => {
      try {
        const [{ settings: loaded }, { pages: listed }] = await Promise.all([
          call(window.zention.getSettings()),
          call(window.zention.listPages()),
        ])
        setSettings(loaded)
        setAppLocale(loaded.locale)
        setPages(listed)
        const saved = localStorage.getItem('zention.page')
        const id = listed.find((item) => item.id === saved)?.id ?? listed[0]?.id
        if (id) await openPage(id)
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error))
      } finally {
        setBooting(false)
      }
    })()
  }, [notify, openPage])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.key.toLowerCase() === 'n') {
        event.preventDefault()
        void create()
      }
      if (event.key === ',') {
        event.preventDefault()
        setSettingsOpen(true)
      }
      if (event.key.toLowerCase() === 's' && externalRef.current) {
        event.preventDefault()
        if (event.shiftKey) saveAsRef.current()
        else saveExternalRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  useEffect(() => {
    const label = external ? external.name : page ? title || t('untitled') : ''
    document.title = label ? `${label} — Zention` : 'Zention'
  }, [external, locale, page, t, title])

  useEffect(() => {
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files')
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      dragDepth.current += 1
      setDragOver(true)
    }
    const over = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }
    const leave = (event: DragEvent) => {
      if (!hasFiles(event)) return
      dragDepth.current -= 1
      if (dragDepth.current <= 0) {
        dragDepth.current = 0
        setDragOver(false)
      }
    }
    const drop = (event: DragEvent) => {
      dragDepth.current = 0
      setDragOver(false)
      const markdown = Array.from(event.dataTransfer?.files ?? []).find((file) => /\.(md|markdown)$/i.test(file.name))
      if (!markdown) return
      event.preventDefault()
      event.stopPropagation()
      const filePath = window.zention.pathForFile(markdown)
      if (!filePath) {
        notify(t('notMarkdown'))
        return
      }
      importDroppedRef.current(filePath)
    }
    window.addEventListener('dragenter', enter, true)
    window.addEventListener('dragover', over, true)
    window.addEventListener('dragleave', leave, true)
    window.addEventListener('drop', drop, true)
    return () => {
      window.removeEventListener('dragenter', enter, true)
      window.removeEventListener('dragover', over, true)
      window.removeEventListener('dragleave', leave, true)
      window.removeEventListener('drop', drop, true)
    }
  }, [notify, t])

  useEffect(() => window.zention.onMarkdownOpen((filePath) => openMarkdownRef.current(filePath)), [])

  useEffect(() => {
    if (pendingRequested) return
    pendingRequested = true
    void window.zention.takePendingMarkdown().then((filePath) => {
      if (filePath) openMarkdownRef.current(filePath)
    })
  }, [])

  useEffect(() => {
    return window.zention.onGithubProgress((next) => {
      setSyncProgress(next)
      if (next.percent >= 100) {
        window.setTimeout(() => {
          setSyncProgress((current) => (current?.text === next.text && current.percent === 100 ? null : current))
        }, 2500)
      }
    })
  }, [])

  const create = async () => {
    if (!leaveExternal()) return
    const { page: next } = await call(window.zention.createPage(t('untitled')))
    setPages((current) => [next, ...current.filter((item) => item.id !== next.id)])
    setPage(next)
    setTitle(next.title)
    localStorage.setItem('zention.page', next.id)
  }

  const saveBody = useCallback(
    (body: string) => {
      if (!page) return
      void window.zention.savePage(page.id, body).then((result) => {
        if (!result.ok) notify(result.error)
      })
    },
    [notify, page],
  )

  const commitTitle = async () => {
    if (!page) return
    const nextTitle = title.trim() || t('untitled')
    setTitle(nextTitle)
    const result = await window.zention.renamePage(page.id, nextTitle)
    if (!result.ok) {
      notify(result.error)
      return
    }
    setPages((current) => current.map((item) => (item.id === page.id ? result.page : item)))
    setPage((current) => (current ? { ...current, title: result.page.title } : current))
  }

  const remove = async (id: string) => {
    if (!window.confirm(t('deleteConfirm'))) return
    const result = await window.zention.deletePage(id)
    if (!result.ok) {
      notify(result.error)
      return
    }
    setPages(result.pages)
    if (!externalRef.current && page?.id === id) {
      const next = result.pages[0]
      if (next) await openPage(next.id)
    }
  }

  const sync = async () => {
    if (!settings?.githubUser || !settings.githubRepo) {
      setGithubOpen(true)
      notify(t('syncNeedLogin'))
      return
    }
    if (syncing) return
    setSyncing(true)
    setSyncProgress({ percent: 0, text: t('syncReady') })
    try {
      await flushNotes()
      const result = await window.zention.githubSync()
      if (!result.ok) {
        setSyncProgress(null)
        notify(result.error)
      } else {
        const listed = await window.zention.listPages()
        if (listed.ok) {
          setPages(listed.pages)
          const currentId = page?.id
          if (!externalRef.current && currentId && listed.pages.some((item) => item.id === currentId)) {
            const fresh = await window.zention.readPage(currentId)
            if (fresh.ok) {
              setPage(fresh.page)
              setTitle(fresh.page.title)
            }
          } else if (!externalRef.current && listed.pages[0]) {
            await openPage(listed.pages[0].id)
          }
        }
        const extra = [
          result.pulled ? t('pulled', { count: result.pulled }) : '',
          result.conflicts ? t('merged', { count: result.conflicts }) : '',
        ].filter(Boolean)
        notify([t('syncDone', { count: result.pageCount }), ...extra].join(' · '))
      }
    } catch (error) {
      setSyncProgress(null)
      notify(error instanceof Error ? error.message : String(error))
    } finally {
      setSyncing(false)
    }
  }

  const pageTitle = () => (external ? external.name.replace(/\.(md|markdown)$/i, '') : title.trim() || t('untitled'))

  const openWorkspace = async (id: string) => {
    if (!leaveExternal()) return
    await openPage(id)
  }

  const openMarkdownFile = async (filePath: string) => {
    const current = externalRef.current
    if (current?.path === filePath && !current.dirty) return
    if (openingRef.current === filePath) return
    if (current?.dirty && !window.confirm(t('externalDirty'))) return
    openingRef.current = filePath
    try {
      const result = await window.zention.readMarkdown(filePath)
      if (!result.ok) {
        notify(result.error)
        return
      }
      setExternalImages(true)
      setExternal({
        path: result.path,
        name: result.name,
        initial: result.body,
        saved: result.body,
        dirty: false,
        revision: Date.now(),
      })
    } finally {
      if (openingRef.current === filePath) openingRef.current = ''
    }
  }

  const markExternalDirty = (body: string) => {
    setExternal((current) => {
      if (!current) return current
      const dirty = body !== current.saved
      return dirty === current.dirty ? current : { ...current, dirty }
    })
  }

  const saveExternalFile = async () => {
    const doc = externalRef.current
    if (!doc) return
    const body = exportHandle.current?.markdown() ?? doc.saved
    const result = await window.zention.saveMarkdown({ path: doc.path, body })
    if (!result.ok) {
      notify(result.error)
      return
    }
    setExternal((current) => (current ? { ...current, path: result.path, name: result.name, saved: body, dirty: false } : current))
    notify(t('savedFile'))
  }

  const saveExternalAs = async () => {
    const doc = externalRef.current
    if (!doc) return
    const body = exportHandle.current?.markdown() ?? doc.saved
    const result = await window.zention.saveMarkdownAs({ body, suggestedName: doc.name })
    if (!result.ok) {
      notify(result.error)
      return
    }
    if (result.canceled || !result.path || !result.name) return
    setExternalImages(true)
    setExternal({
      path: result.path,
      name: result.name,
      initial: body,
      saved: body,
      dirty: false,
      revision: Date.now(),
    })
    notify(t('savedAs'))
  }

  const importDropped = async (filePath: string) => {
    if (openingRef.current === filePath) return
    if (externalRef.current?.dirty && !window.confirm(t('externalDirty'))) return
    openingRef.current = filePath
    try {
      const result = await window.zention.importMarkdown(filePath)
      if (!result.ok) {
        notify(result.error)
        return
      }
      setExternalImages(false)
      setExternal(null)
      setPages((current) => [result.page, ...current.filter((item) => item.id !== result.page.id)])
      setPage(result.page)
      setTitle(result.page.title)
      localStorage.setItem('zention.page', result.page.id)
      notify(t('importedPage'))
    } finally {
      if (openingRef.current === filePath) openingRef.current = ''
    }
  }

  openMarkdownRef.current = (filePath) => {
    void openMarkdownFile(filePath)
  }
  importDroppedRef.current = (filePath) => {
    void importDropped(filePath)
  }
  saveExternalRef.current = () => {
    void saveExternalFile()
  }
  saveAsRef.current = () => {
    void saveExternalAs()
  }

  const exportMarkdown = async () => {
    if (exporting) return
    setExportOpen(false)
    setExporting(true)
    try {
      await flushNotes()
      const markdown = exportHandle.current?.markdown() ?? page?.body ?? ''
      const result = await window.zention.exportMarkdown({ title: pageTitle(), markdown })
      if (!result.ok) notify(result.error)
      else if (!result.canceled) notify(t('exportedMd', { count: result.images ?? 0 }))
    } finally {
      setExporting(false)
    }
  }

  const exportPdf = async () => {
    if (exporting) return
    setExportOpen(false)
    setExporting(true)
    try {
      await flushNotes()
      const html = exportHandle.current?.html() ?? ''
      const result = await window.zention.exportPdf({ title: pageTitle(), html })
      if (!result.ok) notify(result.error)
      else if (!result.canceled) notify(t('exportedPdf'))
    } finally {
      setExporting(false)
    }
  }

  const saveSettings = async (patch: SettingsPatch) => {
    const result = await window.zention.updateSettings(patch)
    if (!result.ok) {
      notify(result.error)
      return
    }
    setSettings(result.settings)
    setSettingsOpen(false)
    notify(t('settingsSaved'))
  }

  const changeLocale = async (value: string) => {
    setAppLocale(value)
    const result = await window.zention.updateSettings({ locale: value })
    if (!result.ok) {
      notify(result.error)
      return
    }
    setSettings(result.settings)
  }

  if (booting || !settings) return <div className="boot">{t('boot')}</div>

  return (
    <div className="app">
      <aside>
        <div className="brand">Zention</div>
        <button type="button" className="new-page" onClick={() => void create()}>
          {t('newPage')}
        </button>
        <nav>
          {external ? (
            <div className="page-row active">
              <button type="button">{external.name}</button>
            </div>
          ) : null}
          {pages.map((item) => (
            <div key={item.id} className={!external && item.id === page?.id ? 'page-row active' : 'page-row'}>
              <button type="button" onClick={() => void openWorkspace(item.id)}>
                {item.title || t('untitled')}
              </button>
              <button type="button" className="icon" onClick={() => void remove(item.id)} aria-label={t('delete')}>
                ×
              </button>
            </div>
          ))}
        </nav>
        <div className="side-foot">
          <button type="button" onClick={() => setGithubOpen(true)}>
            {settings.githubUser ? `@${settings.githubUser.login}` : t('githubLogin')}
          </button>
          <button type="button" onClick={() => setSettingsOpen(true)}>
            {t('settings')}
          </button>
        </div>
      </aside>
      <main>
        {external || page ? (
          <>
            <div className="sheet">
              {!settings.hasApiKey && (
                <div className="banner">
                  {t('needKey')}
                  <button type="button" onClick={() => void window.zention.openExternal(settings.inviteUrl)}>
                    {t('registerInvite')}
                  </button>
                  <button type="button" onClick={() => setSettingsOpen(true)}>
                    {t('openSettings')}
                  </button>
                </div>
              )}
              <div className="sheet-bar">
                {external ? (
                  <div className="page-title file-name">
                    <span>{external.name}</span>
                    {external.dirty ? <em className="dirty">{t('unsaved')}</em> : null}
                  </div>
                ) : (
                  <input
                    className="page-title"
                    value={title}
                    placeholder={t('noTitle')}
                    onChange={(event) => setTitle(event.target.value)}
                    onBlur={() => void commitTitle()}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
                    }}
                  />
                )}
                {external ? (
                  <>
                    <button type="button" onClick={() => void saveExternalFile()} disabled={!external.dirty}>
                      {t('save')}
                    </button>
                    <button type="button" className="save-as" onClick={() => void saveExternalAs()}>
                      {t('saveAs')}
                    </button>
                  </>
                ) : null}
                <div className="export-wrap">
                  <button type="button" className="export-btn" onClick={() => setExportOpen((open) => !open)} disabled={exporting || syncing}>
                    {exporting ? t('exporting') : t('exportMenu')}
                  </button>
                  {exportOpen ? (
                    <>
                      <button type="button" className="scrim" aria-label={t('close')} onClick={() => setExportOpen(false)} />
                      <div className="pop export-pop">
                        <button type="button" onClick={() => void exportMarkdown()}>
                          {t('exportMd')}
                        </button>
                        <button type="button" onClick={() => void exportPdf()}>
                          {t('exportPdf')}
                        </button>
                      </div>
                    </>
                  ) : null}
                </div>
                <button type="button" onClick={() => void sync()} disabled={syncing || exporting}>
                  {syncing ? t('syncing', { percent: syncProgress?.percent ?? 0 }) : t('sync')}
                </button>
              </div>
              {syncProgress ? <SyncProgressView progress={syncProgress} /> : null}
              {external ? (
                <EditorPane
                  key={`file:${external.path}:${external.revision}`}
                  pageId=""
                  external
                  markdown={external.initial}
                  onChange={markExternalDirty}
                  onToast={notify}
                  onNeedKey={() => setSettingsOpen(true)}
                  exportHandle={exportHandle}
                />
              ) : page ? (
                <EditorPane
                  key={`${page.id}:${page.updatedAt}`}
                  pageId={page.id}
                  markdown={page.body}
                  onChange={saveBody}
                  onToast={notify}
                  onNeedKey={() => setSettingsOpen(true)}
                  exportHandle={exportHandle}
                />
              ) : null}
            </div>
          </>
        ) : (
          <div className="boot">{t('noPage')}</div>
        )}
      </main>
      {settingsOpen && (
        <SettingsDialog settings={settings} onClose={() => setSettingsOpen(false)} onSave={saveSettings} onLocale={(value) => void changeLocale(value)} />
      )}
      {githubOpen && (
        <GithubDialog
          settings={settings}
          syncing={syncing}
          onSync={() => void sync()}
          onClose={() => setGithubOpen(false)}
          onChange={setSettings}
          onToast={notify}
        />
      )}
      {toast ? <div className="toast">{toast}</div> : null}
      {dragOver ? <div className="drop-mask">{t('dropMd')}</div> : null}
    </div>
  )
}
