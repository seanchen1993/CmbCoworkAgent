import { createHash } from "node:crypto"
import { types } from "node:util"

export interface AuthoringSourceFile {
  path: string
  text: string
}
export interface AuthoringSourceBundle {
  schemaVersion: 1
  digest: string
  files: AuthoringSourceFile[]
}
export const AUTHORING_BUNDLE_LIMITS = Object.freeze({
  files: 64,
  fileBytes: 64 * 1024,
  totalBytes: 256 * 1024,
  pathLength: 160
})

/** Text may be preserved in a package without granting permission to execute it. */
export const hasAuthoringTextExtension = (path: string): boolean =>
  /\.(?:[cm]?[jt]sx?|json|md|css|txt|py|sh|ps1)$/.test(path)

function dataRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value))
    throw Error("AUTHORING_SOURCE_INVALID")
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw Error("AUTHORING_SOURCE_INVALID")
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string"))
    throw Error("AUTHORING_SOURCE_INVALID")
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.values(descriptors).some((item) => !("value" in item) || !item.enumerable))
    throw Error("AUTHORING_SOURCE_INVALID")
  return Object.fromEntries(Object.entries(descriptors).map(([key, item]) => [key, item.value]))
}

function sourcePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > AUTHORING_BUNDLE_LIMITS.pathLength ||
    !/^[A-Za-z0-9._/-]+$/.test(value)
  )
    throw Error("AUTHORING_SOURCE_PATH")
  const segments = value.split("/")
  if (
    segments.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.endsWith(".") ||
        /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part) ||
        [".git", "node_modules", ".env"].includes(part.toLowerCase()) ||
        part.toLowerCase().startsWith(".env.")
    ) ||
    !hasAuthoringTextExtension(value)
  )
    throw Error("AUTHORING_SOURCE_PATH")
  return value
}

/** Author-supplied text only. This creates no package installation, grant or runtime authority. */
export function createAuthoringSourceBundle(input: unknown): AuthoringSourceBundle {
  if (
    !Array.isArray(input) ||
    types.isProxy(input) ||
    input.length < 1 ||
    input.length > AUTHORING_BUNDLE_LIMITS.files
  )
    throw Error("AUTHORING_SOURCE_LIMIT")
  const files: AuthoringSourceFile[] = []
  const names = new Set<string>()
  let bytes = 0
  for (let index = 0; index < input.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
    if (!descriptor || !("value" in descriptor)) throw Error("AUTHORING_SOURCE_INVALID")
    const row = dataRecord(descriptor.value)
    if (Object.keys(row).length !== 2 || !Object.hasOwn(row, "path") || !Object.hasOwn(row, "text"))
      throw Error("AUTHORING_SOURCE_INVALID")
    const path = sourcePath(row.path)
    const text = row.text
    if (
      typeof text !== "string" ||
      text.length > AUTHORING_BUNDLE_LIMITS.fileBytes ||
      text.includes("\0") ||
      Buffer.byteLength(text, "utf8") > AUTHORING_BUNDLE_LIMITS.fileBytes ||
      Buffer.from(text, "utf8").toString("utf8") !== text
    )
      throw Error("AUTHORING_SOURCE_TEXT")
    const key = path.toLowerCase()
    if (names.has(key)) throw Error("AUTHORING_SOURCE_COLLISION")
    names.add(key)
    bytes += Buffer.byteLength(path, "utf8") + Buffer.byteLength(text, "utf8")
    if (bytes > AUTHORING_BUNDLE_LIMITS.totalBytes) throw Error("AUTHORING_SOURCE_LIMIT")
    files.push({ path, text })
  }
  for (const path of names) {
    const segments = path.split("/")
    for (let count = 1; count < segments.length; count++)
      if (names.has(segments.slice(0, count).join("/"))) throw Error("AUTHORING_SOURCE_COLLISION")
  }
  if (
    !files.some((file) =>
      ["plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json",
        "composition/source.json"].includes(file.path)
    )
  )
    throw Error("AUTHORING_PLUGIN_MANIFEST_REQUIRED")
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return {
    schemaVersion: 1,
    digest: createHash("sha256")
      .update(JSON.stringify({ schemaVersion: 1, files }))
      .digest("hex"),
    files
  }
}

/** Recompute the source digest when reading a saved version; never trust a stored digest alone. */
export function readAuthoringSourceBundle(input: unknown): AuthoringSourceBundle {
  const row = dataRecord(input)
  if (Object.keys(row).length !== 3 || row.schemaVersion !== 1 || typeof row.digest !== "string")
    throw Error("AUTHORING_SOURCE_INVALID")
  const bundle = createAuthoringSourceBundle(row.files)
  if (bundle.digest !== row.digest) throw Error("AUTHORING_SOURCE_DIGEST_CHANGED")
  return bundle
}
