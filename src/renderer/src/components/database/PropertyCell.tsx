import type { PropDef } from '../../../../shared/database'
import { displayImageSrc } from '../../editor/image'
import { useI18n } from '../../i18n'

export function PropertyCell({
  def,
  value,
  onChange,
}: {
  def: PropDef
  value: unknown
  onChange: (value: unknown) => void
}) {
  const { t } = useI18n()
  if (def.type === 'image') {
    const src = typeof value === 'string' ? value.trim() : ''
    return (
      <div className="db-image-cell">
        {src ? <img className="db-image-thumb" src={displayImageSrc(src)} alt="" /> : <span className="muted">{t('dbNoImage')}</span>}
        <div className="db-image-actions">
          <button
            type="button"
            className="quiet"
            onClick={() => {
              void window.zention.pickImage().then((result) => {
                if (result.ok && result.path) onChange(result.path)
              })
            }}
          >
            {t('dbPickImage')}
          </button>
          {src ? (
            <button type="button" className="quiet" onClick={() => onChange(undefined)}>
              {t('dbClearImage')}
            </button>
          ) : null}
        </div>
      </div>
    )
  }
  if (def.type === 'checkbox') {
    return (
      <input
        type="checkbox"
        checked={value === true}
        onChange={(event) => onChange(event.target.checked)}
      />
    )
  }
  if (def.type === 'select') {
    return (
      <select value={String(value ?? '')} onChange={(event) => onChange(event.target.value || undefined)}>
        <option value="">{t('dbEmpty')}</option>
        {(def.options ?? []).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    )
  }
  if (def.type === 'multiSelect') {
    const selected = Array.isArray(value) ? value.map(String) : []
    return (
      <select
        multiple
        value={selected}
        onChange={(event) => {
          const next = [...event.target.selectedOptions].map((option) => option.value)
          onChange(next.length ? next : undefined)
        }}
      >
        {(def.options ?? []).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    )
  }
  if (def.type === 'number') {
    return (
      <input
        type="number"
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(event) => {
          const text = event.target.value.trim()
          onChange(text === '' ? undefined : Number(text))
        }}
      />
    )
  }
  if (def.type === 'date') {
    return (
      <input
        type="date"
        value={String(value ?? '')}
        onChange={(event) => onChange(event.target.value || undefined)}
      />
    )
  }
  return (
    <input
      type="text"
      value={String(value ?? '')}
      onChange={(event) => onChange(event.target.value || undefined)}
    />
  )
}
