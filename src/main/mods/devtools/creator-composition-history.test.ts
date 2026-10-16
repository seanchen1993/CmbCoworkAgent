import { describe, expect, it } from "vitest"
import { CreatorCompositionHistory } from "./creator-composition-history"
import type { ClawProfile } from "../../../shared/mods/claw"

function fixture() {
  const settings = new Map<string, string>()
  const host = {
    getSetting: (key: string, fallback?: string) => settings.get(key) ?? fallback ?? "",
    compareAndSetSetting: (key: string, expected: string | undefined, value: string) => {
      if (settings.get(key) !== expected) return false
      settings.set(key, value)
      return true
    }
  }
  return { host, history: new CreatorCompositionHistory(host) }
}
const scope = {
  workspace: "workspace",
  threadId: "thread",
  incarnation: { token: "one", legacyCreatedAt: 1 }
}
const identity = JSON.stringify(["thread", "one"])
const profile: ClawProfile = { id: "profile", name: "Profile", capabilities: [] }
describe("durable creator composition selections", () => {
  it("restores only an exact confirmed binding and never treats pending metadata as applied", () => {
    const f = fixture()
    const token = f.history.prepare(scope, identity, 1, null, profile)
    expect(f.history.current(scope, identity, 1, profile)).toBeUndefined()
    f.history.activate(token)
    const restarted = new CreatorCompositionHistory(f.host)
    expect(restarted.current(scope, identity, 1, profile)?.undo).toEqual([null])
    expect(restarted.current(scope, identity, 2, profile)).toBeUndefined()
    expect(
      restarted.current(
        { ...scope, incarnation: { ...scope.incarnation, token: "new" } },
        identity,
        1,
        profile
      )
    ).toBeUndefined()
  })
  it("requires exact named template revision and returns independent copies", () => {
    const f = fixture()
    expect(f.history.save("workspace", "Review", 0, profile)).toEqual({
      name: "Review",
      revision: 1
    })
    expect(() => f.history.save("workspace", "Review", 0, profile)).toThrow(
      "COMPOSITION_SAVED_CHANGED"
    )
    const copy = f.history.load("workspace", "Review", 1)
    copy.name = "Changed outside"
    expect(f.history.load("workspace", "Review", 1).name).toBe("Profile")
    expect(f.history.list("other-workspace")).toEqual([])
  })
  it("consumes undo stack entries while preserving a previous journal on rejected CAS", () => {
    const f = fixture()
    const first = f.history.prepare(scope, identity, 1, null, profile)
    f.history.activate(first)
    const candidate = f.history.prepare(scope, identity, 2, profile, { ...profile, name: "New" })
    f.history.abandon(candidate)
    expect(f.history.current(scope, identity, 1, profile)?.undo).toEqual([null])
    const undo = f.history.prepare(scope, identity, 2, profile, null, true, undefined, 1)
    f.history.activate(undo)
    expect(f.history.current(scope, identity, 2, null)?.undo).toEqual([])
  })
})
