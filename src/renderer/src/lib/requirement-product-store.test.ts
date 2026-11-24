import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  REQUIREMENT_RELATIONS_STORAGE_KEY,
  REQUIREMENT_SETTINGS_STORAGE_KEY,
  initializeRequirementProductState,
  commitRequirementRelations,
  resetRequirementProductStoreForTests,
  useRequirementProductStore
} from "./requirement-product-store"

function createStorage(seed: Record<string, string> = {}): Storage & { reads: Map<string, number> } {
  const values = new Map(Object.entries(seed))
  const reads = new Map<string, number>()
  return {
    reads,
    get length() { return values.size },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => {
      reads.set(key, (reads.get(key) ?? 0) + 1)
      return values.get(key) ?? null
    },
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  }
}

describe("requirement product lazy hydration", () => {
  beforeEach(() => resetRequirementProductStoreForTests())
  afterEach(() => vi.unstubAllGlobals())

  it("migrates legacy data once and reuses memory on later product-mode entries", () => {
    const storage = createStorage({
      "requirement-design-associations": JSON.stringify({
        design1: {
          requirementId: "req-1",
          workspacePath: "/workspace",
          requirementFilePath: "/workspace/prd.md",
          prompt: "design",
          htmlId: "design1"
        }
      }),
      "requirement:quick-start-persona": "design"
    })

    initializeRequirementProductState(storage)
    const readsAfterFirstEntry = new Map(storage.reads)
    initializeRequirementProductState(storage)

    expect(storage.reads).toEqual(readsAfterFirstEntry)
    expect(storage.getItem(REQUIREMENT_RELATIONS_STORAGE_KEY)).toContain("design1")
    expect(storage.getItem(REQUIREMENT_SETTINGS_STORAGE_KEY)).toContain('"persona":"design"')
    expect(storage.getItem("requirement-design-associations")).toBeNull()
    expect(useRequirementProductStore.getState().relations.requirements["req-1"])
      .toBeDefined()
  })

  it("updates relations from memory with one persistence write and no storage reread", () => {
    const storage = createStorage()
    const setItem = vi.spyOn(storage, "setItem")
    vi.stubGlobal("localStorage", storage)
    initializeRequirementProductState()
    const readsBeforeUpdate = new Map(storage.reads)
    const writesBeforeUpdate = setItem.mock.calls.length

    commitRequirementRelations((current) => ({
      ...current,
      requirements: {
        ...current.requirements,
        "req-1": { designSessions: {}, developmentThreads: {} }
      }
    }))

    expect(storage.reads).toEqual(readsBeforeUpdate)
    expect(setItem.mock.calls.length - writesBeforeUpdate).toBe(1)
  })
})
