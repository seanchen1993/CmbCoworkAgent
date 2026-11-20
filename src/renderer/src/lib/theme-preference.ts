import {
  CSS_VARIABLE_BY_PALETTE_KEY,
  DEFAULT_THEME_ID,
  getThemeDefinition,
  normalizeThemeId,
  type ThemeColorScheme,
  type ThemeId,
  type ThemePalette
} from "./theme-registry"

export type ThemePreference = ThemeId
export type ThemeModePreference = "system" | ThemeColorScheme

interface ThemeSettings {
  mode: ThemeModePreference
  lightTheme: ThemeId
  darkTheme: ThemeId
}

const DEFAULT_DARK_THEME_ID: ThemeId = "codex-dark"
const LEGACY_THEME_PREFERENCE_STORAGE_KEY = "cmb:theme-preference"
const THEME_SETTINGS_STORAGE_KEY = "cmb:theme-settings"
const THEME_PREFERENCE_CHANGED_EVENT = "cmb:theme-preference-changed"
const SYSTEM_DARK_MODE_QUERY = "(prefers-color-scheme: dark)"
const DEFAULT_THEME_SETTINGS: ThemeSettings = {
  mode: "light",
  lightTheme: DEFAULT_THEME_ID,
  darkTheme: DEFAULT_DARK_THEME_ID
}

let volatileThemeSettings: ThemeSettings | null = null
let volatileThemeWindow: Window | null = null
let synchronizedWindow: Window | null = null
let stopThemeSynchronization: (() => void) | null = null

function normalizeThemeForScheme(
  value: unknown,
  colorScheme: ThemeColorScheme,
  fallback: ThemeId
): ThemeId {
  if (typeof value !== "string") return fallback
  const theme = normalizeThemeId(value)
  return theme && getThemeDefinition(theme).colorScheme === colorScheme ? theme : fallback
}

function normalizeThemeMode(value: unknown): ThemeModePreference | null {
  return value === "system" || value === "light" || value === "dark" ? value : null
}

function parseThemeSettings(value: string | null): ThemeSettings | null {
  if (!value) return null
  try {
    const candidate = JSON.parse(value) as Partial<ThemeSettings>
    const mode = normalizeThemeMode(candidate.mode)
    if (!mode) return null
    return {
      mode,
      lightTheme: normalizeThemeForScheme(
        candidate.lightTheme,
        "light",
        DEFAULT_THEME_SETTINGS.lightTheme
      ),
      darkTheme: normalizeThemeForScheme(
        candidate.darkTheme,
        "dark",
        DEFAULT_THEME_SETTINGS.darkTheme
      )
    }
  } catch {
    return null
  }
}

function settingsFromLegacyTheme(theme: ThemeId | null): ThemeSettings {
  if (!theme) return DEFAULT_THEME_SETTINGS
  const definition = getThemeDefinition(theme)
  return definition.colorScheme === "dark"
    ? { ...DEFAULT_THEME_SETTINGS, mode: "dark", darkTheme: theme }
    : { ...DEFAULT_THEME_SETTINGS, mode: "light", lightTheme: theme }
}

function getThemeSettings(): ThemeSettings {
  if (typeof window === "undefined") return DEFAULT_THEME_SETTINGS
  if (volatileThemeWindow === window && volatileThemeSettings) return volatileThemeSettings

  try {
    const storedSettings = parseThemeSettings(
      window.localStorage.getItem(THEME_SETTINGS_STORAGE_KEY)
    )
    if (storedSettings) return storedSettings
    const legacyTheme = normalizeThemeId(
      window.localStorage.getItem(LEGACY_THEME_PREFERENCE_STORAGE_KEY)
    )
    return settingsFromLegacyTheme(legacyTheme)
  } catch {
    return DEFAULT_THEME_SETTINGS
  }
}

function systemColorScheme(): ThemeColorScheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light"
  return window.matchMedia(SYSTEM_DARK_MODE_QUERY).matches ? "dark" : "light"
}

function resolveThemePreference(settings: ThemeSettings): ThemePreference {
  const colorScheme = settings.mode === "system" ? systemColorScheme() : settings.mode
  return colorScheme === "dark" ? settings.darkTheme : settings.lightTheme
}

function notifyThemePreferenceChanged(): void {
  window.dispatchEvent(new Event(THEME_PREFERENCE_CHANGED_EVENT))
}

function persistThemeSettings(settings: ThemeSettings): void {
  try {
    window.localStorage.setItem(THEME_SETTINGS_STORAGE_KEY, JSON.stringify(settings))
    volatileThemeSettings = null
    volatileThemeWindow = null
  } catch {
    volatileThemeSettings = settings
    volatileThemeWindow = window
  }
  applyThemePreference(resolveThemePreference(settings))
  notifyThemePreferenceChanged()
}

function ensureThemeSynchronization(): void {
  if (typeof window === "undefined" || synchronizedWindow === window) return
  stopThemeSynchronization?.()
  synchronizedWindow = window

  const mediaQuery =
    typeof window.matchMedia === "function" ? window.matchMedia(SYSTEM_DARK_MODE_QUERY) : null
  const handleStorageChange = (event: StorageEvent): void => {
    if (
      event.key !== THEME_SETTINGS_STORAGE_KEY &&
      event.key !== LEGACY_THEME_PREFERENCE_STORAGE_KEY &&
      event.key !== null
    ) {
      return
    }
    volatileThemeSettings = null
    volatileThemeWindow = null
    applyThemePreference(getThemePreference())
    notifyThemePreferenceChanged()
  }
  const handleSystemThemeChange = (): void => {
    if (getThemeModePreference() !== "system") return
    applyThemePreference(getThemePreference())
    notifyThemePreferenceChanged()
  }

  window.addEventListener("storage", handleStorageChange)
  mediaQuery?.addEventListener("change", handleSystemThemeChange)
  stopThemeSynchronization = () => {
    synchronizedWindow?.removeEventListener("storage", handleStorageChange)
    mediaQuery?.removeEventListener("change", handleSystemThemeChange)
  }
}

export function getThemePreference(): ThemePreference {
  return resolveThemePreference(getThemeSettings())
}

export function getThemeModePreference(): ThemeModePreference {
  return getThemeSettings().mode
}

export function getLightThemePreference(): ThemeId {
  return getThemeSettings().lightTheme
}

export function getDarkThemePreference(): ThemeId {
  return getThemeSettings().darkTheme
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
  const definition = getThemeDefinition(theme)
  const settings = getThemeSettings()
  persistThemeSettings({
    ...settings,
    mode: definition.colorScheme,
    [definition.colorScheme === "dark" ? "darkTheme" : "lightTheme"]: definition.id
  })
}

export function setThemeForColorScheme(theme: ThemePreference): void {
  const definition = getThemeDefinition(theme)
  const settings = getThemeSettings()
  persistThemeSettings({
    ...settings,
    [definition.colorScheme === "dark" ? "darkTheme" : "lightTheme"]: definition.id
  })
}

export function setThemeModePreference(mode: ThemeModePreference): void {
  persistThemeSettings({ ...getThemeSettings(), mode })
}

export function subscribeThemePreference(onStoreChange: () => void): () => void {
  ensureThemeSynchronization()
  window.addEventListener(THEME_PREFERENCE_CHANGED_EVENT, onStoreChange)
  return () => window.removeEventListener(THEME_PREFERENCE_CHANGED_EVENT, onStoreChange)
}

export function initializeThemePreference(): void {
  ensureThemeSynchronization()
  applyThemePreference(getThemePreference())
}
