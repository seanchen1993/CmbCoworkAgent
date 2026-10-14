import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import { installLangchainNativeStreamOrigin } from "../../../scripts/apply-langchain-native-stream-origin.mjs"
import { readLangchainNativeStreamBaseFiles, readLangchainNativeToolInvokeBeforeFiles } from "../../../scripts/apply-langchain-native-tool-invoke-origin.mjs"

const renameFault = vi.hoisted(() => ({ calls: 0, at: 0 }))
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...original,
    async rename(...args: Parameters<typeof original.rename>) {
      renameFault.calls++
      if (renameFault.calls === renameFault.at) throw Error("ACTUAL_RENAME_FAILURE")
      return original.rename(...args)
    }
  }
})

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const workspaces: string[] = []
interface PatchFile {
  path: string
  beforeSha256: string | null
  afterSha256: string
}
interface Manifest {
  files: PatchFile[]
}
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")

/** Recover the checked pristine fixture from a checked installed SDK, without executing it. */
function reverseFilePatch(patch: string, path: string, after: string): string {
  const lines = patch.split("\n")
  let index = lines.indexOf(`+++ b/${path}`) + 1
  if (!index) throw Error("EXACT_PATCH_FILE_REQUIRED")
  const inputEndsLF = after.endsWith("\n")
  const input = after === "" ? [] : after.split("\n")
  if (inputEndsLF) input.length--
  const output: string[] = []
  let cursor = 0,
    outputEndsLF = inputEndsLF,
    markedOutput = -1
  const copyInput = () => {
    output.push(input[cursor++])
    outputEndsLF = cursor === input.length ? inputEndsLF : true
  }
  while (index < lines.length && lines[index].startsWith("@@ ")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[index++])
    if (!header) throw Error("EXACT_PATCH_HUNK_REQUIRED")
    const oldCount = Number(header[2] ?? 1),
      newCount = Number(header[4] ?? 1)
    const start = newCount === 0 ? Number(header[3]) : Number(header[3]) - 1
    while (cursor < start) copyInput()
    let oldRows = 0,
      newRows = 0
    while (oldRows < oldCount || newRows < newCount) {
      const row = lines[index++],
        kind = row[0],
        text = row.slice(1)
      const noLF = lines[index] === "\\ No newline at end of file"
      if (noLF) index++
      if (kind !== "-") {
        if (input[cursor++] !== text) throw Error("EXACT_POSTIMAGE_CONTEXT_REQUIRED")
        newRows++
        if (noLF !== (cursor === input.length && !inputEndsLF))
          throw Error("EXACT_POSTIMAGE_EOF_REQUIRED")
      }
      if (kind !== "+") {
        output.push(text)
        outputEndsLF = !noLF
        if (noLF) markedOutput = output.length
        oldRows++
      }
    }
  }
  while (cursor < input.length) copyInput()
  if (markedOutput !== -1 && markedOutput !== output.length)
    throw Error("EXACT_PRISTINE_EOF_REQUIRED")
  return output.join("\n") + (output.length && outputEndsLF ? "\n" : "")
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cmb-langchain-origin-"))
  workspaces.push(root)
  const packageRoot = join(root, "node_modules/langchain")
  await mkdir(join(packageRoot, "dist/agents"), { recursive: true })
  const manifest = JSON.parse(
    await readFile(
      join(repository, "patches/langchain-1.2.37-native-stream-origin.manifest.json"),
      "utf8"
    )
  ) as Manifest
  const patch = await readFile(
    join(repository, "patches/langchain-1.2.37-native-stream-origin.patch"),
    "utf8"
  )
  const originals = new Map<string, Buffer>()
  const checkedBase = await readLangchainNativeStreamBaseFiles({ workspaceRoot: repository })
  const overlayBefore = await readLangchainNativeToolInvokeBeforeFiles({ workspaceRoot: repository })
  for (const path of ["dist/agents/nodes/ToolNode.js", "dist/agents/nodes/ToolNode.cjs"]) {
    const bytes = overlayBefore.get(path)
    if (!bytes) throw Error("EXACT_OFFICIAL_NODE_FILE_REQUIRED")
    await mkdir(dirname(join(packageRoot, path)), { recursive: true })
    await writeFile(join(packageRoot, path), bytes)
  }
  for (const file of manifest.files) {
    if (file.beforeSha256 === null) continue
    const actual = checkedBase.get(file.path)
    if (!actual) throw Error("EXACT_CHECKED_BASE_FILE_REQUIRED")
    const pristine =
      digest(actual) === file.beforeSha256
        ? actual
        : Buffer.from(reverseFilePatch(patch, file.path, actual.toString("utf8")))
    expect(digest(pristine)).toBe(file.beforeSha256)
    expect(pristine[pristine.length - 1]).not.toBe(10)
    originals.set(file.path, pristine)
    await writeFile(join(packageRoot, file.path), pristine)
  }
  await writeFile(
    join(packageRoot, "LICENSE"),
    await readFile(join(repository, "node_modules/langchain/LICENSE"))
  )
  return { root, packageRoot, manifest, originals }
}

async function assertPristine(f: Awaited<ReturnType<typeof fixture>>) {
  for (const file of f.manifest.files) {
    const original = f.originals.get(file.path)
    if (original) expect(await readFile(join(f.packageRoot, file.path))).toEqual(original)
    else
      await expect(readFile(join(f.packageRoot, file.path))).rejects.toMatchObject({
        code: "ENOENT"
      })
  }
  const files = await readdir(f.packageRoot, { recursive: true })
  expect(files.some((path) => String(path).endsWith(".tmp"))).toBe(false)
}

afterEach(async () => {
  renameFault.at = 0
  renameFault.calls = 0
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("reproducible langchain lexical stream patch", () => {
  it("validates all seven postimages and accepts exactly the same installed batch", async () => {
    const f = await fixture()
    await expect(
      installLangchainNativeStreamOrigin({ workspaceRoot: f.root, checkOnly: true })
    ).rejects.toThrow("LANGCHAIN_PATCH_NOT_INSTALLED")
    await assertPristine(f)
    expect(await installLangchainNativeStreamOrigin({ workspaceRoot: f.root })).toEqual({
      status: "patched",
      version: "1.2.37"
    })
    for (const file of f.manifest.files)
      expect(digest(await readFile(join(f.packageRoot, file.path)))).toBe(file.afterSha256)
    for (const file of f.manifest.files.filter((file) => file.beforeSha256 !== null)) {
      const actual = await readFile(join(f.packageRoot, file.path))
      expect(actual[actual.length - 1]).not.toBe(10)
    }
    expect(
      await installLangchainNativeStreamOrigin({ workspaceRoot: f.root, checkOnly: true })
    ).toEqual({ status: "installed", version: "1.2.37" })
    expect(await installLangchainNativeStreamOrigin({ workspaceRoot: f.root })).toEqual({
      status: "installed",
      version: "1.2.37"
    })
  })

  it("rejects a mixed batch before changing any other pristine file", async () => {
    const f = await fixture()
    const changed = Buffer.from("// unrelated partial dependency patch\n")
    await writeFile(join(f.packageRoot, f.manifest.files[0].path), changed)
    await expect(installLangchainNativeStreamOrigin({ workspaceRoot: f.root })).rejects.toThrow(
      "LANGCHAIN_PATCH_MIXED_OR_UNKNOWN_FILES"
    )
    expect(await readFile(join(f.packageRoot, f.manifest.files[0].path))).toEqual(changed)
    for (const [path, original] of f.originals) {
      if (path === f.manifest.files[0].path) continue
      expect(await readFile(join(f.packageRoot, path))).toEqual(original)
    }
    await expect(
      readFile(join(f.packageRoot, "dist/native-stream-origin.js"))
    ).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("rejects an unknown dependency version without rewriting its package", async () => {
    const f = await fixture()
    const packagePath = join(f.packageRoot, "package.json")
    const before = JSON.parse((await readFile(packagePath)).toString("utf8"))
    before.version = "1.2.38"
    const changed = Buffer.from(`${JSON.stringify(before)}\n`)
    await writeFile(packagePath, changed)
    await expect(installLangchainNativeStreamOrigin({ workspaceRoot: f.root })).rejects.toThrow(
      "LANGCHAIN_PATCH_VERSION_CHANGED"
    )
    expect(await readFile(packagePath)).toEqual(changed)
    expect(await readFile(join(f.packageRoot, f.manifest.files[0].path))).toEqual(
      f.originals.get(f.manifest.files[0].path)
    )
  })

  it("restores the actual first committed file after a later filesystem rename fails", async () => {
    const f = await fixture()
    renameFault.at = 2
    await expect(installLangchainNativeStreamOrigin({ workspaceRoot: f.root })).rejects.toThrow(
      "ACTUAL_RENAME_FAILURE"
    )
    expect(renameFault.calls).toBe(2)
    await assertPristine(f)
  })
})
