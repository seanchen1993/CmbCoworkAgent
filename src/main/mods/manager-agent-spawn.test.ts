import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ModsManager } from "./manager"
import { withFunctionAgentExecution } from "./v2/host-call"
import type { FunctionTurnComplete } from "../../shared/mods/v2/turn"
import type { FunctionAgentPlan } from "./v2/agent-spawn-host"
import type { ModObject } from "../../shared/mods/types"
import type { RegisteredFunctionAgent } from "./v2/agent-registry"
import type { ModDispatchRequest } from "./engine"
import { bindLiveToolEvidence, bindRuntimeTraceContext } from "../agent/trace/live-tool-evidence"
import type { TraceContext } from "../agent/trace/types"

const hooks = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock("./v2/agent-spawn-host", () => ({
  prepareFunctionAgentPlan: async (
    input: Record<string, unknown>,
    workspace: string,
    _model: unknown,
    registered?: RegisteredFunctionAgent
  ) => ({
    prompt: input.prompt,
    description: input.description,
    type: "general-purpose",
    model: "custom:model",
    workspace,
    modelFingerprint: "snapshot",
    ...(registered
      ? {
          registered: structuredClone(registered),
          role: { systemPrompt: registered.spec.prompt, disallowedTools: [] },
          maxTurns: registered.spec.maxTurns
        }
      : {})
  }),
  runFunctionAgentChild: (...args: unknown[]) => hooks.run(...args)
}))
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
  vi.clearAllMocks()
})

function fixture(approve = vi.fn(async () => true)) {
  const root = mkdtempSync(path.join(tmpdir(), "mods-agent-manager-"))
  const manager = new ModsManager(
    path.join(root, "control.db"),
    () => [],
    approve,
    () => {}
  )
  manager.configure(root, true, false)
  const workspace = manager.workspaceKey(root)
  const instance = manager.createRuntimeAuthority({ workspace, threadId: "parent", turnId: "turn" })
  manager.bindThread({ ...instance.authority, runtimeAuthority: instance.authority })
  manager.bindFunctionSession(instance.authority, "custom:model")
  const grant = manager.store.grant(workspace, "function:review", "digest", true)
  const lifetime = new AbortController()
  const startup = new AbortController()
  const terminal = Promise.withResolvers<FunctionTurnComplete>()
  let ownedSignal: AbortSignal | undefined
  hooks.run.mockImplementation(
    async (
      host: ModsManager,
      plan: FunctionAgentPlan,
      context: {
        agentId: string
        signal: AbortSignal
        started(id: string): void
      }
    ) => {
      ownedSignal = context.signal
      const physical = `physical:${context.agentId}`
      const child = host.createRuntimeAuthority({
        workspace: plan.workspace,
        threadId: physical,
        agentId: context.agentId,
        turnId: "child-turn",
        signal: context.signal
      })
      host.bindFunctionPeerEndpoint(child.authority)
      context.started(physical)
      try {
        return await terminal.promise
      } finally {
        host.closeFunctionThread(physical)
      }
    }
  )
  cleanup.push(() => {
    lifetime.abort()
    terminal.resolve({
      answer: "done",
      reason: "answer",
      isAborted: false,
      durationMs: 1,
      turnId: "child-turn"
    })
    manager.close()
    rmSync(root, { recursive: true, force: true })
  })
  let previousInput: ModObject | undefined
  const spawn = (repeat = false) =>
    withFunctionAgentExecution(
      {
        workspace,
        threadId: "parent",
        turnId: "turn",
        agentId: "main",
        runtimeAuthority: instance.authority,
        userInitiated: false,
        leased: false,
        immediate: false
      },
      async () => {
        const input = repeat
          ? previousInput!
          : await manager.prepareFunctionAgentSpawn(
              workspace,
              "parent",
              grant,
              { prompt: "review changes" },
              startup.signal
            )
        previousInput = input
        return manager.spawnFunctionAgent(
          workspace,
          "parent",
          grant,
          input,
          startup.signal,
          lifetime.signal
        )
      }
    )
  return {
    manager,
    workspace,
    instance,
    grant,
    lifetime,
    startup,
    terminal,
    spawn,
    approve,
    signal: () => ownedSignal
  }
}

describe("owned agent spawn lifecycle", () => {
  it("captures only the original native lineage before approval, independent of parent trace ending", async () => {
    const decision = Promise.withResolvers<boolean>()
    const f = fixture(vi.fn(() => decision.promise))
    let active = true
    const context: TraceContext = {
      observabilitySchemaVersion: 1,
      traceKind: "root",
      executionMode: "normal",
      traceId: "actual-parent-trace",
      threadId: "parent",
      rootTraceId: "actual-parent-trace",
      rootThreadId: "parent"
    }
    bindLiveToolEvidence(
      context,
      { addToolNode: () => "node", addToolResultNode: () => "result" },
      () => active
    )
    bindRuntimeTraceContext(f.instance.authority, context)
    const pending = f.spawn()
    await vi.waitFor(() => expect(f.approve).toHaveBeenCalled())
    active = false
    context.traceId = "mutated-after-approval"
    decision.resolve(true)
    await pending
    expect(hooks.run.mock.calls[0][2].parentTrace).toMatchObject({
      traceId: "actual-parent-trace",
      threadId: "parent"
    })
    expect(Object.isFrozen(hooks.run.mock.calls[0][2].parentTrace)).toBe(true)
  })
  it("rechecks the creator binding after approval before starting a native child", async () => {
    const decision = Promise.withResolvers<boolean>()
    const f = fixture(vi.fn(() => decision.promise))
    let live = true
    f.manager.bindThread({
      ...f.instance.authority,
      runtimeAuthority: f.instance.authority,
      assertLive: () => {
        if (!live) throw Error("MODS_FS_WRITE_LEASE")
      }
    })
    const pending = f.spawn()
    const rejected = expect(pending).rejects.toThrow("MODS_FS_WRITE_LEASE")
    await vi.waitFor(() => expect(f.approve).toHaveBeenCalled())
    live = false
    decision.resolve(true)
    await rejected
    expect(hooks.run).not.toHaveBeenCalled()
  })
  it("keeps host context available to a no-tool role without authorizing nested plugin capabilities", async () => {
    const f = fixture()
    const invokeTool = vi.fn()
    const binding = {
      ...f.instance.authority,
      runtimeAuthority: f.instance.authority,
      allowedToolNames: new Set<string>(),
      invokeTool
    }
    f.manager.bindThread(binding)
    const context = vi.fn(async (request: ModDispatchRequest) => {
      request.assertScope?.()
      await expect(request.invokeTool!("host:read_file", {}, f.grant, false)).rejects.toThrow(
        "MODS_RUNTIME_TOOL_DENIED"
      )
      return []
    })
    const scoped = f.manager as unknown as { session(): Promise<unknown> }
    vi.spyOn(scoped, "session").mockResolvedValue({ refs: 0, engine: { context } })
    expect(await f.manager.context(binding)).toEqual([])
    expect(context).toHaveBeenCalledOnce()
    expect(invokeTool).not.toHaveBeenCalled()
  })
  it("approves one immutable role snapshot and intersects its allowlist with parent restrictions", async () => {
    const decision = Promise.withResolvers<boolean>()
    const f = fixture(vi.fn(() => decision.promise))
    const role: RegisteredFunctionAgent = {
      name: "lab:review",
      plugin: "lab",
      spec: {
        name: "review",
        description: "Review",
        prompt: "Original role",
        tools: ["Read", "Write"],
        maxTurns: 2
      }
    }
    f.manager.attachFunctions({
      registeredAgent: () => structuredClone(role),
      invalidate: vi.fn(),
      closeThread: vi.fn(),
      close: vi.fn()
    })
    const binding = {
      ...f.instance.authority,
      runtimeAuthority: f.instance.authority,
      blockedToolNames: new Set(["write_file"]),
      readOnly: true
    }
    f.manager.bindThread(binding)
    f.manager.bindFunctionToolCatalog(binding, [
      { name: "read_file", description: "Read", mcp: false },
      { name: "write_file", description: "Write", mcp: false }
    ])
    const promise = f.spawn()
    await vi.waitFor(() => expect(f.approve).toHaveBeenCalled())
    role.spec.prompt = "Replacement role"
    role.spec.maxTurns = 100
    decision.resolve(true)
    await promise
    const plan = hooks.run.mock.calls[0][1]
    expect(plan).toMatchObject({
      role: { systemPrompt: "Original role" },
      allowedToolNames: ["read_file"],
      maxTurns: 2,
      readOnly: true
    })
    expect((f.approve.mock.calls as unknown as unknown[][])[0][3]).toMatchObject({
      rolePrompt: "Original role",
      maxTurns: 2,
      allowedTools: ["read_file"]
    })
  })
  it("persists one operation receipt and prevents repeated next from launching twice", async () => {
    const f = fixture()
    const handle = await f.spawn()
    await expect(f.spawn(true)).rejects.toThrow("MODS_CALL_ALREADY_STARTED")
    expect(hooks.run).toHaveBeenCalledOnce()
    expect(
      f.manager.store.audit(f.workspace).find((row) => row.toolId === "agent.spawn")?.status
    ).toBe("running")
    f.terminal.resolve({
      answer: "done",
      reason: "answer",
      isAborted: false,
      durationMs: 1,
      turnId: "child-turn"
    })
    await handle.completion
    expect(
      f.manager.store.audit(f.workspace).find((row) => row.toolId === "agent.spawn")?.status
    ).toBe("succeeded")
  })
  it("requires explicit native approval before any child starts", async () => {
    const f = fixture(vi.fn(async () => false))
    await expect(f.spawn()).rejects.toThrow("MODS_OPERATION_REJECTED")
    expect(hooks.run).not.toHaveBeenCalled()
  })

  it("returns started without waiting for completion and survives caller frame/parent runtime ending", async () => {
    const f = fixture()
    const handle = await f.spawn()
    expect(handle.value).toMatchObject({
      model: "custom:model",
      agentId: expect.stringContaining("mods-agent:")
    })
    expect(f.approve).toHaveBeenCalledWith(
      "parent",
      "function:review",
      "host:agent.spawn",
      expect.objectContaining({
        prompt: "review changes",
        model: "custom:model",
        background: true
      }),
      expect.any(AbortSignal),
      expect.any(String)
    )
    f.startup.abort()
    f.instance.release()
    expect(f.signal()?.aborted).toBe(false)
    f.terminal.resolve({
      answer: "done",
      reason: "answer",
      isAborted: false,
      durationMs: 1,
      turnId: "child-turn",
      agentId: handle.value.agentId as string
    })
    expect((await handle.completion).answer).toBe("done")
  })

  it("cancels the existing child on module disposal and on global invalidation", async () => {
    const f = fixture()
    const handle = await f.spawn()
    f.lifetime.abort()
    expect(f.signal()?.aborted).toBe(true)
    f.terminal.resolve({
      answer: "cancelled",
      reason: "aborted",
      isAborted: true,
      durationMs: 1,
      turnId: "child-turn"
    })
    await handle.completion
    const other = fixture()
    const second = await other.spawn()
    other.manager.invalidateAll()
    expect(other.signal()?.aborted).toBe(true)
    other.terminal.resolve({
      answer: "cancelled",
      reason: "aborted",
      isAborted: true,
      durationMs: 1,
      turnId: "child-turn"
    })
    await second.completion
  })

  it("rechecks cancellation after approval without launching", async () => {
    const gate = Promise.withResolvers<boolean>()
    const f = fixture(vi.fn(() => gate.promise))
    const pending = f.spawn()
    await vi.waitFor(() => expect(f.approve).toHaveBeenCalledOnce())
    f.startup.abort(new Error("stopped"))
    gate.resolve(true)
    await expect(pending).rejects.toThrow("stopped")
    expect(hooks.run).not.toHaveBeenCalled()
  })
})
