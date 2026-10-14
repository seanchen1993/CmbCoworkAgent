import { describe, expect, it, vi } from "vitest"
import {
  NativeNodeComposition,
  nativeClosureInvocation,
  validateNativeClosure,
  type NativeNodeContext
} from "./node-composition"
import type { HarnessFeatureCreateInput } from "../../shared/harness-board-types"

function fixture() {
  const context = {
    fingerprint: "original",
    sourceIdentity: "source-original",
    project: { projectId: "p", name: "Project" },
    config: {
      templates: [
        {
          id: "custom",
          templateType: "custom",
          requiredNodes: ["finish"],
          label: "自选",
          description: "",
          nodes: []
        }
      ],
      nodes: ["prepare", "build", "finish"].map((id) => ({ id, label: id, description: "" }))
    },
    nodes: [],
    invocation: {
      cwd: "C:/owned/plugin",
      invocation: {
        executable: "python.exe",
        args: ["-X", "utf8", "C:/owned/plugin/hooks/inspect_workflow_templates.py"]
      }
    }
  } as unknown as NativeNodeContext
  const read = vi.fn(async () => structuredClone(context))
  const run = vi.fn<(_invocation: NativeNodeContext["invocation"]) => Promise<unknown>>(
    async () => ({
      ok: true,
      mode: "closure",
      closure: { nodes: ["prepare", "build", "finish"], dropped: {} }
    })
  )
  const verify = vi.fn(async (original: NativeNodeContext) => {
    if (original.sourceIdentity !== context.sourceIdentity) throw Error("项目或插件已变化")
  })
  const spawn = vi.fn()
  const create = vi.fn(
    async (_input: HarnessFeatureCreateInput, guard: () => void | Promise<void>) => {
      await guard()
      spawn()
      return {
        projectId: "p",
        slug: "feature",
        title: "feature",
        workspacePath: "C:/owned/project"
      }
    }
  )
  return {
    context,
    read,
    run,
    create,
    verify,
    spawn,
    service: new NativeNodeComposition({ context: read, run, create, verify })
  }
}
const input = {
  projectId: "p",
  feature: "feature",
  sessionWorkspace: { source: "directory", path: "C:/owned/project" }
} as HarnessFeatureCreateInput

describe("native project node composition", () => {
  it("rechecks source identity after queued preparation and before the real adapter spawn", async () => {
    const f = fixture()
    const plan = await f.service.preview("owner", "work", "p", "custom", ["build"], () => {})
    f.create.mockImplementationOnce(async (_input, guard) => {
      // Simulate replacement while waiting for the process semaphore.
      f.context.sourceIdentity = "source-replaced-in-queue"
      await guard()
      f.spawn()
      throw Error("must not reach spawn")
    })
    const reads = f.read.mock.calls.length
    await expect(f.service.create("owner", "work", plan.planId, input, () => {})).rejects.toThrow(
      "项目或插件已变化"
    )
    expect(f.verify).toHaveBeenCalledTimes(1)
    expect(f.read).toHaveBeenCalledTimes(reads + 1)
    expect(f.spawn).not.toHaveBeenCalled()
  })
  it("adds original prerequisites and submits reviewed closure, ignoring renderer configuration", async () => {
    const f = fixture(),
      guard = vi.fn()
    const plan = await f.service.preview("owner", "work", "p", "custom", ["build"], guard)
    expect(plan.added).toEqual(["prepare", "finish"])
    expect(f.run.mock.calls[0]?.[0]).toBeDefined()
    expect(f.create).not.toHaveBeenCalled()
    const tampered = {
      ...input,
      workflowNodes: ["build"],
      workflowConfig: { templates: [], nodes: [] }
    }
    await f.service.create("owner", "work", plan.planId, tampered, guard)
    expect(f.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowNodes: ["prepare", "build", "finish"],
        workflowConfig: f.context.config
      }),
      expect.any(Function)
    )
    await f.service.create("owner", "work", plan.planId, tampered, guard)
    expect(f.create).toHaveBeenCalledTimes(1)
  })
  it("rejects missing requirements, dropped inputs, reordered results and unknown nodes", () => {
    const { context } = fixture()
    for (const closure of [
      { nodes: ["build"], dropped: {} },
      { nodes: ["prepare", "build", "finish"], dropped: { build: ["spec.md"] } },
      { nodes: ["build", "prepare", "finish"], dropped: {} },
      { nodes: ["prepare", "build", "finish", "invented"], dropped: {} }
    ])
      expect(() =>
        validateNativeClosure(context, "custom", ["build"], { ok: true, mode: "closure", closure })
      ).toThrow()
  })
  it("rejects source change, expired scope and cross-owner confirmation before execution", async () => {
    const f = fixture()
    const plan = await f.service.preview("a", "work", "p", "custom", ["build"], () => {})
    await expect(f.service.create("b", "work", plan.planId, input, () => {})).rejects.toThrow()
    await expect(
      f.service.create("a", "work", plan.planId, input, () => {
        throw Error("scope changed")
      })
    ).rejects.toThrow("scope changed")
    f.context.fingerprint = "changed"
    await expect(f.service.create("a", "work", plan.planId, input, () => {})).rejects.toThrow(
      "项目或插件已变化"
    )
    expect(f.create).not.toHaveBeenCalled()
  })
  it("requires a known adapter command and passes arguments without shell interpolation", () => {
    const { context } = fixture()
    expect(nativeClosureInvocation(context, "custom", ["build"]).invocation.args.slice(-7)).toEqual(
      ["--mode", "closure", "--template", "custom", "--nodes", "build", "--auto-include"]
    )
    context.invocation.invocation.args.push("--execute", "business")
    expect(() => nativeClosureInvocation(context, "custom", ["build"])).toThrow()
  })
  it("allows only explicitly optional original inputs and reports them for review", () => {
    const f = fixture()
    f.context.nodes = f.context.config.nodes.map((node) => ({
      ...node,
      inputs: node.id === "build" ? ["detail.md"] : [],
      optionalInputs: node.id === "build" ? ["detail.md"] : [],
      outputs: []
    }))
    const response = {
      ok: true,
      mode: "closure",
      closure: { nodes: ["prepare", "build", "finish"], dropped: { build: ["detail.md"] } }
    }
    expect(
      validateNativeClosure(f.context, "custom", ["build"], response).optionalOmissions
    ).toEqual([{ nodeId: "build", path: "detail.md" }])
    f.context.nodes[1].optionalInputs = []
    expect(() => validateNativeClosure(f.context, "custom", ["build"], response)).toThrow(
      "必需输入"
    )
  })
  it("rejects optional omissions from a node outside the reviewed closure", () => {
    const f = fixture()
    f.context.nodes = f.context.config.nodes.map((node) => ({
      ...node,
      inputs: [],
      outputs: [],
      optionalInputs: ["detail.md"]
    }))
    expect(() =>
      validateNativeClosure(f.context, "custom", ["build"], {
        ok: true,
        mode: "closure",
        closure: { nodes: ["build", "finish"], dropped: { prepare: ["detail.md"] } }
      })
    ).toThrow("必需输入")
  })
  it("does not retry an uncertain create or invoke adapter on invalid selection", async () => {
    const f = fixture()
    await expect(
      f.service.preview("a", "work", "p", "custom", ["build,other"], () => {})
    ).rejects.toThrow()
    expect(f.run).not.toHaveBeenCalled()
    const plan = await f.service.preview("a", "work", "p", "custom", ["build"], () => {})
    f.create.mockRejectedValueOnce(Error("lost response"))
    await expect(f.service.create("a", "work", plan.planId, input, () => {})).rejects.toThrow(
      "lost response"
    )
    await expect(f.service.create("a", "work", plan.planId, input, () => {})).rejects.toThrow(
      "已提交"
    )
    expect(f.create).toHaveBeenCalledTimes(1)
  })
})
