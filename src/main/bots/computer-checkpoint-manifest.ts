import { z } from "zod"
import { botDirectoryEntries } from "./directory-checkpoint"
import { botSharedWorkspaceReference } from "./shared-workspace"
import { BOT_SCHEMA_VERSION } from "./schema"
import {
  botComputerCheckpointId as id,
  botComputerCheckpointHash as hash,
  botComputerCheckpointSelection,
  botComputerCheckpointRestoreResult,
  botComputerCheckpointSummary
} from "../../shared/bot-computer-checkpoint"

export const COMPUTER_FILES = 50_000
export const COMPUTER_BYTES = 20 * 1024 ** 3
export const COMPUTER_BROWSER_BYTES = 2 * 1024 ** 3
export const computerIdentity = z
  .object({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) })
  .strict()
export const computerOwnedIdentity = z
  .object({ root: computerIdentity, lock: computerIdentity })
  .strict()
export type ComputerOwnedIdentity = z.infer<typeof computerOwnedIdentity>
const count = z.number().int().nonnegative().max(COMPUTER_FILES)
const size = z.number().int().nonnegative().max(COMPUTER_BYTES)
const sealed = z
  .object({ state: z.literal("established"), sha256: hash, entries: count, bytes: size })
  .strict()
const absent = z.object({ state: z.literal("absent") }).strict()
export const computerComponent = z.discriminatedUnion("state", [absent, sealed])
export type ComputerComponent = z.infer<typeof computerComponent>
const components = z
  .object({
    data: computerComponent,
    shared: computerComponent,
    browser: computerComponent,
    managed: computerComponent
  })
  .strict()
export const computerManifest = z
  .object({
    format: z.literal(1),
    id,
    originId: id,
    createdAt: z.number().int().nonnegative(),
    platform: z.enum(["darwin", "win32", "linux"]),
    components,
    files: count,
    bytes: size,
    managedGit: botComputerCheckpointSummary.shape.managedGit,
    includes: z.literal("committed-data-referenced-evidence-shared-browser-managed-deliverables"),
    excludes: z.literal(
      "external-projects-provider-vault-credentials-processes-unreferenced-data-host-caches-external-git-metadata"
    )
  })
  .strict()
  .superRefine((value, ctx) => {
    const active = Object.values(value.components).filter(
      (component) => component.state === "established"
    )
    if (
      active.reduce((sum, component) => sum + component.entries, 0) !== value.files ||
      active.reduce((sum, component) => sum + component.bytes, 0) !== value.bytes
    )
      ctx.addIssue({ code: "custom", message: "Computer manifest totals do not match components" })
    if (
      value.components.browser.state === "established" &&
      value.components.browser.bytes > COMPUTER_BROWSER_BYTES
    )
      ctx.addIssue({ code: "custom", message: "Browser checkpoint exceeds its byte limit" })
    if (
      value.managedGit.complete > 0 !== (value.components.managed.state === "established") ||
      value.managedGit.filesOnly !== 0
    )
      ctx.addIssue({
        code: "custom",
        message: "Managed Git completeness does not match its sealed component"
      })
  })
export type ComputerManifest = z.infer<typeof computerManifest>
export const computerDataEntry = z
  .object({
    path: z
      .string()
      .regex(
        /^(bots\.sqlite|objects\/[a-f0-9]{64}|teach\/[a-f0-9-]{36}\/(?:[0-9]+\.jpg|video\.webm))$/
      ),
    size,
    sha256: hash
  })
  .strict()
export const computerDataManifest = z
  .object({
    format: z.literal(1),
    schemaVersion: z.number().int().min(14).max(BOT_SCHEMA_VERSION),
    entries: z.array(computerDataEntry).min(1).max(COMPUTER_FILES)
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.entries[0].path !== "bots.sqlite" ||
      new Set(value.entries.map((item) => item.path)).size !== value.entries.length ||
      value.entries.reduce((sum, item) => sum + item.size, 0) > COMPUTER_BYTES
    )
      ctx.addIssue({ code: "custom", message: "Invalid data checkpoint topology or budget" })
  })
export type ComputerDataManifest = z.infer<typeof computerDataManifest>
export const computerSharedManifest = z
  .object({ format: z.literal(1), workspaceId: id, entries: botDirectoryEntries })
  .strict()
export const computerBrowserManifest = z
  .object({
    format: z.literal(1),
    originId: id,
    platform: z.enum(["darwin", "win32", "linux"]),
    browser: z.enum(["chrome", "msedge"]),
    entries: botDirectoryEntries,
    // These are review evidence only. Restored sessions are never inserted into
    // bot_browser_sessions, and startup must not navigate to these URLs.
    pages: z
      .array(
        z
          .object({
            botId: id,
            urls: z.array(z.string().max(8192)).max(16),
            active: z.number().int().min(0).max(15)
          })
          .strict()
      )
      .max(2048)
  })
  .strict()
const snapshotState = z.discriminatedUnion("state", [
  absent,
  z.object({ state: z.literal("established"), identity: computerIdentity }).strict()
])
export const computerSlotName = z.enum([
  "database",
  "database-wal",
  "database-shm",
  "database-journal",
  "objects",
  "teach",
  "browser",
  "shared"
])
export type ComputerSlotName = z.infer<typeof computerSlotName>
export const computerSlot = z
  .object({ name: computerSlotName, original: snapshotState, replacement: snapshotState })
  .strict()
export type ComputerSlot = z.infer<typeof computerSlot>
const sharedState = z.discriminatedUnion("state", [
  absent,
  z
    .object({
      state: z.literal("established"),
      reference: botSharedWorkspaceReference,
      recordSha256: hash
    })
    .strict()
])
export const computerPrepared = z
  .object({
    format: z.literal(1),
    nonce: id,
    originId: id,
    checkpoint: botComputerCheckpointSelection,
    components,
    originalShared: sharedState,
    replacementShared: sharedState,
    sharedTargetId: id.optional(),
    managedRecoveryId: id.optional(),
    slots: z.array(computerSlot).length(8)
  })
  .strict()
export type ComputerPrepared = z.infer<typeof computerPrepared>
export const computerJournal = z
  .object({
    format: z.literal(1),
    nonce: id,
    stage: id,
    originId: id,
    owner: computerOwnedIdentity,
    checkpoint: botComputerCheckpointSelection,
    preparedSha256: hash,
    result: botComputerCheckpointRestoreResult
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.result.recoveryCopy !== value.nonce ||
      value.result.checkpoint.id !== value.checkpoint.id ||
      value.result.checkpoint.sha256 !== value.checkpoint.sha256
    )
      ctx.addIssue({
        code: "custom",
        message: "Restore journal receipt does not match the request"
      })
  })
export type ComputerJournal = z.infer<typeof computerJournal>
export const COMPUTER_SLOT_ORDER: ComputerSlotName[] = [
  "database",
  "database-wal",
  "database-shm",
  "database-journal",
  "objects",
  "teach",
  "browser",
  "shared"
]
export function validatePrepared(value: unknown): ComputerPrepared {
  const parsed = computerPrepared.parse(value)
  if (parsed.slots.some((slot, index) => slot.name !== COMPUTER_SLOT_ORDER[index]))
    throw new Error("恢复文件范围无效")
  const data = parsed.components.data.state === "established",
    browser = parsed.components.browser.state === "established",
    shared = parsed.components.shared.state === "established"
  for (const slot of parsed.slots) {
    const shouldExist = ["database", "objects", "teach"].includes(slot.name)
      ? data
      : slot.name === "browser"
        ? browser
        : slot.name === "shared"
          ? shared
          : false
    if ((slot.replacement.state === "established") !== shouldExist)
      throw new Error("恢复文件状态与准备清单不一致")
  }
  if (
    shared !== (parsed.replacementShared.state === "established") ||
    (shared || parsed.originalShared.state === "established") !== Boolean(parsed.sharedTargetId)
  )
    throw new Error("共享目录恢复状态不一致")
  return parsed
}
