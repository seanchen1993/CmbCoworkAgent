import { FlowTraceView } from "./FlowTraceView"
import { useState } from "react"
import { FlowStepProgress } from "./FlowStepProgress"
import { FlowFilePublicationView } from "./FlowFilePublicationView"
import { Button } from "@/components/ui/button"
import type { FlowRun } from "../../../../shared/mods/flows/types"
import { flowTestEvidence } from "../../../../shared/mods/flows/test-evidence-summary"
import { FlowRecoveryView } from "./FlowRecoveryView"
import { FlowEvidenceView } from "./FlowEvidenceView"

const statuses = {
  queued: "排队中",
  running: "执行中",
  waiting: "等待人工确认",
  complete: "已完成",
  failed: "失败",
  cancelled: "已停止",
  interrupted: "已中断"
}
const attemptStatuses = {
  running: "执行中",
  passed: "通过",
  failed: "未通过",
  skipped: "已跳过",
  waiting: "等待确认",
  unknown: "结果未知"
}

export function FlowRunView({
  run,
  busy,
  onDecide,
  onCancel,
  onResumed,
  stopping = false,
  decisionsDisabled = false,
  presentation = "full"
}: {
  run: FlowRun
  busy: boolean
  onDecide(nonce: string, approve: boolean): void
  onCancel(): void
  onResumed?(run: FlowRun): void
  stopping?: boolean
  decisionsDisabled?: boolean
  presentation?: "full" | "task"
}) {
  const taskPresentation = presentation === "task"
  const active = ["queued", "running", "waiting"].includes(run.status)
  const tests = flowTestEvidence(run)
  const currentAttempts = run.attempts.filter((item) => !item.invalidated)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [evidenceOpen, setEvidenceOpen] = useState(false)
  const uncertain = currentAttempts.some((item) => item.status === "unknown")
  const currentAttempt = currentAttempts.findLast((item) => item.stepId === run.currentStepId)
  const currentName = run.flow.definition.steps.find((step) => step.id === run.currentStepId)?.name
  const nextAction =
    uncertain || run.status === "interrupted"
      ? "先核对实际文件和执行记录，确认哪些操作已经发生，再决定是否恢复；不要直接重复提交。"
      : run.status === "waiting"
        ? "核对成果后，选择同意继续或拒绝停止。"
        : run.status === "failed"
          ? "查看未通过的步骤，修复对应问题后再验证。旧失败记录会保留。"
          : run.status === "cancelled"
            ? "先核对已产生的文件或结果；需要继续时，再选择恢复或重新运行。"
            : run.status === "complete"
              ? "查看成果和检查结果。文件修改后需要重新检查；项目阶段仍按原有验证流程推进。"
              : "任务正在进行，需要停止时可点击“停止任务”。"
  return (
    <section
      aria-label={taskPresentation ? "当前任务进展" : "流程运行详情"}
      className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-5"
      data-flow-run={run.id}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">
          {taskPresentation ? "当前任务" : run.flow.definition.name} · {stopping ? "正在停止" : statuses[run.status]}
        </h3>
        {active && (
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onCancel}>
            {stopping ? "正在停止" : "停止任务"}
          </Button>
        )}
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer break-words font-medium">
          任务：{(run.taskGoal ?? run.flow.definition.goal).slice(0, 100)}
          {(run.taskGoal ?? run.flow.definition.goal).length > 100 ? "…" : ""}
        </summary>
        <p className="mt-2 whitespace-pre-wrap break-words">
          {run.taskGoal ?? run.flow.definition.goal}
        </p>
      </details>
      {taskPresentation && active && !run.pendingApproval && (
        <div role="status" className="space-y-1 rounded-lg bg-primary/5 p-3 text-sm">
          <p>{currentName ? `正在处理：${currentName}` : "正在准备任务"}</p>
          {currentAttempt?.progress?.text && <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
            {currentAttempt.progress.text.slice(-400)}
          </p>}
        </div>
      )}
      {run.pendingApproval && run.status === "waiting" && (
        <div
          className="space-y-3 rounded-xl border border-primary/30 bg-primary/5 p-4"
          role="region"
          aria-label="人工成果确认"
        >
          <h4 className="font-medium">请确认本次成果</h4>
          <FlowReadableText text={run.pendingApproval.summary} label="完整确认内容" />
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">技术详情 · 本次确认的结果</summary>
            <p className="mt-2 break-all">{run.pendingApproval.inputDigest}</p>
          </details>
          <p className="text-xs text-muted-foreground">
            文件或结果改变后会再次请你确认；工具操作仍需单独批准。
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              disabled={busy || decisionsDisabled}
              onClick={() => onDecide(run.pendingApproval!.nonce, true)}
            >
              同意并继续
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy || decisionsDisabled}
              onClick={() => onDecide(run.pendingApproval!.nonce, false)}
            >
              拒绝并停止
            </Button>
          </div>
        </div>
      )}
      {run.summary && !run.pendingApproval && (
        <div className="text-sm" role="status">
          <p className="mb-1 font-medium">{run.status === "failed" ? "失败说明" : "任务结果"}</p>
          <FlowReadableText text={run.summary} label="完整任务结果" />
        </div>
      )}
      {run.status === "failed" && !run.summary && (
        <p className="text-sm text-destructive">
          {taskPresentation
            ? "任务尚未完成。先核对已完成的内容，再决定是否继续。具体原因可展开下方排查详情。"
            : "本次运行未完成，请查看下方未通过步骤；没有具体原因时，请查看灵件日志。"}
        </p>
      )}
      {taskPresentation && (
        <p className="rounded-lg bg-muted/30 p-3 text-sm" data-flow-next-action>
          下一步：{run.status === "complete"
            ? "查看任务结果。需要补充或修改时，直接在聊天中说明。"
            : run.status === "failed"
              ? "核对未完成的内容；可检查能否继续，或回到聊天说明需要如何处理。"
              : nextAction}
        </p>
      )}
      <details open={taskPresentation ? undefined : true} className={taskPresentation ? "space-y-3 text-xs" : "space-y-4"}>
      <summary hidden={!taskPresentation} className="cursor-pointer font-medium">排查详情：执行记录</summary>
      <FlowStepProgress key={`progress:${run.id}`} run={run} />
      {!taskPresentation && !["running", "queued", "waiting"].includes(run.status) && (
        <p className="rounded-lg bg-muted/30 p-3 text-sm" data-flow-next-action>
          下一步：{nextAction}
        </p>
      )}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">技术详情 · 运行编号与版本</summary>
        <p>
          流程保存修订 {run.flow.revision} · {new Date(run.startedAt).toLocaleString()}
        </p>
        <p className="mt-2 break-all">
          {run.id} · 成果代次 {run.epoch}
        </p>
      </details>
      <details
        className="rounded-lg border bg-muted/20 p-3 text-xs leading-5"
        aria-label="原生项目测试证据"
      >
        <summary className="cursor-pointer">测试记录</summary>
        <p>
          {tests.current
            ? `已记录项目测试：通过 ${tests.passed} 次，失败 ${tests.failed} 次。请在技术详情核对原始记录；当前文件尚未重新验证。`
            : "尚无可确认的项目测试结果，不能据此认为测试通过。"}
        </p>
        {!tests.current && !active && <p>请先运行测试，或重新检查已修改的文件。</p>}
        {tests.stale > 0 && <p>{tests.stale} 条旧测试记录已失效，仅供追溯。</p>}
      </details>
      <details onToggle={(event) => setHistoryOpen(event.currentTarget.open)} className="text-xs">
        <summary className="cursor-pointer">历史步骤与技术详情</summary>
        {historyOpen && (
          <ol className="mt-3 max-h-[36rem] space-y-2 overflow-y-auto" aria-label="步骤执行记录">
            {run.attempts.map((attempt) => {
              const step = run.flow.definition.steps.find((s) => s.id === attempt.stepId)
              const name =
                step?.name ??
                (attempt.stepId === "__final_check"
                  ? `最终复检：${attempt.reason ?? "宿主检查"}`
                  : attempt.stepId === "__final"
                    ? "最终验收"
                    : attempt.stepId)
              return (
                <li
                  key={attempt.executionId}
                  className="rounded-lg border bg-background p-3 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{name}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${attempt.status === "failed" || attempt.status === "unknown" ? "bg-destructive/10 text-destructive" : attempt.status === "passed" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}
                    >
                      {attemptStatuses[attempt.status]}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      第 {attempt.attempt} 次尝试
                    </span>
                    {attempt.invalidated && (
                      <span className="text-xs text-amber-600">已失效，不能作为当前通过依据</span>
                    )}
                  </div>
                  {attempt.reason && (
                    <p className="whitespace-pre-wrap break-words text-muted-foreground">
                      {attempt.status === "failed" || attempt.status === "unknown"
                        ? "原因："
                        : "说明："}
                      {attempt.reason}
                    </p>
                  )}
                  {attempt.result && (
                    <details
                      className="mt-1"
                      open={attempt.status === "failed" || attempt.status === "unknown"}
                    >
                      <summary className="cursor-pointer">查看结果与证据</summary>
                      <p className="whitespace-pre-wrap break-words py-2">
                        {attempt.result.summary}
                      </p>
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs">
                          技术详情 · 调用来源与原始输出
                        </summary>
                        <p className="text-xs text-muted-foreground">
                          来源：
                          {attempt.result.source === "skill"
                            ? "Skill 显式激活与模型执行"
                            : attempt.result.source === "mcp-tool"
                              ? "MCP 工具调用"
                              : attempt.result.source === "plugin-action"
                                ? "插件动作"
                                : attempt.result.source === "agent"
                                  ? "Agent 业务判断"
                                  : attempt.result.source === "native-check"
                                    ? "宿主真实检查"
                                    : attempt.result.source === "approval"
                                      ? "人工确认"
                                      : "宿主"}
                          {attempt.result.outputTokens !== undefined
                            ? ` · 输出 ${attempt.result.outputTokens} tokens`
                            : ""}
                        </p>
                        {attempt.result.provider && (
                          <p className="break-all text-xs text-muted-foreground">
                            实际动作：{attempt.result.provider.plugin} /{" "}
                            {attempt.result.provider.actionId}
                          </p>
                        )}
                        {attempt.result.modelId && (
                          <p className="break-all text-xs text-muted-foreground">
                            步骤绑定模型：{attempt.result.modelId}
                          </p>
                        )}
                        {attempt.result.skill && (
                          <p className="break-all text-xs text-muted-foreground">
                            执行 Skill：{attempt.result.skill.name} · {attempt.result.skill.id}
                          </p>
                        )}
                        {attempt.result.mcpTool && (
                          <p className="break-all text-xs text-muted-foreground">
                            调用 MCP：{attempt.result.mcpTool.provider.name} /{" "}
                            {attempt.result.mcpTool.toolName}
                          </p>
                        )}
                        {attempt.result.output && (
                          <details>
                            <summary className="cursor-pointer text-xs">结构化输出</summary>
                            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">
                              {JSON.stringify(attempt.result.output, null, 2)}
                            </pre>
                          </details>
                        )}
                        {attempt.result.evidenceIds?.length ? (
                          <p className="break-all text-xs text-muted-foreground">
                            证据编号：{attempt.result.evidenceIds.join("、")}
                          </p>
                        ) : null}
                      </details>
                    </details>
                  )}
                  {attempt.telemetry && (
                    <details className="mt-2 text-xs">
                      <summary className="cursor-pointer">技术详情 · 执行轨迹</summary>
                      <FlowTraceView
                        key={attempt.executionId}
                        attempt={attempt}
                        parentThreadId={run.threadId}
                      />
                    </details>
                  )}
                </li>
              )
            })}
            {!run.attempts.length && (
              <li className="text-sm text-muted-foreground">尚未执行步骤。</li>
            )}
          </ol>
        )}
      </details>
      <details className="text-xs" onToggle={(event) => setEvidenceOpen(event.currentTarget.open)}>
        <summary className="cursor-pointer">技术详情 · 历史检查证据</summary>
        {evidenceOpen && <FlowEvidenceView key={`evidence:${run.id}`} run={run} />}
      </details>
      </details>
      <FlowFilePublicationView run={run} />
      {!active && (!taskPresentation || run.status !== "complete") && (
        <FlowRecoveryView key={`recovery:${run.id}`} run={run} busy={busy} onResumed={onResumed} />
      )}
      {!active && !taskPresentation && (
        <p className="text-xs text-muted-foreground">
          重新运行会从头执行；恢复运行仅复用通过核验的前序文本结果。两者均建立新记录；操作结果不明时，请先核对实际产物。
        </p>
      )}
    </section>
  )
}

/** Long text stays available without adding an independently scrolling box by default. */
function FlowReadableText({ text, label }: { text: string; label: string }) {
  if (text.length <= 240) return <p className="whitespace-pre-wrap break-words text-sm">{text}</p>
  return (
    <div className="space-y-2 text-sm">
      <p className="whitespace-pre-wrap break-words">{text.slice(0, 240)}…</p>
      <details>
        <summary className="cursor-pointer font-medium">
          展开{label}（{text.length.toLocaleString()} 字）
        </summary>
        <div
          className="mt-2 max-h-[32rem] overflow-y-auto whitespace-pre-wrap break-words"
          tabIndex={0}
          aria-label={label}
        >
          {text}
        </div>
      </details>
    </div>
  )
}
