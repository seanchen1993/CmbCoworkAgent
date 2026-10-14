import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import { installLangchainNativeStreamOrigin } from "../../../scripts/apply-langchain-native-stream-origin.mjs"
import {
  installLangchainNativeToolInvokeOrigin, readLangchainNativeStreamBaseFiles,
  readLangchainNativeToolInvokeBeforeFiles, verifyLangchainNativeToolInvokeOverlay
} from "../../../scripts/apply-langchain-native-tool-invoke-origin.mjs"

const fault = vi.hoisted(() => ({ at: 0, calls: 0 }))
vi.mock("node:fs/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs/promises")>()
  return { ...original, async rename(...args: Parameters<typeof original.rename>) {
    fault.calls++
    if (fault.calls === fault.at) throw Error("ACTUAL_OVERLAY_RENAME_FAILURE")
    return original.rename(...args)
  } }
})
interface FileEntry { path: string; beforeSha256: string | null; afterSha256: string }
interface Manifest { files: FileEntry[] }
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cmb-tool-origin-install-"))
  roots.push(root)
  const packageRoot = join(root, "node_modules/langchain")
  const base = await readLangchainNativeStreamBaseFiles({ workspaceRoot: repository })
  const before = await readLangchainNativeToolInvokeBeforeFiles({ workspaceRoot: repository })
  const manifest = JSON.parse(await readFile(join(repository,
    "patches/langchain-1.2.37-native-tool-invoke-origin.manifest.json"), "utf8")) as Manifest
  const files = new Map([...base, ...before])
  for (const [path, bytes] of files) {
    if (bytes === undefined) continue
    await mkdir(dirname(join(packageRoot, path)), { recursive: true })
    await writeFile(join(packageRoot, path), bytes)
  }
  await writeFile(join(packageRoot, "LICENSE"), await readFile(join(repository, "node_modules/langchain/LICENSE")))
  return { root, packageRoot, base, before, manifest }
}
async function assertBefore(f: Awaited<ReturnType<typeof fixture>>) {
  for (const [path, bytes] of f.before) {
    if (bytes === undefined) await expect(readFile(join(f.packageRoot, path))).rejects.toMatchObject({ code: "ENOENT" })
    else expect(await readFile(join(f.packageRoot, path))).toEqual(bytes)
  }
  expect((await readdir(f.packageRoot, { recursive: true })).some(path => String(path).endsWith(".tmp"))).toBe(false)
}
afterEach(async () => {
  fault.at = 0
  fault.calls = 0
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw Error("ACTUAL_FIXTURE_DIRECTORY_REQUIRED")
    await rm(root, { recursive: true, force: true })
  }
})
describe("additive tool invoke installation and whole foundation union", () => {
  it("installs exactly nine postimages and both checkers verify all thirteen files", async () => {
    const f = await fixture()
    await expect(installLangchainNativeToolInvokeOrigin({ workspaceRoot: f.root, checkOnly: true })).rejects.toThrow("LANGCHAIN_TOOL_PATCH_NOT_INSTALLED")
    await assertBefore(f)
    expect(await installLangchainNativeToolInvokeOrigin({ workspaceRoot: f.root })).toEqual({ status: "patched", version: "1.2.37" })
    for (const file of f.manifest.files) expect(hash(await readFile(join(f.packageRoot, file.path)))).toBe(file.afterSha256)
    expect(await verifyLangchainNativeToolInvokeOverlay({ workspaceRoot: f.root })).toBe(true)
    expect(await installLangchainNativeStreamOrigin({ workspaceRoot: f.root, checkOnly: true })).toEqual({ status: "installed", version: "1.2.37" })
    expect(await installLangchainNativeToolInvokeOrigin({ workspaceRoot: f.root, checkOnly: true })).toEqual({ status: "installed", version: "1.2.37" })
    const restored = await readLangchainNativeStreamBaseFiles({ workspaceRoot: f.root })
    expect(restored).toEqual(f.base)
    expect(await readLangchainNativeToolInvokeBeforeFiles({ workspaceRoot: f.root })).toEqual(f.before)
  })
  it("rejects an unknown non-overlapping stream file despite all nine tool postimages", async () => {
    const f = await fixture()
    await installLangchainNativeToolInvokeOrigin({ workspaceRoot: f.root })
    const path = join(f.packageRoot, "dist/native-stream-origin.js")
    const changed = Buffer.concat([await readFile(path), Buffer.from("\n// unknown bytes\n")])
    await writeFile(path, changed)
    expect(await verifyLangchainNativeToolInvokeOverlay({ workspaceRoot: f.root })).toBe(false)
    await expect(installLangchainNativeStreamOrigin({ workspaceRoot: f.root, checkOnly: true })).rejects.toThrow("LANGCHAIN_PATCH_MIXED_OR_UNKNOWN_FILES")
    await expect(installLangchainNativeToolInvokeOrigin({ workspaceRoot: f.root })).rejects.toThrow("LANGCHAIN_PATCH_MIXED_OR_UNKNOWN_FILES")
    expect(await readFile(path)).toEqual(changed)
  })
  it("rejects a partly present overlay before staging or changing the base", async () => {
    const f = await fixture(), path = join(f.packageRoot, "dist/native-tool-invoke-origin.js")
    await writeFile(path, "foreign output\n")
    await expect(installLangchainNativeToolInvokeOrigin({ workspaceRoot: f.root })).rejects.toThrow("LANGCHAIN_PATCH_MIXED_OR_UNKNOWN_FILES")
    for (const [name, bytes] of f.base) expect(await readFile(join(f.packageRoot, name))).toEqual(bytes)
    expect(await readFile(path, "utf8")).toBe("foreign output\n")
  })
  it("rolls an actual partial rename batch back to the usable exact base", async () => {
    const f = await fixture()
    fault.at = 3
    await expect(installLangchainNativeToolInvokeOrigin({ workspaceRoot: f.root })).rejects.toThrow("ACTUAL_OVERLAY_RENAME_FAILURE")
    await assertBefore(f)
    expect(await installLangchainNativeStreamOrigin({ workspaceRoot: f.root, checkOnly: true })).toEqual({ status: "installed", version: "1.2.37" })
  })
  it("rejects a lone changed ToolNode even while all seven older base files remain exact", async () => {
    const f = await fixture(), path = join(f.packageRoot, "dist/agents/nodes/ToolNode.js")
    const changed = Buffer.concat([await readFile(path), Buffer.from("\n// lone unknown Node bytes\n")])
    await writeFile(path, changed)
    await expect(installLangchainNativeStreamOrigin({ workspaceRoot: f.root, checkOnly: true })).rejects.toThrow("LANGCHAIN_PATCH_MIXED_OR_UNKNOWN_FILES")
    await expect(readLangchainNativeStreamBaseFiles({ workspaceRoot: f.root })).rejects.toThrow("LANGCHAIN_PATCH_MIXED_OR_UNKNOWN_FILES")
    for (const [name, bytes] of f.base) expect(await readFile(join(f.packageRoot, name))).toEqual(bytes)
    expect(await readFile(path)).toEqual(changed)
    expect((await readdir(f.packageRoot, { recursive: true })).some(name => String(name).endsWith(".tmp"))).toBe(false)
  })
})
