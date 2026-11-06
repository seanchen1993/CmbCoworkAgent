import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { useAppStore } from "@/lib/store"
import type {
  AgentViewIntent,
  AgentTaskStatus,
  AgentTaskMessages
} from "../../../../shared/mods/v2/agent-tasks"
import { isSameWorkspacePath } from "../../../../shared/workspace-path"
import {
  captureSurfaceNavigationScope,
  surfaceNavigationScopeCurrent
} from "@/lib/platform-surface-intent"
import { Button } from "@/components/ui/button"
import {
  reserveModsAgentInput,
  releaseModsAgentInput,
  useModsAgentDraft,
  captureModsAgentDraft,
  settleModsAgentDraft,
  saveModsAgentDraft
} from "@/lib/mods-agent-input-target"

const statusLabels: Record<AgentTaskStatus["status"], string> = {
  running: "进行中",
  stopping: "正在停止，等待实际结算",
  completed: "已完成",
  failed: "执行失败",
  cancelled: "已停止",
  unknown: "结果待核对"
}
function errorAdvice(error: string) {
  if (/CURSOR|CHECKPOINT/.test(error)) return "记录已经更新，请刷新后从第一页重新查看。"
  if (/CHANGED|GRANT|SCOPE|OWNER|MISSING|NOT_FOUND/.test(error))
    return "聊天或插件状态已变化，请返回父聊天，从当前插件重新打开子任务。"
  return "暂时无法读取或操作子任务，请刷新重试；停止请求失败时请先核对实际状态。"
}

function currentScope(threadId: string, workspace: string, account: number) {
  const state = useAppStore.getState()
  const row = state.threads.find((thread) => thread.thread_id === threadId)
  return (
    state.accountRevision === account &&
    state.currentThreadId === threadId &&
    state.mainView === "thread" &&
    isSameWorkspacePath(
      (row?.metadata as { workspacePath?: string } | undefined)?.workspacePath,
      workspace
    )
  )
}

/** A notification triggers a fresh main-owned intent read. Mount catches requests sent while away. */
export function AgentViewReceiver({
  threadId,
  workspace
}: {
  threadId: string
  workspace: string
}) {
  const account = useAppStore((state) => state.accountRevision)
  const birth = useAppStore((state) => {
    const row = state.threads.find((thread) => thread.thread_id === threadId)
    return JSON.stringify([row?.created_at, row?.metadata?.cmb_thread_incarnation])
  })
  const [error, setError] = useState("")
  useEffect(() => {
    let live = true,
      pending = false,
      queued = false
    const owner = captureSurfaceNavigationScope(threadId, workspace)
    const current = () =>
      !!owner && surfaceNavigationScopeCurrent(owner) && currentScope(threadId, workspace, account)
    setError("")
    const read = async () => {
      if (!live || document.hidden || !window.api.mods.agentViewPending || !current()) return
      if (pending) {
        queued = true
        return
      }
      queued = false
      pending = true
      try {
        const intent = await window.api.mods.agentViewPending(threadId)
        if (!live || !current() || !intent) return
        if (intent.threadId !== threadId || !isSameWorkspacePath(intent.workspace, workspace))
          return
        if (intent.agentId === "main") useAppStore.getState().closeSubagentFocusView()
        else
          useAppStore.getState().openSubagentFocusView({
            threadId,
            subagentId: intent.agentId,
            name: "插件子任务",
            description:
              intent.mode === "interactive" ? "子会话输入" : "只读查看，输入仍发送到父聊天",
            modsView: intent
          })
        setError("")
      } catch {
        if (live && current()) setError("子任务查看入口暂不可用，请回原插件重新打开。")
      } finally {
        pending = false
        if (queued && live) void read()
      }
    }
    const stop = window.api.mods.onAgentViewRequested?.(event => {
      if (event.threadId === threadId) void read()
    })
    const visible = () => { if (!document.hidden) void read() }
    document.addEventListener("visibilitychange", visible)
    void read()
    return () => {
      live = false
      stop?.()
      document.removeEventListener("visibilitychange", visible)
    }
  }, [threadId, workspace, account, birth])
  return error ? (
    <p role="alert" className="px-3 text-xs text-muted-foreground">
      {error}
    </p>
  ) : null
}

export function ModsAgentTranscriptPanel({ intent }: { intent: AgentViewIntent }) {
  const account = useAppStore((state) => state.accountRevision)
  const currentThreadId = useAppStore((state) =>
    state.mainView === "thread" ? state.currentThreadId : null
  )
  const birth = useAppStore((state) => {
    const row = state.threads.find((thread) => thread.thread_id === intent.threadId)
    return JSON.stringify([row?.created_at, row?.metadata?.cmb_thread_incarnation])
  })
  const owner = useRef(captureSurfaceNavigationScope(intent.threadId, intent.workspace))
  const [data, setData] = useState<{ status: AgentTaskStatus; messages: AgentTaskMessages }>()
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [interactive, setInteractive] = useState(false)
  const [activationWaiting, setActivationWaiting] = useState(false)
  const draft = useModsAgentDraft(intent, account)
  const [sending, setSending] = useState(false)
  const [receipt, setReceipt] = useState("")
  const composer = useRef<HTMLTextAreaElement>(null),
    composing = useRef(false)
  const activating = useRef(false),
    sendSequence = useRef(0),
    sendingRef = useRef(false)
  const activationAttempted = useRef(false)
  const activationLifetime = useRef(new AbortController())
  const pending = useRef(false),
    live = useRef(false)
  const stopping = useRef(false),
    paged = useRef(false),
    sequence = useRef(0)
  const scope = { threadId: intent.threadId, intentId: intent.id }
  const valid = () =>
    !!owner.current &&
    surfaceNavigationScopeCurrent(owner.current) &&
    currentScope(intent.threadId, intent.workspace, owner.current.accountRevision)
  const current = () =>
    live.current && valid() && useAppStore.getState().subagentFocusView?.modsView?.id === intent.id
  const load = async (cursor?: string) => {
    if (pending.current || !current()) return
    pending.current = true
    const request = sequence.current
    try {
      const next = await window.api.mods.agentViewRead({ ...scope, cursor })
      if (!current() || request !== sequence.current) return
      if (next.status.status !== "running") {
        releaseModsAgentInput(intent.id)
        setInteractive(false)
      } else if (
        intent.mode === "interactive" &&
        !activationAttempted.current &&
        !activating.current
      ) {
        activationAttempted.current = true
        activating.current = true
        const reservation = reserveModsAgentInput(intent, account)
        let activatedTarget = false
        setActivationWaiting(true)
        try {
          await reservation.ready(activationLifetime.current.signal)
          if (!current() || request !== sequence.current) return
          const activated = await window.api.mods.agentViewActivate(scope)
          if (!current() || request !== sequence.current) return
          if (activated.active && reservation.activate()) {
            activatedTarget = true
            setInteractive(true)
          }
        } finally {
          if (!activatedTarget) reservation.release()
          if (current()) setActivationWaiting(false)
          activating.current = false
        }
      }
      paged.current = !!cursor
      setData((previous) =>
        cursor && previous
          ? {
              ...next,
              messages: {
                ...next.messages,
                skippedMessages: previous.messages.skippedMessages + next.messages.skippedMessages,
                messages: [...previous.messages.messages, ...next.messages.messages]
              }
            }
          : next
      )
      setError("")
    } catch (cause) {
      if (current()) {
        releaseModsAgentInput(intent.id)
        setInteractive(false)
        setError(cause instanceof Error ? cause.message : "子任务记录暂不可用。")
      }
    } finally {
      if (request === sequence.current) pending.current = false
    }
  }
  useEffect(() => {
    activationLifetime.current = new AbortController()
    activationAttempted.current = false
    live.current = true
    void load()
    const timer = setInterval(() => {
      if (!document.hidden && !paged.current) void load()
    }, 2000)
    return () => {
      activationLifetime.current.abort()
      live.current = false
      sequence.current++
      pending.current = false
      releaseModsAgentInput(intent.id)
      clearInterval(timer)
    }
  }, [intent.id])
  useLayoutEffect(() => {
    if (
      !valid() ||
      account !== owner.current?.accountRevision ||
      currentThreadId !== intent.threadId
    ) {
      releaseModsAgentInput(intent.id)
      setInteractive(false)
    }
  }, [account, currentThreadId, intent.id, birth])
  useEffect(() => {
    if (interactive) composer.current?.focus({ preventScroll: true })
  }, [interactive])
  const close = () => {
    activationLifetime.current.abort()
    releaseModsAgentInput(intent.id)
    if (valid()) void window.api.mods.agentViewClose(scope).catch(() => {})
    if (useAppStore.getState().subagentFocusView?.modsView?.id === intent.id)
      useAppStore.getState().closeSubagentFocusView()
  }
  const send = async () => {
    if (!interactive || sendingRef.current || composing.current || !current() || !draft.trim())
      return
    const text = draft
    const submitted = captureModsAgentDraft(intent, account)
    if (new TextEncoder().encode(text).length > 32 * 1024) {
      setError("反馈文字不能超过 32 KiB，草稿已保留。")
      return
    }
    sendingRef.current = true
    setSending(true)
    setReceipt("")
    try {
      const result = await window.api.mods.agentViewSend({
        ...scope,
        sequence: ++sendSequence.current,
        text
      })
      if (result.isDelivered) settleModsAgentDraft(intent, account, submitted.version)
      if (!current()) return
      if (result.isDelivered) {
        setReceipt("已排队，等待子任务在下一次模型调用时读取；不会重新启动任务。")
      } else setError(`反馈未投递，草稿已保留。${result.reason ?? "子任务当前不可接收输入。"}`)
    } catch (cause) {
      if (current()) {
        releaseModsAgentInput(intent.id)
        setInteractive(false)
        setError(
          `投递尚未确认，草稿已保留，请核对记录，避免重复发送。${cause instanceof Error ? cause.message : ""}`
        )
      }
    } finally {
      sendingRef.current = false
      if (current()) setSending(false)
    }
  }
  const stop = async () => {
    if (stopping.current || !current()) return
    stopping.current = true
    setBusy(true)
    try {
      await window.api.mods.agentViewStop(scope)
      if (current()) await load()
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : "停止尚未确认。")
    } finally {
      stopping.current = false
      if (current()) setBusy(false)
    }
  }
  if (account !== owner.current?.accountRevision || currentThreadId !== intent.threadId || !valid())
    return null
  return (
    <section
      aria-label={interactive ? "插件子会话" : "插件子任务只读记录"}
      className="flex h-full min-h-0 flex-col"
    >
      <header className="space-y-2 border-b p-3">
        <Button type="button" variant="ghost" size="sm" onClick={close}>
          返回父聊天
        </Button>
        <h2 className="break-words font-semibold">{data?.status.description ?? "子任务记录"}</h2>
        <p className="text-xs text-muted-foreground">
          {activationWaiting
            ? "正在等待父聊天完成本次发送准备，随后切换输入；可以返回取消。"
            : interactive
              ? `当前发送到：${data?.status.description ?? "插件子任务"}。父聊天输入已暂停，返回后恢复原草稿。`
              : intent.mode === "interactive"
                ? "子任务当前只读，输入已返回父聊天；查看不会重新执行。"
                : "只读查看；输入仍发给父聊天，查看不会重新执行。"}
        </p>
        <p role="status" className="text-sm font-medium">
          {data ? statusLabels[data.status.status] : "正在读取记录…"}
        </p>
        {data?.status.diagnostic && (
          <p className="text-xs text-muted-foreground">{data.status.diagnostic}</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
            刷新记录
          </Button>
          {data && ["running", "stopping"].includes(data.status.status) && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || data.status.status === "stopping"}
              onClick={() => void stop()}
            >
              请求停止子任务
            </Button>
          )}
        </div>
        {error && (
          <div role="alert" className="rounded border p-2 text-sm">
            <p>{errorAdvice(error)}</p>
            <details className="mt-1 text-xs text-muted-foreground">
              <summary>技术信息</summary>
              <p className="break-all">{error}</p>
            </details>
          </div>
        )}
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        <p className="text-xs">保留的原生上下文记录；压缩前历史可能不可用，结果摘要不替代原文。</p>
        {!!data?.messages.skippedMessages && (
          <p role="status">
            {data.messages.skippedMessages} 条消息过大或无法精确显示，已跳过；可以继续读取后续记录。
          </p>
        )}
        {data?.messages.messages.map((message, index) => (
          <article key={index} className="rounded border p-3">
            <p className="mb-2 text-xs text-muted-foreground">
              {message.role === "user" ? "任务输入与反馈" : "子任务回复"}
            </p>
            <pre className="whitespace-pre-wrap break-words text-sm">{message.text}</pre>
            {!!message.toolUses.length && (
              <details>
                <summary>实际工具调用</summary>
                <pre className="whitespace-pre-wrap break-all text-xs">
                  {JSON.stringify(message.toolUses, null, 2)}
                </pre>
              </details>
            )}
            {!!message.toolResults?.length && (
              <details>
                <summary>实际工具结果</summary>
                <pre className="whitespace-pre-wrap break-all text-xs">
                  {JSON.stringify(message.toolResults, null, 2)}
                </pre>
              </details>
            )}
          </article>
        ))}
        {data?.messages.history === "unavailable" && <p>没有可读取的原生消息证据。</p>}
        {data?.messages.nextCursor && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void load(data.messages.nextCursor)}
          >
            读取下一页
          </Button>
        )}
        {data?.status.outcome && (
          <details>
            <summary>任务结果摘要</summary>
            <pre className="whitespace-pre-wrap break-words">{data.status.outcome.answer}</pre>
          </details>
        )}
      </div>
      {intent.mode === "interactive" && (
        <form
          className="space-y-2 border-t p-3"
          onSubmit={(event) => {
            event.preventDefault()
            void send()
          }}
        >
          <label className="text-sm font-medium" htmlFor={`agent-input-${intent.id}`}>
            发送到子任务：{data?.status.description ?? "正在核对目标"}
          </label>
          <textarea
            id={`agent-input-${intent.id}`}
            ref={composer}
            rows={3}
            value={draft}
            className="w-full resize-y rounded border bg-background p-2 text-sm disabled:opacity-60"
            disabled={!interactive || sending}
            placeholder={
              interactive
                ? "补充文字反馈；Enter 发送，Shift + Enter 换行"
                : "子任务当前不可接收输入，未发送草稿已保留"
            }
            onChange={(event) => {
              if (new TextEncoder().encode(event.target.value).length > 32 * 1024) {
                setError("反馈文字不能超过 32 KiB，已有草稿已保留。")
                return
              }
              saveModsAgentDraft(intent, account, event.target.value)
            }}
            onCompositionStart={() => {
              composing.current = true
            }}
            onCompositionEnd={() => {
              composing.current = false
            }}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                !composing.current
              ) {
                event.preventDefault()
                void send()
              }
            }}
          />
          <Button type="submit" disabled={!interactive || sending || !draft.trim()}>
            {sending ? "正在投递…" : "发送到子任务"}
          </Button>
          {receipt && (
            <p role="status" className="text-xs text-muted-foreground">
              {receipt}
            </p>
          )}
        </form>
      )}
    </section>
  )
}
