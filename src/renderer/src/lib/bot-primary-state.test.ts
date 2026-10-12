import { describe, expect, it } from "vitest"
import type { BotPrimaryState } from "../../../shared/bot-primary"
import { mergeBotPrimaryState } from "./bot-primary-state"

const state = (changes: Partial<BotPrimaryState> = {}): BotPrimaryState => ({
  revision: 0,
  botId: null,
  dataEpoch: "workspace-a",
  checkInRevision: 0,
  checkIn: null,
  ...changes
})
describe("primary Bot authority projection", () => {
  it("keeps unknown distinct from a read null pointer", () => {
    expect(mergeBotPrimaryState(undefined, undefined, "workspace-a")).toBeUndefined()
    const known = state()
    expect(mergeBotPrimaryState(undefined, known, "workspace-a")).toBe(known)
  })
  it("does not let a pending old-null poll overwrite a selected Bot receipt", () => {
    const selected = state({ revision: 1, botId: "selected" })
    expect(mergeBotPrimaryState(selected, state(), "workspace-a")).toBe(selected)
  })
  it("preserves configuration revocation even when its routine was deleted", () => {
    const revoked = state({ revision: 1, checkInRevision: 5 })
    const late = state({ revision: 1, checkInRevision: 4 })
    expect(mergeBotPrimaryState(revoked, late, "workspace-a")).toBe(revoked)
  })
  it("accepts a newer role even if an old role had a higher check-in revision", () => {
    const previous = state({ revision: 1, checkInRevision: 10 })
    const incoming = state({ revision: 2, botId: null, checkInRevision: 0 })
    expect(mergeBotPrimaryState(previous, incoming, "workspace-a")).toBe(incoming)
  })
  it("does not retain authority from a restored workspace", () => {
    const previous = state({ revision: 20 })
    const restored = state({ dataEpoch: "workspace-b" })
    expect(mergeBotPrimaryState(previous, restored, "workspace-b")).toBe(restored)
    expect(mergeBotPrimaryState(restored, previous, "workspace-b")).toBeUndefined()
  })
})
