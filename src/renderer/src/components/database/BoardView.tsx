import { useState } from 'react'
import type { PageMeta } from '../../../../shared/types'
import type { PropDef } from '../../../../shared/database'
import { displayImageSrc } from '../../editor/image'
import { useI18n } from '../../i18n'

export function BoardView({
  rows,
  schema,
  groupProp,
  onOpenRow,
  onMove,
  onDelete,
}: {
  rows: PageMeta[]
  schema: PropDef[]
  groupProp: PropDef | undefined
  onOpenRow: (id: string) => void
  onMove: (id: string, value: string | undefined) => void
  onDelete: (id: string) => void
}) {
  const { t } = useI18n()
  const [dragging, setDragging] = useState<string | null>(null)
  const coverDef = schema.find((def) => def.type === 'image')
  const columns = [
    ...(groupProp?.options ?? []).map((option) => ({ key: option, label: option })),
    { key: '', label: t('dbUngrouped') },
  ]

  const inColumn = (row: PageMeta, key: string) => {
    const value = row.props?.[groupProp?.id ?? '']
    const text = value == null || value === '' ? '' : String(value)
    return text === key
  }

  if (!groupProp) {
    return <p className="hint">{t('dbBoardNeedSelect')}</p>
  }

  return (
    <div className="db-board">
      {columns.map((column) => {
        const cards = rows.filter((row) => inColumn(row, column.key))
        return (
          <div
            key={column.key || '__empty'}
            className="db-board-col"
            onDragOver={(event) => {
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
            }}
            onDrop={(event) => {
              event.preventDefault()
              const id = dragging || event.dataTransfer.getData('text/plain')
              if (!id) return
              onMove(id, column.key || undefined)
              setDragging(null)
            }}
          >
            <div className="db-board-head">
              <strong>{column.label}</strong>
              <span>{cards.length}</span>
            </div>
            <div className="db-board-list">
              {cards.map((row) => {
                const cover = coverDef ? String(row.props?.[coverDef.id] ?? '').trim() : ''
                return (
                <div
                  key={row.id}
                  className="db-card"
                  draggable
                  onDragStart={(event) => {
                    setDragging(row.id)
                    event.dataTransfer.setData('text/plain', row.id)
                    event.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragEnd={() => setDragging(null)}
                >
                  {cover ? (
                    <button type="button" className="db-card-cover" onClick={() => onOpenRow(row.id)}>
                      <img src={displayImageSrc(cover)} alt="" />
                    </button>
                  ) : null}
                  <button type="button" className="db-card-open" onClick={() => onOpenRow(row.id)}>
                    {row.title.trim() || t('untitled')}
                  </button>
                  <button
                    type="button"
                    className="icon"
                    aria-label={t('delete')}
                    onClick={() => onDelete(row.id)}
                  >
                    ×
                  </button>
                </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
