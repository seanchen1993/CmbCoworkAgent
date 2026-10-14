import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import { installLangchainInnerStreamOrigin } from "../../../scripts/apply-langchain-inner-stream-origin.mjs"
import {
  readLangchainNativeStreamBaseFiles,
  readLangchainNativeToolInvokeBeforeFiles
} from "../../../scripts/apply-langchain-native-tool-invoke-origin.mjs"

const renameFault = vi.hoisted(() => ({ calls: 0, at: 0 }))
vi.mock("node:fs/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...original,
    async rename(...args: Parameters<typeof original.rename>) {
      renameFault.calls++
      if (renameFault.calls === renameFault.at) throw Error("ACTUAL_INNER_RENAME_FAILURE")
      return original.rename(...args)
    }
  }
})

interface FileEntry {
  path: string
  beforeSha256: string | null
  afterSha256: string
}
interface Manifest {
  name: string
  version: string
  upstreamTarball: string
  upstreamIntegrity: string
  patchSha256: string
  licenseSha256: string
  files: FileEntry[]
}
interface PackageFixture {
  packageRoot: string
  manifest: Manifest
  before: Map<string, Buffer | undefined>
  after: Map<string, Buffer>
}
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const roots: string[] = []
const artifacts = [
  "langchain-core-1.1.36-native-stream-origin",
  "langgraph-1.2.5-native-stream-origin"
]
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

/** The checked full-file patch retains exact official preimages, including their EOF bytes. */
function recoverFiles(patch: string, entries: FileEntry[]) {
  const lines = patch.split("\n")
  const before = new Map<string, Buffer | undefined>()
  const after = new Map<string, Buffer>()
  let index = 0
  for (const entry of entries) {
    expect(lines[index++]).toBe(
      entry.beforeSha256 === null ? "--- /dev/null" : `--- a/${entry.path}`
    )
    expect(lines[index++]).toBe(`+++ b/${entry.path}`)
    const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(lines[index++])
    if (!header) throw Error("EXACT_FULL_FILE_HUNK_REQUIRED")
    const oldRows: string[] = []
    const newRows: string[] = []
    let oldEndsLF = true
    let newEndsLF = true
    let oldMarked = -1
    let newMarked = -1
    while (index < lines.length && lines[index] !== "" && !lines[index].startsWith("--- ")) {
      const line = lines[index++]
      const kind = line[0]
      if (kind !== "-" && kind !== "+") throw Error("EXACT_FULL_FILE_LINE_REQUIRED")
      const noLF = lines[index] === "\\ No newline at end of file"
      if (noLF) index++
      if (kind === "-") {
        oldRows.push(line.slice(1))
        oldEndsLF = !noLF
        if (noLF) oldMarked = oldRows.length
      } else {
        newRows.push(line.slice(1))
        newEndsLF = !noLF
        if (noLF) newMarked = newRows.length
      }
    }
    expect(oldRows.length).toBe(Number(header[2]))
    expect(newRows.length).toBe(Number(header[4]))
    expect(Number(header[1])).toBe(oldRows.length ? 1 : 0)
    expect(Number(header[3])).toBe(newRows.length ? 1 : 0)
    if (oldMarked !== -1) expect(oldMarked).toBe(oldRows.length)
    if (newMarked !== -1) expect(newMarked).toBe(newRows.length)
    const original = entry.beforeSha256 === null
      ? undefined
      : Buffer.from(oldRows.join("\n") + (oldRows.length && oldEndsLF ? "\n" : ""))
    const postimage = Buffer.from(
      newRows.join("\n") + (newRows.length && newEndsLF ? "\n" : "")
    )
    expect(original === undefined ? null : digest(original)).toBe(entry.beforeSha256)
    expect(digest(postimage)).toBe(entry.afterSha256)
    before.set(entry.path, original)
    after.set(entry.path, postimage)
  }
  expect(lines.slice(index)).toEqual([""])
  return { before, after }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cmb-inner-origin-install-"))
  roots.push(root)
  const langchainRoot = join(root, "node_modules/langchain")
  const base = await readLangchainNativeStreamBaseFiles({ workspaceRoot: repository })
  const toolBefore = await readLangchainNativeToolInvokeBeforeFiles({ workspaceRoot: repository })
  const langchain = new Map([...base, ...toolBefore])
  for (const [path, bytes] of langchain) {
    if (bytes === undefined) continue
    await mkdir(dirname(join(langchainRoot, path)), { recursive: true })
    await writeFile(join(langchainRoot, path), bytes)
  }
  await writeFile(
    join(langchainRoot, "LICENSE"),
    await readFile(join(repository, "node_modules/langchain/LICENSE"))
  )
  const packages: PackageFixture[] = []
  const dependencies: Record<string, string> = {}
  const locked: Record<string, unknown> = {}
  for (const artifact of artifacts) {
    const manifest = JSON.parse(
      await readFile(join(repository, "patches", `${artifact}.manifest.json`), "utf8")
    ) as Manifest
    const patch = await readFile(join(repository, "patches", `${artifact}.patch`), "utf8")
    expect(digest(Buffer.from(patch))).toBe(manifest.patchSha256)
    const { before, after } = recoverFiles(patch, manifest.files)
    const packageRoot = join(root, "node_modules", manifest.name)
    for (const [path, bytes] of before) {
      await mkdir(dirname(join(packageRoot, path)), { recursive: true })
      if (bytes !== undefined) await writeFile(join(packageRoot, path), bytes)
    }
    const license = await readFile(join(repository, "node_modules", manifest.name, "LICENSE"))
    expect(digest(license)).toBe(manifest.licenseSha256)
    await writeFile(join(packageRoot, "LICENSE"), license)
    dependencies[manifest.name] = manifest.version
    locked[`node_modules/${manifest.name}`] = {
      version: manifest.version,
      resolved: manifest.upstreamTarball,
      integrity: manifest.upstreamIntegrity
    }
    packages.push({ packageRoot, manifest, before, after })
  }
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies }) + "\n")
  await writeFile(
    join(root, "package-lock.json"),
    JSON.stringify({ packages: { "": { dependencies }, ...locked } }) + "\n"
  )
  return { root, packages, langchainRoot, langchain }
}

async function assertPristine(f: Awaited<ReturnType<typeof fixture>>) {
  for (const pkg of f.packages) {
    for (const [path, bytes] of pkg.before) {
      if (bytes === undefined) {
        await expect(readFile(join(pkg.packageRoot, path))).rejects.toMatchObject({ code: "ENOENT" })
      } else expect(await readFile(join(pkg.packageRoot, path))).toEqual(bytes)
    }
  }
  for (const [path, bytes] of f.langchain) {
    if (bytes === undefined) {
      await expect(readFile(join(f.langchainRoot, path))).rejects.toMatchObject({ code: "ENOENT" })
    } else expect(await readFile(join(f.langchainRoot, path))).toEqual(bytes)
  }
  expect((await readdir(f.root, { recursive: true })).some(path => String(path).endsWith(".tmp")))
    .toBe(false)
}

afterEach(async () => {
  renameFault.at = 0
  renameFault.calls = 0
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw Error("ACTUAL_FIXTURE_REQUIRED")
    await rm(root, { recursive: true, force: true })
  }
})

describe("fixed Core and Graph stream installation as one eighteen-file batch", () => {
  it("installs and checks both complete packages while preserving the Langchain foundation", async () => {
    const f = await fixture()
    await expect(installLangchainInnerStreamOrigin({ workspaceRoot: f.root, checkOnly: true }))
      .rejects.toThrow("LANGCHAIN_INNER_PATCH_NOT_INSTALLED")
    await assertPristine(f)
    expect(await installLangchainInnerStreamOrigin({ workspaceRoot: f.root }))
      .toEqual({ status: "patched", targets: 18 })
    for (const pkg of f.packages) {
      for (const [path, bytes] of pkg.after)
        expect(await readFile(join(pkg.packageRoot, path))).toEqual(bytes)
    }
    expect(await installLangchainInnerStreamOrigin({ workspaceRoot: f.root, checkOnly: true }))
      .toEqual({ status: "installed", targets: 18 })
    expect(await installLangchainInnerStreamOrigin({ workspaceRoot: f.root }))
      .toEqual({ status: "installed", targets: 18 })
    expect(renameFault.calls).toBe(18)
    for (const [path, bytes] of f.langchain) {
      if (bytes !== undefined) expect(await readFile(join(f.langchainRoot, path))).toEqual(bytes)
    }
  })

  it("rejects an unknown Graph preimage without staging or changing any Core file", async () => {
    const f = await fixture()
    const graph = f.packages[1]
    const path = graph.manifest.files[0].path
    const changed = Buffer.concat([graph.before.get(path)!, Buffer.from("\n// unknown bytes\n")])
    await writeFile(join(graph.packageRoot, path), changed)
    await expect(installLangchainInnerStreamOrigin({ workspaceRoot: f.root }))
      .rejects.toThrow("LANGCHAIN_INNER_PATCH_MIXED_OR_UNKNOWN_FILES")
    expect(renameFault.calls).toBe(0)
    expect(await readFile(join(graph.packageRoot, path))).toEqual(changed)
    await writeFile(join(graph.packageRoot, path), graph.before.get(path)!)
    await assertPristine(f)
  })

  it("rejects an altered lock integrity before changing either dependency", async () => {
    const f = await fixture()
    const lockPath = join(f.root, "package-lock.json")
    const lock = JSON.parse(await readFile(lockPath, "utf8"))
    lock.packages["node_modules/@langchain/langgraph"].integrity = "sha512-foreign"
    const changed = JSON.stringify(lock) + "\n"
    await writeFile(lockPath, changed)
    await expect(installLangchainInnerStreamOrigin({ workspaceRoot: f.root }))
      .rejects.toThrow("LANGCHAIN_INNER_PATCH_DEPENDENCY_LOCK_INVALID")
    expect(renameFault.calls).toBe(0)
    expect(await readFile(lockPath, "utf8")).toBe(changed)
    await assertPristine(f)
  })

  it("restores all seven Core files and the first Graph file after a cross-package rename failure", async () => {
    const f = await fixture()
    renameFault.at = 9
    await expect(installLangchainInnerStreamOrigin({ workspaceRoot: f.root }))
      .rejects.toThrow("ACTUAL_INNER_RENAME_FAILURE")
    expect(renameFault.calls).toBe(9)
    await assertPristine(f)
  })

  it("rejects one installed package paired with one pristine package without completing it", async () => {
    const f = await fixture()
    for (const [path, bytes] of f.packages[0].after)
      await writeFile(join(f.packages[0].packageRoot, path), bytes)
    await expect(installLangchainInnerStreamOrigin({ workspaceRoot: f.root }))
      .rejects.toThrow("LANGCHAIN_INNER_PATCH_MIXED_OR_UNKNOWN_FILES")
    expect(renameFault.calls).toBe(0)
    for (const [path, bytes] of f.packages[0].after)
      expect(await readFile(join(f.packages[0].packageRoot, path))).toEqual(bytes)
    for (const [path, bytes] of f.packages[1].before) {
      if (bytes === undefined)
        await expect(readFile(join(f.packages[1].packageRoot, path))).rejects.toMatchObject({ code: "ENOENT" })
      else expect(await readFile(join(f.packages[1].packageRoot, path))).toEqual(bytes)
    }
    expect((await readdir(f.root, { recursive: true })).some(path => String(path).endsWith(".tmp")))
      .toBe(false)
  })

  it.each(["js", "cjs"])("rejects unknown official Loop %s without staging Core or Graph", async extension => {
    const f = await fixture(), graph = f.packages[1], path = `dist/pregel/loop.${extension}`
    const original = graph.before.get(path)
    if (!original) throw Error("The complete official Loop preimage is required")
    const changed = Buffer.concat([original, Buffer.from("\n// unknown Loop\n")])
    await writeFile(join(graph.packageRoot, path), changed)
    await expect(installLangchainInnerStreamOrigin({ workspaceRoot: f.root }))
      .rejects.toThrow("LANGCHAIN_INNER_PATCH_MIXED_OR_UNKNOWN_FILES")
    expect(renameFault.calls).toBe(0)
    expect(await readFile(join(graph.packageRoot, path))).toEqual(changed)
    await writeFile(join(graph.packageRoot, path), original)
    await assertPristine(f)
  })

  it("restores both packages after the last actual Runner rename fails", async () => {
    const f = await fixture()
    renameFault.at = 18
    await expect(installLangchainInnerStreamOrigin({ workspaceRoot: f.root }))
      .rejects.toThrow("ACTUAL_INNER_RENAME_FAILURE")
    expect(renameFault.calls).toBe(18)
    await assertPristine(f)
  })
})
