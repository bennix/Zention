import type { PageMeta } from '../../../../shared/types'
import { propDisplay, type PropDef } from '../../../../shared/database'
import { useI18n } from '../../i18n'

export function ListView({
  rows,
  schema,
  onOpenRow,
  onDelete,
}: {
  rows: PageMeta[]
  schema: PropDef[]
  onOpenRow: (id: string) => void
  onDelete: (id: string) => void
}) {
  const { t } = useI18n()
  const preview = schema.find((def) => def.type !== 'image')
  if (!rows.length) return <p className="hint">{t('dbNoRows')}</p>
  return (
    <ul className="db-list">
      {rows.map((row) => {
        const side = preview ? propDisplay(row.props?.[preview.id]) : ''
        return (
          <li key={row.id} className="db-list-row">
            <button type="button" className="db-list-open" onClick={() => onOpenRow(row.id)}>
              {row.title.trim() || t('untitled')}
            </button>
            {side ? <span className="db-list-meta">{side}</span> : null}
            <button type="button" className="quiet" onClick={() => onDelete(row.id)}>
              {t('delete')}
            </button>
          </li>
        )
      })}
    </ul>
  )
}
