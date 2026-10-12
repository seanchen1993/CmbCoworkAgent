import { BotPeerExchange } from "./BotPeerExchange"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import { botPeerExchangeKey, type BotPeerExchangeLink } from "../../../../shared/bot-peer-exchange"
import { BotComputer } from "./BotComputer"
import { BotModelUsage } from "./BotModelUsage"
import { botApi } from "@/lib/bot-api"
import { botErrorNotice, type BotErrorNotice } from "@/lib/bot-error-notice"
import { useBotViewVisibility } from "@/lib/use-bot-view-visibility"
import { useEffect, useState } from "react"
import {
  Activity,
  FileText,
  Circle,
  ChevronDown,
  ChevronRight,
  ArrowLeft,
  Monitor
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { BotDialogContent as DialogContent } from "./BotDialog"
import type { BotRunHistory as History, BotRunAddress } from "../../../../shared/bot-run-history"
import type { BotRunStatus } from "../../../../shared/bot-types"
import { BotEffectDetails } from "./BotEffectDetails"
import { BotInteractionDetails } from "./BotInteractionDetails"
import { BotWorktreePanel } from "./BotWorktreePanel"
import { BotWorkflowControls } from "./BotWorkflowControls"
import { BotShellJob } from "./BotShellJob"
import { BotErrorNoticeBody } from "./BotErrorNoticeBody"

const labels: Record<BotRunStatus, string> = {
  queued: "等待执行",
  running: "运行中",
  waiting_input: "等待处理",
  cancelling: "正在停止",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已停止",
  needs_review: "待核对"
}
export function BotRunHistory({
  address,
  close,
  back
}: {
  address: BotRunAddress
  close(): void
  back?(): void
}) {
  const viewVisible = useBotViewVisibility()
  const dataEpoch = useBotWorkspaceStore((state) => state.snapshot?.dataEpoch ?? "initial")
  const canReadPeer = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("peer-exchange-v1") ?? false
  )
  const [peer, setPeer] = useState<BotPeerExchangeLink | null>(null)
  const { conversationId, threadRootId } = address
  const [selectedChild, setSelectedChild] = useState<string | null>(null)
  const [selectedShell, setSelectedShell] = useState<string | null>(null)
  const [showComputer, setShowComputer] = useState(false)
  const runId = selectedChild ?? address.runId
  const [cursors, setCursors] = useState<number[]>([])
  const [loaded, setLoaded] = useState<{ key: string; value: History } | null>(null)
  const [failure, setFailure] = useState<{
    key: string
    notice: BotErrorNotice
  } | null>(null)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [retry, setRetry] = useState(0)
  const before = cursors.at(-1)
  const requestKey = JSON.stringify([conversationId, runId, threadRootId, before])
  const value = loaded?.key === requestKey ? loaded.value : null
  const error = failure?.key === requestKey ? failure.notice : null
  useEffect(() => {
    if (!viewVisible || selectedShell || peer) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const read = async () => {
      try {
        const data = await botApi.runHistory({
          conversationId,
          runId,
          threadRootId,
          before,
          limit: 30
        })
        if (disposed) return
        setLoaded({ key: requestKey, value: data })
        setFailure(null)
        if (!["succeeded", "failed", "cancelled"].includes(data.run.status))
          timer = setTimeout(() => void read(), 2000)
      } catch (error) {
        if (!disposed)
          setFailure({
            key: requestKey,
            notice: botErrorNotice(error, "任务记录读取失败")
          })
      }
    }
    void read()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [
    conversationId,
    runId,
    threadRootId,
    before,
    retry,
    requestKey,
    viewVisible,
    selectedShell,
    peer
  ])
  if (peer)
    return (
      <BotPeerExchange
        key={botPeerExchangeKey({
          anchor: peer.anchor,
          peerRunId: peer.peerRunId,
          expectedDataEpoch: dataEpoch
        })}
        link={peer}
        dataEpoch={dataEpoch}
        close={close}
        back={() => setPeer(null)}
      />
    )
  if (selectedShell)
    return (
      <BotShellJob
        address={{ conversationId, runId, threadRootId, jobId: selectedShell }}
        close={close}
        back={() => setSelectedShell(null)}
      />
    )
  if (showComputer && value?.run.workflowTask)
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) close()
        }}
      >
        <DialogContent className="flex h-[85vh] max-w-4xl flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="shrink-0 border-b px-5 py-4 pr-12">
            <DialogTitle className="flex items-center gap-2">
              <Monitor size={18} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">{value.run.workflowTask.label} · 浏览器</span>
            </DialogTitle>
            <DialogDescription>
              此任务的独立浏览器，接管不会影响父任务或其他任务。
            </DialogDescription>
          </DialogHeader>
          <div className="flex shrink-0 items-center justify-between gap-3 px-4 pt-2">
            <Button
              size="sm"
              variant="ghost"
              className="gap-1.5"
              onClick={() => setShowComputer(false)}
            >
              <ArrowLeft size={14} />
              返回任务记录
            </Button>
            <span className="text-xs text-muted-foreground">{labels[value.run.status]}</span>
          </div>
          <BotComputer
            botId={value.run.botId}
            conversationId={conversationId}
            threadRootId={threadRootId}
            taskAddress={{ conversationId, runId, threadRootId }}
            readOnly={!["running", "waiting_input"].includes(value.run.status)}
            name={value.run.workflowTask.label}
            expanded
            active={viewVisible}
          />
        </DialogContent>
      </Dialog>
    )
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Activity size={18} />
            {value?.run.workflowTask ? `子任务 · ${value.run.workflowTask.label}` : "任务记录"}
          </DialogTitle>
          <DialogDescription>查看执行进展、审批和操作结果。最近的记录显示在前。</DialogDescription>
        </DialogHeader>
        {back && !selectedChild && (
          <Button size="sm" variant="ghost" className="self-start" onClick={back}>
            返回后台任务
          </Button>
        )}
        {selectedChild && (
          <Button
            size="sm"
            variant="ghost"
            className="self-start"
            onClick={() => {
              setSelectedChild(null)
              setCursors([])
              setExpanded(null)
            }}
          >
            返回父任务
          </Button>
        )}
        {value && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs">
            <strong className="font-medium">{labels[value.run.status]}</strong>
            <time
              className="text-muted-foreground"
              dateTime={new Date(value.run.createdAt).toISOString()}
            >
              收到任务：{new Date(value.run.createdAt).toLocaleString()}
            </time>
          </div>
        )}
        {error && (
          <div role="alert" className="rounded-xl border border-border/70 bg-muted/30 p-3">
            <BotErrorNoticeBody notice={error} title="任务记录读取失败" showRequestId>
              <Button size="sm" variant="outline" onClick={() => setRetry((n) => n + 1)}>
                重试
              </Button>
            </BotErrorNoticeBody>
          </div>
        )}
        <div className="min-h-0 space-y-4 overflow-y-auto">
          {value?.hasBrowser && value.run.workflowTask && (
            <Button
              size="sm"
              variant="outline"
              className="gap-2 rounded-lg shadow-none"
              onClick={() => setShowComputer(true)}
            >
              <Monitor size={15} />
              查看任务浏览器
            </Button>
          )}
          {!!value?.shellJobs?.length && (
            <section className="space-y-2" aria-label="后台命令记录">
              <h3 className="text-sm font-medium">后台命令</h3>
              {value.shellJobs.map((job) => (
                <button
                  key={job.id}
                  className="flex w-full items-center gap-3 rounded-lg border p-3 text-left text-xs transition-colors hover:bg-muted/50"
                  onClick={() => setSelectedShell(job.id)}
                >
                  <code className="min-w-0 flex-1 truncate">{job.command}</code>
                  <span className="shrink-0 text-muted-foreground">
                    {job.reviewed ? "人工已核对" : labels[job.status]}
                  </span>
                  <ChevronRight size={14} />
                </button>
              ))}
            </section>
          )}
          {value?.run.workflowTask && (
            <BotWorkflowControls
              key={JSON.stringify([conversationId, runId, threadRootId])}
              address={{ conversationId, runId, threadRootId }}
              revision={value.run.revision}
              status={value.run.status}
              changed={() => setRetry((n) => n + 1)}
            />
          )}
          {value?.modelBudget && (
            <details className="rounded-lg border px-3 py-2 text-xs text-muted-foreground">
              <summary className="cursor-pointer">
                任务输出额度 ·{" "}
                {(value.modelBudget.consumed + value.modelBudget.reserved).toLocaleString()} /{" "}
                {value.modelBudget.limit.toLocaleString()} tokens
              </summary>
              <p className="mt-2 leading-5">
                包含本任务及协作任务的模型调用。已确认 {value.modelBudget.consumed.toLocaleString()}
                ，待确认预留 {value.modelBudget.reserved.toLocaleString()}
                ；请求失败或用量回执不完整时保留预留额度。
              </p>
            </details>
          )}
          <BotModelUsage value={value?.modelUsage} />
          {value?.hasWorktree && (
            <BotWorktreePanel
              key={JSON.stringify([conversationId, runId, threadRootId])}
              address={{ conversationId, runId, threadRootId }}
              settled={["succeeded", "failed", "cancelled"].includes(value.run.status)}
            />
          )}
          {!!value?.children?.length && (
            <section className="rounded-xl border border-border/70 p-3" aria-label="工作流子任务">
              <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                <span>并行与分工</span>
                <span>
                  {value.children.filter((child) => child.status === "succeeded").length} /{" "}
                  {value.children.length} 已完成
                </span>
              </div>
              <ul className="space-y-1">
                {value.children.map((child) => (
                  <li key={child.id}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => {
                        setSelectedChild(child.id)
                        setCursors([])
                        setExpanded(null)
                      }}
                    >
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${child.status === "succeeded" ? "bg-emerald-500" : child.status === "failed" || child.status === "needs_review" ? "bg-amber-500" : "bg-muted-foreground/50"}`}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {child.label}
                        <span className="ml-2 text-xs text-muted-foreground">{child.phase}</span>
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {labels[child.status]}
                      </span>
                      <ChevronRight size={14} className="text-muted-foreground" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {value && (value.run.result || value.run.error || value.run.diagnostic) && (
            <section className="rounded-xl border border-border/70 p-3" aria-label="任务结果">
              <h3 className="mb-2 text-xs font-medium text-muted-foreground">
                {value.run.status === "succeeded" ? "交付结果" : "执行说明"}
              </h3>
              {value.run.status !== "succeeded" && (value.run.error || value.run.diagnostic) ? (
                <BotErrorNoticeBody
                  key={JSON.stringify([conversationId, runId, threadRootId])}
                  notice={{
                    message: value.run.error ?? value.run.result ?? "执行失败，请查看任务记录。",
                    diagnostic: value.run.diagnostic
                  }}
                  showRequestId
                />
              ) : (
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">
                  {value.run.result}
                </pre>
              )}
            </section>
          )}
          {!value && !error ? (
            <p role="status" className="py-10 text-center text-sm text-muted-foreground">
              正在读取任务记录…
            </p>
          ) : (
            <ol className="space-y-1">
              {value?.items.map((item) => (
                <li
                  key={item.cursor}
                  data-event-cursor={item.cursor}
                  data-interaction-id={item.interactionId}
                  className="relative flex gap-3 py-3"
                >
                  <span
                    className="absolute left-[7px] top-8 bottom-0 border-l border-border/70"
                    aria-hidden="true"
                  />
                  {item.effectId || item.interactionId ? (
                    <FileText size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <Circle size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
                  )}
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      {item.peerExchange && canReadPeer ? (
                        <button
                          type="button"
                          className="flex min-w-0 items-center gap-1 rounded text-left text-sm font-medium hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          aria-label={`查看与 ${item.peerExchange.peer.name} 的交流`}
                          onClick={() => setPeer(item.peerExchange!)}
                        >
                          <span className="break-words">{item.label}</span>
                          <ChevronRight size={14} />
                        </button>
                      ) : item.effectId || item.interactionId ? (
                        <button
                          type="button"
                          className="flex min-w-0 items-center gap-1 rounded text-left text-sm font-medium hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          aria-expanded={expanded === item.cursor}
                          onClick={() =>
                            setExpanded((id) => (id === item.cursor ? null : item.cursor))
                          }
                        >
                          {expanded === item.cursor ? (
                            <ChevronDown size={14} />
                          ) : (
                            <ChevronRight size={14} />
                          )}
                          <span className="break-words">{item.label}</span>
                        </button>
                      ) : (
                        <span className="break-words text-sm">{item.label}</span>
                      )}
                      <time
                        className="shrink-0 text-[11px] text-muted-foreground"
                        dateTime={new Date(item.createdAt).toISOString()}
                        title={new Date(item.createdAt).toLocaleString()}
                      >
                        {new Date(item.createdAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit"
                        })}
                      </time>
                    </div>
                    {item.detail && (
                      <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                        {item.detail}
                      </p>
                    )}
                    {item.effectId && expanded === item.cursor && (
                      <BotEffectDetails
                        key={item.effectId}
                        address={{ conversationId, runId, threadRootId }}
                        effectId={item.effectId}
                      />
                    )}
                    {item.interactionId && expanded === item.cursor && (
                      <BotInteractionDetails
                        key={item.interactionId}
                        address={{ conversationId, runId, threadRootId }}
                        interactionId={item.interactionId}
                      />
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
        <div className="flex items-center justify-between border-t pt-3">
          <Button
            size="sm"
            variant="ghost"
            disabled={!cursors.length || !value}
            onClick={() => setCursors((all) => all.slice(0, -1))}
          >
            上一页
          </Button>
          <span className="text-xs text-muted-foreground">第 {cursors.length + 1} 页</span>
          <Button
            size="sm"
            variant="ghost"
            disabled={!value?.nextBefore}
            onClick={() => {
              if (value?.nextBefore) setCursors((all) => [...all, value.nextBefore!])
            }}
          >
            更早记录
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
