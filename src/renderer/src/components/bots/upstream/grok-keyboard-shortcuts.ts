/** Grok hotkey matching and editable-target policy; see PROVENANCE. */
export type GlobalShortcutId =
  | "newBot"
  | "jump"
  | "settings"
  | "focusInput"
  | "selectionQuote"
  | "search"
  | "find"
  | "previous"
  | "next"
  | "back"
  | "forward"
  | "tools"
  | "sidebar"
  | `focus${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
export interface GlobalShortcutAction {
  readonly id: GlobalShortcutId
  readonly label: string
  readonly hotkey: string
  readonly isEnabledInContentEditable?: boolean
  readonly run: () => void
}

/** From Grok root-shell-state: reaching an edge does not wrap the selection. */
export function resolveAdjacentAgentId(
  agentIds: readonly string[],
  activeAgentId: string,
  direction: "previous" | "next"
): string | null {
  const activeIndex = agentIds.indexOf(activeAgentId)
  if (activeIndex < 0) return null
  const nextIndex = direction === "previous" ? activeIndex - 1 : activeIndex + 1
  return agentIds[nextIndex] ?? null
}
export interface KeyboardShortcutEvent {
  readonly key: string
  readonly defaultPrevented: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly target?: EventTarget | null
  preventDefault(): void
}

function normalizedKey(key: string): string {
  switch (key.toLowerCase()) {
    case "arrowup":
      return "up"
    case "arrowdown":
      return "down"
    case "[":
      return "bracketleft"
    case "]":
      return "bracketright"
    case ",":
      return "comma"
    default:
      return key.toLowerCase()
  }
}

function editableElement(target: EventTarget | null | undefined): boolean {
  if (target == null || typeof target !== "object") return false
  const value = target as EventTarget & {
    tagName?: unknown
    disabled?: unknown
    type?: unknown
    isContentEditable?: unknown
    matches?: (selector: string) => boolean
  }
  if (value.isContentEditable === true) return true
  if (typeof value.matches === "function") {
    try {
      return value.matches(
        "input:not([type='hidden']):not([disabled]),[contenteditable]:not([contenteditable='false']),textarea:not([disabled])"
      )
    } catch {
      return false
    }
  }
  const tagName = typeof value.tagName === "string" ? value.tagName.toLowerCase() : ""
  if (tagName === "textarea") return value.disabled !== true
  if (tagName === "input") return value.disabled !== true && value.type !== "hidden"
  return false
}

function matchesHotkey(event: KeyboardShortcutEvent, hotkey: string): boolean {
  return hotkey.split(",").some((chord) => matchesChord(event, chord.trim()))
}

function matchesChord(event: KeyboardShortcutEvent, chord: string): boolean {
  const firstChord = chord
  const parts = firstChord.split("+")
  const key = parts.at(-1)
  if (key == null || normalizedKey(event.key) !== key.toLowerCase()) return false
  const wantsMod = parts.includes("mod")
  const wantsAlt = parts.includes("alt")
  const wantsShift = parts.includes("shift")
  if (wantsMod !== (event.metaKey || event.ctrlKey)) return false
  if (wantsAlt !== event.altKey || wantsShift !== event.shiftKey) return false
  return true
}

export function resolveGlobalShortcutAction(
  event: KeyboardShortcutEvent,
  actions: readonly GlobalShortcutAction[]
): GlobalShortcutAction | null {
  if (event.defaultPrevented) return null
  const isEditable = editableElement(event.target)
  return (
    actions.find(
      (action) =>
        (action.isEnabledInContentEditable === true || !isEditable) &&
        matchesHotkey(event, action.hotkey)
    ) ?? null
  )
}
