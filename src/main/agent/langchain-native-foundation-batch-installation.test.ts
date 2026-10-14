import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, it, vi } from "vitest"
import { installLangchainNativeFoundationBatch } from "../../../scripts/langchain-native-foundation-batch.mjs"
import { installLangchainNativeFoundations } from "../../../scripts/apply-langchain-native-foundations.mjs"
import { prepareLangchainInnerStreamPlan } from "../../../scripts/apply-langchain-inner-stream-origin.mjs"
import { prepareLangchainNativeFoundationPlan, readLangchainNativeStreamBaseFiles,
  readLangchainNativeToolInvokeBeforeFiles } from "../../../scripts/apply-langchain-native-tool-invoke-origin.mjs"

const fault = vi.hoisted(() => ({ renames: 0, at: 0, opens: 0,
  corrupt: undefined as { path: string; bytes: Buffer } | undefined,
  failStage: undefined as "prefix" | "foreign" | undefined,
  foreignPath: undefined as string | undefined,
  entered: undefined as (() => void) | undefined,
  held: undefined as Promise<void> | undefined,
  release: undefined as (() => void) | undefined }))
vi.mock("node:fs/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs/promises")>()
  return { ...original,
    async rename(...args: Parameters<typeof original.rename>) {
      fault.renames++
      if (fault.renames === fault.at) {
        if (fault.corrupt) await original.writeFile(fault.corrupt.path, fault.corrupt.bytes)
        throw Error("ACTUAL_BATCH_RENAME_FAILURE")
      }
      return original.rename(...args)
    },
    async open(...args: Parameters<typeof original.open>) {
      fault.opens++
      const handle = await original.open(...args)
      if (String(args[0]).endsWith(".tmp") && fault.failStage) {
        const mode = fault.failStage, path = String(args[0])
        fault.failStage = undefined
        const originalWrite = handle.writeFile, originalClose = handle.close
        Object.defineProperty(handle, "writeFile", { value: async function(this: typeof handle,
          ...writeArgs: Parameters<typeof originalWrite>) {
          expect(this).toBe(handle)
          const bytes = writeArgs[0]
          if (!Buffer.isBuffer(bytes)) throw Error("ACTUAL_STAGE_BUFFER_REQUIRED")
          await Reflect.apply(originalWrite, this, [bytes.subarray(0, 17)])
          if (mode === "prefix") throw undefined
          throw Error("ACTUAL_PARTIAL_FAILURE")
        } })
        if (mode === "foreign") Object.defineProperty(handle, "close", {
          value: async function(this: typeof handle) {
            expect(this).toBe(handle)
            await Reflect.apply(originalClose, this, [])
            await original.writeFile(path, "external changed partial bytes")
            fault.foreignPath = path
          }
        })
      }
      if (String(args[0]).endsWith(".cmb-native-foundations.lock") && fault.held) {
        fault.entered?.()
        await fault.held
      }
      return handle
    }
  }
})

interface FileEntry { path: string; beforeSha256: string | null; afterSha256: string }
interface Manifest { files: FileEntry[]; patchSha256: string }
interface RootPackage { dependencies: Record<string, string> }
interface RootLock { packages: Record<string, {
  version?: string; resolved?: string; integrity?: string; dependencies?: Record<string, string>
}> }
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const roots: string[] = []
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
type State = "before" | "base" | "after"

function reverseBaseFile(patch: string, path: string, after: Buffer): Buffer {
  const lines = patch.split("\n"), source = after.toString("utf8")
  let index = lines.indexOf(`+++ b/${path}`) + 1
  if (!index) throw Error("EXACT_BASE_FILE_REQUIRED")
  const endsLF = source.endsWith("\n"), input = source.split("\n")
  if (endsLF) input.length--
  const output: string[] = []
  let cursor = 0, outputLF = endsLF, marked = -1
  const copy = () => { output.push(input[cursor++]); outputLF = cursor === input.length ? endsLF : true }
  while (lines[index]?.startsWith("@@ ")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[index++])
    if (!header) throw Error("EXACT_BASE_HUNK_REQUIRED")
    const oldCount = Number(header[2] ?? 1), newCount = Number(header[4] ?? 1)
    const start = newCount === 0 ? Number(header[3]) : Number(header[3]) - 1
    while (cursor < start) copy()
    let oldRows = 0, newRows = 0
    while (oldRows < oldCount || newRows < newCount) {
      const row = lines[index++], kind = row[0], text = row.slice(1)
      if (![" ", "+", "-"].includes(kind)) throw Error("EXACT_BASE_ROW_REQUIRED")
      const noLF = lines[index] === "\\ No newline at end of file"
      if (noLF) index++
      if (kind !== "-") {
        expect(input[cursor++]).toBe(text)
        newRows++
        expect(noLF).toBe(cursor === input.length && !endsLF)
      }
      if (kind !== "+") {
        output.push(text); oldRows++; outputLF = !noLF
        if (noLF) marked = output.length
      }
    }
    expect(oldRows).toBe(oldCount); expect(newRows).toBe(newCount)
  }
  while (cursor < input.length) copy()
  if (marked !== -1) expect(marked).toBe(output.length)
  return Buffer.from(output.join("\n") + (output.length && outputLF ? "\n" : ""))
}
function fullBefore(patch: string, entries: FileEntry[], observed: Map<string, Buffer>) {
  const lines = patch.split("\n"), before = new Map<string, Buffer | null>()
  let index = 0
  for (const entry of entries) {
    expect(lines[index++]).toBe(entry.beforeSha256 === null ? "--- /dev/null" : `--- a/${entry.path}`)
    expect(lines[index++]).toBe(`+++ b/${entry.path}`)
    const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(lines[index++])
    if (!header) throw Error("EXACT_FULL_HUNK_REQUIRED")
    const oldRows: string[] = [], newRows: string[] = []
    let oldLF = true, newLF = true, oldMarked = -1, newMarked = -1
    while (lines[index] && !lines[index].startsWith("--- ")) {
      const row = lines[index++], kind = row[0]
      if (kind !== "+" && kind !== "-") throw Error("EXACT_FULL_ROW_REQUIRED")
      const noLF = lines[index] === "\\ No newline at end of file"
      if (noLF) index++
      if (kind === "-") { oldRows.push(row.slice(1)); oldLF = !noLF; if (noLF) oldMarked = oldRows.length }
      else { newRows.push(row.slice(1)); newLF = !noLF; if (noLF) newMarked = newRows.length }
    }
    expect(oldRows.length).toBe(Number(header[2])); expect(newRows.length).toBe(Number(header[4]))
    expect(Number(header[1])).toBe(oldRows.length ? 1 : 0)
    expect(Number(header[3])).toBe(newRows.length ? 1 : 0)
    if (oldMarked !== -1) expect(oldMarked).toBe(oldRows.length)
    if (newMarked !== -1) expect(newMarked).toBe(newRows.length)
    const original = entry.beforeSha256 === null ? null :
      Buffer.from(oldRows.join("\n") + (oldRows.length && oldLF ? "\n" : ""))
    const after = Buffer.from(newRows.join("\n") + (newRows.length && newLF ? "\n" : ""))
    expect(original === null ? null : hash(original)).toBe(entry.beforeSha256)
    expect(hash(after)).toBe(entry.afterSha256)
    expect(after).toEqual(observed.get(entry.path))
    before.set(entry.path, original)
  }
  expect(lines.slice(index)).toEqual([""])
  return before
}
async function fixture(langchainState: State = "before", innerState: "before" | "after" | "graphWithoutLoops" = "before") {
  const root = await mkdtemp(join(tmpdir(), "cmb-foundations-batch-"))
  roots.push(root)
  const [langchain, inner] = await Promise.all([
    prepareLangchainNativeFoundationPlan({ workspaceRoot: repository }),
    prepareLangchainInnerStreamPlan({ workspaceRoot: repository })
  ])
  const base = await readLangchainNativeStreamBaseFiles({ workspaceRoot: repository })
  const toolBefore = await readLangchainNativeToolInvokeBeforeFiles({ workspaceRoot: repository })
  const baseManifest = JSON.parse(await readFile(join(repository,
    "patches/langchain-1.2.37-native-stream-origin.manifest.json"), "utf8")) as Manifest
  const basePatch = await readFile(join(repository, "patches/langchain-1.2.37-native-stream-origin.patch"), "utf8")
  expect(hash(Buffer.from(basePatch))).toBe(baseManifest.patchSha256)
  const langchainBefore = new Map<string, Buffer | null>([...base, ...toolBefore].map(([path, bytes]) => [path, bytes ?? null]))
  if (langchainState === "before") for (const entry of baseManifest.files) {
    if (entry.beforeSha256 === null) langchainBefore.set(entry.path, null)
    else {
      const current = base.get(entry.path)
      if (!current) throw Error("EXACT_BASE_BYTES_REQUIRED")
      const bytes = reverseBaseFile(basePatch, entry.path, current)
      expect(hash(bytes)).toBe(entry.beforeSha256)
      expect(bytes[bytes.length - 1]).not.toBe(10)
      langchainBefore.set(entry.path, bytes)
    }
  }
  const originals = new Map<string, Buffer | null>(), expected = new Map<string, Buffer>()
  for (const pkg of [langchain, ...inner.packages]) {
    let before = langchainBefore
    if (pkg.name !== "langchain") {
      const artifact = pkg.name === "@langchain/core" ? "langchain-core-1.1.36-native-stream-origin" : "langgraph-1.2.5-native-stream-origin"
      const manifest = JSON.parse(await readFile(join(repository, "patches", `${artifact}.manifest.json`), "utf8")) as Manifest
      const patch = await readFile(join(repository, "patches", `${artifact}.patch`), "utf8")
      expect(hash(Buffer.from(patch))).toBe(manifest.patchSha256)
      before = fullBefore(patch, manifest.files, new Map(pkg.targets.map(target => [target.relativePath, target.afterBytes])))
    }
    const useAfter = pkg.name === "langchain" ? langchainState === "after" : innerState !== "before"
    for (const target of pkg.targets) {
      const path = join(root, "node_modules", pkg.name, target.relativePath)
      const oldLoop = pkg.name === "@langchain/langgraph" && innerState === "graphWithoutLoops" &&
        /^dist\/pregel\/loop\.(js|cjs)$/.test(target.relativePath)
      const bytes = useAfter && !oldLoop ? target.afterBytes : before.get(target.relativePath) ?? null
      originals.set(path, bytes); expected.set(path, target.afterBytes)
      await mkdir(dirname(path), { recursive: true })
      if (bytes !== null) await writeFile(path, bytes)
    }
    await writeFile(join(root, "node_modules", pkg.name, "LICENSE"),
      await readFile(join(pkg.root, "LICENSE")))
  }
  const rootPackage = JSON.parse(await readFile(join(repository, "package.json"), "utf8")) as RootPackage
  const rootLock = JSON.parse(await readFile(join(repository, "package-lock.json"), "utf8")) as RootLock
  const dependencies: Record<string, string> = {}, packages: Record<string, unknown> = {}
  for (const name of ["langchain", "@langchain/core", "@langchain/langgraph"]) {
    dependencies[name] = rootPackage.dependencies[name]
    packages[`node_modules/${name}`] = rootLock.packages[`node_modules/${name}`]
  }
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies }))
  await writeFile(join(root, "package-lock.json"), JSON.stringify({ packages: { "": { dependencies }, ...packages } }))
  return { root, originals, expected }
}
async function snapshot(f: Awaited<ReturnType<typeof fixture>>) {
  const result = new Map<string, Buffer | null>()
  for (const path of f.originals.keys()) {
    try { result.set(path, await readFile(path)) }
    catch (reason) {
      if (!(reason instanceof Error) || !("code" in reason) || reason.code !== "ENOENT") throw reason
      result.set(path, null)
    }
  }
  return result
}
async function noMaintenanceFiles(root: string) {
  expect((await readdir(root, { recursive: true })).filter(path =>
    String(path).includes(".cmb-") || String(path).endsWith(".rollback"))).toEqual([])
}
afterEach(async () => {
  fault.release?.(); fault.held = undefined; fault.entered = undefined; fault.release = undefined
  fault.renames = 0; fault.at = 0; fault.opens = 0; fault.corrupt = undefined
  fault.failStage = undefined; fault.foreignPath = undefined
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw Error("ACTUAL_FIXTURE_ROOT_REQUIRED")
    await rm(root, { recursive: true, force: true })
  }
})

it.each(["before", "base", "after"] as const)("installs all 31 targets from exact Langchain %s and pristine inner packages", async state => {
  const f = await fixture(state)
  await expect(installLangchainNativeFoundationBatch({ workspaceRoot: f.root, checkOnly: true }))
    .rejects.toThrow("LANGCHAIN_FOUNDATIONS_NOT_INSTALLED")
  expect(fault.opens).toBe(0); expect(fault.renames).toBe(0)
  expect(await snapshot(f)).toEqual(f.originals)
  expect(await installLangchainNativeFoundationBatch({ workspaceRoot: f.root })).toEqual({ status: "patched", targets: 31 })
  expect(await snapshot(f)).toEqual(f.expected)
  await noMaintenanceFiles(f.root)
  const count = fault.renames
  expect(await installLangchainNativeFoundations({ workspaceRoot: f.root, checkOnly: true }))
    .toEqual({ status: "installed", targets: 31 })
  expect(await installLangchainNativeFoundationBatch({ workspaceRoot: f.root }))
    .toEqual({ status: "installed", targets: 31 })
  expect(fault.renames).toBe(count)
})
it.each(["before", "base"] as const)("preserves complete inner packages when upgrading Langchain %s", async state => {
  const f = await fixture(state, "after")
  await installLangchainNativeFoundationBatch({ workspaceRoot: f.root })
  expect(await snapshot(f)).toEqual(f.expected)
  expect(fault.renames).toBe(state === "before" ? 13 : 9)
  await noMaintenanceFiles(f.root)
})
it("checks complete 31 through the lifecycle entry without creating a lock, temporary or rewriting a target", async () => {
  const f = await fixture("after", "after")
  expect(await installLangchainNativeFoundations({ workspaceRoot: f.root, checkOnly: true }))
    .toEqual({ status: "installed", targets: 31 })
  expect(fault.opens).toBe(0); expect(fault.renames).toBe(0)
  expect(await snapshot(f)).toEqual(f.expected)
  await noMaintenanceFiles(f.root)
})
it.each(["langchain", "@langchain/core", "@langchain/langgraph"])("rejects unknown %s bytes before staging any package", async name => {
  const f = await fixture()
  const path = name === "langchain" ? "dist/agents/nodes/ToolNode.js" : name === "@langchain/core" ? "dist/runnables/base.js" : "dist/pregel/index.js"
  await writeFile(join(f.root, "node_modules", name, path), "unrelated bytes")
  const before = await snapshot(f)
  await expect(installLangchainNativeFoundationBatch({ workspaceRoot: f.root }))
    .rejects.toThrow(name === "langchain" ? "LANGCHAIN_PATCH_MIXED_OR_UNKNOWN_FILES" :
      "LANGCHAIN_INNER_PATCH_MIXED_OR_UNKNOWN_FILES")
  expect(await snapshot(f)).toEqual(before)
  expect(fault.opens).toBe(0); expect(fault.renames).toBe(0)
  await noMaintenanceFiles(f.root)
})

it.each(["js", "cjs"])("rejects unknown official Loop %s bytes before writing any package", async extension => {
  const f = await fixture("base"), path = join(f.root, "node_modules/@langchain/langgraph",
    `dist/pregel/loop.${extension}`)
  const bytes = await readFile(path), changed = Buffer.concat([bytes, Buffer.from("\n// unknown Loop bytes\n")])
  await writeFile(path, changed)
  const before = await snapshot(f)
  await expect(installLangchainNativeFoundationBatch({ workspaceRoot: f.root }))
    .rejects.toThrow("LANGCHAIN_INNER_PATCH_MIXED_OR_UNKNOWN_FILES")
  expect(await snapshot(f)).toEqual(before)
  expect(fault.opens).toBe(0); expect(fault.renames).toBe(0)
  await noMaintenanceFiles(f.root)
})

it.each(["js", "cjs"])("rejects one installed Loop %s beside official Graph and Core", async extension => {
  const f = await fixture("base"), path = join(f.root, "node_modules/@langchain/langgraph",
    `dist/pregel/loop.${extension}`)
  const after = f.expected.get(path)
  if (!after) throw Error("The exact Loop postimage is required")
  await writeFile(path, after)
  const before = await snapshot(f)
  await expect(installLangchainNativeFoundationBatch({ workspaceRoot: f.root }))
    .rejects.toThrow("LANGCHAIN_INNER_PATCH_MIXED_OR_UNKNOWN_FILES")
  expect(await snapshot(f)).toEqual(before)
  expect(fault.opens).toBe(0); expect(fault.renames).toBe(0)
  await noMaintenanceFiles(f.root)
})

it.each(["js", "cjs"])("rejects unknown Runner %s bytes without writing any package", async extension => {
  const f = await fixture("base"), path = join(f.root, "node_modules/@langchain/langgraph",
    `dist/pregel/runner.${extension}`)
  await writeFile(path, Buffer.concat([await readFile(path), Buffer.from("\n// unknown Runner bytes\n")]))
  const before = await snapshot(f)
  await expect(installLangchainNativeFoundationBatch({ workspaceRoot: f.root }))
    .rejects.toThrow("LANGCHAIN_INNER_PATCH_MIXED_OR_UNKNOWN_FILES")
  expect(await snapshot(f)).toEqual(before)
  expect(fault.opens).toBe(0); expect(fault.renames).toBe(0)
  await noMaintenanceFiles(f.root)
})

it.each(["js", "cjs"])("rejects an official Runner %s in an otherwise installed batch", async extension => {
  const f = await fixture("after", "after"), path = join(f.root, "node_modules/@langchain/langgraph",
    `dist/pregel/runner.${extension}`)
  const original = await fixture("base")
  await writeFile(path, await readFile(join(original.root, "node_modules/@langchain/langgraph",
    `dist/pregel/runner.${extension}`)))
  const before = await snapshot(f)
  await expect(installLangchainNativeFoundationBatch({ workspaceRoot: f.root, checkOnly: true }))
    .rejects.toThrow("LANGCHAIN_INNER_PATCH_MIXED_OR_UNKNOWN_FILES")
  expect(await snapshot(f)).toEqual(before)
  expect(fault.opens).toBe(0); expect(fault.renames).toBe(0)
  await noMaintenanceFiles(f.root)
})

it("rejects nine installed Graph targets whose two Loop files remain official", async () => {
  const f = await fixture("after", "graphWithoutLoops"), before = await snapshot(f)
  await expect(installLangchainNativeFoundationBatch({ workspaceRoot: f.root, checkOnly: true }))
    .rejects.toThrow("LANGCHAIN_INNER_PATCH_MIXED_OR_UNKNOWN_FILES")
  expect(await snapshot(f)).toEqual(before)
  expect(fault.opens).toBe(0); expect(fault.renames).toBe(0)
  await noMaintenanceFiles(f.root)
})
it.each(["@langchain/core", "@langchain/langgraph"])("rejects %s after with its sibling before while Langchain remains pristine", async name => {
  const f = await fixture()
  for (const [path, bytes] of f.expected) if (path.includes(join("node_modules", name) + sep)) await writeFile(path, bytes)
  const before = await snapshot(f)
  await expect(installLangchainNativeFoundationBatch({ workspaceRoot: f.root }))
    .rejects.toThrow("LANGCHAIN_INNER_PATCH_MIXED_OR_UNKNOWN_FILES")
  expect(await snapshot(f)).toEqual(before)
  expect(fault.opens).toBe(0); expect(fault.renames).toBe(0)
  await noMaintenanceFiles(f.root)
})
it.each(["pin", "integrity"])("rejects a changed root %s before file writes", async field => {
  const f = await fixture()
  const path = join(f.root, field === "pin" ? "package.json" : "package-lock.json")
  if (field === "pin") {
    const value = JSON.parse(await readFile(path, "utf8")) as RootPackage
    value.dependencies["@langchain/core"] = "^1.1.36"
    await writeFile(path, JSON.stringify(value))
  } else {
    const value = JSON.parse(await readFile(path, "utf8")) as RootLock
    value.packages["node_modules/@langchain/langgraph"].integrity = "unknown"
    await writeFile(path, JSON.stringify(value))
  }
  await expect(installLangchainNativeFoundationBatch({ workspaceRoot: f.root }))
    .rejects.toThrow("LANGCHAIN_INNER_PATCH_DEPENDENCY_LOCK_INVALID")
  expect(await snapshot(f)).toEqual(f.originals)
  expect(fault.opens).toBe(0); expect(fault.renames).toBe(0)
  await noMaintenanceFiles(f.root)
})
it.each([1, 14, 21, 27, 29, 31])("restores all original bytes and absences after actual rename %s fails", async at => {
  const f = await fixture()
  fault.at = at
  await expect(installLangchainNativeFoundationBatch({ workspaceRoot: f.root }))
    .rejects.toThrow("ACTUAL_BATCH_RENAME_FAILURE")
  expect(await snapshot(f)).toEqual(f.originals)
  await noMaintenanceFiles(f.root)
})
it("preserves unknown bytes written over this batch's first committed target", async () => {
  const f = await fixture(), first = [...f.originals.keys()][0]
  const unknown = Buffer.from("external bytes must be preserved")
  fault.at = 15; fault.corrupt = { path: first, bytes: unknown }
  const [result] = await Promise.allSettled([installLangchainNativeFoundationBatch({ workspaceRoot: f.root })])
  expect(result.status).toBe("rejected")
  if (result.status !== "rejected" || !(result.reason instanceof AggregateError))
    throw Error("ACTUAL_ROLLBACK_CONFLICT_REQUIRED")
  expect(result.reason.errors[0]).toMatchObject({ message: "ACTUAL_BATCH_RENAME_FAILURE" })
  expect(result.reason.errors[1]).toMatchObject({ message: "LANGCHAIN_FOUNDATIONS_ROLLBACK_TARGET_CHANGED" })
  expect(await snapshot(f)).toEqual(new Map([...f.originals].map(([path, bytes]) =>
    [path, path === first ? unknown : bytes])))
  await noMaintenanceFiles(f.root)
})
it("cleans only the captured exact prefix after a true staged write rejects with undefined", async () => {
  const f = await fixture()
  fault.failStage = "prefix"
  await expect(installLangchainNativeFoundationBatch({ workspaceRoot: f.root })).rejects.toBeUndefined()
  expect(fault.renames).toBe(0)
  expect(await snapshot(f)).toEqual(f.originals)
  await noMaintenanceFiles(f.root)
})
it("keeps foreign same-inode bytes that replace an observed partial before cleanup", async () => {
  const f = await fixture()
  fault.failStage = "foreign"
  const [result] = await Promise.allSettled([installLangchainNativeFoundationBatch({ workspaceRoot: f.root })])
  if (result.status !== "rejected" || !(result.reason instanceof AggregateError))
    throw Error("ACTUAL_PARTIAL_CLEANUP_CONFLICT_REQUIRED")
  expect(result.reason.errors[0]).toMatchObject({ message: "ACTUAL_PARTIAL_FAILURE" })
  expect(result.reason.errors[1]).toMatchObject({ message: "LANGCHAIN_FOUNDATIONS_CLEANUP_BYTES_CHANGED" })
  expect(fault.renames).toBe(0)
  expect(await snapshot(f)).toEqual(f.originals)
  if (!fault.foreignPath) throw Error("ACTUAL_FOREIGN_PATH_REQUIRED")
  expect(await readFile(fault.foreignPath, "utf8")).toBe("external changed partial bytes")
  const maintenance = (await readdir(f.root, { recursive: true })).filter(path => String(path).includes(".cmb-"))
  expect(maintenance.map(path => join(f.root, String(path)))).toEqual([fault.foreignPath])
})
it("rejects a second actual installer while the first holds its own created lock", async () => {
  const f = await fixture()
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  fault.entered = entered
  fault.held = new Promise<void>(resolve => { fault.release = resolve })
  const first = installLangchainNativeFoundationBatch({ workspaceRoot: f.root })
  const firstSettled = Promise.allSettled([first])
  try {
    await started
    await expect(installLangchainNativeFoundationBatch({ workspaceRoot: f.root }))
      .rejects.toThrow("LANGCHAIN_FOUNDATIONS_INSTALL_BUSY")
    expect(fault.renames).toBe(0)
  } finally { fault.release?.(); fault.held = undefined; await firstSettled }
  expect(await first).toEqual({ status: "patched", targets: 31 })
  expect(await snapshot(f)).toEqual(f.expected)
  await noMaintenanceFiles(f.root)
})
