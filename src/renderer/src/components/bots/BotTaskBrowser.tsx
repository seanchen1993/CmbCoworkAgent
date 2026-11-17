import { useState } from "react"
import { ArrowUpRight } from "lucide-react"
import type { BotClient } from "../../../../shared/bots/contracts"
import { botWorkBrowserScope, type BotWorkSummary } from "../../../../shared/bots/work"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { BotBrowserPanel } from "./BotBrowserPanel"
import { botWorkStatus } from "@/lib/bot-work-status"

/** Only the selected owner mounts a preview; task choice never changes page ownership. */
export function BotTaskBrowser({
  client,
  botId,
  mainScope,
  works,
  selectedWork,
  onWork
}: {
  client: BotClient
  botId: string
  mainScope: string
  works: BotWorkSummary[]
  selectedWork?: BotWorkSummary | null
  onWork(id: string): void
}) {
  const [chosen, setChosen] = useState("main")
  const work = selectedWork ?? works.find((item) => item.id === chosen)
  const scope = work ? botWorkBrowserScope(work.id, botId) : mainScope
  return (
    <>
      {!selectedWork && works.length > 0 && (
        <div className="px-5 pt-4">
          <Select value={work?.id ?? "main"} onValueChange={setChosen}>
            <SelectTrigger aria-label="查看任务浏览器" className="rounded-xl shadow-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent data-bot-popup className="bot-workspace-select rounded-xl">
              <SelectItem value="main">主对话的浏览器</SelectItem>
              {works
                .filter((item) => !item.source || item.source.transport === "im")
                .map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.title}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          {work && (
            <button
              className="mt-2 flex items-center gap-1 text-xs text-muted-foreground"
              onClick={() => onWork(work.id)}
            >
              {botWorkStatus(work)} · 打开任务
              <ArrowUpRight size={12} />
            </button>
          )}
        </div>
      )}
      <BotBrowserPanel key={scope} botId={scope} client={client} />
    </>
  )
}
