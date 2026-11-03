import type { HarnessRunDetailViewModel } from "../../../../shared/harness-board-types"

export interface NativeFeatureGuidance {
  stage: string
  message: string
  action: "start" | "review" | "input"
  threadId?: string
}

/** Use the frozen runtime once started; never substitute a newer installed plugin's text. */
export function nativeFeatureChatGuide(detail: HarnessRunDetailViewModel | null) {
  const guidance = nativeFeatureGuidance(detail)
  if (!guidance || !detail) return null
  const project = detail.nativeProject?.project
  const stages =
    project?.manifest.stages ??
    detail.workflow.nodes.map((node) => ({
      id: node.id,
      title: node.label,
      userGuide: node.userGuide
    }))
  const stage = project
    ? stages[project.stageIndex]
    : stages.find((item) => item.id === detail.run.currentNodeId)
  return {
    ...guidance,
    plugin: project?.packageId ?? detail.nativeBinding?.expectedPlugin?.name ?? "已绑定项目插件",
    version: project?.packageVersion ?? detail.nativeBinding?.expectedPlugin?.version ?? "",
    route: stages.map((item) => item.title).join(" → "),
    userGuide:
      project?.status === "completed"
        ? null
        : (stage?.userGuide ??
          "请说明希望达成的目标、已有资料和验收要求。可先在这里讨论，再到特性详情核对项目设置、填写完整需求并启动。普通讨论不会自动推进阶段。")
  }
}

export function nativeFeatureSessionLabel(
  detail: HarnessRunDetailViewModel | null,
  threadId: string
): string {
  const view = detail?.nativeProject
  const operation = view?.operations.find((item) => item.execution?.threadId === threadId)
  if (!operation) return "普通讨论会话（不自动推进阶段）"
  const stage = view?.project.manifest.stages.find((item) => item.id === operation.stageId)
  return `插件阶段执行会话 · ${stage?.title ?? operation.stageId}`
}

/** Guidance only. Execution and admission remain in the original feature controls. */
export function nativeFeatureGuidance(
  detail: HarnessRunDetailViewModel | null
): NativeFeatureGuidance | null {
  if (!detail?.nativeBinding || detail.project.lifecycle?.status === "archived") return null
  const view = detail.nativeProject
  const stage = view?.project.manifest.stages[view.project.stageIndex]
  const label =
    stage?.title ??
    detail.workflow.nodes.find((node) => node.id === detail.run.currentNodeId)?.label ??
    "当前阶段"
  const guide = (
    message: string,
    action: NativeFeatureGuidance["action"]
  ): NativeFeatureGuidance => ({ stage: label, message, action })
  if (view?.project.status === "completed") {
    return guide("所有阶段已完成，可在特性详情查看成果。", "review")
  }
  if (view?.inputWait) {
    return {
      ...guide(
        view.inputWait.resumable
          ? "答复已收到，请返回特性详情继续执行。"
          : "助手需要补充信息，请在待答复的会话中回复。",
        view.inputWait.resumable ? "review" : "input"
      ),
      threadId: view.inputWait.threadId
    }
  }
  // Host history is newest first, including retries within the same stage/version.
  const operation = view?.operations.find(
    (item) =>
      item.stageId === stage?.id &&
      item.expectedVersion === view.project.version &&
      item.status !== "transitioned"
  )
  switch (operation?.status) {
    case "started":
      return guide("当前阶段正在执行，可在特性详情查看执行记录。", "review")
    case "prepared":
      return guide("当前步骤已准备，请在特性详情核对执行确认。", "review")
    case "succeeded":
      return guide(
        operation.resultApproval?.decision === "rejected"
          ? "成果需要修改，请在特性详情补充意见并重新执行。"
          : (view?.resultApprovalRequired ?? stage?.resultApproval === "human") &&
              !operation.resultApproval
            ? "当前步骤检查通过，请在特性详情查看产物并确认成果。"
            : "当前步骤已执行，请在特性详情查看结果并继续。",
        "review"
      )
    case "unknown":
      return guide("上次执行结果待核对，请在特性详情核对后再继续。", "review")
    case "cancel_requested":
      return guide("正在停止执行，请等待停止完成。", "review")
    case "failed":
    case "cancelled":
      return guide("当前步骤已停止或未完成，请在特性详情查看记录后重新执行。", "review")
  }
  if (view && !stage) return guide("请在特性详情核对阶段状态后继续。", "review")
  return guide(
    view
      ? "当前阶段尚未执行。核对项目设置后，点击“托管运行当前特性”继续。"
      : "先完成项目设置，再填写完整需求并启动。助手会按插件的阶段提示词执行。普通聊天不会自动启动阶段。",
    "start"
  )
}
