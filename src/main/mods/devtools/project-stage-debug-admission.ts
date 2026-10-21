import { posix, relative } from "node:path"
import { isMap, parseDocument } from "yaml"
import {
  parseProjectRuntimeManifest,
  type ProjectRuntimeManifest
} from "../../../shared/project-runtime"
import { parsePluginCapabilities } from "../../../shared/plugin-capabilities"
import { parseClawActionExports } from "../../../shared/mods/claw-actions"
import {
  DEFAULT_PLUGIN_HOOKS_PATH,
  getPluginSkillSearchSources,
  readPluginManifest,
  validatePluginManifest
} from "../../plugins/manifest"
import { readPackageExtensionContract } from "../../plugins/extension-contract"
import { capturePackageMetadataGuard } from "../../harness-board/project-runtime/package-snapshots"
import { packageUsesSharedMods } from "../../harness-board/project-runtime/package-preflight"
import { isConfigurationOnlyPackage } from "../v2/configuration-only-package"
import {
  readRuntimeScopedFile,
  runtimeDirectory,
  runtimeRelativePath
} from "../../harness-board/project-runtime/safe-files"
import { discoverSkillsSync } from "../../skills/discovery"
import { isSupportedHookEvent } from "../../hooks/types"
import {
  assertStageRecoveryDeclaration,
  readStageRecoveryPolicy,
  type StageRecoveryPolicy
} from "../../harness-board/project-runtime/stage-recovery-policy"

function deny(code: string): never {
  throw Error(`PROJECT_STAGE_DEBUG_${code}`)
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) deny("DECLARATION_INVALID")
  return input as Record<string, unknown>
}
function read(root: string, path: string, required = false): string | undefined {
  const file = readRuntimeScopedFile(root, runtimeRelativePath(path), 256 * 1024)
  if (!file.bytes) {
    if (required) deny("RESOURCE_MISSING")
    return undefined
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)
}
function json(root: string, path: string, required = false): unknown {
  const text = read(root, path, required)
  return text === undefined ? undefined : JSON.parse(text)
}

/** An empty declaration may remain byte-for-byte. No disabled/nonmatching handler is discarded. */
function emptyHooks(input: unknown, recovery?: StageRecoveryPolicy) {
  if (Array.isArray(input)) {
    if (input.length && !recovery) deny("HOOKS_UNSUPPORTED")
    for (const entry of input) {
      const hook = record(entry)
      if (!isSupportedHookEvent(hook.event)) deny("HOOK_DECLARATION_INVALID")
      assertStageRecoveryDeclaration(hook, recovery!)
    }
    return
  }
  const raw = record(input)
  if (Object.hasOwn(raw, "modules")) deny("SHARED_MODS_UNSUPPORTED")
  let events = raw
  if (Object.hasOwn(raw, "hooks")) {
    if (
      Object.keys(raw).some((key) => !["description", "hooks"].includes(key)) ||
      (raw.description !== undefined && typeof raw.description !== "string")
    )
      deny("HOOK_DECLARATION_INVALID")
    events = record(raw.hooks)
  }
  for (const [event, matchers] of Object.entries(events)) {
    if (!isSupportedHookEvent(event) || !Array.isArray(matchers)) deny("HOOK_DECLARATION_INVALID")
    if (matchers.length && !recovery) deny("HOOKS_UNSUPPORTED")
    for (const matcher of matchers) {
      const row = record(matcher)
      if (!Array.isArray(row.hooks)) deny("HOOK_DECLARATION_INVALID")
      for (const hook of row.hooks) assertStageRecoveryDeclaration(record(hook), recovery!)
    }
  }
}

function skillHooks(root: string, skill: string, recovery?: StageRecoveryPolicy) {
  const text = read(root, skill, true)!
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/.exec(text)
  if (header) {
    const yaml = parseDocument(header[1])
    if (yaml.errors.length || !isMap(yaml.contents)) deny("SKILL_DECLARATION_INVALID")
    const fields = record(yaml.toJS({ maxAliasCount: 32 }))
    if (Object.keys(fields).some((key) => key.toLowerCase() === "hooks")) {
      if (!recovery || !Object.hasOwn(fields, "hooks")) deny("SKILL_HOOKS_UNSUPPORTED")
      emptyHooks(fields.hooks, recovery)
    }
  } else if (text.startsWith("---")) deny("SKILL_DECLARATION_INVALID")
  const directory = posix.dirname(skill)
  for (const entry of ["hooks.json", "hooks/hooks.json"]) {
    const hooks = json(root, directory === "." ? entry : `${directory}/${entry}`)
    if (hooks !== undefined) emptyHooks(hooks, recovery)
  }
}

/** Conservative admission for the first confined-file stage debugger. Declarations never prove
 * that arbitrary scripts are safe: unsupported behavior blocks this debug path, never gets cut
 * out of the plugin. The original project entry remains available with its normal permissions.
 */
export function assertStageDebugPackageSupported(
  root: string,
  manifest: ProjectRuntimeManifest,
  options: { frozenInputsBound?: boolean } = {}
): void {
  try {
    runtimeDirectory(root)
    const sourceGuard = capturePackageMetadataGuard(root)
    const recovery = readStageRecoveryPolicy(root)
    const original = readPluginManifest(root)
    if (!original) deny("MANIFEST_MISSING")
    const raw = record(json(root, original.relPath, true))
    const parsed = validatePluginManifest(raw)
    if (!parsed || !same(parsed, original.manifest)) deny("MANIFEST_CHANGED")
    if (
      parsed.name !== manifest.plugin.id ||
      parsed.version !== manifest.plugin.version ||
      manifest.mode !== "host" ||
      manifest.stateOwner !== "host"
    )
      deny("OWNER_UNSUPPORTED")
    if (
      !same(parseProjectRuntimeManifest(json(root, "devclaw.project-runtime.json", true)), manifest)
    )
      deny("SOURCE_CHANGED")
    for (const key of ["hooks", "mods", "mcpServers"])
      if (raw[key] !== undefined && (typeof raw[key] !== "string" || !raw[key]))
        deny("MANIFEST_INVALID")
    if (
      !options.frozenInputsBound &&
      (Object.hasOwn(raw, "userConfig") || Object.hasOwn(raw, "userConfigSchema"))
    )
      deny("CONFIGURATION_UNSUPPORTED")
    const contract = readPackageExtensionContract(root)
    // No cross-branch provider, mutable context or external knowledge binding is silently omitted.
    if (contract?.context && !options.frozenInputsBound) deny("CONTEXT_UNSUPPORTED")
    if (contract?.context?.provider?.entry && !recovery?.contextProvider)
      deny("CONTEXT_PROVIDER_RECOVERY_REQUIRED")
    if (contract?.verifiedArtifacts) deny("VERIFIED_ARTIFACTS_UNSUPPORTED")
    if (parsed.mcpServers !== undefined || json(root, ".mcp.json") !== undefined)
      deny("MCP_UNSUPPORTED")
    if (packageUsesSharedMods(root, parsed) && !isConfigurationOnlyPackage(root))
      deny("SHARED_MODS_UNSUPPORTED")
    if (
      manifest.checks.some(
        (check) => check.kind === "action" || check.actionId || check.sideEffect !== "read"
      )
    )
      deny("CHECK_EFFECT_UNSUPPORTED")
    if (
      parseClawActionExports(raw.claw).length ||
      manifest.actions.length ||
      manifest.stages.some((stage) => stage.actionIds.length)
    )
      deny("ACTIONS_UNSUPPORTED")

    const hookPath = parsed.hooks ?? DEFAULT_PLUGIN_HOOKS_PATH
    const declaredHooks = json(root, hookPath, parsed.hooks !== undefined)
    if (declaredHooks !== undefined) emptyHooks(declaredHooks, recovery)
    const capabilities = parsePluginCapabilities(json(root, "devclaw.capabilities.json"))
    for (const capability of capabilities?.capabilities ?? []) {
      if (
        (capability.requiredHooks?.length && !recovery) ||
        capability.requiredMcpServers?.length ||
        capability.inputs?.length ||
        capability.dependsOn.length
      )
        deny("CAPABILITY_DEPENDENCY_UNSUPPORTED")
      if (capability.kind === "flow" && capability.entry !== "devclaw.project-runtime.json")
        deny("CAPABILITY_FLOW_UNSUPPORTED")
      if (
        capability.kind === "skill" &&
        !manifest.stages.some((stage) => stage.skill === capability.entry)
      )
        deny("CAPABILITY_SKILL_UNSUPPORTED")
    }
    const skills = new Set(
      manifest.stages.map((stage) => stage.skill).filter((path): path is string => !!path)
    )
    // Match the original supplement/convention discovery rules, including custom Skill roots.
    for (const source of getPluginSkillSearchSources(root, parsed))
      for (const skill of discoverSkillsSync(source.sourceDir, source.maxDepth))
        skills.add(relative(root, skill.skillMdPath).replace(/\\/g, "/"))
    for (const skill of skills) skillHooks(root, skill, recovery)
    sourceGuard()
  } catch (error) {
    if (error instanceof Error && /^PROJECT_STAGE_DEBUG_[A-Z_]+$/.test(error.message)) throw error
    // JSON/YAML/native parser errors may contain original credential fragments.
    deny("PACKAGE_INVALID")
  }
}
