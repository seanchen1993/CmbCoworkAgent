import { describe, expect, it } from "vitest"
import { ClawEditorDrafts } from "./claw-editor-drafts"
import { createSimpleClawDraft } from "./simple-claw-builder"

const scope = { accountRevision: 0, threadId: "a", workspace: "C:/project" }
const document = () => ({
  ...createSimpleClawDraft({ id: "draft", name: "保留我的组合", capabilities: [] }, "flow"),
  mode: "sequence" as const,
  steps: [{ id: "step", action: "plugin:action", input: { count: 3 }, config: { option: true } }],
  flowText: "{unfinished",
  flowTextError: "invalid JSON",
  parameterDrafts: { "step:input": { numbers: { count: "0." }, dirty: true } },
  componentDrafts: { plugin: { count: { json: "{unfinished", dirty: true } } }
})

describe("in-memory Claw editor drafts", () => {
  it("retains the entire unsaved editor across unmount without sharing mutable objects", () => {
    const cache = new ClawEditorDrafts()
    const draft = document()
    expect(cache.write(scope, draft, true)).toBe(true)
    const restored = cache.read(scope)!
    expect(restored).toEqual(draft)
    restored.profile.name = "changed reader"
    draft.parameterDrafts["step:input"].numbers.count = "changed writer"
    expect(cache.read(scope)?.profile.name).toBe("保留我的组合")
    expect(cache.read(scope)?.parameterDrafts["step:input"].numbers?.count).toBe("0.")
  })

  it("isolates threads and workspaces, clears account generations and fences late writers", () => {
    const cache = new ClawEditorDrafts()
    cache.write(scope, document(), true)
    expect(cache.read({ ...scope, threadId: "b" })).toBeUndefined()
    expect(cache.read({ ...scope, workspace: "C:/other" })).toBeUndefined()
    cache.synchronize(1, () => undefined)
    expect(cache.read(scope)).toBeUndefined()
    expect(cache.write(scope, document(), true)).toBe(false)
    expect(cache.read({ ...scope, accountRevision: 1 })).toBeUndefined()
    cache.synchronize(2, () => undefined)
    expect(cache.read({ ...scope, accountRevision: 2 })).toBeUndefined()
  })

  it("retires deleted/changed scopes but does not confuse paginated absence with deletion", () => {
    const cache = new ClawEditorDrafts()
    cache.write(scope, document(), true)
    cache.synchronize(0, () => undefined)
    expect(cache.read(scope)).toBeDefined()
    cache.synchronize(0, () => "C:/other")
    expect(cache.read(scope)).toBeUndefined()
    cache.write(scope, document(), true)
    cache.synchronize(0, () => null)
    expect(cache.read(scope)).toBeUndefined()
  })

  it("does not resurrect an explicitly saved or discarded document", () => {
    const cache = new ClawEditorDrafts()
    cache.write(scope, document(), true)
    cache.write(scope, document(), false)
    expect(cache.read(scope)).toBeUndefined()
  })

  it("bounds entries and total text, rejecting an oversized replacement without stale recovery", () => {
    const cache = new ClawEditorDrafts(2, 1400)
    for (const threadId of ["a", "b", "c"]) cache.write({ ...scope, threadId }, document(), true)
    expect(cache.read(scope)).toBeUndefined()
    expect(cache.read({ ...scope, threadId: "c" })).toBeDefined()
    expect(
      cache.write(
        { ...scope, threadId: "c" },
        {
          ...document(),
          flowText: "x".repeat(1401)
        },
        true
      )
    ).toBe(false)
    expect(cache.read({ ...scope, threadId: "c" })).toBeUndefined()
  })

  it("enforces the aggregate budget separately from the number of scopes", () => {
    const size = JSON.stringify(document()).length
    const cache = new ClawEditorDrafts(16, size * 2 - 1)
    cache.write(scope, document(), true)
    cache.write({ ...scope, threadId: "b" }, document(), true)
    expect(cache.read(scope)).toBeUndefined()
    expect(cache.read({ ...scope, threadId: "b" })).toEqual(document())
  })
})
