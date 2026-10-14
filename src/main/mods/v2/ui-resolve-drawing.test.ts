import { expect, it } from "vitest"
import {
  FunctionUiResolveDrawing,
  currentFunctionUiResolveDrawing,
  withFunctionUiResolveDrawing
} from "./ui-resolve-drawing"

it("keeps a real drawing receipt live after normal invocation return", async () => {
  const drawing = new FunctionUiResolveDrawing("Pane", "generation", "report", () => {})
  let continuation!: () => Promise<void>
  await withFunctionUiResolveDrawing(drawing, async () => {
    continuation = () =>
      Promise.resolve().then(() => {
        expect(currentFunctionUiResolveDrawing()).toBe(drawing)
      })
    expect(currentFunctionUiResolveDrawing()).toBe(drawing)
  })
  expect(currentFunctionUiResolveDrawing()).toBeUndefined()
  await withFunctionUiResolveDrawing(drawing, continuation)
  expect(drawing.signal.aborted).toBe(false)
  drawing.close()
  expect(() => withFunctionUiResolveDrawing(drawing, continuation)).toThrow()
})

it("fences the original native request instead of borrowing the newest request", async () => {
  const original = {}
  let pending = original
  const old = new FunctionUiResolveDrawing("AskUserQuestion", "R1", "slot", () => {
    if (pending !== original) throw new Error("actual request changed")
  })
  await withFunctionUiResolveDrawing(old, async () => undefined)
  pending = {}
  expect(() => old.assertCurrent()).toThrow("actual request changed")
  const fresh = new FunctionUiResolveDrawing("AskUserQuestion", "R2", "slot", () => {})
  await withFunctionUiResolveDrawing(fresh, async () => {
    expect(currentFunctionUiResolveDrawing()).toBe(fresh)
    expect(() => old.assertCurrent()).toThrow("actual request changed")
  })
})

it("rejects structural clones and stops a guard which synchronously closes its owner", () => {
  const drawing = new FunctionUiResolveDrawing("Pane", "g", "p", () => drawing.close())
  expect(() => drawing.assertCurrent()).toThrow("MODS_UI_DRAWING_STALE")
  const clone = Object.create(FunctionUiResolveDrawing.prototype)
  expect(() => withFunctionUiResolveDrawing(clone, async () => undefined)).toThrow(
    "MODS_UI_RESOLVE_DRAWING_IDENTITY"
  )
})
