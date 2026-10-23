import { expect, it } from "vitest"
import { projectBusinessModWorkflow } from "./business-mod-workflow-projection"
import { projectBusinessModWorkflowRouting } from "./business-mod-workflow"
import reviewedWorkflow from "./autobiz-business-routing-reviewed.json"

function fixture() {
  const workflow = structuredClone(reviewedWorkflow) as Record<string, unknown>
  const source = reviewedWorkflow.nodes.map((node) => ({
    title: node.label,
    node: {
      ...structuredClone(node),
      group: "Dev",
      skill: `skill-${node.id}`,
      artifacts: { inputs: [], outputs: [] }
    }
  }))
  const raw = reviewedWorkflow.dynamicStages[0].nodes[0]
  const dynamic = {
    title: raw.label,
    node: {
      ...structuredClone(raw),
      group: raw.phase,
      checkpoints: [`${raw.checkpointPrefix}_in_progress`, `${raw.checkpointPrefix}_done`],
      guards: [],
      hookDefinitions: []
    }
  }
  const modules: Array<{ title: string; node: Record<string, unknown> }> = [...source]
  modules.splice(4, 0, dynamic)
  return { workflow, modules }
}

it("preserves original dynamic decisions, checkpoint entry points and valid templates without duplicating a branch in the main chain", () => {
  const { workflow, modules } = fixture()
  const before = structuredClone({ workflow, modules })
  const result = projectBusinessModWorkflow(modules, workflow)
  expect(result.requiresFixedWorkflowAcknowledgement, result.diagnostics.join(";")).toBe(false)
  expect(result.nodes.map((node) => node.id)).toEqual(reviewedWorkflow.nodes.map((node) => node.id))
  expect(result.routing.dynamicStages).toEqual(reviewedWorkflow.dynamicStages)
  expect(result.routing.templates).toEqual(reviewedWorkflow.templates)
  expect(result.routing.profiles).toEqual(reviewedWorkflow.profiles)
  expect(result.routing.checkpoints.initial).toEqual(reviewedWorkflow.checkpoints.initial)
  expect(result.routing.checkpoints.transitions.plan_done).toEqual(["code_in_progress"])
  expect(result.routing.checkpoints.transitions.detail_design_in_progress).toBeUndefined()
  expect({ workflow, modules }).toEqual(before)
})

it("treats an intentionally absent AutoBiz branch as unselected when deriving a warehouse workflow", () => {
  const { workflow, modules } = fixture()
  const warehouse = {
    title: "Warehouse model",
    node: {
      id: "warehouse.model",
      skill: "warehouse-model",
      checkpoints: ["model_in_progress", "model_done"]
    }
  }
  const result = projectBusinessModWorkflow([...modules.slice(0, 2), warehouse], workflow)
  expect(result.requiresFixedWorkflowAcknowledgement, result.diagnostics.join(";")).toBe(false)
  expect(result.routing.dynamicStages).toEqual([])
  expect(result.routing.templates.lean).toBeUndefined()
  expect(result.routing.templates.custom).toMatchObject({ requiredNodes: [] })
  expect(result.routing.checkpoints.initial).toEqual(["prd_in_progress", "specs_in_progress"])
  expect(result.routing.checkpoints.transitions.specs_done).toEqual(["model_in_progress"])
})

it.each([
  "anchor",
  "target",
  "enable",
  "definition",
  "guard",
  "profile",
  "transition",
  "duplicate"
])("keeps incompatible %s semantics behind the explicit fixed-flow acknowledgement", (mutation) => {
  const { workflow, modules } = fixture()
  const stages = workflow.dynamicStages as typeof reviewedWorkflow.dynamicStages
  if (mutation === "anchor") modules.splice(3, 1)
  if (mutation === "target") stages[0].skipTargetCheckpoint = "cicd_in_progress"
  if (mutation === "enable") stages[0].enableTargetCheckpoint = "detail_design_done"
  if (mutation === "definition") modules[4].node.skill = "replacement"
  if (mutation === "guard") modules[4].node.guards = ["cannot-lose-this"]
  if (mutation === "profile") workflow.profiles = { standard: { nodes: [{ id: "shadow" }] } }
  if (mutation === "transition")
    (workflow.checkpoints as typeof reviewedWorkflow.checkpoints).transitions.plan_done = [
      "cicd_in_progress"
    ]
  if (mutation === "duplicate")
    (workflow.nodes as unknown[]).push(structuredClone(stages[0].nodes[0]))
  const result = projectBusinessModWorkflow(modules, workflow)
  expect(result.requiresFixedWorkflowAcknowledgement).toBe(true)
  expect(result.diagnostics.join(";")).toContain("明确确认固定步骤方案")
  expect(result.routing.dynamicStages).toEqual([])
  expect(result.routing).toEqual(projectBusinessModWorkflowRouting(modules))
})

it("does not let a newly inserted mandatory step be bypassed through the original branch or lean template", () => {
  const { workflow, modules } = fixture()
  modules.splice(5, 0, {
    title: "Quality",
    node: {
      id: "user.quality",
      skill: "quality",
      checkpoints: ["quality_in_progress", "quality_done"]
    }
  })
  const result = projectBusinessModWorkflow(modules, workflow)
  expect(result.requiresFixedWorkflowAcknowledgement).toBe(true)
  expect(result.diagnostics.join(";")).toContain("不衔接")
  const withoutDynamic = modules.filter((mod) => mod.node.id !== "dev.detail_design")
  const projected = projectBusinessModWorkflow(withoutDynamic, workflow)
  expect(projected.requiresFixedWorkflowAcknowledgement).toBe(false)
  expect(projected.routing.templates.lean).toBeUndefined()
  expect(projected.routing.checkpoints.transitions.plan_done).toEqual(["quality_in_progress"])
})

it("does not use an optional dynamic artifact as the sole producer for required main-chain input", () => {
  const { workflow, modules } = fixture()
  modules[5].node.artifacts = {
    inputs: [{ path: "DETAIL_DESIGN.md", required: true }],
    outputs: []
  }
  const result = projectBusinessModWorkflow(modules, workflow)
  expect(result.requiresFixedWorkflowAcknowledgement).toBe(true)
  expect(result.diagnostics.join(";")).toContain("依赖可跳过动态阶段")
})

it("routes every original entry through a newly inserted mandatory prelude", () => {
  const { workflow, modules } = fixture()
  const before = structuredClone(workflow)
  modules.unshift({
    title: "需求转换",
    node: {
      id: "user.normalize",
      skill: "normalize-requirements",
      checkpoints: ["normalize_in_progress", "normalize_done"]
    }
  })
  const result = projectBusinessModWorkflow(modules, workflow)
  expect(result.requiresFixedWorkflowAcknowledgement, result.diagnostics.join(";")).toBe(false)
  expect(result.routing.checkpoints.initial).toEqual(["normalize_in_progress"])
  expect(result.routing.checkpoints.transitions.normalize_done).toEqual(["prd_in_progress"])
  expect(result.routing.dynamicStages).toEqual(reviewedWorkflow.dynamicStages)
  expect(result.routing.templates.lean).toBeUndefined()
  expect(workflow).toEqual(before)
})

it("keeps the main entry and redirects an alternate entry past a newly inserted middle step", () => {
  const { workflow, modules } = fixture()
  modules.splice(1, 0, {
    title: "核对",
    node: {
      id: "user.review",
      skill: "review-requirements",
      checkpoints: ["review_in_progress", "review_done"]
    }
  })
  const result = projectBusinessModWorkflow(modules, workflow)
  expect(result.requiresFixedWorkflowAcknowledgement, result.diagnostics.join(";")).toBe(false)
  expect(result.routing.checkpoints.initial).toEqual(["prd_in_progress", "review_in_progress"])
  expect(result.routing.checkpoints.transitions.prd_done).toEqual(["review_in_progress"])
  expect(result.routing.checkpoints.transitions.review_done).toEqual(["specs_in_progress"])
})

it("keeps a restricted repair route and the original skip default without adding an unreviewed state edge", () => {
  const { workflow, modules } = fixture()
  const checkpoints = workflow.checkpoints as typeof reviewedWorkflow.checkpoints
  checkpoints.transitions.needs_fix = ["plan_in_progress"]
  ;(workflow.dynamicStages as typeof reviewedWorkflow.dynamicStages)[0].defaultDecision = "skip"
  const result = projectBusinessModWorkflow(modules, workflow)
  expect(result.requiresFixedWorkflowAcknowledgement).toBe(false)
  expect(result.routing.checkpoints.transitions.needs_fix).toEqual(["plan_in_progress"])
  expect(result.routing.dynamicStages[0].defaultDecision).toBe("skip")
})

it("requires an explicit fallback for partial multi-node branches and non-adjacent UI routes", () => {
  const partial = fixture()
  const stages = partial.workflow.dynamicStages as typeof reviewedWorkflow.dynamicStages
  stages[0].nodes.push({ ...structuredClone(stages[0].nodes[0]), id: "dev.another" })
  expect(
    projectBusinessModWorkflow(partial.modules, partial.workflow)
      .requiresFixedWorkflowAcknowledgement
  ).toBe(true)
  const nonlinear = fixture()
  ;(nonlinear.workflow.transitions as typeof reviewedWorkflow.transitions)[0].to.nodeId =
    "ops.archive"
  expect(
    projectBusinessModWorkflow(nonlinear.modules, nonlinear.workflow)
      .requiresFixedWorkflowAcknowledgement
  ).toBe(true)
})
