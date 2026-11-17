import { describe, expect, it } from "vitest"
import type { BotWorkSummary } from "../../../../shared/bots/work"
import { resolveBotWorkStatus } from "./work-status"

const work: BotWorkSummary = {
  id: "work",
  botId: "bot",
  threadId: "work-thread",
  parentThreadId: "bot-thread",
  title: "Codex 源码分析",
  state: "active",
  version: 1,
  createdAt: 1,
  updatedAt: 1,
  executionState: null,
  pendingPeers: 0,
  backgroundBusy: false
}

describe("resolveBotWorkStatus", () => {
  it.each([
    ["<think>Internal assessment</think>Files delivered.", "Files delivered."],
    ["<think>All verified: import.mjs fix present, 44 pass / 0 fail", ""],
    ["Files delivered.", "Files delivered."]
  ])("keeps inline reasoning out of result summaries: %s", (raw, visible) => {
    for (const kind of ["reported", "ready", "blocked"] as const) {
      const resultConclusion = { kind, summary: raw }
      const current = { ...work, executionState: "completed" as const, resultConclusion }
      expect(resolveBotWorkStatus(current).summary).toBe(visible)
      expect(resolveBotWorkStatus({ ...current, resultConclusion: { ...resultConclusion, unavailableDependency: true } }).summary)
        .toBe(visible)
      if (kind === "blocked") {
        expect(resolveBotWorkStatus({ ...current, executionState: "failed" }).summary).toBe(visible)
        expect(resolveBotWorkStatus({ ...current, backgroundBusy: true }).summary).toBe(visible)
      }
      expect(resultConclusion.summary).toBe(raw)
    }
  })

  it("shows a returned result without claiming verification or hiding execution failures", () => {
    const reported = { ...work, resultConclusion: { kind: "reported" as const, summary: "Original result" } }
    expect(resolveBotWorkStatus({ ...reported, executionState: "completed" }))
      .toMatchObject({ label: "结果已回传", tone: "idle" })
    expect(resolveBotWorkStatus({ ...reported, executionState: "failed" }).label).toBe("执行失败")
    expect(resolveBotWorkStatus({ ...reported, executionState: "interrupted" }).label).toBe("需要核对结果")
    expect(resolveBotWorkStatus({ ...reported, executionState: "completed", backgroundBusy: true }).label)
      .toBe("后台处理中")
  })
  const userControl = { settling: false, heldInputs: 1 }

  it("uses the Host's delivered-result service exemption without hiding current execution or control", () => {
    const resultConclusion = { kind: "ready" as const, summary: "Offline report ready", backgroundServicesOnly: true as const }
    const delivered = { ...work, executionState: "completed" as const, backgroundBusy: true, resultConclusion }
    expect(resolveBotWorkStatus(delivered)).toMatchObject({ label: "成果已就绪", summary: resultConclusion.summary })
    for (const update of [
      { executionState: "queued" }, { executionState: "running" }, { executionState: "waiting_user" },
      { pendingPeers: 1 }, { dispatchStopped: true }, { deletionPending: true },
      { resultReviewState: "checking" }, { userControl: { settling: false, heldInputs: 0 } }
    ] satisfies Partial<BotWorkSummary>[]) {
      expect(resolveBotWorkStatus({ ...delivered, ...update }).label).not.toBe("成果已就绪")
    }
    expect(resolveBotWorkStatus({ ...delivered, resultConclusion: { kind: "blocked", summary: "Check failed" } }).label)
      .toBe("后台处理中")
  })

  it.each([null, "completed"] as const)(
    "shows held inputs waiting for return of control with execution state %s",
    (executionState) => {
      expect(resolveBotWorkStatus({ ...work, executionState, userControl })).toEqual({
        label: "等待归还", tone: "idle", icon: "queued"
      })
    }
  )

  it.each([
    ["queued", "等待执行"],
    ["running", "正在处理"],
    ["waiting_user", "等待你处理"]
  ] as const)("keeps the %s execution visible while other inputs are held", (executionState, label) => {
    expect(resolveBotWorkStatus({ ...work, executionState, userControl }).label).toBe(label)
  })

  it.each(["ready", "blocked"] as const)("keeps execution and control states ahead of a %s conclusion", kind => {
    const conclusion = { kind, summary: "Current reviewed outcome" }
    const completed = { ...work, executionState: "completed" as const }
    expect(resolveBotWorkStatus({ ...completed, resultConclusion: conclusion })).toMatchObject({
      label: kind === "ready" ? "成果已就绪" : "成果待核对", summary: conclusion.summary
    })
    for (const state of [
      { executionState: "queued" }, { executionState: "running" }, { executionState: "waiting_user" },
      { executionState: "cancelled" }, { resultReviewState: "checking" },
      { resultReviewState: "waiting" }, { resultReviewState: "interrupted" },
      { pendingPeers: 1 }, { dispatchStopped: true },
      { userControl: { settling: false, heldInputs: 0 } }, { deletionPending: true },
      { state: "completed" }
    ] satisfies Partial<BotWorkSummary>[]) {
      const current = { ...completed, ...state }
      expect(resolveBotWorkStatus({ ...current, resultConclusion: conclusion }))
        .toEqual(resolveBotWorkStatus(current))
    }
    for (const state of [{ executionState: "failed" as const }, { backgroundBusy: true }]) {
      const current = { ...completed, ...state }
      expect(resolveBotWorkStatus({ ...current, resultConclusion: conclusion })).toEqual(
        current.executionState === "failed" && kind === "ready"
          ? { label: "成果已就绪", tone: "complete", icon: "ready", summary: conclusion.summary }
          : { ...resolveBotWorkStatus(current), ...(kind === "blocked" ? { summary: conclusion.summary } : {}) }
      )
    }
  })

  describe.each(["interrupted", "outcome_unknown"] as const)("saved results with physical status %s", executionState => {
    const saved = { ...work, executionState }
    const summary = "已核查保留的报告。"
    const readyConclusion = { kind: "ready" as const, summary }

    it("shows the physical warning when there is no current review status or conclusion", () => {
      expect(resolveBotWorkStatus(saved)).toEqual({
        label: "需要核对结果", tone: "error", icon: "alert"
      })
    })

    it.each([
      ["waiting", { label: "等待回传", tone: "idle", icon: "queued" }],
      ["checking", { label: "正在整理结果", tone: "active", icon: "running" }],
      // The review also has this phase when execution stopped before any review began.
      ["interrupted", { label: "需要核对结果", tone: "error", icon: "alert" }]
    ] as const)("shows the resumed review's %s state", (resultReviewState, expected) => {
      expect(resolveBotWorkStatus({ ...saved, resultReviewState })).toEqual(expected)
    })

    it.each([
      ["ready", { label: "成果已就绪", tone: "complete", icon: "ready" }],
      ["blocked", { label: "成果待核对", tone: "attention", icon: "alert" }]
    ] as const)("shows the acknowledged %s result and summary", (kind, expected) => {
      expect(resolveBotWorkStatus({ ...saved, resultConclusion: { kind, summary } }))
        .toEqual({ ...expected, summary })
    })

    it("shows an acknowledged request for a user decision", () => {
      expect(resolveBotWorkStatus({ ...saved, resultNeedsUser: "请确认报告口径。" })).toEqual({
        label: "成果需确认", tone: "attention", icon: "alert"
      })
    })

    it.each([
      { dispatchStopped: true },
      { userControl: { settling: false, heldInputs: 0 } },
      { userControl },
      { executionState: "queued" },
      { executionState: "running" },
      { executionState: "waiting_user" },
      { resultReviewState: "checking" }
    ] satisfies Partial<BotWorkSummary>[])("preserves the current status with %o", update => {
      const current = { ...saved, ...update }
      const status = resolveBotWorkStatus(current)
      expect(resolveBotWorkStatus({ ...current, resultConclusion: readyConclusion })).toEqual(status)
      expect(status.label).not.toBe("成果已就绪")
    })

    it.each([
      [{ pendingPeers: 1 }, "协作中"],
      [{ backgroundBusy: true }, "后台处理中"]
    ] as const)("keeps active work ahead of the acknowledged ready result with %o", (update, label) => {
      expect(resolveBotWorkStatus({ ...saved, ...update, resultConclusion: readyConclusion })).toEqual({
        label, tone: "active", icon: "idle"
      })
    })
  })

  it.each<{
    update: Partial<BotWorkSummary>
    expected: ReturnType<typeof resolveBotWorkStatus>
  }>([
    {
      update: { executionState: "queued", pendingPeers: 1, backgroundBusy: true },
      expected: { label: "等待执行", tone: "idle", icon: "queued" }
    },
    {
      update: { executionState: "running", dispatchStopped: true },
      expected: { label: "正在处理", tone: "active", icon: "running" }
    },
    {
      update: { executionState: "waiting_user", dispatchStopped: true },
      expected: { label: "等待你处理", tone: "attention", icon: "waiting" }
    },
    {
      update: { state: "completed", executionState: "failed" },
      expected: { label: "已完成", tone: "complete", icon: "complete" }
    },
    {
      update: { executionState: "completed" },
      expected: { label: "本轮已结束", tone: "idle", icon: "idle" }
    },
    {
      update: { executionState: "completed", resultNeedsUser: "请确认口径。" },
      expected: { label: "成果需确认", tone: "attention", icon: "alert" }
    },
    {
      update: { executionState: "completed", resultNeedsUser: "请确认口径。", backgroundBusy: true },
      expected: { label: "成果需确认", tone: "attention", icon: "alert" }
    },
    {
      update: { executionState: "completed", resultNeedsUser: "请确认口径。", userControl: { settling: false, heldInputs: 0 } },
      expected: { label: "成果需确认", tone: "attention", icon: "alert" }
    },
    {
      update: { executionState: "completed", backgroundBusy: true, readyServiceState: "result_ready",
        userControl: { settling: false, heldInputs: 0 },
        resultConclusion: { kind: "blocked", unavailableDependency: true, summary: "必需服务已停止。" } },
      expected: { label: "成果待核对", tone: "attention", icon: "alert", summary: "必需服务已停止。" }
    },
    {
      update: { executionState: "waiting_user", resultNeedsUser: "请确认口径。" },
      expected: { label: "等待你处理", tone: "attention", icon: "waiting" }
    },
    {
      update: { executionState: "running", resultNeedsUser: "请确认口径。" },
      expected: { label: "正在处理", tone: "active", icon: "running" }
    },
    {
      update: { executionState: "completed", dispatchStopped: true, resultNeedsUser: "请确认口径。" },
      expected: { label: "已停止", tone: "idle", icon: "stopped" }
    },
    {
      update: { state: "completed", resultNeedsUser: "请确认口径。" },
      expected: { label: "已完成", tone: "complete", icon: "complete" }
    },
    {
      update: { executionState: "completed", backgroundBusy: true },
      expected: { label: "后台处理中", tone: "active", icon: "idle" }
    },
    {
      update: { executionState: "completed", resultReviewState: "waiting" },
      expected: { label: "等待回传", tone: "idle", icon: "queued" }
    },
    {
      update: { executionState: "completed", resultReviewState: "checking" },
      expected: { label: "正在整理结果", tone: "active", icon: "running" }
    },
    {
      update: { executionState: "completed", resultReviewState: "interrupted" },
      expected: { label: "回传已中断", tone: "error", icon: "alert" }
    },
    {
      update: { executionState: "completed", readyServiceState: "result_ready", backgroundBusy: true },
      expected: { label: "成果已就绪", tone: "complete", icon: "ready" }
    },
    {
      update: { executionState: "failed", readyServiceState: "running", backgroundBusy: true },
      expected: { label: "执行失败", tone: "error", icon: "alert" }
    },
    {
      update: { executionState: "cancelled" },
      expected: { label: "已停止", tone: "idle", icon: "stopped" }
    },
    {
      update: { executionState: "cancelled", dispatchStopped: true, backgroundBusy: true },
      expected: { label: "正在停止", tone: "idle", icon: "stopped" }
    },
    {
      update: { executionState: "failed", dispatchStopped: true },
      expected: { label: "已停止", tone: "idle", icon: "stopped" }
    },
    {
      update: { executionState: "outcome_unknown" },
      expected: { label: "需要核对结果", tone: "error", icon: "alert" }
    },
    {
      update: { executionState: "outcome_unknown", dispatchStopped: true, backgroundBusy: true },
      expected: { label: "需要核对结果", tone: "error", icon: "alert" }
    },
    {
      update: { executionState: "interrupted", dispatchStopped: true },
      expected: { label: "需要核对结果", tone: "error", icon: "alert" }
    },
    {
      update: { state: "completed", deletionPending: true, dispatchStopped: true },
      expected: { label: "删除待完成", tone: "error", icon: "alert" }
    },
    {
      update: {},
      expected: { label: "空闲", tone: "idle", icon: "idle" }
    }
  ])("uses one label, tone and icon for $update", ({ update, expected }) => {
    expect(resolveBotWorkStatus({ ...work, ...update })).toEqual(expected)
  })
})
