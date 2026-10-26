import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { expect, it } from "vitest"
import { createProjectTemplate } from "./project-template"
import { testProjectSource } from "./project-contract"
import { inspectProjectSource } from "./project-doctor"
import { initProjectPlugin, compileProjectPlugin } from "./project-tooling"
import { parseProjectRuntimeManifest } from "../../../shared/project-runtime"

it("starts native composition authors with one editable source and real positive and negative artifact checks", async () => {
  const bundle = createProjectTemplate({
    packageId: "writing",
    name: "文档",
    template: "native-modular"
  })
  const source = JSON.parse(
    bundle.files.find((file) => file.path === "composition/source.json")!.text
  )
  expect(source.modules[1].inputs).toEqual([{ artifactId: "document", contract: "document/v1" }])
  expect(bundle.files.some((file) => file.path === "devclaw.harness.json")).toBe(false)
  const manifest = parseProjectRuntimeManifest(
    JSON.parse(bundle.files.find((file) => file.path === "devclaw.project-runtime.json")!.text)
  )
  expect(manifest.stages[1].resultApproval).toBe("human")
  expect(inspectProjectSource(bundle).report.valid).toBe(true)
  expect(await testProjectSource(bundle, manifest)).toMatchObject({ valid: true })
})

it("CLI compiles author edits into a new directory without changing the prior generated package", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-template-"))
  try {
    const sourceDir = join(root, "source"),
      target = join(root, "compiled")
    await initProjectPlugin(sourceDir, {
      packageId: "writing",
      name: "文档",
      template: "native-modular"
    })
    const runtimePath = join(sourceDir, "devclaw.project-runtime.json")
    const original = await readFile(runtimePath, "utf8")
    const sourcePath = join(sourceDir, "composition/source.json")
    const source = JSON.parse(await readFile(sourcePath, "utf8"))
    source.modules[0].title = "重新起草"
    await writeFile(sourcePath, JSON.stringify(source))
    const result = await compileProjectPlugin(sourceDir, target)
    expect(result).toMatchObject({ executed: false, tests: { valid: true } })
    expect(await readFile(runtimePath, "utf8")).toBe(original)
    expect(await readFile(join(target, "devclaw.project-runtime.json"), "utf8")).toContain(
      "重新起草"
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
