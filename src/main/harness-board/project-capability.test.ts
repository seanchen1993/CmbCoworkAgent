import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import * as fs from "node:fs/promises"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { serialize } from "node:v8"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  attachProjectCapability,
  PROJECT_CAPABILITY_FILE,
  readProjectCapability
} from "./project-capability"
import {
  PROJECT_CAPABILITY_MAX_BYTES,
  type ProjectCapabilityManifest,
  type ProjectCapabilityView
} from "../../shared/project-capability"

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>())
}))

const roots: string[] = []
const manifest: ProjectCapabilityManifest = {
  apiVersion: "devclaw.project/v1",
  name: "项目能力",
  description: "原执行链的静态指导",
  help: [],
  stages: [{ nodeId: "plan", guidance: "规划", before: [], after: [] }]
}

async function fixture(content = JSON.stringify(manifest)): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "project-capability-"))
  roots.push(root)
  await writeFile(join(root, PROJECT_CAPABILITY_FILE), content)
  return root
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("bound project capability reader", () => {
  it("preserves absent legacy plugins and reads only the provided bound plugin root", async () => {
    expect(await readProjectCapability(undefined)).toBeUndefined()
    const first = await fixture()
    const second = await fixture(JSON.stringify({ ...manifest, name: "另一绑定" }))
    expect(await readProjectCapability(first)).toEqual({ status: "ready", manifest })
    expect(await readProjectCapability(second)).toMatchObject({
      status: "ready",
      manifest: { name: "另一绑定" }
    })
    await rm(join(first, PROJECT_CAPABILITY_FILE))
    expect(await readProjectCapability(first)).toBeUndefined()
    await writeFile(join(first, PROJECT_CAPABILITY_FILE), JSON.stringify(manifest))
    expect(await readProjectCapability(first)).toMatchObject({ status: "ready" })
  })

  it.each([
    "",
    "{",
    "null",
    JSON.stringify({ ...manifest, commands: ["run"] }),
    " ".repeat(PROJECT_CAPABILITY_MAX_BYTES + 1)
  ])("isolates empty, malformed, unknown and oversized declarations (%#)", async (content) => {
    expect(await readProjectCapability(await fixture(content))).toMatchObject({ status: "invalid" })
  })

  it("rejects invalid UTF-8 instead of replacing bytes", async () => {
    const root = await fixture()
    const bytes = Buffer.from(JSON.stringify(manifest))
    bytes[bytes.indexOf(Buffer.from("项目"))] = 0xff
    await writeFile(join(root, PROJECT_CAPABILITY_FILE), bytes)
    expect(await readProjectCapability(root)).toMatchObject({ status: "invalid" })
  })

  it("accepts a valid declaration at the file byte limit", async () => {
    const content = JSON.stringify(manifest)
    const padded = content + " ".repeat(PROJECT_CAPABILITY_MAX_BYTES - Buffer.byteLength(content))
    expect(await readProjectCapability(await fixture(padded))).toEqual({
      status: "ready",
      manifest
    })
  })

  it("rejects a directory or relative plugin path", async () => {
    expect(await readProjectCapability("relative/plugin")).toMatchObject({ status: "invalid" })
    const root = await fixture()
    await rm(join(root, PROJECT_CAPABILITY_FILE))
    await mkdir(join(root, PROJECT_CAPABILITY_FILE))
    expect(await readProjectCapability(root)).toMatchObject({ status: "invalid" })
  })

  it("rejects a final symlink before opening it", async () => {
    const root = await fixture()
    const original = await fs.lstat(join(root, PROJECT_CAPABILITY_FILE), { bigint: true })
    vi.spyOn(fs, "lstat").mockResolvedValueOnce({
      ...original,
      isFile: () => true,
      isSymbolicLink: () => true
    } as typeof original)
    const open = vi.spyOn(fs, "open")
    expect(await readProjectCapability(root)).toMatchObject({ status: "invalid" })
    expect(open).not.toHaveBeenCalled()
  })

  it("rejects a resolved path outside the fixed root before opening it", async () => {
    const root = await fixture()
    const canonical = await fs.realpath(root)
    vi.spyOn(fs, "realpath").mockResolvedValueOnce(canonical).mockResolvedValueOnce(tmpdir())
    const open = vi.spyOn(fs, "open")
    expect(await readProjectCapability(root)).toMatchObject({ status: "invalid" })
    expect(open).not.toHaveBeenCalled()
  })

  it("isolates permission errors without disclosing filesystem error text", async () => {
    const root = await fixture()
    vi.spyOn(fs, "open").mockRejectedValueOnce(new Error("EACCES sensitive/path"))
    const result = await readProjectCapability(root)
    expect(result).toMatchObject({ status: "invalid" })
    expect(JSON.stringify(result)).not.toContain("sensitive")
  })

  it("rejects a changed file and closes its handle", async () => {
    const root = await fixture()
    const handle = await fs.open(join(root, PROJECT_CAPABILITY_FILE), "r")
    const initial = await handle.stat({ bigint: true })
    vi.spyOn(handle, "stat")
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce({
        ...initial,
        isFile: () => true,
        size: initial.size + 1n
      } as typeof initial)
    const close = vi.spyOn(handle, "close")
    vi.spyOn(fs, "open").mockResolvedValueOnce(handle)
    expect(await readProjectCapability(root)).toMatchObject({ status: "invalid" })
    expect(close).toHaveBeenCalledOnce()
  })

  it("propagates cancellation instead of reporting a bad declaration", async () => {
    const controller = new AbortController()
    controller.abort(new Error("cancelled"))
    await expect(readProjectCapability(undefined, controller.signal)).rejects.toThrow("cancelled")
    const next = new AbortController()
    const root = await fixture()
    const handle = await fs.open(join(root, PROJECT_CAPABILITY_FILE), "r")
    const close = vi.spyOn(handle, "close")
    vi.spyOn(fs, "open").mockImplementationOnce(async () => {
      next.abort(new Error("cancelled during open"))
      return handle
    })
    await expect(readProjectCapability(root, next.signal)).rejects.toThrow("cancelled during open")
    expect(close).toHaveBeenCalledOnce()
  })

  it("binds the service read to its resolved plugin and preserves cancellation and IPC checks", () => {
    const source = readFileSync(new URL("./service.ts", import.meta.url), "utf8")
    const start = source.indexOf("async function loadHarnessRunDetail(")
    const end = source.indexOf("async function validateFeatureWorkspace(", start)
    const section = source.slice(start, end)
    expect(section).toContain("readProjectCapability(context.plugin?.path, signal)")
    expect(section).toMatch(/readProjectCapability[\s\S]*throwIfHarnessDetailCancelled\(signal\)/)
    expect(section.indexOf("attachProjectCapability(detail, projectCapability)")).toBeLessThan(
      section.indexOf("const responseBytes = serialize(detail).byteLength")
    )
  })
})

describe("optional capability IPC budget", () => {
  it("does not change legacy details and attaches bounded ready declarations", () => {
    const detail: { data: string; projectCapability?: ProjectCapabilityView } = { data: "legacy" }
    attachProjectCapability(detail, undefined)
    expect(detail).toEqual({ data: "legacy" })
    attachProjectCapability(detail, { status: "ready", manifest })
    expect(detail.projectCapability).toEqual({ status: "ready", manifest })
  })

  it("downgrades oversized enhancements and omits them if even a diagnostic will not fit", () => {
    const detail: { data: string; projectCapability?: ProjectCapabilityView } = { data: "legacy" }
    const capability: ProjectCapabilityView = {
      status: "ready",
      manifest: {
        ...manifest,
        description: "x".repeat(2000)
      }
    }
    attachProjectCapability(detail, capability, 512)
    expect(detail.projectCapability?.status).toBe("invalid")
    expect(serialize(detail).byteLength).toBeLessThanOrEqual(512)
    const baselineBytes = serialize({ data: "legacy" }).byteLength
    attachProjectCapability(detail, capability, baselineBytes)
    expect(detail).toEqual({ data: "legacy" })
    expect(serialize(detail).byteLength).toBe(baselineBytes)
  })
})
