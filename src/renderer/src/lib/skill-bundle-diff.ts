export interface TextBundleFile {
  path: string
  content: string
}

export const SKILL_EVOLVER_MARKER_KEY = "evolved-by"
export const SKILL_EVOLVER_MARKER_VALUE = "CMBDevClaw Trace Evolver"

const TEXT_BUNDLE_FILE_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".less",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".vue",
  ".py",
  ".sh",
  ".bash",
  ".zsh",
  ".sql"
])
const MAX_ZIP_TEXT_FILE_BYTES = 512 * 1024
const MAX_ZIP_TEXT_TOTAL_BYTES = 2 * 1024 * 1024

export function normalizeTextBundlePath(input: string): string {
  return input.normalize("NFC").replace(/\\/g, "/").replace(/^\/+/, "")
}

function isUnsafeBundlePath(input: string): boolean {
  const normalized = normalizeTextBundlePath(input)
  return !normalized || normalized.split("/").some((segment) => segment === "..")
}

function extensionOf(filePath: string): string {
  const name = filePath.split("/").pop() || filePath
  const idx = name.lastIndexOf(".")
  return idx >= 0 ? name.slice(idx).toLowerCase() : ""
}

function isTextBundlePath(filePath: string): boolean {
  const baseName = filePath.split("/").pop() || filePath
  if (baseName.startsWith(".")) return false
  return TEXT_BUNDLE_FILE_EXTENSIONS.has(extensionOf(filePath))
}

function containsCjk(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text)
}

function scoreDecodedName(name: string): number {
  let score = 0
  for (const ch of name) {
    if (/[\u3400-\u9fff]/.test(ch)) score += 4
    else if (/[A-Za-z0-9._\- ()[\]]/.test(ch)) score += 1
    else if (/[\u2500-\u259f]/.test(ch)) score -= 3
    else if (ch === "\uFFFD") score -= 4
  }
  return score
}

function filenameBytes(input: Uint8Array | string[]): Uint8Array {
  if (input instanceof Uint8Array) return input
  return Uint8Array.from(input.map((part) => part.charCodeAt(0) & 0xff))
}

function decodeZipFileName(input: Uint8Array | string[]): string {
  const bytes = filenameBytes(input)
  const decoders = [
    new TextDecoder("utf-8"),
    new TextDecoder("gb18030")
  ]
  const candidates = decoders
    .map((decoder) => {
      try {
        return normalizeTextBundlePath(decoder.decode(bytes))
      } catch {
        return ""
      }
    })
    .filter(Boolean)

  if (candidates.length === 0) return ""
  return candidates.reduce((best, candidate) => {
    const candidateScore = scoreDecodedName(candidate)
    const bestScore = scoreDecodedName(best)
    if (containsCjk(candidate) && !containsCjk(best)) return candidate
    return candidateScore > bestScore ? candidate : best
  }, candidates[0])
}

function splitLines(content: string): string[] {
  if (!content) return []
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  const lines = normalized.split("\n")
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  return lines
}

function hunkRange(start: number, count: number): string {
  if (count === 0) return `${Math.max(start - 1, 0)},0`
  return `${start},${count}`
}

function escapeDiffLine(line: string): string {
  return line || ""
}

function buildFilePatch(filePath: string, oldContent: string | null, newContent: string | null): string {
  const oldLines = splitLines(oldContent || "")
  const newLines = splitLines(newContent || "")
  const header = [
    `diff --git a/${filePath} b/${filePath}`,
    oldContent === null ? "new file mode 100644" : newContent === null ? "deleted file mode 100644" : "",
    oldContent === null ? "--- /dev/null" : `--- a/${filePath}`,
    newContent === null ? "+++ /dev/null" : `+++ b/${filePath}`
  ].filter(Boolean)

  if (oldContent === null) {
    return [
      ...header,
      `@@ -0,0 +${hunkRange(1, newLines.length)} @@`,
      ...newLines.map((line) => `+${escapeDiffLine(line)}`)
    ].join("\n")
  }

  if (newContent === null) {
    return [
      ...header,
      `@@ -${hunkRange(1, oldLines.length)} +0,0 @@`,
      ...oldLines.map((line) => `-${escapeDiffLine(line)}`)
    ].join("\n")
  }

  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix++
  }

  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++
  }

  const contextBefore = Math.max(0, prefix - 3)
  const oldChangedEnd = oldLines.length - suffix
  const newChangedEnd = newLines.length - suffix
  const contextAfterOldEnd = Math.min(oldLines.length, oldChangedEnd + 3)
  const contextAfterNewEnd = Math.min(newLines.length, newChangedEnd + 3)

  const hunkOldCount = contextAfterOldEnd - contextBefore
  const hunkNewCount = contextAfterNewEnd - contextBefore
  const body: string[] = []

  for (const line of oldLines.slice(contextBefore, prefix)) body.push(` ${escapeDiffLine(line)}`)
  for (const line of oldLines.slice(prefix, oldChangedEnd)) body.push(`-${escapeDiffLine(line)}`)
  for (const line of newLines.slice(prefix, newChangedEnd)) body.push(`+${escapeDiffLine(line)}`)
  for (const line of oldLines.slice(oldChangedEnd, contextAfterOldEnd)) body.push(` ${escapeDiffLine(line)}`)

  return [
    ...header,
    `@@ -${hunkRange(contextBefore + 1, hunkOldCount)} +${hunkRange(contextBefore + 1, hunkNewCount)} @@`,
    ...body
  ].join("\n")
}

function toFileMap(files: TextBundleFile[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const file of files) {
    const normalized = normalizeTextBundlePath(file.path)
    if (!normalized || isUnsafeBundlePath(normalized)) continue
    map.set(normalized, file.content)
  }
  return map
}

export function buildBundleUnifiedDiff(oldFiles: TextBundleFile[], newFiles: TextBundleFile[]): string {
  const oldMap = toFileMap(oldFiles)
  const newMap = toFileMap(newFiles)
  const paths = Array.from(new Set([...oldMap.keys(), ...newMap.keys()])).sort((a, b) => a.localeCompare(b))
  const patches: string[] = []

  for (const filePath of paths) {
    const oldContent = oldMap.has(filePath) ? oldMap.get(filePath)! : null
    const newContent = newMap.has(filePath) ? newMap.get(filePath)! : null
    if (oldContent === newContent) continue
    patches.push(buildFilePatch(filePath, oldContent, newContent))
  }

  return patches.join("\n\n")
}

export async function extractTextBundleFromZip(buffer: ArrayBuffer): Promise<TextBundleFile[]> {
  const { default: JSZip } = await import("jszip")
  const zip = await JSZip.loadAsync(buffer, { decodeFileName: decodeZipFileName })
  const entries = Object.values(zip.files)
  const skillEntry = entries.find((entry) => !entry.dir && /(^|\/)SKILL\.md$/i.test(normalizeTextBundlePath(entry.name)))
  const basePrefix = skillEntry ? normalizeTextBundlePath(skillEntry.name).replace(/SKILL\.md$/i, "") : ""
  const files: TextBundleFile[] = []
  let totalBytes = 0

  for (const entry of entries) {
    if (entry.dir) continue
    const normalizedName = normalizeTextBundlePath(entry.name)
    if (!normalizedName.startsWith(basePrefix)) continue
    const relativePath = normalizeTextBundlePath(normalizedName.slice(basePrefix.length))
    if (isUnsafeBundlePath(relativePath) || !isTextBundlePath(relativePath)) continue

    const zipEntryData = (entry as { _data?: { uncompressedSize?: number } })._data
    const size = typeof zipEntryData?.uncompressedSize === "number" ? zipEntryData.uncompressedSize : 0
    if (size > MAX_ZIP_TEXT_FILE_BYTES) continue
    if (size > 0 && totalBytes + size > MAX_ZIP_TEXT_TOTAL_BYTES) continue

    const content = await entry.async("string")
    if (content.includes("\u0000")) continue
    totalBytes += size || new TextEncoder().encode(content).byteLength
    if (totalBytes > MAX_ZIP_TEXT_TOTAL_BYTES) break
    files.push({ path: relativePath, content })
  }

  return files.sort((a, b) => a.path.localeCompare(b.path))
}

export function isSafeTextBundlePath(input: string): boolean {
  const normalized = normalizeTextBundlePath(input)
  return !isUnsafeBundlePath(normalized) && isTextBundlePath(normalized)
}

function splitFrontmatter(content: string): { raw: string | null; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/)
  if (!match) return { raw: null, body: content }
  return { raw: match[1], body: content.slice(match[0].length) }
}

function upsertSimpleYamlField(raw: string | null, key: string, value: string): string {
  const lines = raw ? raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n") : []
  const nextLine = `${key}: ${value}`
  const index = lines.findIndex((line) => {
    const colon = line.indexOf(":")
    return colon > 0 && line.slice(0, colon).trim().toLowerCase() === key.toLowerCase()
  })
  if (index >= 0) {
    lines[index] = nextLine
  } else {
    lines.push(nextLine)
  }
  return lines.join("\n").trimEnd()
}

/**
 * 计算下一个补丁版本（与后端 patching.py `_next_version` 对齐）：
 * - 标准语义版本 vX.Y.Z -> vX.Y.(Z+1)
 * - 缺省 / 非标准 -> v1.0.1
 */
export function nextSkillVersion(current?: string | null): string {
  const raw = String(current ?? "").trim()
  const match = raw.match(/^v?(\d+)\.(\d+)\.(\d+)$/)
  if (match) return `v${match[1]}.${match[2]}.${Number(match[3]) + 1}`
  return "v1.0.1"
}

/** 读取一段 SKILL.md frontmatter 的 version 字段。 */
export function readSkillVersion(content: string): string | null {
  const { raw } = splitFrontmatter(content)
  if (!raw) return null
  for (const line of raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    const colon = line.indexOf(":")
    if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === "version") {
      return line.slice(colon + 1).trim() || null
    }
  }
  return null
}

/** 从一组 bundle 文件中读取 SKILL.md 的源版本（用于派生 source+1）。 */
export function readSkillBundleVersion(files: TextBundleFile[]): string | null {
  const skill = files.find((file) => normalizeTextBundlePath(file.path) === "SKILL.md")
  return skill ? readSkillVersion(skill.content) : null
}

/**
 * 写入 Trace Evolver 托管的 SKILL.md frontmatter 字段：
 * - 始终写入 `evolved-by` 标识
 * - 当传入有效的 `bumpFromVersion`（源版本）时，把 `version` 写成 source+1。
 *   注意必须从「源版本」而非当前版本 bump，否则多次保存会持续累加。
 */
export function ensureSkillEvolverMarker(content: string, bumpFromVersion?: string | null): string {
  const { raw, body } = splitFrontmatter(content)
  let frontmatter = upsertSimpleYamlField(raw, SKILL_EVOLVER_MARKER_KEY, SKILL_EVOLVER_MARKER_VALUE)
  if (bumpFromVersion) {
    frontmatter = upsertSimpleYamlField(frontmatter, "version", nextSkillVersion(bumpFromVersion))
  }
  return `---\n${frontmatter}\n---\n\n${body.replace(/^\n+/, "")}`.replace(/\s*$/, "\n")
}

export function ensureTextBundleEvolverMarker(
  files: TextBundleFile[],
  bumpFromVersion?: string | null
): TextBundleFile[] {
  const normalized = files
    .filter((file) => isSafeTextBundlePath(file.path))
    .map((file) => ({ path: normalizeTextBundlePath(file.path), content: file.content }))
  const skillIndex = normalized.findIndex((file) => file.path === "SKILL.md")
  if (skillIndex < 0) {
    throw new Error("候选 bundle 缺少 SKILL.md")
  }
  return normalized.map((file, index) => (
    index === skillIndex
      ? { ...file, content: ensureSkillEvolverMarker(file.content, bumpFromVersion) }
      : file
  ))
}

export async function createTextBundleZip(files: TextBundleFile[], filename = "skill.zip"): Promise<{ buffer: ArrayBuffer; filename: string }> {
  const { default: JSZip } = await import("jszip")
  const zip = new JSZip()
  for (const file of ensureTextBundleEvolverMarker(files)) {
    zip.file(file.path, file.content)
  }
  const buffer = await zip.generateAsync({ type: "arraybuffer", mimeType: "application/zip" })
  return { buffer, filename }
}

export async function createMergedTextBundleZip(
  originalBuffer: ArrayBuffer,
  files: TextBundleFile[],
  filename = "skill.zip"
): Promise<{ buffer: ArrayBuffer; filename: string }> {
  const { default: JSZip } = await import("jszip")
  const zip = await JSZip.loadAsync(originalBuffer, { decodeFileName: decodeZipFileName })
  const entries = Object.values(zip.files)
  const skillEntry = entries.find((entry) => !entry.dir && /(^|\/)SKILL\.md$/i.test(normalizeTextBundlePath(entry.name)))
  const basePrefix = skillEntry ? normalizeTextBundlePath(skillEntry.name).replace(/SKILL\.md$/i, "") : ""
  for (const file of ensureTextBundleEvolverMarker(files)) {
    zip.file(`${basePrefix}${file.path}`, file.content)
  }
  const buffer = await zip.generateAsync({ type: "arraybuffer", mimeType: "application/zip" })
  return { buffer, filename }
}
