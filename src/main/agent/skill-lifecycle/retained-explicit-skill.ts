import { isAbsolute, join, relative, resolve } from "node:path"
import type { PluginMetadata } from "../../types"
import { normalizePathKey } from "../../hooks/path-key"
import {
  assertCurrentRuntimePluginSourceContent,
  captureRuntimePluginSourceThreadGuard,
  captureRuntimePluginSourceToken,
  currentRuntimePluginSource
} from "../../plugins/runtime-source-scope"
import { getPluginSkillSearchSources, readPluginManifest } from "../../plugins/manifest"
import {
  capturePackageMetadataGuard,
  readPackageProtocolDigestAsync
} from "../../harness-board/project-runtime/package-snapshots"
import { SkillLifecycleRegistry } from "./registry"
import { formatSkillUseBlock, parseSkillUseBlock } from "./marker"

export interface RetainedExplicitSkillScope {
  workspacePath: string
  threadId: string
  signal?: AbortSignal
  readInstalledPlugins(): readonly PluginMetadata[]
  readDisabledSkillDirs?(): readonly string[]
  assertCurrent?(): void
}

const identity = (plugin: PluginMetadata): string =>
  JSON.stringify([
    plugin.id,
    plugin.name,
    plugin.version,
    plugin.path,
    plugin.enabled,
    plugin.createdAt,
    plugin.updatedAt
  ])
const pathKey = (path: string): string => normalizePathKey(resolve(path))
const within = (path: string, root: string): boolean => {
  const child = pathKey(path),
    parent = pathKey(root)
  return child === parent || child.startsWith(parent + "/")
}

/** Rebase an exact installed Skill onto this run's retained bytes, never by matching its name.
 * Ordinary/already-retained references avoid the full-tree read. Only an actual same-owner
 * installation path incurs one cancellable, bounded package digest verification.
 */
export async function relocateRetainedExplicitSkill<T extends { name: string; path: string }>(
  input: T,
  scope: RetainedExplicitSkillScope
): Promise<T> {
  const source = currentRuntimePluginSource()
  if (
    !source ||
    !["host", "legacy", "capabilities"].includes(source.mode ?? "") ||
    !isAbsolute(input.path)
  )
    return input
  if (within(input.path, source.plugin.path)) {
    const disabled = scope.readDisabledSkillDirs?.() ?? []
    if (!disabled.length) return input
    scope.signal?.throwIfAborted()
    scope.assertCurrent?.()
    captureRuntimePluginSourceThreadGuard(scope.threadId, scope.workspacePath)()
    const installed = scope.readInstalledPlugins().find((plugin) => plugin.id === source.plugin.id)
    const candidates = [
      input.path,
      ...(installed ? [join(installed.path, relative(source.plugin.path, input.path))] : [])
    ]
    if (disabled.some((dir) => candidates.some((path) => within(path, dir))))
      throw Error("EXPLICIT_SKILL_DISABLED: 显式选择的技能已禁用。")
    return input
  }
  const installed = scope.readInstalledPlugins().find((plugin) => plugin.id === source.plugin.id)
  if (!installed || !within(input.path, installed.path)) return input
  const token = captureRuntimePluginSourceToken()
  const originalIdentity = identity(installed)
  const originalRoot: { value?: string } = {}
  const guardThread = captureRuntimePluginSourceThreadGuard(scope.threadId, scope.workspacePath)
  function changed(): never {
    throw Error("EXPLICIT_SKILL_SOURCE_CHANGED: 所选技能来源已变化，请重新选择技能。")
  }
  const assertCurrent = (): void => {
    scope.signal?.throwIfAborted()
    scope.assertCurrent?.()
    guardThread()
    if (captureRuntimePluginSourceToken() !== token || currentRuntimePluginSource() !== source)
      changed()
    const latest = scope.readInstalledPlugins().find((plugin) => plugin.id === source.plugin.id)
    if (
      !latest ||
      !latest.enabled ||
      identity(latest) !== originalIdentity ||
      latest.name !== source.plugin.name ||
      latest.version !== source.plugin.version
    )
      changed()
    const disabledRoot = originalRoot.value
    if (disabledRoot && scope.readDisabledSkillDirs?.().some((dir) => within(disabledRoot, dir)))
      throw Error("EXPLICIT_SKILL_DISABLED: 显式选择的技能已禁用。")
  }
  assertCurrent()
  assertCurrentRuntimePluginSourceContent()
  // Resolve only against admitted bytes. Never read an arbitrary file from a mutable
  // installation merely because its current path or frontmatter looks like a Skill.
  const skillPath = relative(resolve(installed.path), resolve(input.path)).replace(/\\/g, "/")
  if (
    !skillPath ||
    isAbsolute(skillPath) ||
    skillPath.split("/").some((part) => !part || part === "." || part === "..")
  )
    return input
  const manifest = readPluginManifest(source.plugin.path)?.manifest
  if (
    !manifest ||
    manifest.name !== source.plugin.name ||
    manifest.version !== source.plugin.version
  )
    changed()
  const selected = new SkillLifecycleRegistry(
    getPluginSkillSearchSources(source.plugin.path, manifest)
  ).resolveExplicit({ skillName: input.name, skillPath: join(source.plugin.path, skillPath) })
  if (!selected || selected.name.trim().toLowerCase() !== input.name.trim().toLowerCase())
    return input
  originalRoot.value = join(installed.path, relative(source.plugin.path, selected.rootDir))
  assertCurrent()
  const checkInstalledMetadata = capturePackageMetadataGuard(installed.path)
  // Goal validation can precede creation of a foreground controller. Keep the original
  // reader's five-second bound cancellable even when that caller has no signal yet.
  const digestSignal = scope.signal
    ? AbortSignal.any([scope.signal, AbortSignal.timeout(5000)])
    : AbortSignal.timeout(5000)
  const digest = await readPackageProtocolDigestAsync(installed.path, digestSignal)
  assertCurrent()
  assertCurrentRuntimePluginSourceContent()
  checkInstalledMetadata()
  if (digest !== source.packageDigest) changed()
  return { ...input, path: selected.path }
}

/** Preserve goal scaffolding while appending/rebasing only its explicit native Skill block. */
export async function appendRetainedExplicitSkillContext(
  prompt: string,
  input: { name: string; path: string },
  scope: RetainedExplicitSkillScope
): Promise<string> {
  const existing = parseSkillUseBlock(prompt)
  const selected = await relocateRetainedExplicitSkill(
    existing ? { name: existing.skillName, path: existing.skillPath } : input,
    scope
  )
  if (existing && existing.skillPath === selected.path) return prompt
  return [(existing?.rest ?? prompt).trimEnd(), formatSkillUseBlock(selected)].join("\n\n")
}
