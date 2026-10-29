import { useMemo, useRef, useState, type ReactNode } from 'react'
import type { PageMeta, PagePatch } from '../../../shared/types'
import { useI18n } from '../i18n'

type Node = { page: PageMeta; children: Node[] }

function knownParent(page: PageMeta, ids: Set<string>): string | null {
  return page.parentId && ids.has(page.parentId) ? page.parentId : null
}

function buildTree(pages: PageMeta[], parentId: string | null, ids: Set<string>, rank: Map<string, number>): Node[] {
  return pages
    .filter((page) => knownParent(page, ids) === parentId)
    .map((page) => ({ page, children: buildTree(pages, page.id, ids, rank) }))
    .sort((a, b) => {
      const folderA = a.page.folder || a.children.length > 0 ? 0 : 1
      const folderB = b.page.folder || b.children.length > 0 ? 0 : 1
      if (folderA !== folderB) return folderA - folderB
      return (rank.get(a.page.id) ?? 0) - (rank.get(b.page.id) ?? 0)
    })
}

function matchesTag(node: Node, tag: string): boolean {
  if (!tag) return true
  if ((node.page.tags ?? []).includes(tag)) return true
  return node.children.some((child) => matchesTag(child, tag))
}

function descendantIds(pages: PageMeta[], id: string): Set<string> {
  const ids = new Set<string>()
  const stack = pages.filter((page) => page.parentId === id).map((page) => page.id)
  while (stack.length) {
    const current = stack.pop()!
    if (ids.has(current)) continue
    ids.add(current)
    for (const page of pages) if (page.parentId === current) stack.push(page.id)
  }
  return ids
}

export function NoteNav({
  pages,
  activeId,
  onOpen,
  onCreate,
  onOrganize,
  onDelete,
}: {
  pages: PageMeta[]
  activeId: string
  onOpen: (id: string) => void
  onCreate: (parentId: string) => void
  onOrganize: (id: string, patch: PagePatch) => void
  onDelete: (id: string) => void
}) {
  const { t } = useI18n()
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [dropId, setDropId] = useState<string | null>(null)
  const dragId = useRef<string | null>(null)
  const [tag, setTag] = useState('')
  const [menu, setMenu] = useState<{ id: string; mode: 'main' | 'move' | 'group' | 'tag'; top: number; left: number } | null>(null)
  const [draft, setDraft] = useState('')
  const ids = useMemo(() => new Set(pages.map((page) => page.id)), [pages])
  const rank = useMemo(() => new Map(pages.map((page, index) => [page.id, index])), [pages])
  const tree = useMemo(() => buildTree(pages, null, ids, rank), [pages, ids, rank])
  const tags = useMemo(() => [...new Set(pages.flatMap((page) => page.tags ?? []))].sort((a, b) => a.localeCompare(b, 'zh')), [pages])
  const current = pages.find((page) => page.id === menu?.id) ?? null
  const blocked = current ? descendantIds(pages, current.id) : new Set<string>()

  const canDropOn = (targetId: string) => {
    const source = dragId.current
    return !!source && source !== targetId && !descendantIds(pages, source).has(targetId)
  }

  const openMenu = (id: string, anchor: HTMLElement, mode: 'main' | 'move' | 'group' | 'tag') => {
    const rect = anchor.getBoundingClientRect()
    const page = pages.find((item) => item.id === id)
    setDraft(mode === 'group' ? page?.group ?? '' : '')
    setMenu({ id, mode, top: rect.bottom + 4, left: Math.min(rect.left, window.innerWidth - 240) })
  }

  const renderNodes = (nodes: Node[], depth: number): ReactNode[] => {
    const visible = nodes.filter((node) => matchesTag(node, tag))
    const ungrouped = visible.filter((node) => !node.page.group)
    const groups = new Map<string, Node[]>()
    for (const node of visible) {
      if (!node.page.group) continue
      const list = groups.get(node.page.group) ?? []
      list.push(node)
      groups.set(node.page.group, list)
    }
    const sections = [{ name: '', items: ungrouped }, ...[...groups.entries()].sort(([a], [b]) => a.localeCompare(b, 'zh')).map(([name, items]) => ({ name, items }))]
    return sections.flatMap((section) => {
      const rows: ReactNode[] = section.items.flatMap((node): ReactNode[] => {
        const folder = node.page.folder === true || node.children.length > 0
        const open = tag ? true : collapsed[node.page.id] !== true
        const label = node.page.title.trim() || t('untitled')
        return [
          <div key={node.page.id} className="page-block" style={{ marginInlineStart: depth * 12 }}>
            <div
              className={['page-row', node.page.id === activeId ? 'active' : '', node.page.id === dropId ? 'drop-target' : '', node.page.id === dragId.current ? 'dragging' : ''].filter(Boolean).join(' ')}
              draggable
              title={t('dragInto')}
              onDragStart={(event) => {
                dragId.current = node.page.id
                event.dataTransfer.setData('text/plain', node.page.id)
                event.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(event) => {
                if (!canDropOn(node.page.id)) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                if (dropId !== node.page.id) setDropId(node.page.id)
              }}
              onDragLeave={(event) => {
                const next = event.relatedTarget
                if (next instanceof Node && event.currentTarget.contains(next)) return
                if (dropId === node.page.id) setDropId(null)
              }}
              onDrop={(event) => {
                event.preventDefault()
                const source = event.dataTransfer.getData('text/plain') || dragId.current
                if (source && canDropOn(node.page.id)) {
                  setCollapsed((state) => ({ ...state, [node.page.id]: false }))
                  onOrganize(source, { parentId: node.page.id })
                }
                dragId.current = null
                setDropId(null)
              }}
              onDragEnd={() => {
                dragId.current = null
                setDropId(null)
              }}
            >
              {folder ? (
                <button
                  type="button"
                  className="twist"
                  aria-label={label}
                  onClick={() => setCollapsed((current) => ({ ...current, [node.page.id]: !current[node.page.id] }))}
                >
                  {open ? '▾' : '▸'}
                </button>
              ) : (
                <span className="twist" />
              )}
              <button type="button" className="page-name" onClick={() => onOpen(node.page.id)}>
                {label}
              </button>
              <button type="button" className="icon" aria-label={t('setGroup')} onClick={(event) => openMenu(node.page.id, event.currentTarget, 'main')}>
                ···
              </button>
            </div>
            {(node.page.tags ?? []).length > 0 ? (
              <div className="page-tags">
                {(node.page.tags ?? []).map((item) => (
                  <button key={item} type="button" className={tag === item ? 'pill on' : 'pill'} onClick={() => setTag(item)}>
                    #{item}
                  </button>
                ))}
              </div>
            ) : null}
          </div>,
          ...(folder && open ? renderNodes(node.children, depth + 1) : []),
        ]
      })
      if (!section.name || rows.length === 0) return rows
      return [<div key={`group:${depth}:${section.name}`} className="side-label group-label" style={{ marginInlineStart: depth * 12 }}>{section.name}</div>, ...rows]
    })
  }

  return (
    <>
      {tags.length > 0 ? (
        <div className="tag-filters">
          <button type="button" className={tag ? '' : 'on'} onClick={() => setTag('')}>
            {t('allNotes')}
          </button>
          {tags.map((item) => (
            <button key={item} type="button" className={tag === item ? 'on' : ''} onClick={() => setTag(item)}>
              #{item}
            </button>
          ))}
        </div>
      ) : null}
      {renderNodes(tree, 0)}
      {menu && current ? (
        <>
          <button type="button" className="scrim" aria-label={t('close')} onClick={() => setMenu(null)} />
          <div className="pop note-menu" style={{ top: menu.top, left: menu.left }}>
            {menu.mode === 'main' ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    onOrganize(current.id, { folder: current.folder !== true })
                    setMenu(null)
                  }}
                >
                  {current.folder ? t('unmakeFolder') : t('makeFolder')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCollapsed((state) => ({ ...state, [current.id]: false }))
                    onCreate(current.id)
                    setMenu(null)
                  }}
                >
                  {t('newInside')}
                </button>
                <button type="button" onClick={(event) => openMenu(current.id, event.currentTarget, 'move')}>
                  {t('moveTo')}
                </button>
                <button type="button" onClick={(event) => openMenu(current.id, event.currentTarget, 'group')}>
                  {t('setGroup')}
                </button>
                <button type="button" onClick={(event) => openMenu(current.id, event.currentTarget, 'tag')}>
                  {t('addTag')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMenu(null)
                    onDelete(current.id)
                  }}
                >
                  {t('delete')}
                </button>
              </>
            ) : null}
            {menu.mode === 'move' ? (
              <>
                <button type="button" className="pop-back" onClick={(event) => openMenu(current.id, event.currentTarget, 'main')}>
                  {t('moveTo')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onOrganize(current.id, { parentId: null })
                    setMenu(null)
                  }}
                >
                  {t('moveRoot')}
                </button>
                {pages
                  .filter((page) => page.id !== current.id && !blocked.has(page.id))
                  .map((page) => (
                    <button
                      key={page.id}
                      type="button"
                      onClick={() => {
                        onOrganize(current.id, { parentId: page.id })
                        setCollapsed((state) => ({ ...state, [page.id]: false }))
                        setMenu(null)
                      }}
                    >
                      {page.title.trim() || t('untitled')}
                    </button>
                  ))}
              </>
            ) : null}
            {menu.mode === 'group' ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  onOrganize(current.id, { group: draft })
                  setMenu(null)
                }}
              >
                <input autoFocus value={draft} placeholder={t('groupPh')} onChange={(event) => setDraft(event.target.value)} />
                <button type="submit">{t('setGroup')}</button>
                <button
                  type="button"
                  onClick={() => {
                    onOrganize(current.id, { group: '' })
                    setMenu(null)
                  }}
                >
                  {t('clearGroup')}
                </button>
              </form>
            ) : null}
            {menu.mode === 'tag' ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  const next = cleanDraft(draft)
                  if (next) onOrganize(current.id, { tags: [...(current.tags ?? []), next] })
                  setMenu(null)
                }}
              >
                <input autoFocus value={draft} placeholder={t('tagPh')} onChange={(event) => setDraft(event.target.value)} />
                <button type="submit">{t('addTag')}</button>
                {(current.tags ?? []).map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => {
                      onOrganize(current.id, { tags: (current.tags ?? []).filter((tag) => tag !== item) })
                      setMenu(null)
                    }}
                  >
                    #{item} ×
                  </button>
                ))}
              </form>
            ) : null}
          </div>
        </>
      ) : null}
    </>
  )
}

function cleanDraft(value: string): string {
  return value.trim().slice(0, 24)
}
