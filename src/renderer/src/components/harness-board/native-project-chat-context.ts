import { createContext } from "react"
import type { nativeFeatureChatGuide } from "./native-feature-guidance"

export const NativeProjectChatPresence = createContext(false)
export const NativeProjectChatGuideContext = createContext<{
  threadId: string
  guide: NonNullable<ReturnType<typeof nativeFeatureChatGuide>>
  actionLabel: string
  disabled: boolean
  onAction: () => void
} | null>(null)
