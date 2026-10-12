import { useEffect } from "react"
import { toast } from "sonner"
import { useAppStore } from "@/lib/store"
import { useBotWorkspaceStore } from "./bot-workspace-store"
import { parseBotDeepLink, type BotDeepLink } from "../../../shared/bot-deep-link"

export function useBotNavigation(): void {
  useEffect(() => {
    if (!window.api.botNavigation) return
    const navigate = (link: BotDeepLink) => {
      useBotWorkspaceStore.setState({ navigation: link })
      useAppStore.getState().setMainView("bots")
    }
    // Subscribe before announcing readiness; the main process then flushes its bounded queue.
    const unsubscribe = window.api.botNavigation.onOpen(navigate)
    void window.api.botNavigation.ready().catch(() => toast.error("消息定位服务暂不可用"))
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || !(event.target instanceof Element)) return
      const href = event.target.closest("a")?.getAttribute("href")
      if (!href?.toLowerCase().startsWith("cmbcowork:")) return
      event.preventDefault()
      const parsed = parseBotDeepLink(href)
      if (parsed) navigate(parsed.link)
      else toast.error("消息定位链接无效")
    }
    document.addEventListener("click", click, true)
    return () => {
      unsubscribe()
      document.removeEventListener("click", click, true)
    }
  }, [])
}
