import { createI18n } from 'vue-i18n'
import en from './messages/en'
import zhCN from './messages/zh-CN'

export const LOCALE_STORAGE_KEY = 'mps.locale'

const normalizeLocale = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (raw.toLowerCase().startsWith('zh')) return 'zh-CN'
  if (raw.toLowerCase().startsWith('en')) return 'en'
  return raw
}

const detectLocale = () => {
  try {
    const saved = normalizeLocale(localStorage.getItem(LOCALE_STORAGE_KEY))
    if (saved) return saved
  } catch (_) {}

  const nav = normalizeLocale(navigator.language || navigator.userLanguage || '')
  if (nav) return nav
  return 'en'
}

export const i18n = createI18n({
  legacy: false,
  locale: detectLocale(),
  fallbackLocale: 'en',
  messages: {
    en,
    'zh-CN': zhCN
  }
})

export const setLocale = (nextLocale) => {
  const normalized = normalizeLocale(nextLocale) || 'en'
  i18n.global.locale.value = normalized
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, normalized)
  } catch (_) {}
}

export const getLocale = () => i18n.global.locale.value

