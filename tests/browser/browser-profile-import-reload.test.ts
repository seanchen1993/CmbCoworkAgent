import { describe, expect, it } from "vitest"

import { shouldReloadAfterProfileImport } from "../../src/main/browser/core/browser-service"

describe("browser profile import reload", () => {
  it("does not reload while the browser target is still on the initial blank page", () => {
    expect(shouldReloadAfterProfileImport("")).toBe(false)
    expect(shouldReloadAfterProfileImport("about:blank")).toBe(false)
    expect(shouldReloadAfterProfileImport("  about:blank  ")).toBe(false)
  })

  it("reloads existing pages so newly imported cookies can apply", () => {
    expect(shouldReloadAfterProfileImport("https://www.baidu.com/")).toBe(true)
    expect(shouldReloadAfterProfileImport("http://localhost:5173/")).toBe(true)
  })
})
