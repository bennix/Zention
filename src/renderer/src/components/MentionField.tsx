import { useMemo, useRef, useState } from 'react'
import { mentionAt } from '../../../shared/pages'
import type { PageMeta } from '../../../shared/types'
import { useI18n } from '../i18n'

export function MentionField({
  value,
  pages,
  placeholder,
  rows,
  autoFocus,
  onChange,
}: {
  value: string
  pages: PageMeta[]
  placeholder: string
  rows: number
  autoFocus?: boolean
  onChange: (value: string) => void
}) {
  const { t } = useI18n()
  const ref = useRef<HTMLTextAreaElement>(null)
  const [query, setQuery] = useState<string | null>(null)
  const [start, setStart] = useState(0)
  const [index, setIndex] = useState(0)
  const [box, setBox] = useState<{ top: number; left: number; width: number } | null>(null)

  const matches = useMemo(() => {
    if (query == null) return []
    const q = query.trim().toLowerCase()
    return pages
      .filter((page) => !q || page.title.toLowerCase().includes(q) || (page.tags ?? []).some((tag) => tag.toLowerCase().includes(q)))
      .slice(0, 8)
  }, [pages, query])

  const sync = (next: string, cursor: number) => {
    onChange(next)
    const found = mentionAt(next, cursor)
    const el = ref.current
    if (!found || !el) {
      setQuery(null)
      setBox(null)
      return
    }
    const rect = el.getBoundingClientRect()
    setQuery(found.query)
    setStart(found.start)
    setIndex(0)
    setBox({ top: rect.bottom + 4, left: rect.left, width: rect.width })
  }

  const pick = (page: PageMeta) => {
    const el = ref.current
    const cursor = el?.selectionStart ?? value.length
    const title = page.title.replace(/[\[\]]/g, '').trim() || t('untitled')
    const token = `@[${title}](${page.id}) `
    const next = value.slice(0, start) + token + value.slice(cursor)
    onChange(next)
    setQuery(null)
    setBox(null)
    const pos = start + token.length
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(pos, pos)
    })
  }

  return (
    <div className="mention-wrap">
      <textarea
        ref={ref}
        autoFocus={autoFocus}
        rows={rows}
        placeholder={placeholder}
        value={value}
        onChange={(event) => sync(event.target.value, event.target.selectionStart)}
        onClick={(event) => sync(value, event.currentTarget.selectionStart)}
        onKeyUp={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === 'Escape') return
          sync(value, event.currentTarget.selectionStart)
        }}
        onKeyDown={(event) => {
          if (query == null) return
          if (event.nativeEvent.isComposing) return
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setIndex((value) => (matches.length === 0 ? 0 : (value + 1) % matches.length))
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setIndex((value) => (matches.length === 0 ? 0 : (value - 1 + matches.length) % matches.length))
          } else if (event.key === 'Enter' && matches[index]) {
            event.preventDefault()
            pick(matches[index])
          } else if (event.key === 'Escape') {
            event.preventDefault()
            setQuery(null)
            setBox(null)
          }
        }}
        onBlur={() => {
          window.setTimeout(() => {
            setQuery(null)
            setBox(null)
          }, 120)
        }}
      />
      {query != null && box ? (
        <div className="pop mention-pop" style={{ top: box.top, left: box.left, width: box.width }} onMouseDown={(event) => event.preventDefault()}>
          {matches.length === 0 ? (
            <div className="pop-empty">{t('mentionEmpty')}</div>
          ) : (
            matches.map((page, itemIndex) => (
              <button key={page.id} type="button" className={itemIndex === index ? 'active' : ''} onMouseEnter={() => setIndex(itemIndex)} onClick={() => pick(page)}>
                <span>{page.title.trim() || t('untitled')}</span>
                {page.group ? <em>{page.group}</em> : null}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}
