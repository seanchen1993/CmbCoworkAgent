import { afterEach, describe, expect, it } from "vitest"
import {
  beginSkillCatalogTopologyMutation,
  getSkillCatalogTopologyRevision,
  isSkillCatalogTopologyMutationBusy,
  resetSkillCatalogTopologyMutationGateForTests,
  waitForSkillCatalogTopologyIdle
} from "./topology-mutation-gate"
import { resetHookCatalogRevisionsForTests } from "../hook-catalog/revision"

afterEach(() => {
  resetSkillCatalogTopologyMutationGateForTests()
  resetHookCatalogRevisionsForTests()
})

describe("skill catalog topology mutation gate", () => {
  it("waits for every overlapping mutation and balances idempotent end callbacks", async () => {
    const endFirst = beginSkillCatalogTopologyMutation()
    const endSecond = beginSkillCatalogTopologyMutation()
    expect(isSkillCatalogTopologyMutationBusy()).toBe(true)
    expect(getSkillCatalogTopologyRevision()).toBe(2)

    let settled = false
    const idle = waitForSkillCatalogTopologyIdle().then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    endFirst()
    endFirst()
    await Promise.resolve()
    expect(settled).toBe(false)
    endSecond()
    await idle

    expect(isSkillCatalogTopologyMutationBusy()).toBe(false)
    expect(getSkillCatalogTopologyRevision()).toBe(4)
  })
})
