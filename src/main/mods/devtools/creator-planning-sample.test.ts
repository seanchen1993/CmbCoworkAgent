import { resolve } from "node:path"
import { expect, it } from "vitest"
import { checkFunctionAuthorTypes } from "./authoring-check"
import { checkFunctionPlugin } from "./check"

it("checks the installable typed planning sample through the original compiler, SDK and Guest", async () => {
  const source = resolve("examples/mods-creator-planning")
  const check = await checkFunctionPlugin(source)
  const types = await checkFunctionAuthorTypes(source)
  expect(check.valid, JSON.stringify(check.diagnostics)).toBe(true)
  expect(types.valid, JSON.stringify(types.diagnostics)).toBe(true)
  expect(types.digest).toBe(check.digest)
})
