import { expect, it } from "vitest"
import type { FunctionPlugin } from "./dispatcher"
import { developmentUiOnly } from "./development-conversation-owner"

function plugin(pattern = "ui.render", capabilities = ["ui.resolve"]): FunctionPlugin {
  return { name: "same-name", root: "fixture", tier: "user", capabilities,
    guest: { registrations: [{ pattern }] } } as unknown as FunctionPlugin
}

it("exempts only exact private UI development identities", () => {
  const actual = plugin(), formal = plugin()
  const development = new Map([[actual, {}]])
  expect(developmentUiOnly([actual], development)).toBe(true)
  expect(developmentUiOnly([formal], development)).toBe(false)
  expect(developmentUiOnly([actual, formal], development)).toBe(false)
  expect(developmentUiOnly([], development)).toBe(false)
})

it.each(["tool.call", "command.run", "session.start", "turn.complete", "*", "!ui.render"])(
  "retains conversation ownership for %s", pattern => {
    const actual = plugin(pattern)
    expect(developmentUiOnly([actual], new Map([[actual, {}]]))).toBe(false)
  }
)

it("does not exempt conversation SDK or future unreviewed capabilities", () => {
  for (const method of ["session.messages", "session.append", "future.method"]) {
    const actual = plugin("ui.render", [method])
    expect(developmentUiOnly([actual], new Map([[actual, {}]]))).toBe(false)
  }
})
