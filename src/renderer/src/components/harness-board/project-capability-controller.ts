import type { AppNotification } from "../../../../shared/app-notifications"
import type { HarnessRunDetailViewModel } from "../../../../shared/harness-board-types"
import { projectHarnessNotification } from "../../../../shared/harness-notifications"
import { getHarnessRunNextAction } from "@/lib/harness-run-next-action"

export interface ProjectCapabilityActivity {
  known: boolean
  runningThreadId?: string
  managedRunning?: boolean
  gatePending?: boolean
  gateThreadId?: string
}

export function projectCapabilityState(detail: HarnessRunDetailViewModel, selectedId?: string) {
  const current = detail.run.nodes.find((node) => node.id === detail.run.currentNodeId)
  const selected = detail.run.nodes.find((node) => node.id === selectedId) ?? current
  const manifest =
    detail.projectCapability?.status === "ready" ? detail.projectCapability.manifest : undefined
  return {
    current,
    selected,
    guidance: manifest?.stages.find((stage) => stage.nodeId === selected?.id),
    issues:
      selected?.artifacts.filter(
        (artifact) =>
          artifact.artifactStatus !== "generated" || artifact.validation?.status === "invalid"
      ) ?? [],
    hooks: [...(selected?.hooks ?? [])].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 3),
    nextAction: getHarnessRunNextAction(detail)
  }
}

export function projectCapabilityUnavailable(detail: HarnessRunDetailViewModel): string | null {
  if (detail.projectCapability?.status !== "ready") return "项目能力说明不可用，请刷新详情。"
  const current = detail.run.nodes.find((node) => node.id === detail.run.currentNodeId)
  if (!current || current.nodeStatus === "unknown") return "无法确认当前阶段，请刷新详情。"
  if (["done", "skipped", "archived"].includes(detail.run.featureStatus ?? "")) {
    return "此特性已完成或归档，无需准备新的阶段会话。"
  }
  if (detail.run.managedRun?.status === "corrupt" || detail.run.managedRun?.corrupt) {
    return "无法确认托管运行状态，请先查看原运行记录。"
  }
  const action = getHarnessRunNextAction(detail)
  if (!action?.slashSkill && !action?.userMessage) return "当前阶段没有可准备的下一步指令。"
  if (!detail.run.resolvedSessionWorkspacePath) return "当前特性尚无可用会话工作目录。"
  return null
}

interface ProjectCapabilityControllerDependencies {
  isCurrent: (scope: symbol) => boolean
  canAct?: () => boolean
  load: (detail: HarnessRunDetailViewModel) => Promise<{
    detail: HarnessRunDetailViewModel
    notifications: AppNotification[]
  }>
  activity: (detail: HarnessRunDetailViewModel) => ProjectCapabilityActivity
  create: (detail: HarnessRunDetailViewModel) => Promise<string>
  open: (threadId: string) => void
  showApproval: (threadId?: string) => void
  message: (message: string) => void
  busy: (value: boolean) => void
}

/** Only prepares the existing skill conversation. It never executes or approves a stage. */
export function createProjectCapabilityController(deps: ProjectCapabilityControllerDependencies) {
  let inFlight = false
  return async (initial: HarnessRunDetailViewModel, scope: symbol): Promise<void> => {
    if (inFlight || !deps.isCurrent(scope) || deps.canAct?.() === false) return
    inFlight = true
    deps.busy(true)
    try {
      const snapshot = await deps.load(initial)
      if (!deps.isCurrent(scope) || deps.canAct?.() === false) return
      const detail = snapshot.detail
      if (
        detail.project.projectId !== initial.project.projectId ||
        detail.run.slug !== initial.run.slug
      ) {
        throw new Error("详情已切换，请重新打开当前特性。")
      }
      // Read synchronous activity after the await: ordinary streams and notification events
      // may have changed while the detail/notification IPC calls were in flight.
      const activity = deps.activity(detail)
      if (!activity.known) throw new Error("无法确认运行状态，请刷新后重试。")
      const gate = snapshot.notifications
        .map(projectHarnessNotification)
        .find(
          (item) =>
            item?.type === "human_gate" &&
            item.status === "pending" &&
            item.projectId === detail.project.projectId &&
            item.featureId === detail.run.slug
        )
      if (gate || activity.gatePending) {
        deps.message("需要人工确认，请在原审批入口处理。")
        deps.showApproval(gate?.sourceThreadId || activity.gateThreadId)
        return
      }
      if (
        detail.run.managedRun?.status === "running" ||
        activity.managedRunning ||
        activity.runningThreadId
      ) {
        const threadId = activity.runningThreadId || detail.run.managedRun?.currentSession?.threadId
        deps.message("已有运行中的会话，继续查看原会话。")
        if (threadId) deps.open(threadId)
        else deps.message("托管运行正在准备会话，请查看原运行记录并稍后刷新。")
        return
      }
      const unavailable = projectCapabilityUnavailable(detail)
      if (unavailable) throw new Error(unavailable)
      const threadId = await deps.create(detail)
      if (deps.isCurrent(scope) && deps.canAct?.() !== false) deps.open(threadId)
    } catch (error) {
      if (deps.isCurrent(scope)) {
        deps.message(error instanceof Error ? error.message : "读取阶段状态失败，请刷新后重试。")
      }
    } finally {
      inFlight = false
      if (deps.isCurrent(scope)) deps.busy(false)
    }
  }
}
