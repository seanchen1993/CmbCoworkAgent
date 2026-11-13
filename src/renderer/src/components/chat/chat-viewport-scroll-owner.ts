export type ChatViewportScrollOwner = "search" | "session-restore" | "history-restore" | "detached"
type Listener = (kind: ChatViewportScrollOwner, active: boolean) => void
interface Owners { leases: Map<ChatViewportScrollOwner, object>; listeners: Set<Listener> }
const viewports = new WeakMap<HTMLElement, Owners>()

function notify(state: Owners, kind: ChatViewportScrollOwner, active: boolean): void {
  // Match DOM event observers: their exception cannot interrupt resource ownership,
  // or prevent a later observer handing restored geometry to the detached reader.
  for (const listener of [...state.listeners]) {
    try { listener(kind, active) } catch { /* Only isolate observer code, after the CAS. */ }
  }
}

function owners(viewport: HTMLElement): Owners {
  let value = viewports.get(viewport)
  if (!value) { value = { leases: new Map(), listeners: new Set() }; viewports.set(viewport, value) }
  return value
}

/** Logical ownership only. Physical native anchor tokens remain independently ref-counted. */
export function claimChatViewportScrollOwner(viewport: HTMLElement, kind: ChatViewportScrollOwner) {
  const state = owners(viewport), token = {}
  state.leases.set(kind, token)
  const current = () => state.leases.get(kind) === token
  notify(state, kind, true)
  return {
    current,
    release(): boolean {
      if (!current()) return false
      state.leases.delete(kind)
      notify(state, kind, false)
      return true
    }
  }
}

export function hasChatViewportScrollOwner(viewport: HTMLElement, kind: ChatViewportScrollOwner): boolean {
  return viewports.get(viewport)?.leases.has(kind) ?? false
}

export function canOwnDetachedChatViewport(viewport: HTMLElement): boolean {
  const leases = viewports.get(viewport)?.leases
  return !leases?.has("search") && !leases?.has("session-restore") && !leases?.has("history-restore")
}

export function subscribeChatViewportScrollOwners(viewport: HTMLElement, listener: Listener): () => void {
  const state = owners(viewport)
  state.listeners.add(listener)
  return () => { state.listeners.delete(listener) }
}
