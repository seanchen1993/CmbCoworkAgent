import { useEffect, useRef, useState } from "react"
import type { BuiltinRunOverview as Overview } from "../../../../shared/mods/builtins"
import { BuiltinChangeReview } from "./BuiltinChangeReview"
import { BuiltinProjectAdvisor } from "./BuiltinProjectAdvisor"
import { BuiltinPolicyDecisions, BuiltinOriginalProjectMetrics } from "./BuiltinPolicyMetrics"

const deliveryNames = {
  injected: "已纳入宿主上下文",
  truncated: "部分纳入",
  omitted: "本次未纳入",
  unknown: "待核对"
}

/** Reads on entry or explicit refresh only; never invalidates the conversation's drawings. */
export function BuiltinRunOverview(props: {
  threadId: string
  workspace?: string | null
  visible: boolean
  focusTarget?: "instructions" | "policy"
}) {
  return (
    <ScopedBuiltinRunOverview key={JSON.stringify([props.threadId, props.workspace])} {...props} />
  )
}

function ScopedBuiltinRunOverview({
  threadId,
  workspace,
  visible,
  focusTarget
}: {
  threadId: string
  workspace?: string | null
  visible: boolean
  focusTarget?: "instructions" | "policy"
}) {
  const root = useRef<HTMLElement>(null)
  const [state, setState] = useState<{ threadId: string; data?: Overview; error?: string }>({
    threadId
  })
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(false)
  const request = useRef(0)
  useEffect(() => {
    const sequence = ++request.current
    if (!visible || !workspace) return
    let current = true
    // Loading mirrors the external IPC request, not derived render state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    void (async () => {
      if (typeof window.api.mods.builtinOverview !== "function")
        throw Error("请完全退出并重新启动应用，以加载新的内置功能接口。")
      const data = await window.api.mods.builtinOverview(threadId, workspace)
      if (!current || sequence !== request.current) return
      if (data.threadId !== threadId) throw Error("聊天已切换，请重新打开运行过程。")
      setState({ threadId, data })
    })()
      .catch((error) => {
        if (current && sequence === request.current)
          setState((previous) => ({
            threadId,
            ...(previous.threadId === threadId ? { data: previous.data } : {}),
            error: error instanceof Error ? error.message : "读取记录失败，请重试。"
          }))
      })
      .finally(() => {
        if (current && sequence === request.current) setLoading(false)
      })
    return () => {
      current = false
    }
  }, [threadId, workspace, visible, refresh])
  const data = state.threadId === threadId ? state.data : undefined
  useEffect(() => {
    if (!focusTarget || !data) return
    root.current?.querySelector<HTMLElement>(`[data-builtin-target="${focusTarget}"]`)
      ?.scrollIntoView({ block: "nearest" })
  }, [data, focusTarget])
  return (
    <section ref={root} aria-label="本次规范与运行概况" className="space-y-3 rounded-xl border p-4 text-xs">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-medium">本次规范与运行概况</h3>
        <button
          type="button"
          disabled={loading}
          className="shrink-0 underline disabled:opacity-50"
          onClick={() => setRefresh((value) => value + 1)}
        >
          {loading ? "读取中…" : "更新记录"}
        </button>
      </div>
      {state.threadId === threadId && state.error && (
        <p role="alert" className="break-words text-destructive">
          {state.error}
          {data && " 以下保留上次读取结果。"}
        </p>
      )}
      {!data ? (
        <p className="text-muted-foreground">{loading ? "正在读取已有记录。" : "暂无可用记录。"}</p>
      ) : (
        <>
          <p className="text-muted-foreground">
            上次读取：{new Date(data.capturedAt).toLocaleString()}
          </p>
          {data.project?.state === "observed" && (
            <div className="space-y-1 rounded bg-muted/30 p-3">
              <p>
                本会话对应第 {data.project.stageNumber} / {data.project.totalStages} 阶段。 项目
                {data.project.projectStatus === "completed"
                  ? "已完成"
                  : `当前在第 ${data.project.currentStageNumber} 阶段`}
                。
              </p>
              <p>
                本次检查：{data.project.checks.passed} 项通过，{data.project.checks.failed} 项失败，
                {data.project.checks.blocked + data.project.checks.unknown} 项尚未确认。
              </p>
              <p className="text-muted-foreground">
                这些是已保存的检查结果，不代表文件现在仍有效。
                {!data.project.receiptsMatchCurrentVersion &&
                  "项目已推进，当前会话的检查属于之前的阶段版本。"}
              </p>
            </div>
          )}
          <details data-builtin-target="instructions" open={focusTarget === "instructions" || undefined}>
            <summary className="cursor-pointer font-medium">项目规范 · 查看本次加载来源</summary>
            <p className="mt-2 leading-5 text-muted-foreground">{data.instructions.message}</p>
            <p className="mt-2 text-muted-foreground">
              以下按宿主加载顺序列出。顺序用于核对来源，不代表已经自动解决互相矛盾的规范。
              自然语言冲突需要核对：请打开所列来源，按原项目规则确认；此处不替你裁定或修改规范。
            </p>
            {data.instructions.snapshot?.origin === "disabled" && (
              <p className="mt-2">本次未启用宿主规范加载。</p>
            )}
            <ul className="mt-2 space-y-2">
              {data.instructions.snapshot?.entries.map((entry, index) => (
                <li key={`${entry.path}:${index}`} className="rounded-md bg-muted/30 p-2 leading-5">
                  <p className="break-all font-medium">{entry.path}</p>
                  <p>
                    {deliveryNames[entry.delivery]} ·{" "}
                    {entry.layer === "user"
                      ? "用户规范"
                      : entry.layer === "local"
                        ? "本地补充"
                        : entry.layer === "plugin"
                          ? "项目插件"
                          : "项目规范"}
                  </p>
                  <p className="break-all text-muted-foreground">范围：{entry.scope}</p>
                  <p className="text-muted-foreground">{entry.reason}</p>
                </li>
              ))}
            </ul>
            {data.instructions.snapshot && !data.instructions.snapshot.entries.length && (
              <p className="mt-2 text-muted-foreground">本次没有可逐文件展示的规范来源。</p>
            )}
            <details className="mt-2 text-muted-foreground">
              <summary className="cursor-pointer">模型请求时的核对</summary>
              {data.instructions.snapshot?.finalRequests?.length ? (
                <ul className="mt-2 space-y-1">
                  {data.instructions.snapshot.finalRequests.map((item) => (
                    <li key={item.requestId}>
                      {new Date(item.observedAt).toLocaleTimeString()} · {item.reason}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2">暂无模型请求边界记录；不能据此认定规范已发送给模型。</p>
              )}
            </details>
          </details>
          {!!data.instructions.snapshot?.children?.length && (
            <details>
              <summary>子任务规范 · 独立观测</summary>
              <p>最多保留32个子运行；没有记录表示未知。子任务记录不替代主会话规范。</p>
              {data.instructions.snapshot.children.map((child) => (
                <div key={child.runId} className="mt-2 rounded border p-2">
                  <p>
                    {child.agentId} ·{" "}
                    {child.childSource === "independent-runtime"
                      ? "独立运行实际装载"
                      : "Task实际模型请求"}
                  </p>
                  <p className="break-all">范围：{child.workspace}</p>
                  <p>
                    {child.origin === "disabled"
                      ? "原角色未启用规范继承"
                      : `记录 ${child.entries.length} 个来源`}
                  </p>
                  {child.entries.map((entry, index) => (
                    <p key={index} className="break-all">
                      {entry.path} · {deliveryNames[entry.delivery]} · {entry.reason}
                    </p>
                  ))}
                  {child.finalRequests?.map((item) => (
                    <p key={item.requestId}>{item.reason}</p>
                  ))}
                  {!child.finalRequests?.length && <p>最终请求尚无记录，不能认定已发送。</p>}
                </div>
              ))}
            </details>
          )}
          <BuiltinChangeReview threadId={threadId} workspace={workspace} />
          <BuiltinProjectAdvisor
            threadId={threadId}
            workspace={workspace}
            visible={visible}
            observationRevision={data.capturedAt}
          />
          <details>
            <summary className="cursor-pointer font-medium">执行度量 · 已保留的调用记录</summary>
            <p className="mt-2 leading-5">
              {data.metrics.sampled} 条记录： 已完成 {data.metrics.succeeded}，失败{" "}
              {data.metrics.failed}，执行中 {data.metrics.running}， 结果未确认{" "}
              {data.metrics.unknown}。
            </p>
            <p className="mt-1">
              有回执的输入用量：{data.metrics.inputTokens ?? "未知"}； 输出用量：
              {data.metrics.outputTokens ?? "未知"} tokens；费用：未知。
            </p>
            <p className="mt-2 leading-5 text-muted-foreground">{data.metrics.explanation}</p>
            <BuiltinOriginalProjectMetrics value={data.legacyMetrics} />
            {data.metrics.limited && (
              <p className="mt-1 text-muted-foreground">
                仅展示最近 100 条；完整过程请查看对应运行记录。
              </p>
            )}
          </details>
          <details data-builtin-target="policy" open={focusTarget === "policy" || undefined}>
            <summary className="cursor-pointer font-medium">使用限制 · 查看限制与说明</summary>
            <p className="mt-2 leading-5 text-muted-foreground">{data.policy.explanation}</p>
            <p className="mt-2">
              {data.policy.required
                ? "宿主强制灵件策略已启用。"
                : "宿主未要求强制启用灵件；原工具与项目审批规则仍然适用。"}
            </p>
            {!!data.policy.blockedTools.length && (
              <p className="mt-2 break-all">禁止调用：{data.policy.blockedTools.join("、")}</p>
            )}
            <p className="mt-2">本页记录范围内被阻止的输出：{data.policy.recordedBlocks} 条。</p>
            <BuiltinPolicyDecisions view={data.policy.decisions} />
          </details>
          {!!data.suggestions.length && (
            <div className="space-y-2 border-t pt-3">
              <h4 className="font-medium">下一步建议</h4>
              {data.suggestions.map((item) => (
                <div key={item.id} className="leading-5">
                  <p>{item.title}</p>
                  <p className="text-muted-foreground">{item.detail}</p>
                </div>
              ))}
              <p className="text-muted-foreground">
                依据已有记录整理，未调用模型，也不会自动执行。
              </p>
            </div>
          )}
        </>
      )}
    </section>
  )
}
