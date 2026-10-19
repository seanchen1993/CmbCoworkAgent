import { expect, it } from "vitest"
import type { FlowRun, FlowStepResult } from "../../../shared/mods/flows/types"
import { parseFlowDefinition } from "../../../shared/mods/flows/schema"
import { FlowStore, flowDigest } from "./store"
import {
  originalFlowActionResult,
  publishOriginalFlowActionResult,
  captureNativeFlowActionFacts
} from "./action-execution-facts"
import { FlowManager } from "./manager"

function fixture() {
  const values = new Map<string, string>()
  const settings = {
    getSetting: (key: string, fallback = "") => values.get(key) ?? fallback,
    setSetting: (key: string, value: string) => {
      values.set(key, value)
    }
  }
  const store = new FlowStore(settings)
  const definition = parseFlowDefinition({
    schemaVersion: 2,
    execution: { kind: "host" },
    id: "action-facts",
    name: "Facts",
    goal: "Read an actual artifact",
    timeoutMs: 30000,
    maxExecutions: 3,
    steps: [
      {
        id: "check",
        name: "Check",
        enabled: true,
        kind: "plugin-action",
        pluginId: "installed",
        plugin: "reviewer",
        digest: "a".repeat(64),
        actionId: "review",
        command: "review",
        input: {}
      }
    ]
  })
  const run: FlowRun = {
    id: "run",
    threadId: "thread",
    workspace: "workspace",
    status: "running",
    startedAt: 1,
    epoch: 1,
    flow: { definition, digest: flowDigest(definition), revision: 1, updatedAt: 1 },
    attempts: [
      {
        stepId: "check",
        executionId: "actual-execution",
        attempt: 1,
        epoch: 1,
        status: "running",
        startedAt: 1
      }
    ],
    failureCounts: {}
  }
  const original: FlowStepResult = {
    passed: false,
    summary: "Actual failure",
    source: "plugin-action",
    provider: {
      pluginId: "installed",
      plugin: "reviewer",
      digest: "a".repeat(64),
      actionId: "review"
    },
    output: { passed: false, content: "actual bytes" }
  }
  store.put(run)
  return { store, settings, values, run, original }
}

it("retains original action facts across public result changes, ledger writes and restart", async () => {
  const f = fixture()
  const shown = await publishOriginalFlowActionResult(f.original, async (value) => ({
    ...value,
    passed: true,
    output: { passed: true, content: "public replacement" }
  }))
  expect(shown.passed).toBe(true)
  expect(originalFlowActionResult({ ...shown })).toBeUndefined()
  const actual = originalFlowActionResult(shown)!
  expect(actual).toEqual(f.original)
  f.store.recordActionResult(f.run, f.run.attempts[0], actual)
  f.run.attempts[0].status = "passed"
  f.run.attempts[0].result = shown
  f.run.status = "complete"
  f.store.put(f.run)
  const restored = new FlowStore(f.settings)
  expect(restored.actionResult("workspace", "thread", "run", "actual-execution")).toMatchObject({
    passed: false,
    output: { passed: false, content: "actual bytes" },
    executionId: "actual-execution"
  })
  expect(JSON.stringify(restored.run("workspace", "thread", "run"))).not.toContain(
    "__nativeActionFacts"
  )
  expect(restored.run("workspace", "thread", "run")?.attempts[0].result?.passed).toBe(true)
})

it("does not accept private fact fields from a public ledger projection and rejects tampered original output", () => {
  const f = fixture()
  const forged = structuredClone(f.run)
  Object.assign(forged.attempts[0], { __nativeActionFacts: { passed: true } })
  f.store.put(forged)
  expect(f.store.actionResult("workspace", "thread", "run", "actual-execution")).toBeUndefined()
  f.store.recordActionResult(f.run, f.run.attempts[0], f.original)
  const key = [...f.values.keys()].find((key) => key.includes('"runs"'))!
  f.values.set(key, f.values.get(key)!.replace('"content":"actual bytes"', '"content":"tampered"'))
  expect(() => f.store.actionResult("workspace", "thread", "run", "actual-execution")).toThrow(
    "FLOW_ACTION_FACTS_SCOPE_CHANGED"
  )
})

it("does not capture an oversized ordinary published result as mandatory evidence", async () => {
  const f = fixture()
  const shown = await publishOriginalFlowActionResult(
    { ...f.original, output: { body: "x".repeat(70 * 1024) } },
    async (value) => value
  )
  expect(shown.passed).toBe(false)
  expect(originalFlowActionResult(shown)).toBeUndefined()
})

it.each(["passed", "text", "contextText"])(
  "rejects tampering with the persisted original %s",
  async (field) => {
    const f = fixture()
    const shown = await publishOriginalFlowActionResult(
      f.original,
      async (value) => value,
      "actual required context"
    )
    f.store.recordActionResult(f.run, f.run.attempts[0], originalFlowActionResult(shown)!)
    const key = [...f.values.keys()].find((key) => key.includes('"runs"'))!
    const rows = JSON.parse(f.values.get(key)!)
    rows[0].attempts[0].__nativeActionFacts[field] = field === "passed" ? true : "replacement"
    f.values.set(key, JSON.stringify(rows))
    expect(() => f.store.actionResult("workspace", "thread", "run", "actual-execution")).toThrow(
      "FLOW_ACTION_FACTS_SCOPE_CHANGED"
    )
  }
)

it.each(["ordinary", "mandatory", "serialized"])(
  "persists original results only for an opaque host mandatory consumer (%s)",
  async (mode) => {
    const f = fixture()
    const manager = new FlowManager(f.store, {
      assertScope: () => {},
      changed: () => {},
      prepare: async () => ({
        assertLive: () => {},
        fingerprint: async () => "stable",
        execute: async () =>
          publishOriginalFlowActionResult(f.original, async (value) => ({
            ...value,
            passed: true
          })),
        finalize: async (_context, confirm) => {
          await confirm()
          return { passed: true, summary: "complete", source: "native-check" }
        },
        dispose: async () => {}
      })
    })
    let saved = { ...f.run.flow }
    if (mode !== "ordinary") captureNativeFlowActionFacts(saved)
    if (mode === "serialized") saved = structuredClone(saved)
    const run = await manager.startSaved("workspace", "thread", saved)
    await manager.waitForSettlement("workspace", "thread", run.id)
    const completed = f.store.run("workspace", "thread", run.id)!
    const actual = f.store.actionResult(
      "workspace",
      "thread",
      run.id,
      completed.attempts[0].executionId
    )
    if (mode === "mandatory") expect(actual?.passed).toBe(false)
    else expect(actual).toBeUndefined()
    expect(completed.status).toBe("complete")
    expect(completed.attempts[0].result?.passed).toBe(true)
  }
)
