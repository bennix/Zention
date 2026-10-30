import { useMemo } from 'react'
import type { PageMeta } from '../../../../shared/types'
import { parsePropDate, type PropDef } from '../../../../shared/database'
import { useI18n } from '../../i18n'

export function TimelineView({
  rows,
  dateProp,
  onOpenRow,
  onDelete,
}: {
  rows: PageMeta[]
  dateProp: PropDef | undefined
  onOpenRow: (id: string) => void
  onDelete: (id: string) => void
}) {
  const { t } = useI18n()
  const { dated, undated } = useMemo(() => {
    const withDate: Array<{ row: PageMeta; day: string }> = []
    const without: PageMeta[] = []
    for (const row of rows) {
      const day = dateProp ? parsePropDate(row.props?.[dateProp.id]) : null
      if (day) withDate.push({ row, day })
      else without.push(row)
    }
    withDate.sort((a, b) => a.day.localeCompare(b.day))
    return { dated: withDate, undated: without }
  }, [rows, dateProp])

  if (!dateProp) return <p className="hint">{t('dbNeedDate')}</p>
  if (!rows.length) return <p className="hint">{t('dbNoRows')}</p>

  return (
    <div className="db-timeline">
      {dated.map(({ row, day }) => (
        <div key={row.id} className="db-timeline-item">
          <time dateTime={day}>{day}</time>
          <div className="db-timeline-body">
            <button type="button" className="db-timeline-open" onClick={() => onOpenRow(row.id)}>
              {row.title.trim() || t('untitled')}
            </button>
            <button type="button" className="quiet" onClick={() => onDelete(row.id)}>
              {t('delete')}
            </button>
          </div>
        </div>
      ))}
      {undated.length ? (
        <div className="db-timeline-item muted">
          <time>{t('dbUnscheduled')}</time>
          <div className="db-timeline-body">
            {undated.map((row) => (
              <button key={row.id} type="button" className="db-timeline-open" onClick={() => onOpenRow(row.id)}>
                {row.title.trim() || t('untitled')}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
