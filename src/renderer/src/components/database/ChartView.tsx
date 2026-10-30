import { useMemo } from 'react'
import type { PageMeta } from '../../../../shared/types'
import { aggregateChartBuckets, type DbView, type PropDef } from '../../../../shared/database'
import { useI18n } from '../../i18n'

const COLORS = ['#0f7b6c', '#8d7040', '#3d5a80', '#9a3412', '#5b6b8c', '#2a9d8f', '#bc6c25', '#6d597a']

export function ChartView({
  rows,
  schema,
  view,
}: {
  rows: PageMeta[]
  schema: PropDef[]
  view: DbView
}) {
  const { t } = useI18n()
  const buckets = useMemo(() => aggregateChartBuckets(rows, schema, view), [rows, schema, view])
  const groupOk = schema.some((def) => def.id === view.groupBy || def.type === 'select' || def.type === 'text')
  if (!groupOk && view.type !== 'number') return <p className="hint">{t('dbNeedChartGroup')}</p>
  if (!buckets.length || buckets.every((item) => item.value === 0)) {
    return <p className="hint">{t('dbChartEmpty')}</p>
  }

  if (view.type === 'number') {
    const total = buckets.reduce((sum, item) => sum + item.value, 0)
    return (
      <div className="db-chart db-chart-number">
        <strong>{total}</strong>
        <span>{view.chartOp === 'sum' ? t('dbChartSum') : t('dbChartCount')}</span>
      </div>
    )
  }

  if (view.type === 'donut') return <DonutChart buckets={buckets} />
  if (view.type === 'line') return <LineChart buckets={buckets} />
  return <BarChart buckets={buckets} />
}

function BarChart({ buckets }: { buckets: ReturnType<typeof aggregateChartBuckets> }) {
  const max = Math.max(...buckets.map((item) => item.value), 1)
  const height = 160
  const width = Math.max(buckets.length * 48, 240)
  const gap = 12
  const barW = Math.max(16, (width - gap * (buckets.length + 1)) / buckets.length)
  return (
    <div className="db-chart">
      <svg viewBox={`0 0 ${width} ${height + 28}`} width="100%" role="img">
        {buckets.map((item, index) => {
          const h = Math.round((item.value / max) * height)
          const x = gap + index * (barW + gap)
          const y = height - h
          return (
            <g key={item.key}>
              <rect x={x} y={y} width={barW} height={h} rx={4} fill={COLORS[index % COLORS.length]} />
              <text x={x + barW / 2} y={height + 16} textAnchor="middle" fontSize="10" fill="#5e5a53">
                {item.label.slice(0, 6)}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

function LineChart({ buckets }: { buckets: ReturnType<typeof aggregateChartBuckets> }) {
  const max = Math.max(...buckets.map((item) => item.value), 1)
  const height = 160
  const width = Math.max(buckets.length * 56, 280)
  const pad = 16
  const points = buckets.map((item, index) => {
    const x = pad + (index * (width - pad * 2)) / Math.max(buckets.length - 1, 1)
    const y = height - pad - (item.value / max) * (height - pad * 2)
    return `${x},${y}`
  })
  return (
    <div className="db-chart">
      <svg viewBox={`0 0 ${width} ${height + 24}`} width="100%" role="img">
        <polyline fill="none" stroke="#0f7b6c" strokeWidth="2.5" points={points.join(' ')} />
        {buckets.map((item, index) => {
          const [x, y] = points[index].split(',').map(Number)
          return (
            <g key={item.key}>
              <circle cx={x} cy={y} r={4} fill="#0f7b6c" />
              <text x={x} y={height + 16} textAnchor="middle" fontSize="10" fill="#5e5a53">
                {item.label.slice(0, 6)}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

function DonutChart({ buckets }: { buckets: ReturnType<typeof aggregateChartBuckets> }) {
  const total = buckets.reduce((sum, item) => sum + item.value, 0) || 1
  const r = 54
  const c = 2 * Math.PI * r
  let offset = 0
  return (
    <div className="db-chart db-chart-donut">
      <svg viewBox="0 0 140 140" width="160" height="160" role="img">
        <g transform="translate(70 70) rotate(-90)">
          {buckets.map((item, index) => {
            const len = (item.value / total) * c
            const node = (
              <circle
                key={item.key}
                r={r}
                cx={0}
                cy={0}
                fill="transparent"
                stroke={COLORS[index % COLORS.length]}
                strokeWidth="18"
                strokeDasharray={`${len} ${c - len}`}
                strokeDashoffset={-offset}
              />
            )
            offset += len
            return node
          })}
        </g>
        <text x="70" y="74" textAnchor="middle" fontSize="18" fontWeight="600" fill="#24312d">
          {total}
        </text>
      </svg>
      <ul>
        {buckets.map((item, index) => (
          <li key={item.key}>
            <i style={{ background: COLORS[index % COLORS.length] }} />
            {item.label}
            <em>{item.value}</em>
          </li>
        ))}
      </ul>
    </div>
  )
}
