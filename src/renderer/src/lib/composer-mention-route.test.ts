import { afterEach, describe, expect, it, vi } from "vitest"
import { captureComposerMentionRoute } from "./composer-mention-route"

afterEach(() => vi.unstubAllGlobals())

function platform(value: string): void {
  vi.stubGlobal("window", { electron: { process: { platform: value } } })
}

describe("composer workspace route data", () => {
  it("uses the current logical workspace and preserves the two actual routes", () => {
    platform("linux")
    expect(
      captureComposerMentionRoute(
        { workspace: "/logical/project", enabled: true },
        "/logical/project/"
      )
    ).toBe("defer")
    expect(
      captureComposerMentionRoute(
        { workspace: "/logical/project", enabled: false },
        "/logical/project"
      )
    ).toBe("preview")
    expect(() =>
      captureComposerMentionRoute(
        { workspace: "/canonical/project", enabled: false },
        "/logical/project"
      )
    ).toThrow("当前输入和附件已保留")
  })

  it("keeps the existing platform path comparison instead of resolving an alias", () => {
    platform("win32")
    expect(
      captureComposerMentionRoute(
        { workspace: "C:\\Alias\\Project\\", enabled: false },
        "c:/alias/project"
      )
    ).toBe("preview")
    platform("darwin")
    expect(
      captureComposerMentionRoute(
        { workspace: "/private/var/project", enabled: true },
        "/var/project"
      )
    ).toBe("defer")
    platform("linux")
    expect(() =>
      captureComposerMentionRoute({ workspace: "/Project", enabled: true }, "/project")
    ).toThrow("当前输入和附件已保留")
  })

  it("accepts a complete null-prototype response without granting any additional fields", () => {
    platform("linux")
    const value = Object.assign(Object.create(null), { workspace: "/project", enabled: false })
    expect(captureComposerMentionRoute(value, "/project")).toBe("preview")
  })

  it.each<unknown>([
    undefined,
    null,
    false,
    "/project",
    [],
    {},
    { workspace: "/project" },
    { enabled: false },
    { workspace: "", enabled: false },
    { workspace: "   ", enabled: false },
    { workspace: 17, enabled: false },
    { workspace: "/project", enabled: "false" },
    { workspace: "/project", enabled: false, authority: {} },
    { workspace: "/other", enabled: false }
  ])("rejects unknown route data without selecting OFF: %j", (value) => {
    platform("linux")
    expect(() => captureComposerMentionRoute(value, "/project")).toThrow("当前输入和附件已保留")
  })

  it.each(["workspace", "enabled"])("rejects an own %s accessor without reading it", (key) => {
    platform("linux")
    let getters = 0
    const value = { workspace: "/project", enabled: false }
    Object.defineProperty(value, key, {
      enumerable: true,
      get() {
        getters++
        return false
      }
    })
    expect(() => captureComposerMentionRoute(value, "/project")).toThrow("当前输入和附件已保留")
    expect(getters).toBe(0)
  })

  it("rejects inherited and Symbol route fields without consulting an inherited getter", () => {
    platform("linux")
    let getters = 0
    const prototype = Object.defineProperty({}, "enabled", {
      get() {
        getters++
        return false
      }
    })
    expect(() =>
      captureComposerMentionRoute(
        Object.assign(Object.create(prototype), {
          workspace: "/project"
        }),
        "/project"
      )
    ).toThrow("当前输入和附件已保留")
    expect(getters).toBe(0)
    expect(() =>
      captureComposerMentionRoute(
        { workspace: "/project", enabled: false, [Symbol("extra")]: "extra" },
        "/project"
      )
    ).toThrow("当前输入和附件已保留")
  })
})
