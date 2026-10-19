import { useEffect } from "react"
import { toast } from "sonner"
import type { BotClient, BotConversationActivity } from "../../../../shared/bots/contracts"

/** Acknowledge only the version actually presented in a visible, focused conversation. */
export function useBotReadState(client: BotClient, activity: BotConversationActivity | undefined) {
  useEffect(() => {
    if (!activity?.unread) return
    let disposed = false,
      pending = false,
      acknowledged = false
    const acknowledge = () => {
      if (disposed || pending || acknowledged || document.hidden || !document.hasFocus()) return
      pending = true
      void client
        .markRead(activity.kind, activity.id, activity.version)
        .then(
          () => {
            acknowledged = true
          },
          () => {
            if (!disposed) toast.error("未能保存已读状态，返回此会话时会重试。")
          }
        )
        .finally(() => {
          pending = false
        })
    }
    window.addEventListener("focus", acknowledge)
    document.addEventListener("visibilitychange", acknowledge)
    acknowledge()
    return () => {
      disposed = true
      window.removeEventListener("focus", acknowledge)
      document.removeEventListener("visibilitychange", acknowledge)
    }
  }, [client, activity?.kind, activity?.id, activity?.version, activity?.unread])
}
