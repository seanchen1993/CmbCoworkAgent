import { resolve } from "node:path"
import { expect, it } from "vitest"
import { analyzeAuthoringPreview } from "../mods/devtools/authoring-preflight"

it("strictly checks the complete delivery provider against the actual author SDK", async () => {
  const result = await analyzeAuthoringPreview(
    resolve("resources/native-compositions/autobiz-lean/providers/delivery")
  )
  expect(result.typecheck.valid, JSON.stringify(result.typecheck)).toBe(true)
  expect(result.typecheck.diagnostics).toEqual([])
  expect(result.sdk.strictCompatible, JSON.stringify(result.sdk)).toBe(true)
  expect(result.sdk.diagnostics).toEqual([])
})
