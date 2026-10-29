import { useMemo, useState } from 'react'
import type { PageMeta, PagePatch } from '../../../../shared/types'
import type { DbAiContext, DbAiResult, DbAiRowDraft } from '../../../../shared/databaseAi'
import { rowMatchesFilters, type DbFilter, type DbView, type PropDef } from '../../../../shared/database'
import { useI18n } from '../../i18n'
import { BoardView } from './BoardView'
import { DatabaseAiDialog } from './DatabaseAiDialog'
import { FilterBar } from './FilterBar'
import { PropertyEditor } from './PropertyEditor'
import { TableView } from './TableView'

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

  const groupProp = schema.find((def) => def.id === activeView?.groupBy) ?? schema.find((def) => def.type === 'select')

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
              {view.type === 'board' ? t('dbViewBoard') : t('dbViewTable')}
              {view.name && view.name !== '表格' && view.name !== '看板' ? ` · ${view.name}` : ''}
            </button>
          ))}
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
      {editingProps ? <PropertyEditor schema={schema} onChange={setSchema} /> : null}
      {activeView ? (
        <FilterBar schema={schema} filters={activeView.filters ?? []} onChange={setFilters} onAskAi={() => setAiScope('filters')} />
      ) : null}
      {activeView?.type === 'board' ? (
        <BoardView
          rows={filtered}
          groupProp={groupProp}
          onOpenRow={onOpenRow}
          onDelete={onDeleteRow}
          onMove={(id, value) => onPropChange(id, groupProp?.id ?? 'status', value)}
        />
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
