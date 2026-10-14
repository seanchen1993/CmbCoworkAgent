import { describe, expect, it, vi } from "vitest"
import { FlowManager } from "./manager"
import { FlowStore, flowDigest } from "./store"
import type { FlowRun } from "../../../shared/mods/flows/types"
import type { FlowRecoveryObservation } from "./recovery"
import { parseFlowDefinition } from "../../../shared/mods/flows/schema"

function fixture() {
  const settings = new Map<string, string>()
  const setSetting = vi.fn((key: string, value: string) => {
    settings.set(key, value)
  })
  const store = new FlowStore({
    getSetting: (key, fallback = "") => settings.get(key) ?? fallback,
    setSetting
  })
  const definition = parseFlowDefinition({
    schemaVersion: 2 as const,
    execution: { kind: "host" as const },
    id: "flow",
    name: "Flow",
    goal: "Goal",
    timeoutMs: 10000,
    maxExecutions: 16,
    steps: [{ id: "edit", name: "Edit", enabled: true, kind: "agent" as const, prompt: "Edit" }]
  })
  const run: FlowRun = {
    id: "source",
    workspace: "workspace",
    threadId: "thread",
    status: "running",
    flow: { definition, digest: flowDigest(definition), revision: 1, updatedAt: 1 },
    startedAt: 1,
    epoch: 0,
    attempts: [],
    failureCounts: {}
  }
  store.put(run)
  setSetting.mockClear()
  const host = {
    assertScope: vi.fn(),
    prepare: vi.fn(),
    changed: vi.fn(),
    observeRecovery: vi.fn(
      async (): Promise<FlowRecoveryObservation> => ({ authority: "unverified" })
    )
  }
  const manager = new FlowManager(store, host)
  return { manager, host, store, setSetting, run }
}

describe("read-only recovery lookup", () => {
  it("does not repair running history, prepare executors or broadcast", async () => {
    const f = fixture()
    const before = f.store.run("workspace", "thread", "source")
    const result = await f.manager.recovery("workspace", "thread", "source")
    expect(result.status).toBe("blocked")
    expect(f.store.run("workspace", "thread", "source")).toEqual(before)
    expect(f.setSetting).not.toHaveBeenCalled()
    expect(f.host.prepare).not.toHaveBeenCalled()
    expect(f.host.changed).not.toHaveBeenCalled()
  })
  it("rejects source changes during an asynchronous read", async () => {
    const f = fixture()
    f.host.observeRecovery.mockImplementation(async () => {
      f.store.put({ ...f.run, summary: "changed" })
      return { authority: "unverified" }
    })
    await expect(f.manager.recovery("workspace", "thread", "source")).rejects.toThrow(
      "FLOW_RECOVERY_STALE"
    )
  })
  it("rechecks scope before publishing and does not prepare after revocation", async () => {
    const f = fixture()
    f.host.assertScope
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw Error("revoked")
      })
    await expect(f.manager.recovery("workspace", "thread", "source")).rejects.toThrow("revoked")
    expect(f.setSetting).not.toHaveBeenCalled()
    expect(f.host.prepare).not.toHaveBeenCalled()
  })
  it("does not observe a run from another workspace or thread", async () => {
    const f = fixture()
    await expect(f.manager.recovery("other", "thread", "source")).rejects.toThrow(
      "FLOW_RUN_MISSING"
    )
    await expect(f.manager.recovery("workspace", "other", "source")).rejects.toThrow(
      "FLOW_RUN_MISSING"
    )
    expect(f.host.observeRecovery).not.toHaveBeenCalled()
  })
  it("does not permit an observer to mutate the persisted source", async () => {
    const f = fixture()
    f.host.observeRecovery.mockImplementation(async (observed?: FlowRun) => {
      observed!.status = "complete"
      return { authority: "unverified" }
    })
    expect((await f.manager.recovery("workspace", "thread", "source")).status).toBe("blocked")
    expect(f.store.run("workspace", "thread", "source")?.status).toBe("running")
  })
})
