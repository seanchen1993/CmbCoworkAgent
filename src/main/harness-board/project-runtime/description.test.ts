import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PROJECT_RUNTIME_MAX_BYTES } from "../../../shared/project-runtime"
import { PROJECT_RUNTIME_FILE, readProjectRuntimeDescription } from "./description"

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>())
}))

const roots: string[] = []
const manifest = {
  apiVersion: "devclaw.project-runtime/v1",
  plugin: { id: "docs", version: "1" },
  mode: "legacy",
  stateOwner: "plugin",
  stages: [],
  actions: [],
  artifacts: [],
  checks: [],
  environment: [],
  capabilities: {
    execution: false,
    conditionalTransition: false,
    idempotency: false,
    reconciliation: false,
    cancellation: false
  }
}
async function fixture(content = JSON.stringify(manifest)) {
  const root = await mkdtemp(join(tmpdir(), "project-runtime-"))
  roots.push(root)
  await writeFile(join(root, PROJECT_RUNTIME_FILE), content)
  return root
}
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("static runtime description", () => {
  it("does not require a new declaration from legacy packages", async () => {
    expect(await readProjectRuntimeDescription(undefined)).toBeUndefined()
    const root = await fixture()
    expect(await readProjectRuntimeDescription(root)).toMatchObject({
      status: "ready",
      manifest,
      declarationDigest: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
    await rm(join(root, PROJECT_RUNTIME_FILE))
    expect(await readProjectRuntimeDescription(root)).toBeUndefined()
  })
  it.each(["{", "null", " ".repeat(PROJECT_RUNTIME_MAX_BYTES + 1)])(
    "isolates invalid declarations (%#)",
    async (content) => {
      expect(await readProjectRuntimeDescription(await fixture(content))).toMatchObject({
        status: "invalid"
      })
    }
  )
  it("rejects directories and invalid UTF-8", async () => {
    const root = await fixture()
    await writeFile(join(root, PROJECT_RUNTIME_FILE), Buffer.from([0xff]))
    expect(await readProjectRuntimeDescription(root)).toMatchObject({ status: "invalid" })
    await rm(join(root, PROJECT_RUNTIME_FILE))
    await mkdir(join(root, PROJECT_RUNTIME_FILE))
    expect(await readProjectRuntimeDescription(root)).toMatchObject({ status: "invalid" })
  })
  it("rejects linked declarations before opening them", async () => {
    const root = await fixture()
    const stat = await fs.lstat(join(root, PROJECT_RUNTIME_FILE), { bigint: true })
    vi.spyOn(fs, "lstat").mockResolvedValueOnce({
      ...stat,
      isFile: () => true,
      isSymbolicLink: () => true
    } as typeof stat)
    const open = vi.spyOn(fs, "open")
    expect(await readProjectRuntimeDescription(root)).toMatchObject({ status: "invalid" })
    expect(open).not.toHaveBeenCalled()
  })
  it("propagates cancellation and rejects relative roots", async () => {
    expect(await readProjectRuntimeDescription("relative")).toMatchObject({ status: "invalid" })
    const controller = new AbortController()
    controller.abort()
    await expect(
      readProjectRuntimeDescription(await fixture(), controller.signal)
    ).rejects.toThrow()
  })
})
