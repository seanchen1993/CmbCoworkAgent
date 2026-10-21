import { isAbsolute, relative, sep } from "node:path"
import type { HookConfig } from "../../hooks/types"
import { readRuntimeScopedFile } from "./safe-files"

export interface StageRecoveryPolicy {
  apiVersion: "devclaw.stage-recovery/v1"
  hookExecution: "prompt-only" | "windows-sandbox"
  externalEffects: "deny" | "network-requires-confirmation"
  contextProvider?: { protocol: "devclaw.context-text/v1"; args: string[] }
}

export interface StageRecoveryCommandPolicy {
  /** Native-owned retained source and upstream trial roots. Never user-selected ACL targets. */
  readOnlyRoots: readonly string[]
  networkAccess: "explicitly-approved"
}

function deny(code: string): never {
  throw Error(`PROJECT_STAGE_DEBUG_${code}`)
}

/** A package declaration is a request, never an execution grant. Native branch review still
 * authorizes the retained bytes; every Hook boundary enforces the supported execution profile.
 */
export function readStageRecoveryPolicy(root: string): StageRecoveryPolicy | undefined {
  const file = readRuntimeScopedFile(root, "devclaw.stage-recovery.json", 4096)
  if (!file.bytes) return undefined
  try {
    const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes))
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      ![
        "apiVersion,externalEffects,hookExecution",
        "apiVersion,contextProvider,externalEffects,hookExecution"
      ].includes(Object.keys(raw).sort().join(",")) ||
      raw.apiVersion !== "devclaw.stage-recovery/v1" ||
      !(
        (raw.hookExecution === "prompt-only" && raw.externalEffects === "deny") ||
        (raw.hookExecution === "windows-sandbox" &&
          raw.externalEffects === "network-requires-confirmation")
      )
    )
      deny("RECOVERY_DECLARATION_INVALID")
    if (
      raw.contextProvider !== undefined &&
      (raw.hookExecution !== "windows-sandbox" ||
        !raw.contextProvider ||
        typeof raw.contextProvider !== "object" ||
        Object.keys(raw.contextProvider).sort().join(",") !== "args,protocol" ||
        raw.contextProvider.protocol !== "devclaw.context-text/v1" ||
        !Array.isArray(raw.contextProvider.args) ||
        raw.contextProvider.args.length > 64 ||
        raw.contextProvider.args.some(
          (arg: unknown) =>
            typeof arg !== "string" ||
            arg.length > 4096 ||
            arg.includes("\0") ||
            /\$\{(?!(?:workspace|stageId|goal)\})/.test(arg)
        ))
    )
      deny("RECOVERY_DECLARATION_INVALID")
    return raw
  } catch {
    deny("RECOVERY_DECLARATION_INVALID")
  }
}

export function assertStageRecoveryPromptDeclaration(raw: Record<string, unknown>): void {
  if (
    raw.type !== "prompt" ||
    typeof raw.prompt !== "string" ||
    !raw.prompt.trim() ||
    raw.prompt.length > 65536 ||
    raw.fallback !== "block" ||
    raw.async === true ||
    raw.command !== undefined ||
    raw.shell !== undefined ||
    raw.url !== undefined ||
    raw.headers !== undefined ||
    raw.allowedEnvVars !== undefined ||
    (raw.injectUserContext !== undefined && raw.injectUserContext !== false) ||
    (raw.onBlock &&
      (typeof raw.onBlock !== "object" ||
        Array.isArray(raw.onBlock) ||
        Object.hasOwn(raw.onBlock, "requiredSkill")))
  )
    deny("HOOK_PROFILE_UNSUPPORTED")
}

export function assertStageRecoveryCommandDeclaration(raw: Record<string, unknown>): void {
  if (
    (raw.type ?? "command") !== "command" ||
    typeof raw.command !== "string" ||
    !raw.command.trim() ||
    raw.command.length > 65536 ||
    raw.async === true ||
    (raw.shell !== undefined && raw.shell !== "powershell") ||
    raw.fallback !== "block" ||
    raw.url !== undefined ||
    raw.prompt !== undefined ||
    (raw.injectUserContext !== undefined && raw.injectUserContext !== false)
  )
    deny("HOOK_PROFILE_UNSUPPORTED")
}

export function assertStageRecoveryDeclaration(
  raw: Record<string, unknown>,
  policy: StageRecoveryPolicy
): void {
  if (raw.type === "prompt") assertStageRecoveryPromptDeclaration(raw)
  else if (policy.hookExecution === "windows-sandbox") assertStageRecoveryCommandDeclaration(raw)
  else deny("HOOK_PROFILE_UNSUPPORTED")
}

function inside(root: string, path: string): boolean {
  const result = relative(root, path)
  return !isAbsolute(result) && result !== ".." && !result.startsWith(`..${sep}`)
}

/** Global and workspace policy is never silently dropped. A matching unconfined Hook blocks
 * this branch, even if another retained package Hook happens to have the same identifier.
 */
export function assertStageRecoveryHookSupported(
  policy: {
    allowPromptHooks?: boolean
    commandHooks?: StageRecoveryCommandPolicy
    snapshotRoot: string
  },
  hook: HookConfig
): void {
  const scoped = hook as HookConfig & { pluginRoot?: string }
  if (hook.type === "prompt" && policy.allowPromptHooks)
    assertStageRecoveryPromptDeclaration(hook as unknown as Record<string, unknown>)
  else if (policy.commandHooks?.networkAccess === "explicitly-approved")
    assertStageRecoveryCommandDeclaration(hook as unknown as Record<string, unknown>)
  else deny("HOOK_UNSUPPORTED")
  if (
    !["plugin", "skill"].includes(hook.hookSourceType ?? "") ||
    !scoped.pluginRoot ||
    relative(policy.snapshotRoot, scoped.pluginRoot) !== "" ||
    !hook.hookSourceRoot ||
    !inside(policy.snapshotRoot, hook.hookSourceRoot) ||
    !hook.hookSourcePath ||
    !inside(policy.snapshotRoot, hook.hookSourcePath)
  )
    deny("HOOK_SOURCE_UNSUPPORTED")
}
