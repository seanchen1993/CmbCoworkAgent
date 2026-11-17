import { lstat } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import {
  parsePluginCapabilities,
  PLUGIN_CAPABILITIES_MAX_BYTES
} from "../../shared/plugin-capabilities"
import {
  isCapabilityUsageAllowed,
  type CapabilityUsageContext
} from "../../shared/mods/capability-usage"
import { readRuntimeScopedFileAsync } from "../harness-board/project-runtime/safe-files-async"
import { readRuntimeScopedFile, runtimeDigest } from "../harness-board/project-runtime/safe-files"
import type { PluginMetadata } from "../types"
import { parseProjectRuntimeManifest } from "../../shared/project-runtime"

export interface NativeSkillUsagePolicy {
  readonly usage: CapabilityUsageContext
  allowsSkill(document: string): boolean
  assertCurrent(): void
}

interface SkillUsageSource {
  root: string
  path: string
  digest: string
}

const key = (path: string) => {
  const normalized = resolve(path).replaceAll("\\", "/")
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}
const physicalKey = (path: string) => {
  try {
    return key(realpathSync.native(path))
  } catch {
    return key(path)
  }
}
const within = (path: string, root: string) => path === root || path.startsWith(`${root}/`)

async function readPluginSkillUsage(
  root: string,
  usage: CapabilityUsageContext,
  signal?: AbortSignal
) {
  const blocked: string[] = []
  const snapshots: SkillUsageSource[] = []
  const file = await readRuntimeScopedFileAsync(
    root,
    "devclaw.capabilities.json",
    PLUGIN_CAPABILITIES_MAX_BYTES,
    signal
  )
  if (!file.bytes) throw Error("NATIVE_CAPABILITY_DECLARATION_CHANGED")
  const declaration = parsePluginCapabilities(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes))
  )
  if (!declaration) throw Error("NATIVE_CAPABILITY_DECLARATION_INVALID")
  snapshots.push({ root, path: "devclaw.capabilities.json", digest: runtimeDigest(file.bytes) })

  const byId = new Map(declaration.capabilities.map((item) => [item.id, item]))
  const permitted = new Map<string, boolean>()
  const allowed = (id: string, seen = new Set<string>()): boolean => {
    if (permitted.has(id)) return permitted.get(id)!
    if (seen.has(id)) return false
    const item = byId.get(id)
    if (!item || !isCapabilityUsageAllowed(item.usage, usage)) return false
    const next = new Set(seen).add(id)
    const result = item.dependsOn.every((dependency) => allowed(dependency, next))
    permitted.set(id, result)
    return result
  }
  const flowEntries = new Set<string>()
  for (const item of declaration.capabilities) {
    if (item.kind === "skill" && !allowed(item.id)) {
      const skillRoot = dirname(join(root, item.entry))
      blocked.push(key(skillRoot), physicalKey(skillRoot))
    }
    if (item.kind === "flow" && !allowed(item.id) && !flowEntries.has(item.entry)) {
      flowEntries.add(item.entry)
      const runtimeFile = await readRuntimeScopedFileAsync(
        root,
        item.entry,
        PLUGIN_CAPABILITIES_MAX_BYTES,
        signal
      )
      if (!runtimeFile.bytes) throw Error("NATIVE_CAPABILITY_RUNTIME_REQUIRED")
      const runtime = parseProjectRuntimeManifest(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(runtimeFile.bytes))
      )
      snapshots.push({ root, path: item.entry, digest: runtimeDigest(runtimeFile.bytes) })
      for (const stage of runtime.stages) {
        if (!stage.skill) continue
        const skillRoot = dirname(join(root, stage.skill))
        blocked.push(key(skillRoot), physicalKey(skillRoot))
      }
      // Dynamic legacy stages cannot be safely separated by a static skill path.
      if (runtime.mode === "legacy") blocked.push(key(root), physicalKey(root))
    }
  }
  return { blocked, snapshots }
}

/** Only opt-in declaration files are read. Never hash or copy an entire installed package. */
export async function readNativeSkillUsagePolicy(
  plugins: Pick<PluginMetadata, "path" | "enabled">[],
  captureContext: () => { usage: CapabilityUsageContext; assertCurrent(): void },
  signal?: AbortSignal,
  chatDiscovery?: { explicitSkillPath?: string }
): Promise<NativeSkillUsagePolicy | undefined> {
  const blocked: string[] = []
  const snapshots: SkillUsageSource[] = []
  let context: ReturnType<typeof captureContext> | undefined
  for (const plugin of plugins) {
    if (!plugin.enabled) continue
    signal?.throwIfAborted()
    let discoveryError: unknown
    try {
      await lstat(join(plugin.path, "devclaw.capabilities.json"))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      if (!chatDiscovery) throw error
      discoveryError = error
    }
    signal?.throwIfAborted()
    context ??= captureContext()
    try {
      if (discoveryError) throw discoveryError
      const source = await readPluginSkillUsage(plugin.path, context.usage, signal)
      blocked.push(...source.blocked)
      snapshots.push(...source.snapshots)
    } catch (error) {
      signal?.throwIfAborted()
      if (!chatDiscovery || context.usage !== "chat") throw error
      const roots = [key(plugin.path), physicalKey(plugin.path)]
      const selected = chatDiscovery.explicitSkillPath
      if (
        selected &&
        [key(selected), physicalKey(selected)].some((path) =>
          roots.some((root) => within(path, root))
        )
      )
        throw error
      // In ordinary discovery a broken source contributes no skills for this turn.
      blocked.push(...roots)
    }
  }
  signal?.throwIfAborted()
  if (!context) return undefined
  context.assertCurrent()
  return {
    usage: context.usage,
    allowsSkill: (document) => {
      if (!blocked.length) return true
      const paths = [key(document), physicalKey(document)]
      return !blocked.some((root) => paths.some((path) => within(path, root)))
    },
    assertCurrent: () => {
      context!.assertCurrent()
      for (const snapshot of snapshots) {
        const file = readRuntimeScopedFile(
          snapshot.root,
          snapshot.path,
          PLUGIN_CAPABILITIES_MAX_BYTES
        )
        if (!file.bytes || runtimeDigest(file.bytes) !== snapshot.digest)
          throw Error("NATIVE_CAPABILITY_DECLARATION_CHANGED")
      }
    }
  }
}
