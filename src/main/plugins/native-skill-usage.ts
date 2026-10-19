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
  allowsSkill(document: string): boolean
  assertCurrent(): void
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

/** Only opt-in declaration files are read. Never hash or copy an entire installed package. */
export async function readNativeSkillUsagePolicy(
  plugins: Pick<PluginMetadata, "path" | "enabled">[],
  captureContext: () => { usage: CapabilityUsageContext; assertCurrent(): void },
  signal?: AbortSignal
): Promise<NativeSkillUsagePolicy | undefined> {
  const blocked: string[] = []
  const snapshots: Array<{ root: string; path: string; digest: string }> = []
  let context: ReturnType<typeof captureContext> | undefined
  for (const plugin of plugins) {
    if (!plugin.enabled) continue
    signal?.throwIfAborted()
    const manifestPath = join(plugin.path, "devclaw.capabilities.json")
    try {
      await lstat(manifestPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw error
    }
    context ??= captureContext()
    const file = await readRuntimeScopedFileAsync(
      plugin.path,
      "devclaw.capabilities.json",
      PLUGIN_CAPABILITIES_MAX_BYTES,
      signal
    )
    if (!file.bytes) throw Error("NATIVE_CAPABILITY_DECLARATION_CHANGED")
    const declaration = parsePluginCapabilities(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes))
    )
    if (!declaration) throw Error("NATIVE_CAPABILITY_DECLARATION_INVALID")
    snapshots.push({
      root: plugin.path,
      path: "devclaw.capabilities.json",
      digest: runtimeDigest(file.bytes)
    })
    const byId = new Map(declaration.capabilities.map((item) => [item.id, item]))
    const permitted = new Map<string, boolean>()
    const allowed = (id: string, seen = new Set<string>()): boolean => {
      if (permitted.has(id)) return permitted.get(id)!
      if (seen.has(id)) return false
      const item = byId.get(id)
      if (!item || !isCapabilityUsageAllowed(item.usage, context!.usage)) return false
      const next = new Set(seen).add(id)
      const result = item.dependsOn.every((dependency) => allowed(dependency, next))
      permitted.set(id, result)
      return result
    }
    const flowEntries = new Set<string>()
    for (const item of declaration.capabilities) {
      if (item.kind === "skill" && !allowed(item.id)) {
        const root = dirname(join(plugin.path, item.entry))
        blocked.push(key(root), physicalKey(root))
      }
      if (item.kind === "flow" && !allowed(item.id) && !flowEntries.has(item.entry)) {
        flowEntries.add(item.entry)
        const runtimeFile = await readRuntimeScopedFileAsync(
          plugin.path,
          item.entry,
          PLUGIN_CAPABILITIES_MAX_BYTES,
          signal
        )
        if (!runtimeFile.bytes) throw Error("NATIVE_CAPABILITY_RUNTIME_REQUIRED")
        const runtime = parseProjectRuntimeManifest(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(runtimeFile.bytes))
        )
        snapshots.push({
          root: plugin.path,
          path: item.entry,
          digest: runtimeDigest(runtimeFile.bytes)
        })
        for (const stage of runtime.stages) {
          if (!stage.skill) continue
          const root = dirname(join(plugin.path, stage.skill))
          blocked.push(key(root), physicalKey(root))
        }
        // Dynamic legacy stages cannot be safely separated by a static skill path.
        if (runtime.mode === "legacy") blocked.push(key(plugin.path), physicalKey(plugin.path))
      }
    }
  }
  if (!context) return undefined
  context.assertCurrent()
  return {
    allowsSkill: (document) => {
      const paths = [key(document), physicalKey(document)]
      return !blocked.some((root) =>
        paths.some((path) => path === root || path.startsWith(`${root}/`))
      )
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
