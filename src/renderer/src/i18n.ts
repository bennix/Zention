import { useEffect, useState } from 'react'
import { normalizeLocale, translate, type LocaleId, type MessageKey } from '../../shared/i18n'

let locale: LocaleId = 'zh-CN'
const listeners = new Set<(next: LocaleId) => void>()

function applyDocument(next: LocaleId): void {
  document.documentElement.lang = next
  document.documentElement.dir = next === 'ar' ? 'rtl' : 'ltr'
  const placeholder = translate(next, 'editorPlaceholder')
  document.querySelectorAll('[data-placeholder]').forEach((node) => node.setAttribute('data-placeholder', placeholder))
  const equation = translate(next, 'eqTitle')
  document.querySelectorAll('.md-equation').forEach((node) => node.setAttribute('title', equation))
}

export function getLocale(): LocaleId {
  return locale
}

export function setAppLocale(value: string | undefined): void {
  const next = normalizeLocale(value)
  locale = next
  applyDocument(next)
  listeners.forEach((listener) => listener(next))
}

export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  return translate(locale, key, vars)
}

export function useI18n(): { t: typeof t; locale: LocaleId } {
  const [current, setCurrent] = useState(locale)
  useEffect(() => subscribeLocale(setCurrent), [])
  return { t, locale: current }
}

function subscribeLocale(listener: (next: LocaleId) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
