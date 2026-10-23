import { describe, expect, it } from "vitest"
import type { BusinessModDefinition } from "../../shared/business-mods"
import {
  assertWorkflowReplacementPreservesChecks,
  inspectBusinessWorkflow,
  transformBusinessWorkflow
} from "./business-workflow-transform"

function stage(id: string, input?: string): BusinessModDefinition {
  return {
    id,
    title: id,
    node: {
      id,
      skill: id,
      checkpoints: [`${id}_active`, `${id}_done`],
      validators: ["required"],
      guards: ["safe"],
      hookDefinitions: [{ event: "Stop", required: true }],
      artifacts: {
        inputs: input ? [{ id: "input", path: input, required: true, schemaVersion: "1.0.0" }] : [],
        outputs: [
          {
            id: "output",
            path: `${id}.json`,
            required: true,
            artifactType: "json",
            extract: { degrade: "Preserve this original output policy." },
            schemaVersion: "1.0.0",
            schema: { type: "object" }
          }
        ]
      }
    },
    skill: { entry: `skills/${id}/SKILL.md`, resources: [`skills/${id}/knowledge.md`] },
    resources: [],
    dependencies: { required: [], advisory: [] },
    checks: { validators: ["required"], guards: ["safe"] }
  }
}
const original = [stage("design"), stage("build", "design.json")]
function transform(changes: Parameters<typeof transformBusinessWorkflow>[0]["changes"]) {
  return transformBusinessWorkflow({
    modules: original,
    sourceDigest: "a".repeat(64),
    expectedWorkflowDigest: inspectBusinessWorkflow(original).digest,
    changes
  })
}

describe("generic immutable workflow transformation", () => {
  it("defaults to protecting current contracts while allowing native source baselines to evolve unpublished additions", () => {
    const added = stage("normalize")
    const first = transform([{ kind: "insert", before: "design", module: added }])
    const changed = structuredClone(added)
    const artifacts = changed.node.artifacts as { outputs: Array<Record<string, unknown>> }
    artifacts.outputs[0].schema = {
      type: "object",
      required: ["revision"],
      properties: { revision: { minimum: 2 } }
    }
    const input = {
      modules: first.modules,
      sourceDigest: "a".repeat(64),
      expectedWorkflowDigest: first.workflow.digest,
      changes: [{ kind: "replace_step" as const, id: added.id, module: changed }]
    }
    expect(() => transformBusinessWorkflow(input)).toThrow(
      "BUSINESS_WORKFLOW_REQUIRED_OUTPUT_REMOVED"
    )
    expect(
      transformBusinessWorkflow({ ...input, protectedModules: original }).workflow.stages[0]
        .outputs[0].schema
    ).toEqual(artifacts.outputs[0].schema)
    const weakenedOriginal = structuredClone(original[0])
    const originalArtifacts = weakenedOriginal.node.artifacts as { outputs: unknown[] }
    originalArtifacts.outputs = []
    expect(() =>
      transformBusinessWorkflow({
        ...input,
        protectedModules: original,
        changes: [{ kind: "replace_step", id: "design", module: weakenedOriginal }]
      })
    ).toThrow("BUSINESS_WORKFLOW_REQUIRED_OUTPUT_REMOVED")
  })
  it("preserves existing checkpoint identities used by original business Hooks", () => {
    const replacement = structuredClone(original[0])
    replacement.node.checkpoints = ["different_active", "different_done"]
    expect(() =>
      transform([{ kind: "replace_step", id: replacement.id, module: replacement }])
    ).toThrow("BUSINESS_WORKFLOW_REQUIRED_CHECK_REMOVED")
  })
  it.each(["C:/outside.json", "C:outside.json", "bad\0.json", "bad\n.json"])(
    "rejects an unsafe relative artifact path %j",
    (path) => {
      const replacement = structuredClone(original[0])
      const artifacts = replacement.node.artifacts as { outputs: Array<{ path: string }> }
      artifacts.outputs[0].path = path
      expect(() => inspectBusinessWorkflow([replacement])).toThrow(
        "BUSINESS_WORKFLOW_CONTRACT_INVALID"
      )
    }
  )
  it("inserts a real stage and exposes its state route without mutating the source or inventing execution", () => {
    const inserted = stage("normalize")
    const result = transform([{ kind: "insert", before: "design", module: inserted }])
    expect(result.order).toEqual(["normalize", "design", "build"])
    expect(result.workflow.transitions[1]).toMatchObject({
      from: "normalize_done",
      to: "design_active"
    })
    expect(result).toMatchObject({
      evidence: "invalidated",
      execution: "unverified",
      replacements: []
    })
    expect(original.map((mod) => mod.id)).toEqual(["design", "build"])
  })
  it("binds native extension dependencies into the workflow digest", () => {
    const source = stage("design")
    source.dependencies.required = ["knowledge"]
    expect(inspectBusinessWorkflow([source]).diagnostics[0].code).toBe(
      "UPSTREAM_DEPENDENCY_MISSING"
    )
    expect(inspectBusinessWorkflow([source], ["knowledge"]).diagnostics).toEqual([])
    expect(inspectBusinessWorkflow([source], ["knowledge"]).digest).not.toBe(
      inspectBusinessWorkflow([source], ["other"]).digest
    )
  })
  it("rejects stale edits and leaves source unchanged", () => {
    expect(() =>
      transformBusinessWorkflow({
        modules: original,
        sourceDigest: "a".repeat(64),
        expectedWorkflowDigest: "b".repeat(64),
        changes: []
      })
    ).toThrow("BUSINESS_WORKFLOW_CHANGED")
    expect(original[0].node.skill).toBe("design")
  })
  it("changes a Skill while retaining its original knowledge closure", () => {
    const result = transform([
      {
        kind: "replace_skill",
        id: "design",
        skillName: "design-v2",
        skill: { entry: "skills/design-v2/SKILL.md", resources: [] }
      }
    ])
    expect(result.modules[0].skill.resources).toContain("skills/design/knowledge.md")
    expect(result.replacements).toEqual(["design"])
    expect(result.workflow.digest).not.toBe(inspectBusinessWorkflow(original).digest)
  })
  it.each([
    [
      "validator",
      (mod: BusinessModDefinition) => {
        mod.checks.validators = []
        mod.node.validators = []
      }
    ],
    [
      "guard",
      (mod: BusinessModDefinition) => {
        mod.checks.guards = []
        mod.node.guards = []
      }
    ],
    [
      "Hook",
      (mod: BusinessModDefinition) => {
        delete mod.node.hookDefinitions
      }
    ],
    [
      "knowledge",
      (mod: BusinessModDefinition) => {
        mod.skill.resources = []
      }
    ],
    [
      "output",
      (mod: BusinessModDefinition) => {
        const artifacts = mod.node.artifacts as { outputs: unknown[] }
        artifacts.outputs = []
      }
    ],
    [
      "schema",
      (mod: BusinessModDefinition) => {
        const artifacts = mod.node.artifacts as { outputs: Array<Record<string, unknown>> }
        artifacts.outputs[0].schema = {}
      }
    ],
    [
      "output type",
      (mod: BusinessModDefinition) => {
        const artifacts = mod.node.artifacts as { outputs: Array<Record<string, unknown>> }
        artifacts.outputs[0].artifactType = "file"
      }
    ],
    [
      "output extraction policy",
      (mod: BusinessModDefinition) => {
        const artifacts = mod.node.artifacts as { outputs: Array<Record<string, unknown>> }
        delete artifacts.outputs[0].extract
      }
    ]
  ])("does not remove the original required %s during step replacement", (_name, weaken) => {
    const replacement = structuredClone(original[0])
    weaken(replacement)
    expect(() => transform([{ kind: "replace_step", id: "design", module: replacement }])).toThrow(
      /BUSINESS_WORKFLOW_REQUIRED_/
    )
  })
  it("rejects missing producers, incompatible schema versions and duplicate output owners", () => {
    const missing = stage("missing", "absent.json")
    expect(() => transform([{ kind: "insert", before: "design", module: missing }])).toThrow(
      "BUSINESS_WORKFLOW_LINKS_INVALID"
    )
    const changed = structuredClone(original[1])
    const changedArtifacts = changed.node.artifacts as { inputs: Array<Record<string, unknown>> }
    changedArtifacts.inputs[0].schemaVersion = "2.0.0"
    expect(inspectBusinessWorkflow([original[0], changed]).diagnostics[0].code).toBe(
      "INPUT_VERSION_MISMATCH"
    )
    const duplicate = stage("duplicate")
    const duplicateArtifacts = duplicate.node.artifacts as {
      outputs: Array<Record<string, unknown>>
    }
    duplicateArtifacts.outputs[0].path = "design.json"
    expect(() => transform([{ kind: "insert", before: "build", module: duplicate }])).toThrow(
      "BUSINESS_WORKFLOW_LINKS_INVALID"
    )
  })
  it("allows sequential artifact refinement only when the next stage explicitly consumes that exact prior artifact version", () => {
    const refinement = stage("refine", "design.json")
    const artifacts = refinement.node.artifacts as {
      inputs: Array<Record<string, unknown>>
      outputs: Array<Record<string, unknown>>
    }
    artifacts.inputs[0].id = "output"
    artifacts.outputs[0].path = "design.json"
    expect(inspectBusinessWorkflow([original[0], refinement]).diagnostics).toEqual([])
    artifacts.inputs[0].required = false
    expect(inspectBusinessWorkflow([original[0], refinement]).diagnostics[0].code).toBe(
      "OUTPUT_PRODUCER_AMBIGUOUS"
    )
    artifacts.inputs[0].required = true
    artifacts.outputs[0].schemaVersion = "2.0.0"
    expect(inspectBusinessWorkflow([original[0], refinement]).diagnostics[0].code).toBe(
      "OUTPUT_PRODUCER_AMBIGUOUS"
    )
  })
  it("rejects removal of required native stage check references and human approval", () => {
    const source = stage("native")
    source.host = {
      stage: { actionIds: [], artifactIds: ["report"], checkIds: ["exists"], approval: "human" },
      actions: [],
      artifacts: [{ id: "report", path: "report.json", required: true }],
      checks: [{ id: "exists", artifactId: "report", kind: "file-exists", sideEffect: "read" }],
      environment: []
    }
    const next = structuredClone(source)
    next.host!.stage.checkIds = []
    expect(() => assertWorkflowReplacementPreservesChecks(source, next)).toThrow(
      "BUSINESS_WORKFLOW_REQUIRED_CHECK_REMOVED"
    )
    next.host!.stage.checkIds = ["exists"]
    next.host!.stage.approval = "none"
    expect(() => assertWorkflowReplacementPreservesChecks(source, next)).toThrow(
      "BUSINESS_WORKFLOW_REQUIRED_CHECK_REMOVED"
    )
  })
})
