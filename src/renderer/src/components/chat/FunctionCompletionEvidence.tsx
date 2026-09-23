import { useEffect, useState } from "react"
import type { CompletionEvidenceRecord } from "../../../../main/mods/v2/completion-evidence"
import { isModObject } from "../../../../shared/mods/v2/contracts"
import { FunctionSiteLifetime } from "../../lib/function-site-lifecycle"

const statuses = {
  completed: "步骤已结束",
  running: "执行中",
  pass: "通过",
  revise: "需要修复并复检",
  block: "阻止完成",
  stale: "证据已失效",
  cancelled: "已取消",
  error: "检查错误",
  interrupted: "执行中断"
}
const phases = {
  "capture.started": "开始采集文件证据",
  "capture.failed": "文件证据采集失败",
  "check.started": "开始检查",
  "check.result": "完成门禁",
  "repair.attempt": "修复尝试",
  "validator.result": "检查结果",
  "state.transition": "checkpoint 推进"
}
function detailText(record: CompletionEvidenceRecord, key: string): string {
  const value = isModObject(record.detail) ? record.detail[key] : undefined
  return typeof value === "string" ? value.slice(0, 2048) : ""
}
function label(record: CompletionEvidenceRecord): string {
  if (record.phase === "check.result") return "完成门禁"
  if (detailText(record, "source").startsWith("guest")) return "插件评审意见"
  const kind = detailText(record, "kind")
  return kind === "unit-test"
    ? "宿主单元测试"
    : kind === "e2e"
      ? "宿主 E2E"
      : kind === "autobiz-validator" ||
          (record.phase === "validator.result" &&
            isModObject(record.detail) &&
            typeof record.detail.sourceCommit === "string")
        ? "宿主 Autobiz validator"
        : record.phase === "invalidated"
          ? "证据失效"
          : phases[record.phase]
}
function nextAction(record: CompletionEvidenceRecord): string {
  if (record.phase === "capture.started")
    return record.status === "running"
      ? "正在读取当前文件、需求和配置；尚未形成检查结论。"
      : record.status === "completed"
        ? "采集步骤已结束，请查看后续检查结果；此步骤不代表检查通过。"
        : "采集中断，尚未取得完整文件证据；恢复任务后重新检查，不自动重放。"
  if (record.phase === "capture.failed")
    return "尚未取得文件和需求证据；检查路径、文件大小或读取权限，缩小范围后重新检查。"
  if (record.phase === "state.transition" && record.status === "interrupted")
    return "提交结果未知。请先按操作编号复核宿主提交日志、state.json 与 STATE.md；不要直接重试推进。"
  const reason = detailText(record, "reason") || detailText(record, "error")
  if (reason.includes("MODEL_BUDGET"))
    return "调整模型总预算或缩小范围后重新执行；已有用量不会被本次重试清零。"
  if (reason.includes("TIMEOUT")) return "检查耗时步骤，调整最长时间或范围后重新执行。"
  if (reason.includes("USAGE_"))
    return "检查模型服务的实际输入和输出用量返回；缺失用量时不能确认通过。"
  if (record.status === "stale") return "文件、需求或配置已变化，请对当前版本重新检查。"
  if (record.status === "cancelled" || record.status === "interrupted")
    return "执行未完成；恢复权限或任务后对当前版本重新检查。"
  if (record.status === "revise") return "原 Agent 修复后重新运行已选检查。"
  if (record.status === "block" || record.status === "error")
    return "根据失败原因修复代码、测试或配置后重新检查。"
  if (record.phase === "state.transition" && record.status === "pass")
    return "checkpoint 已由宿主确认；继续下一阶段。"
  return record.status === "running"
    ? "等待检查结果。"
    : "此记录仅对应所列检查和文件版本，不代表业务验收。"
}

export function FunctionCompletionEvidenceContent({
  records
}: {
  records: CompletionEvidenceRecord[]
}): React.JSX.Element | null {
  if (!records.length) return null
  const sorted = [...records].sort((a, b) => b.at - a.at)
  const visible = sorted.slice(0, 24)
  const latest = sorted.find((record) => record.phase !== "invalidated") ?? sorted[0]
  const latestInvalidation = sorted.find(
    (record) =>
      record.phase === "invalidated" &&
      record.at >= latest.at &&
      JSON.stringify(record.binding) === JSON.stringify(latest.binding)
  )
  // A delayed invalidation from an older runtime does not change newer execution
  // facts. A confirmed checkpoint transition remains a historical commit fact.
  const currentStatus =
    latest.phase !== "state.transition" && latest.status === "pass" && latestInvalidation
      ? "stale"
      : latest.status
  return (
    <details
      className="mx-auto mb-2 max-w-3xl rounded border px-3 py-2 text-xs"
      data-completion-evidence
    >
      <summary className="cursor-pointer">
        完成检查证据 · {statuses[currentStatus]} · {records.length} 条记录
      </summary>
      <p className="mt-2 text-muted-foreground">
        来自宿主历史执行记录，仅对所列文件版本有效。文件、需求或配置变化后需要重新检查。插件评审意见不代表测试通过或业务验收。显示最近{" "}
        {visible.length} 条。
      </p>
      <ol className="mt-2 space-y-3">
        {visible.map((record) => (
          <li key={record.id} data-completion-record={record.id} className="border-t pt-2">
            <strong>
              {label(record)} · {statuses[record.status]}
            </strong>
            <p className="whitespace-pre-wrap break-words">
              {detailText(record, "reason") || detailText(record, "error")}
            </p>
            <p>下一步：{nextAction(record)}</p>
            {isModObject(record.detail) &&
              Array.isArray(record.detail.rules) &&
              record.detail.rules.filter(isModObject).map((rule, index) => (
                <p key={index} className="break-words">
                  本次规则 {String(rule.plugin)}：{String(rule.mode)} ·{" "}
                  {String(rule.scope ?? "插件定义")}
                  {Array.isArray(rule.checks) &&
                    ` · ${rule.checks.filter((check) => typeof check === "string").join(" + ")}`}
                  {typeof rule.maxRepairs === "number" && ` · 最多修复 ${rule.maxRepairs} 次`}
                  {typeof rule.timeoutMs === "number" && ` · 最长 ${rule.timeoutMs} ms`}
                  {typeof rule.modelTokenBudget === "number" &&
                    ` · 模型输入+输出总预算 ${rule.modelTokenBudget} tokens`}
                </p>
              ))}
            {record.binding ? (
              <details className="mt-1 text-muted-foreground">
                <summary>版本与检查证据</summary>
                <p className="break-all">
                  任务 {record.threadId} · 轮次 {record.turnId} · 运行 {record.runId} · generation{" "}
                  {record.binding.runtimeGeneration}
                </p>
                <p className="break-all">需求版本：{record.binding.requirementVersion}</p>
                {detailText(record, "operationId") && (
                  <p className="break-all">操作编号：{detailText(record, "operationId")}</p>
                )}
                <p className="break-all">
                  diff：{record.binding.diffFingerprint} · 配置：{record.binding.configFingerprint}
                </p>
                {Object.entries(record.binding.pluginDigests).map(([name, digest]) => (
                  <p key={name} className="break-all">
                    插件 {name}：{digest}
                  </p>
                ))}
                {detailText(record, "outputFingerprint") && (
                  <p className="break-all">检查输出：{detailText(record, "outputFingerprint")}</p>
                )}
                {isModObject(record.detail) && typeof record.detail.inputTokens === "number" && (
                  <p>
                    实际模型用量：输入 {record.detail.inputTokens} · 输出{" "}
                    {String(record.detail.outputTokens ?? "未返回")}
                  </p>
                )}
                <p>文件指纹 {record.binding.files.length} 项（显示前 24 项）</p>
                {record.binding.files.slice(0, 24).map((file) => (
                  <p key={file.path} className="break-all">
                    {file.path} · {file.sha256}
                  </p>
                ))}
              </details>
            ) : (
              <details className="mt-1 text-muted-foreground">
                <summary>执行身份（未取得文件证据）</summary>
                <p className="break-all">
                  任务 {record.threadId} · 轮次 {record.turnId} · 运行 {record.runId} · generation{" "}
                  {record.capture.runtimeGeneration}
                </p>
                <p className="break-all">配置：{record.capture.configFingerprint}</p>
                {Object.entries(record.capture.pluginDigests).map(([name, digest]) => (
                  <p key={name} className="break-all">
                    插件 {name}：{digest}
                  </p>
                ))}
                <p>未生成 diff、需求版本、文件指纹或 checkpoint 推进凭据。</p>
              </details>
            )}
          </li>
        ))}
      </ol>
    </details>
  )
}

/** This reader never mounts guests or starts checks. Invalidated IPC replies cannot restore old UI. */
export function FunctionCompletionEvidence({
  threadId,
  isWorking
}: {
  threadId: string
  isWorking: boolean
}): React.JSX.Element | null {
  const [records, setRecords] = useState<CompletionEvidenceRecord[]>([])
  const [error, setError] = useState("")
  useEffect(() => {
    const lifetime = new FunctionSiteLifetime()
    let stopped = false
    let running = false
    let queued = false
    setRecords([])
    const refresh = async (): Promise<void> => {
      lifetime.invalidate()
      if (stopped) return
      if (running) {
        queued = true
        return
      }
      running = true
      const ticket = lifetime.capture()
      try {
        const enabled = await window.api.mods.globalEnabled()
        if (!ticket.current()) return
        const next = enabled ? await window.api.mods.completionEvidence(threadId) : []
        ticket.commit(() => {
          setRecords(next)
          setError("")
        })
      } catch {
        ticket.commit(() => {
          setRecords([])
          setError("宿主检查记录暂不可用，请稍后重试。")
        })
      } finally {
        running = false
        if (queued && !stopped) {
          queued = false
          void refresh()
        }
      }
    }
    const reset = (): void => {
      lifetime.invalidate()
      setRecords([])
      setError("")
      void refresh()
    }
    const stopCards = window.api.mods.onCardsChanged((event) => {
      if (event.threadId === threadId) void refresh()
    })
    const stopConfiguration = window.api.mods.onConfigurationChanged(reset)
    window.addEventListener("mods:configuration-changed", reset)
    void refresh()
    return () => {
      stopped = true
      lifetime.close()
      stopCards()
      stopConfiguration()
      window.removeEventListener("mods:configuration-changed", reset)
    }
  }, [threadId, isWorking])
  return error ? (
    <p className="mx-auto max-w-3xl text-xs text-muted-foreground">{error}</p>
  ) : (
    <FunctionCompletionEvidenceContent records={records} />
  )
}
