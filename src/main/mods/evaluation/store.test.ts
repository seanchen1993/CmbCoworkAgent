import { describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, dirname, basename } from "node:path"
import { ModControlStore } from "../control-store"
import { EvaluationStore } from "./store"
import { flowDigest } from "../flows/store"
import { parseFlowDefinition } from "../../../shared/mods/flows/schema"
import type { HostFlowDefinition, SavedFlow } from "../../../shared/mods/flows/types"

export function evaluationFlow(id = "baseline"): SavedFlow {
  const definition: HostFlowDefinition = {
    schemaVersion: 2,
    id,
    name: id,
    goal: "Check a fixed task",
    execution: { kind: "host", profile: "prompt-only-v1" },
    timeoutMs: 2000,
    maxExecutions: 3,
    steps: [
      {
        id: "agent",
        name: "Agent",
        enabled: true,
        kind: "agent",
        prompt: "Answer",
        modelId: "test-model"
      },
      { id: "test", name: "Test", enabled: true, kind: "check", check: "unit-test" }
    ]
  }
  const parsed = parseFlowDefinition(definition)
  return { definition: parsed, digest: flowDigest(parsed), revision: 1, updatedAt: 1 }
}
export function memoryEvaluationSettings() {
  const values = new Map<string, string>()
  return {
    values,
    getSetting: (key: string, fallback = "") => values.get(key) ?? fallback,
    compareAndSetSetting: (key: string, expected: string | undefined, value: string) => {
      if (values.get(key) !== expected) return false
      values.set(key, value)
      return true
    }
  }
}
export function initialEvaluation() {
  return {
    workspace: "workspace",
    threadId: "thread",
    baseline: evaluationFlow(),
    candidate: evaluationFlow("candidate"),
    provider: "controlled" as const,
    tasks: [{ id: "task", goal: "Fixed acceptance" }],
    budget: { timeoutMs: 10000, maxExecutions: 6 }
  }
}
describe("evaluation durable history", () => {
  it("uses the actual SQLite CAS across connections and preserves an external winning write", () => {
    const directory = mkdtempSync(join(tmpdir(), "evaluation-store-"))
    const first = new ModControlStore(join(directory, "control.sqlite"))
    const second = new ModControlStore(join(directory, "control.sqlite"))
    try {
      const a = new EvaluationStore(first),
        b = new EvaluationStore(second)
      const row = a.create(initialEvaluation())
      const copy = b.list("workspace", "thread")[0]
      a.put({ ...row, revision: 2, pending: { variant: "baseline", caseId: "task" } }, 1)
      expect(() => b.put({ ...copy, revision: 2 }, 1)).toThrow("STALE")
      const current = a.list("workspace", "thread")[0]
      const original = first.compareAndSetSetting.bind(first)
      vi.spyOn(first, "compareAndSetSetting").mockImplementationOnce((key, expected, value) => {
        second.setSetting(key, "[]")
        return original(key, expected, value)
      })
      expect(() => a.put({ ...current, revision: 3 }, 2)).toThrow("STALE")
      expect(b.list("workspace", "thread")).toEqual([])
    } finally {
      first.close()
      second.close()
      expect(dirname(resolve(directory))).toBe(resolve(tmpdir()))
      expect(basename(directory).startsWith("evaluation-store-")).toBe(true)
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it("atomically retains a launch marker and rejects stale writers and rewritten suites", () => {
    const settings = memoryEvaluationSettings(),
      a = new EvaluationStore(settings),
      b = new EvaluationStore(settings)
    const original = a.create(initialEvaluation())
    a.put({ ...original, revision: 2, pending: { variant: "baseline", caseId: "task" } }, 1)
    expect(() => b.put({ ...original, revision: 2 }, 1)).toThrow("STALE")
    const current = b.list("workspace", "thread")[0]
    expect(current.pending?.caseId).toBe("task")
    expect(() =>
      b.put({ ...current, revision: 3, tasks: [{ id: "task", goal: "changed" }] }, 2)
    ).toThrow("INVALID")
  })
  it("read returns detached data, scope is exact and terminal rows cannot restart", () => {
    const store = new EvaluationStore(memoryEvaluationSettings())
    const row = store.create(initialEvaluation())
    store.list("workspace", "thread")[0].tasks[0].goal = "tamper"
    expect(store.list("workspace", "thread")[0].tasks[0].goal).toBe("Fixed acceptance")
    expect(store.list("other", "thread")).toEqual([])
    const terminal = store.put({ ...row, revision: 2, state: "interrupted" }, 1)
    expect(() => store.put({ ...terminal, revision: 3, state: "running" }, 2)).toThrow("STALE")
  })
  it("does not accept missing atomic support or trim old records to make room", () => {
    expect(() => new EvaluationStore({ getSetting: () => "" }).create(initialEvaluation())).toThrow(
      "STALE"
    )
    const store = new EvaluationStore(memoryEvaluationSettings())
    for (let n = 0; n < 16; n++) store.create(initialEvaluation())
    expect(() => store.create(initialEvaluation())).toThrow("LIMIT")
    expect(store.list("workspace", "thread")).toHaveLength(16)
  })
  it("missing evidence cannot become a persisted pass", () => {
    const store = new EvaluationStore(memoryEvaluationSettings()),
      row = store.create(initialEvaluation())
    expect(() =>
      store.put(
        {
          ...row,
          revision: 2,
          results: {
            candidate: [],
            baseline: [
              {
                fact: {
                  caseId: "task",
                  runId: "run",
                  result: "passed",
                  evidenceIds: [],
                  humanTakeovers: 0,
                  durationMs: 10,
                  modelCalls: null,
                  inputTokens: null,
                  outputTokens: null
                },
                environmentDigest: null,
                modelFingerprint: null,
                reasons: []
              }
            ]
          }
        },
        1
      )
    ).toThrow("INVALID")
  })
})
