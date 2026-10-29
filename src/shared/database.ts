export type PropType = 'text' | 'number' | 'select' | 'multiSelect' | 'checkbox' | 'date'

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

export interface DbView {
  id: string
  name: string
  type: 'table' | 'board'
  groupBy?: string
  filters: DbFilter[]
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
    if (!['text', 'number', 'select', 'multiSelect', 'checkbox', 'date'].includes(type)) continue
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
    const type = row.type === 'board' ? 'board' : row.type === 'table' ? 'table' : null
    if (!id || !name || !type) continue
    const filters = cleanFilters(row.filters)
    const view: DbView = { id, name, type, filters }
    if (typeof row.groupBy === 'string' && row.groupBy.trim()) view.groupBy = row.groupBy.trim().slice(0, 40)
    out.push(view)
    if (out.length >= 12) break
  }
  return out
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
      ...schema.map((def) => propDisplay(row.props?.[def.id])),
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
