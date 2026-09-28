import { createHash } from "crypto"
import type {
  TraceCallStage,
  TraceStageUsage,
  TraceStageUsageSnapshot
} from "../../../shared/trace-stage-usage"
import type { TraceTokenUsage } from "./types"

const MAX_CALLS = 100_000
const MAX_STAGES = 64
const callKey = (key: string): string =>
  key.length > 256 ? createHash("sha256").update(key).digest("hex") : key
const validCount = (value: number): boolean => Number.isSafeInteger(value) && value >= 0

/** Counters survive node/content truncation. Call identity is scoped to this trace. */
export class TraceStageUsageCounter {
  private readonly buckets = new Map<string, TraceStageUsage>()
  private readonly modelStages = new Map<string, TraceCallStage>()
  private readonly tools = new Map<
    string,
    { stage: TraceCallStage; name?: string; started?: boolean }
  >()
  private overflow = false

  bindModel(messageId: string, stage: TraceCallStage): void {
    if (!messageId) return
    if (this.modelStages.size >= MAX_CALLS && !this.modelStages.has(callKey(messageId))) {
      this.overflow = true
      return
    }
    this.modelStages.set(callKey(messageId), { ...stage })
  }

  recordModel(
    messageId: string | undefined,
    usage?: TraceTokenUsage,
    explicitStage?: TraceCallStage
  ): void {
    const stage =
      explicitStage ?? (messageId ? this.modelStages.get(callKey(messageId)) : undefined) ?? {}
    if (messageId) this.modelStages.delete(callKey(messageId))
    const bucket = this.bucket(stage)
    if (!bucket) return
    bucket.modelCalls += 1
    const input = usage?.inputTokens ?? 0
    const output = usage?.outputTokens ?? 0
    const total = usage?.totalTokens ?? input + output
    if (![input, output, total].every(validCount)) {
      this.overflow = true
      return
    }
    bucket.inputTokens += input
    bucket.outputTokens += output
    bucket.totalTokens += total
    if (usage?.inputTokens !== undefined && usage?.outputTokens !== undefined)
      bucket.tokenUsageReportedCalls += 1
  }

  /** May arrive after the values snapshot first observed the tool intent. */
  bindTool(key: string, stage: TraceCallStage): void {
    key = callKey(key)
    const previous = this.tools.get(key)
    if (previous?.started) return
    if (previous?.name !== undefined) {
      this.addTool(previous.stage, previous.name, -1)
      this.addTool(stage, previous.name, 1)
    }
    if (!previous && this.tools.size >= MAX_CALLS) {
      this.overflow = true
      return
    }
    this.tools.set(key, { ...previous, stage: { ...stage }, started: true })
  }

  recordTool(key: string, name: string, stage?: TraceCallStage): void {
    key = callKey(key)
    const previous = this.tools.get(key)
    if (previous?.name !== undefined) return
    if (!previous && this.tools.size >= MAX_CALLS) {
      this.overflow = true
      return
    }
    const captured = stage ?? previous?.stage ?? {}
    this.tools.set(key, {
      name,
      stage: { ...captured },
      started: stage !== undefined || previous?.started
    })
    this.addTool(captured, name, 1)
  }

  snapshot(totals: {
    toolCalls: number
    modelCalls: number
    inputTokens: number
    outputTokens: number
    totalTokens: number
  }): TraceStageUsageSnapshot {
    const rows = [...this.buckets.values()].filter((row) => row.toolCalls > 0 || row.modelCalls > 0)
    const complete =
      !this.overflow &&
      Object.entries(totals).every(
        ([field, total]) =>
          validCount(total) &&
          rows.reduce((sum, row) => sum + row[field as keyof typeof totals], 0) === total
      ) &&
      rows.every((row) =>
        Object.entries(row).every(
          ([key, value]) =>
            key === "nodeName" || key === "nodeStatus" || validCount(value as number)
        )
      )
    return {
      stageUsageSchemaVersion: 1,
      stageUsageComplete: complete,
      stageUsage: rows.map((row) => ({ ...row }))
    }
  }

  private addTool(stage: TraceCallStage, name: string, delta: number): void {
    const bucket = this.bucket(stage)
    if (!bucket) return
    bucket.toolCalls += delta
    if (name === "request_user_input") bucket.userInputRequests += delta
  }

  private bucket(stage: TraceCallStage): TraceStageUsage | undefined {
    const nodeName = stage.nodeName?.trim().slice(0, 1024)
    const nodeStatus = nodeName ? stage.nodeStatus?.trim().slice(0, 256) : undefined
    const key = JSON.stringify([nodeName ?? "", nodeStatus ?? ""])
    let bucket = this.buckets.get(key)
    if (!bucket) {
      if (this.buckets.size >= MAX_STAGES) {
        this.overflow = true
        return undefined
      }
      bucket = {
        ...(nodeName ? { nodeName } : {}),
        ...(nodeStatus ? { nodeStatus } : {}),
        toolCalls: 0,
        modelCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        userInputRequests: 0,
        tokenUsageReportedCalls: 0
      }
      this.buckets.set(key, bucket)
    }
    return bucket
  }
}
