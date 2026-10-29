import { useState } from 'react'
import {
  buildDbAiUser,
  parseDbAi,
  systemFor,
  templateText,
  templatesFor,
  type DbAiContext,
  type DbAiMode,
  type DbAiResult,
  type DbAiScope,
} from '../../../../shared/databaseAi'
import { useI18n } from '../../i18n'

export function DatabaseAiDialog({
  scope,
  context,
  onClose,
  onBlank,
  onApply,
  onNeedKey,
}: {
  scope: DbAiScope
  context?: DbAiContext
  onClose: () => void
  onBlank?: () => void
  onApply: (result: DbAiResult) => Promise<void> | void
  onNeedKey: () => void
}) {
  const { t, locale } = useI18n()
  const templates = templatesFor(scope)
  const initialMode: DbAiMode = scope === 'create' ? 'create' : scope === 'filters' ? 'filters' : 'schema'
  const [mode, setMode] = useState<DbAiMode>(initialMode)
  const [activeId, setActiveId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const title = scope === 'create' ? t('dbAiCreate') : scope === 'filters' ? t('dbAiFilter') : t('dbAiAssist')

  const run = async () => {
    const ask = prompt.trim()
    if (!ask) {
      setError(t('dbAiNeedPrompt'))
      return
    }
    setBusy(true)
    setError('')
    try {
      const response = await window.zention.aiComplete({
        system: systemFor(mode),
        user: buildDbAiUser(ask, context),
      })
      if (!response.ok) {
        if (response.error.includes('API Key')) onNeedKey()
        setError(response.error)
        return
      }
      const parsed = parseDbAi(mode, response.content, context, ask)
      await onApply(parsed)
      onClose()
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      setError(message === 'dbAiBadJson' ? t('dbAiBadJson') : message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={() => {
        if (!busy) onClose()
      }}
    >
      <div className="modal" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <h2>{title}</h2>
          <button type="button" onClick={onClose} disabled={busy}>
            {t('close')}
          </button>
        </header>
        <div className="db-ai-chips">
          {templates.map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.id === activeId ? 'active' : ''}
              disabled={busy}
              onClick={() => {
                setActiveId(item.id)
                setMode(item.mode)
                setPrompt(templateText(item, locale))
                setError('')
              }}
            >
              {t(item.label)}
            </button>
          ))}
        </div>
        <label>
          {t('dbAiPrompt')}
          <textarea
            className="db-ai-prompt"
            value={prompt}
            rows={5}
            placeholder={t('dbAiPromptPh')}
            disabled={busy}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>
        {error ? <p className="db-ai-error">{error}</p> : null}
        <footer className={onBlank ? 'spread' : ''}>
          {onBlank ? (
            <button type="button" onClick={onBlank} disabled={busy}>
              {t('dbAiBlank')}
            </button>
          ) : (
            <span />
          )}
          <span className="inline">
            <button type="button" onClick={onClose} disabled={busy}>
              {t('cancel')}
            </button>
            <button type="button" onClick={() => void run()} disabled={busy || !prompt.trim()}>
              {busy ? t('dbAiWorking') : t('dbAiRun')}
            </button>
          </span>
        </footer>
      </div>
    </div>
  )
}
