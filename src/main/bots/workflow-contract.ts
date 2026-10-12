import { z } from "zod"
import { WORKFLOW_RUN_ID_PATTERN } from "../agent/workflow/types"

export const WORKFLOW_WIRE_BYTES = 32 * 1024 * 1024
const text = z.string().max(64_000)
const count = z.number().int().nonnegative()
const json = z.unknown()
const phase = z.string().max(1000).nullable()
export const workflowStats = z
  .object({
    agentsTotal: count,
    agentsCached: count,
    agentsFailed: count,
    outputTokens: z.number().nonnegative(),
    durationMs: z.number().nonnegative()
  })
  .strict()
export const workflowJournal = z
  .object({
    index: count,
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    durableCallKey: z
      .string()
      .regex(/^[a-f0-9]{64}_n[0-9]{1,5}$/)
      .optional(),
    result: text.nullable(),
    structured: json.optional(),
    hasStructured: z.boolean().optional(),
    outputTokens: z.number().nonnegative().optional()
  })
  .strict()
export const workflowAgent = z
  .object({
    index: count,
    label: z.string().max(1000),
    phase,
    status: z.enum(["running", "completed", "error", "cached"]),
    error: text.optional(),
    outputTokens: z.number().nonnegative(),
    promptPreview: z.string().max(1000).optional(),
    resultPreview: z.string().max(1500).optional(),
    toolStreamKey: z.string().max(160).optional()
  })
  .strict()
const agentState = workflowAgent.extend({
  startedAt: z.string(),
  endedAt: z.string().optional()
})
export const workflowStatePatch = z
  .object({
    status: z.enum(["running", "completed", "error", "aborted"]),
    phases: z.array(z.string().max(1000)).max(1000),
    currentPhase: phase,
    agents: z.array(agentState).max(1000),
    logs: z.array(z.string().max(2200)).max(500),
    result: json.optional(),
    resultSidecarStatus: z.enum(["available", "unavailable", "none"]).optional(),
    error: text.optional(),
    warning: text.optional(),
    stats: workflowStats,
    completedAt: z.string().optional()
  })
  .strict()
export const workflowState = workflowStatePatch
  .extend({
    version: z.literal(1),
    runId: z.string().regex(WORKFLOW_RUN_ID_PATTERN),
    threadId: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/),
    workflowName: z.string().max(120),
    description: z.string().max(500).optional(),
    script: z.string().max(524_288),
    scriptSha256: z.string().regex(/^[a-f0-9]{64}$/),
    args: json.optional(),
    journal: z.array(workflowJournal).max(10_000),
    startedAt: z.string(),
    updatedAt: z.string(),
    resumed: z.boolean().optional()
  })
  .strict()
export const workflowAgentRequest = z
  .object({
    prompt: text,
    schema: z.record(z.string(), json).optional(),
    model: z.string().max(200).optional(),
    agentIndex: count,
    toolStreamKey: z.string().max(160),
    durableCallKey: z.string().regex(/^[a-f0-9]{64}_n[0-9]{1,5}$/),
    label: z.string().max(1000),
    phase,
    agentType: z.string().min(1).max(100).optional(),
    roleSystemPrompt: text.optional(),
    disallowedTools: z.array(z.string().max(100)).max(200).optional(),
    shellAccess: z.enum(["none", "read_only", "full"]).optional(),
    browserAccess: z.literal("page").optional(),
    desktopAccess: z.literal("shared-native").optional(),
    isolation: z.literal("worktree").optional()
  })
  .strict()
export const workflowAgentResult = z
  .object({
    text,
    structured: json,
    outputTokens: z.number().nonnegative(),
    modelFellBack: z.boolean().optional()
  })
  .strict()
export const workflowStart = z
  .object({
    state: workflowState,
    tokenBudget: z.number().int().positive().nullable().optional(),
    maxConcurrency: z.number().int().min(1).max(16),
    defaultModelId: z.string().max(200),
    agentProfiles: z
      .array(
        z
          .object({
            name: z.string().max(100),
            description: text,
            systemPrompt: text,
            model: z.string().max(200).optional(),
            source: z.enum(["built-in", "library", "user"]),
            disallowedTools: z.array(z.string().max(100)).max(200),
            shellAccess: z.enum(["none", "read_only", "full"]),
            browserAccess: z.literal("page").optional(),
            desktopAccess: z.literal("shared-native").optional()
          })
          .strict()
      )
      .max(200)
  })
  .strict()
export type WorkflowProcessInput = z.infer<typeof workflowStart>

const path = z.string().min(1).max(4096)
export const workflowOperation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("agent"), input: workflowAgentRequest }),
  z.object({ op: z.literal("read"), path }),
  z.object({ op: z.literal("exists"), path }),
  z.object({ op: z.literal("glob"), path }),
  z.object({ op: z.literal("workflow"), path }),
  z.object({
    op: z.literal("write"),
    path,
    content: z.string().max(1_048_576)
  }),
  z.object({ op: z.literal("flush") }),
  z.object({
    op: z.literal("result"),
    content: z
      .string()
      .max(8 * 1024 * 1024)
      .nullable()
  })
])
export const workflowResult = z
  .object({
    status: z.enum(["completed", "error", "aborted"]),
    result: json.optional(),
    error: text.optional(),
    warning: text.optional(),
    stats: workflowStats
  })
  .strict()
const runId = z.string().regex(WORKFLOW_RUN_ID_PATTERN)
export const workflowProgress = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("started"),
    runId,
    name: z.string().max(120),
    description: z.string().max(500),
    phases: z.array(z.string().max(1000)).max(1000),
    resumed: z.boolean()
  }),
  z.object({ kind: z.literal("phase"), runId, title: z.string().max(1000) }),
  z.object({ kind: z.literal("log"), runId, message: z.string().max(2200) }),
  z.object({
    kind: z.literal("agent_start"),
    runId,
    agentIndex: count,
    label: z.string().max(1000),
    phase,
    promptPreview: z.string().max(1000).optional()
  }),
  z.object({
    kind: z.literal("agent_end"),
    runId,
    agentIndex: count,
    label: z.string().max(1000),
    phase,
    status: z.enum(["completed", "error", "cached"]),
    outputTokens: z.number().nonnegative(),
    durationMs: z.number().nonnegative(),
    error: text.optional(),
    reason: z.enum(["timeout", "structured-output", "agent-error"]).optional(),
    resultPreview: z.string().max(1500).optional()
  }),
  z.object({
    kind: z.literal("finished"),
    runId,
    status: z.enum(["completed", "error", "aborted"]),
    error: text.optional(),
    warning: text.optional(),
    stats: workflowStats
  })
])
export const workflowWorkerMessage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready") }),
  z.object({ kind: z.literal("heartbeat") }),
  z.object({ kind: z.literal("call"), id: count, request: workflowOperation }),
  z.object({ kind: z.literal("cancel"), id: count }),
  z.object({ kind: z.literal("state"), value: workflowStatePatch }),
  z.object({ kind: z.literal("journal"), value: workflowJournal }),
  z.object({ kind: z.literal("agent"), value: workflowAgent }),
  z.object({ kind: z.literal("progress"), value: workflowProgress }),
  z.object({ kind: z.literal("done"), value: workflowResult }),
  z.object({ kind: z.literal("error"), error: text })
])
export const workflowHostMessage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("start"), value: workflowStart }),
  z.object({
    kind: z.literal("reply"),
    id: count,
    value: json.optional(),
    error: z.object({ name: z.string().max(100), message: text }).optional()
  }),
  z.object({ kind: z.literal("approval"), waiting: z.boolean() })
])

/** JSON strings bound allocation before parsing; no prototypes or native handles cross IPC. */
export function workflowEncode(value: unknown): string {
  const result = JSON.stringify(value)
  if (typeof result !== "string" || Buffer.byteLength(result, "utf8") > WORKFLOW_WIRE_BYTES)
    throw new Error("工作流通信内容超出限制")
  return result
}
export function workflowDecode<T>(value: unknown, schema: z.ZodType<T>): T {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > WORKFLOW_WIRE_BYTES)
    throw new Error("工作流通信内容无效或超出限制")
  return schema.parse(JSON.parse(value))
}
