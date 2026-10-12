import { useSyncExternalStore } from "react"
import { createWindowVisibilityStore } from "./window-visibility-store"

const visibility = createWindowVisibilityStore(document, window.api?.windowVisibility)
const serverVisible = () => false

/** Window lifecycle only; hiding the UI must never stop the independent Bot Host. */
export function useDocumentVisibility(): boolean {
  return useSyncExternalStore(visibility.subscribe, visibility.getSnapshot, serverVisible)
}
