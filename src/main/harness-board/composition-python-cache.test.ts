import { mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { afterEach, describe, expect, it } from "vitest"
import { suppressCompositionPythonCache } from "./composition-python-cache"
import { isReviewedAutobizProtocol } from "../plugins/autobiz-composition-protocol"

const folders: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "composition-cache-"))
  folders.push(root)
  return root
}
async function declare(root: string, mode = "legacy") {
  await writeFile(
    join(root, "devclaw.stage-checks.json"),
    JSON.stringify({
      apiVersion: "devclaw.stage-check-adapter/v1",
      adapter: "autobiz-v1"
    })
  )
  await writeFile(
    join(root, "devclaw.project-runtime.json"),
    JSON.stringify({
      apiVersion: "devclaw.project-runtime/v1",
      mode,
      stateOwner: "plugin"
    })
  )
}
afterEach(async () => {
  for (const root of folders.splice(0)) await rm(root, { recursive: true, force: true })
})
describe("composition Python cache preference", () => {
  it("leaves undeclared original plugins unchanged", async () => {
    expect(await suppressCompositionPythonCache(await fixture())).toBe(false)
  })
  it("requires both matching declarations, without granting protocol admission", async () => {
    const root = await fixture()
    await declare(root)
    // No Python protocol is present: this flag is not an admission result.
    expect(await suppressCompositionPythonCache(root)).toBe(true)
    await writeFile(join(root, "devclaw.stage-checks.json"), "{}")
    expect(await suppressCompositionPythonCache(root)).toBe(false)
  })
  it("does not opt a host-managed package into the legacy preference", async () => {
    const root = await fixture()
    await declare(root, "host")
    expect(await suppressCompositionPythonCache(root)).toBe(false)
  })
  it("suppresses v2 inline legacy bytecode without granting source or contract admission", async () => {
    const root = await fixture()
    await declare(root)
    const runtime = JSON.stringify({ apiVersion: "devclaw.project-runtime/v2",
      runtime: { apiVersion: "devclaw.project-runtime/v1", mode: "legacy", stateOwner: "plugin" } })
    await writeFile(join(root, "devclaw.project-runtime.json"), runtime)
    expect(await suppressCompositionPythonCache(root)).toBe(true)
    expect(isReviewedAutobizProtocol({ files: [{ path: "devclaw.project-runtime.json",
      bytes: Buffer.from(runtime) }] })).toBe(false)
  })
  it.each([
    { apiVersion: "devclaw.project-runtime/v3", runtime: { apiVersion: "devclaw.project-runtime/v1", mode: "legacy", stateOwner: "plugin" } },
    { apiVersion: "devclaw.project-runtime/v2", runtime: [] },
    { apiVersion: "devclaw.project-runtime/v2", runtime: { apiVersion: "devclaw.project-runtime/v3", mode: "legacy", stateOwner: "plugin" } },
    { apiVersion: "devclaw.project-runtime/v2", runtime: { apiVersion: "devclaw.project-runtime/v1", mode: "host", stateOwner: "host" } }
  ])("does not infer a legacy preference from an unsupported inline shape %j", async runtime => {
    const root = await fixture()
    await declare(root)
    await writeFile(join(root, "devclaw.project-runtime.json"), JSON.stringify(runtime))
    expect(await suppressCompositionPythonCache(root)).toBe(false)
  })
  it("accepts a declaration above 32 KiB within the catalog limit", async () => {
    const root = await fixture()
    await declare(root)
    await writeFile(
      join(root, "devclaw.project-runtime.json"),
      JSON.stringify({
        apiVersion: "devclaw.project-runtime/v1",
        mode: "legacy",
        stateOwner: "plugin",
        description: "x".repeat(40000)
      })
    )
    expect(await suppressCompositionPythonCache(root)).toBe(true)
  })
  it("bounds declarations and tolerates malformed optional metadata", async () => {
    const root = await fixture()
    await declare(root)
    await writeFile(join(root, "devclaw.project-runtime.json"), "x".repeat(65537))
    expect(await suppressCompositionPythonCache(root)).toBe(false)
    await writeFile(join(root, "devclaw.project-runtime.json"), "{")
    expect(await suppressCompositionPythonCache(root)).toBe(false)
  })
  it("does not delete existing bytecode or change inherited process settings", async () => {
    const root = await fixture()
    await declare(root)
    await writeFile(join(root, "existing.pyc"), "existing")
    const inherited = process.env.PYTHONDONTWRITEBYTECODE
    expect(await suppressCompositionPythonCache(root)).toBe(true)
    expect(await readdir(root)).toContain("existing.pyc")
    expect(process.env.PYTHONDONTWRITEBYTECODE).toBe(inherited)
  })
  it("rejects a package reached through a directory link", async () => {
    const root = await fixture()
    const source = await fixture()
    await declare(source)
    await symlink(source, join(root, "linked"), process.platform === "win32" ? "junction" : "dir")
    expect(await suppressCompositionPythonCache(join(root, "linked"))).toBe(false)
  })
  it("lets Python run its original imports without creating package bytecode", async () => {
    const root = await fixture()
    await declare(root)
    await writeFile(join(root, "helper.py"), "VALUE = 42\n")
    const enabled = await suppressCompositionPythonCache(root)
    const result = spawnSync("python", ["-c", "import helper; assert helper.VALUE == 42"], {
      cwd: root,
      env: { ...process.env, ...(enabled ? { PYTHONDONTWRITEBYTECODE: "1" } : {}) },
      encoding: "utf8",
      windowsHide: true
    })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(await readdir(root)).not.toContain("__pycache__")
  })
})
