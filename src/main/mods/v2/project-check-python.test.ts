import { exec } from "node:child_process"
import { promisify } from "node:util"
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { assertProjectCheckPlanCurrent, planProjectCheck } from "./project-check-plan"
import { parseProjectCheckConfig } from "./project-check-config"
import { captureCompletionBinding } from "./completion-evidence"

const execute = promisify(exec)
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const config = (patch: Record<string, unknown> = {}) =>
  JSON.stringify({
    schemaVersion: 1,
    unitTest: { runner: "python-unittest", startDirectory: "tests", pattern: "test_*.py", ...patch }
  })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mods-python-check-"))
  roots.push(root)
  await mkdir(join(root, ".cmb"))
  await mkdir(join(root, "tests"))
  await writeFile(join(root, ".cmb/project-checks.json"), config())
  return root
}

it("runs Python's real unittest loader and never accepts an empty suite as passing", async () => {
  const root = await fixture()
  const plan = await planProjectCheck(root, "unit-test")
  await expect(execute(plan.command, { cwd: root, windowsHide: true })).rejects.toMatchObject({
    code: 2
  })
  await writeFile(
    join(root, "tests/test_real.py"),
    "import unittest\nclass Real(unittest.TestCase):\n def test_value(self): self.assertEqual(1 + 1, 2)\n"
  )
  const passed = await execute(plan.command, { cwd: root, windowsHide: true })
  expect(passed.stderr).toContain("Ran 1 test")
  expect(passed.stderr).toContain("OK")
  await writeFile(
    join(root, "tests/test_real.py"),
    "import unittest\nclass Real(unittest.TestCase):\n def test_value(self): self.assertEqual(1 + 1, 3)\n"
  )
  await expect(execute(plan.command, { cwd: root, windowsHide: true })).rejects.toMatchObject({
    code: 1
  })
})

it.each([
  { startDirectory: "../outside" },
  { startDirectory: "/outside" },
  { startDirectory: "C:/outside" },
  { startDirectory: "tests;echo" },
  { startDirectory: "tests/$HOME" },
  { startDirectory: "tests/%TEMP%" },
  { pattern: 'test_*.py";echo injected' },
  { pattern: "../test_*.py" },
  { pattern: "test_`id`.py" },
  { runner: "arbitrary-shell" },
  { command: "echo bad" }
])("rejects shell/path/unknown-runner configuration: %j", (patch) => {
  expect(() => parseProjectCheckConfig(config(patch))).toThrow("PROJECT_CHECK_CONFIG_INVALID")
})

it("pins config bytes, including appearance after an old npm plan, and rejects fabricated plans", async () => {
  const root = await fixture()
  const plan = await planProjectCheck(root, "unit-test")
  await assertProjectCheckPlanCurrent(plan)
  await writeFile(join(root, ".cmb/project-checks.json"), config({ pattern: "test_other.py" }))
  await expect(assertProjectCheckPlanCurrent(plan)).rejects.toThrow("PROJECT_CHECK_CONFIG_CHANGED")
  await expect(assertProjectCheckPlanCurrent({ ...plan })).rejects.toThrow(
    "PROJECT_CHECK_CONFIG_CHANGED"
  )
  await rm(join(root, ".cmb/project-checks.json"))
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "existing" } }))
  const npm = await planProjectCheck(root, "unit-test")
  expect(npm.command).toBe("npm run test")
  await writeFile(join(root, ".cmb/project-checks.json"), config())
  await expect(assertProjectCheckPlanCurrent(npm)).rejects.toThrow("PROJECT_CHECK_CONFIG_CHANGED")
})

it("rejects a linked test directory and malformed configuration rather than falling back to npm", async () => {
  const root = await fixture()
  await mkdir(join(root, "elsewhere"))
  await symlink(join(root, "elsewhere"), join(root, "linked"), "junction")
  await writeFile(join(root, ".cmb/project-checks.json"), config({ startDirectory: "linked" }))
  await expect(planProjectCheck(root, "unit-test")).rejects.toThrow(
    "PROJECT_CHECK_DIRECTORY_INVALID"
  )
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "existing" } }))
  await writeFile(join(root, ".cmb/project-checks.json"), "invalid")
  await expect(planProjectCheck(root, "unit-test")).rejects.toThrow("PROJECT_CHECK_CONFIG_INVALID")
})

it.each(["tests", "tests/suite"])(
  "rejects a final/parent directory junction during approval: %s",
  async (startDirectory) => {
    const root = await fixture()
    await mkdir(join(root, "tests/suite"))
    await writeFile(join(root, ".cmb/project-checks.json"), config({ startDirectory }))
    const plan = await planProjectCheck(root, "unit-test")
    await rename(join(root, "tests"), join(root, "original-tests"))
    await symlink(join(root, "original-tests"), join(root, "tests"), "junction")
    await expect(assertProjectCheckPlanCurrent(plan)).rejects.toThrow(
      "PROJECT_CHECK_DIRECTORY_INVALID"
    )
    // The subprocess repeats the guard after the asynchronous human approval boundary.
    await expect(execute(plan.command, { cwd: root, windowsHide: true })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("PROJECT_CHECK_DIRECTORY_INVALID")
    })
  }
)

it("binds ignored runner config into completion evidence even outside the selected source scope", async () => {
  const root = await fixture()
  await execute("git init", { cwd: root, windowsHide: true })
  await writeFile(join(root, ".gitignore"), ".cmb/\n")
  const capture = () =>
    captureCompletionBinding({
      workspace: root,
      threadId: "t",
      turnId: "turn",
      pluginDigests: {},
      runtimeGeneration: 1,
      paths: []
    })
  const before = await capture()
  await writeFile(join(root, ".cmb/project-checks.json"), config({ pattern: "test_other.py" }))
  const after = await capture()
  expect(after.diffFingerprint).toBe(before.diffFingerprint)
  expect(after.configFingerprint).not.toBe(before.configFingerprint)
})

it("keeps E2E on its declared npm runner and bounds/cancels explicit configuration reads", async () => {
  const root = await fixture()
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ scripts: { "test:e2e": "existing" } })
  )
  expect((await planProjectCheck(root, "e2e")).command).toBe("npm run test:e2e")
  const controller = new AbortController()
  controller.abort(Error("stop before Python planning"))
  await expect(planProjectCheck(root, "unit-test", controller.signal)).rejects.toThrow(
    "stop before Python planning"
  )
  await writeFile(join(root, ".cmb/project-checks.json"), Buffer.alloc(16 * 1024 + 1, 32))
  await expect(planProjectCheck(root, "unit-test")).rejects.toThrow()
})
