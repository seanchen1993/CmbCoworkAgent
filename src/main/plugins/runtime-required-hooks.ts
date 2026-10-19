import { parsePluginCapabilities } from "../../shared/plugin-capabilities"
import { readRuntimeScopedFile } from "../harness-board/project-runtime/safe-files"
import { parsePluginHooks } from "../storage"
import type { PluginMetadata } from "../types"
import { assertPackageExtensionCompatibility } from "./extension-contract"
import { readPackageExtensionContract } from "./extension-contract"
import { REQUIRED_BUSINESS_CHECKS_PROTOCOL } from "../../shared/project-runtime"
import { reviewedAutobizRequiredHookIds } from "./autobiz-required-hooks"

/** Read only after the caller has admitted/frozen this package. Never grants plugin authority. */
export function readRuntimeRequiredHooks(
  plugin: PluginMetadata,
  options: { legacy?: boolean; entry?: string } = {}
): string[] {
  assertPackageExtensionCompatibility(plugin.path)
  const declaration = readRuntimeScopedFile(plugin.path, "devclaw.capabilities.json", 65_536)
  const manifest = declaration.present
    ? parsePluginCapabilities(JSON.parse(declaration.bytes!.toString("utf8")))
    : undefined
  const required = new Set(
    manifest?.capabilities
      .filter(
        (item) => item.usage !== "chat" && (item.kind === "flow" || item.entry === options.entry)
      )
      .flatMap((item) => item.requiredHooks ?? []) ?? []
  )
  const adapterFile = options.legacy
    ? readRuntimeScopedFile(plugin.path, "devclaw.stage-checks.json", 4096)
    : undefined
  const adapter = adapterFile?.present
    ? (JSON.parse(adapterFile.bytes!.toString("utf8")) as Record<string, unknown>)
    : undefined
  const legacyGuards =
    adapter?.apiVersion === "devclaw.stage-check-adapter/v1" && adapter.adapter === "autobiz-v1"
  if (!required.size && !legacyGuards) return []
  if (
    legacyGuards &&
    readPackageExtensionContract(plugin.path)?.requires.includes(REQUIRED_BUSINESS_CHECKS_PROTOCOL)
  ) {
    const file = readRuntimeScopedFile(
      plugin.path,
      plugin.hookPath ?? "hooks/hooks.json",
      256 * 1024
    )
    if (!file.present) throw Error("PROJECT_REQUIRED_HOOK_MISSING")
    const reviewed = reviewedAutobizRequiredHookIds(JSON.parse(file.bytes!.toString("utf8")))
    for (const id of reviewed)
      if (!required.has(id) && !required.has(`plugin:${plugin.id}/${id}`))
        throw Error(`PROJECT_REQUIRED_HOOK_DECLARATION_INCOMPLETE: ${id}`)
  }
  const hooks = parsePluginHooks(plugin)
  // The supported old adapter already declares blocking business guards through onBlock.
  // Keep that policy while generic plugins opt in through capability.requiredHooks.
  if (legacyGuards)
    for (const hook of hooks)
      if (hook.onBlock && (hook.event === "PreToolUse" || hook.event === "PostToolUse"))
        required.add(hook.id)
  const ids = [...required].map((id) => {
    const hook = hooks.find(
      (item) => item.enabled && (item.id === id || item.id === `plugin:${plugin.id}/${id}`)
    )
    if (!hook) throw Error("PROJECT_REQUIRED_HOOK_MISSING")
    return hook.id
  })
  return [...new Set(ids)]
}
