import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createProjectRuntimePlatformProvider,
  type NativeProjectRuntimeScope,
  type ProjectRuntimePlatformDependencies
} from "./platform-project-runtime-provider"
import { platformDescriptor } from "./platform-capabilities-validation"
import type { NativePlatformCallContext } from "./platform-capabilities-types"
import type { ModObject } from "../../../shared/mods/types"
import { hostProjectFixture } from "../../harness-board/project-runtime/host-fixtures.test-helper"

afterEach(() => vi.restoreAllMocks())
function fixture() {
  let active = true
  const context: NativePlatformCallContext = {
    threadId: "thread",
    workspace: "/workspace",
    incarnation: "incarnation",
    generation: "native-1",
    caller: { name: "consumer", provider: "consumer", digest: "source", generation: "caller-1" },
    signal: new AbortController().signal,
    assertCurrent() {
      if (!active) throw Error("AUTHORITY_REVOKED")
    },
    invoke: vi.fn(),
    publish: vi.fn()
  }
  const project = {
    ...hostProjectFixture("/workspace"),
    schemaVersion: 1 as const,
    stateOwner: "host" as const,
    version: 1,
    stageIndex: 0,
    status: "active" as const,
    createdAt: 1,
    updatedAt: 1
  }
  const scope: NativeProjectRuntimeScope = {
    project,
    operation: {
      schemaVersion: 1,
      operationId: "operation",
      projectId: project.projectId,
      expectedVersion: 1,
      stageId: "draft",
      idempotencyKey: "key",
      inputFingerprint: "input",
      pluginDigest: project.pluginDigest,
      status: "succeeded",
      createdAt: 1,
      updatedAt: 2,
      cancelRequestedAt: null,
      startedAt: 1,
      execution: { threadId: "thread", terminal: null },
      approval: null,
      receipts: [
        {
          schemaVersion: 1,
          operationId: "operation",
          projectId: project.projectId,
          stageId: "draft",
          pluginDigest: project.pluginDigest,
          inputFingerprint: "input",
          checkId: "check",
          artifactFingerprint: "artifact",
          result: "passed",
          validatorVersion: "1",
          checkedAt: 2
        }
      ]
    },
    historyLimited: false,
    assertCurrent: vi.fn(),
    assertAuthority: vi.fn(),
    preflight: vi.fn(async () => "input-identity")
  }
  const executeNative = vi.fn<NonNullable<ProjectRuntimePlatformDependencies["executeNative"]>>(
    async () => ({ status: "completed", projectVersion: 2, operationStatus: "transitioned" })
  )
  const deps = { resolve: vi.fn((): NativeProjectRuntimeScope | undefined => scope), executeNative }
  const provider = createProjectRuntimePlatformProvider(deps)
  const call = (action: string, input: ModObject) =>
    provider.act(context, action, input) as Promise<ModObject>
  return {
    context,
    scope,
    deps,
    provider,
    call,
    executeNative,
    revoke() {
      active = false
    }
  }
}

describe("scoped native project runtime capability", () => {
  it("projects required and recorded result decisions without exposing the approving actor", async () => {
    const f = fixture()
    f.scope.project.manifest.stages[0].resultApproval = "human"
    expect(await f.provider.read!(f.context)).toMatchObject({
      resultApprovalRequired: true,
      recordedResultDecision: "none"
    })
    expect(JSON.stringify(await f.provider.read!(f.context))).not.toContain("actorId")
  })
  it("does not retain a late preflight after provider shutdown", async () => {
    const f = fixture()
    vi.mocked(f.scope.preflight).mockImplementation(async () => {
      await f.provider.close!()
      return "input"
    })
    await expect(f.call("preflight", { kind: "continue" })).rejects.toThrow("CLOSED")
    expect(f.executeNative).not.toHaveBeenCalled()
  })
  it("discovers without loading Host and exposes no approval or arbitrary project selector", () => {
    const f = fixture()
    expect(platformDescriptor(f.provider.descriptor)).toEqual(f.provider.descriptor)
    expect(f.deps.resolve).not.toHaveBeenCalled()
    expect(f.provider.descriptor.actions.map((item) => item.id)).toEqual([
      "inspect-workflow-evidence",
      "inspect",
      "preflight",
      "request"
    ])
  })
  it("keeps an unbound simple Mod independent of the runtime", async () => {
    const f = fixture()
    f.deps.resolve.mockReturnValue(undefined)
    expect(await f.provider.read!(f.context)).toMatchObject({
      status: "unavailable",
      reviewAvailable: false
    })
    await expect(f.call("preflight", { kind: "continue" })).rejects.toThrow("UNBOUND")
    expect(f.scope.preflight).not.toHaveBeenCalled()
  })
  it("projects bounded real receipts without private native paths or approval objects", async () => {
    const f = fixture()
    f.scope.project.goal = "secret goal C:/private"
    f.scope.operation.receipts = Array.from({ length: 80 }, () => f.scope.operation.receipts[0])
    const value = await f.call("inspect", {})
    expect(value).toMatchObject({ summary: { operationStatus: "succeeded" }, historyLimited: true })
    expect(value.checks).toHaveLength(64)
    expect(JSON.stringify(value)).not.toContain("private")
    expect(f.scope.preflight).not.toHaveBeenCalled()
    expect(f.executeNative).not.toHaveBeenCalled()
  })
  it.each<[string, ModObject]>([
    ["inspect", { projectId: "foreign" }],
    ["inspect", { workspace: "/other" }],
    ["preflight", { kind: "continue", actorId: "user" }],
    ["preflight", { kind: "approve" }],
    ["preflight", { kind: "continue", approved: true }],
    ["request", { planId: "forged", contextProviderApproval: { allowNetworkSideEffects: true } }]
  ])("rejects injected scope and authority before native resolution: %s", async (action, input) => {
    const f = fixture()
    await expect(f.call(action, input)).rejects.toThrow("INPUT_INVALID")
    expect(f.deps.resolve).not.toHaveBeenCalled()
  })
  it("rechecks real inputs, then returns the original native command result", async () => {
    const f = fixture()
    const plan = await f.call("preflight", { kind: "continue" })
    expect(plan).toMatchObject({ executionGranted: false, canReview: true })
    expect(f.executeNative).not.toHaveBeenCalled()
    expect(await f.call("request", { planId: plan.planId })).toEqual({
      status: "completed",
      kind: "continue",
      projectVersion: 2,
      operationStatus: "transitioned"
    })
    expect(f.scope.preflight).toHaveBeenCalledTimes(2)
    expect(f.executeNative.mock.calls[0][0]).toMatchObject({
      expectedVersion: 1,
      operationId: "operation"
    })
    await expect(f.call("request", { planId: plan.planId })).rejects.toThrow("PLAN_UNKNOWN")
  })
  it("does not confuse a rejected native confirmation with execution", async () => {
    const f = fixture()
    f.executeNative.mockResolvedValue({ status: "rejected" })
    const plan = await f.call("preflight", { kind: "cancel" })
    expect(await f.call("request", { planId: plan.planId })).toEqual({
      status: "rejected",
      kind: "cancel"
    })
  })
  it.each(["digest", "generation", "name"] as const)("binds a plan to caller %s", async (field) => {
    const f = fixture()
    const plan = await f.call("preflight", { kind: "continue" })
    f.context.caller[field] = "different"
    await expect(f.call("request", { planId: plan.planId })).rejects.toThrow("PLAN_UNKNOWN")
    expect(f.executeNative).not.toHaveBeenCalled()
  })
  it("rejects version changes, changed inputs, and expired preparations", async () => {
    const f = fixture()
    const plan = await f.call("preflight", { kind: "continue" })
    f.scope.project.version++
    await expect(f.call("request", { planId: plan.planId })).rejects.toThrow("PLAN_CHANGED")
    f.scope.project.version--
    vi.mocked(f.scope.preflight).mockResolvedValue("changed")
    await expect(f.call("request", { planId: plan.planId })).rejects.toThrow("PLAN_CHANGED")
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60 * 1000)
    await expect(f.call("request", { planId: plan.planId })).rejects.toThrow("PLAN_UNKNOWN")
    expect(f.executeNative).not.toHaveBeenCalled()
  })
  it("consumes a dispatched plan even when the native response is lost", async () => {
    const f = fixture()
    f.executeNative.mockRejectedValue(Error("private C:/credential"))
    const plan = await f.call("preflight", { kind: "reconcile" })
    await expect(f.call("request", { planId: plan.planId })).rejects.toThrow("NATIVE_UNAVAILABLE")
    await expect(f.call("request", { planId: plan.planId })).rejects.toThrow("PLAN_UNKNOWN")
    expect(f.executeNative).toHaveBeenCalledOnce()
  })
  it("refuses late results after authority revocation", async () => {
    const f = fixture()
    vi.mocked(f.scope.preflight).mockImplementation(async () => {
      f.revoke()
      return "input"
    })
    await expect(f.call("preflight", { kind: "continue" })).rejects.toThrow("AUTHORITY_REVOKED")
    expect(f.executeNative).not.toHaveBeenCalled()
  })
  it("does not claim a native confirmation endpoint when none is connected", async () => {
    const f = fixture()
    const provider = createProjectRuntimePlatformProvider({ resolve: f.deps.resolve })
    expect(await provider.act(f.context, "preflight", { kind: "continue" })).toMatchObject({
      canReview: false,
      executionGranted: false
    })
  })
})
