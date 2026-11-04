import { useEffect, useRef, useState } from "react"
import type {
  ModApprovalInboxApi,
  ModApprovalSnapshot
} from "../../../../shared/mods/approval-inbox"

const empty: ModApprovalSnapshot = { current: null, queued: 0, paused: [] }
const button =
  "rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"

/** A passive inbox, never a modal or a focus trap. Chat and navigation remain usable. */
export function ModApprovalInbox({
  api = window.api.mods.approvalInbox
}: {
  api?: ModApprovalInboxApi
}) {
  const [snapshot, setSnapshot] = useState(empty)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const generation = useRef(0)
  const ownerRef = useRef({ live: false })
  useEffect(() => {
    if (!api) return
    const owner = { live: true }
    ownerRef.current = owner
    setSnapshot(empty)
    setBusy(false)
    setError("")
    setOpen(false)
    const refresh = async () => {
      const ticket = ++generation.current
      try {
        const value = await api.snapshot()
        if (owner.live && ticket === generation.current) {
          setSnapshot(value)
          setError("")
        }
      } catch {
        if (owner.live && ticket === generation.current) setError("无法读取灵件请求，请稍后重试。")
      }
    }
    const unsubscribe = api.onChanged(() => {
      void refresh()
    })
    void refresh()
    return () => {
      owner.live = false
      unsubscribe()
    }
  }, [api])
  if (!api || (!snapshot.current && !snapshot.paused.length && !error)) return null
  const run = async (call: () => Promise<void>) => {
    if (busy) return
    const owner = ownerRef.current
    const current = () => owner.live && ownerRef.current === owner
    setBusy(true)
    setError("")
    try {
      await call()
      if (!current()) return
      const ticket = ++generation.current
      const next = await api.snapshot()
      if (current() && ticket === generation.current) setSnapshot(next)
    } catch {
      if (current()) setError("请求状态已变化，请刷新后核对。")
    } finally {
      if (current()) setBusy(false)
    }
  }
  const current = snapshot.current
  return (
    <section
      aria-label="灵件请求"
      className="fixed bottom-4 right-4 z-40 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-background p-3 shadow-lg"
    >
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          aria-expanded={open}
          className="text-sm font-medium"
          onClick={() => setOpen((value) => !value)}
        >
          {current ? `灵件请求待确认（${snapshot.queued + 1}）` : "灵件请求已暂停"}
        </button>
        {open && (
          <button type="button" className={button} onClick={() => setOpen(false)}>
            收起
          </button>
        )}
      </div>
      {open && (
        <div className="mt-3 max-h-[60vh] w-96 max-w-full overflow-y-auto overscroll-contain space-y-3">
          <p className="text-xs text-muted-foreground">
            可以继续聊天或切换页面。允许只针对本次请求；拒绝会暂停此来源在该会话中的后续审批请求。
          </p>
          {current && (
            <div key={current.requestId} className="space-y-3">
              <p className="break-words text-sm font-medium">{current.message}</p>
              <p className="text-xs text-muted-foreground">会话：{current.threadId.slice(0, 8)}</p>
              <details>
                <summary className="cursor-pointer text-xs">查看请求内容</summary>
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">
                  {current.detail}
                </pre>
              </details>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={button}
                  disabled={busy}
                  onClick={() =>
                    void run(() => api.decide({ requestId: current.requestId, decision: "deny" }))
                  }
                >
                  拒绝并暂停
                </button>
                <button
                  type="button"
                  className={button}
                  disabled={busy}
                  onClick={() =>
                    void run(() => api.decide({ requestId: current.requestId, decision: "allow" }))
                  }
                >
                  {current.allowLabel}
                </button>
                {current.canViewRequest && (
                  <button
                    type="button"
                    className={button}
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        api.decide({ requestId: current.requestId, decision: "details" })
                      )
                    }
                  >
                    查看完整请求
                  </button>
                )}
              </div>
            </div>
          )}
          {snapshot.paused.map((source) => (
            <div
              key={source.id}
              className="flex items-center justify-between gap-2 border-t pt-2 text-xs"
            >
              <span className="min-w-0 break-all">
                {source.modId} · 会话 {source.threadId.slice(0, 8)} 已暂停请求
              </span>
              <button
                type="button"
                className={button}
                disabled={busy}
                onClick={() => void run(() => api.resume(source.id))}
              >
                恢复申请
              </button>
            </div>
          ))}
        </div>
      )}
      {error && (
        <div role="status" className="mt-2 text-xs">
          <p>{error}</p>
          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={() => void run(async () => {})}
          >
            刷新请求
          </button>
        </div>
      )}
    </section>
  )
}
