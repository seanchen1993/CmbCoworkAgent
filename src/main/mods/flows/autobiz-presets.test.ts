import { expect, it } from "vitest"
import { createAutobizPreset } from "../../../shared/mods/flows/autobiz-presets"
import type { FlowStepResult } from "../../../shared/mods/flows/types"
import { FlowManager } from "./manager"
import { FlowStore } from "./store"

let number = 0
async function executePreset(failures: number) {
  const settings = new Map<string, string>()
  const store = new FlowStore({
    getSetting: (key, fallback = "") => settings.get(key) ?? fallback,
    setSetting: (key, value) => {
      settings.set(key, value)
    }
  })
  const calls: string[] = []
  let checks = 0
  const result = (passed = true): FlowStepResult => ({
    passed,
    source: "native-check",
    summary: passed ? "passed" : "real check failure"
  })
  const manager = new FlowManager(store, {
    assertScope: () => {},
    changed: () => {},
    prepare: async () => ({
      assertLive: () => {},
      fingerprint: async () => "stable",
      execute: async (step) => {
        calls.push(step.id)
        return result(step.kind !== "check" || ++checks > failures)
      },
      finalize: async (_context, confirm) => {
        await confirm()
        return result()
      },
      dispose: async () => {}
    })
  })
  const thread = `autobiz-preset-${++number}`
  const saved = manager.save("workspace", createAutobizPreset("repair-retest", "repair"), 0)
  const started = await manager.start("workspace", thread, saved.definition.id, saved.revision)
  for (let attempt = 0; attempt < 400; attempt++) {
    const run = manager.run("workspace", thread, started.id)!
    if (run.pendingApproval)
      await manager.decide("workspace", thread, run.id, run.pendingApproval.nonce, true)
    if (["complete", "failed", "cancelled", "interrupted"].includes(run.status))
      return { run, calls }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw Error("preset did not settle")
}

it("skips every repair when initial real test passes", async () => {
  const { run, calls } = await executePreset(0)
  expect(run.status).toBe("complete")
  expect(calls).toEqual(["review", "unit", "report"])
})
it("repairs only after failure and reruns the native test", async () => {
  const { run, calls } = await executePreset(1)
  expect(run.status).toBe("complete")
  expect(calls).toEqual(["review", "unit", "repair", "retest", "report"])
})
it("bounds failed repairs and never reaches report or approval as success", async () => {
  const { run, calls } = await executePreset(99)
  expect(run.status).toBe("failed")
  expect(calls).toEqual(["review", "unit", "repair", "retest", "repair", "retest"])
})
