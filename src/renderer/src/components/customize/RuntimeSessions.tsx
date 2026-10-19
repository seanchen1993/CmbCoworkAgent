import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import type {
  FunctionRuntimeSession,
  FunctionRuntimeSessions
} from "../../../../shared/mods/v2/runtime-sessions"

const labels: Record<FunctionRuntimeSession["state"], string> = {
  loading: "正在加载",
  resident: "已启动",
  discovery: "已登记",
  releasing: "正在释放",
  stopped: "已停止并释放",
  failed: "清理或恢复待核对"
}

export function RuntimeSessions({
  active = true,
  threadId
}: {
  active?: boolean
  threadId?: string | null
}): React.JSX.Element {
  const [view, setView] = useState<FunctionRuntimeSessions | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [confirm, setConfirm] = useState<{
    action: "release" | "resume"
    session: FunctionRuntimeSession
  } | null>(null)
  const revision = useRef(0)
  const controlling = useRef<number | null>(null)
  const invalidateRequests = useCallback(() => {
    revision.current++
    controlling.current = null
  }, [])
  const refresh = useCallback(
    async (clearError = true) => {
      if (controlling.current !== null) return
      const id = ++revision.current
      try {
        const next = await window.api.mods.runtimeSessions(threadId ?? undefined)
        if (id === revision.current) {
          setView(next)
          if (clearError) setError(null)
        }
      } catch (failure) {
        if (id === revision.current) setError(String(failure))
      }
    },
    [threadId]
  )
  useEffect(() => {
    if (!active) return
    setPending(false)
    setConfirm(null)
    setError(null)
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    const stop = window.api.mods.onConfigurationChanged(() => void refresh())
    return () => {
      invalidateRequests()
      window.clearInterval(timer)
      stop()
    }
  }, [active, refresh, invalidateRequests])
  const act = async () => {
    if (!confirm || pending) return
    setPending(true)
    setError(null)
    const id = ++revision.current
    controlling.current = id
    try {
      const next = await (confirm.action === "release"
        ? window.api.mods.releaseRuntimeSession(confirm.session)
        : window.api.mods.resumeRuntimeSession(confirm.session))
      if (id === revision.current) {
        setView(next)
        setError(null)
      }
    } catch (failure) {
      if (id === revision.current) setError(String(failure))
    } finally {
      if (controlling.current === id) {
        controlling.current = null
        if (id === revision.current) {
          setPending(false)
          setConfirm(null)
          void refresh(false)
        }
      }
    }
  }
  return (
    <details className="rounded-lg border p-3 text-xs" open={!!view && view.resident >= view.limit}>
      <summary className="cursor-pointer font-medium">
        聊天组件占用{view ? ` ${view.resident}/${view.limit}` : ""}
      </summary>
      <p className="mt-2 text-muted-foreground">
        切换聊天会保留已启动的组件。名额不足时，可停止已结束任务的组件；正在操作或仍有后台任务的聊天需要先结束任务。
      </p>
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => void refresh()}>
        刷新占用
      </Button>
      {view?.sessions.map((session) => (
        <div
          key={`${session.workspace}:${session.threadId}:${session.generation}`}
          className="mt-2 rounded border p-2"
        >
          <p className="break-all font-medium">
            {session.threadId === threadId
              ? "当前聊天"
              : session.title || `聊天 ${session.threadId.slice(0, 12)}`}{" "}
            · {labels[session.state]}
          </p>
          <p className="break-all text-muted-foreground">{session.workspace}</p>
          {session.blocker && <p className="mt-1 text-muted-foreground">{session.blocker}</p>}
          {session.error && <p className="mt-1 text-destructive">{session.error}</p>}
          {session.autoReclaimable && (
            <p className="mt-1 text-muted-foreground">
              仅完成登记、尚未使用；名额不足时可自动回收。
            </p>
          )}
          {session.guestEntered && session.mountedSites === 0 && (
            <p className="mt-1 text-muted-foreground">当前未挂载聊天绘制，组件运行状态仍保留。</p>
          )}
          {session.canRelease && (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => setConfirm({ action: "release", session })}
            >
              停止并释放
            </Button>
          )}
          {session.canResume && (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => setConfirm({ action: "resume", session })}
            >
              明确恢复组件
            </Button>
          )}
          {confirm &&
            confirm.session.threadId === session.threadId &&
            confirm.session.workspace === session.workspace &&
            confirm.session.generation === session.generation && (
              <div role="alert" className="mt-3 space-y-2 rounded border p-3">
                <p>
                  {confirm.action === "release"
                    ? `停止并释放「${session.title || "这段聊天"}」的组件？组件的临时变量会丢失，已保存的设置、数据和聊天记录保留。组件保持停止，直到你明确恢复；需要这组组件或强制检查的任务须先恢复后继续。`
                    : `恢复「${session.title || "这段聊天"}」的组件？将重新核对已批准的来源和设置。启动操作可能再次执行，请先核对之前任务的结果。`}
                </p>
                <Button size="sm" disabled={pending} onClick={() => void act()}>
                  {pending ? "正在处理…" : "确认"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => setConfirm(null)}
                >
                  取消
                </Button>
              </div>
            )}
        </div>
      ))}
      {!!view?.retiring && (
        <p className="mt-2 text-muted-foreground">
          另有 {view.retiring} 个运行正在清理，尚未确认释放。
        </p>
      )}
      {!!view?.reserved && (
        <p className="mt-2 text-muted-foreground">
          其中 {view.reserved} 个名额正在启动或等待清理确认。
        </p>
      )}
      {!!view?.omitted && (
        <p className="mt-2 text-muted-foreground">
          共 {view.stoppedTotal} 段聊天已停止，仅展示最近 10
          段及当前聊天。打开更早的聊天可查看并恢复它的组件。
        </p>
      )}
      {view?.error && (
        <p role="alert" className="mt-2 text-destructive">
          {view.error}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 break-all text-destructive">
          {error}
        </p>
      )}
    </details>
  )
}
