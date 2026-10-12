import { createHash } from "node:crypto"
import { z } from "zod"
import type { BotRunLease } from "../../shared/bot-types"
import type { BotStore } from "./store"
import { botReviewTaskSchema, type BotReviewTask } from "./review-task"
import { canonicalJson } from "./validation"

const recordSchema = z
  .object({
    parentRunId: z.string(),
    sourceBotId: z.string(),
    recipientBotId: z.string(),
    sourceRevision: z.number().int().positive(),
    recipientRevision: z.number().int().positive(),
    policyRevision: z.number().int().nonnegative(),
    dataEpoch: z.string(),
    sourceTaskHash: z.string(),
    task: botReviewTaskSchema
  })
  .strict()
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex")

/** A handoff shares a bounded assignment, not a new human permission grant.
 * Private source instructions enter only the source owner's independent reviewer. */
export class BotPeerAuthority {
  private readonly reading = new Set<string>()
  private readonly resolved = new Map<string, BotReviewTask | null>()
  constructor(private readonly store: BotStore) {}

  capture(lease: BotRunLease, childRunId: string, assignment: string): void {
    const parent = this.store.assertDispatch(lease)
    const child = this.store.getRun(childRunId)
    if (
      child.source !== "peer" ||
      child.parentRunId !== parent.id ||
      child.rootRunId !== parent.rootRunId
    )
      throw new Error("协作授权与任务归属不一致")
    const policy = this.store.autoReview.read(parent.botId)
    if (!policy.isEnabled) return
    const task = this.store.autoReview.task(parent.id)
    if (!task || this.store.steering.hasPending(parent.id)) return
    const source = this.store.getBot(parent.botId),
      recipient = this.store.getBot(child.botId)
    const record = recordSchema.parse({
      parentRunId: parent.id,
      sourceBotId: parent.botId,
      recipientBotId: child.botId,
      sourceRevision: source.revision,
      recipientRevision: recipient.revision,
      policyRevision: policy.revision,
      dataEpoch: policy.dataEpoch,
      sourceTaskHash: digest(task),
      task: {
        ...task,
        source: "peer",
        peer: {
          reviewerBotId: task.peer?.reviewerBotId ?? parent.botId,
          handoffs: [
            ...(task.peer?.handoffs ?? []),
            {
              fromBotId: parent.botId,
              toBotId: child.botId,
              assignment,
              ...(task.delegation ? { sourceDelegation: task.delegation } : {}),
              recipient: {
                name: recipient.name,
                instructions: recipient.instructions,
                workspacePath: recipient.workspacePath,
                modelRef: recipient.modelRef,
                connectorIds: recipient.connectorIds ?? []
              },
              reviewPolicy: {
                isEnabled: policy.isEnabled,
                allowInstructions: policy.allowInstructions,
                blockInstructions: policy.blockInstructions
              }
            }
          ]
        }
      }
    })
    this.store.db.run("INSERT INTO bot_peer_authority VALUES(?,?)", [
      childRunId,
      JSON.stringify(record)
    ])
  }

  task(runId: string): BotReviewTask | null {
    // Cache only during this synchronous traversal, never across dispatch checks.
    // Repeated ancestor reads would otherwise grow exponentially with handoff depth.
    const outermost = this.reading.size === 0
    if (outermost) this.resolved.clear()
    if (this.reading.has(runId) || this.reading.size >= 8) return null
    if (this.resolved.has(runId)) return this.resolved.get(runId)!
    this.reading.add(runId)
    try {
      const task = this.readTask(runId)
      this.resolved.set(runId, task)
      return task
    } finally {
      this.reading.delete(runId)
      if (outermost) this.resolved.clear()
    }
  }

  private readTask(runId: string): BotReviewTask | null {
    const row = this.store.db.exec("SELECT record FROM bot_peer_authority WHERE run_id=?", [
      runId
    ])[0]?.values[0]
    if (!row) return null
    const record = recordSchema.parse(JSON.parse(String(row[0])))
    const child = this.store.getRun(runId),
      parent = this.store.getRun(record.parentRunId)
    if (
      child.source !== "peer" ||
      child.parentRunId !== parent.id ||
      child.rootRunId !== parent.rootRunId ||
      child.botId !== record.recipientBotId ||
      parent.botId !== record.sourceBotId ||
      !["running", "waiting_input", "succeeded"].includes(parent.status) ||
      this.store.steering.hasPending(parent.id)
    )
      return null
    const source = this.store.getBot(parent.botId, true),
      recipient = this.store.getBot(child.botId, true)
    if (source.deletedAt !== null || recipient.deletedAt !== null) return null
    const policy = this.store.autoReview.read(parent.botId)
    if (
      source.revision !== record.sourceRevision ||
      recipient.revision !== record.recipientRevision ||
      !policy.isEnabled ||
      policy.revision !== record.policyRevision ||
      policy.dataEpoch !== record.dataEpoch
    )
      return null
    const current = this.store.autoReview.task(parent.id)
    if (!current || digest(current) !== record.sourceTaskHash) return null
    return record.task
  }
}
