import { createHash } from "node:crypto"
import type { BotModelSnapshot } from "./model-config"
import { canonicalJson } from "./validation"

/** These preferences are bounded separately or pinned by the run. Changing them
 * neither grants access nor revokes credentials. Keep every other field, including
 * unknown future fields, in the authority check; a whitelist could miss a new
 * permission-bearing setting. Never persist the credential-bearing projection. */
const preferences = [
  "timezone",
  "graphRecursionLimit",
  "toolStrategy",
  "failureFuse",
  "workflowWorktreeTimeoutMinutes",
  "workflowWorktreeRemoveTimeoutMinutes"
] as const satisfies readonly (keyof BotModelSnapshot)[]

export function botExecutionAuthorityFingerprint(snapshot: BotModelSnapshot): string {
  const authority = { ...snapshot }
  for (const key of preferences) delete authority[key]
  return createHash("sha256")
    .update(canonicalJson(JSON.parse(JSON.stringify(authority))))
    .digest("hex")
}
