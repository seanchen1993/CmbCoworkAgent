import { describe, expect, it } from "vitest"
import type { BotErrorTraySnapshot } from "../../../shared/bot-error-trays"
import { projectBotErrorTraySnapshot } from "./bot-error-tray-projection"

const authority = { hostId: "host-a", dataEpoch: "epoch-a" }
const snapshot = (revision: number): BotErrorTraySnapshot => ({ ...authority, revision, items: [] })

describe("Bot notification projection", () => {
  it("does not publish an older refresh after a newer dismissal receipt", () => {
    const acknowledged = snapshot(11)
    expect(projectBotErrorTraySnapshot(acknowledged, snapshot(10), authority)).toBe(acknowledged)
  })

  it("keeps a stable snapshot on equal revisions", () => {
    const current = snapshot(11)
    expect(projectBotErrorTraySnapshot(current, snapshot(11), authority)).toBe(current)
    expect(projectBotErrorTraySnapshot(current, snapshot(12), authority)?.revision).toBe(12)
  })

  it("cannot change authority using a mutation response from a retired Host", () => {
    const current = snapshot(3)
    expect(
      projectBotErrorTraySnapshot(current, { ...snapshot(50), hostId: "host-retired" }, authority)
    ).toBe(current)
  })

  it("retires old trays on an accepted Host or data generation change", () => {
    const current = snapshot(50)
    const nextAuthority = { hostId: "host-b", dataEpoch: "epoch-b" }
    expect(projectBotErrorTraySnapshot(current, undefined, nextAuthority)).toBeNull()
    const fresh = { ...nextAuthority, revision: 0, items: [] }
    expect(projectBotErrorTraySnapshot(current, fresh, nextAuthority)).toEqual(fresh)
    expect(projectBotErrorTraySnapshot(fresh, current, nextAuthority)).toBe(fresh)
  })

  it("ignores malformed or unbounded wire snapshots without discarding current state", () => {
    const current = snapshot(3)
    expect(projectBotErrorTraySnapshot(current, { ...snapshot(4), revision: -1 }, authority)).toBe(
      current
    )
    expect(
      projectBotErrorTraySnapshot(current, { ...snapshot(4), rawBody: "secret" }, authority)
    ).toBe(current)
    expect(
      projectBotErrorTraySnapshot(
        current,
        { ...snapshot(4), items: new Array(21).fill({}) },
        authority
      )
    ).toBe(current)
  })
})
