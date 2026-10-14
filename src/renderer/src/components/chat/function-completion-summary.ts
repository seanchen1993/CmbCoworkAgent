import type { CompletionEvidenceRecord } from "../../../../main/mods/v2/completion-evidence"
import { isModObject } from "../../../../shared/mods/v2/contracts"

export const statuses = {
  completed: "步骤已结束",
  running: "执行中",
  pass: "通过",
  revise: "需要修复并复检",
  block: "未通过",
  stale: "需要重新检查",
  cancelled: "已取消",
  error: "检查错误",
  interrupted: "执行中断"
}
const phases = {
  "capture.started": "开始采集文件证据",
  "capture.failed": "文件证据采集失败",
  "check.started": "开始检查",
  "check.result": "任务完成检查",
  "repair.attempt": "修复尝试",
  "validator.result": "检查结果",
  "state.transition.started": "开始确认项目阶段",
  "state.transition": "项目阶段推进"
}
export function detailText(record: CompletionEvidenceRecord, key: string): string {
  const value = isModObject(record.detail) ? record.detail[key] : undefined
  return typeof value === "string" ? value.slice(0, 2048) : ""
}
export function label(record: CompletionEvidenceRecord): string {
  if (record.phase === "check.result") return "任务完成检查"
  if (detailText(record, "source").startsWith("guest")) return "插件评审意见"
  const kind = detailText(record, "kind")
  return kind === "unit-test"
    ? "实际单元测试"
    : kind === "e2e"
      ? "实际端到端测试"
      : kind === "autobiz-validator" ||
          (record.phase === "validator.result" &&
            isModObject(record.detail) &&
            typeof record.detail.sourceCommit === "string")
        ? "Autobiz 原有阶段验证"
        : record.phase === "invalidated"
          ? "证据失效"
          : phases[record.phase]
}
export function nextAction(record: CompletionEvidenceRecord): string {
  if (record.phase === "state.transition.started")
    return record.status === "running"
      ? "等待原生权限审批及宿主提交结果；此步骤不代表推进成功。"
      : record.status === "completed"
        ? "推进步骤已结束，请查看对应提交结果；此步骤不代表推进成功。"
        : "推进确认中断，请先核对宿主提交日志与状态文件；不要直接重试推进。"
  if (record.phase === "capture.started")
    return record.status === "running"
      ? "正在读取当前文件、需求和配置；尚未形成检查结论。"
      : record.status === "completed"
        ? "采集步骤已结束，请查看后续检查结果；此步骤不代表检查通过。"
        : "采集中断，尚未取得完整文件证据；恢复任务后重新检查，不自动重放。"
  if (record.phase === "capture.failed")
    return "尚未取得文件和需求证据；检查路径、文件大小或读取权限，缩小范围后重新检查。"
  if (record.phase === "state.transition" && record.status === "interrupted")
    return isModObject(record.detail) && record.detail.applied === true
      ? "宿主已记录状态写入，但本次权限或生命周期复核未完成。请按操作编号复核日志与状态；不要直接重试推进。"
      : "提交结果未知。请先按操作编号复核宿主提交日志、state.json 与 STATE.md；不要直接重试推进。"
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
    return isModObject(record.detail) && record.detail.duplicate === true
      ? "checkpoint 此前已确认；本次复核未重复写入，继续下一阶段。"
      : "checkpoint 已由宿主确认；继续下一阶段。"
  return record.status === "running"
    ? "等待检查结果。"
    : "此记录仅对应所列检查和文件版本，不代表业务验收。"
}

export function completionEvidenceOverview(records: CompletionEvidenceRecord[]) {
  if (!records.length) return null
  const sorted = [...records].sort((a, b) => b.at - a.at)
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
  const currentRun = sorted.filter(
    (record) =>
      record.runId === latest.runId &&
      record.turnId === latest.turnId &&
      record.threadId === latest.threadId
  )
  const repairRequests = Math.max(
    0,
    ...currentRun
      .filter((record) => record.phase === "repair.attempt")
      .map((record) =>
        isModObject(record.detail) && typeof record.detail.revisionAttempts === "number"
          ? record.detail.revisionAttempts
          : 0
      )
  )
  const reportOnly =
    latest.phase === "check.result" &&
    currentStatus === "pass" &&
    detailText(latest, "source") === "guest-opinion-report"
  const outcome =
    currentStatus === "stale"
      ? "检查后文件或规则有变化，需要重新检查。"
      : latest.phase === "state.transition" && currentStatus === "pass"
        ? `阶段${isModObject(latest.detail) && latest.detail.duplicate === true ? "此前已推进，本次未重复写入" : "已推进"}：${detailText(latest, "from") || "起点"} → ${detailText(latest, "to") || "下一阶段"}`
        : reportOnly
          ? "仅报告模式已记录检查结果，不会阻止任务完成；报告中仍可能存在未通过项。"
          : latest.phase === "check.result" && currentStatus === "pass"
            ? "任务已获准完成；各项检查结果见明细，是否推进阶段请以阶段推进记录为准。"
            : currentStatus === "pass"
              ? "单项检查已返回结果，完整结论以本轮完成检查为准。"
              : nextAction(latest)
  return {
    sorted,
    currentStatus,
    repairRequests,
    reportOnly,
    outcome,
    notice: reportOnly
      ? "检查报告已记录，查看未通过项"
      : latest.phase === "state.transition"
        ? `项目阶段：${currentStatus === "pass" ? "已确认推进" : statuses[currentStatus]}`
        : currentStatus === "pass" && latest.phase !== "check.result"
          ? "单项检查已返回，完整结论待确认"
          : `完成检查：${statuses[currentStatus]}`
  }
}
