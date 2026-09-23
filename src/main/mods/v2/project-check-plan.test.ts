import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { planProjectCheck } from "./project-check-plan"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function project(scripts: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "mods-check-plan-"))
  roots.push(root)
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts }))
  return root
}

it("selects declared unit and E2E scripts without interpolating their shell bodies", async () => {
  const root = await project({ test: "node unit.cjs", "test:e2e": "node browser.cjs" })
  expect(await planProjectCheck(root, "unit-test")).toEqual({
    kind: "unit-test",
    command: "npm run test",
    cwd: root
  })
  expect(await planProjectCheck(root, "e2e")).toEqual({
    kind: "e2e",
    command: "npm run test:e2e",
    cwd: root
  })
})

it("prefers an explicit unit script and never accepts an absent check as passing", async () => {
  const root = await project({ test: "node everything.cjs", "test:unit": "node unit.cjs" })
  expect((await planProjectCheck(root, "unit-test")).command).toBe("npm run test:unit")
  await expect(planProjectCheck(root, "e2e")).rejects.toThrow("PROJECT_CHECK_UNAVAILABLE")
})

it("retains local Vitest and existing Mods E2E entrypoints without npx or Electron execPath", async () => {
  const root = await project()
  await mkdir(join(root, "node_modules/vitest"), { recursive: true })
  await writeFile(join(root, "node_modules/vitest/vitest.mjs"), "export {}")
  await mkdir(join(root, "tests"))
  await writeFile(join(root, "tests/run-mods-e2e.mjs"), "export {}")
  expect((await planProjectCheck(root, "unit-test")).command).toBe(
    "node node_modules/vitest/vitest.mjs run"
  )
  expect((await planProjectCheck(root, "e2e")).command).toBe("node tests/run-mods-e2e.mjs")
})

it("refuses to fetch a missing test runner", async () => {
  await expect(planProjectCheck(await project(), "unit-test")).rejects.toThrow(
    "PROJECT_CHECK_UNAVAILABLE"
  )
})

it("bounds the manifest and honors cancellation before reading it", async () => {
  const root = await project()
  await writeFile(join(root, "package.json"), Buffer.alloc(128 * 1024 + 1, 32))
  await expect(planProjectCheck(root, "unit-test")).rejects.toThrow()
  const controller = new AbortController()
  controller.abort(Error("cancelled before plan"))
  await expect(planProjectCheck(root, "unit-test", controller.signal)).rejects.toThrow(
    "cancelled before plan"
  )
})
