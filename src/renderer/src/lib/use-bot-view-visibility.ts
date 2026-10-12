import { createContext, useContext } from "react"
import { useAppStore } from "./store"
import { useDocumentVisibility } from "./use-document-visibility"

/** A presentation-only gate; it never grants execution or file permissions. */
export const BotViewVisibilityContext = createContext(true)

/** Keep viewer state mounted while settings cover it, without continuing to
 * capture screenshots or refresh hidden controls. Host work stays independent. */
export function useBotViewVisibility(): boolean {
  const parentVisible = useContext(BotViewVisibilityContext)
  const visible = useDocumentVisibility()
  const settingsOpen = useAppStore((state) => state.showCustomizeView)
  return parentVisible && visible && !settingsOpen
}
