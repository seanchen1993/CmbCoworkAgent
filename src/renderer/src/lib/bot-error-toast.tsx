import { toast } from "sonner"
import { BotErrorNoticeBody } from "@/components/bots/BotErrorNoticeBody"
import { botErrorNotice } from "./bot-error-notice"

/** Explicit user actions retain their local retry context. Host execution
 * failures have the separate durable history and bounded notification tray. */
export function reportBotError(error: unknown, fallback = "操作失败"): void {
  const notice = botErrorNotice(error, fallback)
  if (notice.diagnostic)
    toast.error(fallback, {
      description: <BotErrorNoticeBody notice={notice} showRequestId />,
      duration: 10_000
    })
  else toast.error(notice.message)
}
