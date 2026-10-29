import type { PropDef } from '../../../../shared/database'
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
