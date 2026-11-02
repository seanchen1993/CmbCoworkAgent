import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { assertEmptyProjectDirectory, validateProjectDirectorySelection } from "./project-workspace"

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "project-workspace-"))
})
afterEach(() => rm(root, { recursive: true, force: true }))

describe("project workspace directory", () => {
  it("accepts an existing empty directory", async () => {
    await expect(assertEmptyProjectDirectory(root)).resolves.toBeUndefined()
  })

  it.each(["spec.md", ".DS_Store"])("rejects a directory containing %s", async (name) => {
    await writeFile(join(root, name), "")
    await expect(assertEmptyProjectDirectory(root)).rejects.toThrow("必须为空")
  })

  it.each(["features", ".git"])("rejects a directory containing folder %s", async (name) => {
    await mkdir(join(root, name))
    await expect(assertEmptyProjectDirectory(root)).rejects.toThrow("必须为空")
  })

  it("rejects a missing directory", async () => {
    await expect(assertEmptyProjectDirectory(join(root, "missing"))).rejects.toThrow("不存在")
  })

  it("rejects a file", async () => {
    const file = join(root, "file")
    await writeFile(file, "")
    await expect(assertEmptyProjectDirectory(file)).rejects.toThrow("请选择文件夹")
  })

  it("returns the selected path and validation result before project creation", async () => {
    expect(await validateProjectDirectorySelection(root)).toEqual({
      workspacePath: dirname(root),
      projectDir: basename(root),
      validationError: null
    })
  })

  it.each(["spec.md", ".DS_Store", ".git"])(
    "returns a field error for %s without discarding the selected path",
    async (name) => {
      if (name === ".git") await mkdir(join(root, name))
      else await writeFile(join(root, name), "")
      expect(await validateProjectDirectorySelection(root)).toEqual({
        workspacePath: dirname(root),
        projectDir: basename(root),
        validationError: expect.stringContaining("必须为空")
      })
    }
  )

  it("clears validation errors when the next selected directory is empty", async () => {
    await writeFile(join(root, ".DS_Store"), "")
    expect((await validateProjectDirectorySelection(root)).validationError).not.toBeNull()
    const empty = join(root, "empty")
    await mkdir(empty)
    expect((await validateProjectDirectorySelection(empty)).validationError).toBeNull()
  })
})
