export type PropType = 'text' | 'number' | 'select' | 'multiSelect' | 'checkbox' | 'date' | 'image'

export interface PropDef {
  id: string
  name: string
  type: PropType
  options?: string[]
}

export type FilterOp = 'equals' | 'contains' | 'isEmpty'

export interface DbFilter {
  propId: string
  op: FilterOp
  value?: string
}

export const DB_VIEW_TYPES = [
  'table',
  'board',
  'gallery',
  'list',
  'calendar',
  'timeline',
  'bar',
  'line',
  'donut',
  'number',
] as const

export type DbViewType = (typeof DB_VIEW_TYPES)[number]

export type ChartOp = 'count' | 'sum'

export const CHART_VIEW_TYPES = ['bar', 'line', 'donut', 'number'] as const

export function isChartView(type: DbViewType): boolean {
  return (CHART_VIEW_TYPES as readonly string[]).includes(type)
}

export function isDbViewType(value: unknown): value is DbViewType {
  return typeof value === 'string' && (DB_VIEW_TYPES as readonly string[]).includes(value)
}

export interface DbView {
  id: string
  name: string
  type: DbViewType
  groupBy?: string
  dateProp?: string
  valueProp?: string
  chartOp?: ChartOp
  filters: DbFilter[]
}

export interface ChartBucket {
  key: string
  label: string
  value: number
}

export const STATUS_PROP_ID = 'status'

export const DEFAULT_STATUS_OPTIONS = ['待办', '进行中', '完成'] as const

export function defaultDatabaseSchema(): PropDef[] {
  return [
    {
      id: STATUS_PROP_ID,
      name: 'Status',
      type: 'select',
      options: [...DEFAULT_STATUS_OPTIONS],
    },
  ]
}

export function defaultDatabaseViews(): DbView[] {
  return [
    { id: 'table', name: '表格', type: 'table', filters: [] },
    { id: 'board', name: '看板', type: 'board', groupBy: STATUS_PROP_ID, filters: [] },
  ]
}

export function cleanPropDefs(raw: unknown): PropDef[] {
  if (!Array.isArray(raw)) return []
  const out: PropDef[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const id = String(row.id ?? '')
      .trim()
      .slice(0, 40)
    const name = String(row.name ?? '')
      .replace(/[\r\n{}]/g, ' ')
      .trim()
      .slice(0, 40)
    const type = String(row.type ?? '') as PropType
    if (!id || !name) continue
    if (!['text', 'number', 'select', 'multiSelect', 'checkbox', 'date', 'image'].includes(type)) continue
    const def: PropDef = { id, name, type }
    if (type === 'select' || type === 'multiSelect') {
      const options = Array.isArray(row.options)
        ? row.options
            .map((opt) => String(opt).trim().slice(0, 40))
            .filter(Boolean)
            .slice(0, 24)
        : []
      def.options = options
    }
    out.push(def)
    if (out.length >= 32) break
  }
  return out
}

export function cleanDbViews(raw: unknown): DbView[] {
  if (!Array.isArray(raw)) return []
  const out: DbView[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const id = String(row.id ?? '')
      .trim()
      .slice(0, 40)
    const name = String(row.name ?? '')
      .replace(/[\r\n{}]/g, ' ')
      .trim()
      .slice(0, 40)
    if (!id || !name || !isDbViewType(row.type)) continue
    const filters = cleanFilters(row.filters)
    const view: DbView = { id, name, type: row.type, filters }
    if (typeof row.groupBy === 'string' && row.groupBy.trim()) view.groupBy = row.groupBy.trim().slice(0, 40)
    if (typeof row.dateProp === 'string' && row.dateProp.trim()) view.dateProp = row.dateProp.trim().slice(0, 40)
    if (typeof row.valueProp === 'string' && row.valueProp.trim()) view.valueProp = row.valueProp.trim().slice(0, 40)
    if (row.chartOp === 'sum' || row.chartOp === 'count') view.chartOp = row.chartOp
    out.push(view)
    if (out.length >= 16) break
  }
  return out
}

export function parsePropDate(value: unknown): string | null {
  if (value == null || value === '') return null
  const text = String(value).trim().slice(0, 32)
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return null
  const day = text.slice(0, 10)
  const time = Date.parse(`${day}T12:00:00`)
  return Number.isFinite(time) ? day : null
}

export function aggregateChartBuckets(
  rows: Array<{ props?: Record<string, unknown> }>,
  schema: PropDef[],
  view: Pick<DbView, 'groupBy' | 'valueProp' | 'chartOp'>,
): ChartBucket[] {
  const group =
    schema.find((def) => def.id === view.groupBy && (def.type === 'select' || def.type === 'text')) ??
    schema.find((def) => def.type === 'select')
  const valueDef = schema.find((def) => def.id === view.valueProp && def.type === 'number')
  const op = view.chartOp === 'sum' && valueDef ? 'sum' : 'count'
  const totals = new Map<string, number>()
  const labels = new Map<string, string>()
  if (group?.type === 'select') {
    for (const option of group.options ?? []) {
      totals.set(option, 0)
      labels.set(option, option)
    }
  }
  for (const row of rows) {
    const raw = group ? row.props?.[group.id] : undefined
    const key = raw == null || raw === '' ? '' : String(raw)
    const label = key || '—'
    if (!labels.has(key)) labels.set(key, label)
    const prev = totals.get(key) ?? 0
    if (op === 'sum' && valueDef) {
      const n = Number(row.props?.[valueDef.id])
      totals.set(key, prev + (Number.isFinite(n) ? n : 0))
    } else {
      totals.set(key, prev + 1)
    }
  }
  return [...totals.entries()].map(([key, value]) => ({
    key,
    label: labels.get(key) ?? (key || '—'),
    value,
  }))
}

export function cleanFilters(raw: unknown): DbFilter[] {
  if (!Array.isArray(raw)) return []
  const out: DbFilter[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const propId = String(row.propId ?? '')
      .trim()
      .slice(0, 40)
    const op = String(row.op ?? '') as FilterOp
    if (!propId || !['equals', 'contains', 'isEmpty'].includes(op)) continue
    const filter: DbFilter = { propId, op }
    if (row.value !== undefined) filter.value = String(row.value).slice(0, 120)
    out.push(filter)
    if (out.length >= 16) break
  }
  return out
}

export function cleanProps(raw: unknown, schema: PropDef[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const allowed = new Map(schema.map((def) => [def.id, def]))
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const def = allowed.get(key)
    if (!def) continue
    const cleaned = cleanPropValue(def, value)
    if (cleaned !== undefined) out[key] = cleaned
  }
  return out
}

export function cleanPropValue(def: PropDef, value: unknown): unknown {
  if (value === null || value === undefined) return undefined
  switch (def.type) {
    case 'text':
    case 'date':
      return String(value).slice(0, 500)
    case 'image': {
      const text = String(value)
        .trim()
        .replace(/\\/g, '/')
        .slice(0, 500)
      if (!text || text.includes('..')) return undefined
      if (/^(assets\/|https?:\/\/|zention-asset:)/i.test(text)) return text
      if (text.includes('/')) return text
      return undefined
    }
    case 'number': {
      const n = typeof value === 'number' ? value : Number(String(value).trim())
      return Number.isFinite(n) ? n : undefined
    }
    case 'checkbox':
      return value === true || value === 'true' || value === 1 || value === '1'
    case 'select': {
      const text = String(value).trim().slice(0, 40)
      if (!text) return undefined
      if (def.options?.length && !def.options.includes(text)) return text
      return text
    }
    case 'multiSelect': {
      const list = Array.isArray(value) ? value : String(value).split(',')
      const cleaned = list
        .map((item) => String(item).trim().slice(0, 40))
        .filter(Boolean)
        .slice(0, 12)
      return cleaned.length ? cleaned : undefined
    }
    default:
      return undefined
  }
}

export function propDisplay(value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  if (Array.isArray(value)) return value.map(String).join(', ')
  if (typeof value === 'boolean') return value ? '✓' : ''
  return String(value)
}

const SYNCED_DB_START = '<!-- zention-db -->'
const SYNCED_DB_END = '<!-- /zention-db -->'

function syncedCell(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
}

/** Markdown table written into the database file on GitHub. Row ids stay in comments so the grid can be read back. */
export function syncedDatabaseTable(
  schema: PropDef[],
  rows: Array<{ id: string; title: string; props?: Record<string, unknown> }>,
): string {
  const headers = ['标题', ...schema.map((def) => def.name)]
  const line = (cells: string[]) => `| ${cells.map(syncedCell).join(' | ')} |`
  const rule = `| ${headers.map(() => '---').join(' | ')} |`
  const body = rows.map((row) =>
    line([
      `${row.title} <!-- zention-row:${row.id} -->`,
      ...schema.map((def) => {
        const raw = row.props?.[def.id]
        if (def.type === 'image' && raw) {
          const src = String(raw).trim()
          return src ? `![](${src})` : ''
        }
        return propDisplay(raw)
      }),
    ]),
  )
  return `${SYNCED_DB_START}\n${line(headers)}\n${rule}\n${body.join('\n')}${body.length ? '\n' : ''}${SYNCED_DB_END}\n\n`
}

export function stripSyncedDatabaseTable(body: string): string {
  const start = body.indexOf(SYNCED_DB_START)
  if (start < 0) return body
  const end = body.indexOf(SYNCED_DB_END, start)
  if (end < 0) return body
  return `${body.slice(0, start)}${body.slice(end + SYNCED_DB_END.length)}`.replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n')
}

export function rowMatchesFilters(props: Record<string, unknown>, filters: DbFilter[]): boolean {
  for (const filter of filters) {
    const raw = props[filter.propId]
    const text = propDisplay(raw)
    if (filter.op === 'isEmpty') {
      if (text !== '') return false
      continue
    }
    if (filter.op === 'equals') {
      if (text !== String(filter.value ?? '')) return false
      continue
    }
    if (filter.op === 'contains') {
      if (!text.toLowerCase().includes(String(filter.value ?? '').toLowerCase())) return false
    }
  }
  return true
}
