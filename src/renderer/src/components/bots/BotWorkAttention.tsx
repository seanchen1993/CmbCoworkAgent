import { ArrowUpRight } from "lucide-react"
import type { BotClient } from "../../../../shared/bots/contracts"
import { botWorkBrowserScope, type BotWorkSummary } from "../../../../shared/bots/work"
import { BotBrowserHelpCard } from "./BotBrowserHelpCard"
import { botWorkStatus } from "@/lib/bot-work-status"

/** Runtime facts, independent of whether the main Bot has produced another reply. */
export function BotWorkAttention({
  client,
  works,
  onWork
}: {
  client: BotClient
  works: BotWorkSummary[]
  onWork(id: string): void
}) {
  const waiting = works.filter(
    (work) =>
      work.state !== "completed" &&
      (work.execution?.waitingFor.length ||
        ["failed", "interrupted", "outcome_unknown"].includes(work.execution?.phase ?? ""))
  )
  if (!waiting.length) return null
  const first =
    waiting.find((work) => work.execution?.waitingFor.some((item) => item.kind === "browser")) ??
    waiting[0]
  const browser = first.execution?.waitingFor.find((item) => item.kind === "browser")
  return (
    <div className="bot-task-attention" aria-live="polite">
      <button onClick={() => onWork(first.id)} className="bot-task-attention-title">
        <span>{first.title}</span>
        <small>{botWorkStatus(first)}</small>
        <ArrowUpRight size={13} />
      </button>
      {browser?.kind === "browser" && (
        <BotBrowserHelpCard
          key={first.id + browser.instruction}
          client={client}
          scopeId={botWorkBrowserScope(first.id, first.botId)}
          instruction={browser.instruction}
        />
      )}
      {waiting
        .filter((work) => work.id !== first.id)
        .map((work) => (
          <button
            key={work.id}
            className="bot-task-attention-title"
            onClick={() => onWork(work.id)}
          >
            <span>{work.title}</span>
            <small>{botWorkStatus(work)}</small>
            <ArrowUpRight size={13} />
          </button>
        ))}
    </div>
  )
}
