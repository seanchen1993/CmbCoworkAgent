import { AsyncResource } from "node:async_hooks"
import { describe, expect, it } from "vitest"
import { FunctionGuestRuntime } from "../mods/v2/guest-runtime"
import {
  captureRunCancellationRequest,
  confirmRunCancellationSettlement,
  createRunCancellationSettlement,
  invalidateRunCancellationSettlement,
  markRunCancellationEffectDispatched,
  observeRunCancellationEffect,
  recordRunCancellation,
  settledRunCancellationTerminal,
  withRunCancellationSettlement
} from "./run-cancellation-settlement"

const confirmed = { outcome: "error", code: "cancelled_before_effect_dispatch" }
const unknown = { outcome: "unknown", code: "unknown" }

describe("original run cancellation proof", () => {
  it("requires both original cancellation and physical settlement, never an empty ledger alone", async () => {
    const scope = createRunCancellationSettlement()
    await scope.run(async () => {
      confirmRunCancellationSettlement(true)
      expect(settledRunCancellationTerminal()).toEqual(unknown)
      recordRunCancellation()
      expect(scope.read().confirmed).toBe(false)
      confirmRunCancellationSettlement(true)
      expect(settledRunCancellationTerminal()).toEqual(confirmed)
    })
    expect(scope.read()).toEqual({ requested: true, confirmed: true })
    await expect(scope.run(async () => {})).rejects.toThrow("FRAME_REUSED")
  })

  it.each(["settlement", "authority", "effect"])("keeps the %s veto monotonic", async (veto) => {
    await withRunCancellationSettlement(async () => {
      if (veto === "effect") markRunCancellationEffectDispatched()
      if (veto === "authority") invalidateRunCancellationSettlement()
      recordRunCancellation()
      if (veto === "settlement") confirmRunCancellationSettlement(false)
      confirmRunCancellationSettlement(true)
      expect(settledRunCancellationTerminal()).toEqual(unknown)
    })
  })

  it("a failed original Stop callback cannot certify cancellation", async () => {
    await withRunCancellationSettlement(async () => {
      const controller = new AbortController()
      const stop = captureRunCancellationRequest(() => {
        throw Error("owner revoked")
      })
      try {
        expect(stop).toThrow("owner revoked")
      } finally {
        controller.abort()
      }
      expect(controller.signal.aborted).toBe(true)
      confirmRunCancellationSettlement(true)
      expect(settledRunCancellationTerminal()).toEqual(unknown)
    })
  })

  it("keeps a late transport callback bound to its original closed frame", async () => {
    const external = new AsyncResource("outside-run")
    const scope = createRunCancellationSettlement()
    let writes = 0
    let callback!: () => void
    await scope.run(async () => {
      callback = observeRunCancellationEffect(() => {
        writes++
      })
      recordRunCancellation()
      confirmRunCancellationSettlement(true)
    })
    expect(scope.read().confirmed).toBe(true)
    expect(() => external.runInAsyncScope(callback)).toThrow("ADMISSION_CLOSED")
    expect(writes).toBe(0)
    expect(scope.read().confirmed).toBe(false)
    external.emitDestroy()
  })

  it("isolates concurrent runs and treats a nested producer as an effect of its parent", async () => {
    const a = createRunCancellationSettlement()
    const b = createRunCancellationSettlement()
    await Promise.all([
      a.run(async () => {
        await withRunCancellationSettlement(async () => {
          recordRunCancellation()
          confirmRunCancellationSettlement(true)
          expect(settledRunCancellationTerminal()).toEqual(confirmed)
        })
        recordRunCancellation()
        confirmRunCancellationSettlement(true)
      }),
      b.run(async () => {
        await Promise.resolve()
        recordRunCancellation()
        confirmRunCancellationSettlement(true)
      })
    ])
    expect(a.read().confirmed).toBe(false)
    expect(b.read().confirmed).toBe(true)
  })

  it("does not change ordinary completed-run callback admission", async () => {
    let callback!: () => number
    await withRunCancellationSettlement(async () => {
      callback = observeRunCancellationEffect(() => 42)
    })
    expect(callback()).toBe(42)
  })

  it.each([false, true])(
    "actual Function describe SDK dispatch vetoes cancellation (throw=%s)",
    async (fail) => {
      const guest = await FunctionGuestRuntime.create(
        'var __cmbFunctionMod={register(on){on("tool.describe",async($)=>({text:await $.session.id()}))}}'
      )
      const scope = createRunCancellationSettlement()
      let hostCalls = 0
      try {
        await scope.run(async () => {
          const result = guest.invoke(
            "0",
            {},
            async () => {
              hostCalls++
              if (fail) throw Error("SDK unavailable")
              return { value: "thread" }
            },
            {
              event: "tool.describe",
              origin: { plugin: "engine", tier: "core" },
              capabilities: ["session.id"],
              plugin: { name: "probe", root: "/probe" }
            }
          )
          if (fail) await expect(result).rejects.toThrow()
          else await expect(result).resolves.toEqual({ value: { text: "thread" } })
          recordRunCancellation()
          confirmRunCancellationSettlement(true)
        })
        expect(hostCalls).toBe(1)
        expect(scope.read().confirmed).toBe(false)
      } finally {
        guest.dispose()
      }
    }
  )
})
