import { randomUUID } from "node:crypto"
import { getDb } from "../db"
import { ManagedRunScheduleStore } from "../db/managed-run-schedules"
import { formatGmt8Timestamp } from "../../shared/gmt8-time"
import {
  parseManagedRunScheduleTime,
  type ManagedRunSchedule,
  type ManagedRunScheduleChange,
  type ManagedRunScheduleIdentity,
  type ManagedRunScheduleInput
} from "../../shared/managed-run-schedule"
import type { ManagedRunSummary } from "../../shared/harness-board-types"

interface SchedulerRuntime {
  start(schedule: ManagedRunSchedule): Promise<ManagedRunSummary>
  changed(event: ManagedRunScheduleChange): void
}

export class ManagedRunScheduler {
  private runtime?: SchedulerRuntime

  constructor(private readonly store: ManagedRunScheduleStore) {}

  private publish(projectId: string, featureId: string, schedule: ManagedRunSchedule | null): void {
    try {
      this.runtime?.changed({ projectId, featureId, schedule })
    } catch (error) {
      console.warn("[ManagedRunScheduler] Failed to publish schedule change:", error)
    }
  }

  private save(row: ManagedRunSchedule): void {
    this.store.update(row)
    this.publish(row.projectId, row.featureId, row)
  }

  private remove(row: ManagedRunSchedule): void {
    this.store.remove(row)
    this.publish(row.projectId, row.featureId, null)
  }

  get(projectId: string, featureId: string): ManagedRunSchedule | null {
    return this.store.get(projectId, featureId)
  }

  assertCanStart(projectId: string, featureId: string, scheduledStartId?: string): void {
    const schedule = this.get(projectId, featureId)
    if (scheduledStartId) {
      if (schedule?.scheduleId !== scheduledStartId || schedule.status !== "starting") {
        throw new Error("托管预约已发生变化，请刷新后重试")
      }
    } else if (schedule?.status === "pending" || schedule?.status === "starting") {
      throw new Error("当前特性已预约托管，请先退出预约托管模式")
    }
  }

  listActive(): ManagedRunSchedule[] {
    return this.store.listActive()
  }

  hasActiveProject(projectId: string): boolean {
    return this.store.hasActiveProject(projectId)
  }

  create(input: ManagedRunScheduleInput, now = new Date()): ManagedRunSchedule {
    this.assertFuture(input.scheduledAt, now)
    if (!input.workspacePath?.trim()) throw new Error("请选择本次托管使用的会话工作区")
    if (this.get(input.projectId, input.featureId)) {
      throw new Error("当前特性已有托管预约，请修改启动时间或退出托管模式")
    }
    const timestamp = formatGmt8Timestamp(now)
    const row: ManagedRunSchedule = {
      projectId: input.projectId,
      featureId: input.featureId,
      workspacePath: input.workspacePath,
      initialUserMessage: input.initialUserMessage,
      existingThreadId: input.existingThreadId,
      scheduledAt: input.scheduledAt,
      scheduleId: randomUUID(),
      status: "pending",
      createdAt: timestamp,
      updatedAt: timestamp
    }
    this.store.insert(row)
    this.publish(row.projectId, row.featureId, row)
    return { ...row }
  }

  private assertFuture(scheduledAt: string, now: Date): void {
    const time = parseManagedRunScheduleTime(scheduledAt)
    if (!Number.isFinite(time) || time <= now.getTime()) {
      throw new Error("请选择晚于当前时间的预约时间")
    }
  }

  private requireEditable(input: ManagedRunScheduleIdentity): ManagedRunSchedule {
    const row = this.get(input.projectId, input.featureId)
    if (!row || row.scheduleId !== input.scheduleId)
      throw new Error("托管预约已发生变化，请刷新后重试")
    if (row.status === "starting") throw new Error("托管正在启动，请稍后使用停止托管运行")
    return row
  }

  cancel(input: ManagedRunScheduleIdentity): void {
    const row = this.requireEditable(input)
    this.remove(row)
  }

  reschedule(input: ManagedRunScheduleIdentity & { scheduledAt: string }, now = new Date()): void {
    const row = this.requireEditable(input)
    this.assertFuture(input.scheduledAt, now)
    this.save({
      ...row,
      scheduledAt: input.scheduledAt,
      status: "pending",
      failureReason: undefined,
      updatedAt: formatGmt8Timestamp(now)
    })
  }

  initialize(runtime: SchedulerRuntime, now = new Date()): void {
    this.runtime = runtime
    const timestamp = formatGmt8Timestamp(now)
    for (const row of this.store.interrupted(timestamp)) {
      this.save({
        ...row,
        status: row.status === "starting" ? "failed" : "missed",
        failureReason:
          row.status === "starting"
            ? "应用重启导致预约启动中断，请检查托管运行记录"
            : "应用启动时已超过预约时间，请重新设置启动时间",
        updatedAt: timestamp
      })
    }
  }

  async tick(now = new Date()): Promise<void> {
    if (!this.runtime) return
    const timestamp = formatGmt8Timestamp(now)
    for (const row of this.store.due(timestamp)) {
      // Save before yielding so another tick or a restart cannot launch this reservation twice.
      const starting = { ...row, status: "starting" as const, updatedAt: timestamp }
      this.save(starting)
      void this.launch(starting).catch((error) =>
        console.warn("[ManagedRunScheduler] Failed to persist startup result:", error)
      )
    }
  }

  removeProject(projectId: string): void {
    this.store.removeProject(projectId)
  }

  private async launch(row: ManagedRunSchedule): Promise<void> {
    try {
      const run = await this.runtime!.start(row)
      if (run.status !== "running" && run.status !== "completed") {
        throw new Error(run.failureReason || "托管启动失败，请查看托管运行记录")
      }
      this.remove(row)
    } catch (error) {
      this.save({
        ...row,
        status: "failed",
        updatedAt: formatGmt8Timestamp(),
        failureReason: error instanceof Error ? error.message : String(error)
      })
    }
  }
}

export const managedRunScheduler = new ManagedRunScheduler(
  new ManagedRunScheduleStore(() => getDb())
)
