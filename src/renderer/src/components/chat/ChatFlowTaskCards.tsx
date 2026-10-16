import { memo, useState } from "react"
import type { ChatFlowController } from "@/lib/use-chat-flow"
import { FlowRunView } from "../customize/FlowRunView"
import { FlowNativeApprovalHint } from "../customize/FlowNativeApprovalHint"
import { flowFollowUp } from "../../../../shared/mods/flows/follow-up"
import type { FlowRun } from "../../../../shared/mods/flows/types"

export type ChatFlowTaskState = Pick<
  ChatFlowController,
  | "threadId"
  | "run"
  | "recentRuns"
  | "busy"
  | "enabled"
  | "stopping"
  | "active"
  | "error"
  | "act"
  | "acceptResumed"
>

/** Native runs update in place by run.id; they never append synthetic assistant messages. */
export const ChatFlowTaskCards = memo(function ChatFlowTaskCards({
  flow,
  onFollowUp
}: {
  flow: ChatFlowTaskState
  onFollowUp(text: string): void
}) {
  const runs = flow.recentRuns?.length ? flow.recentRuns : flow.run ? [flow.run] : []
  return (
    <section
      aria-label={runs.length ? "聊天任务与成果" : undefined}
      className="space-y-3"
      data-chat-flow-tasks
    >
      {flow.error && (
        <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">
          {flow.error}
        </p>
      )}
      <FlowNativeApprovalHint threadId={flow.threadId} active={flow.active} />
      {runs.map((run) => (
        <ChatFlowTaskCard key={run.id} run={run} flow={flow} onFollowUp={onFollowUp} />
      ))}
    </section>
  )
})

function ChatFlowTaskCard({
  run,
  flow,
  onFollowUp
}: {
  run: FlowRun
  flow: ChatFlowTaskState
  onFollowUp(text: string): void
}) {
  const current = flow.run?.id === run.id
  const [expanded, setExpanded] = useState(false)
  const content = (
    <FlowRunView
      run={run}
      presentation="task"
      busy={flow.busy || !current}
      decisionsDisabled={!flow.enabled}
      stopping={current && flow.stopping}
      onCancel={() => {
        if (current) void flow.act("cancel")
      }}
      onDecide={(nonce, approve) => {
        if (current) void flow.act(approve ? "approve" : "reject", { runId: run.id, nonce })
      }}
      onResumed={current ? (next) => flow.acceptResumed(run.id, next) : undefined}
    />
  )
  return (
    <article data-chat-task-id={run.id} className="space-y-2">
      {current ? (
        content
      ) : (
        <details
          onToggle={(event) => setExpanded(event.currentTarget.open)}
          className="rounded-lg border p-3"
        >
          <summary className="cursor-pointer text-sm font-medium">
            {(run.taskGoal ?? run.flow.definition.goal).slice(0, 80)} · {run.flow.definition.name} ·{" "}
            {run.status === "complete"
              ? "已完成"
              : run.status === "cancelled"
                ? "已停止"
                : "查看任务结果"}
          </summary>
          {expanded && <div className="mt-3">{content}</div>}
        </details>
      )}
      {!["queued", "running", "waiting"].includes(run.status) && (
        <button
          type="button"
          className="rounded-lg border px-3 py-2 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onFollowUp(flowFollowUp(run))}
        >
          继续处理这个任务
        </button>
      )}
    </article>
  )
}
