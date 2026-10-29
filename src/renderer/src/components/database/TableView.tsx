import type { PageMeta } from '../../../../shared/types'
import type { PropDef } from '../../../../shared/database'
import { useI18n } from '../../i18n'
import { PropertyCell } from './PropertyCell'

export function TableView({
  rows,
  schema,
  onOpenRow,
  onRename,
  onPropChange,
  onDelete,
}: {
  rows: PageMeta[]
  schema: PropDef[]
  onOpenRow: (id: string) => void
  onRename: (id: string, title: string) => void
  onPropChange: (id: string, propId: string, value: unknown) => void
  onDelete: (id: string) => void
}) {
  const { t } = useI18n()
  return (
    <div className="db-table-wrap">
      <table className="db-table">
        <thead>
          <tr>
            <th>{t('dbTitleCol')}</th>
            {schema.map((def) => (
              <th key={def.id}>{def.name}</th>
            ))}
            <th className="db-row-actions" />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={schema.length + 2} className="db-empty">
                {t('dbNoRows')}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.id}>
                <td className="db-title-cell">
                  <input
                    value={row.title}
                    onChange={(event) => onRename(row.id, event.target.value)}
                    onBlur={(event) => onRename(row.id, event.target.value.trim() || t('untitled'))}
                  />
                  <button type="button" className="quiet" onClick={() => onOpenRow(row.id)}>
                    {t('dbOpenRow')}
                  </button>
                </td>
                {schema.map((def) => (
                  <td key={def.id}>
                    <PropertyCell
                      def={def}
                      value={row.props?.[def.id]}
                      onChange={(value) => onPropChange(row.id, def.id, value)}
                    />
                  </td>
                ))}
                <td className="db-row-actions">
                  <button type="button" className="quiet" onClick={() => onDelete(row.id)}>
                    {t('delete')}
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}
