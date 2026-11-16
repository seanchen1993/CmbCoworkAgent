import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { UpdateActionButton } from "./UpdateActionButton"

afterEach(() => vi.unstubAllGlobals())

describe("UpdateActionButton platform availability", () => {
  it.each(["card", "tag"] as const)("hides the %s update entry on macOS", (variant) => {
    vi.stubGlobal("window", { electron: { process: { platform: "darwin" } } })

    expect(renderToStaticMarkup(createElement(UpdateActionButton, { variant }))).toBe("")
  })

  it.each(["win32", "linux"])("shows the update entry on %s", (platform) => {
    vi.stubGlobal("window", { electron: { process: { platform } } })

    const markup = renderToStaticMarkup(createElement(UpdateActionButton, { variant: "tag" }))

    expect(markup).toContain("检查是否有新版本")
  })
})
