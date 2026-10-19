import type { ProjectCompositionCatalogEntry } from "../../shared/project-runtime/composition-api"
import type { PluginCapability } from "../../shared/plugin-capabilities"
import type { PluginMetadata } from "../types"
import { readNativeCapabilityCatalog, type NativeCapabilityCatalogItem } from "./capability-catalog"
import { readProjectRuntimeDescription } from "../harness-board/project-runtime/description"
import { assertHostPackageSupported } from "../harness-board/project-runtime/package-preflight"
import { runtimeDigest } from "../harness-board/project-runtime/safe-files"
import { ProjectCapabilityRuntimeService } from "./project-capability-runtime"

export type CompositionPlugin = PluginMetadata
export interface CompositionCatalogSource {
  plugin: CompositionPlugin
  capability: PluginCapability & Pick<NativeCapabilityCatalogItem, "runtimeMode">
  entry: ProjectCompositionCatalogEntry
  nodeContext?: import("../harness-board/node-composition").NativeNodeContext
}
export interface CompositionCatalogSnapshot {
  revision: string
  sources: CompositionCatalogSource[]
  diagnostics: string[]
}
export const compositionSourceKey = (source: ProjectCompositionCatalogEntry["source"]) =>
  JSON.stringify([source.pluginId, source.capabilityId, source.packageDigest])

/** Explicit, bounded catalog request. Never run this scan during chat streaming or render updates. */
export async function readProjectCompositionCatalog(
  plugins: CompositionPlugin[],
  signal?: AbortSignal,
  readCatalog: typeof readNativeCapabilityCatalog = readNativeCapabilityCatalog
): Promise<CompositionCatalogSnapshot> {
  if (plugins.length > 256) throw Error("COMPOSITION_CATALOG_LIMIT")
  const sources: CompositionCatalogSource[] = []
  const diagnostics: string[] = []
  for (const plugin of plugins) {
    signal?.throwIfAborted()
    const catalog = await readCatalog(plugin, "project", signal)
    // A deadline leaves the registry unconfirmed, not changed. Do not publish a partial
    // catalog that would discard selections or misclassify recovery as source replacement.
    if (catalog.reasons.includes("CAPABILITY_PACKAGE_TIMEOUT"))
      throw Error("COMPOSITION_CATALOG_BUSY")
    if (catalog.status !== "declared") {
      diagnostics.push(`${plugin.name}：${catalog.reasons.join("；")}`)
      continue
    }
    const description = await readProjectRuntimeDescription(plugin.path, signal)
    const capabilities = new Map(catalog.capabilities.map((item) => [item.id, item]))
    // Only validate is used here: no retained copies, token issuance or package execution.
    const validator = new ProjectCapabilityRuntimeService(plugin.path, {
      getPlugin: (id) => (id === plugin.id ? plugin : undefined),
      assertCurrent: () => signal?.throwIfAborted(),
      readCatalog: async (installed) => {
        if (installed.id !== plugin.id || installed.path !== plugin.path)
          throw Error("PROJECT_CAPABILITY_SOURCE_CHANGED")
        return catalog
      }
    })
    const selection = (id: string) => {
      const selected = new Set<string>()
      const visit = (current: string) => {
        if (selected.has(current)) return
        selected.add(current)
        if (selected.size > 16) throw Error("PROJECT_CAPABILITIES_LIMIT")
        const capability = capabilities.get(current)
        if (!capability) throw Error("PROJECT_CAPABILITY_DEPENDENCY_REQUIRED")
        for (const dependency of capability.dependsOn) visit(dependency)
      }
      visit(id)
      return [...selected].map((capabilityId) => ({
        pluginId: plugin.id,
        capabilityId,
        packageDigest: catalog.packageDigest!
      }))
    }
    for (const item of catalog.capabilities) {
      let available = false
      let outputs: ProjectCompositionCatalogEntry["outputs"] = []
      const reasons: string[] = []
      if (!plugin.enabled) reasons.push("请先启用来源插件。")
      if (!item.applicable) reasons.push("该功能仅用于普通对话。")
      if (
        item.kind === "flow" &&
        item.runtimeMode === "host" &&
        item.applicable &&
        plugin.enabled
      ) {
        if (item.entry !== "devclaw.project-runtime.json" || description?.status !== "ready")
          reasons.push("流程入口尚不支持；请由插件开发者检查运行声明。")
        else {
          try {
            assertHostPackageSupported(plugin.path, description.manifest)
            outputs = description.manifest.artifacts.map((artifact) => ({
              id: artifact.id,
              title: artifact.id,
              path: artifact.path
            }))
            available = true
          } catch (error) {
            reasons.push(`此流程尚不能组合：${error instanceof Error ? error.message : "检查失败"}`)
          }
        }
      } else if (
        item.kind === "skill" &&
        !item.stageIds.length &&
        item.applicable &&
        plugin.enabled
      ) {
        try {
          await validator.validate(selection(item.id), signal)
          available = true
        } catch (error) {
          signal?.throwIfAborted()
          const code = error instanceof Error ? error.message : ""
          reasons.push(
            code.includes("LIMIT")
              ? "必要能力超过 16 项，请由插件开发者简化依赖。"
              : "独立能力或其必要依赖未通过原有检查；请核对来源配置，或使用完整流程。"
          )
        }
      } else if (item.kind === "flow") {
        if (
          item.runtimeMode === "legacy" &&
          item.applicable &&
          plugin.enabled &&
          item.entry === "devclaw.project-runtime.json" &&
          description?.status === "ready" &&
          catalog.legacyAdapter === "autobiz-v1" &&
          process.platform === "win32"
        ) {
          // Exact reviewed protocol only. The original engine still owns every check and approval.
          available = true
          outputs = description.manifest.artifacts.map((artifact) => ({
            id: artifact.id,
            title: artifact.id,
            path: artifact.path
          }))
        } else {
          reasons.push("此流程暂不支持组合，请继续从原项目入口使用。")
        }
      } else {
        reasons.push(
          item.stageIds.length
            ? "这是流程中的一个阶段，需要连同原流程执行。"
            : "独立能力执行接入尚未完成，暂不能在组合中启动。"
        )
      }
      sources.push({
        plugin: { ...plugin },
        capability: item,
        entry: {
          source: {
            pluginId: plugin.id,
            capabilityId: item.id,
            packageDigest: catalog.packageDigest!
          },
          sourceName: plugin.name,
          title: item.title,
          kind: item.kind === "flow" ? "flow" : "capability",
          available,
          reasons,
          inputs: (item.inputs ?? []).map(({ id, title, required }) => ({ id, title, required })),
          outputs
        }
      })
    }
  }
  // Complete flows execute in isolated original engines; parent-chat skills cannot satisfy them.
  const bySource = new Map(
    sources.map((source) => [compositionSourceKey(source.entry.source), source])
  )
  // A declaration has at most 64 capabilities and dependencies stay within that declaration.
  for (let pass = 0; pass < 64; pass++) {
    let changed = false
    for (const source of sources) {
      if (!source.entry.available || source.entry.kind !== "flow") continue
      for (const id of source.capability.dependsOn) {
        const dependency = bySource.get(
          compositionSourceKey({ ...source.entry.source, capabilityId: id })
        )
        if (!dependency?.entry.available || dependency.entry.kind !== "flow") {
          source.entry.available = false
          source.entry.reasons.push("所需能力无法作为流程步骤执行，请由插件开发者封装完整流程。")
          changed = true
          break
        }
      }
    }
    if (!changed) break
  }
  return { sources, diagnostics, revision: runtimeDigest(JSON.stringify(sources)) }
}
