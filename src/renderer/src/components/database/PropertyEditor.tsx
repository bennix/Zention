import type { PropDef, PropType } from '../../../../shared/database'
import { useI18n } from '../../i18n'

const TYPES: PropType[] = ['text', 'number', 'select', 'multiSelect', 'checkbox', 'date']

export function PropertyEditor({
  schema,
  onChange,
}: {
  schema: PropDef[]
  onChange: (schema: PropDef[]) => void
}) {
  const { t } = useI18n()

  const typeLabel = (type: PropType) => {
    switch (type) {
      case 'text':
        return t('dbTypeText')
      case 'number':
        return t('dbTypeNumber')
      case 'select':
        return t('dbTypeSelect')
      case 'multiSelect':
        return t('dbTypeMulti')
      case 'checkbox':
        return t('dbTypeCheck')
      case 'date':
        return t('dbTypeDate')
      default:
        return type
    }
  }

  return (
    <div className="db-props-editor">
      {schema.map((def, index) => (
        <div key={def.id} className="db-prop-row">
          <input
            value={def.name}
            onChange={(event) => {
              const next = [...schema]
              next[index] = { ...def, name: event.target.value }
              onChange(next)
            }}
          />
          <select
            value={def.type}
            onChange={(event) => {
              const type = event.target.value as PropType
              const next = [...schema]
              const updated: PropDef = { ...def, type }
              if (type === 'select' || type === 'multiSelect') updated.options = def.options ?? ['选项 A', '选项 B']
              else delete updated.options
              next[index] = updated
              onChange(next)
            }}
          >
            {TYPES.map((type) => (
              <option key={type} value={type}>
                {typeLabel(type)}
              </option>
            ))}
          </select>
          {def.type === 'select' || def.type === 'multiSelect' ? (
            <input
              value={(def.options ?? []).join(', ')}
              placeholder={t('dbOptionsPh')}
              onChange={(event) => {
                const options = event.target.value
                  .split(',')
                  .map((item) => item.trim())
                  .filter(Boolean)
                const next = [...schema]
                next[index] = { ...def, options }
                onChange(next)
              }}
            />
          ) : (
            <span />
          )}
          <button
            type="button"
            className="icon"
            onClick={() => onChange(schema.filter((item) => item.id !== def.id))}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="quiet"
        onClick={() =>
          onChange([
            ...schema,
            {
              id: `prop_${Date.now().toString(36)}`,
              name: t('dbNewProp'),
              type: 'text',
            },
          ])
        }
      >
        {t('dbAddProp')}
      </button>
    </div>
  )
}
