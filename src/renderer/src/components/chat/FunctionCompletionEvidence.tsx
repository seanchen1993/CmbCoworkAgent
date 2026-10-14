import {
  statuses,
  detailText,
  label,
  nextAction,
  completionEvidenceOverview
} from "./function-completion-summary"
import { publishClawNotice } from "@/lib/claw-sidebar"
import { withModsChatScope } from "../../lib/mods-chat-scope"
import { isModSiteChangeScope } from "../../../../shared/mods/types"
import { useEffect, useState } from "react"
import { invalidateModsGlobalEnabled, readModsGlobalEnabled } from "../../lib/mods-global-enabled"
import type { CompletionEvidenceRecord } from "../../../../main/mods/v2/completion-evidence"
import { isModObject } from "../../../../shared/mods/v2/contracts"
import { FunctionSiteLifetime } from "../../lib/function-site-lifecycle"
import { FunctionCheckpointInspection } from "./FunctionCheckpointInspection"

export function FunctionCompletionEvidenceContent({
  records
}: {
  records: CompletionEvidenceRecord[]
}): React.JSX.Element | null {
  const overview = completionEvidenceOverview(records)
  if (!overview) return null
  const { sorted, currentStatus, repairRequests, reportOnly, outcome } = overview
  const visible = sorted.slice(0, 24)
  return (
    <details
      className="mx-auto mb-2 max-w-3xl rounded border px-3 py-2 text-xs"
      data-completion-evidence
    >
      <summary className="cursor-pointer">
        完成检查证据 · {reportOnly ? "报告已记录" : statuses[currentStatus]} · {records.length}{" "}
        条记录
        <span className="mt-1 block font-medium" data-completion-overview>
          {outcome}
        </span>
        {repairRequests > 0 && (
          <span className="block">
            本轮已请求修复 {repairRequests} 轮（实际完成情况见复检结果）。
          </span>
        )}
        <span className="block text-muted-foreground">展开查看检查明细与版本证据</span>
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
            {record.phase === "state.transition" &&
              /^[a-f0-9]{64}$/.test(detailText(record, "operationId")) && (
                <FunctionCheckpointInspection threadId={record.threadId} recordId={record.id} />
              )}
            <details className="mt-1 text-muted-foreground">
              <summary className="cursor-pointer">技术详情 · 检查规则与版本</summary>
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
                    diff：{record.binding.diffFingerprint} · 配置：
                    {record.binding.configFingerprint}
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
            </details>
          </li>
        ))}
      </ol>
    </details>
  )
}

/** This reader never mounts guests or starts checks. Invalidated IPC replies cannot restore old UI. */
export const FunctionCompletionEvidence = withModsChatScope(FunctionCompletionEvidenceSurface)

function FunctionCompletionEvidenceSurface({
  threadId,
  isWorking
}: {
  threadId: string
  isWorking: boolean
}): React.JSX.Element | null {
  const [records, setRecords] = useState<CompletionEvidenceRecord[]>([])
  const [error, setError] = useState("")
  useEffect(() => {
    const overview = completionEvidenceOverview(records)
    publishClawNotice(threadId, "evidence", error ? "检查记录读取失败" : (overview?.notice ?? ""))
    return () => publishClawNotice(threadId, "evidence", "")
  }, [records, error, threadId])
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
        const enabled = await readModsGlobalEnabled()
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
      invalidateModsGlobalEnabled()
      lifetime.invalidate()
      setRecords([])
      setError("")
      void refresh()
    }
    const stopCards = window.api.mods.onCardsChanged((event) => {
      if (
        event.threadId === threadId &&
        event.scope !== "panes" &&
        !isModSiteChangeScope(event.scope)
      )
        void refresh()
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
