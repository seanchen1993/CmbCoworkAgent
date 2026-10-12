import { z } from "zod"
import { isAbsolute } from "node:path"
import {
  computerOwnedIdentity,
  computerDataEntry,
  computerBrowserManifest
} from "./computer-checkpoint-manifest"
import { botWorktreeRecord } from "./worktree-contract"
import { BOT_SCHEMA_VERSION } from "./schema"
const id = z.string().uuid()
const relativeDatabase = z
  .string()
  .regex(
    /^(?:bots\.sqlite|computer-recovery\/(?:points\/(?:\.pending-)?[a-f0-9-]{36}\/data|\.restore-[a-f0-9-]{36}\/next)\/bots\.sqlite)$/
  )
const common = {
  directory: z.string().min(1).max(4096).refine(isAbsolute),
  owner: computerOwnedIdentity
}
export const computerNativeRequest = z.discriminatedUnion("action", [
  z
    .object({
      ...common,
      action: z.literal("capture"),
      nonce: id,
      maxBytes: z
        .number()
        .int()
        .nonnegative()
        .max(20 * 1024 ** 3)
    })
    .strict(),
  z.object({ ...common, action: z.literal("read"), database: relativeDatabase }).strict(),
  z.object({ ...common, action: z.literal("bindings"), database: relativeDatabase }).strict(),
  z
    .object({
      ...common,
      action: z.literal("fence"),
      stage: id,
      nonce: id,
      empty: z.boolean().optional()
    })
    .strict()
])
export type ComputerNativeRequest = z.infer<typeof computerNativeRequest>
export const computerNativeDataResult = z
  .object({
    kind: z.literal("data"),
    schemaVersion: z.number().int().min(14).max(BOT_SCHEMA_VERSION),
    references: z.array(computerDataEntry).max(49_999)
  })
  .strict()
  .refine((value) => value.references.every((entry) => entry.path !== "bots.sqlite"))
export const computerNativeBindingsResult = z
  .object({
    kind: z.literal("bindings"),
    pages: computerBrowserManifest.shape.pages,
    records: z.array(botWorktreeRecord).max(2048)
  })
  .strict()
export const computerNativeResult = z.union([
  computerNativeDataResult,
  computerNativeBindingsResult
])
export type ComputerNativeResult = z.infer<typeof computerNativeResult>
