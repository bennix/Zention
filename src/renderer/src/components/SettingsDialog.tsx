import { useEffect, useState } from 'react'
import { LOCALES } from '../../../shared/i18n'
import type { AssetScanProgress, SettingsView, UpdateStatus } from '../../../shared/types'
import { useI18n } from '../i18n'

export function SettingsDialog({
  settings,
  version,
  update,
  onCheckUpdate,
  onInstallUpdate,
  onClose,
  onSave,
  onLocale,
  onOpenGithub,
  onGithubChange,
  onToast,
  onFlushNotes,
}: {
  settings: SettingsView
  version: string
  update: UpdateStatus | null
  onCheckUpdate: () => void
  onInstallUpdate: () => void
  onClose: () => void
  onLocale: (locale: string) => void
  onOpenGithub: () => void
  onGithubChange: (settings: SettingsView) => void
  onToast: (message: string) => void
  onFlushNotes: () => Promise<void>
  onSave: (
    patch: {
      apiKey?: string
      clearApiKey?: boolean
      baseUrl: string
      chatModels: string[]
      chatModel: string
      imageModels: string[]
      imageModel: string
      proxy: string
    },
    close?: boolean,
  ) => Promise<void>
}) {
  const { t, locale } = useI18n()
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl)
  const [proxy, setProxy] = useState(settings.proxy)
  const [detected, setDetected] = useState<{ url: string; kind: 'direct' | 'http' | 'socks'; endpoint: string } | null>(null)
  const [detectError, setDetectError] = useState('')
  const [detecting, setDetecting] = useState(false)
  const [chatModels, setChatModels] = useState(settings.chatModels)
  const [chatModel, setChatModel] = useState(settings.chatModel)
  const [imageModels, setImageModels] = useState(settings.imageModels)
  const [imageModel, setImageModel] = useState(settings.imageModel)
  const [chatDraft, setChatDraft] = useState('')
  const [imageDraft, setImageDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState('')
  const [reports, setReports] = useState<Record<string, { ok: boolean; text: string }>>({})
  const [githubBusy, setGithubBusy] = useState(false)
  const [assetBusy, setAssetBusy] = useState<'scan' | 'clean' | ''>('')
  const [assetReport, setAssetReport] = useState<{ unused: string[]; total: number; used: number } | null>(null)
  const [assetProgress, setAssetProgress] = useState<AssetScanProgress | null>(null)

  const runTest = async (kind: 'key' | 'chat' | 'image', model?: string) => {
    const id = kind === 'key' ? 'key' : `${kind}:${model}`
    setTesting(id)
    const result = await window.zention.testConnection({
      kind,
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      baseUrl,
      model,
      proxy,
    })
    setReports((current) => ({
      ...current,
      [id]: result.ok ? { ok: true, text: result.message } : { ok: false, text: result.error },
    }))
    setTesting('')
  }

  const detect = async () => {
    setDetecting(true)
    const result = await window.zention.detectProxy()
    setDetecting(false)
    if (!result.ok) {
      setDetectError(result.error)
      setDetected(null)
      return
    }
    setDetectError('')
    setProxy(result.url)
    setDetected({ url: result.url, kind: result.kind, endpoint: result.endpoint })
  }
  const proxyNote = detectError
    ? detectError
    : detected
      ? detected.url
        ? t('proxyFound', {
            kind: detected.kind === 'socks' ? t('proxySocks') : t('proxyHttp'),
            endpoint: detected.endpoint,
          })
        : t('proxyNone')
      : ''

  useEffect(() => {
    if (settings.proxyConfigured) return
    void detect()
  }, [settings.proxyConfigured])

  useEffect(() => window.zention.onAssetProgress(setAssetProgress), [])

  const reveal = async () => {
    const result = await window.zention.revealSecret('apiKey')
    if (result.ok) setApiKey(result.value)
  }

  const settingsPatch = (nextChat = chatModels) => ({
    ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    baseUrl,
    chatModels: nextChat,
    chatModel,
    imageModels,
    imageModel,
    proxy,
  })

  const persist = (close: boolean) => {
    setSaving(true)
    void onSave(settingsPatch(), close).finally(() => setSaving(false))
  }

  const add = (kind: 'chat' | 'image') => {
    const draft = (kind === 'chat' ? chatDraft : imageDraft).trim()
    if (!draft) return
    if (kind === 'chat') {
      const next = chatModels.includes(draft) ? chatModels : [...chatModels, draft]
      setChatModels(next)
      setChatModel(draft)
      setChatDraft('')
    } else {
      const next = imageModels.includes(draft) ? imageModels : [...imageModels, draft]
      setImageModels(next)
      setImageModel(draft)
      setImageDraft('')
    }
  }

  const remove = (kind: 'chat' | 'image', name: string) => {
    if (kind === 'chat') {
      if (chatModels.length <= 1) return
      const next = chatModels.filter((item) => item !== name)
      setChatModels(next)
      if (chatModel === name) setChatModel(next[0] ?? '')
    } else {
      if (imageModels.length <= 1) return
      const next = imageModels.filter((item) => item !== name)
      setImageModels(next)
      if (imageModel === name) setImageModel(next[0] ?? '')
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault()
          persist(true)
        }}
      >
        <header>
          <h2>{t('settings')}</h2>
          <button type="button" onClick={onClose}>
            {t('close')}
          </button>
        </header>
        <section>
          <h3>{t('updateSection')}</h3>
          <p className="hint">{t('updateVersion', { version: version || '—' })}</p>
          {update?.phase === 'checking' ? <p className="hint">{t('updateChecking')}</p> : null}
          {update?.phase === 'current' ? <p className="test-ok">{t('updateCurrent', { version: update.version || version })}</p> : null}
          {update?.phase === 'available' ? <p className="hint">{t('updateAvailable', { version: update.version ?? '' })}</p> : null}
          {update?.phase === 'progress' ? <p className="hint">{t('updateProgress', { percent: update.percent ?? 0 })}</p> : null}
          {update?.phase === 'downloaded' ? <p className="test-ok">{t('updateReady', { version: update.version ?? '' })}</p> : null}
          {update?.phase === 'error' ? <p className="test-bad">{t('updateError', { detail: update.message ?? '' })}</p> : null}
          <div className="row">
            <button type="button" onClick={onCheckUpdate} disabled={update?.phase === 'checking' || update?.phase === 'progress'}>
              {update?.phase === 'checking' ? t('updateChecking') : t('updateCheck')}
            </button>
            {update?.phase === 'downloaded' ? (
              <button type="button" className="primary" onClick={onInstallUpdate}>
                {t('updateRestart')}
              </button>
            ) : null}
          </div>
        </section>
        <section>
          <h3>{t('assetsSection')}</h3>
          <p className="hint">{t('assetsHint')}</p>
          {assetReport ? (
            <p className={assetReport.unused.length ? 'hint' : 'test-ok'}>
              {assetReport.unused.length
                ? t('assetsFound', {
                    count: assetReport.unused.length,
                    total: assetReport.total,
                    used: assetReport.used,
                  })
                : t('assetsNone', { total: assetReport.total })}
            </p>
          ) : null}
          {assetBusy && assetProgress ? (
            <div className="sync-progress">
              <div className="sync-progress-track">
                <div
                  style={{
                    width: `${assetProgress.total ? Math.round((assetProgress.done / assetProgress.total) * 100) : 0}%`,
                  }}
                />
              </div>
              <div className="sync-progress-meta">
                <span>
                  {assetProgress.phase === 'pages'
                    ? t('assetsScanPages', { done: assetProgress.done, total: assetProgress.total })
                    : assetProgress.phase === 'assets'
                      ? t('assetsScanFiles', { done: assetProgress.done, total: assetProgress.total })
                      : t('assetsTrashing', { done: assetProgress.done, total: assetProgress.total })}
                </span>
                <strong>
                  {t(assetProgress.phase === 'pages' ? 'assetsSpeedPages' : 'assetsSpeedFiles', {
                    speed: assetProgress.perSecond,
                  })}
                </strong>
              </div>
            </div>
          ) : null}
          <div className="row">
            <button
              type="button"
              disabled={Boolean(assetBusy)}
              onClick={() => {
                void (async () => {
                  setAssetBusy('scan')
                  setAssetProgress(null)
                  await onFlushNotes()
                  const result = await window.zention.listUnusedAssets()
                  setAssetBusy('')
                  if (!result.ok) {
                    onToast(result.error)
                    return
                  }
                  setAssetReport({ unused: result.unused, total: result.total, used: result.used })
                })()
              }}
            >
              {assetBusy === 'scan' ? t('assetsScanning') : t('assetsScan')}
            </button>
            <button
              type="button"
              disabled={Boolean(assetBusy) || !assetReport?.unused.length}
              onClick={() => {
                if (!assetReport?.unused.length) return
                if (!window.confirm(t('assetsConfirm', { count: assetReport.unused.length }))) return
                void (async () => {
                  setAssetBusy('clean')
                  setAssetProgress(null)
                  await onFlushNotes()
                  const result = await window.zention.cleanUnusedAssets()
                  setAssetBusy('')
                  if (!result.ok) {
                    onToast(result.error)
                    return
                  }
                  setAssetReport({ unused: [], total: result.kept, used: result.kept })
                  onToast(t('assetsCleaned', { count: result.deleted.length, kept: result.kept }))
                })()
              }}
            >
              {assetBusy === 'clean' ? t('assetsCleaning') : t('assetsClean')}
            </button>
          </div>
        </section>
        <label>
          {t('language')}
          <select value={locale} onChange={(event) => onLocale(event.target.value)}>
            {LOCALES.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          ZenMux API Key
          <div className="inline">
            <input type="password" value={apiKey} placeholder={settings.hasApiKey ? t('apiKeySavedPh') : t('apiKeyEmptyPh')} onChange={(event) => setApiKey(event.target.value)} />
            <button type="button" onClick={() => void reveal()}>
              {t('show')}
            </button>
            <button type="button" className="test-btn" disabled={!!testing} onClick={() => void runTest('key')}>
              {testing === 'key' ? t('testing') : t('testKey')}
            </button>
          </div>
        </label>
        {reports.key ? <p className={reports.key.ok ? 'test-ok' : 'test-bad'}>{reports.key.text}</p> : null}
        {!settings.hasApiKey && (
          <p className="notice">
            {t('noKey')}
            <button type="button" className="link" onClick={() => void window.zention.openExternal(settings.inviteUrl)}>
              {settings.inviteUrl}
            </button>
          </p>
        )}
        {settings.hasApiKey && (
          <p className="notice">
            {t('keySaved')}
            <button type="button" className="link" onClick={() => void window.zention.openExternal(settings.inviteUrl)}>
              {settings.inviteUrl}
            </button>
          </p>
        )}
        <label>
          Base URL
          <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
        </label>
        <p className="hint">{t('baseHint')}</p>
        <label>
          {t('proxy')}
          <div className="inline">
            <input value={proxy} placeholder="127.0.0.1:7890" onChange={(event) => setProxy(event.target.value)} />
            <button type="button" className="test-btn" disabled={detecting} onClick={() => void detect()}>
              {detecting ? t('detecting') : t('detectProxy')}
            </button>
          </div>
        </label>
        <p className="hint">{proxyNote || t('proxyHint')}</p>
        <ModelList
          title={t('chatModels')}
          models={chatModels}
          current={chatModel}
          draft={chatDraft}
          onDraft={setChatDraft}
          onAdd={() => add('chat')}
          onPick={setChatModel}
          onRemove={(name) => remove('chat', name)}
          onTest={(name) => void runTest('chat', name)}
          testing={testing}
          reports={reports}
          kind="chat"
        />
        <ModelList
          title={t('imageModels')}
          models={imageModels}
          current={imageModel}
          draft={imageDraft}
          onDraft={setImageDraft}
          onAdd={() => add('image')}
          onPick={setImageModel}
          onRemove={(name) => remove('image', name)}
          onTest={(name) => void runTest('image', name)}
          testing={testing}
          reports={reports}
          kind="image"
          note={t('imageNote')}
        />
        <section>
          <h3>{t('ghSection')}</h3>
          {settings.githubUser ? (
            <div className="user-card">
              {settings.githubUser.avatarUrl ? <img src={settings.githubUser.avatarUrl} alt="" /> : null}
              <div>
                <strong>{settings.githubUser.name || settings.githubUser.login}</strong>
                <span>@{settings.githubUser.login}</span>
              </div>
              <button
                type="button"
                disabled={githubBusy}
                onClick={() => {
                  setGithubBusy(true)
                  void window.zention.githubLogout().then((result) => {
                    setGithubBusy(false)
                    if (!result.ok) {
                      onToast(result.error)
                      return
                    }
                    onGithubChange(result.settings)
                  })
                }}
              >
                {t('logout')}
              </button>
            </div>
          ) : (
            <p className="hint">{t('ghNoAccount')}</p>
          )}
          <p className="hint">
            {settings.githubRepo
              ? t('syncTarget', { repo: `${settings.githubRepo.owner}/${settings.githubRepo.name}`, branch: settings.githubRepo.branch })
              : t('ghNoRepo')}
          </p>
          <div className="row">
            <button type="button" onClick={onOpenGithub}>
              {t('ghManage')}
            </button>
          </div>
        </section>
        <footer>
          {settings.hasApiKey && (
            <button
              type="button"
              onClick={() => {
                setApiKey('')
                setSaving(true)
                const patch = settingsPatch()
                delete patch.apiKey
                void onSave({ ...patch, clearApiKey: true }, true).finally(() => setSaving(false))
              }}
            >
              {t('clearKey')}
            </button>
          )}
          <button type="submit" className="primary" disabled={saving}>
            {saving ? t('saving') : t('save')}
          </button>
        </footer>
      </form>
    </div>
  )
}

function ModelList({
  title,
  models,
  current,
  draft,
  onDraft,
  onAdd,
  onPick,
  onRemove,
  onTest,
  testing,
  reports,
  kind,
  note,
}: {
  title: string
  models: string[]
  current: string
  draft: string
  onDraft: (value: string) => void
  onAdd: () => void
  onPick: (value: string) => void
  onRemove: (value: string) => void
  onTest: (value: string) => void
  testing: string
  reports: Record<string, { ok: boolean; text: string }>
  kind: 'chat' | 'image'
  note?: string
}) {
  const { t } = useI18n()
  return (
    <section>
      <h3>{title}</h3>
      {note ? <p className="hint">{note}</p> : null}
      <ul className="model-list">
        {models.map((model) => {
          const report = reports[`${kind}:${model}`]
          const busy = testing === `${kind}:${model}`
          return (
            <li key={model}>
              <button type="button" className={model === current ? 'current' : ''} onClick={() => onPick(model)}>
                {model}
                {model === current ? t('currentMark') : ''}
              </button>
              <button type="button" className="test-btn" disabled={!!testing} onClick={() => onTest(model)}>
                {busy ? t('testing') : t('test')}
              </button>
              <button type="button" onClick={() => onRemove(model)} disabled={models.length <= 1 || !!testing}>
                {t('remove')}
              </button>
              {report ? <p className={report.ok ? 'test-ok' : 'test-bad'}>{report.text}</p> : null}
            </li>
          )
        })}
      </ul>
      <div className="inline">
        <input value={draft} placeholder={t('addModelPh')} onChange={(event) => onDraft(event.target.value)} />
        <button type="button" onClick={onAdd}>
          {t('add')}
        </button>
      </div>
    </section>
  )
}
