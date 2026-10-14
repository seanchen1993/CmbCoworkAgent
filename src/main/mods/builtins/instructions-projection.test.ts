import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { loadAgentsPromptForWorkspace, loadAgentsPromptForWorkspaces } from "../../agent/agents-md"

let root: string | undefined
afterEach(async () => {
  vi.unstubAllEnvs()
  if (root) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  root = await realpath(await mkdtemp(join(tmpdir(), "builtin-instructions-")))
  const project = join(root, "project")
  const home = join(root, "home")
  await mkdir(join(project, ".git"), { recursive: true })
  await mkdir(home)
  vi.stubEnv("CMB_COWORK_AGENT_HOME", home)
  return { project, home }
}

it("reports total-budget omissions without treating their placeholder as injected text", async () => {
  const { project } = await fixture()
  const path = join(project, "AGENTS.md")
  await writeFile(path, "rule ".repeat(2000))
  const result = await loadAgentsPromptForWorkspaces(
    { primaryWorkspacePath: project, includeGlobal: false },
    { projectMaxBytes: 1000, globalMaxBytes: 1, totalMaxBytes: 1 }
  )
  expect(result.instructionProjection).toContainEqual(
    expect.objectContaining({
      path,
      layer: "project",
      scope: project,
      delivery: "omitted"
    })
  )
  expect(result.instructionFiles).toEqual([])
  expect(result.loadedPaths).toContain(path)
})

it("preserves the original loaded content while reporting per-file truncation and scope", async () => {
  const { project, home } = await fixture()
  await writeFile(join(home, "AGENTS.md"), "global rule")
  await writeFile(join(project, "AGENTS.md"), "rule ".repeat(2000))
  const result = await loadAgentsPromptForWorkspace(project, {
    globalMaxBytes: 1000,
    projectMaxBytes: 1000
  })
  expect(result.instructionProjection).toContainEqual(
    expect.objectContaining({
      path: join(home, "AGENTS.md"),
      layer: "user",
      delivery: "injected"
    })
  )
  expect(result.instructionProjection).toContainEqual(
    expect.objectContaining({
      path: join(project, "AGENTS.md"),
      layer: "project",
      delivery: "truncated",
      scope: project
    })
  )
  expect(result.instructionFiles?.map((entry) => entry.path)).toEqual(result.loadedPaths)
  expect(result.prompt).toContain("[truncated to fit prompt budget]")
})
