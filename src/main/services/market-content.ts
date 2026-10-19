import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"

// Deliberately obfuscation, not cryptography. Version the envelope so ordinary
// text and binary assets can be decoded without guessing their encoding.
export const MARKET_CONTENT_PREFIX = "CMB-MARKET-BASE64-V1\n"
export const MARKET_CONTENT_MARKER = ".cmb-market-content.json"
export const MARKET_CONTENT_DENIED =
  "市场下载的技能和插件受保护，仅自己上传的原始内容可查看、编辑或导出"
const prefix = Buffer.from(MARKET_CONTENT_PREFIX)

export function encodeMarketContent(content: Buffer): Buffer {
  return Buffer.from(MARKET_CONTENT_PREFIX + content.toString("base64"))
}

export function decodeMarketContent(content: Buffer): Buffer {
  if (!content.subarray(0, prefix.length).equals(prefix)) return content
  const body = content.subarray(prefix.length).toString("utf8")
  if (body.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body)) {
    throw new Error("市场资源编码损坏，请重新安装")
  }
  const decoded = Buffer.from(body, "base64")
  if (decoded.toString("base64") !== body) throw new Error("市场资源编码损坏，请重新安装")
  return decoded
}

export function readContentFileSync(filePath: string): Buffer
export function readContentFileSync(filePath: string, encoding: BufferEncoding): string
export function readContentFileSync(filePath: string, encoding?: BufferEncoding): Buffer | string {
  const content = decodeMarketContent(readFileSync(filePath))
  return encoding ? content.toString(encoding) : content
}

export function readContentFile(filePath: string): Promise<Buffer>
export function readContentFile(filePath: string, encoding: BufferEncoding): Promise<string>
export async function readContentFile(
  filePath: string,
  encoding?: BufferEncoding
): Promise<Buffer | string> {
  const content = decodeMarketContent(await readFile(filePath))
  return encoding ? content.toString(encoding) : content
}

function findMarker(filePath: string): string | null {
  let current = resolve(filePath)
  while (true) {
    if (existsSync(join(current, MARKET_CONTENT_MARKER))) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/** Check the real path too: a symlink must not turn a market file into a local file. */
export function findProtectedMarketRoot(filePath: string): string | null {
  const lexical = findMarker(filePath)
  if (lexical) return lexical
  let existing = resolve(filePath)
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing)
  try {
    return findMarker(realpathSync(existing))
  } catch {
    return null
  }
}

export function assertOriginalContent(filePath: string): void {
  if (findProtectedMarketRoot(filePath)) throw new Error(MARKET_CONTENT_DENIED)
}

export function getMarketContentStoredLimit(filePath: string, maxBytes: number): number {
  return findProtectedMarketRoot(filePath) ? Math.ceil(maxBytes / 3) * 4 + prefix.length : maxBytes
}

function walkFiles(root: string, visit: (filePath: string) => void): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === MARKET_CONTENT_MARKER) continue
    const target = join(root, entry.name)
    if (entry.isSymbolicLink()) throw new Error("市场资源不能包含符号链接")
    if (entry.isDirectory()) walkFiles(target, visit)
    else if (entry.isFile()) visit(target)
  }
}

/** The installer calls this before publishing metadata or invalidating caches. */
export function protectMarketDirectory(root: string): void {
  // The marker also covers nested skills and prevents exporting a parent bundle.
  writeFileSync(
    join(root, MARKET_CONTENT_MARKER),
    JSON.stringify({ version: 1, origin: "market", complete: false })
  )
  walkFiles(root, (filePath) => {
    const content = readFileSync(filePath)
    if (content.subarray(0, prefix.length).equals(prefix)) {
      decodeMarketContent(content)
      return
    }
    const temporary = `${filePath}.cmb-encoding-${randomUUID()}`
    try {
      writeFileSync(temporary, encodeMarketContent(content), {
        mode: statSync(filePath).mode,
        flag: "wx"
      })
      renameSync(temporary, filePath)
    } finally {
      rmSync(temporary, { force: true })
    }
  })
  writeFileSync(
    join(root, MARKET_CONTENT_MARKER),
    JSON.stringify({ version: 1, origin: "market", complete: true })
  )
  clearRuntimeProjection(root)
}

export function isMarketProtectionComplete(root: string): boolean {
  try {
    return JSON.parse(readFileSync(join(root, MARKET_CONTENT_MARKER), "utf8")).complete === true
  } catch {
    return false
  }
}

/** Refuse importing an encoded installed copy through the original-upload path. */
export function assertOriginalUpload(content: Buffer, fileName: string): void {
  if (
    fileName.replace(/\\/g, "/").split("/").includes(MARKET_CONTENT_MARKER) ||
    content.subarray(0, prefix.length).equals(prefix)
  ) {
    throw new Error(MARKET_CONTENT_DENIED)
  }
}

export function assertOriginalDirectory(root: string): void {
  assertOriginalContent(root)
  walkFiles(root, (filePath) => assertOriginalUpload(readFileSync(filePath), filePath))
}

const projections = new Map<string, string>()
let runtimeRoot: string | undefined

function clearRuntimeProjection(root: string): void {
  projections.delete(realpathSync(root))
}

/** External interpreters need real files. These copies live only for this app session. */
export function materializeMarketRuntimeRoot(root: string): string {
  root = realpathSync(root)
  if (
    runtimeRoot &&
    (root === runtimeRoot ||
      root.startsWith(runtimeRoot + (process.platform === "win32" ? "\\" : "/")))
  )
    return root
  const cached = projections.get(root)
  if (cached) return cached
  runtimeRoot ??= mkdtempSync(join(tmpdir(), "cmb-market-runtime-"))
  const targetRoot = mkdtempSync(join(runtimeRoot, "resource-"))
  try {
    walkFiles(root, (filePath) => {
      const target = join(targetRoot, relative(root, filePath))
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, readContentFileSync(filePath), { mode: lstatSync(filePath).mode })
    })
    writeFileSync(
      join(targetRoot, MARKET_CONTENT_MARKER),
      JSON.stringify({ version: 1, runtime: true })
    )
    projections.set(root, targetRoot)
    return targetRoot
  } catch (error) {
    rmSync(targetRoot, { recursive: true, force: true })
    throw error
  }
}

export function cleanupMarketRuntimeContent(): void {
  if (runtimeRoot) rmSync(runtimeRoot, { recursive: true, force: true })
  runtimeRoot = undefined
  projections.clear()
}

export function resolveMarketRuntimePath(filePath: string): string {
  const root = findProtectedMarketRoot(filePath)
  if (!root) return filePath
  const real = realpathSync(filePath)
  const rel = relative(realpathSync(root), real)
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(MARKET_CONTENT_DENIED)
  return join(materializeMarketRuntimeRoot(root), rel)
}

/** Roots come from main-owned discovery, never from renderer-provided origin flags. */
export function prepareMarketCommand(
  command: string,
  cwd: string,
  roots: string[]
): { command: string; cwd: string } {
  for (const candidate of new Set(roots)) {
    const root = findProtectedMarketRoot(candidate)
    if (!root) continue
    const variants = [root, root.replace(/\\/g, "/"), root.replace(/\\/g, "\\\\")]
    if (!variants.some((value) => command.includes(value)) && !cwd.startsWith(root)) continue
    const runtime = materializeMarketRuntimeRoot(root)
    for (const value of variants.sort((a, b) => b.length - a.length)) {
      const replacement = value.includes("/")
        ? runtime.replace(/\\/g, "/")
        : value.includes("\\\\")
          ? runtime.replace(/\\/g, "\\\\")
          : runtime
      command = command.split(value).join(replacement)
    }
    const rel = relative(root, cwd)
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) cwd = join(runtime, rel)
  }
  return { command, cwd }
}
