export interface BrowserPageConfirmation {
  id: string
  title?: string
  confirmLabel?: string
  busyLabel?: string
  secondaryAction?: { label: string; onConfirm: () => void }
  activeAction?: "primary" | "secondary"
  restrictedLabel?: string
  cancelLabel?: string
  phase: "opening" | "ready" | "capturing"
  message: string
  error?: string
  restricted?: boolean
  onConfirm: () => void
  onConfirmRestricted: () => void
  onCancel: () => void
  onEditUrl: () => void
}

let confirmation: BrowserPageConfirmation | null = null
const listeners = new Set<() => void>()

export const getBrowserPageConfirmation = () => confirmation
export function subscribeBrowserPageConfirmation(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function setBrowserPageConfirmation(next: BrowserPageConfirmation): void {
  confirmation = next
  for (const listener of listeners) listener()
}

export function updateBrowserPageConfirmation(
  id: string,
  patch: Partial<BrowserPageConfirmation>
): void {
  if (confirmation?.id !== id) return
  setBrowserPageConfirmation({ ...confirmation, ...patch, id })
}

export function clearBrowserPageConfirmation(id: string): void {
  if (confirmation?.id !== id) return
  confirmation = null
  for (const listener of listeners) listener()
}
