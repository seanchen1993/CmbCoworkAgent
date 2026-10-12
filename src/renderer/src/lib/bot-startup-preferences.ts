import { botInspectorPreferenceScope } from "./bot-inspector-preferences"

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">
type ScopeSelection = { scope: string; conversationId: string }
const viewKey = "cmb-last-primary-workspace"
const selectionKey = "cmb-bot-startup-selection"
const maximumScopes = 8
const maximumCharacters = 40 * 1024
const conversationId = (value: unknown): value is string =>
  typeof value === "string" && /^[\w:.-]{1,160}$/.test(value)

/** Layout identity only: a process restart preserves it; a data replacement does not. */
export function botStartupPreferenceScope(
  sharedWorkspace: unknown,
  dataEpoch: unknown
): string | null {
  const workspace = botInspectorPreferenceScope(sharedWorkspace)
  return workspace && conversationId(dataEpoch) ? JSON.stringify([workspace, dataEpoch]) : null
}

/** A bounded layout preference, never task state or permission. The live store
 * validates the saved conversation against its current authoritative roster. */
export function createBotStartupPreferences(storage: () => PreferenceStorage = () => localStorage) {
  const readSelections = (): ScopeSelection[] => {
    try {
      const raw = storage().getItem(selectionKey)
      if (!raw || raw.length > maximumCharacters) return []
      const value: unknown = JSON.parse(raw)
      if (!value || typeof value !== "object" || Array.isArray(value)) return []
      const record = value as Record<string, unknown>
      if (record.version !== 1 || !Array.isArray(record.scopes)) return []
      if (record.scopes.length > maximumScopes) return []
      const rows = new Map<string, ScopeSelection>()
      for (const item of record.scopes) {
        if (!item || typeof item !== "object" || Array.isArray(item)) return []
        const row = item as Record<string, unknown>
        if (
          typeof row.scope !== "string" ||
          row.scope.length > 4300 ||
          !conversationId(row.conversationId)
        )
          return []
        rows.delete(row.scope)
        rows.set(row.scope, { scope: row.scope, conversationId: row.conversationId })
      }
      return [...rows.values()]
    } catch {
      return []
    }
  }
  return {
    mainView(): "bots" | "thread" {
      try {
        return storage().getItem(viewKey) === "bots" ? "bots" : "thread"
      } catch {
        return "thread"
      }
    },
    rememberMainView(view: string): void {
      if (view !== "bots" && view !== "thread") return
      try {
        if (storage().getItem(viewKey) !== view) storage().setItem(viewKey, view)
      } catch {
        // A failed layout write must not block live navigation.
      }
    },
    conversation(scope: string | null): string | null {
      return scope
        ? (readSelections().find((row) => row.scope === scope)?.conversationId ?? null)
        : null
    },
    rememberConversation(scope: string | null, id: string): void {
      if (!scope || scope.length > 4300 || !conversationId(id)) return
      try {
        const previous = readSelections()
        if (previous.find((row) => row.scope === scope)?.conversationId === id) return
        const scopes = previous.filter((row) => row.scope !== scope).slice(-(maximumScopes - 1))
        const raw = JSON.stringify({
          version: 1,
          scopes: [...scopes, { scope, conversationId: id }]
        })
        if (raw.length <= maximumCharacters) storage().setItem(selectionKey, raw)
      } catch {
        // Selection and unsent drafts remain owned by the existing live store.
      }
    }
  }
}

export const botStartupPreferences = createBotStartupPreferences()
