import {
  cleanDbViews,
  cleanFilters,
  cleanPropDefs,
  cleanProps,
  defaultDatabaseSchema,
  defaultDatabaseViews,
  propDisplay,
  type DbFilter,
  type DbView,
  type PropDef,
} from './database'
import type { MessageKey } from './i18n'

export type DbAiMode = 'create' | 'schema' | 'rows' | 'fill' | 'filters'
export type DbAiScope = 'create' | 'manage' | 'filters'

export interface DbAiTemplate {
  id: string
  mode: DbAiMode
  label: MessageKey
  zh: string
  en: string
}

export interface DbAiContext {
  title?: string
  schema?: PropDef[]
  views?: DbView[]
  filters?: DbFilter[]
  rows?: Array<{ id: string; title: string; props?: Record<string, unknown> }>
}

export type DbAiRowDraft = { title: string; props: Record<string, unknown> }
export type DbAiUpdate = { id: string; title?: string; props: Record<string, unknown> }

export type DbAiResult =
  | { mode: 'create'; title: string; schema: PropDef[]; views: DbView[]; rows: DbAiRowDraft[] }
  | { mode: 'schema'; schema: PropDef[]; views?: DbView[] }
  | { mode: 'rows'; rows: DbAiRowDraft[] }
  | { mode: 'fill'; updates: DbAiUpdate[] }
  | { mode: 'filters'; filters: DbFilter[] }

const CREATE_TEMPLATES: DbAiTemplate[] = [
  {
    id: 'task',
    mode: 'create',
    label: 'dbTplTask',
    zh: '建一个任务看板。属性：状态（待办、进行中、完成）、优先级（高、中、低）、截止日期、负责人。包含表格，以及按状态分组的看板。给 4 条示例任务。',
    en: 'Create a task board. Properties: status (To do, Doing, Done), priority (High, Medium, Low), due date, owner. Include a table and a board grouped by status, plus 4 sample tasks.',
  },
  {
    id: 'reading',
    mode: 'create',
    label: 'dbTplReading',
    zh: '建一个阅读清单。属性：状态（想读、在读、读完）、作者、评分、类型（小说、非虚构、论文）。包含表格和按状态分组的看板。给 4 条示例。',
    en: 'Create a reading list. Properties: status (Want, Reading, Done), author, rating, type (Fiction, Nonfiction, Paper). Include a table and a board grouped by status, plus 4 samples.',
  },
  {
    id: 'customer',
    mode: 'create',
    label: 'dbTplCustomer',
    zh: '建一个客户跟进库。属性：阶段（线索、沟通中、已报价、成交、搁置）、下次联系日期、来源、金额。包含表格和按阶段分组的看板。给 4 条示例。',
    en: 'Create a customer follow-up database. Properties: stage (Lead, Talking, Quoted, Won, Paused), next contact date, source, amount. Include a table and a board grouped by stage, plus 4 samples.',
  },
  {
    id: 'meeting',
    mode: 'create',
    label: 'dbTplMeeting',
    zh: '建一个会议纪要库。属性：日期、状态（待整理、已确认）、参与人、决议。包含表格视图。给 3 条示例。',
    en: 'Create a meeting-notes database. Properties: date, status (Draft, Confirmed), attendees, decision. Include a table view and 3 samples.',
  },
  {
    id: 'habit',
    mode: 'create',
    label: 'dbTplHabit',
    zh: '建一个习惯打卡库。属性：频率（每天、每周）、已完成（勾选）、连续天数、备注。包含表格视图。给 4 条示例。',
    en: 'Create a habit tracker. Properties: frequency (Daily, Weekly), done (checkbox), streak, note. Include a table view and 4 samples.',
  },
]

const MANAGE_TEMPLATES: DbAiTemplate[] = [
  {
    id: 'adjust',
    mode: 'schema',
    label: 'dbTplAdjust',
    zh: '根据这个库的用途调整属性：补上明显缺少的字段，合并重复含义，保留已有属性 id。给出表格视图；若有单选状态，再给一个按它分组的看板。',
    en: 'Adjust properties for this database: add obvious missing fields, merge duplicates, and keep existing property ids. Include a table view, and a board grouped by a select status if one exists.',
  },
  {
    id: 'fill',
    mode: 'fill',
    label: 'dbTplFill',
    zh: '只补全各行里空着的属性。能从标题合理推断的就填上，推断不了的留空。不要改已经有值的属性，不要新增行。',
    en: 'Fill only empty properties on existing rows. Infer from the title when reasonable; leave the rest blank. Do not change values that are already set, and do not add rows.',
  },
  {
    id: 'sample',
    mode: 'rows',
    label: 'dbTplSample',
    zh: '按当前属性生成 4 条示例行，标题具体，属性值落在已有选项里。不要重复已有标题。',
    en: 'Add 4 sample rows for the current properties. Use specific titles and values that match existing options. Do not repeat titles that already exist.',
  },
  {
    id: 'filter',
    mode: 'filters',
    label: 'dbTplFilter',
    zh: '按我的描述设置筛选。只使用已有属性 id。没有提到的条件不要加。',
    en: 'Set filters from my description. Use only existing property ids. Do not add conditions I did not ask for.',
  },
  {
    id: 'board',
    mode: 'schema',
    label: 'dbTplBoard',
    zh: '保证有一个名为状态的单选属性（待办、进行中、完成；若已有状态类单选则保留它的 id 和选项）。保留其他属性。视图包含表格，以及按该状态分组的看板。',
    en: 'Ensure a select property for status (To do, Doing, Done). If a status-like select already exists, keep its id and options. Keep other properties. Include a table view and a board grouped by that status.',
  },
]

export function templatesFor(scope: DbAiScope): DbAiTemplate[] {
  if (scope === 'create') return CREATE_TEMPLATES
  if (scope === 'filters') return MANAGE_TEMPLATES.filter((item) => item.mode === 'filters')
  return MANAGE_TEMPLATES
}

export function templateText(template: DbAiTemplate, locale: string): string {
  return locale.startsWith('zh') ? template.zh : template.en
}

const JSON_ONLY = '只输出一个 JSON 对象，不要 Markdown，不要解释。'

export function systemFor(mode: DbAiMode): string {
  if (mode === 'create') {
    return `${JSON_ONLY}
{
  "title": "数据库标题",
  "schema": [{ "id": "status", "name": "状态", "type": "select", "options": ["待办", "进行中", "完成"] }],
  "views": [
    { "id": "table", "name": "表格", "type": "table", "filters": [] },
    { "id": "board", "name": "看板", "type": "board", "groupBy": "status", "filters": [] }
  ],
  "rows": [{ "title": "示例", "props": { "status": "待办" } }]
}
type 只能是 text、number、select、multiSelect、checkbox、date、image。
schema 3 到 8 个属性。id 用短英文。select 和 multiSelect 必须带 options。image 不要写 options。rows 最多 8 条，可以是空数组；image 属性值可先留空。`
  }
  if (mode === 'schema') {
    return `${JSON_ONLY}
{ "schema": [{ "id": "status", "name": "状态", "type": "select", "options": ["待办", "进行中", "完成"] }], "views": [{ "id": "table", "name": "表格", "type": "table", "filters": [] }] }
保留上下文里已有属性的 id，除非指令明确要求删除。type 只能是 text、number、select、multiSelect、checkbox、date、image。views 可选；看板的 groupBy 必须是 schema 里的 select 属性 id。`
  }
  if (mode === 'filters') {
    return `${JSON_ONLY}
{ "filters": [{ "propId": "已有属性id", "op": "equals", "value": "选项原文" }] }
op 只能是 equals、contains、isEmpty。propId 必须来自上下文，不要发明属性。isEmpty 不要带 value。最多 8 条。若指令是清空筛选，返回 { "filters": [] }。`
  }
  if (mode === 'rows') {
    return `${JSON_ONLY}
{ "rows": [{ "title": "具体标题", "props": { "属性id": "值" } }] }
最多 8 条。props 的键必须是已有属性 id。select 的值必须是已有选项之一。不要输出上下文里已有的行。`
  }
  return `${JSON_ONLY}
{ "updates": [{ "id": "已有行id", "props": { "属性id": "值" } }] }
只填写上下文里为空的属性，不要改已有非空值，除非指令明确要求覆盖。id 必须来自上下文。不要新增行。props 的键必须是已有属性 id。`
}

export function buildDbAiUser(instruction: string, context?: DbAiContext): string {
  const parts = [`指令：${instruction.trim()}`]
  if (!context) return parts[0]
  if (context.title) parts.push(`数据库：${context.title}`)
  if (context.schema?.length) parts.push(`属性：${JSON.stringify(context.schema)}`)
  if (context.views?.length) {
    parts.push(
      `视图：${JSON.stringify(
        context.views.map((view) => ({
          id: view.id,
          name: view.name,
          type: view.type,
          groupBy: view.groupBy,
          filters: view.filters,
        })),
      )}`,
    )
  }
  if (context.filters) parts.push(`当前筛选：${JSON.stringify(context.filters)}`)
  if (context.rows?.length) {
    const rows = context.rows.slice(0, 30).map((row) => ({
      id: row.id,
      title: row.title,
      props: row.props ?? {},
    }))
    parts.push(`行：${JSON.stringify(rows)}`)
  }
  return parts.join('\n\n')
}

export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = (fenced?.[1] ?? text).trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('dbAiBadJson')
  try {
    return JSON.parse(raw.slice(start, end + 1))
  } catch {
    throw new Error('dbAiBadJson')
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('dbAiBadJson')
  return value as Record<string, unknown>
}

function cleanTitle(value: unknown, fallback = ''): string {
  return String(value ?? fallback)
    .replace(/[\r\n{}]/g, ' ')
    .trim()
    .slice(0, 80)
}

function ensureViews(views: DbView[], schema: PropDef[]): DbView[] {
  const select = schema.find((item) => item.type === 'select')
  const date = schema.find((item) => item.type === 'date')
  const number = schema.find((item) => item.type === 'number')
  let next = views.length ? views : defaultDatabaseViews()
  next = next.map((view) => {
    if (view.type === 'board' || view.type === 'bar' || view.type === 'line' || view.type === 'donut' || view.type === 'number') {
      const groupBy =
        schema.some((item) => item.id === view.groupBy && (item.type === 'select' || item.type === 'text'))
          ? view.groupBy
          : select?.id
      if (view.type === 'board' && !groupBy) return { ...view, type: 'table' as const, groupBy: undefined }
      const patched = { ...view, groupBy }
      if (view.type !== 'board') {
        patched.chartOp = view.chartOp === 'sum' ? 'sum' : 'count'
        if (number && !schema.some((item) => item.id === view.valueProp && item.type === 'number')) {
          patched.valueProp = number.id
        }
      }
      return patched
    }
    if (view.type === 'calendar' || view.type === 'timeline') {
      const dateProp = schema.some((item) => item.id === view.dateProp && item.type === 'date') ? view.dateProp : date?.id
      return { ...view, dateProp }
    }
    return view
  })
  if (!next.some((view) => view.type === 'table')) {
    next = [{ id: 'table', name: '表格', type: 'table', filters: [] }, ...next]
  }
  const cleaned = cleanDbViews(next)
  return cleaned.length ? cleaned : defaultDatabaseViews()
}

function cleanDrafts(raw: unknown, schema: PropDef[], limit: number): DbAiRowDraft[] {
  if (!Array.isArray(raw)) return []
  const out: DbAiRowDraft[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const title = cleanTitle(row.title)
    if (!title) continue
    out.push({ title, props: cleanProps(row.props, schema) })
    if (out.length >= limit) break
  }
  return out
}

function knownFilters(raw: unknown, schema: PropDef[]): DbFilter[] {
  const ids = new Set(schema.map((item) => item.id))
  return cleanFilters(raw).filter((filter) => ids.has(filter.propId)).slice(0, 8)
}

export function parseDbAi(mode: DbAiMode, text: string, context?: DbAiContext, instruction = ''): DbAiResult {
  const raw = asRecord(extractJson(text))
  const schemaNow = context?.schema ?? []
  if (mode === 'create') {
    const schema = cleanPropDefs(raw.schema)
    const ready = schema.length ? schema : defaultDatabaseSchema()
    const views = ensureViews(Array.isArray(raw.views) ? cleanDbViews(raw.views) : [], ready)
    const title = cleanTitle(raw.title)
    if (!title) throw new Error('dbAiBadJson')
    return { mode, title, schema: ready, views, rows: cleanDrafts(raw.rows, ready, 8) }
  }
  if (mode === 'schema') {
    const schema = cleanPropDefs(raw.schema)
    if (!schema.length) throw new Error('dbAiBadJson')
    const cleanedViews = Array.isArray(raw.views) ? cleanDbViews(raw.views) : []
    const views = cleanedViews.length ? ensureViews(cleanedViews, schema) : undefined
    return views ? { mode, schema, views } : { mode, schema }
  }
  if (mode === 'filters') {
    if (!Array.isArray(raw.filters)) throw new Error('dbAiBadJson')
    return { mode, filters: knownFilters(raw.filters, schemaNow) }
  }
  if (mode === 'rows') {
    const rows = cleanDrafts(raw.rows, schemaNow, 8)
    if (!rows.length) throw new Error('dbAiBadJson')
    return { mode, rows }
  }
  if (!Array.isArray(raw.updates)) throw new Error('dbAiBadJson')
  const overwrite = /覆盖|替换已有|改已有|overwrite|replace existing/i.test(instruction)
  const byId = new Map((context?.rows ?? []).map((row) => [row.id, row]))
  const updates: DbAiUpdate[] = []
  for (const item of raw.updates) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const id = String(row.id ?? '').trim()
    const current = byId.get(id)
    if (!current) continue
    const cleaned = cleanProps(row.props, schemaNow)
    const props: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(cleaned)) {
      if (!overwrite && propDisplay(current.props?.[key])) continue
      props[key] = value
    }
    const title = cleanTitle(row.title)
    const nextTitle = title && title !== current.title ? title : undefined
    if (!Object.keys(props).length && !nextTitle) continue
    updates.push({ id, ...(nextTitle ? { title: nextTitle } : {}), props })
    if (updates.length >= 30) break
  }
  if (!updates.length) throw new Error('dbAiBadJson')
  return { mode: 'fill', updates }
}
