import { describe, expect, it, vi } from "vitest"
import {
  bindLiveToolEvidence,
  traceCodeExecCalls,
  bindRuntimeTraceContext,
  captureRuntimeTraceParent
} from "./live-tool-evidence"
import { ModRuntimeAuthorities } from "../../mods/runtime-instance"
import type { McpCapabilityService } from "../../mcp/capability-types"
import type { TraceContext } from "./types"

function fixture() {
  const nodes: unknown[] = [],
    results: unknown[] = []
  const collector = {
    addToolNode: vi.fn((input) => {
      nodes.push(input)
      return `node-${nodes.length}`
    }),
    addToolResultNode: vi.fn((input) => {
      results.push(input)
      return `result-${results.length}`
    })
  }
  let active = true
  const context: TraceContext = {
    observabilitySchemaVersion: 1,
    traceKind: "root",
    executionMode: "normal",
    traceId: "trace",
    threadId: "thread",
    rootTraceId: "trace",
    rootThreadId: "thread",
    rootNodeId: "root"
  }
  bindLiveToolEvidence(context, collector, () => active)
  const result = {
    capabilityId: "mcp__test__call",
    raw: { secret: "never-store" },
    text: "never-store",
    isError: false
  }
  const service: McpCapabilityService = {
    listTools: vi.fn(async () => []),
    getTool: vi.fn(async () => null),
    invoke: vi.fn(async () => result),
    invalidate: vi.fn(async () => {}),
    close: vi.fn(async () => {})
  }
  return {
    context,
    collector,
    nodes,
    results,
    result,
    service,
    close: () => {
      active = false
    }
  }
}
describe("native runtime trace lineage", () => {
  it("captures immutable native lineage before an await and never writes to the ended parent", () => {
    const f = fixture(),
      registry = new ModRuntimeAuthorities()
    const owner = registry.create({ workspace: "workspace", threadId: "thread", turnId: "turn" })
    bindRuntimeTraceContext(owner.authority, f.context)
    const captured = captureRuntimeTraceParent(owner.authority)!
    f.context.traceId = "mutated"
    expect(captured.traceId).toBe("trace")
    expect(Object.isFrozen(captured)).toBe(true)
    f.close()
    expect(captured.traceId).toBe("trace")
    expect(captureRuntimeTraceParent(owner.authority)).toBeUndefined()
    expect(f.collector.addToolNode).not.toHaveBeenCalled()
    registry.close()
  })
  it("does not accept copied contexts, foreign threads or a forged runtime authority", () => {
    const f = fixture(),
      registry = new ModRuntimeAuthorities()
    const owner = registry.create({ workspace: "workspace", threadId: "thread", turnId: "turn" })
    bindRuntimeTraceContext(owner.authority, { ...f.context })
    expect(captureRuntimeTraceParent(owner.authority)).toBeUndefined()
    const foreign = registry.create({ workspace: "workspace", threadId: "foreign", turnId: "turn" })
    bindRuntimeTraceContext(foreign.authority, f.context)
    expect(captureRuntimeTraceParent(foreign.authority)).toBeUndefined()
    const forged = {
      ...owner.authority,
      assertLive() {
        /* A copied method cannot mint native identity. */
      }
    }
    bindRuntimeTraceContext(forged, f.context)
    expect(captureRuntimeTraceParent(forged)).toBeUndefined()
    registry.close()
  })
  it("does not lend old lineage to a replacement owner or an aborted source", () => {
    const f = fixture(),
      registry = new ModRuntimeAuthorities(),
      abort = new AbortController()
    const scope = { workspace: "workspace", threadId: "thread", turnId: "turn" }
    const first = registry.create(scope, abort.signal)
    bindRuntimeTraceContext(first.authority, f.context)
    abort.abort()
    expect(captureRuntimeTraceParent(first.authority)).toBeUndefined()
    const next = registry.create(scope)
    expect(captureRuntimeTraceParent(next.authority)).toBeUndefined()
    bindRuntimeTraceContext(next.authority, f.context)
    expect(captureRuntimeTraceParent(next.authority)?.traceId).toBe("trace")
    registry.close()
    expect(captureRuntimeTraceParent(next.authority)).toBeUndefined()
  })
  it("keeps missing or failing telemetry outside runtime admission", () => {
    const f = fixture(),
      registry = new ModRuntimeAuthorities()
    const owner = registry.create({ workspace: "workspace", threadId: "thread", turnId: "turn" })
    bindLiveToolEvidence(f.context, f.collector, () => {
      throw Error("observer unavailable")
    })
    expect(() => bindRuntimeTraceContext(owner.authority, f.context)).not.toThrow()
    expect(captureRuntimeTraceParent(owner.authority)).toBeUndefined()
    expect(() => owner.authority.assertLive()).not.toThrow()
    registry.close()
  })
})
describe("native CodeExec linked observations", () => {
  it("delegates the original call exactly once and records only bounded host metadata", async () => {
    const f = fixture(),
      traced = traceCodeExecCalls(f.service, f.context, "parent-call")
    const args = { secret: "never-store" },
      guard = () => {}
    expect(await traced.invoke("mcp__test__call", args, guard)).toBe(f.result)
    expect(f.service.invoke).toHaveBeenCalledExactlyOnceWith("mcp__test__call", args, guard)
    expect(f.nodes[1]).toMatchObject({
      parentId: "node-1",
      metadata: { parentToolCallId: "parent-call" }
    })
    expect(f.results[0]).toMatchObject({ parentId: "node-2", status: "success" })
    expect(JSON.stringify([f.nodes, f.results])).not.toContain("never-store")
  })
  it("cannot append through a serialized/cloned context or after collector finish", async () => {
    const f = fixture()
    expect(traceCodeExecCalls(f.service, { ...f.context })).toBe(f.service)
    const traced = traceCodeExecCalls(f.service, f.context)
    f.close()
    await traced.invoke("mcp__test__call", {})
    expect(f.nodes).toHaveLength(1)
    expect(f.results).toHaveLength(0)
  })
  it("preserves error identity and records native failed results without trusting their content", async () => {
    const f = fixture(),
      traced = traceCodeExecCalls(f.service, f.context)
    const error = Error("credential must not enter trace")
    vi.mocked(f.service.invoke)
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ ...f.result, isError: true })
    await expect(traced.invoke("bad name with credential", {})).rejects.toBe(error)
    await traced.invoke("mcp__test__call", {})
    expect(f.results).toHaveLength(2)
    expect(f.results.every((row) => (row as { status: string }).status === "error")).toBe(true)
    expect(JSON.stringify([f.nodes, f.results])).not.toContain("credential")
  })
  it("telemetry failure never prevents or retries the original execution", async () => {
    const f = fixture()
    f.collector.addToolNode.mockImplementation(() => {
      throw Error("telemetry")
    })
    const traced = traceCodeExecCalls(f.service, f.context)
    await traced.invoke("mcp__test__call", {})
    expect(f.service.invoke).toHaveBeenCalledTimes(1)
  })
  it("does not settle an in-flight observation when its native collector has ended", async () => {
    const f = fixture(),
      traced = traceCodeExecCalls(f.service, f.context)
    let finish!: (value: typeof f.result) => void
    vi.mocked(f.service.invoke).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const operation = traced.invoke("mcp__test__call", {})
    f.close()
    finish(f.result)
    await operation
    expect(f.nodes).toHaveLength(2)
    expect(f.results).toHaveLength(0)
  })
})
