// Draft regression: real supplier compiler, not an AutoBiz-name exception. Not executed.
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { expect, it } from "vitest"
import {
  compileNativeComposition,
  nativeCompositionSchema,
  readNativeCompositionFiles
} from "./native-composition"
import { parseProjectRuntimeManifest } from "../../shared/project-runtime"

it("compiles one explicitly selected supplier stage without enabling other stages", () => {
  const root = resolve("tests/fixtures/native-compositions/vendor")
  const input = nativeCompositionSchema.parse(
    JSON.parse(readFileSync(resolve(root, "composition/source.json"), "utf8"))
  )
  const files = readNativeCompositionFiles(root, input)
  input.modules[1].executionMode = "workflow"
  const compiled = compileNativeComposition(input, { files, actionCatalog: [] })
  const manifest = parseProjectRuntimeManifest(compiled.runtime)
  expect(manifest.stages[1].executionMode).toBe("workflow")
  for (const [index, stage] of manifest.stages.entries()) {
    if (index !== 1) expect(stage).not.toHaveProperty("executionMode")
    expect(stage.approval).toBe(input.modules[index].approval)
    expect(stage.resultApproval ?? "none").toBe(input.modules[index].resultApproval)
  }
  expect(() =>
    nativeCompositionSchema.parse({
      ...input,
      modules: input.modules.map((module, index) =>
        index === 1 ? { ...module, executionMode: "coordinator" } : module
      )
    })
  ).toThrow()
})
