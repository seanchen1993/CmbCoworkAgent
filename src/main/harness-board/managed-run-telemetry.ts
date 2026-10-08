import { trackEvent } from "../services/event-reporter"
import type { ManagedRunSnapshot, ManagedRunStatus } from "../../shared/harness-board-types"

/**
 * 托管运行的开始 / 结束上报。
 *
 * 托管运行本来就有一套 20 种类型的事件流水（ManagedRunEventType），但它写在
 * `<工作区>/.cmbdevclaw/managed-runs/<runId>/events.ndjson`，只用于本地界面的运行
 * 时间线，从不上传。看板要的是「谁在用托管、跑了多少次、怎么结束的」，所以这里单独
 * 上报开始和结束两条，不动那套本地流水。
 *
 * 事件名和属性键名跟着既有约定走：`harnessProjectId` / `harnessFeatureSlug` 与系统
 * 约束读取、hook.executed、code_gen 一致，这样看板能直接复用同一套按项目聚合的脚手架。
 * （featureId 在 ManagedRunSnapshot 里存的就是 feature.slug，见 auto-mode-controller
 * 里 `featureId: feature.slug`。）
 *
 * 结束事件刻意只有一个，用 outcome 区分 completed / failed / cancelled。模型里这是三
 * 个独立的事件类型，但对看板来说「结束了几次」是一个问题，分成三个事件名会让此后每次
 * 算完成率都要先把三个名字加起来。
 */

const STARTED_EVENT = "harness.managed_run.started"
const ENDED_EVENT = "harness.managed_run.ended"

/** 结束原因码来自 managed-run-policy，长度有限，这里只做个兜底截断。 */
const REASON_CODE_MAX_LENGTH = 128

/**
 * 快照里的时间是 GMT+8 墙上时间（formatGmt8Timestamp 固定加 8 小时后取 UTC 字段，
 * 与本机时区无关），所以补上 +08:00 才是它真正代表的时刻。
 */
function parseGmt8Timestamp(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(`${value.replace(" ", "T")}+08:00`)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * 托管一次能跑很久，结束事件自带时长，免得开始事件丢了就再也算不出耗时。
 * trackEvent 是 fire-and-forget，丢一条是可能的。
 */
function resolveDurationMs(startedAt: string, endedAt: string): number | undefined {
  const start = parseGmt8Timestamp(startedAt)
  const end = parseGmt8Timestamp(endedAt)
  if (start === undefined || end === undefined) return undefined
  const durationMs = end - start
  return durationMs >= 0 ? durationMs : undefined
}

function identity(run: ManagedRunSnapshot): Record<string, unknown> {
  return {
    harnessProjectId: run.projectId,
    harnessFeatureSlug: run.featureId,
    managedRunId: run.runId
  }
}

export function reportManagedRunStarted(run: ManagedRunSnapshot): void {
  trackEvent(STARTED_EVENT, "harness", {
    ...identity(run),
    startedAt: run.startedAt
  })
}

/**
 * 结束上报。三条终止路径都要调用：auto-mode-controller 的 markTerminal 覆盖正常终止，
 * managed-run-recovery 覆盖应用重启后发现的中断运行（它不走 markTerminal，直接改
 * 快照）。漏掉后者的话，被重启打断的运行会只有开始没有结束，而那恰好是最该被看见的
 * 失败场景。
 */
export function reportManagedRunEnded(
  run: ManagedRunSnapshot,
  outcome: Exclude<ManagedRunStatus, "running">,
  reasonCode?: string
): void {
  const endedAt = run.completedAt ?? run.updatedAt
  const durationMs = resolveDurationMs(run.startedAt, endedAt)
  trackEvent(ENDED_EVENT, "harness", {
    ...identity(run),
    outcome,
    // 结束时停在哪个节点，用于看「托管都死在哪一步」。
    nodeId: run.decisionBaseline?.nodeId,
    startedAt: run.startedAt,
    endedAt,
    ...(durationMs !== undefined ? { durationMs } : {}),
    providerRetryCount: run.providerRetryCount,
    ...(reasonCode ? { reasonCode: reasonCode.slice(0, REASON_CODE_MAX_LENGTH) } : {})
  })
}

export { STARTED_EVENT as MANAGED_RUN_STARTED_EVENT, ENDED_EVENT as MANAGED_RUN_ENDED_EVENT }
