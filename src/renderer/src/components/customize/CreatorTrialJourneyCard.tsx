import type { CreatorProjectTrialJourney } from "../../../../shared/mods/creator-trial-journey"
import { creatorJourneyView } from "./creator-journey-view"

const stageLabels: Record<CreatorProjectTrialJourney["stages"][number]["status"], string> = {
  pending: "待执行",
  ready: "待开始执行",
  running: "执行中",
  "needs-approval": "待人工确认",
  "checks-passed": "检查通过，待确认推进",
  passed: "已通过",
  failed: "未通过",
  unknown: "待核对"
}
const checkLabels = { passed: "通过", failed: "未通过", blocked: "检查受阻", unknown: "待核对" }

export function CreatorTrialJourneyCard({
  journey,
  threadId,
  digest
}: {
  journey?: CreatorProjectTrialJourney
  threadId: string
  digest?: string
}) {
  const view = creatorJourneyView(journey, { threadId, digest })
  return (
    <section
      aria-label="整轮项目试用验收"
      className="space-y-3 rounded-xl border bg-background p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-semibold">试用结果</h4>
        <span
          role="status"
          className={`rounded-md px-2 py-1 text-xs ${
            view.passed
              ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
              : "bg-muted text-muted-foreground"
          }`}
        >
          {view.label}
        </span>
      </div>
      {!view.passed && <p className="text-sm">{view.nextStep}</p>}
      {journey && view.current && (
        <>
          <details>
            <summary className="cursor-pointer text-sm text-muted-foreground">
              已通过 {journey.stages.filter((stage) => stage.status === "passed").length} /{" "}
              {journey.stages.length} 步 · 查看结果
            </summary>
            <ol className="space-y-2" aria-label="本轮阶段验收">
              {journey.stages.map((stage, index) => (
                <li key={stage.id}>
                  <details className="rounded-lg border p-3" open={stage.status === "failed"}>
                    <summary className="cursor-pointer text-sm font-medium">
                      {index + 1}. {stage.title} · {stageLabels[stage.status]}
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        {stage.checks.length} 项检查 · {stage.sessions.length} 次执行
                      </span>
                    </summary>
                    <div className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
                      <div className="space-y-1">
                        <p className="font-medium">产物要求</p>
                        {stage.artifacts.length ? (
                          stage.artifacts.map((artifact) => (
                            <p key={artifact.id} className="break-all">
                              {artifact.path} ·{" "}
                              {artifact.required === null
                                ? "由原校验决定"
                                : artifact.required
                                  ? "必需"
                                  : "可选"}
                            </p>
                          ))
                        ) : (
                          <p className="text-muted-foreground">本阶段未声明产物要求。</p>
                        )}
                      </div>
                      <div className="space-y-1">
                        <p className="font-medium">原运行器校验</p>
                        {stage.checks.length ? (
                          stage.checks.map((check) => (
                            <p key={check.id} className="break-words">
                              {check.id} · {checkLabels[check.result]}
                              {check.validatorVersion && (
                                <span className="text-muted-foreground">
                                  {" "}
                                  · {check.validatorVersion}
                                </span>
                              )}
                            </p>
                          ))
                        ) : (
                          <p className="text-muted-foreground">
                            本阶段未声明检查；请结合原阶段推进记录核对。
                          </p>
                        )}
                      </div>
                    </div>
                    {!!stage.sessions.length && (
                      <details className="mt-3 text-xs text-muted-foreground">
                        <summary className="cursor-pointer">
                          查看所属执行会话（{stage.sessions.length}）
                        </summary>
                        <ul className="mt-2 space-y-1">
                          {stage.sessions.map((session) => (
                            <li key={session.operationId} className="break-all">
                              {session.threadId} · {session.status}
                              {session.terminalOutcome ? ` · ${session.terminalOutcome}` : ""}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </details>
                </li>
              ))}
            </ol>
          </details>
          {journey.stages.some((stage) => stage.status === "failed") && (
            <p role="alert" className="text-sm text-destructive">
              未通过：
              {journey.stages
                .filter((stage) => stage.status === "failed")
                .map((stage) => stage.title)
                .join("、")}
              。可在聊天中描述需要修改的地方。
            </p>
          )}
          {!!journey.diagnostics.length && (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">
                验收说明与诊断（{journey.diagnostics.length}）
              </summary>
              <ul className="mt-2 list-inside list-disc space-y-1">
                {journey.diagnostics.map((message, index) => (
                  <li key={index}>{message}</li>
                ))}
              </ul>
            </details>
          )}
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">原会话、试用与版本关联</summary>
            <p className="mt-2 break-all">原会话：{journey.creatorThreadId}</p>
            <p className="break-all">本轮项目：{journey.projectId}</p>
            <p className="break-all">候选摘要：{journey.candidateDigest}</p>
          </details>
        </>
      )}
    </section>
  )
}
