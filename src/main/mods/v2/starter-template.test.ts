import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { expect, it } from "vitest"
import { MODS_STARTER_FILES } from "../../../shared/mods/v2/starter-template"
import { compileFunctionPlugin } from "./loader"
import { checkFunctionPlugin } from "../devtools/check"

async function removeFixture(root: string) {
  if (dirname(resolve(root)) !== resolve(tmpdir())) throw Error("Unexpected fixture path")
  await rm(root, { recursive: true, force: true })
}

it("the downloadable starter compiles and registers the documented command without approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "mods-download-starter-"))
  try {
    for (const [file, content] of Object.entries(MODS_STARTER_FILES)) {
      const target = join(root, file)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content)
    }
    const compiled = await compileFunctionPlugin(root)
    expect(compiled.name).toBe("my-claw")
    const report = await checkFunctionPlugin(root)
    expect(report).toMatchObject({ valid: true, authorized: false })
    expect(compiled.code).toContain("my-claw-info")
  } finally {
    await removeFixture(root)
  }
})
