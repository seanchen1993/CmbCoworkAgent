import { GitBranch, RefreshCw } from "lucide-react"
import { flowFollowUp } from "../../../../shared/mods/flows/follow-up"
import { flowRunnableInCatalog } from "../../../../shared/mods/flows/schema"
import { Button } from "@/components/ui/button"
import { useAppStore } from "@/lib/store"
import type { ChatFlowController } from "@/lib/use-chat-flow"
import { FlowRunView } from "../customize/FlowRunView"

export function ChatFlowControls({
  flow,
  disabled,
  onFollowUp,
  showRun = true
}: {
  flow: ChatFlowController
  disabled: boolean
  onFollowUp?(text: string): void
  showRun?: boolean
}) {
  if (!flow.enabled && !flow.choice) return null
  const catalog = "catalog" in flow ? flow.catalog : undefined
  const binding = "binding" in flow ? flow.binding : undefined
  return (
    <div className="space-y-4" data-chat-flow>
      <details open>
        <summary className="flex cursor-pointer items-center gap-2 text-sm">
          <GitBranch className="size-4 text-primary" aria-hidden="true" />
          {flow.choice ? `已选步骤：${flow.choice.name}` : "选择一套步骤"}
        </summary>
        <div className="mt-3 space-y-2 border-t pt-3">
          <div className="flex flex-wrap gap-2">
            <select
              aria-label="本次使用的步骤"
              className="min-w-0 flex-1 rounded-lg border bg-background px-3 py-2 text-sm"
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
              <option value="">不选择流程</option>
              {binding?.active?.flow && (
                <option value={`claw:${binding.bindingRevision}`}>
                  {binding.active.name} · 已应用流程
                </option>
              )}
              {flow.choice &&
                flow.choice.bindingRevision === undefined &&
                !flow.flows.some(
                  (item) =>
                    item.definition.id === flow.choice!.id &&
                    item.revision === flow.choice!.revision
                ) && (
                  <option value={`${flow.choice.id}:${flow.choice.revision}`} disabled>
                    {flow.choice.name}
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
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={flow.busy || flow.loading || !flow.enabled}
              onClick={() => {
                void flow.load()
              }}
            >
              <RefreshCw className="mr-1 size-3.5" aria-hidden="true" />
              刷新
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => useAppStore.getState().setShowCustomizeView(true, "flows")}
            >
              编辑流程
            </Button>
          </div>
          {!flow.flows.length && !binding?.active?.flow && !flow.busy && (
            <p className="text-xs text-muted-foreground">
              还没有保存的步骤。点击“编辑流程”创建，再回到这里选择。
            </p>
          )}
        </div>
      </details>
      {flow.choice && (
        <div className="rounded-xl border bg-muted/20 p-3 text-xs leading-6 text-muted-foreground">
          <p>
            已选择 {flow.choice.name} · 保存修订 {flow.choice.revision}（流程保存记录）。
            {flow.choice.bindingRevision !== undefined
              ? "来自当前助手组合。"
              : "来自已保存的流程。"}
          </p>
          <p>在对话输入框选择“按步骤执行”，输入本次任务并发送。聊天模式仍按普通对话处理。</p>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={flow.busy || flow.active}
            onClick={flow.clear}
          >
            清除流程选择
          </Button>
        </div>
      )}
      {!flow.enabled && flow.choice && (
        <p role="alert" className="text-sm text-destructive">
          当前流程不可用。普通聊天仍可使用；开启灵件功能或清除流程选择后重试。
        </p>
      )}
      {showRun && flow.error && (
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
  onFollowUp
}: {
  flow: ChatFlowController
  disabled: boolean
  onFollowUp?(text: string): void
}) {
  if (!flow.run) return null
  return (
    <div className="space-y-3" data-chat-flow-run>
      <FlowRunView
        run={flow.run}
        busy={flow.busy || !flow.enabled}
        onResumed={(next) => flow.acceptResumed(flow.run!.id, next)}
        onCancel={() => {
          void flow.act("cancel")
        }}
        onDecide={(nonce, approve) => {
          void flow.act(approve ? "approve" : "reject", { runId: flow.run!.id, nonce })
        }}
      />
      {onFollowUp && !flow.active && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3"
          disabled={disabled}
          onClick={() => onFollowUp(flowFollowUp(flow.run!))}
        >
          带运行摘要追问
        </Button>
      )}
    </div>
  )
}
