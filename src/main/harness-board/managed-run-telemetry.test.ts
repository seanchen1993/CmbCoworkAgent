import { mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { dirname, join, resolve } from "path"
import { fileURLToPath } from "url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ManagedRunSnapshot } from "../../shared/harness-board-types"

/**
 * 托管运行的开始 / 结束上报。
 *
 * 这两条事件是看板「托管运行」标签和「托管运行次数」的数据来源，所以关心的不是流水好
 * 不好看，而是两件事：结束事件不能漏，以及丢了开始事件时还能算出耗时。
 *
 * 最容易漏的是崩溃恢复：应用重启后 recoverManagedRunsAtStartup 会把上次没结束的运行
 * 标记成失败，但它不走 markTerminal，是直接改快照的。只在 markTerminal 里埋点的话，
 * 被重启打断的托管运行在看板上就只有开始没有结束，而那恰好是最该被看见的失败场景。
 */

const reported: Array<{ name: string; category: string; properties: Record<string, unknown> }> = []

vi.mock("../services/event-reporter", () => ({
  trackEvent: (name: string, category: string, properties: Record<string, unknown>) => {
    reported.push({ name, category, properties })
  }
}))

const { reportManagedRunEnded, reportManagedRunStarted } = await import("./managed-run-telemetry")
const { ManagedRunStore } = await import("./managed-run-store")
const { recoverManagedRunsAtStartup } = await import("./managed-run-recovery")

const temporaryDirectories: string[] = []

beforeEach(() => {
  reported.length = 0
})

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function makeStore(): InstanceType<typeof ManagedRunStore> {
  const directory = mkdtempSync(join(tmpdir(), "managed-run-telemetry-"))
  temporaryDirectories.push(directory)
  return new ManagedRunStore({ rootDir: directory })
}

function makeSnapshot(overrides: Partial<ManagedRunSnapshot> = {}): ManagedRunSnapshot {
  return {
    version: 2.5,
    runId: "mr_1",
    projectId: "project-1",
    featureId: "feature-slug",
    status: "running",
    providerRetryCount: 0,
    startedAt: "2026-09-20 09:00:00",
    updatedAt: "2026-09-20 09:05:30",
    ...overrides
  } as ManagedRunSnapshot
}

describe("托管运行上报", () => {
  it("开始事件带上能和其他事件对齐的项目/特性标识", () => {
    // 键名必须是 harnessProjectId / harnessFeatureSlug：系统约束读取、hook.executed、
    // code_gen 用的都是这两个，看板才能复用同一套按项目聚合的脚手架。
    reportManagedRunStarted(makeSnapshot())

    expect(reported).toHaveLength(1)
    expect(reported[0].name).toBe("harness.managed_run.started")
    expect(reported[0].category).toBe("harness")
    expect(reported[0].properties).toMatchObject({
      harnessProjectId: "project-1",
      harnessFeatureSlug: "feature-slug",
      managedRunId: "mr_1"
    })
  })

  it("三种结束共用一个事件名，靠 outcome 区分", () => {
    // 模型里 completed / failed / cancelled 是三个事件类型，但看板问的是「结束了几次」，
    // 拆成三个事件名会让此后每次算完成率都要先把三个名字加起来。
    reportManagedRunEnded(makeSnapshot({ status: "completed" }), "completed")
    reportManagedRunEnded(makeSnapshot({ status: "failed" }), "failed", "provider_error")
    reportManagedRunEnded(makeSnapshot({ status: "cancelled" }), "cancelled", "user_stop_requested")

    expect(reported.map((entry) => entry.name)).toEqual([
      "harness.managed_run.ended",
      "harness.managed_run.ended",
      "harness.managed_run.ended"
    ])
    expect(reported.map((entry) => entry.properties.outcome)).toEqual([
      "completed",
      "failed",
      "cancelled"
    ])
    expect(reported[1].properties.reasonCode).toBe("provider_error")
  })

  it("结束事件自带时长，按 GMT+8 解析快照时间", () => {
    // 开始事件是 fire-and-forget，丢了就再也算不出耗时，所以时长写在结束事件上。
    // 快照时间是 GMT+8 墙上时间，与本机时区无关，解析时必须补 +08:00。
    reportManagedRunEnded(
      makeSnapshot({ startedAt: "2026-09-20 09:00:00", updatedAt: "2026-09-20 09:05:30" }),
      "failed"
    )

    expect(reported[0].properties.durationMs).toBe(330_000)
  })

  it("completed 用 completedAt 而不是 updatedAt 算结束时刻", () => {
    reportManagedRunEnded(
      makeSnapshot({
        startedAt: "2026-09-20 09:00:00",
        completedAt: "2026-09-20 09:02:00",
        updatedAt: "2026-09-20 09:09:00"
      }),
      "completed"
    )

    expect(reported[0].properties.endedAt).toBe("2026-09-20 09:02:00")
    expect(reported[0].properties.durationMs).toBe(120_000)
  })

  it("时间解析不出来时不发 durationMs，而不是发个 NaN 或 0", () => {
    reportManagedRunEnded(makeSnapshot({ startedAt: "坏掉的时间" }), "failed")

    expect(reported[0].properties).not.toHaveProperty("durationMs")
    expect(reported[0].properties.startedAt).toBe("坏掉的时间")
  })
})

describe("崩溃恢复路径", () => {
  it("应用重启后收尾的托管运行也会上报结束", () => {
    // 这条路径不经过 markTerminal，漏了它，被重启打断的运行就只有开始没有结束。
    const store = makeStore()
    const created = store.createRun("project-9", "feature-9")
    reported.length = 0

    const result = recoverManagedRunsAtStartup(store)

    expect(result.failedRunIds).toEqual([created.runId])
    expect(reported).toHaveLength(1)
    expect(reported[0].name).toBe("harness.managed_run.ended")
    expect(reported[0].properties).toMatchObject({
      harnessProjectId: "project-9",
      harnessFeatureSlug: "feature-9",
      managedRunId: created.runId,
      outcome: "failed",
      reasonCode: "app_interrupted"
    })
  })

  it("已经结束的运行不会被重复上报", () => {
    const store = makeStore()
    const created = store.createRun("project-9", "feature-9")
    store.updateSnapshot({ ...created, status: "completed" })
    reported.length = 0

    recoverManagedRunsAtStartup(store)

    expect(reported).toHaveLength(0)
  })
})

describe("markTerminal 的接线", () => {
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "./auto-mode-controller.ts"),
    "utf8"
  )

  it("上报在 decisionEventId 判断之外", () => {
    // markTerminal 里写本地流水的 appendEvent 被 `if (decisionEventId)` 挡着，没有决策
    // 来源的终止路径不写流水。上报要是也放进这个 if，那些终止就会静默丢失。
    const body = source.slice(source.indexOf("async function markTerminal("))
    const reportAt = body.indexOf("reportManagedRunEnded(")
    const guardAt = body.indexOf("if (decisionEventId)")

    expect(reportAt, "markTerminal 里没有上报").toBeGreaterThan(-1)
    expect(guardAt, "找不到 decisionEventId 判断").toBeGreaterThan(-1)
    expect(reportAt, "上报被 decisionEventId 判断包住了").toBeLessThan(guardAt)
  })

  it("开始上报跟在 createRun 之后", () => {
    // 工作区缺失、已有活跃运行这些校验在 createRun 之前 throw，所以放在它之后才只统计
    // 真正开起来的运行。
    const body = source.slice(source.indexOf("export async function startManagedRun("))
    expect(body.indexOf("managedRunStore.createRun(")).toBeLessThan(
      body.indexOf("reportManagedRunStarted(")
    )
  })
})
