import { afterEach, beforeEach, expect, test } from "vitest"
import { mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { rollup } from "rollup"
import { mainGeneratedScriptsPlugin, MAIN_GENERATED_SCRIPTS } from "./main-generated-scripts"

let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "cmb-main-generated-")))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const directory = join(root, "generated")
  await mkdir(directory)
  for (const name of MAIN_GENERATED_SCRIPTS)
    await writeFile(join(root, name), `original generated contents: ${name}`)
  await writeFile(join(root, "index.js"), "export const marker = 1;")
  return directory
}

test("emits and watches the exact two scripts before code seal generation", async () => {
  const directory = await fixture()
  const bundle = await rollup({
    input: join(root, "index.js"),
    plugins: [mainGeneratedScriptsPlugin(directory)]
  })
  try {
    const { output } = await bundle.generate({ format: "cjs" })
    for (const name of MAIN_GENERATED_SCRIPTS) {
      const asset = output.find((member) => member.fileName === name)
      expect(asset?.type).toBe("asset")
      if (!asset || asset.type !== "asset") throw new Error("Missing generated asset")
      expect(Buffer.from(asset.source).toString()).toBe(`original generated contents: ${name}`)
      expect(bundle.watchFiles).toContain(join(root, name))
    }
  } finally {
    await bundle.close()
  }
})

test("a missing required script fails the build instead of producing partial code", async () => {
  const directory = await fixture()
  await rm(join(root, MAIN_GENERATED_SCRIPTS[1]))
  await expect(
    rollup({ input: join(root, "index.js"), plugins: [mainGeneratedScriptsPlugin(directory)] })
  ).rejects.toThrow("ENOENT")
})

test("bounds generated source reads before allocating an oversized source asset", async () => {
  const directory = await fixture()
  const file = await open(join(root, MAIN_GENERATED_SCRIPTS[0]), "r+")
  try {
    await file.truncate(4 * 1024 * 1024 + 1)
  } finally {
    await file.close()
  }
  await expect(
    rollup({ input: join(root, "index.js"), plugins: [mainGeneratedScriptsPlugin(directory)] })
  ).rejects.toThrow("too large")
})
