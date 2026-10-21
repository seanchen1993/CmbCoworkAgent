import type { PluginMetadata } from "../types"
import type {
  PluginStartUseInput,
  PluginStartUseIssue,
  PluginStartUseReport
} from "../../shared/plugin-start-use"
import { derivationContentIdentity, snapshotDerivationSource } from "./derivation-source"
import { readProjectRuntimeDescription } from "../harness-board/project-runtime/description"
import { assertHostPackageSupported } from "../harness-board/project-runtime/package-preflight"
import { isLegacyProjectModePluginRoot } from "../harness-board/plugin-mode"
import { withPluginCatalogMutation } from "./catalog-mutation"

const identity = (plugin: PluginMetadata) =>
  JSON.stringify([
    plugin.id,
    plugin.name,
    plugin.version,
    plugin.path,
    plugin.enabled,
    plugin.updatedAt
  ])

/** Main-only prepare is read-only; explicit enable mutates the catalog without granting execution. */
export class PluginStartUseService {
  constructor(
    private readonly deps: {
      plugins(): PluginMetadata[]
      enable?(pluginId: string, guard: () => void): Promise<void>
      diagnostics?(
        plugin: PluginMetadata,
        input: PluginStartUseInput,
        guard: () => void
      ): Promise<PluginStartUseIssue[]>
      chatEntries?(
        plugin: PluginMetadata,
        input: PluginStartUseInput,
        guard: () => void
      ): Promise<NonNullable<PluginStartUseReport["chat"]>>
    }
  ) {}

  /** Explicit catalog enablement only; VM/source approval and project execution stay separate. */
  async enable(
    input: PluginStartUseInput,
    assertCurrent: () => void
  ): Promise<PluginStartUseReport> {
    if (!input.expected?.digest) throw Error("PLUGIN_START_USE_EXACT_IDENTITY_REQUIRED")
    return withPluginCatalogMutation(async () => {
      assertCurrent()
      const initial = this.deps.plugins().find((plugin) => plugin.id === input.pluginId)
      if (!initial) throw Error("PLUGIN_START_USE_PLUGIN_UNAVAILABLE")
      const original = identity(initial)
      const beforeEnable = () => {
        assertCurrent()
        const current = this.deps.plugins().find((plugin) => plugin.id === input.pluginId)
        if (!current || identity(current) !== original)
          throw Error("PLUGIN_START_USE_IDENTITY_CHANGED")
      }
      const report = await this.prepare(input, assertCurrent)
      beforeEnable()
      if (report.activationRequired) {
        if (!this.deps.enable) throw Error("PLUGIN_START_USE_ENABLE_UNAVAILABLE")
        await this.deps.enable(input.pluginId, beforeEnable)
      }
      assertCurrent()
      return this.prepare(input, assertCurrent)
    })
  }

  async prepare(
    input: PluginStartUseInput,
    assertCurrent: () => void
  ): Promise<PluginStartUseReport> {
    try {
      return await this.prepareCurrent(input, assertCurrent)
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : ""
      if (
        /^(?:(?:PLUGIN_START_USE|DEVELOPMENT|PROJECT_HOST|MODS)_[A-Z_]+|SCOPE_CHANGED)$/.test(code)
      )
        throw cause
      // Parser and filesystem errors can include untrusted source fragments or local paths.
      throw Error("PLUGIN_START_USE_PACKAGE_INVALID")
    }
  }

  private async prepareCurrent(
    input: PluginStartUseInput,
    assertCurrent: () => void
  ): Promise<PluginStartUseReport> {
    assertCurrent()
    if (
      !input ||
      !input.expected ||
      !input.pluginId ||
      !input.expected.name ||
      !input.expected.version ||
      (input.expected.digest !== undefined && !/^[a-f0-9]{64}$/.test(input.expected.digest))
    )
      throw Error("PLUGIN_START_USE_INPUT_INVALID")
    const original = this.deps.plugins().find((plugin) => plugin.id === input.pluginId)
    if (!original) throw Error("PLUGIN_START_USE_PLUGIN_UNAVAILABLE")
    if (original.name !== input.expected.name || original.version !== input.expected.version)
      throw Error("PLUGIN_START_USE_IDENTITY_CHANGED")
    const fixed = { ...original }
    const guard = () => {
      assertCurrent()
      const current = this.deps.plugins().find((plugin) => plugin.id === input.pluginId)
      if (!current || identity(current) !== identity(fixed))
        throw Error("PLUGIN_START_USE_IDENTITY_CHANGED")
    }
    guard()
    const before = await snapshotDerivationSource(fixed.path)
    guard()
    const digest = derivationContentIdentity(before.files)
    const manifest = JSON.parse(
      before.files.find((file) => file.path === before.manifests[0])!.bytes.toString("utf8")
    ) as { name?: unknown; version?: unknown }
    if (
      manifest.name !== fixed.name ||
      manifest.version !== fixed.version ||
      (input.expected.digest && digest !== input.expected.digest)
    )
      throw Error("PLUGIN_START_USE_CONTENT_CHANGED")
    const description = await readProjectRuntimeDescription(fixed.path)
    guard()
    let kind: PluginStartUseReport["kind"] = "chat"
    if (description) {
      if (description.status !== "ready") throw Error("PLUGIN_START_USE_PROJECT_INVALID")
      if (
        description.manifest.plugin.id !== fixed.name ||
        description.manifest.plugin.version !== fixed.version
      )
        throw Error("PLUGIN_START_USE_IDENTITY_CHANGED")
      if (description.manifest.mode === "host") {
        assertHostPackageSupported(fixed.path, description.manifest)
        kind = "host-project"
      } else if (isLegacyProjectModePluginRoot(fixed.path)) kind = "plugin-project"
      else throw Error("PLUGIN_START_USE_PROJECT_UNSUPPORTED")
    } else if (isLegacyProjectModePluginRoot(fixed.path)) kind = "plugin-project"
    const issues = fixed.enabled ? ((await this.deps.diagnostics?.(fixed, input, guard)) ?? []) : []
    guard()
    const chat =
      fixed.enabled && kind === "chat"
        ? await this.deps.chatEntries?.(fixed, input, guard)
        : undefined
    guard()
    const after = await snapshotDerivationSource(fixed.path)
    guard()
    if (derivationContentIdentity(after.files) !== digest)
      throw Error("PLUGIN_START_USE_CONTENT_CHANGED")
    if (
      issues.length > 64 ||
      issues.some(
        (issue) =>
          !["configuration", "knowledge", "dependency", "permission", "runtime"].includes(
            issue.code
          ) ||
          !["plugin-settings", "project-form", "chat-settings"].includes(issue.resolution) ||
          typeof issue.message !== "string" ||
          issue.message.length > 1000
      )
    )
      throw Error("PLUGIN_START_USE_DIAGNOSTIC_INVALID")
    return {
      identity: { pluginId: fixed.id, name: fixed.name, version: fixed.version, digest },
      kind,
      canOpen: fixed.enabled,
      ...(!fixed.enabled ? { activationRequired: true } : {}),
      issues,
      ...(chat ? { chat } : {})
    }
  }
}
