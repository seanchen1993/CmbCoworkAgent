import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { expect, it } from "vitest"
import { createAuthoringTemplate } from "./authoring-templates"
import { compileFunctionPlugin } from "../v2/loader"
import { authoringStructureCode, AuthoringStructureError } from "./authoring-structure-diagnostics"

it("keeps scaffold valid and diagnoses the actual extra root entry introduced by an author", async () => {
  const root = await mkdtemp(join(tmpdir(), "generic-authoring-structure-"))
  try {
    const template = createAuthoringTemplate({
      id: "generic-counter",
      name: "计数器",
      kind: "panel",
      instruction: "显示工具次数"
    })
    for (const file of template.files) {
      await mkdir(dirname(join(root, file.path)), { recursive: true })
      await writeFile(join(root, file.path), file.text)
    }
    const compiled = await compileFunctionPlugin(root)
    expect(compiled.code).toBeTruthy()
    const file = template.files.find((file) => file.path === "mods/manifest.json")!
    const manifest = JSON.parse(file.text)
    expect(manifest.entry).toBeUndefined()
    manifest.entry = "main.ts"
    await writeFile(join(root, file.path), JSON.stringify(manifest))
    const failure = await compileFunctionPlugin(root).catch((error) => error)
    const code = authoringStructureCode(failure.message)
    expect(code).toBe("CLAW_COMPONENT_ENTRY_CONFLICT")
    const publicFailure = new AuthoringStructureError(code!)
    expect(publicFailure.diagnostic.message).toContain("删除顶层 entry")
    expect(publicFailure.diagnostic.path).toBe("/entry")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
