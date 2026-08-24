import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../services/system-constraint-read-reporter", () => ({
  recordSystemConstraintRead: vi.fn()
}))

import { recordSystemConstraintRead } from "../services/system-constraint-read-reporter"
import { LocalSandbox } from "./local-sandbox"

const temporaryRoots: string[] = []

async function createSandboxFixture(): Promise<{
  sandbox: LocalSandbox
  constraintPath: string
  emptyConstraintPath: string
  outsidePath: string
}> {
  const root = await mkdtemp(join(tmpdir(), "cmb-sandbox-system-constraint-"))
  temporaryRoots.push(root)
  const pluginRoot = join(root, "plugin")
  const sysDir = join(pluginRoot, "sys")
  await mkdir(sysDir, { recursive: true })
  const constraintPath = join(sysDir, "project.md")
  const emptyConstraintPath = join(sysDir, "empty.md")
  const outsidePath = join(pluginRoot, "README.md")
  await Promise.all([
    writeFile(constraintPath, "first constraint\nsecond constraint\n"),
    writeFile(emptyConstraintPath, ""),
    writeFile(outsidePath, "plugin documentation\n")
  ])
  return {
    sandbox: new LocalSandbox({
      rootDir: root,
      runId: "thread-1",
      agentId: "agent-1",
      pluginRoot,
      pluginId: "plugin-1",
      pluginName: "Plugin One",
      featureId: "feature-1",
      harnessProjectId: "project-1",
      harnessNodeName: "Dev-代码实现",
      harnessNodeStatus: "进行中",
      traceId: "trace-1",
      rootTraceId: "root-trace-1",
      rootThreadId: "root-thread-1"
    }),
    constraintPath,
    emptyConstraintPath,
    outsidePath
  }
}

beforeEach(() => {
  vi.mocked(recordSystemConstraintRead).mockClear()
})

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe("LocalSandbox system-constraint telemetry", () => {
  it("records only after read_file actually returns constraint content", async () => {
    const { sandbox, constraintPath, emptyConstraintPath, outsidePath } =
      await createSandboxFixture()

    await expect(sandbox.read(constraintPath, 0, 1)).resolves.toContain("first constraint")
    expect(recordSystemConstraintRead).toHaveBeenCalledTimes(1)
    expect(recordSystemConstraintRead).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: "trace-1",
        harnessProjectId: "project-1",
        harnessFeatureSlug: "feature-1",
        harnessNodeName: "Dev-代码实现",
        constraintFile: "sys/project.md"
      })
    )

    await expect(sandbox.read(emptyConstraintPath)).resolves.toContain("empty contents")
    await expect(sandbox.read(constraintPath, 99, 1)).resolves.toContain("exceeds file length")
    await expect(sandbox.read(outsidePath)).resolves.toContain("plugin documentation")
    expect(recordSystemConstraintRead).toHaveBeenCalledTimes(1)
  })
})
