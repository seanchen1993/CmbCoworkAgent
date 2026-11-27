import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, sep } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { resolveSystemConstraintPath } from "./system-constraint-path"

const temporaryRoots: string[] = []

async function createPluginFixture(): Promise<{ root: string; pluginRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "cmb-system-constraint-"))
  temporaryRoots.push(root)
  const pluginRoot = join(root, "plugin")
  await mkdir(join(pluginRoot, "sys", "stages"), { recursive: true })
  return { root, pluginRoot }
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe("resolveSystemConstraintPath", () => {
  it("returns a stable plugin-relative identity for a physical file under sys", async () => {
    const { pluginRoot } = await createPluginFixture()
    const constraintPath = join(pluginRoot, "sys", "stages", "code.md")
    await writeFile(constraintPath, "constraint")

    await expect(resolveSystemConstraintPath(pluginRoot, constraintPath)).resolves.toBe(
      "sys/stages/code.md"
    )
  })

  it("rejects a similarly named path outside the plugin sys directory", async () => {
    const { pluginRoot } = await createPluginFixture()
    const outsidePath = join(pluginRoot, "system", "code.md")
    await mkdir(join(pluginRoot, "system"), { recursive: true })
    await writeFile(outsidePath, "not a plugin system constraint")

    await expect(resolveSystemConstraintPath(pluginRoot, outsidePath)).resolves.toBeNull()
  })

  it.runIf(process.platform !== "win32")(
    "rejects a symlink under sys when its physical target escapes the directory",
    async () => {
      const { root, pluginRoot } = await createPluginFixture()
      const outsidePath = join(root, "outside.md")
      const linkPath = join(pluginRoot, "sys", "escaped.md")
      await writeFile(outsidePath, "outside")
      await symlink(outsidePath, linkPath)

      await expect(resolveSystemConstraintPath(pluginRoot, linkPath)).resolves.toBeNull()
    }
  )

  it("matches files throughout the knowledge directory and normalizes repeated separators", async () => {
    const { root, pluginRoot } = await createPluginFixture()
    const appDataRoot = join(root, ".cmbcoworkagent")
    vi.stubEnv("CMB_COWORK_AGENT_HOME", appDataRoot)
    const id = "0123456789abcdef0123456789abcdef"
    const readRoot = join(appDataRoot, "knowledge", id, "read")
    const folder = join(readRoot, "guides")
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, "rules.md"), "constraint")

    const filePath = `${root}${sep}${sep}${join(".cmbcoworkagent", "knowledge", id, "read", "guides", "rules.md")}`
    await expect(resolveSystemConstraintPath(pluginRoot, filePath)).resolves.toBe(
      `knowledge/${id}/read/guides/rules.md`
    )
    for (const relativePath of ["index.md", "shared/draft.md", "example/write/rules.md"]) {
      const file = join(appDataRoot, "knowledge", relativePath)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, "constraint")
      await expect(resolveSystemConstraintPath(undefined, file)).resolves.toBe(
        `knowledge/${relativePath}`
      )
    }
    await expect(resolveSystemConstraintPath(pluginRoot, folder)).resolves.toBeNull()
    await expect(resolveSystemConstraintPath(pluginRoot, readRoot)).resolves.toBeNull()
  })

  it("ignores similarly named folders outside the managed knowledge directory", async () => {
    const { root } = await createPluginFixture()
    const appDataRoot = join(root, ".cmbcoworkagent")
    vi.stubEnv("CMB_COWORK_AGENT_HOME", appDataRoot)
    const sibling = join(appDataRoot, "knowledge-backup")
    const lookalike = join(root, "other", ".cmbcoworkagent", "knowledge")
    for (const folder of [sibling, lookalike]) {
      await mkdir(folder, { recursive: true })
      const filePath = join(folder, "rules.md")
      await writeFile(filePath, "ordinary file")
      await expect(resolveSystemConstraintPath(undefined, filePath)).resolves.toBeNull()
    }
  })

  it.runIf(process.platform !== "win32")(
    "rejects a symlink that resolves outside the knowledge directory",
    async () => {
      const { root } = await createPluginFixture()
      vi.stubEnv("CMB_COWORK_AGENT_HOME", root)
      const knowledgeRoot = join(root, "knowledge")
      const outsidePath = join(root, "outside.md")
      const linkPath = join(knowledgeRoot, "link.md")
      await mkdir(knowledgeRoot)
      await writeFile(outsidePath, "outside")
      await symlink(outsidePath, linkPath)

      await expect(resolveSystemConstraintPath(undefined, linkPath)).resolves.toBeNull()
    }
  )
})
