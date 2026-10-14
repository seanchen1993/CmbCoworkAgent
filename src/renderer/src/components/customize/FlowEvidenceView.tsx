import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import type { FlowRun } from "../../../../shared/mods/flows/types"
import type { FlowExecutionEvidenceView } from "../../../../shared/mods/flows/execution-evidence"

const sources = {
  agent: "模型判断",
  "native-check": "检查步骤",
  approval: "人工确认",
  host: "宿主",
  "plugin-action": "插件动作",
  skill: "Skill",
  "mcp-tool": "MCP",
  unknown: "来源未确认"
}
const checks = {
  "native-project-test": "宿主项目测试",
  "native-virtual-test": "隔离文件树原生测试",
  "completion-gate": "完成门禁",
  "plugin-opinion": "插件意见",
  unknown: "证据类型未确认"
}
const states = {
  found: "已关联历史记录",
  missing: "记录缺失",
  invalid: "记录未通过完整性核对",
  limited: "记录超出读取上限",
  unlinked: "不能作为宿主检查证据"
}
const outcomes = {
  pass: "通过",
  block: "未通过",
  revise: "需要修复",
  cancelled: "已取消",
  error: "出错",
  interrupted: "中断",
  stale: "已失效"
}

export function FlowEvidenceView({ run }: { run: FlowRun }) {
  const currentRun = useRef(run)
  currentRun.current = run
  const sequence = useRef(0)
  const [state, setState] = useState<{
    source: FlowRun
    loading?: boolean
    view?: FlowExecutionEvidenceView
    failed?: boolean
  }>()
  useEffect(
    () => () => {
      sequence.current++
    },
    [run]
  )
  const current = state?.source === run ? state : undefined
  const inspect = async () => {
    const request = ++sequence.current
    setState({ source: run, loading: true })
    try {
      const view = await window.api.mods.flowEvidence(run.threadId, run.id)
      if (request !== sequence.current || currentRun.current !== run) return
      if (view.runId !== run.id) throw Error("scope")
      setState({ source: run, view })
    } catch {
      if (request === sequence.current && currentRun.current === run)
        setState({ source: run, failed: true })
    }
  }
  return (
    <section aria-label="执行证据" className="space-y-3 rounded-lg border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-medium">执行证据</h4>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={current?.loading}
          onClick={() => {
            void inspect()
          }}
        >
          {current?.loading ? "正在读取证据…" : "展开历史证据"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        只读持久记录，不执行检查。历史通过仅对应当时结算，当前文件与权限未重新核验。
      </p>
      {current?.failed && (
        <p role="alert" className="text-sm text-destructive">
          无法读取此运行的证据，请刷新后重试。
        </p>
      )}
      {current?.view && (
        <div className="space-y-3 text-xs">
          {current.view.partial && (
            <p role="status">部分记录缺失、损坏或超出读取上限；不能据此确认完整执行历史。</p>
          )}
          {current.view.lineage.state !== "none" && (
            <p>
              恢复关联：
              {current.view.lineage.state === "linked" ? "父链记录已关联" : "父链未完整确认"}
              {current.view.lineage.parentRunId && (
                <span className="break-all"> · 来源 {current.view.lineage.parentRunId}</span>
              )}
            </p>
          )}
          <ol className="max-h-[32rem] space-y-3 overflow-y-auto" aria-label="历史执行证据列表">
            {current.view.attempts.map((attempt, index) => (
              <li key={`${attempt.executionId}:${index}`} className="space-y-1 rounded border p-2">
                <p className="break-all font-medium">
                  {attempt.stepId} · {sources[attempt.source]}
                </p>
                <p>
                  {attempt.historicalValidity === "invalidated"
                    ? "此运行已将结果标记失效"
                    : attempt.historicalValidity === "settled"
                      ? "已记录历史结算"
                      : "尚无确定结算"}
                </p>
                {attempt.reusedFrom && (
                  <p className="break-all">
                    复用来源：{attempt.reusedFrom.runId} / {attempt.reusedFrom.executionId}（
                    {attempt.reusedFrom.state === "linked" ? "记录内容已关联" : "关联未确认"}）
                  </p>
                )}
                {attempt.receipt.state === "recorded" ? (
                  <p>
                    {attempt.receipt.coverage === "prompt-prior-and-virtual-root" ? "文件执行回执：覆盖提示词、前序记录与隔离文件树；逻辑模型调用 " : "文本执行回执：仅覆盖提示词与前序文本记录；逻辑模型调用 "}
                    {attempt.receipt.modelCalls} 次，不代表网络请求总数或当前恢复资格。
                  </p>
                ) : attempt.receipt.state === "invalid" ? (
                  <p>执行回执未通过历史完整性核对。</p>
                ) : null}
                {attempt.checks.map((check) => (
                  <p key={check.id} className="break-all">
                    {checks[check.kind]} · {states[check.state]}
                    {check.status ? ` · 历史结果：${outcomes[check.status]}` : ""}
                    {check.check ? ` · ${check.check}` : ""}
                    <span className="text-muted-foreground"> · {check.id}</span>
                  </p>
                ))}
                {attempt.source === "native-check" && !attempt.checks.length && (
                  <p>没有可关联的宿主检查回执。</p>
                )}
                {attempt.omittedChecks > 0 && <p>另有 {attempt.omittedChecks} 条引用未展示。</p>}
              </li>
            ))}
          </ol>
          {current.view.omittedAttempts > 0 && (
            <p>另有 {current.view.omittedAttempts} 条步骤记录未展示。</p>
          )}
          {!current.view.attempts.length && <p>没有步骤执行记录。</p>}
        </div>
      )}
    </section>
  )
}
