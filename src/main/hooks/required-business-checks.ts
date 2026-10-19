import { isSameWorkspacePath } from "../../shared/workspace-path"
import { currentRuntimePluginSource } from "../plugins/runtime-source-scope"
import type { HookConfig, HookEvent, HookResult } from "./types"
import type { PluginHookMetadata } from "../types"

/** Events whose native callers consume a synchronous gate result. */
export const REQUIRED_BUSINESS_CHECK_EVENTS: ReadonlySet<HookEvent> = new Set([
  "PreToolUse",
  "PostToolUse",
  "PreSkillUse",
  "PostSkillUse",
  "Stop",
  "UserPromptSubmit",
  "UserPromptExpansion",
  "PreCompact",
  "PostToolBatch"
])

/** Only host-issued, package-bound declarations can protect a check. Script fields are ignored. */
export function partitionRequiredBusinessHooks(hooks: readonly HookConfig[]): {
  ordinary: HookConfig[]
  required: HookConfig[]
} {
  const binding = currentRuntimePluginSource()
  if (!binding) return { ordinary: [...hooks], required: [] }
  const sources = [
    { plugin: binding.plugin, requiredHooks: binding.requiredHooks ?? [] },
    ...(binding.capabilitySources ?? []).map(({ plugin, capability }) => ({
      plugin,
      requiredHooks: capability.requiredHooks ?? []
    }))
  ]
  const required = new Set<HookConfig>()
  for (const { plugin, requiredHooks } of sources) {
    for (const id of requiredHooks) {
      const expectedId = id.startsWith(`plugin:${plugin.id}/`) ? id : `plugin:${plugin.id}/${id}`
      const matched = hooks.filter((hook) => {
        const actual = hook as Partial<PluginHookMetadata>
        return (
          hook.id === expectedId &&
          actual.pluginId === plugin.id &&
          hook.hookSourceType === "plugin" &&
          !!hook.hookSourceRoot &&
          isSameWorkspacePath(hook.hookSourceRoot, plugin.path)
        )
      })
      if (matched.length !== 1 || !matched[0].enabled)
        throw Error(`REQUIRED_BUSINESS_CHECK_MISSING: ${expectedId}`)
      const hook = matched[0]
      if (
        !REQUIRED_BUSINESS_CHECK_EVENTS.has(hook.event) ||
        hook.async ||
        hook.once ||
        hook.forcedOutcome ||
        ((hook.type ?? "command") === "command" && !hook.command?.trim())
      )
        throw Error(`REQUIRED_BUSINESS_CHECK_CONFIG_INVALID: ${expectedId}`)
      required.add(hook)
    }
  }
  return { ordinary: hooks.filter((hook) => !required.has(hook)), required: [...required] }
}

export function requiredBusinessCheckFailure(hook: HookConfig, detail: string): HookResult {
  const reason = `REQUIRED_BUSINESS_CHECK_FAILED: ${hook.id}: ${detail}`
  return { exitCode: 1, stdout: reason, stderr: detail, blocked: true, decision: "block", reason }
}
