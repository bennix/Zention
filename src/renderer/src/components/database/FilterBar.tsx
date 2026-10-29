import type { DbFilter, PropDef } from '../../../../shared/database'
import { useI18n } from '../../i18n'

export function FilterBar({
  schema,
  filters,
  onChange,
  onAskAi,
}: {
  schema: PropDef[]
  filters: DbFilter[]
  onChange: (filters: DbFilter[]) => void
  onAskAi: () => void
}) {
  const { t } = useI18n()
  const add = () => {
    const prop = schema[0]
    if (!prop) return
    onChange([...filters, { propId: prop.id, op: 'contains', value: '' }])
  }

  return (
    <div className="db-filters">
      {filters.map((filter, index) => {
        const prop = schema.find((item) => item.id === filter.propId)
        return (
          <div key={`${filter.propId}-${index}`} className="db-filter-row">
            <select
              value={filter.propId}
              onChange={(event) => {
                const next = [...filters]
                next[index] = { ...filter, propId: event.target.value }
                onChange(next)
              }}
            >
              {schema.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <select
              value={filter.op}
              onChange={(event) => {
                const next = [...filters]
                next[index] = { ...filter, op: event.target.value as DbFilter['op'] }
                onChange(next)
              }}
            >
              <option value="contains">{t('dbFilterContains')}</option>
              <option value="equals">{t('dbFilterEquals')}</option>
              <option value="isEmpty">{t('dbFilterEmpty')}</option>
            </select>
            {filter.op !== 'isEmpty' ? (
              prop?.type === 'select' && prop.options?.length ? (
                <select
                  value={filter.value ?? ''}
                  onChange={(event) => {
                    const next = [...filters]
                    next[index] = { ...filter, value: event.target.value }
                    onChange(next)
                  }}
                >
                  <option value="">{t('dbFilterAny')}</option>
                  {prop.options.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={filter.value ?? ''}
                  placeholder={t('dbFilterValue')}
                  onChange={(event) => {
                    const next = [...filters]
                    next[index] = { ...filter, value: event.target.value }
                    onChange(next)
                  }}
                />
              )
            ) : null}
            <button
              type="button"
              className="icon"
              onClick={() => onChange(filters.filter((_, i) => i !== index))}
            >
              ×
            </button>
          </div>
        )
      })}
      <div className="db-filter-actions">
        <button type="button" className="quiet" onClick={add} disabled={schema.length === 0}>
          {t('dbAddFilter')}
        </button>
        <button type="button" className="quiet" onClick={onAskAi} disabled={schema.length === 0}>
          {t('dbAiFilter')}
        </button>
      </div>
    </div>
  )
}
