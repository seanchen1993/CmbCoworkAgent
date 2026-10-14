import { readFileSync } from "node:fs"
import { setImmediate } from "node:timers/promises"
import { describe, expect, it, vi } from "vitest"
import { yieldBeforeStreamProjection } from "./stream-projection-yield"

const source = readFileSync(new URL("./agent.ts", import.meta.url), "utf8")
// Execute the actual three consumer cutpoints without bootstrapping Electron or a provider.
const cutpoints = [...source.matchAll(
  /if \(mode === "values" \|\| mode === "updates"\) \{\s+await yieldBeforeStreamProjection\(abortController.signal\)\s+(?:throwIfInvokeAborted\(\)|throwIfPhysicalStreamRunIsInactive\(threadId, runToken, abortController.signal\))\s+\}\s+const \{\s+data: serialized,\s+valuesMessageIndexOffset,\s+valuesSnapshotKind\s+\} = serializeForRun\(mode, data\)/g
)].map((match) => match[0])

describe("IPC snapshot projection scheduling", () => {
  it("keeps all three consumers fenced immediately before synchronous projection", () => {
    expect(cutpoints).toHaveLength(3)
    expect(cutpoints[0]).toContain("throwIfInvokeAborted()")
    expect(cutpoints.slice(1).every((point) =>
      point.includes("throwIfPhysicalStreamRunIsInactive(threadId, runToken, abortController.signal)")
    )).toBe(true)
  })

  for (const [index, cutpoint] of cutpoints.entries()) {
    const execute = new Function(
      "mode", "abortController", "yieldBeforeStreamProjection", "guard", "serializeForRun",
      `return (async () => {
        const threadId = "thread", runToken = "original", data = {}
        const throwIfInvokeAborted = guard, throwIfPhysicalStreamRunIsInactive = guard
        ${cutpoint}
      })()`
    ) as (
      mode: string, controller: AbortController, yieldProjection: typeof yieldBeforeStreamProjection,
      guard: () => void, serialize: () => object
    ) => Promise<void>

    it.each(["values", "updates"])(`consumer ${index} yields before %s and rechecks ownership`, async (mode) => {
      let inputDispatched = false
      const pendingInput = setImmediate().then(() => { inputDispatched = true })
      const guard = vi.fn(() => { expect(inputDispatched).toBe(true) })
      const serialize = vi.fn(() => {
        expect(guard).toHaveBeenCalledOnce()
        return { data: {} }
      })
      await execute(mode, new AbortController(), yieldBeforeStreamProjection, guard, serialize)
      await pendingInput
      expect(serialize).toHaveBeenCalledOnce()
    })

    it(`consumer ${index} does not serialize after cancellation during the yield`, async () => {
      const controller = new AbortController()
      const serialize = vi.fn()
      const pending = execute("values", controller, yieldBeforeStreamProjection, vi.fn(), serialize)
      controller.abort()
      await expect(pending).rejects.toMatchObject({ name: "AbortError" })
      expect(serialize).not.toHaveBeenCalled()
    })

    it(`consumer ${index} rejects a replacement owner even without aborting the old signal`, async () => {
      let owner = "original"
      const guard = () => {
        if (owner !== "original") throw Object.assign(new Error("aborted"), { name: "AbortError" })
      }
      const serialize = vi.fn()
      const pending = execute("updates", new AbortController(), yieldBeforeStreamProjection, guard, serialize)
      owner = "successor"
      await expect(pending).rejects.toMatchObject({ name: "AbortError" })
      expect(serialize).not.toHaveBeenCalled()
    })

    it(`consumer ${index} leaves token messages synchronous`, async () => {
      const yieldProjection = vi.fn(yieldBeforeStreamProjection)
      const serialize = vi.fn(() => ({ data: {} }))
      const pending = execute("messages", new AbortController(), yieldProjection, vi.fn(), serialize)
      expect(serialize).toHaveBeenCalledOnce()
      expect(yieldProjection).not.toHaveBeenCalled()
      await pending
    })
  }
})
