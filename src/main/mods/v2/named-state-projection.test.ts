import { expect, it } from "vitest"
import { FunctionNamedState, type FunctionNamedStateScope } from "./named-state"

const ref = { plugin: "counter", key: "count" }

it("hands actual dependencies to a passive proof before releasing its drawing", () => {
  const state = new FunctionNamedState()
  state.read(ref, { drawing: "old-generation" })
  const proof = state.captureDrawingDependencies("old-generation")!
  expect(state.dependencyStats()).toMatchObject({ proofs: 1, subscriptions: 2 })
  state.release("old-generation")
  expect(state.drawingDependenciesCurrent(proof)).toBe(true)
  let invalidated = 0
  state.listenDrawingDependencies(proof, () => {
    invalidated++
  })
  state.write({ ...ref, key: "unrelated", value: 1 }, {})
  expect(state.drawingDependenciesCurrent(proof)).toBe(true)
  state.write({ ...ref, value: 1 }, {})
  state.write({ ...ref, value: 2 }, {})
  expect(invalidated).toBe(1)
  expect(state.drawingDependenciesCurrent(proof)).toBe(false)
  state.releaseDrawingDependencies(proof)
  state.releaseDrawingDependencies(proof)
  expect(state.dependencyStats()).toEqual({ readers: 0, proofs: 0, subscriptions: 0, bytes: 0 })
})

it("rejects capture after an await-time write and keeps read snapshots coherent", () => {
  const state = new FunctionNamedState()
  const scope: FunctionNamedStateScope = { drawing: "draw" }
  state.read(ref, scope)
  state.write({ ...ref, value: 1 }, {})
  expect(state.read(ref, scope)).toEqual({ version: 0 })
  expect(state.captureDrawingDependencies("draw")).toBeUndefined()
  // Returning to equal data does not return to the old dependency version.
  state.write({ ...ref, value: 0 }, {})
  expect(state.captureDrawingDependencies("draw")).toBeUndefined()
})

it("does not certify a drawing which observed mixed versions of the same key", () => {
  const state = new FunctionNamedState()
  const scope: FunctionNamedStateScope = { drawing: "draw" }
  state.read(ref, scope)
  state.write({ ...ref, value: 1 }, scope)
  state.read(ref, scope)
  expect(state.captureDrawingDependencies("draw")).toBeUndefined()
})

it("does not accept forged proofs or proofs from another state engine", () => {
  const state = new FunctionNamedState()
  const other = new FunctionNamedState()
  state.beginDrawingDependencies("completed-empty-draw")
  const proof = state.captureDrawingDependencies("completed-empty-draw")!
  expect(state.drawingDependenciesCurrent(proof)).toBe(true)
  expect(other.drawingDependenciesCurrent(proof)).toBe(false)
  expect(state.drawingDependenciesCurrent({} as typeof proof)).toBe(false)
  state.releaseDrawingDependencies(proof)
  expect(state.drawingDependenciesCurrent(proof)).toBe(false)
  state.release("completed-empty-draw")
  expect(state.captureDrawingDependencies("completed-empty-draw")).toBeUndefined()
  expect(state.captureDrawingDependencies("never-observed")).toBeUndefined()
})

it("uses original subscription quotas and releases proof resources without expanding them", () => {
  const state = new FunctionNamedState()
  for (let drawing = 0; drawing < 8; drawing++)
    for (let key = 0; key < 1024; key++)
      state.read({ ...ref, key: String(key) }, { drawing: String(drawing) })
  expect(state.captureDrawingDependencies("0")).toBeUndefined()
  state.release("1")
  const proof = state.captureDrawingDependencies("0")!
  expect(proof).toBeDefined()
  state.release("0")
  expect(state.dependencyStats().subscriptions).toBe(7168)
  state.releaseDrawingDependencies(proof)
  expect(state.dependencyStats().subscriptions).toBe(6144)
})

it("reclaims a host-owned proof before admitting another without increasing quotas", () => {
  const state = new FunctionNamedState()
  state.beginDrawingDependencies("draw")
  const proofs = Array.from({ length: 96 }, () => state.captureDrawingDependencies("draw")!)
  expect(state.captureDrawingDependencies("draw")).toBeUndefined()
  let reclaimed = 0
  const next = state.captureDrawingDependencies("draw", () => {
    state.releaseDrawingDependencies(proofs[reclaimed++])
    return true
  })!
  expect(reclaimed).toBe(1)
  expect(state.drawingDependenciesCurrent(next)).toBe(true)
  expect(state.drawingDependenciesCurrent(proofs[0])).toBe(false)
  expect(state.dependencyStats()).toMatchObject({ proofs: 96, subscriptions: 0 })
})

it("rechecks the actual reader after reclaim callbacks and bounds unproductive reclamation", () => {
  const state = new FunctionNamedState()
  state.read(ref, { drawing: "draw" })
  const proofs = Array.from({ length: 96 }, () => state.captureDrawingDependencies("draw")!)
  let calls = 0
  expect(
    state.captureDrawingDependencies("draw", () => {
      calls++
      return true
    })
  ).toBeUndefined()
  expect(calls).toBe(96)
  expect(
    state.captureDrawingDependencies("draw", () => {
      state.releaseDrawingDependencies(proofs[0])
      state.write({ ...ref, value: 1 }, {})
      return true
    })
  ).toBeUndefined()
  expect(state.dependencyStats().proofs).toBe(95)
})

it("bounds empty proofs and does not let invalidation callback errors turn writes into failures", () => {
  const state = new FunctionNamedState()
  state.beginDrawingDependencies("empty")
  const proof = state.captureDrawingDependencies("empty")!
  for (let index = 1; index < 96; index++) {
    state.beginDrawingDependencies(`empty-${index}`)
    state.captureDrawingDependencies(`empty-${index}`)
  }
  state.beginDrawingDependencies("overflow")
  expect(state.captureDrawingDependencies("overflow")).toBeUndefined()
  state.releaseDrawingDependencies(proof)
  state.read(ref, { drawing: "draw" })
  const watched = state.captureDrawingDependencies("draw")!
  state.listenDrawingDependencies(watched, () => {
    throw Error("cache callback failed")
  })
  expect(() => state.write({ ...ref, value: 1 }, {})).not.toThrow()
  expect(state.drawingDependenciesCurrent(watched)).toBe(false)
})

it("requires actual native reads for every declared ref including absent version zero", () => {
  const state = new FunctionNamedState()
  state.beginDrawingDependencies("empty")
  const empty = state.captureDrawingDependencies("empty")!
  expect(state.coversDisplayDependencies(empty, [])).toBe(true)
  expect(state.coversDisplayDependencies(empty, [ref])).toBe(false)
  state.read(ref, { drawing: "read" })
  state.read({ ...ref, id: "" }, { drawing: "read" })
  state.read({ ...ref, key: "extra" }, { drawing: "read" })
  const proof = state.captureDrawingDependencies("read")!
  expect(state.coversDisplayDependencies(proof, [ref, { ...ref, id: "" }])).toBe(true)
  expect(state.coversDisplayDependencies(proof, [{ ...ref, key: "never-read" }])).toBe(false)
  expect(state.coversDisplayDependencies(proof, [{ ...ref, id: "other" }])).toBe(false)
  expect(state.coversDisplayDependencies(proof, [{ ...ref, plugin: "other" }])).toBe(false)
  state.release("read")
  expect(state.coversDisplayDependencies(proof, [ref])).toBe(true)
  state.write({ ...ref, key: "extra", value: 1 }, {})
  expect(state.coversDisplayDependencies(proof, [ref])).toBe(false)
})

it("rejects forged, released, cross-engine and malformed dependency coverage claims", () => {
  const state = new FunctionNamedState()
  const other = new FunctionNamedState()
  state.read(ref, { drawing: "read" })
  const proof = state.captureDrawingDependencies("read")!
  expect(other.coversDisplayDependencies(proof, [ref])).toBe(false)
  expect(state.coversDisplayDependencies({} as typeof proof, [])).toBe(false)
  for (const bad of [
    { ...ref, id: null },
    { ...ref, extra: true },
    { ...ref, key: "" }
  ])
    expect(state.coversDisplayDependencies(proof, [bad])).toBe(false)
  expect(
    state.coversDisplayDependencies(
      proof,
      Array.from({ length: 1025 }, () => ref)
    )
  ).toBe(false)
  state.releaseDrawingDependencies(proof)
  expect(state.coversDisplayDependencies(proof, [ref])).toBe(false)
})
