import { forwardRef, useEffect, useImperativeHandle, useState } from 'react'
import type { MessageKey } from '../../../shared/i18n'
import { EXPAND_LEVELS, POLISH_STYLES, TRANSLATE_LANGS } from '../editor/rewrite'
import type { SlashMenuState } from '../editor/slash'
import type { SelectionSlashDetail } from '../editor/slash'
import { useI18n } from '../i18n'
import { MenuIcon } from './menuIcons'

export interface SlashMenuHandle {
  handleKey(event: KeyboardEvent): boolean
}

export const SlashMenu = forwardRef<SlashMenuHandle, { state: SlashMenuState | null; onDismiss: () => void }>(
  function SlashMenu({ state, onDismiss }, ref) {
    const { t } = useI18n()
    const [index, setIndex] = useState(0)
    const count = state?.items.length ?? 0

    useEffect(() => setIndex(0), [state?.items])

    useImperativeHandle(
      ref,
      () => ({
        handleKey(event: KeyboardEvent) {
          if (!state) return false
          if (event.key === 'ArrowDown') {
            setIndex((value) => (count === 0 ? 0 : (value + 1) % count))
            return true
          }
          if (event.key === 'ArrowUp') {
            setIndex((value) => (count === 0 ? 0 : (value - 1 + count) % count))
            return true
          }
          if (event.key === 'Enter') {
            const item = state.items[index]
            if (item) state.command(item)
            return true
          }
          if (event.key === 'Escape') {
            onDismiss()
            return true
          }
          return false
        },
      }),
      [state, index, count, onDismiss],
    )

    if (!state?.clientRect) return null
    const rect = state.clientRect
    const top = rect.bottom + 320 > window.innerHeight ? Math.max(8, rect.top - 280) : rect.bottom + 6
    return (
      <div className="pop" style={{ top, left: Math.min(rect.left, window.innerWidth - 280) }} onMouseDown={(event) => event.preventDefault()}>
        {state.items.length === 0 ? (
          <div className="pop-empty">{t('slashEmpty')}</div>
        ) : (
          state.items.map((item, itemIndex) => (
            <button
              key={item.id}
              type="button"
              className={itemIndex === index ? 'menu-row active' : 'menu-row'}
              onMouseEnter={() => setIndex(itemIndex)}
              onClick={() => state.command(item)}
            >
              <MenuIcon id={item.id} />
              <span>{item.label}</span>
            </button>
          ))
        )}
      </div>
    )
  },
)

type SelectionItem = { id: string; label: string; group?: 'polish' | 'longer' | 'translate' }

const POLISH_KEYS: Record<string, MessageKey> = {
  'polish:natural': 'styleNatural',
  'polish:formal': 'styleFormal',
  'polish:concise': 'styleConcise',
  'polish:vivid': 'styleVivid',
  'polish:academic': 'styleAcademic',
  'polish:casual': 'styleCasual',
  'polish:business': 'styleBusiness',
}
const EXPAND_KEYS: Record<string, MessageKey> = {
  'longer:slight': 'expandSlight',
  'longer:medium': 'expandMedium',
  'longer:full': 'expandFull',
  'longer:deep': 'expandDeep',
}
const LANG_KEYS: Record<string, MessageKey> = {
  'lang:zh': 'langZh',
  'lang:zh-Hant': 'langZhHant',
  'lang:en': 'langEn',
  'lang:ja': 'langJa',
  'lang:ko': 'langKo',
  'lang:fr': 'langFr',
  'lang:de': 'langDe',
  'lang:es': 'langEs',
  'lang:pt': 'langPt',
  'lang:ru': 'langRu',
  'lang:ar': 'langAr',
  'lang:it': 'langIt',
}

export function SelectionMenu({
  detail,
  onPick,
  onClose,
}: {
  detail: SelectionSlashDetail | null
  onPick: (id: string) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const [index, setIndex] = useState(0)
  const [group, setGroup] = useState<'polish' | 'longer' | 'translate' | null>(null)
  const root: SelectionItem[] = [
    { id: 'ai', label: t('menuAi') },
    { id: 'polish', label: t('menuPolish'), group: 'polish' },
    { id: 'shorter', label: t('menuShorter') },
    { id: 'longer', label: t('menuLonger'), group: 'longer' },
    { id: 'translate', label: t('menuTranslate'), group: 'translate' },
    { id: 'above', label: t('menuAbove') },
    { id: 'below', label: t('menuBelow') },
    { id: 'h1', label: t('menuH1') },
    { id: 'h2', label: t('menuH2') },
    { id: 'quote', label: t('menuQuote') },
    { id: 'task', label: t('menuTask') },
  ]
  const submenus = {
    polish: { title: t('polishTitle'), items: POLISH_STYLES.map((item) => ({ id: item.id, label: t(POLISH_KEYS[item.id] ?? 'styleNatural') })) },
    longer: { title: t('longerTitle'), items: EXPAND_LEVELS.map((item) => ({ id: item.id, label: t(EXPAND_KEYS[item.id] ?? 'expandMedium') })) },
    translate: { title: t('translateTitle'), items: TRANSLATE_LANGS.map((item) => ({ id: item.id, label: t(LANG_KEYS[item.id] ?? 'langEn') })) },
  }
  const items: SelectionItem[] = group ? submenus[group].items : root
  useEffect(() => {
    setIndex(0)
    setGroup(null)
  }, [detail])
  useEffect(() => {
    if (!detail) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'ArrowLeft') {
        if (group && event.key !== 'Escape') {
          event.preventDefault()
          setGroup(null)
          setIndex(0)
          return
        }
        if (event.key === 'Escape' && group) {
          event.preventDefault()
          setGroup(null)
          setIndex(0)
          return
        }
        onClose()
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setIndex((value) => (items.length === 0 ? 0 : (value + 1) % items.length))
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setIndex((value) => (items.length === 0 ? 0 : (value - 1 + items.length) % items.length))
      }
      if (event.key === 'Enter' || event.key === 'ArrowRight') {
        const action = items[index]
        if (!action) return
        if (action.group && event.key === 'ArrowRight') {
          event.preventDefault()
          setGroup(action.group)
          setIndex(0)
          return
        }
        if (event.key === 'ArrowRight') return
        event.preventDefault()
        if (action.group) {
          setGroup(action.group)
          setIndex(0)
          return
        }
        onPick(action.id)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [detail, group, index, items, onClose, onPick])

  if (!detail) return null
  const top = detail.bottom + 420 > window.innerHeight ? Math.max(8, detail.top - 360) : detail.bottom + 6
  return (
    <>
      <button type="button" className="scrim" aria-label={t('close')} onClick={onClose} />
      <div className="pop" style={{ top, left: Math.min(detail.left, window.innerWidth - 280) }} onMouseDown={(event) => event.preventDefault()}>
        {group ? (
          <button
            type="button"
            className="pop-back"
            onClick={() => {
              setGroup(null)
              setIndex(0)
            }}
          >
            ← {submenus[group].title}
          </button>
        ) : (
          <div className="pop-caption">{detail.text.slice(0, 48)}</div>
        )}
        {items.map((action, actionIndex) => (
          <button
            key={action.id}
            type="button"
            className={actionIndex === index ? 'menu-row active' : 'menu-row'}
            onMouseEnter={() => setIndex(actionIndex)}
            onClick={() => {
              if (action.group) {
                setGroup(action.group)
                setIndex(0)
                return
              }
              onPick(action.id)
            }}
          >
            <MenuIcon id={action.id} />
            <span>
              {action.label}
              {action.group ? ' ›' : ''}
            </span>
          </button>
        ))}
      </div>
    </>
  )
}
