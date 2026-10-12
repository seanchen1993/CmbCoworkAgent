import { randomUUID } from "node:crypto"
import { tool, type StructuredToolInterface } from "@langchain/core/tools"
import { z } from "zod"
import { BotDomainError, type BotRoutine } from "../../shared/bot-types"
import type { BotSaveRoutineInput } from "../../shared/bot-routines"
import { botSkillSelections, type BotSkillReference } from "../../shared/bot-skill-references"
import type { BotRuntimeRequest } from "./host"
import type { ApproveLocalBotAction } from "./profile-tools"
import { validateBotSchedule } from "./schedules"
import { botEventPolicy, type BotEventPolicy } from "../../shared/bot-event-state"

const triggerFields = {
  at: z.number().int().optional().describe("Absolute one-shot time in Unix milliseconds"),
  after_seconds: z
    .number()
    .int()
    .min(1)
    .max(366 * 86_400)
    .optional()
    .describe(
      "One-shot delay from this tool call, calculated by the Host; use for work requested in N seconds/minutes"
    ),
  every_minutes: z.number().int().min(1).max(527040).optional(),
  cron: z.string().max(200).optional(),
  topic: z.string().max(160).optional(),
  event_policy: botEventPolicy
    .nullable()
    .optional()
    .describe(
      "Explicit latest-state event policy; null restores every-event mode. The caller must supply entityKey, sourceEpoch and monotonic safe-integer sequence."
    )
}
const specification = {
  name: z.string().min(1).max(100),
  prompt: z.string().min(1).max(64000),
  timezone: z.string().min(1).max(100)
}
interface TriggerInput {
  at?: number
  after_seconds?: number
  every_minutes?: number
  cron?: string
  topic?: string
  event_policy?: BotEventPolicy | null
}

function schedule(
  input: TriggerInput,
  now: number,
  previous?: BotRoutine["schedule"]
): BotRoutine["schedule"] {
  const { at, after_seconds, every_minutes, cron, topic } = input
  const count = [at, after_seconds, every_minutes, cron, topic].filter(
    (value) => value !== undefined
  ).length
  if (!count && previous) {
    if (input.event_policy !== undefined) {
      if (previous.kind !== "event")
        throw new BotDomainError("invalid_schedule", "只有事件例程可设置事件模式")
      return {
        kind: "event",
        topic: previous.topic,
        ...(input.event_policy ? { eventPolicy: input.event_policy } : {})
      }
    }
    return previous
  }
  if (count !== 1) throw new BotDomainError("invalid_schedule", "请选择一种触发方式")
  if (topic !== undefined) {
    const policy =
      input.event_policy === undefined && previous?.kind === "event"
        ? previous.eventPolicy
        : input.event_policy
    return { kind: "event", topic, ...(policy ? { eventPolicy: policy } : {}) }
  }
  if (input.event_policy !== undefined)
    throw new BotDomainError("invalid_schedule", "只有事件例程可设置事件模式")
  if (cron !== undefined) return { kind: "cron", expression: cron }
  if (after_seconds !== undefined) return { kind: "once", at: now + after_seconds * 1000 }
  if (at !== undefined) return { kind: "once", at }
  return {
    kind: "interval",
    anchor: now + every_minutes! * 60_000,
    everyMs: every_minutes! * 60_000
  }
}

export const BOT_ROUTINE_MUTATION_TOOLS = new Set([
  "create_routine",
  "update_routine",
  "delete_routine"
])

/** Cmb's durable receipt/version boundary over the existing Grok calendar implementation. */
export function botRoutineTools(
  request: BotRuntimeRequest,
  check: () => void,
  approve: (
    id: string,
    action: unknown,
    operation: () => Promise<string>,
    beforeStart?: () => Promise<void>
  ) => Promise<string>,
  approveLocal?: ApproveLocalBotAction
): StructuredToolInterface[] {
  const { store, bot, run, lease } = request
  const result = (saved: BotRoutine) => {
    const text = JSON.stringify(saved)
    return text.length <= 64_000
      ? text
      : JSON.stringify({ ...saved, prompt: saved.prompt.slice(0, 400), promptTruncated: true })
  }
  const change = async (
    id: string | undefined,
    input: unknown,
    prepare: () => {
      before: BotRoutine | null
      after: BotSaveRoutineInput
      /** Immutable display metadata from the same validated selection as after.skills. */
      skillReferences?: BotSkillReference[]
    }
  ) => {
    check()
    try {
      const callId = id ?? randomUUID()
      const completed = store.hasToolResult(lease, callId)
      // A recovered review belongs to its already frozen action. Read it before
      // deriving a new plan or deciding whether the current review policy applies.
      const frozenPlan =
        !completed && id && store.hasToolResult(lease, `${id}:routine-plan`)
          ? store.toolOnce<ReturnType<typeof prepare>>(lease, `${id}:routine-plan`, input, () => {
              throw new BotDomainError("not_found", "待审核的例程变更记录已不存在")
            })
          : null
      const proposed = completed ? null : (frozenPlan ?? prepare())
      const requiresActivation = !!proposed?.before?.activationRequired && proposed.after.enabled
      if (
        completed ||
        (!frozenPlan && !requiresActivation && !store.autoReview.read(bot.id).isEnabled)
      )
        return result(store.saveRoutineFromTool(lease, callId, input, proposed?.after ?? null))
      if (!id || !approveLocal)
        throw new BotDomainError("approval_required", "例程变更缺少可恢复的审核入口")
      // Freeze derived interval anchors and the exact previous revision before
      // waiting. Recovery reads the same plan, even if the model turn restarts.
      const planned = store.toolOnce(lease, `${id}:routine-plan`, input, () => {
        const value = proposed!
        value.after.schedule = validateBotSchedule(value.after.schedule, value.after.timezone)
        return value
      })
      return await approveLocal(
        `routine-save:${run.id}:${id}`,
        {
          routine: {
            operation: planned.before ? "update" : "create",
            ...planned
          }
        },
        () => {
          check()
          return result(
            store.saveRoutineFromTool(
              lease,
              callId,
              input,
              planned.after,
              `routine-save:${run.id}:${id}`
            )
          )
        }
      )
    } catch (error) {
      // A stale routine can be reread by the agent; it must never be overwritten blindly.
      if (
        error instanceof BotDomainError &&
        [
          "revision_conflict",
          "not_found",
          "invalid_schedule",
          "routine_limit",
          "skill_changed",
          "skill_unavailable",
          "skill_unverified",
          "skill_scope",
          "skill_catalog_unavailable"
        ].includes(error.code)
      )
        return JSON.stringify({
          error: error.code,
          message: error.message,
          ...(error.code === "invalid_schedule" ? { now: store.now() } : {})
        })
      throw error
    }
  }
  return [
    tool(
      ({ id, before_id, before_created_at, limit }) => {
        check()
        if (run.conversationId !== store.directConversation(bot.id).id || run.threadRootId)
          return JSON.stringify({
            error: "history_scope",
            message:
              "例程结果属于 Bot 主对话，请在主对话查询；不会将私聊运行记录带入群聊或其他讨论分支。"
          })
        if ((before_id === undefined) !== (before_created_at === undefined))
          return JSON.stringify({ error: "history_cursor", message: "分页时必须同时提供完整位置" })
        return JSON.stringify(
          store.routineHistory({
            botId: bot.id,
            routineId: id,
            before:
              before_id !== undefined
                ? { id: before_id, createdAt: before_created_at! }
                : undefined,
            limit
          })
        )
      },
      {
        name: "list_routine_runs",
        description:
          "Read this Bot's actual routine execution history in its main direct conversation only, newest first, including status, trigger reason, timestamps, result/error excerpt and original message IDs. Private history is unavailable in group conversations and discussion branches. Use next.id and next.createdAt together for the next page. Queued, waiting, cancelled and needs_review are not successful completion; saving or enabling a routine does not prove it ran. Deleted routines retain existing history. Read the referenced result message for full evidence.",
        schema: z.object({
          id: z.string().min(1).max(160),
          before_id: z.string().min(1).max(160).optional(),
          before_created_at: z.number().int().nonnegative().optional(),
          limit: z.number().int().min(1).max(25).default(20)
        })
      }
    ),
    tool(
      async ({ offset }) => {
        check()
        const routines = store.routines(bot.id)
        return JSON.stringify({
          items: routines.slice(offset, offset + 25).map(({ prompt, ...routine }) => ({
            ...routine,
            promptPreview: prompt.slice(0, 400),
            promptTruncated: prompt.length > 400
          })),
          nextOffset: offset + 25 < routines.length ? offset + 25 : null
        })
      },
      {
        name: "list_routines",
        description:
          "List this Bot's saved routines, including exact IDs, revisions, triggers, timezone, enabled state and next occurrence. Does not list other Bots' routines. Use read_routine for the complete instruction.",
        schema: z.object({ offset: z.number().int().min(0).default(0) })
      }
    ),
    tool(
      async ({ id, offset }) => {
        check()
        const routine = store.routine(bot.id, id)
        return JSON.stringify({
          ...routine,
          prompt: routine.prompt.slice(offset, offset + 16000),
          nextOffset: offset + 16000 < routine.prompt.length ? offset + 16000 : null
        })
      },
      {
        name: "read_routine",
        description:
          "Read one of this Bot's routines in bounded pages before updating it. Returned revision and timezone are authoritative; a chat description is not current saved state.",
        schema: z.object({ id: z.string().max(160), offset: z.number().int().min(0).default(0) })
      }
    ),
    tool(
      async (input, call) =>
        change(call.toolCall?.id, { tool: "create_routine", ...input }, () => {
          // Validate the same typed selection as the editor before requesting a
          // review. saveRoutine rechecks the version after any approval wait.
          const skillReferences =
            input.skills === undefined
              ? undefined
              : store.routineSkills.resolve(bot.id, input.skills, [])
          return {
            before: null,
            ...(skillReferences === undefined ? {} : { skillReferences }),
            after: {
              botId: bot.id,
              name: input.name,
              prompt: input.prompt,
              timezone: input.timezone,
              enabled: input.enabled ?? true,
              ...(input.skills === undefined ? {} : { skills: input.skills }),
              schedule: schedule(input, store.now())
            }
          }
        }),
      {
        name: "create_routine",
        description:
          "Create a user-requested routine. Choose exactly one: after_seconds (one-shot delay calculated by the Host from this call; preferred for 'in N minutes'), at (absolute Unix ms), every_minutes (recurring elapsed interval), cron (five-field recurring calendar expression), or topic (authenticated local event topic). A one-time request must use after_seconds or at; never create temporary routines to probe the clock. Always specify the user timezone; daily/weekly calendar work uses cron, not elapsed intervals. Set enabled=false when the user asks to save it paused; omitted enabled starts active. When the user requests a skill-based routine, provide its exact current verified catalog selection in skills; only this Bot's visible skills are allowed. Selecting skills grants no additional permissions. Event adapters must be configured separately. Return the saved specification; do not claim creation after an error. An invalid_schedule response includes the current Host Unix-ms clock in now.",
        schema: z.object({
          ...specification,
          ...triggerFields,
          enabled: z.boolean().optional(),
          skills: botSkillSelections.optional()
        })
      }
    ),
    tool(
      async (input, call) =>
        change(call.toolCall?.id, { tool: "update_routine", ...input }, () => {
          const previous = store.routine(bot.id, input.id)
          if (previous.revision !== input.revision)
            throw new BotDomainError("revision_conflict", "例程已修改，请重新读取后按用户要求调整")
          return {
            before: previous,
            after: {
              botId: bot.id,
              id: previous.id,
              revision: previous.revision,
              name: input.name ?? previous.name,
              prompt: input.prompt ?? previous.prompt,
              timezone: input.timezone ?? previous.timezone,
              enabled: input.enabled ?? previous.enabled,
              desiredEnabled: input.enabled ?? previous.desiredEnabled ?? previous.enabled,
              schedule: schedule(input, store.now(), previous.schedule)
            }
          }
        }),
      {
        name: "update_routine",
        description:
          "Modify, pause or resume an existing routine only as requested by the user. Read its exact ID and revision first. Omitted fields are preserved; provide at most one trigger to change its schedule. Use after_seconds for a new one-shot delay from this tool call, or at for an absolute Unix-ms time. Preserve its ID instead of creating a replacement. Bound skill versions are preserved and cannot be upgraded through this tool; the user must select and confirm them in the routine editor. A revision conflict requires rereading, not a blind retry. A saved routine is not evidence that it has already run.",
        schema: z.object({
          id: z.string().max(160),
          revision: z.number().int().min(1),
          name: specification.name.optional(),
          prompt: specification.prompt.optional(),
          timezone: specification.timezone.optional(),
          enabled: z.boolean().optional(),
          ...triggerFields
        })
      }
    ),
    tool(
      async ({ id, revision }, call) => {
        check()
        const callId = call.toolCall?.id ?? randomUUID()
        const effectId = `routine-delete:${run.id}:${callId}`
        const previous = store.effectResult(lease, effectId)
        if (previous?.status === "succeeded") return previous.result ?? "例程已删除"
        if (previous)
          throw new BotDomainError("effect_requires_review", "删除结果尚未确认，请核对后继续")
        const routine = store.routine(bot.id, id)
        if (routine.revision !== revision)
          return JSON.stringify({
            error: "revision_conflict",
            message: "例程已修改，请重新读取后确认"
          })
        return approve(
          effectId,
          {
            routineDelete: {
              id,
              revision,
              name: routine.name,
              prompt: routine.prompt,
              schedule: routine.schedule,
              timezone: routine.timezone
            },
            note: "删除将取消尚未开始的任务；运行中或待核对的任务保留。"
          },
          async () => {
            check()
            return JSON.stringify(
              store.deleteRoutine({ nonce: effectId, botId: bot.id, id, revision })
            )
          },
          async () => {
            check()
            if (store.routine(bot.id, id).revision !== revision)
              throw new BotDomainError("revision_conflict", "审批期间例程已修改，请重新确认")
          }
        )
      },
      {
        name: "delete_routine",
        description:
          "Delete a user-requested routine after confirmation of its exact current revision. Cancels queued occurrences; already running or uncertain work remains available for separate stop/review. Does not delete past messages or results. Read the receipt; never claim active tasks stopped because the routine was removed.",
        schema: z.object({ id: z.string().max(160), revision: z.number().int().min(1) })
      }
    )
  ]
}
