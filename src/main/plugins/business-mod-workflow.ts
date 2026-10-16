import type { BusinessModDefinition } from "../../shared/business-mods"
import { businessModObject } from "./business-mod-manifest"

export function businessModCheckpoints(node: Record<string, unknown>) {
  const values = node.checkpoints
  if (!Array.isArray(values) || !values.length || values.some((item) => typeof item !== "string"))
    throw Error(`业务 Mod 没有明确状态协议：${node.id}`)
  const start =
    values.find((value) => value.endsWith("_in_progress")) ??
    (values.length === 1 && values[0] === "archived" ? "archived" : undefined)
  const done =
    values.find((value) => value.endsWith("_done")) ??
    (values.length === 1 && values[0] === "archived" ? "archived" : undefined)
  if (!start || !done) throw Error(`业务 Mod 状态协议不完整：${node.id}`)
  return { start: String(start), done: String(done) }
}

export function projectBusinessModNodes(modules: Pick<BusinessModDefinition, "node" | "title">[]) {
  const nodes = modules.map(({ node }, index) => ({
    ...structuredClone(node),
    order: (index + 1) * 10
  })) as Array<Record<string, unknown>>
  const labels: Record<string, string> = {
    not_started: "未开始",
    in_progress: "进行中",
    done: "已完成",
    archived: "已归档"
  }
  nodes.forEach((node, index) => {
    const archived = businessModCheckpoints(node).start === "archived"
    const original = Array.isArray(node.states) ? node.states : []
    node.states = (archived ? ["archived"] : ["not_started", "in_progress", "done"]).map(
      (state) => {
        const prior = original.find(
          (value) =>
            value &&
            typeof value === "object" &&
            ((value as Record<string, unknown>).nodeStatus === state ||
              (value as Record<string, unknown>).id === state)
        )
        const template = prior ? businessModObject(prior) : {}
        const target = state === "done" ? (nodes[index + 1] ?? node) : node
        const oldAction =
          template.nextAction === undefined ? undefined : businessModObject(template.nextAction)
        const complete = state === "done" && index === nodes.length - 1
        return {
          ...template,
          id: state,
          nodeStatus: state,
          label: template.label ?? labels[state],
          nextAction:
            !complete && oldAction && oldAction.slashSkill === target.skill
              ? oldAction
              : {
                  slashSkill: target.skill,
                  userMessage: complete
                    ? "本组装流程已完成，请查看产物与检查结果。"
                    : `请使用 /${target.skill} 继续当前步骤。`,
                  dialogTips: complete
                    ? "本组装流程已完成。"
                    : `当前步骤：${target.label ?? target.id}。`
                }
        }
      }
    )
  })
  return nodes
}

/** Recomputed from selected, checked node definitions; a lock digest cannot alter the route. */
export function projectBusinessModWorkflowRouting(
  modules: Pick<BusinessModDefinition, "node" | "title">[],
  customSelection = true
) {
  if (!modules.length) throw Error("业务流程不能为空")
  const states = modules.map(({ node }) => businessModCheckpoints(node))
  const transitions: Record<string, string[]> = {},
    labels: Record<string, string> = {}
  states.forEach(({ start, done }, index) => {
    transitions[start] = start === done ? [] : [done]
    transitions[done] = states[index + 1] ? [states[index + 1].start] : []
    labels[start] = String(modules[index].node.label ?? modules[index].title)
    labels[done] = `${modules[index].title} 完成`
  })
  transitions.needs_fix = states.map((state) => state.start).filter((state) => state !== "archived")
  labels.needs_fix = "待修复"
  return {
    templates: {
      standard: { kind: "profile", label: "已组装业务流程" },
      ...(customSelection
        ? {
            custom: {
              kind: "custom",
              label: "自选步骤",
              description: "按必需产物与业务依赖补齐步骤，保留所选步骤的原检查。",
              requiredNodes: []
            }
          }
        : {})
    },
    profiles: { standard: { label: "已组装业务流程" } },
    dynamicStages: [],
    checkpoints: { initial: [states[0].start], transitions, stageLabels: labels },
    transitions: modules.slice(0, -1).map(({ node }, index) => ({
      id: `${node.id}-to-${modules[index + 1].node.id}`,
      from: { nodeId: node.id, state: states[index].done === "archived" ? "archived" : "done" },
      to: {
        nodeId: modules[index + 1].node.id,
        state: states[index + 1].start === "archived" ? "archived" : "in_progress"
      }
    }))
  }
}
