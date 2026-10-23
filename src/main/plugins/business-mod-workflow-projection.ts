import type { BusinessModDefinition } from "../../shared/business-mods"
import { businessModObject } from "./business-mod-manifest"
import {
  businessModCheckpoints,
  projectBusinessModNodes,
  projectBusinessModWorkflowRouting
} from "./business-mod-workflow"

type Module = Pick<BusinessModDefinition, "node" | "title">
type Routing = Omit<
  ReturnType<typeof projectBusinessModWorkflowRouting>,
  "templates" | "profiles" | "dynamicStages"
> & {
  templates: Record<string, unknown>
  profiles: Record<string, unknown>
  dynamicStages: Record<string, unknown>[]
}
export interface BusinessModWorkflowProjection {
  nodes: Record<string, unknown>[]
  routing: Routing
  requiresFixedWorkflowAcknowledgement: boolean
  diagnostics: string[]
}
const rows = (value: unknown): Record<string, unknown>[] => {
  if (!Array.isArray(value) || value.length > 64) throw Error("流程节点列表无效")
  return value.map(businessModObject)
}
const strings = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw Error("流程引用列表无效")
  return value
}
const equivalent = (left: unknown, right: unknown) => {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, canonical(item)])
          )
        : value
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

/** Project only supported routing semantics. Unsupported changes retain the explicit fixed-flow gate.
 * Source trust is checked by admission; a caller cannot use this projection as a provenance proof.
 */
export function projectBusinessModWorkflow(
  modules: Module[],
  originalWorkflow: Record<string, unknown>
): BusinessModWorkflowProjection {
  const fixed = (): BusinessModWorkflowProjection => ({
    nodes: projectBusinessModNodes(modules),
    routing: projectBusinessModWorkflowRouting(modules),
    requiresFixedWorkflowAcknowledgement: false,
    diagnostics: []
  })
  try {
    const sourceNodes = rows(originalWorkflow.nodes ?? [])
    // Old/minimal catalogs without a routing contract keep their existing fixed behavior.
    if (
      !sourceNodes.length &&
      (originalWorkflow.dynamicStages === undefined ||
        (Array.isArray(originalWorkflow.dynamicStages) && !originalWorkflow.dynamicStages.length))
    )
      return fixed()
    const sourceIds = new Set(sourceNodes.map((node) => String(node.id)))
    if (sourceIds.size !== sourceNodes.length) throw Error("原流程主干节点重复")
    const selected = new Map(modules.map((mod) => [String(mod.node.id), mod]))
    if (selected.size !== modules.length) throw Error("所选流程节点重复")
    const stages = rows(originalWorkflow.dynamicStages ?? [])
    const dynamicIds = new Set<string>(),
      stageIds = new Set<string>()
    for (const stage of stages) {
      if (typeof stage.id !== "string" || stageIds.has(stage.id)) throw Error("动态阶段标识无效")
      stageIds.add(stage.id)
      for (const node of rows(stage.nodes)) {
        if (typeof node.id !== "string" || sourceIds.has(node.id) || dynamicIds.has(node.id))
          throw Error("动态节点与主干或其它动态节点重复")
        dynamicIds.add(node.id)
      }
    }
    const baseModules = modules.filter((mod) => !dynamicIds.has(String(mod.node.id)))
    if (!baseModules.length) throw Error("动态阶段缺少主干")
    const nodes = projectBusinessModNodes(baseModules)
    const routing: Routing = projectBusinessModWorkflowRouting(baseModules)
    const baseIds = new Set(nodes.map((node) => String(node.id)))
    const baseStates = nodes.map(businessModCheckpoints)
    const diagnostics: string[] = []
    for (const stage of stages) {
      const branch = rows(stage.nodes)
      const chosen = branch.filter((node) => selected.has(String(node.id)))
      if (!chosen.length) {
        diagnostics.push(`未选择动态阶段 ${stage.id} 的业务 Mod，该分支不进入本次流程。`)
        continue
      }
      if (chosen.length !== branch.length) throw Error(`动态阶段 ${stage.id} 只选择了部分节点`)
      const after = typeof stage.insertAfter === "string",
        before = typeof stage.insertBefore === "string"
      if (after === before) throw Error(`动态阶段 ${stage.id} 插入锚点无效`)
      const anchor = String(after ? stage.insertAfter : stage.insertBefore)
      const anchorIndex = nodes.findIndex((node) => node.id === anchor)
      const edgeIndex = after ? anchorIndex : anchorIndex - 1
      if (anchorIndex < 0 || edgeIndex < 0 || !nodes[edgeIndex + 1])
        throw Error(`动态阶段 ${stage.id} 缺少所选主干锚点`)
      if (
        stage.phase !== "Dev" ||
        !["pending", "skip"].includes(String(stage.defaultDecision ?? "pending")) ||
        stage.choiceCheckpoint !== baseStates[edgeIndex].done ||
        stage.skipTargetCheckpoint !== baseStates[edgeIndex + 1].start
      )
        throw Error(`动态阶段 ${stage.id} 的选择或跳过目标与所选主干不衔接`)
      for (const raw of branch) {
        const mod = selected.get(String(raw.id))!
        const checkpoints = businessModCheckpoints(mod.node)
        if (
          raw.skill !== mod.node.skill ||
          raw.phase !== (mod.node.group ?? mod.node.phase) ||
          `${raw.checkpointPrefix}_in_progress` !== checkpoints.start ||
          `${raw.checkpointPrefix}_done` !== checkpoints.done ||
          !equivalent(raw.artifacts ?? {}, mod.node.artifacts ?? {}) ||
          !equivalent(raw.validators ?? [], mod.node.validators ?? []) ||
          (Array.isArray(mod.node.guards) && mod.node.guards.length > 0) ||
          (Array.isArray(mod.node.hookDefinitions) && mod.node.hookDefinitions.length > 0)
        )
          throw Error(`动态阶段 ${stage.id} 的业务定义或检查不能无损投影`)
      }
      if (
        stage.enableTargetCheckpoint !==
        businessModCheckpoints(selected.get(String(branch[0].id))!.node).start
      )
        throw Error(`动态阶段 ${stage.id} 启用目标无效`)
      // A skipped optional branch must not be the sole producer of a required main-chain input.
      const branchOutputs = new Set(
        branch.flatMap((node) =>
          rows(businessModObject(node.artifacts ?? {}).outputs ?? []).map((output) =>
            String(output.path)
          )
        )
      )
      const produced = new Set<string>()
      for (const node of nodes) {
        const artifacts = businessModObject(node.artifacts ?? {})
        for (const input of rows(artifacts.inputs ?? []))
          if (
            input.required !== false &&
            branchOutputs.has(String(input.path)) &&
            !produced.has(String(input.path))
          )
            throw Error(`主干必需输入 ${input.path} 依赖可跳过动态阶段 ${stage.id}`)
        for (const output of rows(artifacts.outputs ?? [])) produced.add(String(output.path))
      }
      routing.dynamicStages.push(structuredClone(stage))
    }
    const sourceRouting = projectBusinessModWorkflowRouting(
      sourceNodes.map((node) => ({ node, title: String(node.label ?? node.id) }))
    )
    const checkpoints = businessModObject(originalWorkflow.checkpoints ?? {})
    const sourceTransitions = businessModObject(checkpoints.transitions ?? {})
    for (const [checkpoint, targets] of Object.entries(sourceTransitions)) {
      if (
        checkpoint !== "needs_fix" &&
        !equivalent(targets, sourceRouting.checkpoints.transitions[checkpoint])
      )
        throw Error(`原状态分支 ${checkpoint} 不能无损投影`)
    }
    const originalInitial = strings(checkpoints.initial ?? [])
    const sourceStates = sourceNodes.map(businessModCheckpoints)
    if (
      originalInitial.some(
        (checkpoint) => !sourceStates.some((state) => state.start === checkpoint)
      )
    )
      throw Error("原流程初始状态不是主干入口")
    const retainedInitial = originalInitial.filter((checkpoint) =>
      baseStates.some((state) => state.start === checkpoint)
    )
    if (retainedInitial.length) {
      // Old alternate entry points must not bypass a newly inserted mandatory predecessor.
      // Keep original starts when no new predecessor exists; otherwise enter the new chain.
      routing.checkpoints.initial = [
        ...new Set(
          retainedInitial.map((checkpoint) => {
            const entryIndex = baseStates.findIndex((state) => state.start === checkpoint)
            const insertedIndex = nodes.findIndex(
              (node, index) => index < entryIndex && !sourceIds.has(String(node.id))
            )
            return insertedIndex < 0 ? checkpoint : baseStates[insertedIndex].start
          })
        )
      ]
      if (!equivalent(retainedInitial, routing.checkpoints.initial))
        diagnostics.push("已将原快捷入口衔接到新增的必经前置步骤，避免跳过新增步骤。")
    }
    if (sourceTransitions.needs_fix !== undefined) {
      const repair = strings(sourceTransitions.needs_fix)
      if (repair.some((checkpoint) => !sourceStates.some((state) => state.start === checkpoint)))
        throw Error("原修复分支引用非主干入口")
      routing.checkpoints.transitions.needs_fix = [
        ...repair.filter((checkpoint) => baseStates.some((state) => state.start === checkpoint)),
        ...baseStates
          .filter((_, index) => !sourceIds.has(String(nodes[index].id)))
          .map((state) => state.start)
          .filter((checkpoint) => checkpoint !== "archived")
      ]
    }
    const sourceUiTransitions = rows(originalWorkflow.transitions ?? [])
    for (const transition of sourceUiTransitions) {
      const from = businessModObject(transition.from),
        to = businessModObject(transition.to)
      const fromIndex = sourceNodes.findIndex((node) => node.id === from.nodeId)
      if (
        fromIndex < 0 ||
        sourceNodes[fromIndex + 1]?.id !== to.nodeId ||
        from.state !== (sourceStates[fromIndex].done === "archived" ? "archived" : "done") ||
        to.state !== (sourceStates[fromIndex + 1].start === "archived" ? "archived" : "in_progress")
      )
        throw Error("原界面流程包含未支持的非相邻分支")
    }
    routing.transitions = routing.transitions.map((transition) => {
      const prior = sourceUiTransitions.find(
        (row) => equivalent(row.from, transition.from) && equivalent(row.to, transition.to)
      )
      return prior ? (structuredClone(prior) as typeof transition) : transition
    })
    const oldLabels = businessModObject(checkpoints.stageLabels ?? {})
    for (const checkpoint of Object.keys(routing.checkpoints.stageLabels))
      if (typeof oldLabels[checkpoint] === "string")
        routing.checkpoints.stageLabels[checkpoint] = oldLabels[checkpoint]
    const oldProfiles = businessModObject(originalWorkflow.profiles ?? {})
    for (const [id, raw] of Object.entries(oldProfiles)) {
      const profile = businessModObject(raw)
      if (Object.keys(profile).some((key) => !["label", "description"].includes(key)))
        throw Error(`流程配置 ${id} 含有未支持的覆盖语义`)
    }
    if (Object.keys(oldProfiles).length) routing.profiles = structuredClone(oldProfiles)
    const oldTemplates = businessModObject(originalWorkflow.templates ?? {})
    const templates: Record<string, unknown> = {}
    const hasNewBaseNode = [...baseIds].some((id) => !sourceIds.has(id))
    for (const [id, raw] of Object.entries(oldTemplates)) {
      const template = businessModObject(raw)
      if (template.kind === "profile" && routing.profiles[id])
        templates[id] = structuredClone(template)
      else if (template.kind === "nodeSubset") {
        const subset = strings(template.nodes)
        if (!hasNewBaseNode && subset.length && subset.every((id) => baseIds.has(id)))
          templates[id] = structuredClone(template)
      } else if (template.kind === "custom") {
        templates[id] = {
          ...structuredClone(template),
          requiredNodes: strings(template.requiredNodes ?? []).filter((id) => baseIds.has(id))
        }
      } else if (template.kind !== "profile") throw Error(`流程模板 ${id} 类型不支持`)
    }
    routing.templates = { ...routing.templates, ...templates }
    return { nodes, routing, diagnostics, requiresFixedWorkflowAcknowledgement: false }
  } catch (error) {
    const result = fixed()
    result.requiresFixedWorkflowAcknowledgement = true
    result.diagnostics.push(
      `行为差异：${error instanceof Error ? error.message : "原流程无法投影"}。需明确确认固定步骤方案，或保留原插件入口。`
    )
    return result
  }
}
