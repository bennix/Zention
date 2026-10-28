import { normalizeLocale, type LocaleId } from '../shared/i18n'

let localeCache: LocaleId = 'zh-CN'

export function currentLocale(): LocaleId {
  return localeCache
}

export function setCurrentLocale(value: string | undefined | null): LocaleId {
  localeCache = normalizeLocale(value)
  return localeCache
}
