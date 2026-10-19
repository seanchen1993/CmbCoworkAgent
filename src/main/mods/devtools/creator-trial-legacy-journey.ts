import type { CreatorProjectTrialJourney } from "../../../shared/mods/creator-trial-journey"
import type { DevelopmentBusinessTrialSession } from "../../../shared/mods/development"
import type { ProjectRuntimeManifest } from "../../../shared/project-runtime"
import type { StageCheckContract } from "../../../shared/project-runtime/stage-check-receipt"
import type { StoredStageCheck } from "../../harness-board/project-runtime/composition-stage-check-store"

/** Legacy journal membership and actual synchronous Hook/checkpoint receipts, never model prose. */
export function projectCreatorLegacyTrialJourney(input: {
  projectId: string
  creatorThreadId: string
  candidateDigest: string
  candidateCurrent: boolean
  packageDigest: string
  workspace: string
  featureId: string
  runId?: string
  phase: string
  currentStageId?: string
  manifest: ProjectRuntimeManifest
  contracts?: StageCheckContract[]
  receipts: StoredStageCheck[]
  sessions: DevelopmentBusinessTrialSession[]
  sessionsTruncated?: boolean
  sessionsUnavailable?: boolean
  diagnostic?: string
}): CreatorProjectTrialJourney {
  const completeHistory = !input.sessionsTruncated && !input.sessionsUnavailable
  const stages = input.manifest.stages.map((stage) => {
    const members = input.sessions.filter((session) => session.nodeId === stage.id)
    const latest = members.at(-1)
    const contracts = input.contracts?.filter((contract) => contract.nodeId === stage.id) ?? []
    const receipts = input.receipts.filter(
      (value) =>
        value.runId === input.projectId &&
        value.unitId === input.featureId &&
        value.engineRunId === input.runId &&
        value.packageDigest === input.packageDigest &&
        members.some(
          (session) =>
            session.threadId === value.threadId &&
            JSON.stringify(session.incarnation) === value.incarnationKey
        )
    )
    const checks = contracts.map((contract) => {
      const receipt = receipts.findLast(
        (value) =>
          value.receipt.checkId === contract.checkId &&
          value.receipt.nodeId === contract.nodeId &&
          value.receipt.contractDigest === contract.contractDigest &&
          value.threadId === latest?.threadId
      )
      return {
        id: contract.checkId,
        artifactId: contract.artifacts.map((value) => value.id).join(","),
        result: receipt ? ("passed" as const) : ("unknown" as const),
        ...(receipt
          ? { validatorVersion: `devclaw.stage-check/v1:${contract.contractDigest.slice(0, 12)}` }
          : {})
      }
    })
    const checked = contracts.length > 0 && checks.every((check) => check.result === "passed")
    const status: CreatorProjectTrialJourney["stages"][number]["status"] =
      latest && !latest.endedAt
        ? "running"
        : latest?.outcome && latest.outcome !== "success" && latest.outcome !== "completed"
          ? "failed"
          : checked && completeHistory
            ? "passed"
            : members.length || input.phase === "completed"
              ? "unknown"
              : "pending"
    return {
      id: stage.id,
      title: stage.title,
      status,
      artifacts: [
        ...new Map(
          contracts
            .flatMap((contract) => contract.artifacts)
            .map((artifact) => [
              artifact.path,
              { id: artifact.id, path: artifact.path, required: null }
            ])
        ).values()
      ],
      checks,
      sessions: members.map(
        (session): CreatorProjectTrialJourney["stages"][number]["sessions"][number] => ({
          threadId: session.threadId,
          operationId: `${input.runId}:${session.threadId}`,
          status: session.endedAt ? "settled" : "running",
          ...(session.outcome === "success" ||
          session.outcome === "error" ||
          session.outcome === "cancelled" ||
          session.outcome === "unknown"
            ? { terminalOutcome: session.outcome }
            : {})
        })
      )
    }
  })
  const passed =
    input.phase === "completed" &&
    completeHistory &&
    stages.length > 0 &&
    stages.every((stage) => stage.status === "passed") &&
    !input.diagnostic
  const phase: CreatorProjectTrialJourney["phase"] = passed
    ? "passed"
    : input.phase === "failed" || input.phase === "cancelled"
      ? "failed"
      : stages.some((stage) => stage.status === "running")
        ? "running"
        : input.phase === "ready"
          ? "ready"
          : input.phase === "needs-confirmation"
            ? "not-started"
            : "unknown"
  return {
    projectId: input.projectId,
    creatorThreadId: input.creatorThreadId,
    candidateDigest: input.candidateDigest,
    workspace: input.workspace,
    phase,
    candidateCurrent: input.candidateCurrent,
    canDeliver: passed && input.candidateCurrent,
    operationsTruncated: !completeHistory,
    stages,
    diagnostics: [
      "阶段会话沿用原业务执行器，原制作会话统一显示归属；原 Hooks 和人工确认继续生效。",
      "只有原运行整轮完成、物理执行已确认且每阶段真实校验回执齐全时，才认定本轮检查通过。",
      "回执证明当时读取的产物；不替代业务效果评审，也不恢复原批准或自动重跑。",
      ...(!input.candidateCurrent
        ? ["此为历史试用结果；原来源已失效或当前候选已改变，不能作为当前插件的验收依据。"]
        : []),
      ...(!input.contracts
        ? ["此插件未接入受审阶段收据契约，不能把流程完成当作业务验收通过。"]
        : []),
      ...(!completeHistory ? ["阶段会话记录不完整，不能确认本轮全部校验。"] : []),
      ...(input.diagnostic ? [`阶段收据未核对：${input.diagnostic}`] : [])
    ]
  }
}
