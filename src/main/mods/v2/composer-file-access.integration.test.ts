import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import * as skills from "../claw-skills"
import { createComposerPermissionScope } from "./composer-permission-scope"
import { ProjectFunctionFiles } from "./file-access"

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: () => {} }
}))
const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it("reads cold configuration through the real native probe while preserving Claw file exclusions", async () => {
  const root = mkdtempSync(join(tmpdir(), "mods-composer-files-"))
  roots.push(root)
  const source = join(root, "skills")
  for (const name of ["selected", "excluded"]) {
    mkdirSync(join(source, name), { recursive: true })
    writeFileSync(
      join(source, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: fixture\n---\n${name}`
    )
  }
  writeFileSync(join(root, "config.json"), "PROJECT_CONFIG")
  const access = {
    sources: async () => [{ sourceDir: source }],
    currentSources: () => [{ sourceDir: source }],
    disabledDirs: () => []
  }
  const entries = await skills.listClawSkillSources(access)
  const selection = {
    mode: "selected" as const,
    items: entries.filter((row) => row.name === "selected")
  }
  const policy = await skills.createClawSkillPolicy(selection, access)
  vi.spyOn(skills, "createClawSkillPolicy").mockResolvedValue(policy)
  const controller = new AbortController()
  const scope = await createComposerPermissionScope(
    root,
    "composer-files",
    () => {},
    controller.signal,
    selection
  )
  const files = new ProjectFunctionFiles(
    root,
    scope.assertLive,
    async (value) => value,
    scope.queryTool
  )
  expect(await files.run("fs.read", "config.json", controller.signal)).toBe("PROJECT_CONFIG")
  expect(await files.run("fs.read", "skills/selected/SKILL.md", controller.signal)).toContain(
    "selected"
  )
  await expect(files.run("fs.read", "skills/excluded/SKILL.md", controller.signal)).rejects.toThrow(
    "MODS_FS_ACCESS_DENIED"
  )
  for (const tool of ["write_file", "execute", "task", "function:read_file"])
    expect(await scope.queryTool(tool, { file_path: join(root, "config.json") })).toMatchObject({
      decision: "deny"
    })
  controller.abort(Error("cancelled"))
  await expect(files.run("fs.read", "config.json", controller.signal)).rejects.toThrow("cancelled")
})
