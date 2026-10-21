import { RefreshCw } from "lucide-react"
import { flowFollowUp } from "../../../../shared/mods/flows/follow-up"
import { flowRunnableInCatalog } from "../../../../shared/mods/flows/schema"
import { Button } from "@/components/ui/button"
import { useAppStore } from "@/lib/store"
import type { ChatFlowController } from "@/lib/use-chat-flow"
import { FlowRunView } from "../customize/FlowRunView"

/** Chooses the next message's steps. The chat composer is the only task input and submit. */
export function ChatFlowControls({
  flow,
  disabled,
  onFollowUp,
  showRun = true
}: {
  flow: ChatFlowController
  disabled: boolean
  onStart?(goal: string): Promise<boolean>
  onFollowUp?(text: string): void
  showRun?: boolean
}) {
  if (!flow.enabled && !flow.choice && !flow.run) return null
  const catalog = "catalog" in flow ? flow.catalog : undefined
  const binding = "binding" in flow ? flow.binding : undefined
  return (
    <div className="space-y-3" data-chat-flow>
      {flow.workspaceActive && flow.workspaceActive.threadId !== flow.threadId && (
        <div role="status" className="space-y-2 text-sm">
          <p>本项目正在运行“{flow.workspaceActive.flowName}”。本次输入会保留，请先处理该任务。</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void flow.openActive()}>
            前往任务所在聊天
          </Button>
        </div>
      )}
      <label className="block space-y-2 text-sm">
        <span className="font-medium">本次消息使用的步骤</span>
        <select
          aria-label="本次使用的步骤"
          className="devclaw-select min-w-0 w-full flex-1 text-sm"
          value={
            flow.choice?.bindingRevision !== undefined
              ? `claw:${flow.choice.bindingRevision}`
              : flow.choice
                ? `${flow.choice.id}:${flow.choice.revision}`
                : ""
          }
          disabled={disabled || flow.busy || flow.active || !flow.enabled}
          onChange={(event) => flow.choose(event.target.value)}
        >
          <option value="">普通聊天，不使用步骤</option>
          {binding?.active?.flow && (
            <option value={`claw:${binding.bindingRevision}`}>
              {binding.active.name} · 已应用步骤
            </option>
          )}
          {flow.choice &&
            flow.choice.bindingRevision === undefined &&
            !flow.flows.some(
              (item) =>
                item.definition.id === flow.choice!.id && item.revision === flow.choice!.revision
            ) && (
              <option value={`${flow.choice.id}:${flow.choice.revision}`} disabled>
                {flow.choice.name} · 待读取
              </option>
            )}
          {flow.flows.map((saved) => {
            const authorized = flowRunnableInCatalog(saved.definition, catalog)
            return (
              <option
                key={saved.definition.id}
                value={`${saved.definition.id}:${saved.revision}`}
                disabled={!authorized}
              >
                {saved.definition.name}
                {authorized ? "" : "（需开启或授权）"}
              </option>
            )
          })}
        </select>
      </label>
      <p className="text-xs text-muted-foreground">
        仅用于下一条任务。回到聊天输入内容并发送；选择本身不会执行。
      </p>
      <div className="flex flex-wrap gap-2">
        {flow.choice && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={flow.busy}
            onClick={flow.clear}
          >
            取消本次选择
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            useAppStore.getState().setRightPanelCollapsed(true)
            document.querySelector<HTMLTextAreaElement>("textarea.composer-textarea")?.focus()
          }}
        >
          到聊天输入任务
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={flow.busy || flow.loading || !flow.enabled}
          onClick={() => void flow.load()}
        >
          <RefreshCw className="mr-1 size-3.5" aria-hidden="true" />
          {flow.loading ? "正在加载" : "重新加载步骤"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => useAppStore.getState().setShowCustomizeView(true, "flows")}
        >
          管理聊天任务模板
        </Button>
      </div>
      {!flow.flows.length && !binding?.active?.flow && !flow.loading && (
        <p className="text-xs text-muted-foreground">
          暂无已保存步骤，可先管理聊天任务模板；普通聊天可直接发送。
        </p>
      )}
      {!flow.enabled && flow.choice && (
        <p role="alert" className="text-sm text-destructive">
          本次步骤暂不可用。请核对灵件功能，或取消选择后普通发送；输入已保留。
        </p>
      )}
      {flow.error && (
        <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">
          {flow.error}
        </p>
      )}
      {showRun && <ChatFlowRun flow={flow} disabled={disabled} onFollowUp={onFollowUp} />}
    </div>
  )
}

/** One owner for approvals and recovery, also visible after a failed run. */
export function ChatFlowRun({
  flow,
  disabled,
  onFollowUp,
  presentation
}: {
  flow: ChatFlowController
  disabled: boolean
  onFollowUp?(text: string): void
  presentation?: "full" | "task"
}) {
  if (!flow.run) return null
  return (
    <div className="space-y-3" data-chat-flow-run>
      <FlowRunView
        run={flow.run}
        busy={flow.busy}
        decisionsDisabled={!flow.enabled}
        stopping={flow.stopping}
        presentation={presentation}
        onResumed={(next) => flow.acceptResumed(flow.run!.id, next)}
        onCancel={() => void flow.act("cancel")}
        onDecide={(nonce, approve) =>
          void flow.act(approve ? "approve" : "reject", { runId: flow.run!.id, nonce })
        }
      />
      {onFollowUp && !flow.active && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onFollowUp(flowFollowUp(flow.run!))}
        >
          继续处理这个任务
        </Button>
      )}
    </div>
  )
}
