import { existsSync, opendirSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
import type { ProjectRuntimeContextMaterials, ProjectRuntimeInputScope } from "../project-action-runtime"
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
  HOST_CONTEXT_MATERIAL_ROOT_LIMIT,
  type ExtensionContextContract
} from "../../../shared/project-runtime/extension-contract"
import type { HarnessHostFeatureInputs } from "../../../shared/project-runtime/host-types"
import { isSensitiveProjectMaterialName } from "../../mods/v2/project-context-scope"
import {
  probeRuntimeScopedFile,
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

const KNOWLEDGE_FILE_LIMIT = 16 * 1024 * 1024
const KNOWLEDGE_METADATA_ENTRIES_PER_TURN = 16
const KNOWLEDGE_METADATA_MS_PER_TURN = 8
type KnowledgeBudget = { entries: number; bytes: number }

function* directoryEntries(parent: string) {
  const directory = opendirSync(parent)
  try {
    for (let item = directory.readSync(); item; item = directory.readSync()) yield item
  } finally {
    directory.closeSync()
  }
}

/** Hash actual declared knowledge bytes. No content or local path is returned across IPC. */
export function fingerprintProjectKnowledge(directory: string, required = false): string {
  return fingerprintKnowledgeRoot(directory, required)
}

function fingerprintKnowledgeRoot(
  directory: string,
  required: boolean,
  materialBudget?: KnowledgeBudget
): string {
  const scan = observeKnowledgeRoot(directory, required, materialBudget)
  let current = scan.next()
  while (!current.done) current = scan.next()
  return current.value
}

function* observeKnowledgeRoot(
  directory: string,
  required: boolean,
  materialBudget?: KnowledgeBudget,
  metadataOnly = false
): Generator<void, string> {
  if (!materialBudget && !required && !existsSync(directory))
    return runtimeDigest("empty-knowledge/v1")
  const root = runtimeDirectory(directory)
  const files: Array<[string, string]> = []
  const budget = materialBudget ?? { entries: 0, bytes: 0 }
  const bytesAtStart = budget.bytes
  function* visit(relative: string, depth: number): Generator<void> {
    if (depth > 16) throw Error("PROJECT_KNOWLEDGE_LIMIT")
    const parent = join(root, relative)
    // A selected directory is an explicit read boundary. Do not follow directory symlinks.
    if (metadataOnly) runtimeDirectory(parent)
    else files.push([relative || ".", runtimeDirectoryIdentity(parent)])
    const entries = metadataOnly ? directoryEntries(parent) :
      readdirSync(parent, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    for (const item of entries) {
      if (++budget.entries > 4096) throw Error("PROJECT_KNOWLEDGE_LIMIT")
      if (metadataOnly) yield
      if (materialBudget && isSensitiveProjectMaterialName(item.name)) continue
      const path = relative ? `${relative}/${item.name}` : item.name
      if (item.isDirectory()) yield* visit(path, depth + 1)
      else {
        if (!item.isFile() || item.isSymbolicLink()) throw Error("PROJECT_KNOWLEDGE_UNSAFE")
        const file = metadataOnly
          ? probeRuntimeScopedFile(root, path)
          : readRuntimeScopedFile(root, path, KNOWLEDGE_FILE_LIMIT)
        const size = file.bytes?.length ?? file.size
        if (size === undefined) throw Error("PROJECT_KNOWLEDGE_CHANGED")
        if (size > KNOWLEDGE_FILE_LIMIT) throw Error("PROJECT_KNOWLEDGE_LIMIT")
        budget.bytes += size
        if (budget.bytes > 32 * 1024 * 1024) throw Error("PROJECT_KNOWLEDGE_LIMIT")
        if (!metadataOnly) files.push([path, file.fingerprint])
      }
    }
  }
  yield* visit("", 0)
  if (budget.bytes === bytesAtStart) {
    if (required) throw Error("PROJECT_KNOWLEDGE_REQUIRED")
    if (!materialBudget) return runtimeDigest("empty-knowledge/v1")
  }
  return runtimeDigest(JSON.stringify(files))
}

export function fingerprintHarnessFeatureKnowledge(
  inputs: HarnessHostFeatureInputs,
  required: boolean
): string {
  const budget = { entries: 0, bytes: 0 }
  const roots = inputs.knowledgeRoots.map(root => [
    root.id, fingerprintKnowledgeRoot(root.path, false, budget)
  ])
  if (required && !budget.bytes) throw Error("PROJECT_KNOWLEDGE_REQUIRED")
  return runtimeDigest(JSON.stringify({ selectedDeployUnits: inputs.selectedDeployUnits, roots }))
}

/** Keep the first-start metadata inspection bounded per turn. Commit fences use the real bytes. */
export async function assertHarnessFeatureKnowledgeAvailable(
  inputs: HarnessHostFeatureInputs,
  required: boolean
): Promise<void> {
  const budget = { entries: 0, bytes: 0 }
  let entries = 0
  let startedAt = performance.now()
  for (const root of inputs.knowledgeRoots) {
    for (const _ of observeKnowledgeRoot(root.path, false, budget, true)) {
      if (++entries < KNOWLEDGE_METADATA_ENTRIES_PER_TURN &&
        performance.now() - startedAt < KNOWLEDGE_METADATA_MS_PER_TURN) continue
      await setImmediate()
      entries = 0
      startedAt = performance.now()
    }
  }
  if (required && !budget.bytes) throw Error("PROJECT_KNOWLEDGE_REQUIRED")
}

/** Bound roots must stay the exact read copies chosen in the existing UAT project form. */
export function assertHarnessFeatureMaterialInputs(
  inputs: HarnessHostFeatureInputs,
  context: ExtensionContextContract | undefined,
  requireInitialIdentity = false
): void {
  const materials = context?.provider?.materials
  if (
    !context || !materials?.featureInputs ||
    !inputs.selectedDeployUnits.length ||
    (context.knowledge.required && !inputs.knowledgeRoots.length) ||
    inputs.knowledgeRoots.length +
      materials.roots.filter(root => root.source === "package").length > HOST_CONTEXT_MATERIAL_ROOT_LIMIT
  )
    throw Error("PROJECT_HOST_FEATURE_INPUTS_INVALID")
  if (!requireInitialIdentity) return
  for (const root of inputs.knowledgeRoots) {
    try {
      if (runtimeDirectoryIdentity(root.path) === root.identity) continue
    } catch {
      // The read copy was moved, removed or replaced.
    }
    throw Error("PROJECT_KNOWLEDGE_ROOT_CHANGED")
  }
}

/** Reads existing native configuration, source and rule stores. */
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
      const featureInputs = project.harnessFeatureInputs
      if (featureInputs) assertHarnessFeatureMaterialInputs(featureInputs, context)
      const key = context.knowledge.binding
      const field = !featureInputs && key && facts.userConfig?.[key]
      const selected = key && field && field.type === "directory" && !field.multiple && !field.sensitive
        ? manager.readUserConfigDirectoryIdentity(project.workspace, facts.name, key) : undefined
      const roots = materials.roots.flatMap<ProjectRuntimeContextMaterials["roots"][number]>(
        (material) => {
          if (material.source === "knowledge" && featureInputs) {
            return featureInputs.knowledgeRoots.map((bound, index) => ({
              id: material.id + "-" + (index + 1),
              path: bound.path,
              identity: runtimeDirectoryIdentity(bound.path),
              source: "knowledge"
            }))
          }
          const base = material.source === "package" ? root : selected
          if (!base) throw Error("PROJECT_KNOWLEDGE_BINDING_INVALID")
          const canonical = runtimeDirectory(base)
          const path = material.path ? runtimeDirectory(join(canonical, material.path)) : canonical
          return [{ id: material.id, path, source: material.source }]
        }
      )
      const configuration = manager.readRuntimePublicConfiguration(
        input,
        featureInputs
          ? materials.configuration.filter(key =>
              key !== "selectedDeployUnits" || facts.userConfig?.[key]?.required === true
            )
          : materials.configuration
      )
      return {
        roots,
        configuration,
        ...(featureInputs
          ? { featureInputs: { selectedDeployUnits: [...featureInputs.selectedDeployUnits] } }
          : {})
      }
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
      const featureInputs = project.harnessFeatureInputs
      if (featureInputs) {
        assertHarnessFeatureMaterialInputs(featureInputs, context)
        knowledge = fingerprintHarnessFeatureKnowledge(featureInputs, context?.knowledge.required === true)
      } else if (context?.knowledge.binding) {
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
