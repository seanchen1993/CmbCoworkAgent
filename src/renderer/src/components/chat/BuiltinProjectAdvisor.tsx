import { useEffect, useRef, useState } from "react"
import type { BuiltinAdvisorView } from "../../../../shared/mods/builtin-advisor"

export function BuiltinProjectAdvisor(props: {
  threadId: string
  workspace?: string | null
  visible: boolean
  observationRevision?: number
}) {
  return <ScopedAdvisor key={JSON.stringify([props.threadId, props.workspace])} {...props} />
}
function ScopedAdvisor({
  threadId,
  workspace,
  visible,
  observationRevision
}: {
  threadId: string
  workspace?: string | null
  visible: boolean
  observationRevision?: number
}) {
  const [view, setView] = useState<BuiltinAdvisorView>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const current = useRef(0)
  const mounted = useRef(false)
  const pendingAction = useRef<string | null>(null)
  const pendingCancellation = useRef<Promise<void>>(Promise.resolve())
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      current.current++
    }
  }, [])
  useEffect(() => {
    if (!visible || !workspace) return
    setBusy(false)
    setView((previous) => (previous ? { ...previous, result: undefined } : previous))
    setError("")
    pendingAction.current = null
    const token = ++current.current
    void pendingCancellation.current
      .then(() => window.api.mods.builtinAdvisor(threadId, workspace, "view"))
      .then((value) => {
        if (mounted.current && token === current.current) setView(value)
      })
      .catch(() => {
        if (mounted.current && token === current.current)
          setError("暂时无法读取建议设置，请重开运行过程。")
      })
    return () => {
      current.current++
      pendingCancellation.current = window.api.mods
        .builtinAdvisor(threadId, workspace, "cancel")
        .then(
          () => undefined,
          () => undefined
        )
    }
  }, [threadId, workspace, visible, observationRevision])
  async function action(kind: "enable" | "disable" | "analyze" | "cancel" | "dismiss") {
    if (!workspace || !visible) return
    if (
      pendingAction.current &&
      (pendingAction.current !== "analyze" || (kind !== "cancel" && kind !== "disable"))
    )
      return
    const token = ++current.current
    pendingAction.current = kind
    setBusy(true)
    setError("")
    try {
      const value = await window.api.mods.builtinAdvisor(threadId, workspace, kind)
      if (mounted.current && token === current.current) setView(value)
    } catch (cause) {
      if (mounted.current && token === current.current)
        setError(cause instanceof Error ? cause.message : "分析未完成")
    } finally {
      if (mounted.current && token === current.current) {
        pendingAction.current = null
        setBusy(false)
      }
    }
  }
  return (
    <details>
      <summary className="cursor-pointer font-medium">智能建议 · 可选</summary>
      <p className="mt-2 leading-5 text-muted-foreground">
        让当前模型分析已有调用统计和可用的阶段检查记录，帮你整理下一步。
        不发送文件正文，不执行操作。会产生模型用量，金额取决于你的模型服务。
      </p>
      <label className="mt-2 flex items-center gap-2">
        <input
          type="checkbox"
          checked={view?.enabled ?? false}
          disabled={!view || !visible}
          onChange={(event) => void action(event.target.checked ? "enable" : "disable")}
        />
        在本次应用会话中启用
      </label>
      {view?.enabled && (
        <div className="mt-2 flex flex-wrap gap-3">
          <button
            type="button"
            disabled={busy || view.running}
            className="underline disabled:opacity-50"
            onClick={() => void action("analyze")}
          >
            {busy ? "正在分析…" : "分析已有记录"}
          </button>
          {(busy || view.running) && (
            <button type="button" className="underline" onClick={() => void action("cancel")}>
              停止分析
            </button>
          )}
        </div>
      )}
      {error && (
        <div role="alert" className="mt-2 text-destructive">
          <p>
            {/COOLDOWN/.test(error)
              ? "请间隔一分钟再分析。"
              : /DAILY_LIMIT/.test(error)
                ? "今天的建议分析次数已用完，规则提示仍可使用。"
                : /CANCELLED/.test(error)
                  ? "分析已停止。"
                  : /FACTS_CHANGED/.test(error)
                    ? "运行情况已经变化，请更新记录后重新分析。旧建议不会继续显示。"
                    : "分析未完成，已有项目和聊天不受影响。"}
          </p>
          <details>
            <summary className="cursor-pointer">问题详情</summary>
            <p className="break-all">{error}</p>
          </details>
        </div>
      )}
      {view?.result && (
        <div className="mt-3 space-y-2 rounded bg-muted/30 p-2">
          <p className="whitespace-pre-wrap break-words leading-5">{view.result.text}</p>
          <p className="text-muted-foreground">
            生成于 {new Date(view.result.at).toLocaleString()}。建议供参考，不是验证结果。
          </p>
          <button
            type="button"
            className="underline disabled:opacity-50"
            disabled={busy}
            onClick={() => void action("dismiss")}
          >
            忽略这条建议
          </button>
          <details>
            <summary className="cursor-pointer text-muted-foreground">用量与限制</summary>
            <p>
              输入 {view.result.inputTokens ?? "未知"}；输出 {view.result.outputTokens ?? "未知"}{" "}
              tokens。费用未知。
            </p>
          </details>
        </div>
      )}
      <p className="mt-2 text-muted-foreground">
        全应用每天最多 {view?.dailyLimit ?? 10} 次，间隔至少一分钟； 单次最多{" "}
        {view?.outputTokenLimit ?? 512} 输出 tokens，30 秒超时。关闭面板会停止当前分析。
      </p>
    </details>
  )
}
