import { describe, expect, it } from "vitest"
import { FlowStore, flowDigest } from "./store"
import { createAutobizFlow, createHostReviewFlow } from "../../../shared/mods/flows/templates"
import type { FlowRun } from "../../../shared/mods/flows/types"

describe("flow persistence", () => {
  function fixture() {
    const data = new Map<string, string>()
    const settings = {
      getSetting: (key: string, fallback = "") => data.get(key) ?? fallback,
      setSetting: (key: string, value: string) => {
        data.set(key, value)
      }
    }
    return { data, settings, store: new FlowStore(settings) }
  }
  it("persists exact order/revision, isolates projects and rejects lost updates", () => {
    const f = fixture()
    const flow = createAutobizFlow("plugin")
    const first = f.store.save("A", flow, 0)
    const restored = new FlowStore(f.settings)
    expect(restored.get("A", flow.id)).toEqual(first)
    expect(restored.list("B")).toEqual([])
    expect(() => restored.save("A", flow, 0)).toThrow("REVISION")
    const next = restored.save("A", { ...flow, name: "revision2" }, 1)
    expect(next.revision).toBe(2)
    expect(next.digest).not.toBe(first.digest)
  })
  it("reads mixed legacy and host definitions after restart without rewriting legacy digests", () => {
    const f = fixture()
    const canonical =
      '{"schemaVersion":1,"id":"old","name":"Old","plugin":"owner","goal":"Work","timeoutMs":1000,"maxExecutions":8,"steps":[{"id":"a","name":"A","enabled":true,"kind":"agent","prompt":"Review"}]}'
    const definition = JSON.parse(canonical)
    const legacy = { definition, digest: flowDigest(definition), revision: 7, updatedAt: 1 }
    const key = JSON.stringify(["diy-flow-v1", "definitions", "A"])
    f.data.set(key, JSON.stringify([legacy]))
    const modern = f.store.save("A", createHostReviewFlow("modern"), 0)
    const restarted = new FlowStore(f.settings)
    expect(restarted.list("A")).toEqual([legacy, modern])
    expect(JSON.stringify(restarted.get("A", "old")!.definition)).toBe(canonical)
    const bytes = f.data.get(key)
    restarted.list("A")
    expect(f.data.get(key)).toBe(bytes)
    expect(restarted.save("A", { ...modern.definition, name: "Next" }, 1).revision).toBe(2)
    expect(restarted.get("A", "old")).toEqual(legacy)
  })
  it("detects persisted definition corruption instead of silently disabling execution", () => {
    const f = fixture()
    f.store.save("A", createAutobizFlow("plugin"), 0)
    const key = [...f.data.keys()][0]
    const rows = JSON.parse(f.data.get(key)!)
    rows[0].definition.goal = "tampered"
    f.data.set(key, JSON.stringify(rows))
    expect(() => f.store.list("A")).toThrow("STORAGE_INVALID")
  })
  it("bounds history and keeps the newest run", () => {
    const f = fixture()
    const flow = f.store.save("A", createAutobizFlow("plugin"), 0)
    for (let n = 0; n < 25; n++) {
      const run: FlowRun = {
        id: `run-${n}`,
        workspace: "A",
        threadId: "thread",
        flow,
        startedAt: n,
        status: "complete",
        epoch: 0,
        attempts: [],
        failureCounts: {}
      }
      f.store.put(run)
    }
    expect(f.store.runs("A", "thread")).toHaveLength(20)
    expect(f.store.runs("A", "thread")[0].id).toBe("run-24")
    expect(f.store.runs("B", "thread")).toEqual([])
  })
})
