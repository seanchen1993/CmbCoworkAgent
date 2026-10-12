import { z } from "zod"

/** Grok External-tool choices, adapted to the user's project. This permit never
 * changes the underlying file boundary, command sandbox, plugin grant or action review. */
export const BOT_LOCAL_TOOL_ASK_TTL_MS = 10 * 60 * 1000
export const botLocalToolPermission = z.enum(["ask", "always", "never"])
export type BotLocalToolPermission = z.infer<typeof botLocalToolPermission>
const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[\w:.-]+$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const botLocalComputerTarget = z
  .object({
    id: digest,
    label: z.string().min(1).max(200),
    platform: z.enum(["darwin", "win32", "linux"])
  })
  .strict()
export type BotLocalComputerTarget = z.infer<typeof botLocalComputerTarget>
export const botLocalToolPolicy = z
  .object({
    target: botLocalComputerTarget,
    dataEpoch: id,
    revision: z.number().int().nonnegative(),
    choice: botLocalToolPermission,
    ceiling: botLocalToolPermission,
    effective: botLocalToolPermission
  })
  .strict()
export type BotLocalToolPolicy = z.infer<typeof botLocalToolPolicy>
export const botLocalToolPolicyChange = z
  .object({
    nonce: id,
    targetId: digest,
    dataEpoch: id,
    revision: z.number().int().nonnegative(),
    choice: botLocalToolPermission
  })
  .strict()
export type BotLocalToolPolicyChange = z.infer<typeof botLocalToolPolicyChange>
export const botLocalToolResolution = z.enum(["allow-once", "deny", "always", "never"])
export const botLocalToolAnswer = z
  .object({
    nonce: id,
    targetId: digest,
    dataEpoch: id,
    id,
    revision: z.number().int().positive(),
    resolution: botLocalToolResolution
  })
  .strict()
export type BotLocalToolAnswer = z.infer<typeof botLocalToolAnswer>
export const botLocalToolAction = z
  .object({
    kind: z.enum(["run-command", "read-file", "list-directory", "write-file"]),
    workspace: z.string().min(1).max(4096),
    target: z.string().min(1).max(16_000),
    description: z.string().min(1).max(500),
    // Host-pinned root/operation identity. Display strings alone cannot authorize anything.
    fingerprint: digest
  })
  .strict()
export type BotLocalToolAction = z.infer<typeof botLocalToolAction>
export const botLocalToolCard = z
  .object({
    version: z.literal(1),
    target: botLocalComputerTarget,
    dataEpoch: id,
    policyRevision: z.number().int().nonnegative(),
    action: botLocalToolAction
  })
  .strict()
export type BotLocalToolCard = z.infer<typeof botLocalToolCard>
export function readBotLocalToolCard(prompt: string): BotLocalToolCard | null {
  try {
    const result = botLocalToolCard.safeParse(JSON.parse(prompt)?.localProjectAccess)
    return result.success ? result.data : null
  } catch {
    return null
  }
}
