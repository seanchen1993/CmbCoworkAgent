import { createHash, randomUUID } from "node:crypto"
import { readFile, writeFile, rename, unlink } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const manifestPath = resolve(
  repositoryRoot,
  "patches/langchain-1.2.37-native-stream-origin.manifest.json"
)
const patchPath = resolve(repositoryRoot, "patches/langchain-1.2.37-native-stream-origin.patch")
const sha256 = (value) => createHash("sha256").update(value).digest("hex")
const packageFiles = [
  "dist/agents/ReactAgent.js",
  "dist/agents/ReactAgent.cjs",
  "package.json",
  "dist/native-stream-origin.js",
  "dist/native-stream-origin.cjs",
  "dist/native-stream-origin.d.ts",
  "dist/native-stream-origin.d.cts"
]
const templateFiles = [
  "langchain-native-stream-origin-runtime.js.inc",
  "langchain-native-stream-origin.d.ts"
]

function targetPath(packageRoot, path) {
  const target = resolve(packageRoot, path)
  const within = relative(packageRoot, target)
  if (
    !within ||
    isAbsolute(within) ||
    within === ".." ||
    within.startsWith("../") ||
    within.startsWith("..\\")
  )
    throw Error("LANGCHAIN_PATCH_PATH_INVALID")
  return target
}

/** Apply only ordinary text hunks; no shell, patch executable, or executable manifest input. */
function applyTextPatch(patch, originals) {
  const lines = patch.split("\n")
  if (lines[lines.length - 1] === "") lines.length--
  const outputs = new Map()
  let index = 0
  while (index < lines.length) {
    const oldHeader = lines[index++]
    const newHeader = lines[index++]
    if (!oldHeader.startsWith("--- ") || !newHeader.startsWith("+++ b/"))
      throw Error("LANGCHAIN_PATCH_HEADER_INVALID")
    const path = newHeader.slice(6)
    const original = originals.get(path)
    if (
      !originals.has(path) ||
      outputs.has(path) ||
      (original === undefined ? oldHeader !== "--- /dev/null" : oldHeader !== `--- a/${path}`)
    )
      throw Error("LANGCHAIN_PATCH_FILE_INVALID")
    const source = original === undefined ? "" : original.toString("utf8")
    const inputEndsLF = source.endsWith("\n")
    const input = source === "" ? [] : source.split("\n")
    if (inputEndsLF) input.length--
    const output = []
    let cursor = 0,
      outputEndsLF = inputEndsLF,
      markedOutput = -1
    const copyInput = () => {
      output[output.length] = input[cursor++]
      outputEndsLF = cursor === input.length ? inputEndsLF : true
    }
    while (index < lines.length && !lines[index].startsWith("--- ")) {
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[index++])
      if (!header) throw Error("LANGCHAIN_PATCH_HUNK_INVALID")
      const oldStart = Number(header[1]),
        oldCount = Number(header[2] ?? 1)
      const newStart = Number(header[3]),
        newCount = Number(header[4] ?? 1)
      const start = oldCount === 0 ? oldStart : oldStart - 1
      if (start < cursor || start > input.length) throw Error("LANGCHAIN_PATCH_RANGE_INVALID")
      while (cursor < start) copyInput()
      if (output.length !== (newCount === 0 ? newStart : newStart - 1))
        throw Error("LANGCHAIN_PATCH_OFFSET_INVALID")
      let consumed = 0,
        produced = 0
      while (consumed < oldCount || produced < newCount) {
        const line = lines[index++]
        if (!line) throw Error("LANGCHAIN_PATCH_LINE_INVALID")
        const kind = line[0],
          text = line.slice(1)
        if (kind !== " " && kind !== "-" && kind !== "+")
          throw Error("LANGCHAIN_PATCH_LINE_INVALID")
        const noLF = lines[index] === "\\ No newline at end of file"
        if (noLF) index++
        if (kind !== "+") {
          if (input[cursor++] !== text) throw Error("LANGCHAIN_PATCH_CONTEXT_CHANGED")
          consumed++
          if (noLF !== (cursor === input.length && !inputEndsLF))
            throw Error("LANGCHAIN_PATCH_OLD_EOF_INVALID")
        }
        if (kind !== "-") {
          output[output.length] = text
          outputEndsLF = !noLF
          if (noLF) markedOutput = output.length
          produced++
        }
      }
      if (consumed !== oldCount || produced !== newCount)
        throw Error("LANGCHAIN_PATCH_COUNT_INVALID")
    }
    while (cursor < input.length) copyInput()
    if (markedOutput !== -1 && markedOutput !== output.length)
      throw Error("LANGCHAIN_PATCH_NEW_EOF_INVALID")
    outputs.set(
      path,
      Buffer.from(output.join("\n") + (output.length && outputEndsLF ? "\n" : ""), "utf8")
    )
  }
  if (outputs.size !== originals.size) throw Error("LANGCHAIN_PATCH_FILE_SET_INVALID")
  return outputs
}

async function readOptional(path) {
  try {
    return await readFile(path)
  } catch (error) {
    if (error?.code === "ENOENT") return undefined
    throw error
  }
}

/** Exact, reproducible dependency installation. This never grants a runtime capability. */
export async function installLangchainNativeStreamOrigin({
  workspaceRoot = repositoryRoot,
  checkOnly = false
} = {}) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  const patch = await readFile(patchPath)
  if (
    manifest.name !== "langchain" ||
    manifest.version !== "1.2.37" ||
    sha256(patch) !== manifest.patchSha256
  )
    throw Error("LANGCHAIN_PATCH_MANIFEST_INVALID")
  if (
    !Array.isArray(manifest.files) ||
    manifest.files.length !== packageFiles.length ||
    manifest.files.some((file, index) => file.path !== packageFiles[index])
  )
    throw Error("LANGCHAIN_PATCH_FILE_SET_INVALID")
  if (
    !Array.isArray(manifest.templates) ||
    manifest.templates.length !== templateFiles.length ||
    manifest.templates.some((template, index) => template.path !== templateFiles[index])
  )
    throw Error("LANGCHAIN_PATCH_TEMPLATE_SET_INVALID")
  for (const template of manifest.templates) {
    const path = targetPath(resolve(repositoryRoot, "patches"), template.path)
    if (sha256(await readFile(path)) !== template.sha256)
      throw Error("LANGCHAIN_PATCH_TEMPLATE_CHANGED")
  }
  const packageRoot = resolve(workspaceRoot, "node_modules/langchain")
  const packageValue = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"))
  if (packageValue.name !== manifest.name || packageValue.version !== manifest.version)
    throw Error("LANGCHAIN_PATCH_VERSION_CHANGED")
  if (sha256(await readFile(resolve(packageRoot, "LICENSE"))) !== manifest.licenseSha256)
    throw Error("LANGCHAIN_PATCH_LICENSE_CHANGED")
  const originals = new Map()
  let pristine = true,
    installed = true
  for (const file of manifest.files) {
    if (originals.has(file.path)) throw Error("LANGCHAIN_PATCH_DUPLICATE_PATH")
    const content = await readOptional(targetPath(packageRoot, file.path))
    originals.set(file.path, content)
    const digest = content === undefined ? null : sha256(content)
    pristine &&= digest === file.beforeSha256
    installed &&= digest === file.afterSha256
  }
  // The additive tool foundation changes three shared files. Recognize only its complete
  // thirteen-file known state and artifacts, including the six non-overlapping beforeimages.
  const { classifyLangchainNativeFoundations } = await import(
    "./apply-langchain-native-tool-invoke-origin.mjs"
  )
  const state = await classifyLangchainNativeFoundations({ workspaceRoot })
  if (state === "mixed") throw Error("LANGCHAIN_PATCH_MIXED_OR_UNKNOWN_FILES")
  if (installed && (state === undefined || state === "base"))
    return { status: "installed", version: manifest.version }
  if (state === "overlay")
    return { status: "installed", version: manifest.version }
  if (!pristine) throw Error("LANGCHAIN_PATCH_MIXED_OR_UNKNOWN_FILES")
  if (state !== undefined && state !== "pristine")
    throw Error("LANGCHAIN_PATCH_MIXED_OR_UNKNOWN_FILES")
  if (checkOnly) throw Error("LANGCHAIN_PATCH_NOT_INSTALLED")
  const outputs = applyTextPatch(patch.toString("utf8"), originals)
  for (const file of manifest.files) {
    if (sha256(outputs.get(file.path)) !== file.afterSha256)
      throw Error("LANGCHAIN_PATCH_POSTIMAGE_INVALID")
  }
  // Stage all validated outputs before changing any target. A failed batch restores its own bytes.
  const staged = [],
    committed = [],
    failures = []
  try {
    for (const file of manifest.files) {
      const target = targetPath(packageRoot, file.path)
      const temporary = `${target}.cmb-${randomUUID()}.tmp`
      staged.push({ target, temporary, path: file.path })
      await writeFile(temporary, outputs.get(file.path), { flag: "wx" })
    }
    for (const file of manifest.files) {
      const now = await readOptional(targetPath(packageRoot, file.path))
      const digest = now === undefined ? null : sha256(now)
      if (digest !== file.beforeSha256) throw Error("LANGCHAIN_PATCH_CHANGED_DURING_INSTALL")
    }
    for (const file of staged) {
      await rename(file.temporary, file.target)
      committed.push(file)
    }
  } catch (error) {
    failures.push(error)
    for (let index = committed.length - 1; index >= 0; index--) {
      const file = committed[index],
        original = originals.get(file.path)
      try {
        const current = await readOptional(file.target)
        if (current === undefined || sha256(current) !== sha256(outputs.get(file.path)))
          throw Error("LANGCHAIN_PATCH_ROLLBACK_TARGET_CHANGED")
        if (original === undefined) await unlink(file.target)
        else await writeFile(file.target, original)
      } catch (rollbackError) {
        failures.push(rollbackError)
      }
    }
  } finally {
    for (const file of staged) {
      try {
        await unlink(file.temporary)
      } catch (error) {
        if (error?.code !== "ENOENT") failures.push(error)
      }
    }
  }
  if (failures.length > 1) throw new AggregateError(failures, "LANGCHAIN_PATCH_ROLLBACK_FAILED")
  if (failures.length) throw failures[0]
  return { status: "patched", version: manifest.version }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await installLangchainNativeStreamOrigin({
    checkOnly: process.argv.includes("--check")
  })
  process.stdout.write(`langchain native stream origin: ${result.status} ${result.version}\n`)
}
