import { useEffect, useState } from 'react'
import type { SettingsView, SyncProgress } from '../../../shared/types'
import { flushNotes } from '../flush'
import { useI18n } from '../i18n'

export function SyncProgressView({ progress }: { progress: SyncProgress }) {
  return (
    <div className="sync-progress" role="status" aria-live="polite">
      <div className="sync-progress-track">
        <div style={{ width: `${progress.percent}%` }} />
      </div>
      <div className="sync-progress-meta">
        <span>{progress.text}</span>
        <strong>{progress.percent}%</strong>
      </div>
    </div>
  )
}

export function GithubDialog({
  settings,
  syncing,
  onSync,
  onClose,
  onChange,
  onToast,
}: {
  settings: SettingsView
  syncing: boolean
  onSync: () => void
  onClose: () => void
  onChange: (settings: SettingsView) => void
  onToast: (message: string) => void
}) {
  const [token, setToken] = useState('')
  const [repoName, setRepoName] = useState('zention-notes')
  const [fullName, setFullName] = useState(settings.githubRepo ? `${settings.githubRepo.owner}/${settings.githubRepo.name}` : '')
  const [busy, setBusy] = useState('')
  const [progress, setProgress] = useState<SyncProgress | null>(null)
  const [envText, setEnvText] = useState('')
  const { t, locale } = useI18n()

  useEffect(() => {
    let stop = false
    setEnvText(t('ghEnvLooking'))
    const unsub = window.zention.onGithubEnv((next) => {
      if (!stop) setEnvText(next.text)
    })
    void window.zention.ensureGithubCli().then((result) => {
      if (stop) return
      if (!result.ok) {
        setEnvText(result.error)
        return
      }
      setEnvText(t(result.source === 'app' ? 'ghEnvApp' : 'ghEnvSystem', { version: result.version }))
    })
    return () => {
      stop = true
      unsub()
    }
  }, [locale, t])

  useEffect(() => {
    return window.zention.onGithubProgress((next) => {
      setProgress(next)
      if (next.percent >= 100) {
        window.setTimeout(() => {
          setProgress((current) => (current?.text === next.text && current.percent === 100 ? null : current))
        }, 2500)
      }
    })
  }, [])

  const confirmCreate = () => {
    if (!settings.githubUser || busy || !repoName.trim()) return
    void run('create', async () => {
      await flushNotes()
      const result = await window.zention.githubCreateRepo(repoName)
      if (!result.ok) throw new Error(result.error)
      onChange(result.settings)
      onToast(`${t('repoCreated', { count: result.pageCount, url: result.url })}${result.conflicts ? t('mergedTail', { count: result.conflicts }) : ''}`)
    })
  }

  const run = async (label: string, task: () => Promise<void>) => {
    setBusy(label)
    setProgress({ percent: 0, text: t('syncReady') })
    try {
      await task()
    } catch (error) {
      setProgress(null)
      onToast(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault()
          confirmCreate()
        }}
      >
        <header>
          <h2>GitHub</h2>
          <button type="button" onClick={onClose}>
            {t('close')}
          </button>
        </header>
        {envText ? <p className="notice">{envText}</p> : null}
        {settings.githubUser ? (
          <div className="user-card">
            {settings.githubUser.avatarUrl ? <img src={settings.githubUser.avatarUrl} alt="" /> : null}
            <div>
              <strong>{settings.githubUser.name || settings.githubUser.login}</strong>
              <span>@{settings.githubUser.login}</span>
            </div>
            <button
              type="button"
              onClick={() =>
                void run('logout', async () => {
                  const result = await window.zention.githubLogout()
                  if (!result.ok) throw new Error(result.error)
                  onChange(result.settings)
                })
              }
            >
              {t('logout')}
            </button>
          </div>
        ) : (
          <>
            <p className="hint">{t('ghHint')}</p>
            <label>
              Personal Access Token
              <textarea value={token} rows={3} placeholder="github_pat_… 或 ghp_…" onChange={(event) => setToken(event.target.value)} />
            </label>
            <div className="row">
              <button type="button" className="link" onClick={() => void window.zention.openExternal('https://github.com/settings/tokens/new?scopes=repo&description=Zention')}>
                {t('createToken')}
              </button>
            </div>
            <div className="row">
              <button
                type="button"
                className="primary"
                disabled={!!busy}
                onClick={() =>
                  void run('login', async () => {
                    const result = await window.zention.githubLoginToken(token)
                    if (!result.ok) throw new Error(result.error)
                    onChange(result.settings)
                    onToast(t('loggedIn', { name: result.settings.githubUser?.login ?? '' }))
                  })
                }
              >
                {t('loginToken')}
              </button>
              <button
                type="button"
                disabled={!!busy}
                onClick={() =>
                  void run('gh', async () => {
                    const result = await window.zention.githubLoginCli()
                    if (!result.ok) throw new Error(result.error)
                    onChange(result.settings)
                    onToast(t('loggedInGh', { name: result.settings.githubUser?.login ?? '' }))
                  })
                }
              >
                {t('loginGh')}
              </button>
            </div>
          </>
        )}
        {settings.githubUser && (
          <>
            <label>
              {t('newRepo')}
              <input
                value={repoName}
                onChange={(event) => setRepoName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    confirmCreate()
                  }
                }}
              />
              <button type="button" className="primary create-repo" disabled={!!busy || syncing || !repoName.trim()} onClick={confirmCreate}>
                {busy === 'create' ? t('creating', { percent: progress?.percent ?? 0 }) : t('createRepo')}
              </button>
            </label>
            <label>
              {t('bindExisting')}
              <input value={fullName} placeholder="owner/repo" onChange={(event) => setFullName(event.target.value)} />
              <button
                type="button"
                className="create-repo"
                disabled={!!busy || syncing || !fullName.trim()}
                onClick={() =>
                  void run('bind', async () => {
                    await flushNotes()
                    const result = await window.zention.githubLinkRepo(fullName)
                    if (!result.ok) throw new Error(result.error)
                    onChange(result.settings)
                    onToast(`${t('repoBound', { count: result.pageCount, url: result.url })}${result.conflicts ? t('mergedTail', { count: result.conflicts }) : ''}`)
                  })
                }
              >
                {busy === 'bind' ? t('binding', { percent: progress?.percent ?? 0 }) : t('bindSync')}
              </button>
            </label>
            {settings.githubRepo && (
              <>
                <p className="notice">
                  {t('syncTarget', { repo: `${settings.githubRepo.owner}/${settings.githubRepo.name}`, branch: settings.githubRepo.branch })}
                </p>
                <button
                  type="button"
                  className="primary create-repo"
                  disabled={!!busy || syncing}
                  onClick={() => {
                    setProgress({ percent: 0, text: t('syncReady') })
                    onSync()
                  }}
                >
                  {syncing ? t('syncing', { percent: progress?.percent ?? 0 }) : t('sync')}
                </button>
              </>
            )}
            {progress ? <SyncProgressView progress={progress} /> : null}
          </>
        )}
      </form>
    </div>
  )
}
