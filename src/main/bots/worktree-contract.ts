import { z } from "zod"
import {
  isWorkflowWorktreeTimeoutMinutes,
  isWorkflowWorktreeRemoveTimeoutMinutes
} from "../../shared/agent-runtime-limits"

const path = z.string().min(1).max(4096)
const id = z.string().min(1).max(512)
const hash = z.string().regex(/^[a-f0-9]{40,64}$/)
export const botWorktreeSource = z
  .object({
    gitRoot: path,
    sourceRoot: path,
    commonDir: path,
    workspacePath: path,
    sourceRelativePath: z.string().max(4096),
    baseCommit: hash,
    sourceBranch: id
  })
  .strict()
export const botWorktreeRecord = z
  .object({
    id,
    runId: id,
    threadId: id,
    branch: id,
    directory: path,
    workspaceDirectory: path,
    sourceRoot: path,
    sourceRelativePath: z.string().max(4096),
    sourceBranch: id,
    gitRoot: path,
    commonDir: path,
    baseCommit: hash,
    headCommit: hash.optional(),
    integrationParent: hash.optional(),
    integrationCommit: hash.optional(),
    dirty: z.boolean(),
    status: z.enum([
      "provisioning",
      "running",
      "ready",
      "recoverable",
      "integrating",
      "merged",
      "discarded"
    ]),
    cleanupPending: z.boolean().optional(),
    error: z.string().max(64000).optional(),
    updatedAt: z.string().max(100)
  })
  .strict()
export const botWorktreeBoundary = z
  .object({
    workspaceRoot: path,
    worktreeRoot: path,
    commonDir: path,
    branch: id
  })
  .strict()
export const botWorktreeTimeouts = z
  .object({
    createMinutes: z.number().refine(isWorkflowWorktreeTimeoutMinutes),
    removeMinutes: z.number().refine(isWorkflowWorktreeRemoveTimeoutMinutes)
  })
  .strict()
const common = { appDataRoot: path, workspacePath: path, timeouts: botWorktreeTimeouts.optional() }
export const botWorktreeOperation = z.discriminatedUnion("op", [
  z.object({ ...common, op: z.literal("prepare") }).strict(),
  z
    .object({
      ...common,
      op: z.enum(["acquire", "lookup"]),
      source: botWorktreeSource,
      runId: id,
      childId: id
    })
    .strict(),
  z
    .object({
      ...common,
      op: z.literal("settle"),
      record: botWorktreeRecord,
      succeeded: z.boolean()
    })
    .strict(),
  z
    .object({ ...common, op: z.enum(["diff", "status", "recover"]), record: botWorktreeRecord })
    .strict(),
  z
    .object({
      ...common,
      op: z.enum(["merge", "discard", "cleanup"]),
      record: botWorktreeRecord,
      expectedHeadCommit: hash
    })
    .strict()
])
export type BotWorktreeOperation = z.infer<typeof botWorktreeOperation>
export const botWorktreeAcquired = z
  .object({ record: botWorktreeRecord, boundary: botWorktreeBoundary })
  .strict()
export const botWorktreeDetail = z
  .object({
    record: botWorktreeRecord,
    summary: z.string().max(64000),
    patch: z.string().max(256_000).optional(),
    patchTruncated: z.boolean().optional()
  })
  .strict()
