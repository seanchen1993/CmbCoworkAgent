import type { ManagedRunStartInput } from "./harness-board-types"
import { formatGmt8Timestamp } from "./gmt8-time"

export interface ManagedRunScheduleInput extends ManagedRunStartInput {
  scheduledAt: string
}

export interface ManagedRunSchedule extends ManagedRunScheduleInput {
  scheduleId: string
  createdAt: string
  updatedAt: string
  status: "pending" | "starting" | "failed" | "missed"
  failureReason?: string
}

export interface ManagedRunScheduleIdentity {
  projectId: string
  featureId: string
  scheduleId: string
}

export interface ManagedRunScheduleChange {
  projectId: string
  featureId: string
  schedule: ManagedRunSchedule | null
}

export function parseManagedRunScheduleTime(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value)) return NaN
  const time = Date.parse(`${value.replace(" ", "T")}+08:00`)
  return Number.isFinite(time) && formatGmt8Timestamp(new Date(time)) === value ? time : NaN
}

export function nextManagedRunScheduleTime(now = new Date()): string {
  const current = formatGmt8Timestamp(now)
  const tonight = `${current.slice(0, 10)} 22:00:00`
  const time = parseManagedRunScheduleTime(tonight)
  return now.getTime() < time ? tonight : formatGmt8Timestamp(new Date(time + 24 * 60 * 60 * 1000))
}
