import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import type { FlowRecoveryPlan } from "../../../../shared/mods/flows/recovery"
import type { FlowRun } from "../../../../shared/mods/flows/types"

const labels = {
  reusable: "可尝试沿用结果",
  pending: "尚未执行",
  recheck: "需要重新检查",
  unknown: "结果不明",
  blocked: "需要重新执行",
  disabled: "未启用"
}

export function FlowRecoveryView({
  run,
  busy = false,
  onResumed
}: {
  run: FlowRun
  busy?: boolean
  onResumed?(run: FlowRun): void
}) {
  const sequence = useRef(0)
  const resumeSequence = useRef(0)
  const scopeKey = JSON.stringify([run.workspace, run.threadId, run.id])
  const currentScope = useRef(scopeKey)
  currentScope.current = scopeKey
  const source = useRef(run)
  source.current = run
  const pending = useRef(false)
  const [state, setState] = useState<{
    source: FlowRun
    loading?: boolean
    preparing?: boolean
    plan?: FlowRecoveryPlan
    error?: string
  } | null>(null)
  useEffect(
    () => () => {
      sequence.current++
    },
    [run]
  )
  useEffect(
    () => () => {
      resumeSequence.current++
    },
    [scopeKey]
  )
  const current =
    state?.source === run ||
    (state?.preparing &&
      JSON.stringify([state.source.workspace, state.source.threadId, state.source.id]) === scopeKey)
      ? state
      : null
  const inspect = async () => {
    if (pending.current || busy) return
    const request = ++sequence.current
    setState({ source: run, loading: true })
    try {
      const plan = await window.api.mods.flowRecovery(run.threadId, run.id)
      if (request !== sequence.current || source.current !== run) return
      if (plan.runId !== run.id) throw Error("运行记录已改变，请刷新后重试。")
      setState({ source: run, plan })
    } catch (error) {
      if (request === sequence.current && source.current === run)
        setState({ source: run, error: error instanceof Error ? error.message : String(error) })
    }
  }
  const resume = async () => {
    const plan = current?.plan
    if (
      pending.current ||
      busy ||
      !onResumed ||
      plan?.status !== "eligible" ||
      !/^[a-f0-9]{64}$/.test(plan.sourceDigest)
    )
      return
    pending.current = true
    sequence.current++
    const request = ++resumeSequence.current
    setState({ source: run, plan, preparing: true })
    try {
      const child = await window.api.mods.flowResume(run.threadId, run.id, plan.sourceDigest)
      if (request !== resumeSequence.current || currentScope.current !== scopeKey) return
      if (
        child.threadId !== run.threadId ||
        child.workspace !== run.workspace ||
        child.id === run.id
      )
        throw Error("恢复记录范围不匹配，请刷新运行历史。")
      // Clear the one-use diagnosis before switching to the newly reserved run.
      setState(null)
      onResumed(child)
    } catch {
      if (request === resumeSequence.current && currentScope.current === scopeKey)
        setState({
          source: source.current,
          error: "未能确认恢复成功。源记录仍保留；请刷新历史并重新核对，避免重复执行。"
        })
    } finally {
      pending.current = false
    }
  }
  return (
    <section aria-label="中断后怎么继续" className="space-y-3 rounded-lg border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-medium">中断后怎么继续</h4>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || current?.loading || current?.preparing}
          onClick={() => {
            void inspect()
          }}
        >
          {current?.loading ? "正在核对…" : "检查能否继续"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        先检查哪些步骤可以沿用。确认“恢复运行”后才会继续执行。
      </p>
      {current?.error && (
        <p role="alert" className="text-sm text-destructive">
          {current.error}
        </p>
      )}
      {current?.plan && (
        <div className="space-y-2 text-sm" role="status">
          <p>
            {current.plan.status === "eligible"
              ? "部分步骤可能无需重做。恢复时会再次检查结果和权限。"
              : current.plan.status === "complete"
                ? "流程已完成。"
                : current.plan.status === "active"
                  ? "流程仍在运行。"
                  : "当前记录不能直接续跑。"}
          </p>
          <ul className="list-disc space-y-1 pl-5 text-xs">
            {current.plan.reasons.map((reason, index) => (
              <li key={`${reason.code}:${index}`}>{reason.message}</li>
            ))}
          </ul>
          <ol className="space-y-2 text-xs" aria-label="恢复步骤核对">
            {current.plan.steps.map((step) => (
              <li key={step.stepId}>
                <span className="font-medium">
                  {step.name} · {labels[step.disposition]}
                </span>
                <p className="mt-1 text-muted-foreground">{step.reason}</p>
              </li>
            ))}
          </ol>
          <p className="text-xs text-muted-foreground">
            已执行 {current.plan.consumedExecutions} 次，最多还可执行{" "}
            {current.plan.remainingExecutions} 次。最终检查和人工确认需要重新完成。
          </p>
          {current.plan.status === "eligible" && onResumed && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                续跑会复用已核验的文本结果并建立新记录；其余步骤、最终检查和人工确认将重新执行。
              </p>
              <Button
                type="button"
                disabled={
                  busy || current.preparing || !/^[a-f0-9]{64}$/.test(current.plan.sourceDigest)
                }
                onClick={() => {
                  void resume()
                }}
              >
                {current.preparing ? "正在准备续跑…" : "恢复运行"}
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
