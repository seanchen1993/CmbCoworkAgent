import { useEffect, useRef, useState } from "react"
import type { ModAuditEntry } from "../../../../shared/mods/types"
import { Button } from "@/components/ui/button"

const execution = {
  not_started: "未执行",
  running: "执行中",
  succeeded: "已成功",
  failed: "已失败",
  unknown: "结果待核查"
}
const publication = { pending: "待发布", published: "已检查", blocked: "已阻止发布" }

export function ModsAudit(props: {
  threadId: string
  expectedWorkspace?: string
}): React.JSX.Element {
  return (
    <ScopedModsAudit key={JSON.stringify([props.threadId, props.expectedWorkspace])} {...props} />
  )
}

function ScopedModsAudit({
  threadId,
  expectedWorkspace
}: {
  threadId: string
  expectedWorkspace?: string
}): React.JSX.Element {
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const [rows, setRows] = useState<ModAuditEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [more, setMore] = useState(false)
  useEffect(() => {
    setRows([])
    setMore(false)
    setError("")
  }, [threadId])
  async function load(append = false): Promise<void> {
    setBusy(true)
    setError("")
    try {
      const page = await window.api.mods.audit(
        threadId,
        append ? rows.at(-1)?.cursor : undefined,
        expectedWorkspace
      )
      if (!alive.current) return
      setRows((old) => (append ? [...old, ...page] : page))
      setMore(page.length === 50)
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : "读取记录失败")
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  async function reconcile(
    row: ModAuditEntry,
    resolution: "confirmed-success" | "confirmed-failure"
  ): Promise<void> {
    setBusy(true)
    try {
      await window.api.mods.reconcile(threadId, row.callId, resolution, expectedWorkspace)
      if (alive.current) await load()
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : "记录失败")
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  return (
    <details data-mods-audit>
      <summary
        className="cursor-pointer"
        onClick={() => {
          if (!rows.length && !busy) void load()
        }}
      >
        项目调用记录 · 包含本项目其他聊天
      </summary>
      <p className="text-xs text-muted-foreground my-2">
        这里包含本项目所有聊天的调用记录。结果不明时，先核对实际文件或外部系统，再记录结论；不会重新执行操作。
      </p>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void load()}>
          刷新记录
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void window.api.mods
              .backup()
              .catch((e) => setError(String(e)))
              .finally(() => setBusy(false))
          }}
        >
          备份授权与记录
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="max-h-80 overflow-auto space-y-2 mt-2">
        {rows.map((row) => (
          <div key={row.callId} className="rounded border p-2 text-xs space-y-1">
            <p>
              <strong>{row.toolId}</strong> · {execution[row.status]} ·{" "}
              {publication[row.publication]}
            </p>
            <p>
              {new Date(row.startedAt).toLocaleString()} · {row.identity?.origin} ·{" "}
              {row.identity?.modId ?? "宿主"}
            </p>
            <p>
              下一步：
              {row.reconciliation
                ? "人工核查结论已记录，请结合实际产物决定后续处理；这里不会自动重试。"
                : row.status === "unknown"
                  ? "先核对实际产物，再使用下方按钮记录核查结论，不要直接重试。"
                  : row.status === "failed"
                    ? "本记录未提供具体失败原因，请结合步骤结果和灵件日志排查。"
                    : row.status === "running"
                      ? "等待执行结果；记录刷新不会重新执行。"
                      : row.publication === "blocked"
                        ? "输出未通过发布检查，请核对检查规则；不要仅因看不到输出就重复执行。"
                        : "可查看对应任务结果；此调用记录不代表整个项目已验收。"}
            </p>
            <details>
              <summary className="cursor-pointer">技术详情 · 调用与检查信息</summary>
              <p className="break-all font-mono">调用：{row.callId}</p>
              {row.modelUsage && (
                <p>
                  模型：{row.modelUsage.modelRef}；输入 Token：
                  {row.modelUsage.inputTokens ?? "未返回"}； 输出 Token：
                  {row.modelUsage.outputTokens ?? "未返回"}； 输出上限：
                  {row.modelUsage.outputTokenLimit}
                </p>
              )}
              <p className="break-all">原始参数 SHA-256：{row.originalArgsHash}</p>
              <p className="break-all">最终参数 SHA-256：{row.finalArgsHash ?? "无"}</p>
              <p className="break-all">策略 SHA-256：{row.policyDigest ?? "未启用"}</p>
              <p>检查规则：{row.ruleIds.join("、") || "无"}</p>
            </details>
            {row.reconciliation && (
              <p>已人工核查：{row.reconciliation === "confirmed-success" ? "成功" : "未成功"}</p>
            )}
            {row.status === "unknown" && !row.reconciliation && (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void reconcile(row, "confirmed-success")}
                >
                  已核实成功
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void reconcile(row, "confirmed-failure")}
                >
                  已核实未成功
                </Button>
              </div>
            )}
          </div>
        ))}
        {!rows.length && !busy && <p className="text-muted-foreground">暂无执行记录。</p>}
      </div>
      {more && (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void load(true)}>
          更早记录
        </Button>
      )}
    </details>
  )
}
