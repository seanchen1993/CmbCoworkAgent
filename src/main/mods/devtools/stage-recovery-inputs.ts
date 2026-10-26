import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, writeFileSync, renameSync, rmSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import type { ModObject } from "../../../shared/mods/types"
import type { HostSkillExecutionContext } from "../../harness-board/project-runtime/host-service"
import type { FunctionModsManager } from "../v2/manager"
import { readPackageExtensionContract } from "../../plugins/extension-contract"
import { readPluginManifest } from "../../plugins/manifest"
import { extensionContextStorageKey } from "../../harness-board/extension-context"
import { fingerprintProjectKnowledge } from "../../harness-board/project-runtime/package-input-identity"
import {
  readRuntimeScopedFile,
  runtimeDigest,
  runtimeDirectory,
  runtimeDirectoryIdentity
} from "../../harness-board/project-runtime/safe-files"
import {
  registerProjectRecoveryContextResolver,
  type ProjectRecoveryContext
} from "../../harness-board/project-runtime/recovery-context"
import { normalizeWorkspacePathKey } from "../../../shared/workspace-path"
import { resolveFunctionUserConfig } from "../../../shared/mods/v2/user-config"

export interface StageRecoveryInputSnapshot {
  schemaVersion: 1
  id: string
  digest: string
}
/** Main-owned immutable package/workspace authority, independent of a particular state owner. */
export interface NativeStageRecoverySource {
  sourceId: string
  workspace: string
  packageRoot: string
  packageId: string
  packageVersion: string
  inputIdentity: string
  /** Explicit native callers may retain a bare package's authority without inventing inputs. */
  retainAuthority?: true
  guard(): void
  /** Optional full content fence, separate from authority checks at every IO boundary. */
  assertInputsCurrent?(): void
}
type Configuration = NonNullable<
  Awaited<ReturnType<FunctionModsManager["captureStageRecoveryConfiguration"]>>
>
type Target = {
  projectId: string
  workspace: string
  installedPluginId: string
  packageRoot: string
}
export interface StageRecoveryInputAdapter {
  capture(
    context: HostSkillExecutionContext & { inputIdentity: string }
  ): Promise<StageRecoveryInputSnapshot | undefined>
  assertCurrent(snapshot: StageRecoveryInputSnapshot, guard: () => void): Promise<void>
  bind(snapshot: StageRecoveryInputSnapshot, target: Target, guard: () => void): Promise<void>
  branchReadOnlyRoots(projectId: string): readonly string[]
  assertBranchCurrent(projectId: string): void
  prepareProviderInputs?(
    snapshot: StageRecoveryInputSnapshot,
    guard: () => void
  ): Promise<ProjectRecoveryContext>
}
interface Record {
  version: 1
  id: string
  source: {
    projectId: string
    workspace: string
    workspaceIdentity: string
    packageId: string
    packageVersion: string
    sourceRoot: string
    inputIdentity: string
  }
  configuration?: Configuration
  knowledge?: {
    source: string
    sourceFingerprint: string
    contentDigest: string
    required: boolean
    binding?: string
  }
  context?: { sourceData: string; mutableDigest: string; board: ModObject }
  providerContext?: true
}
interface Binding {
  version: 1
  snapshot: StageRecoveryInputSnapshot
  target: Target
  workspaceIdentity: string
  phase: "binding" | "bound"
  configurationIdentity?: ReturnType<FunctionModsManager["readUserConfigIdentity"]>
}
function fail(code: string): never {
  throw Error(`PROJECT_STAGE_RECOVERY_${code}`)
}
const digest = (value: unknown) => runtimeDigest(JSON.stringify(value))
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Private inputs only. Public stage metadata contains an opaque ID/digest, never config values. */
export class StageRecoveryInputs implements StageRecoveryInputAdapter {
  private readonly root: string
  private readonly rootIdentity: string
  private readonly bindings = new Map<string, Binding>()
  private readonly bindingBusy = new Set<string>()
  private readonly unregister: () => void
  constructor(
    private readonly deps: {
      root: string
      contextDataRoot: string
      normalizeConfigurationWorkspace?: (workspace: string) => string
      manager: Pick<
        FunctionModsManager,
        | "captureStageRecoveryConfiguration"
        | "assertStageRecoveryConfiguration"
        | "bindStageRecoveryConfiguration"
        | "stageRecoveryConfigurationMatches"
        | "readUserConfigIdentity"
      >
    }
  ) {
    mkdirSync(deps.root, { recursive: true, mode: 0o700 })
    this.root = runtimeDirectory(deps.root)
    this.rootIdentity = runtimeDirectoryIdentity(this.root)
    mkdirSync(join(this.root, "bindings"), { recursive: true, mode: 0o700 })
    const names = readdirSync(join(this.root, "bindings"))
    if (names.length > 128) fail("LIMIT")
    for (const name of names) {
      if (/^[a-f0-9]{64}$/.test(name)) {
        runtimeDirectory(join(this.root, "bindings", name))
        continue
      }
      if (!/^[a-f0-9]{64}\.json$/.test(name)) fail("BINDING_INVALID")
      const binding = this.readJson(`bindings/${name}`) as unknown as Binding
      this.validateBinding(binding)
      this.bindings.set(binding.target.projectId, binding)
    }
    this.unregister = registerProjectRecoveryContextResolver((workspace, plugin) => {
      for (const binding of this.bindings.values()) {
        if (
          normalizeWorkspacePathKey(binding.target.workspace) !==
          normalizeWorkspacePathKey(workspace)
        )
          continue
        const record = this.read(binding.snapshot)
        if (
          record.source.packageId !== plugin.name ||
          record.source.packageVersion !== plugin.version
        )
          fail("BINDING_CHANGED")
        if (!record.context && !record.providerContext) return undefined
        const context = join(this.root, "bindings", digest(binding.target.projectId))
        return {
          directory: context,
          ...(record.configuration ? { configuration: this.providerConfiguration(record) } : {}),
          ...(record.knowledge
            ? {
                knowledgeRoot: join(this.root, record.id, "knowledge")
              }
            : {}),
          assertCurrent: () => this.assertBranchCurrent(binding.target.projectId)
        }
      }
      return undefined
    })
  }
  close() {
    this.unregister()
  }
  private assertRoot() {
    if (runtimeDirectoryIdentity(this.root) !== this.rootIdentity) fail("ROOT_CHANGED")
  }
  private configurationWorkspace(workspace: string): string {
    return this.deps.normalizeConfigurationWorkspace?.(workspace) ?? workspace
  }
  /** Main-only facts identity; private snapshot allocation is deliberately excluded. */
  identity(snapshot: StageRecoveryInputSnapshot): string {
    const record = this.read(snapshot)
    return digest({
      version: record.version,
      source: record.source,
      configuration: record.configuration,
      knowledge: record.knowledge,
      context: record.context,
      providerContext: record.providerContext
    })
  }
  private readJson(path: string): ModObject {
    this.assertRoot()
    const file = readRuntimeScopedFile(this.root, path, 2 * 1024 * 1024)
    if (!file.bytes) fail("RECORD_MISSING")
    try {
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes))
      if (!value || typeof value !== "object" || Array.isArray(value)) fail("RECORD_INVALID")
      return value as ModObject
    } catch {
      return fail("RECORD_INVALID")
    }
  }
  private read(pointer: StageRecoveryInputSnapshot): Record {
    if (
      !pointer ||
      pointer.schemaVersion !== 1 ||
      !/^[a-f0-9-]{36}$/.test(pointer.id) ||
      !/^[a-f0-9]{64}$/.test(pointer.digest)
    )
      fail("REFERENCE_INVALID")
    const value = this.readJson(`${pointer.id}/record.json`)
    if (digest(value) !== pointer.digest) fail("RECORD_CHANGED")
    const record = value as unknown as Record
    if (
      record.version !== 1 ||
      record.id !== pointer.id ||
      !record.source ||
      typeof record.source.sourceRoot !== "string" ||
      typeof record.source.workspace !== "string"
    )
      fail("RECORD_INVALID")
    return record
  }
  private validateBinding(binding: Binding) {
    if (
      !binding ||
      binding.version !== 1 ||
      !binding.target ||
      typeof binding.target.projectId !== "string" ||
      !binding.target.projectId ||
      typeof binding.target.workspace !== "string" ||
      !["binding", "bound"].includes(binding.phase)
    )
      fail("BINDING_INVALID")
    this.read(binding.snapshot)
  }
  private saveBinding(binding: Binding) {
    this.assertRoot()
    const path = join(this.root, "bindings", `${digest(binding.target.projectId)}.json`)
    const temporary = join(this.root, `binding-${randomUUID()}.tmp`)
    writeFileSync(temporary, JSON.stringify(binding), { flag: "wx", mode: 0o600 })
    renameSync(temporary, path)
    this.bindings.set(binding.target.projectId, structuredClone(binding))
  }
  private content(root: string): string {
    runtimeDirectory(root)
    const files: Array<[string, string]> = []
    let bytes = 0,
      count = 0
    const walk = (base: string, depth: number) => {
      if (depth > 16) fail("KNOWLEDGE_LIMIT")
      runtimeDirectory(join(root, base))
      files.push([`${base}/`, "directory"])
      for (const entry of readdirSync(join(root, base), { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name)
      )) {
        if (++count > 4096 || entry.isSymbolicLink()) fail("KNOWLEDGE_LIMIT")
        const path = base ? `${base}/${entry.name}` : entry.name
        if (entry.isDirectory()) walk(path, depth + 1)
        else {
          if (!entry.isFile()) fail("KNOWLEDGE_UNSAFE")
          const file = readRuntimeScopedFile(root, path, 16 * 1024 * 1024)
          if (!file.bytes || (bytes += file.bytes.length) > 32 * 1024 * 1024)
            fail("KNOWLEDGE_LIMIT")
          files.push([path, runtimeDigest(file.bytes)])
        }
      }
    }
    walk("", 0)
    return digest(files)
  }
  private copyKnowledge(source: string, target: string, guard: () => void) {
    mkdirSync(target, { mode: 0o700 })
    if (!existsSync(source)) return
    this.content(source)
    let count = 0,
      bytes = 0
    const walk = (base: string, depth: number) => {
      guard()
      if (depth > 16) fail("KNOWLEDGE_LIMIT")
      for (const entry of readdirSync(join(source, base), { withFileTypes: true })) {
        if (++count > 4096 || entry.isSymbolicLink()) fail("KNOWLEDGE_LIMIT")
        const path = base ? `${base}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          runtimeDirectory(join(source, path))
          mkdirSync(join(target, path), { mode: 0o700 })
          walk(path, depth + 1)
        } else {
          const file = readRuntimeScopedFile(source, path, 16 * 1024 * 1024)
          if (!file.bytes || (bytes += file.bytes.length) > 32 * 1024 * 1024)
            fail("KNOWLEDGE_LIMIT")
          writeFileSync(join(target, path), file.bytes, { flag: "wx", mode: 0o600 })
        }
      }
    }
    walk("", 0)
    guard()
    if (this.content(source) !== this.content(target)) fail("KNOWLEDGE_CHANGED")
  }
  private mutable(record: Record): string {
    if (!record.context) return digest(null)
    const original = record.context.board.supported_deploy_units ?? null
    if (!existsSync(record.context.sourceData)) return digest(original)
    const file = readRuntimeScopedFile(record.context.sourceData, "board_config.json", 262144)
    if (!file.bytes) return digest(original)
    try {
      const current = JSON.parse(file.bytes.toString("utf8")) as {
        supported_deploy_units?: unknown
      }
      return digest(
        Array.isArray(current.supported_deploy_units) ? current.supported_deploy_units : original
      )
    } catch {
      return fail("CONTEXT_INVALID")
    }
  }
  async capture(context: HostSkillExecutionContext & { inputIdentity: string }) {
    return this.captureOwnedProject({
      sourceId: context.project.projectId,
      workspace: context.project.workspace,
      packageRoot: context.snapshotRoot,
      packageId: context.project.packageId,
      packageVersion: context.project.packageVersion,
      inputIdentity: context.inputIdentity,
      guard: () => {
        context.signal.throwIfAborted()
        if (context.assertAuthorityCurrent) context.assertAuthorityCurrent()
        else context.assertInputsCurrent?.()
      },
      assertInputsCurrent: context.assertInputsCurrent
    })
  }
  async captureOwnedProject(input: NativeStageRecoverySource) {
    const guard = () => {
      input.guard()
      this.assertRoot()
    }
    guard()
    input.assertInputsCurrent?.()
    const config = await this.deps.manager.captureStageRecoveryConfiguration(
      this.configurationWorkspace(input.workspace),
      input.packageRoot,
      guard
    )
    guard()
    if (!config) {
      const manifest = readPluginManifest(input.packageRoot)
      const raw = manifest && readRuntimeScopedFile(input.packageRoot, manifest.relPath, 262144)
      let declared: ModObject | undefined
      try {
        declared = raw?.bytes ? (JSON.parse(raw.bytes.toString("utf8")) as ModObject) : undefined
      } catch {
        return fail("CONFIGURATION_INVALID")
      }
      if (
        declared &&
        (Object.hasOwn(declared, "userConfig") || Object.hasOwn(declared, "userConfigSchema"))
      )
        fail("CONFIGURATION_UNSUPPORTED")
    }
    const contract = readPackageExtensionContract(input.packageRoot)?.context
    if (!config && !contract && !input.retainAuthority) return undefined
    if (readdirSync(this.root).filter((name) => /^[a-f0-9-]{36}$/.test(name)).length >= 32)
      fail("LIMIT")
    const id = randomUUID()
    const directory = join(this.root, id)
    mkdirSync(directory, { mode: 0o700 })
    const directoryIdentity = runtimeDirectoryIdentity(directory)
    let completed = false
    try {
      const record: Record = {
        version: 1,
        id,
        source: {
          projectId: input.sourceId,
          workspace: input.workspace,
          workspaceIdentity: runtimeDirectoryIdentity(input.workspace),
          packageId: input.packageId,
          packageVersion: input.packageVersion,
          sourceRoot: input.packageRoot,
          inputIdentity: input.inputIdentity
        },
        ...(config ? { configuration: config } : {})
      }
      let knowledge: string | undefined
      if (contract?.knowledge.binding) {
        const key = contract.knowledge.binding
        const schema = config?.configuration.schema
        const field = schema && Object.hasOwn(schema, key) ? schema[key] : undefined
        if (!field || field.type !== "directory" || field.sensitive || field.multiple)
          fail("KNOWLEDGE_BINDING_INVALID")
        const value = config!.configuration.record.values[key] ?? field.default
        if (value !== undefined && value !== "") {
          if (typeof value !== "string") fail("KNOWLEDGE_BINDING_INVALID")
          knowledge = value as string
        }
      }
      if (contract?.provider?.materials) record.providerContext = true
      if (contract?.provider?.entry) {
        const board = readRuntimeScopedFile(
          input.packageRoot,
          "board_core/board_config.json",
          262144
        )
        record.providerContext = true
        if (board.bytes) {
          const metadata = readPluginManifest(input.packageRoot)?.manifest
          if (!metadata?.version) fail("CONTEXT_INVALID")
          const key = extensionContextStorageKey(
            { name: metadata.name, version: metadata.version },
            board.bytes,
            contract,
            knowledge
          )
          const sourceData = join(this.deps.contextDataRoot, key)
          let original: ModObject
          try {
            original = JSON.parse(board.bytes.toString("utf8")) as ModObject
          } catch {
            return fail("CONTEXT_INVALID")
          }
          record.context = { sourceData, mutableDigest: "", board: original }
          record.context.mutableDigest = this.mutable(record)
          const cached = existsSync(sourceData)
            ? readRuntimeScopedFile(sourceData, "board_config.json", 262144)
            : { bytes: undefined }
          if (cached.bytes) {
            let parsed: ModObject
            try {
              parsed = JSON.parse(cached.bytes.toString("utf8")) as ModObject
            } catch {
              return fail("CONTEXT_INVALID")
            }
            if (Array.isArray(parsed.supported_deploy_units))
              record.context.board.supported_deploy_units = parsed.supported_deploy_units
          }
          if (!knowledge) knowledge = join(sourceData, "knowledge")
        }
      }
      if (knowledge) {
        const sourceFingerprint = fingerprintProjectKnowledge(
          knowledge,
          contract?.knowledge.required
        )
        this.copyKnowledge(knowledge, join(this.root, id, "knowledge"), guard)
        record.knowledge = {
          source: knowledge,
          sourceFingerprint,
          contentDigest: this.content(join(this.root, id, "knowledge")),
          required: contract?.knowledge.required ?? false,
          ...(contract?.knowledge.binding ? { binding: contract.knowledge.binding } : {})
        }
      } else if (contract?.knowledge.required) fail("KNOWLEDGE_REQUIRED")
      guard()
      if (config) this.deps.manager.assertStageRecoveryConfiguration(config)
      input.assertInputsCurrent?.()
      const pointer = { schemaVersion: 1 as const, id, digest: digest(record) }
      writeFileSync(join(this.root, id, "record.json"), JSON.stringify(record), {
        flag: "wx",
        mode: 0o600
      })
      await this.assertCurrent(pointer, guard)
      input.assertInputsCurrent?.()
      completed = true
      return pointer
    } finally {
      if (!completed) {
        try {
          this.assertRoot()
          if (
            dirname(resolve(directory)) !== this.root ||
            runtimeDirectoryIdentity(directory) !== directoryIdentity
          )
            fail("ROOT_CHANGED")
          rmSync(directory, { recursive: true })
        } catch {
          /* Preserve the original failure; never clean a replaced directory. */
        }
      }
    }
  }
  async assertCurrent(snapshot: StageRecoveryInputSnapshot, guard: () => void) {
    guard()
    const record = this.read(snapshot)
    if (runtimeDirectoryIdentity(record.source.workspace) !== record.source.workspaceIdentity)
      fail("SOURCE_CHANGED")
    if (record.configuration) {
      const fresh = await this.deps.manager.captureStageRecoveryConfiguration(
        this.configurationWorkspace(record.source.workspace),
        record.configuration.sourceRoot,
        guard
      )
      guard()
      if (!same(fresh, record.configuration)) fail("CONFIGURATION_CHANGED")
      this.deps.manager.assertStageRecoveryConfiguration(record.configuration)
    }
    if (
      record.knowledge &&
      (fingerprintProjectKnowledge(record.knowledge.source, record.knowledge.required) !==
        record.knowledge.sourceFingerprint ||
        this.content(join(this.root, record.id, "knowledge")) !== record.knowledge.contentDigest)
    )
      fail("KNOWLEDGE_CHANGED")
    if (record.context && this.mutable(record) !== record.context.mutableDigest)
      fail("CONTEXT_CHANGED")
    guard()
  }
  /** Main-only frozen input for the first trial; creates no binding, grant or config override. */
  async prepareProviderInputs(
    snapshot: StageRecoveryInputSnapshot,
    guard: () => void
  ): Promise<ProjectRecoveryContext> {
    await this.assertCurrent(snapshot, guard)
    const record = this.read(snapshot)
    const directory = join(this.root, record.id, "provider-inputs")
    if (!existsSync(directory)) {
      mkdirSync(directory, { mode: 0o700 })
      if (record.context)
        writeFileSync(join(directory, "board_config.json"), JSON.stringify(record.context.board), {
          flag: "wx",
          mode: 0o600
        })
    }
    const names = readdirSync(directory).sort()
    if (!same(names, record.context ? ["board_config.json"] : [])) fail("CONTEXT_CHANGED")
    if (record.context) {
      const board = readRuntimeScopedFile(directory, "board_config.json", 262144)
      if (!board.bytes || board.bytes.toString("utf8") !== JSON.stringify(record.context.board))
        fail("CONTEXT_CHANGED")
    }
    const expected = this.content(directory)
    const assertCurrent = () => {
      guard()
      this.read(snapshot)
      if (runtimeDirectoryIdentity(record.source.workspace) !== record.source.workspaceIdentity)
        fail("SOURCE_CHANGED")
      if (record.configuration)
        this.deps.manager.assertStageRecoveryConfiguration(record.configuration)
      if (
        record.knowledge &&
        (fingerprintProjectKnowledge(record.knowledge.source, record.knowledge.required) !==
          record.knowledge.sourceFingerprint ||
          this.content(join(this.root, record.id, "knowledge")) !== record.knowledge.contentDigest)
      )
        fail("KNOWLEDGE_CHANGED")
      if (record.context && this.mutable(record) !== record.context.mutableDigest)
        fail("CONTEXT_CHANGED")
      if (this.content(directory) !== expected) fail("CONTEXT_CHANGED")
    }
    assertCurrent()
    return {
      directory,
      ...(record.configuration ? { configuration: this.providerConfiguration(record) } : {}),
      ...(record.knowledge ? { knowledgeRoot: join(this.root, record.id, "knowledge") } : {}),
      assertCurrent
    }
  }
  private overrides(record: Record): ModObject {
    const binding =
      record.knowledge?.binding ??
      readPackageExtensionContract(record.source.sourceRoot)?.context?.knowledge.binding
    return binding && record.knowledge ? { [binding]: join(this.root, record.id, "knowledge") } : {}
  }
  private providerConfiguration(record: Record): ModObject {
    const saved = record.configuration?.configuration
    if (!saved) return {}
    // Resolving a filtered schema preserves native defaults and list/type validation, while
    // confidential fields are never decoded, returned or replaced by their secret defaults.
    const schema = Object.fromEntries(
      Object.entries(saved.schema).filter(([, field]) => !field.sensitive)
    )
    const result = resolveFunctionUserConfig(schema, saved.record.values)
    const binding = record.knowledge?.binding
    if (binding && Object.hasOwn(schema, binding)) {
      const field = schema[binding]
      if (field.type !== "directory" || field.multiple) fail("KNOWLEDGE_BINDING_INVALID")
      result[binding] = join(this.root, record.id, "knowledge")
    }
    return result
  }
  async bind(snapshot: StageRecoveryInputSnapshot, target: Target, guard: () => void) {
    if (this.bindingBusy.has(target.projectId)) fail("BUSY")
    this.bindingBusy.add(target.projectId)
    try {
      await this.assertCurrent(snapshot, guard)
      const record = this.read(snapshot)
      if (
        normalizeWorkspacePathKey(target.workspace) ===
        normalizeWorkspacePathKey(record.source.workspace)
      )
        fail("TARGET_INVALID")
      const previous = this.bindings.get(target.projectId)
      if (previous && (!same(previous.snapshot, snapshot) || !same(previous.target, target)))
        fail("BINDING_CHANGED")
      if (previous?.phase === "bound") {
        this.assertBranchCurrent(target.projectId)
        return
      }
      if (
        !previous &&
        record.configuration &&
        this.deps.manager.readUserConfigIdentity(
          this.configurationWorkspace(target.workspace),
          record.configuration.configuration.plugin
        ).savedRevision !== 0
      )
        fail("TARGET_CONFIGURATION_EXISTS")
      const binding: Binding = {
        version: 1,
        snapshot,
        target: structuredClone(target),
        workspaceIdentity: runtimeDirectoryIdentity(target.workspace),
        phase: "binding"
      }
      this.saveBinding(binding)
      if (record.context || record.providerContext) {
        const directory = join(this.root, "bindings", digest(target.projectId))
        if (!existsSync(directory)) {
          mkdirSync(directory, { mode: 0o700 })
          if (record.context)
            writeFileSync(
              join(directory, "board_config.json"),
              JSON.stringify(record.context.board),
              { flag: "wx", mode: 0o600 }
            )
        }
      }
      guard()
      if (record.configuration) {
        const overrides = this.overrides(record)
        if (
          previous?.phase !== "binding" ||
          !this.deps.manager.stageRecoveryConfigurationMatches(
            record.configuration,
            this.configurationWorkspace(target.workspace),
            overrides
          )
        )
          await this.deps.manager.bindStageRecoveryConfiguration(
            record.configuration,
            { ...target, workspace: this.configurationWorkspace(target.workspace) },
            overrides,
            guard
          )
        guard()
        binding.configurationIdentity = this.deps.manager.readUserConfigIdentity(
          this.configurationWorkspace(target.workspace),
          record.configuration.configuration.plugin
        )
      }
      await this.assertCurrent(snapshot, guard)
      binding.phase = "bound"
      this.saveBinding(binding)
      this.assertBranchCurrent(target.projectId)
    } finally {
      this.bindingBusy.delete(target.projectId)
    }
  }
  /** Recover a native publication whose caller's reply was lost, without replacing its inputs. */
  async bindOwnedEquivalent(
    snapshot: StageRecoveryInputSnapshot,
    target: Target,
    guard: () => void
  ): Promise<void> {
    await this.assertCurrent(snapshot, guard)
    const previous = this.bindings.get(target.projectId)
    if (!previous || same(previous.snapshot, snapshot)) {
      await this.bind(snapshot, target, guard)
      return
    }
    if (
      !same(previous.target, target) ||
      this.identity(previous.snapshot) !== this.identity(snapshot)
    )
      fail("BINDING_CHANGED")
    await this.assertCurrent(previous.snapshot, guard)
    await this.assertCurrent(snapshot, guard)
    // The strict binding path validates an already-published target (or reconciles the
    // original pending native write). Keep its original private knowledge directory.
    await this.bind(previous.snapshot, target, guard)
  }
  assertBranchCurrent(projectId: string) {
    this.assertRoot()
    const binding = this.bindings.get(projectId)
    if (
      !binding ||
      binding.phase !== "bound" ||
      runtimeDirectoryIdentity(binding.target.workspace) !== binding.workspaceIdentity
    )
      fail("BINDING_CHANGED")
    const record = this.read(binding.snapshot)
    if (
      record.configuration &&
      !same(
        this.deps.manager.readUserConfigIdentity(
          this.configurationWorkspace(binding.target.workspace),
          record.configuration.configuration.plugin
        ),
        binding.configurationIdentity
      )
    )
      fail("CONFIGURATION_CHANGED")
    if (
      record.knowledge &&
      this.content(join(this.root, record.id, "knowledge")) !== record.knowledge.contentDigest
    )
      fail("KNOWLEDGE_CHANGED")
    if (record.context) {
      const path = join(this.root, "bindings", digest(projectId))
      const file = readRuntimeScopedFile(path, "board_config.json", 262144)
      if (!file.bytes) fail("CONTEXT_CHANGED")
      let parsed: ModObject
      try {
        parsed = JSON.parse(file.bytes.toString("utf8")) as ModObject
      } catch {
        return fail("CONTEXT_INVALID")
      }
      if (digest(parsed.supported_deploy_units ?? null) !== record.context.mutableDigest)
        fail("CONTEXT_CHANGED")
    }
  }
  branchReadOnlyRoots(projectId: string): readonly string[] {
    this.assertBranchCurrent(projectId)
    const record = this.read(this.bindings.get(projectId)!.snapshot)
    return record.knowledge ? [join(this.root, record.id, "knowledge")] : []
  }
  /** Published targets own these frozen inputs independently of the old source workspace. */
  targetInputs(projectId: string, guard: () => void) {
    guard()
    this.assertBranchCurrent(projectId)
    const binding = this.bindings.get(projectId)!
    const record = this.read(binding.snapshot)
    const knowledgeRoot = record.knowledge ? join(this.root, record.id, "knowledge") : undefined
    const directory = join(this.root, "bindings", digest(projectId))
    const expectedContext =
      record.context || record.providerContext ? this.content(directory) : undefined
    const assertCurrent = () => {
      guard()
      this.assertBranchCurrent(projectId)
      if (!same(this.bindings.get(projectId), binding)) fail("BINDING_CHANGED")
      if (expectedContext !== undefined && this.content(directory) !== expectedContext)
        fail("CONTEXT_CHANGED")
    }
    assertCurrent()
    return {
      inputsDigest: this.identity(binding.snapshot),
      readOnlyRoots: [
        ...(expectedContext !== undefined ? [directory] : []),
        ...(knowledgeRoot ? [knowledgeRoot] : [])
      ],
      ...(expectedContext !== undefined
        ? {
            providerInput: {
              directory,
              ...(knowledgeRoot ? { knowledgeRoot } : {}),
              ...(record.configuration
                ? { configuration: this.providerConfiguration(record) }
                : {}),
              assertCurrent
            } satisfies ProjectRecoveryContext
          }
        : {})
    }
  }
}
