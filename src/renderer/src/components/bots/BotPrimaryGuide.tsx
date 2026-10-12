import type { ReactNode } from "react"
import { Star } from "lucide-react"
import { Button } from "@/components/ui/button"
import { BotAvatar } from "./BotAvatar"

/** Shared first-use surface. Opening or rendering it never creates a Bot or
 * changes its role; both choices continue through the protected settings flow. */
export function BotPrimaryGuide({
  botCount,
  disabled,
  create,
  choose,
  footer
}: {
  botCount: number
  disabled: boolean
  create(): void
  choose(): void
  footer?: ReactNode
}) {
  return (
    <section
      aria-label="主 Bot 首次引导"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-6 py-10 text-center"
    >
      <div className="relative">
        <BotAvatar agentId="cmb-welcome" size="xl" state="happy" isFollowingPointer />
        <span
          aria-hidden="true"
          className="absolute bottom-0 right-0 flex size-7 items-center justify-center rounded-full border-2 border-background bg-amber-500 text-white"
        >
          <Star size={14} className="fill-current" />
        </span>
      </div>
      <div className="space-y-2">
        <h2 className="text-xl font-medium">先选一位主 Bot</h2>
        <p className="mx-auto max-w-md text-sm leading-relaxed text-muted-foreground">
          向主 Bot 交办目标，由它联系其他 Bot、核对结果，并向你汇报进展。
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button className="rounded-full px-5" disabled={disabled} onClick={create}>
          <Star size={16} />
          创建主 Bot
        </Button>
        {botCount > 0 && (
          <Button
            variant="outline"
            className="rounded-full px-5"
            disabled={disabled}
            onClick={choose}
          >
            选择现有 Bot
          </Button>
        )}
      </div>
      {footer}
    </section>
  )
}
