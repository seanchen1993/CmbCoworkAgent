import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { resolvePluginSystemConstraintPath } from "./plugin-system-constraint"

const temporaryRoots: string[] = []

async function createPluginFixture(): Promise<{ root: string; pluginRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "cmb-system-constraint-"))
  temporaryRoots.push(root)
  const pluginRoot = join(root, "plugin")
  await mkdir(join(pluginRoot, "sys", "stages"), { recursive: true })
  return { root, pluginRoot }
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe("resolvePluginSystemConstraintPath", () => {
  it("returns a stable plugin-relative identity for a physical file under sys", async () => {
    const { pluginRoot } = await createPluginFixture()
    const constraintPath = join(pluginRoot, "sys", "stages", "code.md")
    await writeFile(constraintPath, "constraint")

    await expect(resolvePluginSystemConstraintPath(pluginRoot, constraintPath)).resolves.toBe(
      "sys/stages/code.md"
    )
  })

  it("rejects a similarly named path outside the plugin sys directory", async () => {
    const { pluginRoot } = await createPluginFixture()
    const outsidePath = join(pluginRoot, "system", "code.md")
    await mkdir(join(pluginRoot, "system"), { recursive: true })
    await writeFile(outsidePath, "not a plugin system constraint")

    await expect(resolvePluginSystemConstraintPath(pluginRoot, outsidePath)).resolves.toBeNull()
  })

  it.runIf(process.platform !== "win32")(
    "rejects a symlink under sys when its physical target escapes the directory",
    async () => {
      const { root, pluginRoot } = await createPluginFixture()
      const outsidePath = join(root, "outside.md")
      const linkPath = join(pluginRoot, "sys", "escaped.md")
      await writeFile(outsidePath, "outside")
      await symlink(outsidePath, linkPath)

      await expect(resolvePluginSystemConstraintPath(pluginRoot, linkPath)).resolves.toBeNull()
    }
  )
})
