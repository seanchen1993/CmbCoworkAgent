import { describe, expect, it, vi } from "vitest"
import { resolveCompositionWorkflows } from "./composition-workflow"
import type { CompositionCatalogSnapshot } from "../../plugins/project-composition-catalog"
import type { NativeNodeContext } from "../node-composition"

function fixture() {
  const nodes = ["dev.specs", "dev.code", "ops.archive"]
    .map((id) => ({ id, label: id, description: "", inputs: [], outputs: [], optionalInputs: [] }))
  const context = {
    config: { nodes, templates: [{ id: "custom", templateType: "custom",
      nodes: [], requiredNodes: ["dev.code", "ops.archive"], label: "自选", description: "" }] },
    nodes,
    invocation: { cwd: "C:/plugin", invocation: {
      executable: "python", args: ["-X", "utf8", "C:/plugin/hooks/inspect_workflow_templates.py"]
    } }
  } as unknown as NativeNodeContext
  const source = { pluginId: "autobiz", capabilityId: "flow", packageDigest: "a".repeat(64) }
  const definition = { apiVersion: "devclaw.project-composition/v1", parentProjectId: "p",
    workspace: "C:/project", units: [{ id: "delivery", kind: "flow", source,
      inputs: [], outputs: [], workflow: { templateId: "custom", nodeIds: ["dev.code"] } }] }
  const snapshot = { sources: [{ nodeContext: context, capability: { kind: "flow", runtimeMode: "legacy" },
    entry: { source, available: true } }] } as unknown as CompositionCatalogSnapshot
  const run = vi.fn<(_invocation: NativeNodeContext["invocation"]) => Promise<unknown>>(async () => ({ ok: true, mode: "closure",
    closure: { nodes: nodes.map((node) => node.id), dropped: {} } }))
  const deps = { run, verify: vi.fn(async () => {}), assertCurrent: vi.fn() }
  return { definition, snapshot, deps }
}

describe("composition workflow selection", () => {
  it("calls the original closure and freezes prerequisites into the actual execution definition", async () => {
    const f = fixture()
    const resolved = await resolveCompositionWorkflows(f.definition, f.snapshot, f.deps)
    expect(resolved.units[0].workflow?.nodeIds).toEqual(["dev.specs", "dev.code", "ops.archive"])
    expect(f.definition.units[0].workflow.nodeIds).toEqual(["dev.code"])
    expect(f.deps.run.mock.calls[0]?.[0]).toMatchObject({ invocation: {
      args: expect.arrayContaining(["--mode", "closure", "--template", "custom", "--nodes", "dev.code", "--auto-include"])
    } })
    expect(f.deps.verify).toHaveBeenCalledTimes(2)
  })
  it("rejects unknown nodes and host flows before running any adapter", async () => {
    const f = fixture()
    f.definition.units[0].workflow.nodeIds = ["unknown"]
    await expect(resolveCompositionWorkflows(f.definition, f.snapshot, f.deps)).rejects.toThrow()
    expect(f.deps.run).not.toHaveBeenCalled()
    f.definition.units[0].workflow.nodeIds = ["dev.code"]
    const capability = f.snapshot.sources[0].capability
    if (capability.kind === "flow") capability.runtimeMode = "host"
    await expect(resolveCompositionWorkflows(f.definition, f.snapshot, f.deps)).rejects.toThrow()
    expect(f.deps.run).not.toHaveBeenCalled()
  })
  it("rejects a resolver that omits mandatory nodes or a source replaced during execution", async () => {
    const f = fixture()
    f.deps.run.mockResolvedValueOnce({ ok: true, mode: "closure", closure: { nodes: ["dev.code"], dropped: {} } })
    await expect(resolveCompositionWorkflows(f.definition, f.snapshot, f.deps)).rejects.toThrow("必选步骤")
    f.deps.verify.mockRejectedValueOnce(Error("source replaced"))
    await expect(resolveCompositionWorkflows(f.definition, f.snapshot, f.deps)).rejects.toThrow("source replaced")
    expect(f.deps.run).toHaveBeenCalledTimes(1)
  })
})
