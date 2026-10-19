import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { ProjectRuntimeInputScope } from "../project-action-runtime"
import { extensionContextStorageKey } from "../extension-context"
import type { FunctionModsManager } from "../../mods/v2/manager"
import { readPackageExtensionContract } from "../../plugins/extension-contract"
import { readPluginManifest } from "../../plugins/manifest"
import { packageUsesSharedMods } from "./package-preflight"
import { readProjectActionLock } from "./action-input"
import {
  readRuntimeScopedFile,
  runtimeDigest,
  runtimeDirectory,
  runtimeDirectoryIdentity
} from "./safe-files"

type InputManager = Pick<
  FunctionModsManager,
  | "prepareRuntimeSourceFacts"
  | "getRuntimeSourceFacts"
  | "readUserConfigIdentity"
  | "readUserConfigDirectoryIdentity"
  | "assertRuntimeSourceConfiguration"
>

/** Hash actual declared knowledge bytes. No content or local path is returned across IPC. */
export function fingerprintProjectKnowledge(directory: string, required = false): string {
  if (!required && !existsSync(directory)) return runtimeDigest("empty-knowledge/v1")
  const root = runtimeDirectory(directory)
  const files: Array<[string, string]> = []
  let count = 0,
    total = 0
  const visit = (relative: string, depth: number) => {
    if (depth > 16) throw Error("PROJECT_KNOWLEDGE_LIMIT")
    const parent = join(root, relative)
    // A selected directory is an explicit read boundary. Do not follow directory symlinks.
    runtimeDirectory(parent)
    files.push([relative || ".", runtimeDirectoryIdentity(parent)])
    for (const item of readdirSync(parent, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      if (++count > 4096) throw Error("PROJECT_KNOWLEDGE_LIMIT")
      const path = relative ? `${relative}/${item.name}` : item.name
      if (item.isDirectory()) visit(path, depth + 1)
      else {
        if (!item.isFile() || item.isSymbolicLink()) throw Error("PROJECT_KNOWLEDGE_UNSAFE")
        const file = readRuntimeScopedFile(root, path, 16 * 1024 * 1024)
        if (!file.bytes) throw Error("PROJECT_KNOWLEDGE_CHANGED")
        total += file.bytes.length
        if (total > 32 * 1024 * 1024) throw Error("PROJECT_KNOWLEDGE_LIMIT")
        files.push([path, file.fingerprint])
      }
    }
  }
  visit("", 0)
  if (required && total === 0) throw Error("PROJECT_KNOWLEDGE_REQUIRED")
  if (total === 0) return runtimeDigest("empty-knowledge/v1")
  return runtimeDigest(JSON.stringify(files))
}

/** Reads existing native configuration, source and rule stores; never creates a parallel config. */
export function createHostProjectInputIdentity(
  manager: InputManager,
  host: {
    rules(workspace: string, plugins: readonly string[]): unknown
    contextDataRoot?: string
  }
) {
  const authority = (workspace: string, names: readonly string[]) => ({
    config: names.map(name => ({ name, ...manager.readUserConfigIdentity(workspace, name) })),
    rules: host.rules(workspace, names)
  })
  const source = (project: ProjectRuntimeInputScope, root: string) => ({
    workspace: project.workspace,
    plugin: {
      id: project.installedPluginId,
      name: project.packageId,
      path: root,
      enabled: true
    }
  })
  return {
    async prepareInputIdentity(project: ProjectRuntimeInputScope, root: string): Promise<void> {
      // Creating a project must leave the original native configuration form reachable.
      // Only immutable compiler/schema facts are required before that form exists.
      await manager.prepareRuntimeSourceFacts(source(project, root))
    },
    captureInputAuthorityIdentity(project: ProjectRuntimeInputScope, root: string): () => string {
      const metadata = readPluginManifest(root)?.manifest
      if (!metadata) throw Error("PROJECT_INPUT_SOURCE_MISSING")
      const own = manager.getRuntimeSourceFacts(source(project, root))
      if (packageUsesSharedMods(root, metadata) && !own)
        throw Error("PROJECT_INPUT_SOURCE_NOT_PREPARED")
      const lock = readProjectActionLock(root, project.manifest)
      const names = [...new Set([
        ...(own ? [own.name] : []), ...lock.bindings.map(item => item.ref.plugin)
      ])].sort()
      // Only the current physical operation retains this immutable name list, never a global map.
      const workspace = project.workspace
      return () => runtimeDigest(JSON.stringify(authority(workspace, names)))
    },
    inputIdentity(project: ProjectRuntimeInputScope, root: string): string {
      const metadata = readPluginManifest(root)?.manifest
      if (!metadata) throw Error("PROJECT_INPUT_SOURCE_MISSING")
      const own = manager.getRuntimeSourceFacts(source(project, root))
      if (packageUsesSharedMods(root, metadata) && !own)
        throw Error("PROJECT_INPUT_SOURCE_NOT_PREPARED")
      // Stage preparation and every subsequent input fence validate the original effective
      // configuration, including required fields/secrets/schema, before making a receipt.
      manager.assertRuntimeSourceConfiguration(source(project, root))
      const lock = readProjectActionLock(root, project.manifest)
      const names = [
        ...new Set([...(own ? [own.name] : []), ...lock.bindings.map((item) => item.ref.plugin)])
      ].sort()
      const config = names.map((name) => ({
        name,
        ...manager.readUserConfigIdentity(project.workspace, name)
      }))
      const context = readPackageExtensionContract(root)?.context
      let knowledge: string | undefined
      let boundKnowledge: string | undefined
      let mutableContext: string | undefined
      if (context?.knowledge.binding) {
        const key = context.knowledge.binding
        const field =
          own?.userConfig && Object.hasOwn(own.userConfig, key) ? own.userConfig[key] : undefined
        if (!own || !field || field.type !== "directory" || field.sensitive || field.multiple)
          throw Error("PROJECT_KNOWLEDGE_BINDING_INVALID")
        const value =
          manager.readUserConfigDirectoryIdentity(project.workspace, own.name, key) ?? field.default
        if (value !== undefined && value !== "") {
          if (typeof value !== "string") throw Error("PROJECT_KNOWLEDGE_BINDING_INVALID")
          knowledge = fingerprintProjectKnowledge(value, context.knowledge.required)
          boundKnowledge = runtimeDirectory(value)
        } else if (context.knowledge.required && !context.provider?.entry)
          throw Error("PROJECT_KNOWLEDGE_REQUIRED")
      }
      if (context?.provider?.entry) {
        if (!host.contextDataRoot || !metadata.version)
          throw Error("PROJECT_KNOWLEDGE_ROOT_UNAVAILABLE")
        const board = readRuntimeScopedFile(root, "board_core/board_config.json", 262_144)
        if (!board.bytes) throw Error("PROJECT_KNOWLEDGE_SOURCE_MISSING")
        const key = extensionContextStorageKey(
          { name: metadata.name, version: metadata.version },
          board.bytes,
          context,
          boundKnowledge
        )
        const data = join(host.contextDataRoot, key)
        if (!boundKnowledge)
          knowledge = fingerprintProjectKnowledge(
            join(data, "knowledge"),
            context.knowledge.required
          )
        const original = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(board.bytes))
        let mutable = original.supported_deploy_units ?? null
        if (existsSync(data)) {
          const configuration = readRuntimeScopedFile(data, "board_config.json", 262_144)
          if (configuration.bytes) {
            const current = JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(configuration.bytes)
            )
            if (Array.isArray(current.supported_deploy_units))
              mutable = current.supported_deploy_units
          }
        }
        mutableContext = runtimeDigest(JSON.stringify(mutable))
      }
      return runtimeDigest(
        JSON.stringify({
          schemaVersion: 1,
          source: own?.digest ?? project.pluginDigest,
          config,
          rules: host.rules(project.workspace, names),
          knowledge: knowledge ?? null,
          mutableContext: mutableContext ?? null
        })
      )
    }
  }
}
