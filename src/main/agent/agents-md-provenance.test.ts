import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { loadAgentsPromptForWorkspace, loadAgentsPromptForWorkspaces } from "./agents-md"

let root: string | undefined
afterEach(async () => {
  vi.unstubAllEnvs()
  if (root) await rm(root, { recursive: true, force: true })
})

it("retains actual User, Project and Local provenance without rediscovering paths", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mods-instructions-")))
  const home = join(root, "home")
  const project = join(root, "project")
  const nested = join(project, "nested")
  await mkdir(home)
  await mkdir(join(project, ".git"), { recursive: true })
  await mkdir(nested)
  vi.stubEnv("CMB_COWORK_AGENT_HOME", home)
  await writeFile(join(home, "AGENTS.md"), "USER_RULE")
  await writeFile(join(project, "AGENTS.md"), "PROJECT_RULE")
  await writeFile(join(nested, "AGENTS.override.md"), "LOCAL_RULE")
  const loaded = await loadAgentsPromptForWorkspace(nested)
  expect(loaded.instructionSources).toEqual([
    { file_path: join(home, "AGENTS.md"), memory_type: "User" },
    { file_path: join(project, "AGENTS.md"), memory_type: "Project" },
    { file_path: join(nested, "AGENTS.override.md"), memory_type: "Local" }
  ])
  const multi = await loadAgentsPromptForWorkspaces({
    primaryWorkspacePath: nested,
    additionalWorkspacePaths: [project, nested],
    includeGlobal: true
  })
  expect(new Set(multi.instructionSources?.map((item) => item.file_path)).size).toBe(
    multi.instructionSources?.length
  )
  expect(multi.instructionSources).toEqual(expect.arrayContaining(loaded.instructionSources!))
})

it("does not label omitted placeholders as injected instructions", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mods-instructions-budget-")))
  const project = join(root, "project")
  await mkdir(join(project, ".git"), { recursive: true })
  await writeFile(join(project, "AGENTS.md"), "A".repeat(10000))
  const loaded = await loadAgentsPromptForWorkspaces(
    { primaryWorkspacePath: project, includeGlobal: false },
    { totalMaxBytes: 1, projectMaxBytes: 1000, globalMaxBytes: 1 }
  )
  expect(loaded.instructionSources).toEqual([])
})
