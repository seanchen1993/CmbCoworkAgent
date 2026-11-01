import type { DevelopmentStatus } from "../../../../shared/mods/development"
import { creatorJourneyView } from "./creator-journey-view"
import { isHostBusinessCreatorReview } from "./creator-project-route"

/** Read-only navigation projection. It cannot authorize, execute or certify a candidate. */
export function creatorNextStep(status: DevelopmentStatus) {
  const trial = !status.business?.review || isHostBusinessCreatorReview(status.projectTrial, status.business.review)
    ? status.projectTrial : undefined
  const delivery = status.projectDelivery
  const step = (title: string, detail: string, target: "create" | "trial" | "delivery",
    actionLabel = target === "create" ? "返回对话继续制作" : target === "delivery" ? "前往保存与使用" : "查看本轮试用与待办") =>
    ({ title, detail, target, actionLabel })
  if (delivery && ["unknown", "installing", "exporting"].includes(delivery.phase))
    return step("保存结果待核对", "先核对原操作结果，不要重复保存或安装。", "delivery")
  const sourceSet = status.sourceSet
  if (sourceSet && sourceSet.phase !== "cancelled") {
    if (sourceSet.dependencies.some(dep => ["unknown", "installing"].includes(dep.phase)))
      return step("依赖安装结果待核对", "到源码准备区域核对原安装结果，确认前不要重复安装。", "delivery", "核对依赖安装结果")
    if (sourceSet.phase !== "ready")
      return step(sourceSet.phase === "needs-review" ? "源码准备需要重新核对" : "源码依赖待准备",
        "到源码准备区域逐项安装、配置并确认所需组件，再核对权限生成候选。", "delivery", "处理源码准备待办")
  }
  const journey = trial ? creatorJourneyView(trial.journey, {
    threadId: status.threadId, digest: trial.digest
  }) : undefined
  if (trial?.journey && !journey?.current)
    return step(delivery?.pluginId ? "历史版本已保存" : "草稿已变化，需准备新候选",
      "原试用和保存记录仍保留。回原创作对话准备最新草稿，再试用和保存；旧记录不代表当前版本。", "create")
  if (trial && delivery?.requestId === trial.id && delivery.sourceDigest === trial.digest &&
      delivery.pluginId)
    return step("当前版本已保存", "点击“开始使用”进入插件对应的聊天或项目入口；保存不代表已经运行。", "delivery")
  if (trial) {
    if (journey!.passed) return step("当前版本试用通过", "可以保存插件，之后在正式聊天或项目中使用。", "delivery")
    if (trial.journey) return step(journey!.label, journey!.nextStep, "trial")
    return step("项目候选已准备", "先填写下方的实际试用目标。", "trial")
  }
  const business = status.business
  if (business?.trialDiagnostic) return step("试用记录待核对", "读取原记录后再继续，不能将未知结果当作成功。", "trial")
  if (business?.review?.phase === "installed")
    return step("插件已保存", "从保存页的“开始使用”进入对应入口。", "delivery")
  if (business?.trial) {
    const journey = creatorJourneyView(business.trial.journey, {
      threadId: status.threadId, digest: business.trial.digest
    })
    if (journey.passed) return step("当前版本试用通过", "可以保存插件。", "delivery")
    return step("查看本轮试用", "按实际进度补齐配置、确认权限或检查结果；结束不代表通过。", "trial")
  }
  if (status.configuration) return step("试用需要配置", "补齐下方要求的配置后继续。", "trial")
  if (status.trials.some(row => row.phase === "unknown" || (row.diagnostics?.unknownRequests ?? 0) > 0))
    return step("试用结果待核对", "先核对原运行记录，不要重复执行。", "trial")
  if (status.trials.some(row => row.phase === "needs-approval"))
    return step("确认后即可在聊天试用", "核对下方用途和权限，确认仅对当前版本、当前聊天生效。", "trial")
  const reuse = status.reuse
  if (reuse?.phase === "active" && status.drafts.some(draft => draft.id === reuse.draftId &&
      draft.revision === reuse.revision && draft.digest === reuse.sourceDigest))
    return step("当前版本已保存并用于聊天", "回到原聊天描述实际任务，核对效果；保存和启用本身不等于任务完成。", "delivery")
  if (status.trials.some(row => row.phase === "failed"))
    return step("试用未完成", "查看具体问题，回原对话修改后重新准备候选。", "trial")
  if (status.trials.some(row => row.phase === "active"))
    return step("已在当前聊天启用试用", "回聊天实际验证效果；启用不代表已通过验收，满意后再保存。", "trial")
  if (status.trials.length || business?.review)
    return step("候选待试用", "查看下方准备状态；需要你确认时会显示明确操作。", "trial")
  return step("尚未准备可试用版本", "在原创作对话说明目标或修改要求；助手准备候选后，试用入口会出现在这里。", "create")
}
