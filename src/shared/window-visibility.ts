export const WINDOW_VISIBILITY_READ = "app:window-visibility:read"
export const WINDOW_VISIBILITY_CHANGED = "app:window-visibility:changed"

export interface WindowVisibilitySnapshot {
  revision: number
  visible: boolean
}

export interface WindowVisibilityAPI {
  read(): Promise<WindowVisibilitySnapshot>
  onChanged(callback: (snapshot: WindowVisibilitySnapshot) => void): () => void
}

export function isWindowVisibilitySnapshot(value: unknown): value is WindowVisibilitySnapshot {
  if (!value || typeof value !== "object") return false
  const item = value as WindowVisibilitySnapshot
  return (
    Number.isSafeInteger(item.revision) && item.revision >= 0 && typeof item.visible === "boolean"
  )
}
