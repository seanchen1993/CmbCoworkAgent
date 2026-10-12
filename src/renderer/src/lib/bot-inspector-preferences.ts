export type BotInspectorPreferenceTab = "details" | "library" | "computer"
export interface BotInspectorPreferences {
  fallback: BotInspectorPreferenceTab
  tabs: readonly (readonly [string, BotInspectorPreferenceTab])[]
}
type PreferenceStorage = Pick<Storage, "getItem" | "setItem">
interface ScopePreferences extends BotInspectorPreferences {
  scope: string
}
const storageKey = "cmb-bot-inspector-tabs"
const maximumScopes = 8
const maximumBots = 128
const maximumCharacters = 256 * 1024
const defaultPreferences = (): BotInspectorPreferences => ({ fallback: "details", tabs: [] })
const tab = (value: unknown): value is BotInspectorPreferenceTab =>
  value === "details" || value === "library" || value === "computer"
const botId = (value: unknown): value is string =>
  typeof value === "string" && /^[\w:.-]{1,160}$/.test(value)
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Existing Host-owned managed workspace path is stable across process restarts.
 * Unknown/old Hosts get memory-only layout; neither hostId nor login tokens scope storage. */
export function botInspectorPreferenceScope(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    !value.includes("\0")
    ? value
    : null
}
export function resolveBotInspectorPreference(
  preferences: BotInspectorPreferences,
  id: string
): BotInspectorPreferenceTab {
  return preferences.tabs.find(([key]) => key === id)?.[1] ?? preferences.fallback
}

/** Small layout codec, not an authority or a second Bot domain store. Reads never
 * repair malformed storage. The caller owns its live cache and complete-roster proof. */
export function createBotInspectorPreferences(
  storage: () => PreferenceStorage = () => localStorage
) {
  const readAll = (): ScopePreferences[] => {
    try {
      const raw = storage().getItem(storageKey)
      if (!raw || raw.length > maximumCharacters) return []
      const value: unknown = JSON.parse(raw)
      if (!record(value) || value.version !== 1 || !Array.isArray(value.scopes)) return []
      if (value.scopes.length > maximumScopes) return []
      const scopes = new Map<string, ScopePreferences>()
      for (const item of value.scopes) {
        if (
          !record(item) ||
          !botInspectorPreferenceScope(item.scope) ||
          !tab(item.fallback) ||
          !Array.isArray(item.tabs) ||
          item.tabs.length > maximumBots
        )
          return []
        const tabs = new Map<string, BotInspectorPreferenceTab>()
        for (const pair of item.tabs) {
          if (!Array.isArray(pair) || pair.length !== 2 || !botId(pair[0]) || !tab(pair[1]))
            return []
          tabs.delete(pair[0])
          tabs.set(pair[0], pair[1])
        }
        const scope = String(item.scope)
        scopes.delete(scope)
        scopes.set(scope, { scope, fallback: item.fallback, tabs: [...tabs] })
      }
      return [...scopes.values()]
    } catch {
      // Layout remains usable when browser storage is unavailable.
      return []
    }
  }
  const save = (scope: string | null, preferences: BotInspectorPreferences): void => {
    if (!scope || !botInspectorPreferenceScope(scope)) return
    try {
      const others = readAll()
        .filter((item) => item.scope !== scope)
        .slice(-(maximumScopes - 1))
      const raw = JSON.stringify({ version: 1, scopes: [...others, { scope, ...preferences }] })
      if (raw.length <= maximumCharacters) storage().setItem(storageKey, raw)
    } catch {
      // The caller retains the new live preference even if persistence fails.
    }
  }
  return {
    read(scope: string | null): BotInspectorPreferences {
      if (!scope || !botInspectorPreferenceScope(scope)) return defaultPreferences()
      const found = readAll().find((item) => item.scope === scope)
      return found ? { fallback: found.fallback, tabs: found.tabs } : defaultPreferences()
    },
    /** Explicit tab clicks alone update both this Bot and the global fallback.
     * Reveals/navigation just resolve, so their temporary tab cannot change history. */
    remember(
      scope: string | null,
      previous: BotInspectorPreferences,
      id: string,
      selected: BotInspectorPreferenceTab
    ): BotInspectorPreferences {
      if (!botId(id) || !tab(selected)) return previous
      if (
        previous.fallback === selected &&
        previous.tabs.find(([key]) => key === id)?.[1] === selected
      )
        return previous
      const tabs = previous.tabs.filter(([key]) => key !== id).slice(-(maximumBots - 1))
      const next: BotInspectorPreferences = { fallback: selected, tabs: [...tabs, [id, selected]] }
      save(scope, next)
      return next
    },
    /** Only call with an acknowledged full live roster. No missing scope/null snapshot cleanup. */
    prune(
      scope: string | null,
      previous: BotInspectorPreferences,
      liveIds: ReadonlySet<string>
    ): BotInspectorPreferences {
      const tabs = previous.tabs.filter(([id]) => liveIds.has(id))
      if (tabs.length === previous.tabs.length) return previous
      const next = { ...previous, tabs }
      save(scope, next)
      return next
    }
  }
}
export const botInspectorPreferences = createBotInspectorPreferences()
