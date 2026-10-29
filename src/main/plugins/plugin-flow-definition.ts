import { createHash } from "node:crypto"
import type { PluginMetadata } from "../types"
import type {
  PluginFlowDefinition,
  PluginFlowDefinitionInput
} from "../../shared/plugin-flow-definition"
import { readProjectRuntimeDescription } from "../harness-board/project-runtime/description"
import { HARNESS_BOARD_CONFIG_RELATIVE_PATH } from "../harness-board/plugin-mode"
import { readRuntimeScopedFileAsync } from "../harness-board/project-runtime/safe-files-async"
import type { ProjectRuntimeManifest } from "../../shared/project-runtime"

type InstalledPlugin = Pick<
  PluginMetadata,
  "id" | "name" | "version" | "path" | "enabled" | "updatedAt"
>
const runtimePath = "devclaw.project-runtime.json"
const legacyPath = HARNESS_BOARD_CONFIG_RELATIVE_PATH.replaceAll("\\", "/")
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
const identity = (plugin: InstalledPlugin) =>
  JSON.stringify([
    plugin.id,
    plugin.name,
    plugin.version,
    plugin.path,
    plugin.enabled,
    plugin.updatedAt
  ])

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("PLUGIN_FLOW_DECLARATION_INVALID")
  return value as Record<string, unknown>
}

function text(value: unknown, fallback = "", max = 12000): string {
  if (value === undefined) return fallback
  if (typeof value !== "string" || value.length > max)
    throw Error("PLUGIN_FLOW_DECLARATION_INVALID")
  return value
}

function id(value: unknown): string {
  const result = text(value, "", 256)
  if (!result.trim()) throw Error("PLUGIN_FLOW_DECLARATION_INVALID")
  return result
}

function list(value: unknown, max = 128): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > max) throw Error("PLUGIN_FLOW_DECLARATION_LIMIT")
  return value
}

function refs(value: unknown): string[] {
  const result = list(value).map(id)
  if (new Set(result).size !== result.length) throw Error("PLUGIN_FLOW_DECLARATION_INVALID")
  return result
}

function relativeReference(value: unknown): string {
  const result = id(value)
  if (/^(?:[\\/]|[a-z]:|~[\\/])/i.test(result) || result.split(/[\\/]/).includes(".."))
    throw Error("PLUGIN_FLOW_REFERENCE_INVALID")
  return result
}

function diagnosticCode(error: unknown): string {
  const value = error as { message?: unknown; code?: unknown } | null
  if (typeof value?.message === "string" && /^PLUGIN_FLOW_[A-Z_]+$/.test(value.message))
    return value.message
  if (typeof value?.code === "string" && /^[A-Z_]+$/.test(value.code)) return value.code
  return "PLUGIN_FLOW_DECLARATION_UNREADABLE"
}

function nativeDefinition(
  manifest: ProjectRuntimeManifest
): Pick<PluginFlowDefinition, "templates" | "nodes"> {
  const artifacts = new Map(manifest.artifacts.map((item) => [item.id, item.path]))
  const checks = new Map(
    manifest.checks.map((item) => [item.id, `${item.id} · ${item.kind} · ${item.sideEffect}`])
  )
  return {
    templates: [
      {
        id: "declared-runtime",
        title: "插件声明的流程",
        description: "",
        kind: manifest.mode === "host" ? "fixed" : "legacy",
        nodeIds: manifest.stages.map((stage) => stage.id),
        requiredNodeIds: []
      }
    ],
    nodes: manifest.stages.map((stage) => ({
      id: stage.id,
      title: stage.title,
      description: "",
      ...(stage.skill ? { skill: stage.skill } : {}),
      inputs: (stage.inputArtifactIds ?? []).map((value) => artifacts.get(value) ?? value),
      outputs: stage.artifactIds.map((value) => artifacts.get(value) ?? value),
      checks: stage.checkIds.map((value) => checks.get(value) ?? value),
      approval: stage.approval,
      ...(stage.resultApproval ? { resultApproval: stage.resultApproval } : {})
    }))
  }
}

/** Projects declared data only. In particular, profile/custom routes are never compiled here. */
function legacyDefinition(
  value: unknown
): Pick<PluginFlowDefinition, "templates" | "nodes"> | null {
  const root = object(value)
  if (root.workflow === undefined) return null
  const workflow = object(root.workflow)
  if (!Array.isArray(workflow.nodes)) return null
  const paths = (value: unknown) => list(value).map((item) => relativeReference(object(item).path))
  const node = (value: unknown): PluginFlowDefinition["nodes"][number] => {
    const raw = object(value)
    const nodeId = id(raw.id)
    const artifacts = raw.artifacts === undefined ? {} : object(raw.artifacts)
    return {
      id: nodeId,
      title: text(raw.label, nodeId, 512),
      description: text(raw.description),
      ...(raw.skill === undefined ? {} : { skill: relativeReference(raw.skill) }),
      inputs: paths(artifacts.inputs),
      outputs: paths(artifacts.outputs),
      checks: refs(raw.checkpoints)
    }
  }
  const nodes = list(workflow.nodes).map(node)
  for (const value of list(workflow.dynamicStages, 64)) {
    const stage = object(value)
    const title = text(stage.label, id(stage.id), 512)
    for (const value of list(stage.nodes))
      nodes.push({
        ...node(value),
        optional: {
          title,
          ...(stage.insertAfter === undefined ? {} : { insertAfter: id(stage.insertAfter) })
        }
      })
  }
  if (nodes.length > 128) throw Error("PLUGIN_FLOW_DECLARATION_LIMIT")
  const nodeIds = new Set(nodes.map((item) => item.id))
  if (nodeIds.size !== nodes.length) throw Error("PLUGIN_FLOW_DECLARATION_INVALID")
  const registry = workflow.templates === undefined ? {} : object(workflow.templates)
  if (Object.keys(registry).length > 64) throw Error("PLUGIN_FLOW_DECLARATION_LIMIT")
  const templates = Object.entries(registry).map(([templateId, value]) => {
    const raw = object(value)
    const nodeIds = raw.nodes === undefined ? undefined : refs(raw.nodes)
    return {
      id: id(templateId),
      title: text(raw.label, templateId, 512),
      description: text(raw.description),
      kind: text(raw.kind, "未声明类型", 100),
      ...(nodeIds ? { nodeIds } : {}),
      requiredNodeIds: refs(raw.requiredNodes)
    }
  })
  for (const template of templates)
    for (const reference of [...(template.nodeIds ?? []), ...template.requiredNodeIds])
      if (!nodeIds.has(reference)) throw Error("PLUGIN_FLOW_NODE_REFERENCE_INVALID")
  return { templates, nodes }
}

/** Fixed installed files only: no scripts, project state, retained copy, grants or runtime tokens. */
export async function readPluginFlowDefinition(
  plugin: InstalledPlugin
): Promise<PluginFlowDefinition> {
  const result: PluginFlowDefinition = {
    source: {
      pluginId: plugin.id,
      name: plugin.name,
      version: plugin.version,
      enabled: plugin.enabled
    },
    status: "undeclared",
    diagnostics: [],
    templates: [],
    nodes: []
  }
  try {
    const description = await readProjectRuntimeDescription(plugin.path)
    if (description?.status === "invalid")
      return {
        ...result,
        status: "invalid",
        declarationPath: runtimePath,
        diagnostics: ["已安装版本的项目流程声明无法读取或格式无效，请让作者修正后重新安装。"]
      }
    if (description?.status === "ready") {
      if (
        description.manifest.plugin.id !== plugin.name ||
        description.manifest.plugin.version !== plugin.version
      )
        throw Error("PLUGIN_FLOW_PACKAGE_IDENTITY_CHANGED")
      if (description.manifest.mode === "host" || description.manifest.stages.length) {
        const observed = await readRuntimeScopedFileAsync(plugin.path, runtimePath, 65536)
        if (!observed.bytes || digest(observed.bytes) !== description.declarationDigest)
          throw Error("PLUGIN_FLOW_SOURCE_CHANGED")
        return {
          ...result,
          ...nativeDefinition(description.manifest),
          status: "ready",
          format: description.manifest.mode === "host" ? "native" : "legacy",
          declarationPath: runtimePath,
          declarationDigest: description.declarationDigest
        }
      }
    }
    const observed = await readRuntimeScopedFileAsync(plugin.path, legacyPath, 1024 * 1024)
    if (!observed.bytes)
      return {
        ...result,
        diagnostics: [
          "此安装版本未提供可只读展示的静态流程定义。原项目入口仍会按插件声明核对执行能力。"
        ]
      }
    const parsed = legacyDefinition(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(observed.bytes))
    )
    if (!parsed)
      return {
        ...result,
        diagnostics: ["此安装版本的配置没有声明可展示的流程模板和步骤。请由作者补充静态流程定义。"]
      }
    const current = await readRuntimeScopedFileAsync(plugin.path, legacyPath, 1024 * 1024)
    if (current.fingerprint !== observed.fingerprint) throw Error("PLUGIN_FLOW_SOURCE_CHANGED")
    const latestRuntime = await readProjectRuntimeDescription(plugin.path)
    if (JSON.stringify(description) !== JSON.stringify(latestRuntime))
      throw Error("PLUGIN_FLOW_SOURCE_CHANGED")
    return {
      ...result,
      ...parsed,
      status: "ready",
      format: "legacy",
      declarationPath: legacyPath,
      declarationDigest: digest(observed.bytes),
      diagnostics: parsed.templates.some((item) => item.nodeIds === undefined)
        ? [
            "部分模板未在静态配置中列出固定步骤序列；这里只展示包内声明，实际需求的步骤由原项目入口核对。"
          ]
        : []
    }
  } catch (error) {
    return {
      ...result,
      status: "invalid",
      diagnostics: [
        `已安装版本的静态流程定义读取失败：${diagnosticCode(error)}。请刷新后重试或让作者修正声明。`
      ]
    }
  }
}

/** Never accept a source path from the renderer. Disabled packages remain inspectable. */
export async function readInstalledPluginFlowDefinition(
  input: PluginFlowDefinitionInput,
  plugins: () => readonly InstalledPlugin[],
  assertCurrent: () => void,
  read: typeof readPluginFlowDefinition = readPluginFlowDefinition
): Promise<PluginFlowDefinition> {
  assertCurrent()
  const installed = plugins().find((item) => item.id === input.pluginId)
  if (!installed) throw Error("插件已卸载，请刷新插件目录。")
  const plugin = { ...installed }
  if (plugin.name !== input.expected.name || plugin.version !== input.expected.version)
    throw Error("插件版本已变化，请刷新插件目录后重新查看流程定义。")
  const original = identity(plugin)
  const result = await read(plugin)
  assertCurrent()
  const latest = plugins().find((item) => item.id === plugin.id)
  if (!latest || identity(latest) !== original)
    throw Error("插件已卸载、更新或状态已变化，请刷新插件目录后重新查看流程定义。")
  return result
}
