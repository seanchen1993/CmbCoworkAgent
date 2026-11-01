import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { runInNewContext } from "node:vm"
import { installGuestDisposeDiagnostic } from "./support/mods-guest-dispose-diagnostic"

const checks: string[] = []
{
  const returned = Promise.resolve("original-return")
  const calls: unknown[][] = [],
    records: Record<string, unknown>[] = []
  const prototype = {
    dispose(this: unknown, ...args: unknown[]) {
      calls.push([this, ...args])
      return returned
    }
  }
  const original = Object.getOwnPropertyDescriptor(prototype, "dispose")!
  const receiver = Object.assign(Object.create(prototype), {
    cpuMs: 501,
    cpuWindow: performance.now() - 2000,
    disposed: false
  })
  const control = installGuestDisposeDiagnostic(prototype, (record) => {
    assert.equal(Object.getOwnPropertyDescriptor(prototype, "dispose")!.value, original.value)
    records.push(record)
  })
  assert.equal(receiver.dispose("MODS_BUDGET_EXCEEDED", true), returned)
  assert.deepEqual(calls, [[receiver, "MODS_BUDGET_EXCEEDED", true]])
  assert.equal(records[0].cpuMs, 501)
  assert.equal(records[0].guestFailure, true)
  assert.equal(records[0].originalMethodRestoredBeforeCall, true)
  assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, "dispose"), original)
  assert.equal(control.restore(), true)
  assert.equal(control.restore(), true)
  checks.push(
    "original this/arguments/Promise identity and full descriptor restoration before delegation"
  )
}
{
  const thrown = new Error("original-throw"),
    records: Record<string, unknown>[] = []
  let getterCalls = 0,
    calls = 0
  const prototype = {
    dispose() {
      calls++
      throw thrown
    }
  }
  const receiver = Object.create(prototype)
  Object.defineProperty(receiver, "cpuMs", {
    get() {
      getterCalls++
      throw Error("must not invoke")
    }
  })
  const control = installGuestDisposeDiagnostic(prototype, (record) => {
    records.push(record)
    throw Error("emit failed")
  })
  assert.throws(
    () => receiver.dispose(),
    (error) => error === thrown
  )
  assert.equal(calls, 1)
  assert.equal(getterCalls, 0)
  assert.equal(records[0].cpuMs, "unknown")
  assert.equal(records[0].cpuWindow, "unknown")
  assert.equal(records[0].code, "MODS_UNLOADED")
  assert(control.failures.includes("emit-failed"))
  checks.push(
    "getters are never invoked; absent fields unknown; emission failure preserves original throw"
  )
}
{
  let calls = 0
  const prototype = {
    dispose() {
      calls++
      return "original"
    }
  }
  const control = installGuestDisposeDiagnostic(prototype, () => {})
  const wrapped = prototype.dispose
  const replacement = () => "other-owner"
  prototype.dispose = replacement
  assert.equal(Reflect.apply(wrapped, {}, ["KEEP", false]), "original")
  assert.equal(calls, 1)
  assert.equal(prototype.dispose, replacement)
  assert.equal(control.restore(), false)
  assert(control.failures.includes("restore-owner-conflict"))
  checks.push(
    "concurrent owner replacement is never overwritten and an admitted call still delegates"
  )
}
{
  let calls = 0
  const records: Record<string, unknown>[] = []
  const prototype = {
    dispose() {
      calls++
      return "original"
    }
  }
  const control = installGuestDisposeDiagnostic(prototype, (record) => records.push(record))
  Object.freeze(prototype)
  assert.equal(Reflect.apply(prototype.dispose, {}, []), "original")
  assert.equal(calls, 1)
  assert.equal(records[0].originalMethodRestoredBeforeCall, false)
  assert(control.failures.includes("restore-failed"))
  checks.push("a failed descriptor restoration never suppresses the original dispose")
}
{
  const prototype = {}
  Object.defineProperty(prototype, "dispose", {
    get() {
      throw Error("must not invoke")
    }
  })
  assert.throws(() => installGuestDisposeDiagnostic(prototype, () => {}), /OWN_DISPOSE_DATA/)
  checks.push("accessor method rejected without invoking it")
}
void (async () => {
  const entry = readFileSync(join(__dirname, "support/mods-v2-performance-entry.ts"), "utf8")
  const start = entry.lastIndexOf("    if (diagnosticDispose) {")
  const end = entry.indexOf("    await setProfile(0, false)", start)
  assert(start > 0 && end > start, "ACTUAL_PERFORMANCE_PHASE_BRANCH_REQUIRED")
  const branch = entry.slice(start, end)
  for (const diagnosticDispose of [true, false])
    for (const phase of ["all", "matrix", "idle", "soak"]) {
      const calls: string[] = []
      const context = {
        diagnosticDispose,
        options: { phase, warmups: 2, samples: 3 },
        report: {},
        active: new Set([{ stats: { pid: 123 } }]),
        save: () => {},
        setProfile: async (count: number) => {
          calls.push(`profile:${count}`)
        },
        event: async () => {
          calls.push("event")
        },
        matrix: async () => {
          calls.push("matrix")
        },
        idle: async () => {
          calls.push("idle")
        },
        soak: async () => {
          calls.push("soak")
        }
      }
      await runInNewContext(`(async () => {let phase;${branch}})()`, context)
      if (diagnosticDispose)
        assert.deepEqual(calls, ["profile:1", ...Array<string>(6).fill("event")])
      else assert.deepEqual(calls, phase === "all" ? ["matrix", "idle", "soak"] : [phase])
    }
  checks.push(
    "actual diagnostic entry remains one bounded plugin even for phase=all; formal phases unchanged"
  )
  console.log(JSON.stringify({ passed: checks.length, checks }))
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
