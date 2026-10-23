import { createHash } from "node:crypto"
import { lstat, readdir, realpath, open, mkdir, writeFile, chmod } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import {
  parseProjectRuntimeManifest,
  preserveProjectRuntimeEnvelope
} from "../../shared/project-runtime"

export const DERIVATION_LIMITS = {
  files: 4096,
  fileBytes: 8 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  depth: 24
}
export const DERIVATION_MANIFESTS = [
  ".codex-plugin/plugin.json",
  ".claude-plugin/plugin.json",
  "plugin.json"
]
export const DERIVATION_NOTES = "MY-PLUGIN.md"
export interface DerivationFile {
  path: string
  bytes: Buffer
  mode: number
  digest: string
}
export interface DerivationSnapshot {
  root: string
  files: DerivationFile[]
  excluded: string[]
  digest: string
  name: string
  totalBytes: number
  manifests: string[]
}

const excludedName = (name: string) =>
  /^(?:\.git|\.svn|\.hg|node_modules|__pycache__|\.venv|venv|\.cache|\.pytest_cache|logs?|\.autobizdevops|\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|id_rsa|id_ed25519|\.ssh|\.aws|\.azure|\.npmrc|\.pypirc|\.netrc|auth\.json|settings\.local\.json)$/i.test(
    name
  ) || /\.(?:log|pyc|pem|key|p12|pfx)$/i.test(name)
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex")
/** Match the existing directory DFS snapshot order without changing its digest domain. */
export function compareDerivationPaths(left: string, right: string): number {
  const a = left.split("/"),
    b = right.split("/")
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const order = a[index].localeCompare(b[index], "en")
    if (order) return order
  }
  return a.length - b.length
}
export function derivationDigest(files: DerivationFile[], excluded: string[]): string {
  return hash(
    JSON.stringify({ files: files.map((f) => [f.path, f.digest, f.mode & 0o777]), excluded })
  )
}
/** Host provenance compares retained paths and bytes across a source checkout and its ZIP.
 * Copy CAS separately includes permissions and excluded-path observations. */
export function derivationContentIdentity(files: DerivationFile[]): string {
  return hash(
    JSON.stringify(
      files
        .map((file) => [file.path, file.digest])
        .sort(([left], [right]) => left.localeCompare(right))
    )
  )
}
function packageJson(bytes: Buffer): Record<string, unknown> {
  const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("插件清单格式不支持")
  return raw as Record<string, unknown>
}

/** Reads only package content; excluded credentials are identified by name and never opened. */
export async function snapshotDerivationSource(directory: string): Promise<DerivationSnapshot> {
  const original = resolve(directory)
  const rootStat = await lstat(original)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw Error("来源不能是链接")
  const root = await realpath(original)
  if (root.toLowerCase() !== original.toLowerCase()) throw Error("来源目录包含链接")
  const files: DerivationFile[] = []
  const excluded: string[] = []
  const active = new Set<Promise<void>>()
  const jobs: Array<{ order: number; done: Promise<void> }> = []
  let totalBytes = 0
  let visited = 0
  let nextFile = 0
  let failure: { order: number; error: unknown } | undefined
  const failed = (order: number, error: unknown): void => {
    if (!failure || order < failure.order) failure = { order, error }
  }
  const walk = async (directoryPath: string, depth: number): Promise<void> => {
    if (failure) return
    if (depth > DERIVATION_LIMITS.depth) throw Error("插件目录层级超限")
    const entries = (await readdir(directoryPath, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name, "en")
    )
    const names = new Set<string>()
    for (const entry of entries) {
      if (failure) return
      if (++visited > DERIVATION_LIMITS.files) throw Error("插件文件数超限")
      const key = entry.name.toLowerCase()
      if (names.has(key) || /[<>:"|?*]/.test(entry.name) || /[. ]$/.test(entry.name))
        throw Error("插件路径存在大小写冲突或不支持的名称")
      names.add(key)
      const absolute = join(directoryPath, entry.name)
      const path = relative(root, absolute).replace(/\\/g, "/")
      if (isAbsolute(path) || path.startsWith("../")) throw Error("插件路径越界")
      const stat = await lstat(absolute)
      if (
        stat.isSymbolicLink() ||
        (await realpath(absolute)) !== absolute ||
        (stat.isFile() && stat.nlink !== 1)
      )
        throw Error("插件包含链接或硬链接")
      if (failure) return
      if (excludedName(entry.name)) {
        excluded.push(path)
        continue
      }
      if (stat.isDirectory()) {
        await walk(absolute, depth + 1)
        continue
      }
      if (!stat.isFile()) throw Error("插件包含不支持的文件类型")
      const reservedBytes = stat.size
      if (
        reservedBytes > DERIVATION_LIMITS.fileBytes ||
        totalBytes + reservedBytes > DERIVATION_LIMITS.totalBytes
      )
        throw Error("插件文件大小超限")
      // Reserve in DFS order before waiting for a slot; buffers may never exceed this budget.
      totalBytes += reservedBytes
      while (active.size >= 8) await Promise.race(active)
      if (failure) return
      const order = visited
      const index = nextFile++
      const read = async (): Promise<DerivationFile> => {
        const handle = await open(absolute, "r")
        try {
          const before = await handle.stat()
          if (
            !before.isFile() ||
            before.nlink !== 1 ||
            before.ino !== stat.ino ||
            before.dev !== stat.dev ||
            before.size !== reservedBytes
          )
            throw Error("来源已变化，请重新检查")
          const bytes = Buffer.alloc(before.size)
          let offset = 0
          while (offset < bytes.length) {
            const read = await handle.read(bytes, offset, bytes.length - offset, offset)
            if (!read.bytesRead) throw Error("来源已变化，请重新检查")
            offset += read.bytesRead
          }
          const after = await handle.stat()
          const current = await lstat(absolute)
          if (
            after.size !== before.size ||
            after.mtimeMs !== before.mtimeMs ||
            current.ino !== before.ino ||
            current.isSymbolicLink()
          )
            throw Error("来源已变化，请重新检查")
          return { path, bytes, mode: stat.mode, digest: hash(bytes) }
        } finally {
          await handle.close()
        }
      }
      const done: Promise<void> = read()
        .then(
          (file) => {
            files[index] = file
          },
          (error: unknown) => {
            failed(order, error)
          }
        )
        .finally(() => {
          active.delete(done)
        })
      active.add(done)
      jobs.push({ order, done })
    }
  }
  try {
    await walk(root, 0)
  } catch (error) {
    failed(visited, error)
  }
  // Never publish a result or error while a started read/close is still physically pending.
  const settled = await Promise.allSettled(jobs.map((job) => job.done))
  for (let index = 0; index < settled.length; index++) {
    const result = settled[index]
    if (result.status === "rejected") failed(jobs[index].order, result.reason)
  }
  if (failure) throw failure.error
  if ((await realpath(original)) !== root) throw Error("来源已变化，请重新检查")
  const manifests = DERIVATION_MANIFESTS.filter((path) => files.some((file) => file.path === path))
  if (!manifests.length) throw Error("未找到完整插件清单")
  const metadata = manifests.map((path) =>
    packageJson(files.find((file) => file.path === path)!.bytes)
  )
  const first = metadata[0]
  if (typeof first.name !== "string" || !first.name.trim()) throw Error("插件名称缺失")
  if (metadata.some((item) => item.name !== first.name || item.version !== first.version))
    throw Error("多个插件清单身份不一致")
  const paths = new Set(files.map((file) => file.path))
  const runtime = files.find((file) => file.path === "devclaw.project-runtime.json")
  if (runtime) {
    const rawManifest = packageJson(runtime.bytes)
    const manifest =
      rawManifest.apiVersion === "devclaw.project-runtime/v2"
        ? parseProjectRuntimeManifest(rawManifest)
        : rawManifest
    const plugin = manifest.plugin as Record<string, unknown> | undefined
    if (!plugin || plugin.id !== first.name || plugin.version !== first.version)
      throw Error("项目运行时清单与插件身份不一致")
  }
  for (const manifest of metadata)
    for (const key of ["hooks", "mods", "mcpServers", "skills"]) {
      const value = manifest[key]
      if (value === undefined) continue
      const values =
        typeof value === "string" ? [value] : key === "skills" && Array.isArray(value) ? value : []
      if (!values.length || values.some((v) => typeof v !== "string"))
        throw Error(`不支持的插件依赖声明：${key}`)
      for (const item of values as string[]) {
        const path = item.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "")
        if (
          isAbsolute(item) ||
          path.split("/").includes("..") ||
          !(
            path === "." ||
            paths.has(path) ||
            [...paths].some((file) => file.startsWith(`${path}/`))
          )
        )
          throw Error(`插件必需依赖缺失或已排除：${key}`)
      }
    }
  return {
    root,
    files,
    excluded,
    name: first.name,
    manifests,
    totalBytes,
    digest: derivationDigest(files, excluded)
  }
}

export function renameDerivation(
  snapshot: DerivationSnapshot,
  name: string,
  version?: string
): DerivationFile[] {
  if (
    !/^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,79}$/u.test(name) ||
    /[. ]$/.test(name) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  )
    throw Error("请输入1至80字的独立插件名称，不含路径或特殊符号")
  if (name.toLowerCase() === snapshot.name.toLowerCase()) throw Error("新插件名称必须与来源不同")
  return snapshot.files.map((file) => {
    let bytes = file.bytes
    if (snapshot.manifests.includes(file.path)) {
      const manifest = packageJson(bytes)
      bytes = Buffer.from(
        JSON.stringify(
          { ...manifest, name, ...(version === undefined ? {} : { version }) },
          null,
          2
        ) + "\n"
      )
    } else if (file.path === "devclaw.project-runtime.json") {
      const manifest = packageJson(bytes)
      const v2 = manifest.apiVersion === "devclaw.project-runtime/v2"
      const runtime = v2 ? parseProjectRuntimeManifest(manifest) : manifest
      const plugin = runtime.plugin as Record<string, unknown> | undefined
      if (!plugin || plugin.id !== snapshot.name) throw Error("项目清单身份约束不支持")
      const renamed = {
        ...runtime,
        plugin: {
          ...plugin,
          id: name,
          ...(plugin.name === snapshot.name ? { name } : {}),
          ...(version === undefined ? {} : { version })
        }
      }
      bytes = Buffer.from(
        JSON.stringify(
          v2
            ? preserveProjectRuntimeEnvelope(manifest, parseProjectRuntimeManifest(renamed))
            : renamed,
          null,
          2
        ) + "\n"
      )
    }
    return { ...file, bytes, digest: hash(bytes) }
  })
}

export async function writeDerivationFiles(root: string, files: DerivationFile[]): Promise<void> {
  for (const file of files) {
    const target = join(root, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.bytes, { flag: "wx", mode: file.mode & 0o777 })
    if (process.platform !== "win32") await chmod(target, file.mode & 0o777)
  }
}
