import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import { BotDomainError, type BotRoutine, type BotRunLease } from "../../shared/bot-types"
import type { BotStore } from "./store"
import { botReviewTaskSchema, type BotReviewTask } from "./review-task"
import { canonicalJson } from "./validation"

/** Supplied by the Host caller, never accepted from the routine's wire input. */
export type BotRoutineSaveAuthority =
  | { kind: "human" }
  | { kind: "task"; lease: BotRunLease; approvalEffectId?: string }
const saved = z
  .object({
    token: z.string(),
    definitionHash: z.string(),
    origin: z.enum(["human", "delegated"]),
    task: botReviewTaskSchema
  })
  .strict()
const occurrence = saved
  .extend({
    routineId: z.string(),
    botId: z.string(),
    trigger: z.enum(["manual", "scheduled", "event"]),
    eventData: z.string().optional()
  })
  .strict()
function definitionHash(routine: BotRoutine): string {
  // Scheduler cursor advancement and automatic completion of a one-shot schedule are not edits.
  return createHash("sha256")
    .update(
      canonicalJson({
        botId: routine.botId,
        name: routine.name,
        prompt: routine.prompt,
        schedule: routine.schedule,
        timezone: routine.timezone,
        skills: routine.skillReferences ?? []
      })
    )
    .digest("hex")
}

/** Pins the human standing assignment separately from scheduler/event messages.
 * Existing routines have no invented authorization after upgrade. */
export class BotRoutineAuthority {
  constructor(private readonly store: BotStore) {}

  private current(routine: BotRoutine) {
    const row = this.store.db.exec("SELECT record FROM bot_routine_authority WHERE routine_id=?", [
      routine.id
    ])[0]?.values[0]
    return row ? saved.parse(JSON.parse(String(row[0]))) : null
  }
  private human(routine: BotRoutine): BotReviewTask {
    return {
      source: "routine-definition",
      messages: [{ id: `routine:${routine.id}:${routine.revision}`, text: routine.prompt }],
      rejectedActions: []
    }
  }
  private confirmed(
    routine: BotRoutine,
    source: Extract<BotRoutineSaveAuthority, { kind: "task" }>
  ): boolean {
    if (!source.approvalEffectId) return false
    const row = this.store.db.exec(
      `SELECT i.id,i.prompt,e.action_hash FROM bot_effects e
      JOIN bot_effect_approvals a ON a.effect_id=e.id JOIN bot_interactions i ON i.id=a.approval_id
      WHERE e.id=? AND e.run_id=? AND i.run_id=e.run_id AND e.status='started'
      AND i.kind='approval' AND i.status='answered' AND i.answer='approve'`,
      [source.approvalEffectId, source.lease.runId]
    )[0]?.values[0]
    const invalid = () => new BotDomainError("approval_required", "例程定义与已批准内容不一致")
    if (!row) throw invalid()
    const action = JSON.parse(String(row[1]))
    if (createHash("sha256").update(canonicalJson(action)).digest("hex") !== row[2]) throw invalid()
    const after = action?.routine?.after
    if (
      !after ||
      typeof after !== "object" ||
      Array.isArray(after) ||
      (after.id === undefined
        ? routine.revision !== 1
        : after.id !== routine.id || after.revision !== routine.revision - 1)
    )
      throw invalid()
    const fields = ["botId", "name", "prompt", "schedule", "timezone", "enabled"] as const
    if (
      !fields.every(
        (key) => key in after && canonicalJson(after[key]) === canonicalJson(routine[key])
      )
    )
      throw invalid()
    if (after.desiredEnabled !== undefined && after.desiredEnabled !== routine.desiredEnabled)
      throw invalid()
    if (
      after.skills !== undefined &&
      canonicalJson(after.skills) !==
        canonicalJson(
          (routine.skillReferences ?? []).map(({ botId, id, version }) => ({ botId, id, version }))
        )
    )
      throw invalid()
    return this.store.getInteraction(String(row[0])).autoReview?.decision !== "allow"
  }
  save(
    routine: BotRoutine,
    source: BotRoutineSaveAuthority | null,
    requireActivation = false
  ): void {
    let task: BotReviewTask | null = null
    let origin: "human" | "delegated" = source?.kind === "human" ? "human" : "delegated"
    if (source?.kind === "human") task = this.human(routine)
    else if (source?.kind === "task") {
      const run = this.store.assertDispatch(source.lease)
      if (run.botId !== routine.botId) throw new Error("例程授权不属于当前 Bot")
      if (this.confirmed(routine, source)) {
        // A human explicitly accepted this exact recurring definition in the approval card.
        task = this.human(routine)
        origin = "human"
      } else {
        task = this.store.autoReview.task(run.id)
        // Automatic delegation cannot amplify scheduler/event authority.
        if (task?.routine || task?.peer) task = null
      }
    }
    if (requireActivation && origin !== "human")
      throw new BotDomainError("approval_required", "此例程需要你确认后启用")
    this.store.db.run("DELETE FROM bot_routine_authority WHERE routine_id=?", [routine.id])
    if (!task) return
    const record = saved.parse({
      token: randomUUID(),
      definitionHash: definitionHash(routine),
      origin,
      task
    })
    this.store.db.run("INSERT INTO bot_routine_authority VALUES(?,?)", [
      routine.id,
      JSON.stringify(record)
    ])
  }

  capture(
    routine: BotRoutine,
    runId: string,
    trigger: "manual" | "scheduled" | "event",
    eventData?: string
  ): void {
    const current = this.current(routine)
    if (trigger !== "manual" && (!current || current.definitionHash !== definitionHash(routine)))
      return
    const authority =
      trigger === "manual"
        ? {
            token: current?.token ?? `legacy:${routine.revision}`,
            definitionHash: definitionHash(routine),
            origin: "human" as const,
            task: this.human(routine)
          }
        : current!
    const record = occurrence.parse({
      ...authority,
      routineId: routine.id,
      botId: routine.botId,
      trigger,
      ...(eventData === undefined ? {} : { eventData })
    })
    this.store.db.run("INSERT INTO bot_routine_run_authority VALUES(?,?)", [
      runId,
      JSON.stringify(record)
    ])
  }

  task(runId: string): BotReviewTask | null {
    const row = this.store.db.exec("SELECT record FROM bot_routine_run_authority WHERE run_id=?", [
      runId
    ])[0]?.values[0]
    if (!row) return null
    const record = occurrence.parse(JSON.parse(String(row[0])))
    const run = this.store.getRun(runId)
    const source = { manual: "routine-manual", scheduled: "routine", event: "event" }[
      record.trigger
    ]
    if (run.botId !== record.botId || run.source !== `${source}:${record.routineId}`) return null
    let routine: BotRoutine
    try {
      routine = this.store.routine(run.botId, record.routineId)
    } catch {
      return null
    }
    const current = this.current(routine)
    if (
      record.definitionHash !== definitionHash(routine) ||
      record.token !== (current?.token ?? `legacy:${routine.revision}`)
    )
      return null
    return {
      ...record.task,
      source: run.source,
      routine: {
        id: routine.id,
        authorizationId: record.token,
        name: routine.name,
        prompt: routine.prompt,
        schedule: routine.schedule,
        timezone: routine.timezone,
        origin: record.origin,
        trigger: record.trigger,
        ...(record.eventData === undefined ? {} : { eventData: record.eventData })
      }
    }
  }
}
