import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { expect, it } from "vitest"
import { readFlowUnitTestReadiness } from "./template-readiness"

it("reads the real planner without executing scripts and diagnoses missing or malformed entrypoints", async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-template-readiness-"))
  try {
    expect(await readFlowUnitTestReadiness(root)).toMatchObject({
      ready: false,
      reason: expect.stringContaining("package.json")
    })
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ scripts: { test: "this-command-must-never-run" } })
    )
    expect(await readFlowUnitTestReadiness(root)).toEqual({ ready: true, command: "npm run test" })
    await mkdir(join(root, ".cmb"))
    await writeFile(join(root, ".cmb/project-checks.json"), "{invalid}")
    expect(await readFlowUnitTestReadiness(root)).toMatchObject({ ready: false })
    await mkdir(join(root, "tests"))
    await writeFile(
      join(root, ".cmb/project-checks.json"),
      JSON.stringify({
        schemaVersion: 1,
        unitTest: { runner: "python-unittest", startDirectory: "tests", pattern: "test_*.py" }
      })
    )
    expect(await readFlowUnitTestReadiness(root)).toMatchObject({
      ready: true,
      command: expect.stringContaining("unittest")
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
