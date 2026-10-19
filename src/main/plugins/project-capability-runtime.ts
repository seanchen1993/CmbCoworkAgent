import { join } from "node:path"
import type { ProjectCompositionSource } from "../../shared/project-runtime/composition"
import type { PluginMetadata } from "../types"
import { readNativeCapabilityCatalog } from "./capability-catalog"
import { RetainedPackageSnapshots } from "../harness-board/project-runtime/package-snapshots"
import {
  readRuntimeScopedFile,
  runtimeRelativePath
} from "../harness-board/project-runtime/safe-files"
import { parseMcpJsonFile, parsePluginHooks } from "../storage"
import { readPluginManifest } from "./manifest"
import { hasAutobizBoardContext } from "./business-adapters/autobiz-package-admission"
import {
  issueRuntimePluginSourceToken,
  extendRuntimePluginSourceToken,
  type RuntimeCapabilitySource,
  type RuntimePluginSourceToken
} from "./runtime-source-scope"

export interface ProjectCapabilityRuntimeIdentity {
  threadId: string
  incarnationKey: string
  projectId: string
  workspace: string
  operationId: string
  sources: readonly RuntimeCapabilitySource[]
  parentPlugin?: PluginMetadata
}

/** Declaration validation and retained copies never themselves authorize a model/tool call. */
export class ProjectCapabilityRuntimeService {
  private snapshots?: RetainedPackageSnapshots
  private readonly admissions = new WeakSet<RuntimeCapabilitySource>()
  private readonly retainedGuards = new Map<string, () => void>()
  constructor(
    private readonly root: string,
    private readonly deps: {
      getPlugin(id: string): PluginMetadata | undefined
      assertCurrent(): void
      readCatalog?: typeof readNativeCapabilityCatalog
    }
  ) {}

  async validate(
    sources: readonly ProjectCompositionSource[],
    signal?: AbortSignal
  ): Promise<RuntimeCapabilitySource[]> {
    if (!Array.isArray(sources) || sources.length === 0 || sources.length > 16)
      throw Error("PROJECT_CAPABILITIES_LIMIT")
    this.deps.assertCurrent()
    const admitted: RuntimeCapabilitySource[] = []
    const seen = new Set<string>()
    const catalogs = new Map<string, Awaited<ReturnType<typeof readNativeCapabilityCatalog>>>()
    for (const source of sources) {
      signal?.throwIfAborted()
      const key = JSON.stringify([source.pluginId, source.capabilityId])
      if (seen.has(key)) throw Error("PROJECT_CAPABILITY_DUPLICATE")
      seen.add(key)
      const installed = this.deps.getPlugin(source.pluginId)
      if (!installed?.enabled) throw Error("PROJECT_CAPABILITY_SOURCE_DISABLED")
      let catalog = catalogs.get(installed.id)
      if (!catalog) {
        catalog = await (this.deps.readCatalog ?? readNativeCapabilityCatalog)(
          installed,
          "project",
          signal
        )
        catalogs.set(installed.id, catalog)
      }
      this.deps.assertCurrent()
      if (catalog.status !== "declared" || catalog.packageDigest !== source.packageDigest)
        throw Error("PROJECT_CAPABILITY_SOURCE_CHANGED")
      const capability = catalog.capabilities.find((item) => item.id === source.capabilityId)
      if (
        !capability ||
        capability.kind !== "skill" ||
        !capability.applicable ||
        !capability.entryDigest
      )
        throw Error("PROJECT_CAPABILITY_UNAVAILABLE")
      if (
        capability.stageIds.length ||
        capability.reasons.some(
          (reason) =>
            !reason.startsWith("需宿主验证独立依赖") && !reason.startsWith("组合预览必须验证")
        )
      )
        throw Error("PROJECT_CAPABILITY_STAGE_CONTEXT_REQUIRED")
      // Legacy stage routing is computed by its original scripts; no static claim can strip it.
      if (hasAutobizBoardContext(installed.path))
        throw Error("PROJECT_CAPABILITY_LEGACY_CONTEXT_REQUIRED")
      const manifest = readPluginManifest(installed.path)?.manifest
      const hookPath = manifest?.hooks ?? installed.hookPath ?? "hooks/hooks.json"
      runtimeRelativePath(hookPath)
      const plugin = { ...installed, hookPath }
      const hookFile = readRuntimeScopedFile(plugin.path, hookPath, 256 * 1024)
      const hooks = parsePluginHooks(plugin)
      if (hookFile.present && !hooks.length && hookFile.bytes?.toString("utf8").trim() !== "[]")
        throw Error("PROJECT_CAPABILITY_HOOKS_INVALID")
      for (const id of capability.requiredHooks ?? [])
        if (
          !hooks.some(
            (hook) => hook.enabled && (hook.id === id || hook.id === `plugin:${plugin.id}/${id}`)
          )
        )
          throw Error("PROJECT_CAPABILITY_REQUIRED_HOOK_MISSING")
      const servers = parseMcpJsonFile(join(plugin.path, ".mcp.json"))
      for (const id of capability.requiredMcpServers ?? [])
        if (!servers?.[id]) throw Error("PROJECT_CAPABILITY_REQUIRED_MCP_MISSING")
      const { id, title, kind, usage, entry, dependsOn, requiredHooks, requiredMcpServers } =
        capability
      admitted.push({
        plugin,
        packageDigest: source.packageDigest,
        capability: { id, title, kind, usage, entry, dependsOn, requiredHooks, requiredMcpServers }
      })
    }
    for (const item of admitted)
      for (const id of item.capability.dependsOn)
        if (
          !admitted.some(
            (candidate) =>
              candidate.plugin.id === item.plugin.id &&
              candidate.packageDigest === item.packageDigest &&
              candidate.capability.id === id
          )
        )
          throw Error("PROJECT_CAPABILITY_DEPENDENCY_REQUIRED")
    this.deps.assertCurrent()
    return admitted
  }

  async admit(
    sources: readonly ProjectCompositionSource[],
    signal?: AbortSignal
  ): Promise<RuntimeCapabilitySource[]> {
    const checked = await this.validate(sources, signal)
    this.snapshots ??= new RetainedPackageSnapshots(this.root)
    const retained = new Map<string, string>()
    const admitted: RuntimeCapabilitySource[] = []
    for (const item of checked) {
      signal?.throwIfAborted()
      this.deps.assertCurrent()
      const key = JSON.stringify([item.plugin.path, item.packageDigest])
      let path = retained.get(key)
      if (!path) {
        const snapshot = await this.snapshots.captureAsync(item.plugin.path, signal)
        if (snapshot.digest !== item.packageDigest) throw Error("PROJECT_CAPABILITY_SOURCE_CHANGED")
        path = snapshot.root
        retained.set(key, path)
        this.retainedGuards.set(
          snapshot.digest,
          await this.snapshots.captureGuardAsync(snapshot.digest, signal)
        )
      }
      admitted.push({ ...item, plugin: { ...item.plugin, path } })
    }
    this.deps.assertCurrent()
    for (const item of admitted) this.admissions.add(item)
    return admitted
  }

  retainParentPlugin(plugin: PluginMetadata): PluginMetadata {
    this.deps.assertCurrent()
    this.snapshots ??= new RetainedPackageSnapshots(this.root)
    const snapshot = this.snapshots.capture(plugin.path)
    this.deps.assertCurrent()
    return { ...plugin, path: snapshot.root }
  }

  async retainParentPluginAsync(
    plugin: PluginMetadata,
    signal?: AbortSignal
  ): Promise<PluginMetadata> {
    this.deps.assertCurrent()
    this.snapshots ??= new RetainedPackageSnapshots(this.root)
    const snapshot = await this.snapshots.captureAsync(plugin.path, signal)
    this.retainedGuards.set(
      snapshot.digest,
      await this.snapshots.captureGuardAsync(snapshot.digest, signal)
    )
    this.deps.assertCurrent()
    return { ...plugin, path: snapshot.root }
  }

  issue(
    identity: ProjectCapabilityRuntimeIdentity,
    assertCurrent: () => void,
    original?: RuntimePluginSourceToken
  ): RuntimePluginSourceToken {
    if (
      (!identity.sources.length && !identity.parentPlugin) ||
      !this.snapshots ||
      identity.sources.some((item) => !this.admissions.has(item))
    )
      throw Error("PROJECT_CAPABILITY_ADMISSION_REQUIRED")
    const parentDigest = identity.parentPlugin
      ? identity.parentPlugin.path.split(/[\\/]/).at(-2)
      : undefined
    for (const source of identity.sources)
      if (source.plugin.path !== join(this.snapshots.root, source.packageDigest, "package"))
        throw Error("PROJECT_CAPABILITY_SNAPSHOT_CHANGED")
    if (
      identity.parentPlugin &&
      identity.parentPlugin.path !== join(this.snapshots.root, parentDigest!, "package")
    )
      throw Error("PROJECT_CAPABILITY_PARENT_SOURCE_CHANGED")
    const guards = [
      ...new Set(
        identity.sources
          .map((source) => source.packageDigest)
          .concat(parentDigest ? [parentDigest] : [])
      )
    ].map((digest) => this.retainedGuards.get(digest) ?? this.snapshots!.captureGuard(digest))
    const assertContent = () => {
      for (const guard of guards) guard()
    }
    const assertRuntime = () => {
      this.deps.assertCurrent()
      assertCurrent()
    }
    assertContent()
    assertRuntime()
    if (original)
      return extendRuntimePluginSourceToken(
        original,
        identity.sources,
        assertContent,
        assertRuntime
      )
    const first = identity.sources[0]
    return issueRuntimePluginSourceToken(
      {
        ...identity,
        mode: "capabilities",
        stageId: "independent-capabilities",
        plugin: identity.parentPlugin ?? first.plugin,
        preserveParentContext: Boolean(identity.parentPlugin),
        packageDigest: parentDigest ?? first.packageDigest,
        requiredHooks: identity.parentPlugin
          ? readRuntimeRequiredHooks(identity.parentPlugin, { legacy: true })
          : [],
        capabilitySources: identity.sources
      },
      assertContent,
      assertRuntime
    )
  }
}
import { readRuntimeRequiredHooks } from "./runtime-required-hooks"
