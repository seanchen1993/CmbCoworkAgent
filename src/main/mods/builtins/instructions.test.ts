import { describe, expect, it } from "vitest"
import type { BuiltinInstructionsSnapshot } from "../../../shared/mods/builtin-instructions"
import { BuiltinInstructionsStore } from "./instructions"

const scope = { threadId: "thread", workspace: "/workspace", incarnationKey: "first" }
function snapshot(runId: string): BuiltinInstructionsSnapshot {
  return {
    schemaVersion: 1,
    threadId: scope.threadId,
    runId,
    workspace: scope.workspace,
    capturedAt: 123,
    origin: "host",
    status: "observed",
    observation: "host-context-assembly",
    entries: [
      {
        path: "/workspace/AGENTS.md",
        layer: "project",
        scope: "/workspace",
        workspace: "/workspace",
        delivery: "truncated",
        reason: "budget"
      }
    ],
    limitations: []
  }
}

describe("instruction observations", () => {
  it("does not revive facts across workspace changes or thread reincarnation", () => {
    const store = new BuiltinInstructionsStore()
    const token = store.begin(scope, "run")
    expect(store.capture(scope, token, snapshot("run"))).toBe(true)
    expect(store.read(scope).snapshot?.entries[0].delivery).toBe("truncated")
    expect(store.read({ ...scope, workspace: "/other" }).status).toBe("unknown")
    expect(store.read({ ...scope, incarnationKey: "second" }).status).toBe("unknown")
    expect(new BuiltinInstructionsStore().read(scope).status).toBe("unknown")
  })

  it("clears prior facts on a new run and rejects an older slow assembly", () => {
    const store = new BuiltinInstructionsStore()
    const old = store.begin(scope, "old")
    store.capture(scope, old, snapshot("old"))
    const latest = store.begin(scope, "latest")
    expect(store.read(scope).status).toBe("unknown")
    expect(store.capture(scope, old, snapshot("old"))).toBe(false)
    expect(store.capture(scope, latest, snapshot("old"))).toBe(false)
    expect(store.capture(scope, latest, snapshot("latest"))).toBe(true)
    expect(store.begin(scope, "latest")).toBe(latest)
    expect(store.read(scope).snapshot?.runId).toBe("latest")
  })

  it("keeps reads detached and retention bounded", () => {
    const store = new BuiltinInstructionsStore(1)
    const data = snapshot("run")
    store.capture(scope, store.begin(scope, "run"), data)
    data.entries[0].reason = "changed outside"
    const read = store.read(scope)
    read.snapshot!.entries.length = 0
    expect(store.read(scope).snapshot?.entries[0].reason).toBe("budget")
    store.begin({ ...scope, threadId: "another" }, "run")
    expect(store.read(scope).status).toBe("unknown")
  })

  it("binds final observations to a run and request without replacing assembly facts", () => {
    const store = new BuiltinInstructionsStore()
    const token = store.begin(scope, "run")
    store.capture(scope, token, snapshot("run"))
    const final = {
      requestId: "request",
      observedAt: 124,
      result: "modified" as const,
      reason: "hook"
    }
    expect(store.observeFinal(scope, token, "wrong", final)).toBe(false)
    expect(store.observeFinal(scope, token, "run", final)).toBe(true)
    expect(store.observeFinal(scope, token, "run", final)).toBe(false)
    const result = store.read(scope).snapshot!
    expect(result.entries[0].delivery).toBe("truncated")
    expect(result.finalRequests).toEqual([final])
  })
})

it("retains child facts separately and rejects old parent run/incarnation callbacks", () => {
  const store = new BuiltinInstructionsStore()
  const sequence = store.begin(scope, "parent")
  store.capture(scope, sequence, snapshot("parent"))
  const child = {
    ...snapshot("child"),
    threadId: "child-thread",
    agentId: "worker",
    childSource: "independent-runtime" as const
  }
  expect(store.captureChild(scope, sequence, child)).toBe(true)
  expect(store.read(scope).snapshot?.runId).toBe("parent")
  expect(store.read(scope).snapshot?.children?.[0].threadId).toBe("child-thread")
  const request = {
    requestId: "request",
    observedAt: 124,
    result: "confirmed" as const,
    reason: "actual"
  }
  expect(store.observeChildFinal(scope, sequence, "child", request)).toBe(true)
  expect(
    store.observeChildFinal({ ...scope, incarnationKey: "new" }, sequence, "child", request)
  ).toBe(false)
  for (let i = 0; i < 40; i++)
    store.captureChild(scope, sequence, { ...child, runId: `child-${i}` })
  expect(store.read(scope).snapshot?.children).toHaveLength(32)
  store.begin(scope, "next")
  expect(store.captureChild(scope, sequence, child)).toBe(false)
  expect(store.observeChildFinal(scope, sequence, "child", request)).toBe(false)
})

it("distinguishes nested Task records sharing role and turn under different runtime instances", () => {
  const store = new BuiltinInstructionsStore()
  const sequence = store.begin(scope, "root")
  store.capture(scope, sequence, snapshot("root"))
  for (const runtime of ["workflow-child-a", "workflow-child-b"]) {
    const runId = JSON.stringify([runtime, "same-role", "same-turn"])
    expect(
      store.captureChild(scope, sequence, {
        ...snapshot(runId),
        agentId: "same-role",
        childSource: "task-model-boundary"
      })
    ).toBe(true)
    expect(
      store.observeChildFinal(scope, sequence, runId, {
        requestId: runtime,
        observedAt: 1,
        result: "confirmed",
        reason: "actual child request"
      })
    ).toBe(true)
  }
  expect(store.read(scope).snapshot?.children).toHaveLength(2)
  expect(store.read(scope).snapshot?.finalRequests).toBeUndefined()
})
