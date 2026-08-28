import {
  CSS_VARIABLE_BY_PALETTE_KEY,
  DEFAULT_THEME_ID,
  getThemeDefinition,
  normalizeThemeId,
  type ThemeId,
  type ThemePalette
} from "./theme-registry"

export type ThemePreference = ThemeId

const THEME_PREFERENCE_STORAGE_KEY = "cmb:theme-preference"
const THEME_PREFERENCE_CHANGED_EVENT = "cmb:theme-preference-changed"
let volatileThemePreference: ThemePreference | null = null
let volatileThemeWindow: Window | null = null

export function getThemePreference(): ThemePreference {
  if (typeof window === "undefined") return DEFAULT_THEME_ID
  if (volatileThemeWindow === window && volatileThemePreference) {
    return volatileThemePreference
  }
  try {
    const storedTheme = window.localStorage.getItem(THEME_PREFERENCE_STORAGE_KEY)
    return normalizeThemeId(storedTheme) ?? DEFAULT_THEME_ID
  } catch {
    return DEFAULT_THEME_ID
  }
}

export function applyThemePreference(theme: ThemePreference): void {
  if (typeof document === "undefined") return
  const definition = getThemeDefinition(theme)
  const root = document.documentElement

  for (const [paletteKey, cssVariable] of Object.entries(CSS_VARIABLE_BY_PALETTE_KEY) as Array<
    [keyof ThemePalette, `--${string}`]
  >) {
    root.style.setProperty(cssVariable, definition.palette[paletteKey])
  }

  root.dataset.theme = definition.id
  root.dataset.colorScheme = definition.colorScheme
  root.classList.toggle("dark", definition.colorScheme === "dark")
  root.style.colorScheme = definition.colorScheme
}

export function setThemePreference(theme: ThemePreference): void {
  try {
    if (theme === DEFAULT_THEME_ID) {
      window.localStorage.removeItem(THEME_PREFERENCE_STORAGE_KEY)
    } else {
      window.localStorage.setItem(THEME_PREFERENCE_STORAGE_KEY, theme)
    }
    volatileThemePreference = null
    volatileThemeWindow = null
  } catch {
    volatileThemePreference = theme
    volatileThemeWindow = window
  }
  applyThemePreference(theme)
  window.dispatchEvent(new Event(THEME_PREFERENCE_CHANGED_EVENT))
}

export function subscribeThemePreference(onStoreChange: () => void): () => void {
  const handlePreferenceChange = (): void => onStoreChange()
  const handleStorageChange = (event: StorageEvent): void => {
    if (event.key !== THEME_PREFERENCE_STORAGE_KEY) return
    volatileThemePreference = null
    volatileThemeWindow = null
    applyThemePreference(normalizeThemeId(event.newValue) ?? DEFAULT_THEME_ID)
    onStoreChange()
  }

  window.addEventListener(THEME_PREFERENCE_CHANGED_EVENT, handlePreferenceChange)
  window.addEventListener("storage", handleStorageChange)
  return () => {
    window.removeEventListener(THEME_PREFERENCE_CHANGED_EVENT, handlePreferenceChange)
    window.removeEventListener("storage", handleStorageChange)
  }
}
