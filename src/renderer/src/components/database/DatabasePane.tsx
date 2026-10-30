import { useMemo, useState } from 'react'
import type { PageMeta, PagePatch } from '../../../../shared/types'
import type { DbAiContext, DbAiResult, DbAiRowDraft } from '../../../../shared/databaseAi'
import {
  DB_VIEW_TYPES,
  isChartView,
  rowMatchesFilters,
  type DbFilter,
  type DbView,
  type DbViewType,
  type PropDef,
} from '../../../../shared/database'
import { useI18n } from '../../i18n'
import type { MessageKey } from '../../../../shared/i18n'
import { BoardView } from './BoardView'
import { CalendarView } from './CalendarView'
import { ChartView } from './ChartView'
import { DatabaseAiDialog } from './DatabaseAiDialog'
import { FilterBar } from './FilterBar'
import { GalleryView } from './GalleryView'
import { ListView } from './ListView'
import { PropertyEditor } from './PropertyEditor'
import { TableView } from './TableView'
import { TimelineView } from './TimelineView'

const VIEW_LABEL: Record<DbViewType, MessageKey> = {
  table: 'dbViewTable',
  board: 'dbViewBoard',
  gallery: 'dbViewGallery',
  list: 'dbViewList',
  calendar: 'dbViewCalendar',
  timeline: 'dbViewTimeline',
  bar: 'dbViewBar',
  line: 'dbViewLine',
  donut: 'dbViewDonut',
  number: 'dbViewNumber',
}

const DEFAULT_VIEW_NAME: Record<DbViewType, string> = {
  table: '表格',
  board: '看板',
  gallery: '画廊',
  list: '列表',
  calendar: '日历',
  timeline: '时间线',
  bar: '柱状图',
  line: '折线图',
  donut: '环形图',
  number: '数字',
}

export function DatabasePane({
  database,
  pages,
  onOrganize,
  onRename,
  onOpenRow,
  onAddRow,
  onCreateRows,
  onNeedKey,
  onDeleteRow,
}: {
  database: PageMeta
  pages: PageMeta[]
  onOrganize: (id: string, patch: PagePatch) => Promise<void> | void
  onRename: (id: string, title: string) => Promise<void> | void
  onOpenRow: (id: string) => void
  onAddRow: () => void
  onCreateRows: (rows: DbAiRowDraft[]) => Promise<void>
  onNeedKey: () => void
  onDeleteRow: (id: string) => void
}) {
  const { t } = useI18n()
  const [editingProps, setEditingProps] = useState(false)
  const [aiScope, setAiScope] = useState<'manage' | 'filters' | null>(null)
  const schema = database.schema ?? []
  const views = database.views ?? []
  const activeViewId = database.activeViewId || views[0]?.id || 'table'
  const activeView = views.find((view) => view.id === activeViewId) ?? views[0]
  const rows = useMemo(
    () => pages.filter((page) => page.parentId === database.id),
    [pages, database.id],
  )
  const filtered = useMemo(() => {
    const filters = activeView?.filters ?? []
    if (!filters.length) return rows
    return rows.filter((row) => rowMatchesFilters(row.props ?? {}, filters))
  }, [rows, activeView])

  const setActiveView = (id: string) => {
    void onOrganize(database.id, { activeViewId: id })
  }

  const updateView = (patch: Partial<DbView>) => {
    if (!activeView) return
    const nextViews = views.map((view) => (view.id === activeView.id ? { ...view, ...patch } : view))
    void onOrganize(database.id, { views: nextViews })
  }

  const setFilters = (filters: DbFilter[]) => updateView({ filters })

  const setSchema = (next: PropDef[]) => {
    void onOrganize(database.id, { schema: next })
  }

  const addView = (type: DbViewType) => {
    const id = `${type}-${Date.now().toString(36).slice(-4)}`
    const select = schema.find((def) => def.type === 'select')
    const date = schema.find((def) => def.type === 'date')
    const number = schema.find((def) => def.type === 'number')
    const view: DbView = {
      id,
      name: DEFAULT_VIEW_NAME[type],
      type,
      filters: [],
    }
    if (type === 'board' || isChartView(type)) {
      if (select) view.groupBy = select.id
    }
    if (type === 'calendar' || type === 'timeline') {
      if (date) view.dateProp = date.id
    }
    if (isChartView(type)) {
      view.chartOp = 'count'
      if (number) view.valueProp = number.id
    }
    void onOrganize(database.id, { views: [...views, view], activeViewId: id })
  }

  const context: DbAiContext = {
    title: database.title,
    schema,
    views,
    filters: activeView?.filters ?? [],
    rows: rows.slice(0, 30).map((row) => ({ id: row.id, title: row.title, props: row.props })),
  }

  const applyAi = async (result: DbAiResult) => {
    if (result.mode === 'schema') {
      const patch: PagePatch = { schema: result.schema }
      if (result.views) {
        patch.views = result.views
        patch.activeViewId = result.views.find((view) => view.type === 'table')?.id ?? result.views[0]?.id
      }
      await onOrganize(database.id, patch)
      return
    }
    if (result.mode === 'filters') {
      if (!activeView) return
      const nextViews = views.map((view) => (view.id === activeView.id ? { ...view, filters: result.filters } : view))
      await onOrganize(database.id, { views: nextViews })
      return
    }
    if (result.mode === 'rows') {
      await onCreateRows(result.rows)
      return
    }
    if (result.mode !== 'fill') return
    for (const update of result.updates) {
      const row = pages.find((item) => item.id === update.id)
      if (!row) continue
      if (update.title) await onRename(update.id, update.title)
      if (Object.keys(update.props).length) {
        await onOrganize(update.id, { props: { ...(row.props ?? {}), ...update.props } })
      }
    }
  }

  const onPropChange = (rowId: string, propId: string, value: unknown) => {
    const row = pages.find((page) => page.id === rowId)
    if (!row) return
    const props = { ...(row.props ?? {}) }
    if (value === undefined || value === '') delete props[propId]
    else props[propId] = value
    void onOrganize(rowId, { props })
  }

  const groupProp =
    schema.find((def) => def.id === activeView?.groupBy) ?? schema.find((def) => def.type === 'select')
  const dateProp =
    schema.find((def) => def.id === activeView?.dateProp && def.type === 'date') ??
    schema.find((def) => def.type === 'date')
  const type = activeView?.type ?? 'table'
  const showDateConfig = type === 'calendar' || type === 'timeline'
  const showChartConfig = isChartView(type)
  const showGroupConfig = type === 'board' || showChartConfig

  return (
    <div className="db-pane">
      <div className="db-toolbar">
        <div className="db-views">
          {views.map((view) => (
            <button
              key={view.id}
              type="button"
              className={view.id === activeView?.id ? 'active' : ''}
              onClick={() => setActiveView(view.id)}
            >
              {t(VIEW_LABEL[view.type] ?? 'dbViewTable')}
              {view.name && view.name !== DEFAULT_VIEW_NAME[view.type] ? ` · ${view.name}` : ''}
            </button>
          ))}
          <label className="db-add-view">
            <span>{t('dbAddView')}</span>
            <select
              value=""
              onChange={(event) => {
                const next = event.target.value as DbViewType
                if ((DB_VIEW_TYPES as readonly string[]).includes(next)) addView(next)
                event.target.value = ''
              }}
            >
              <option value="" disabled>
                {t('dbAddView')}
              </option>
              {DB_VIEW_TYPES.map((item) => (
                <option key={item} value={item}>
                  {t(VIEW_LABEL[item])}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="db-actions">
          <button type="button" onClick={onAddRow}>
            {t('dbAddRow')}
          </button>
          <button type="button" className="quiet" onClick={() => setAiScope('manage')}>
            {t('dbAiAssist')}
          </button>
          <button type="button" className="quiet" onClick={() => setEditingProps((open) => !open)}>
            {editingProps ? t('close') : t('dbEditProps')}
          </button>
        </div>
      </div>
      {activeView && (showDateConfig || showGroupConfig || showChartConfig) ? (
        <div className="db-view-config">
          {showDateConfig ? (
            <label>
              {t('dbDateProp')}
              <select
                value={activeView.dateProp ?? dateProp?.id ?? ''}
                onChange={(event) => updateView({ dateProp: event.target.value || undefined })}
              >
                <option value="">{t('dbEmpty')}</option>
                {schema
                  .filter((def) => def.type === 'date')
                  .map((def) => (
                    <option key={def.id} value={def.id}>
                      {def.name}
                    </option>
                  ))}
              </select>
            </label>
          ) : null}
          {showGroupConfig ? (
            <label>
              {t('dbGroupProp')}
              <select
                value={activeView.groupBy ?? groupProp?.id ?? ''}
                onChange={(event) => updateView({ groupBy: event.target.value || undefined })}
              >
                <option value="">{t('dbEmpty')}</option>
                {schema
                  .filter((def) => def.type === 'select' || def.type === 'text')
                  .map((def) => (
                    <option key={def.id} value={def.id}>
                      {def.name}
                    </option>
                  ))}
              </select>
            </label>
          ) : null}
          {showChartConfig ? (
            <>
              <label>
                {t('dbChartOp')}
                <select
                  value={activeView.chartOp ?? 'count'}
                  onChange={(event) => updateView({ chartOp: event.target.value === 'sum' ? 'sum' : 'count' })}
                >
                  <option value="count">{t('dbChartCount')}</option>
                  <option value="sum">{t('dbChartSum')}</option>
                </select>
              </label>
              <label>
                {t('dbValueProp')}
                <select
                  value={activeView.valueProp ?? ''}
                  onChange={(event) => updateView({ valueProp: event.target.value || undefined })}
                >
                  <option value="">{t('dbEmpty')}</option>
                  {schema
                    .filter((def) => def.type === 'number')
                    .map((def) => (
                      <option key={def.id} value={def.id}>
                        {def.name}
                      </option>
                    ))}
                </select>
              </label>
            </>
          ) : null}
        </div>
      ) : null}
      {editingProps ? <PropertyEditor schema={schema} onChange={setSchema} /> : null}
      {activeView ? (
        <FilterBar schema={schema} filters={activeView.filters ?? []} onChange={setFilters} onAskAi={() => setAiScope('filters')} />
      ) : null}
      {type === 'board' ? (
        <BoardView
          rows={filtered}
          schema={schema}
          groupProp={groupProp}
          onOpenRow={onOpenRow}
          onDelete={onDeleteRow}
          onMove={(id, value) => onPropChange(id, groupProp?.id ?? 'status', value)}
        />
      ) : type === 'gallery' ? (
        <GalleryView rows={filtered} schema={schema} onOpenRow={onOpenRow} onDelete={onDeleteRow} />
      ) : type === 'list' ? (
        <ListView rows={filtered} schema={schema} onOpenRow={onOpenRow} onDelete={onDeleteRow} />
      ) : type === 'calendar' ? (
        <CalendarView rows={filtered} dateProp={dateProp} onOpenRow={onOpenRow} />
      ) : type === 'timeline' ? (
        <TimelineView rows={filtered} dateProp={dateProp} onOpenRow={onOpenRow} onDelete={onDeleteRow} />
      ) : isChartView(type) && activeView ? (
        <ChartView rows={filtered} schema={schema} view={activeView} />
      ) : (
        <TableView
          rows={filtered}
          schema={schema}
          onOpenRow={onOpenRow}
          onRename={(id, title) => void onRename(id, title)}
          onPropChange={onPropChange}
          onDelete={onDeleteRow}
        />
      )}
      {aiScope ? (
        <DatabaseAiDialog
          scope={aiScope}
          context={context}
          onClose={() => setAiScope(null)}
          onApply={applyAi}
          onNeedKey={onNeedKey}
        />
      ) : null}
    </div>
  )
}
