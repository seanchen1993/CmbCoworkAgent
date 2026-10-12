/** One identity for all entries/chunks in an application build; source tests use a stable fallback. */
import type { BotRpcMethod } from "../../shared/bot-api"
declare const __BOT_BUILD_ID__: string
export const BOT_BUILD_ID =
  typeof __BOT_BUILD_ID__ === "string" ? __BOT_BUILD_ID__ : "source-development"

export interface BotIdleRestartResult {
  accepted: boolean
  reason: string | null
}

/** During a build transition, existing tasks can be inspected, answered or stopped.
 * New work waits until the Host and desktop run the same code. */
export const BOT_UPGRADE_ALLOWED_METHODS = new Set<BotRpcMethod>([
  "status",
  "usageBudget",
  "snapshot",
  "events",
  "messages",
  "message",
  "thread",
  "threadSummaries",
  "search",
  "setReadState",
  "runHistory",
  "runOutput",
  "asyncTasks",
  "shellJob",
  "stopShellJob",
  "webhook",
  "avatar",
  "backupSchedule",
  "effectDetail",
  "interactionDetail",
  "worktreeDetail",
  "routineHistory",
  "artifacts",
  "download",
  "fileChunk",
  "filePreview",
  "cancelFilePreview",
  "cancelModelCheck",
  "effects",
  "answer",
  "provideSecret",
  "secrets",
  "approvalRules",
  "autoReviewSettings",
  "cancel",
  "computerOpen",
  "computerTake",
  "computerFrame",
  "computerRelease",
  "computerInput",
  "teachStatus",
  "teachPause",
  "teachStop",
  "teachHistory",
  "teachVideoChunk",
  "skillTrials",
  "skillDependencies",
  "connectors",
  "memories",
  "skills",
  "routines"
])

export function botUpgradeAllows(method: BotRpcMethod, input?: unknown): boolean {
  if (BOT_UPGRADE_ALLOWED_METHODS.has(method)) return true
  // Cancelling an existing child is allowed; messaging it starts additional work.
  // The owning Host still validates the full address, revision, nonce and permissions.
  return (
    method === "workflowControl" &&
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    "operation" in input &&
    input.operation === "cancel"
  )
}
