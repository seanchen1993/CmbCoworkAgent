import type { CreatorProjectTrialJourney } from "../../../../shared/mods/creator-trial-journey"

const phases: Record<CreatorProjectTrialJourney["phase"], string> = {
  "not-started": "尚未开始",
  ready: "当前阶段已准备，待开始执行",
  running: "正在执行",
  "needs-approval": "等待人工确认",
  "needs-transition": "本阶段检查通过，等待进入下一阶段",
  passed: "整轮试用已通过",
  failed: "试用未通过",
  unknown: "结果待核对"
}

/** A conservative display projection. It never approves execution or plugin installation. */
export function creatorJourneyView(
  journey: CreatorProjectTrialJourney | undefined,
  scope: { threadId: string; digest?: string }
) {
  const current =
    !!journey &&
    journey.candidateCurrent !== false &&
    journey.creatorThreadId === scope.threadId &&
    !!scope.digest &&
    journey.candidateDigest === scope.digest
  const passed =
    current &&
    journey.phase === "passed" &&
    journey.canDeliver &&
    !journey.operationsTruncated &&
    journey.stages.length > 0 &&
    journey.stages.every(
      (stage) =>
        stage.status === "passed" && stage.checks.every((check) => check.result === "passed")
    )
  return {
    current,
    passed,
    label: !journey
      ? "尚无整轮验收记录"
      : !current
        ? "试用版本或原会话已变化，待重新核对"
        : journey.phase === "passed" && !passed
          ? "验收凭据不完整，待核对"
          : phases[journey.phase],
    nextStep: !current
      ? "刷新原试用记录，核对当前候选版本。"
      : passed
        ? "可保存为插件。"
        : journey.phase === "ready"
          ? "点击“开始执行”。"
          : journey.phase === "needs-transition"
            ? "检查已通过，可进入下一步。"
            : journey.phase === "needs-approval"
              ? "请处理下方待确认事项。"
              : journey.phase === "failed"
                ? "查看未通过的检查，回到聊天修改。"
                : journey.phase === "running"
                  ? "正在执行，请稍候。"
                  : journey.phase === "not-started"
                    ? "点击“开始执行”。"
                    : "请核对本轮结果。"
  }
}
