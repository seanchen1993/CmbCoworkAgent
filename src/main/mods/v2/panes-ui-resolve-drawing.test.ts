import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { isModObject } from "../../../shared/mods/v2/contracts"
import type { FunctionPaneSnapshot } from "../../../shared/mods/v2/ui"
import { FunctionPanes } from "./panes"
import {
  currentFunctionUiResolveDrawing,
  withFunctionUiResolveDrawing,
  type FunctionUiResolveDrawing
} from "./ui-resolve-drawing"

const registries: FunctionPanes[] = []
afterEach(() => {
  for (const panes of registries.splice(0)) panes.close()
})

function fixture() {
  const drawings: FunctionUiResolveDrawing[] = []
  let failPublication = false
  let held:
    | {
        entered: ReturnType<typeof Promise.withResolvers<void>>
        release: ReturnType<typeof Promise.withResolvers<void>>
      }
    | undefined
  const panes = new FunctionPanes({
    plugins: [],
    assertLive() {
      /* The fixture source remains live until the explicit drawing transition. */
    },
    changed() {
      /* The test observes actual snapshots directly. */
    },
    callback: async () => {},
    publish: async (value) => {
      if (
        failPublication &&
        Array.isArray(value) &&
        value.some((row) => isModObject(row) && row.tree)
      )
        throw Error("actual publication refused")
      return value
    },
    withUiResolveDrawing: (drawing, run) => {
      drawings.push(drawing)
      return withFunctionUiResolveDrawing(drawing, async () => {
        expect(currentFunctionUiResolveDrawing()).toBe(drawing)
        return run()
      })
    },
    dispatch: async (event, input, options) => {
      if (event === "ui.render" && held) {
        const active = held
        held = undefined
        active.entered.resolve()
        await active.release.promise
      }
      const value = (await options.core?.(input, new AbortController().signal)) ?? {}
      return event === "ui.render"
        ? {
            type: "Box",
            props: { flexDirection: "column" },
            children: [value]
          }
        : value
    }
  })
  registries.push(panes)
  panes.open("p", { id: "board" })
  return {
    panes,
    drawings,
    fail(value: boolean) {
      failPublication = value
    },
    barrier() {
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      held = { entered, release }
      return { entered: entered.promise, release: () => release.resolve() }
    }
  }
}

async function dirty(panes: FunctionPanes, snapshot: FunctionPaneSnapshot) {
  await panes.act({
    pane: snapshot.key,
    generation: snapshot.generation,
    plugin: "p",
    handle: 0,
    intentId: randomUUID(),
    kind: "focus",
    value: { focused: true }
  })
}

describe("actual Panes with private constructor drawing adapter enabled", () => {
  it("keeps committed proof after normal return and reuses it on a cached publication", async () => {
    const f = fixture()
    const [before] = await f.panes.snapshot()
    const original = f.drawings[0]
    expect(currentFunctionUiResolveDrawing()).toBeUndefined()
    expect(original.generation).toBe(before.generation)
    expect(() => original.assertCurrent()).not.toThrow()
    const [cached] = await f.panes.snapshot()
    expect(cached.generation).toBe(before.generation)
    expect(f.drawings).toHaveLength(1)
    expect(original.signal.aborted).toBe(false)
  })

  it("closes committed and truly held candidate receipts before prior open replaces their Pane", async () => {
    const f = fixture()
    const [before] = await f.panes.snapshot()
    await dirty(f.panes, before)
    const gate = f.barrier()
    const pending = f.panes.snapshot()
    const rejected = expect(pending).rejects.toThrow("MODS_UI_DRAWING_STALE")
    await gate.entered
    expect(f.drawings).toHaveLength(2)
    expect(f.drawings.map((drawing) => drawing.signal.aborted)).toEqual([false, false])
    f.panes.open("p", { id: "board" })
    expect(f.drawings.map((drawing) => drawing.signal.aborted)).toEqual([true, true])
    gate.release()
    await rejected
    await f.panes.snapshot()
    expect(f.drawings[2].signal.aborted).toBe(false)
    expect(() => f.drawings[0].assertCurrent()).toThrow("MODS_UI_DRAWING_STALE")
  })

  it("closes a failed fresh candidate while retaining healthy proof, then closes old proof at commit", async () => {
    const f = fixture()
    const [before] = await f.panes.snapshot()
    await dirty(f.panes, before)
    f.fail(true)
    await expect(f.panes.snapshot()).rejects.toThrow("actual publication refused")
    expect(f.drawings.map((drawing) => drawing.signal.aborted)).toEqual([false, true])
    expect(() => f.drawings[0].assertCurrent()).not.toThrow()
    f.fail(false)
    const [after] = await f.panes.snapshot()
    expect(after.generation).not.toBe(before.generation)
    expect(f.drawings.map((drawing) => drawing.signal.aborted)).toEqual([true, true, false])
    expect(() => f.drawings[2].assertCurrent()).not.toThrow()
  })

  it("explicit invalidate fences committed and held candidate proof even if the next draw fails", async () => {
    const f = fixture()
    const [before] = await f.panes.snapshot()
    await dirty(f.panes, before)
    const gate = f.barrier()
    const pending = f.panes.snapshot()
    const rejected = expect(pending).rejects.toThrow("MODS_UI_DRAWING_STALE")
    await gate.entered
    f.panes.invalidate()
    expect(f.drawings.map((drawing) => drawing.signal.aborted)).toEqual([true, true])
    gate.release()
    await rejected
    f.fail(true)
    await expect(f.panes.snapshot()).rejects.toThrow("actual publication refused")
    expect(f.drawings.every((drawing) => drawing.signal.aborted)).toBe(true)
    f.fail(false)
    const [fresh] = await f.panes.snapshot()
    const latest = f.drawings.at(-1)!
    expect(latest.signal.aborted).toBe(false)
    expect(f.panes.invalidateGeneration(fresh.generation)).toBe(true)
    expect(latest.signal.aborted).toBe(true)
  })

  it.each([false, true])(
    "retires fault redraw proof only at a healthy commit (first fails=%s)",
    async (failed) => {
      const f = fixture()
      const [before] = await f.panes.snapshot()
      const receipt = f.panes.captureClientFault(before.key, before.generation)
      expect(receipt).toBeDefined()
      f.fail(failed)
      if (failed) {
        await expect(receipt!.redraw()).rejects.toThrow("actual publication refused")
        expect(f.drawings.map((drawing) => drawing.signal.aborted)).toEqual([false, true])
        expect(() => f.drawings[0].assertCurrent()).not.toThrow()
        f.fail(false)
        await f.panes.snapshot()
      } else await receipt!.redraw()
      expect(f.drawings[0].signal.aborted).toBe(true)
      expect(f.drawings.at(-1)!.signal.aborted).toBe(false)
      expect(() => receipt!.assertCurrent()).toThrow()
    }
  )

  it.each(["unmount", "close"] as const)(
    "closes both committed and held candidate receipts on actual %s",
    async (action) => {
      const f = fixture()
      const [before] = await f.panes.snapshot()
      await dirty(f.panes, before)
      const gate = f.barrier()
      const pending = f.panes.snapshot()
      const rejected = expect(pending).rejects.toThrow("MODS_UI_DRAWING_STALE")
      await gate.entered
      if (action === "unmount") await f.panes.closePane("p", "board")
      else f.panes.close()
      expect(f.drawings.map((drawing) => drawing.signal.aborted)).toEqual([true, true])
      gate.release()
      await rejected
    }
  )
})
