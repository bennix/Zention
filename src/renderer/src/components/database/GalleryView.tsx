import type { PageMeta } from '../../../../shared/types'
import { propDisplay, type PropDef } from '../../../../shared/database'
import { displayImageSrc } from '../../editor/image'
import { useI18n } from '../../i18n'

export function GalleryView({
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
  const coverDef = schema.find((def) => def.type === 'image')
  const preview = schema.filter((def) => def.type !== 'image').slice(0, 3)
  if (!rows.length) return <p className="hint">{t('dbNoRows')}</p>
  return (
    <div className="db-gallery">
      {rows.map((row) => {
        const cover = coverDef ? String(row.props?.[coverDef.id] ?? '').trim() : ''
        return (
          <article key={row.id} className="db-gallery-card">
            {cover ? (
              <button type="button" className="db-gallery-cover" onClick={() => onOpenRow(row.id)}>
                <img src={displayImageSrc(cover)} alt="" />
              </button>
            ) : null}
            <button type="button" className="db-gallery-open" onClick={() => onOpenRow(row.id)}>
              {row.title.trim() || t('untitled')}
            </button>
            <ul className="db-gallery-props">
              {preview.map((def) => {
                const text = propDisplay(row.props?.[def.id])
                if (!text) return null
                return (
                  <li key={def.id}>
                    <span>{def.name}</span>
                    {text}
                  </li>
                )
              })}
            </ul>
            <button type="button" className="quiet" onClick={() => onDelete(row.id)}>
              {t('delete')}
            </button>
          </article>
        )
      })}
    </div>
  )
}
