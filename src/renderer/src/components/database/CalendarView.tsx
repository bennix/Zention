import { useMemo, useState } from 'react'
import type { PageMeta } from '../../../../shared/types'
import { parsePropDate, type PropDef } from '../../../../shared/database'
import { useI18n } from '../../i18n'

function monthLabel(year: number, month: number, locale: string): string {
  return new Intl.DateTimeFormat(locale.startsWith('zh') ? 'zh-CN' : 'en', {
    year: 'numeric',
    month: 'long',
  }).format(new Date(year, month, 1))
}

export function CalendarView({
  rows,
  dateProp,
  onOpenRow,
}: {
  rows: PageMeta[]
  dateProp: PropDef | undefined
  onOpenRow: (id: string) => void
}) {
  const { t, locale } = useI18n()
  const now = new Date()
  const [cursor, setCursor] = useState({ year: now.getFullYear(), month: now.getMonth() })
  const byDay = useMemo(() => {
    const map = new Map<string, PageMeta[]>()
    for (const row of rows) {
      const day = dateProp ? parsePropDate(row.props?.[dateProp.id]) : null
      if (!day) continue
      const list = map.get(day) ?? []
      list.push(row)
      map.set(day, list)
    }
    return map
  }, [rows, dateProp])
  const unscheduled = useMemo(
    () => rows.filter((row) => !(dateProp && parsePropDate(row.props?.[dateProp.id]))),
    [rows, dateProp],
  )

  if (!dateProp) return <p className="hint">{t('dbNeedDate')}</p>

  const first = new Date(cursor.year, cursor.month, 1)
  const startPad = first.getDay()
  const daysInMonth = new Date(cursor.year, cursor.month + 1, 0).getDate()
  const cells: Array<{ day: number | null; key: string }> = []
  for (let i = 0; i < startPad; i += 1) cells.push({ day: null, key: `pad-${i}` })
  for (let day = 1; day <= daysInMonth; day += 1) {
    const key = `${cursor.year}-${String(cursor.month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    cells.push({ day, key })
  }

  return (
    <div className="db-calendar">
      <div className="db-calendar-nav">
        <button
          type="button"
          className="quiet"
          onClick={() =>
            setCursor((cur) => {
              const date = new Date(cur.year, cur.month - 1, 1)
              return { year: date.getFullYear(), month: date.getMonth() }
            })
          }
        >
          {t('dbPrevMonth')}
        </button>
        <strong>{monthLabel(cursor.year, cursor.month, locale)}</strong>
        <button
          type="button"
          className="quiet"
          onClick={() =>
            setCursor((cur) => {
              const date = new Date(cur.year, cur.month + 1, 1)
              return { year: date.getFullYear(), month: date.getMonth() }
            })
          }
        >
          {t('dbNextMonth')}
        </button>
      </div>
      <div className="db-calendar-grid">
        {cells.map((cell) => {
          const items = cell.day == null ? [] : (byDay.get(cell.key) ?? [])
          return (
            <div key={cell.key} className={`db-calendar-cell${cell.day == null ? ' empty' : ''}`}>
              {cell.day != null ? <span className="db-calendar-day">{cell.day}</span> : null}
              <div className="db-calendar-items">
                {items.map((row) => (
                  <button key={row.id} type="button" className="db-calendar-item" onClick={() => onOpenRow(row.id)}>
                    {row.title.trim() || t('untitled')}
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </div>
      {unscheduled.length ? (
        <div className="db-calendar-unscheduled">
          <strong>{t('dbUnscheduled')}</strong>
          <ul>
            {unscheduled.map((row) => (
              <li key={row.id}>
                <button type="button" className="quiet" onClick={() => onOpenRow(row.id)}>
                  {row.title.trim() || t('untitled')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
