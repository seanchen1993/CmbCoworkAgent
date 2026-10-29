import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { ProjectRuntimeInputScope } from "../project-action-runtime"
import { extensionContextStorageKey } from "../extension-context"
import type { FunctionModsManager } from "../../mods/v2/manager"
import { readPackageExtensionContract } from "../../plugins/extension-contract"
import { readPluginManifest } from "../../plugins/manifest"
import { packageUsesSharedMods } from "./package-preflight"
import { readProjectActionLock } from "./action-input"
import { readProjectRecoveryContext } from "./recovery-context"
import { readDeclaredContextFiles } from "./declared-context-files"
import { readRetainedExecutionResources } from "./execution-resources"
import { parseProjectCheckConfigurationKeys } from "../../../shared/project-runtime/action-bindings"
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
  | "readRuntimePublicConfiguration"
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
    config: names.map((name) => ({ name, ...manager.readUserConfigIdentity(workspace, name) })),
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
  const executionResources = (project: ProjectRuntimeInputScope, root: string) =>
    readRetainedExecutionResources(root, binding => {
      const input = source(project, root)
      manager.assertRuntimeSourceConfiguration(input)
      const facts = manager.getRuntimeSourceFacts(input)
      const field = facts?.userConfig?.[binding]
      if (!facts || !field || field.type !== "directory" || field.sensitive || field.multiple || !field.required)
        throw Error("PROJECT_EXECUTION_WORKSPACE_BINDING_INVALID")
      const value = manager.readUserConfigDirectoryIdentity(project.workspace, facts.name, binding)
      if (typeof value !== "string" || !value) throw Error("PROJECT_EXECUTION_WORKSPACE_REQUIRED")
      return value
    })
  return {
    readExecutionResources: executionResources,
    readPublicConfiguration(project: ProjectRuntimeInputScope, root: string, keys: readonly string[]) {
      const selected = parseProjectCheckConfigurationKeys(keys)
      const input = source(project, root)
      manager.assertRuntimeSourceConfiguration(input)
      const facts = manager.getRuntimeSourceFacts(input)
      if (!facts) throw Error("PROJECT_INPUT_SOURCE_NOT_PREPARED")
      for (const key of selected) {
        const field = facts.userConfig && Object.hasOwn(facts.userConfig, key)
          ? facts.userConfig[key] : undefined
        if (!field || field.sensitive || !["string", "number", "boolean"].includes(field.type))
          throw Error("PROJECT_CHECK_CONFIGURATION_PRIVATE_FIELD")
      }
      return manager.readRuntimePublicConfiguration(input, selected)
    },
    readContextMaterials(project: ProjectRuntimeInputScope, root: string) {
      const context = readPackageExtensionContract(root)?.context
      const materials = context?.provider?.materials
      if (!materials) throw Error("PROJECT_CONTEXT_MATERIALS_REQUIRED")
      const input = source(project, root)
      manager.assertRuntimeSourceConfiguration(input)
      const facts = manager.getRuntimeSourceFacts(input)
      if (!facts) throw Error("PROJECT_INPUT_SOURCE_NOT_PREPARED")
      const key = context.knowledge.binding
      const field = key && facts.userConfig?.[key]
      const selected = key && field && field.type === "directory" && !field.multiple && !field.sensitive
        ? manager.readUserConfigDirectoryIdentity(project.workspace, facts.name, key) : undefined
      const roots = materials.roots.map(material => {
        const base = material.source === "package" ? root : selected
        if (!base) throw Error("PROJECT_KNOWLEDGE_BINDING_INVALID")
        const canonical = runtimeDirectory(base)
        const path = material.path ? runtimeDirectory(join(canonical, material.path)) : canonical
        // runtimeDirectory rejects aliases/symlinks, including a redirected parent segment.
        return { id: material.id, path, source: material.source }
      })
      const configuration = manager.readRuntimePublicConfiguration(input, materials.configuration)
      return { roots, configuration }
    },
    readDeclaredContext(project: ProjectRuntimeInputScope, root: string, stageId: string): string {
      const declaration = readPackageExtensionContract(root)?.context
      if (!declaration?.provider?.files) throw Error("PROJECT_DECLARED_CONTEXT_REQUIRED")
      manager.assertRuntimeSourceConfiguration(source(project, root))
      const facts = manager.getRuntimeSourceFacts(source(project, root))
      const key = declaration.knowledge.binding
      const field = key && facts?.userConfig?.[key]
      if (key && (!facts || !field || field.type !== "directory" || field.sensitive || field.multiple))
        throw Error("PROJECT_KNOWLEDGE_BINDING_INVALID")
      const selected = key && facts
        ? manager.readUserConfigDirectoryIdentity(project.workspace, facts.name, key) : undefined
      const identity = facts ? authority(project.workspace, [facts.name]) : null
      return readDeclaredContextFiles({ context: declaration, snapshotRoot: root,
        knowledgeRoot: typeof selected === "string" && selected ? selected : undefined,
        stageId, assertCurrent: () => {
          manager.assertRuntimeSourceConfiguration(source(project, root))
          if (JSON.stringify(facts ? authority(project.workspace, [facts.name]) : null) !== JSON.stringify(identity))
            throw Error("PROJECT_CONTEXT_CONFIGURATION_CHANGED")
        } })
    },
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
      const names = [
        ...new Set([...(own ? [own.name] : []), ...lock.bindings.map((item) => item.ref.plugin)])
      ].sort()
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
          boundKnowledge = runtimeDirectory(value)
          // Explicit file providers depend on selected documents, not the entire directory.
          // Keep actual byte checks at commit boundaries; metadata-only caches are not evidence.
          if (!context.provider?.files)
            knowledge = fingerprintProjectKnowledge(value, context.knowledge.required)
        } else if (context.knowledge.required && !context.provider?.entry)
          throw Error("PROJECT_KNOWLEDGE_REQUIRED")
      }
      if (context?.provider?.files) {
        const stage = project.stageIndex === undefined ? undefined
          : project.manifest.stages[project.stageIndex]
        knowledge = runtimeDigest(readDeclaredContextFiles({ context, snapshotRoot: root,
          knowledgeRoot: boundKnowledge, stageId: stage?.id, assertCurrent: () => {} }))
      }
      if (context?.provider?.entry) {
        if (!host.contextDataRoot || !metadata.version)
          throw Error("PROJECT_KNOWLEDGE_ROOT_UNAVAILABLE")
        const board = readRuntimeScopedFile(root, "board_core/board_config.json", 262_144)
        if (board.bytes) {
          const key = extensionContextStorageKey(
            { name: metadata.name, version: metadata.version },
            board.bytes,
            context,
            boundKnowledge
          )
          const recovery = readProjectRecoveryContext(project.workspace, {
            name: metadata.name,
            version: metadata.version
          })
          const data = recovery?.directory ?? join(host.contextDataRoot, key)
          if (!boundKnowledge)
            knowledge = fingerprintProjectKnowledge(
              recovery?.knowledgeRoot ?? join(data, "knowledge"),
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
          recovery?.assertCurrent()
        } else {
          // Generic text providers do not imply a legacy board/cache layout.
          const recovery = readProjectRecoveryContext(project.workspace, {
            name: metadata.name,
            version: metadata.version
          })
          if (!boundKnowledge && recovery?.knowledgeRoot)
            knowledge = fingerprintProjectKnowledge(
              recovery.knowledgeRoot,
              context.knowledge.required
            )
          if (context.knowledge.required && knowledge === undefined)
            throw Error("PROJECT_KNOWLEDGE_REQUIRED")
          mutableContext = runtimeDigest("generic-native-context-provider/v1")
          recovery?.assertCurrent()
        }
      }
      return runtimeDigest(
        JSON.stringify({
          schemaVersion: 1,
          source: own?.digest ?? project.pluginDigest,
          config,
          rules: host.rules(project.workspace, names),
          knowledge: knowledge ?? null,
          mutableContext: mutableContext ?? null,
          executionResources: executionResources(project, root)?.fingerprint ?? null
        })
      )
    }
  }
}
