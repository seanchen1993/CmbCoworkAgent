import { lstat, opendir, realpath, stat } from "node:fs/promises"
import type { BigIntStats } from "node:fs"
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path"
import type { ModJson } from "../../../shared/mods/types"
import type { ToolPermissionResult } from "../../../shared/tool-permission"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import {
  openStableFileHandle,
  readStableFileHandleBounded,
  StableBoundedReadError
} from "../../services/stable-file-handle"

export const FUNCTION_READ_LIMIT = 512 * 1024
const ENTRY_LIMIT = 1024
export const FILE_CAPABILITIES = ["fs.read", "fs.list", "fs.exists", "fs.stat"] as const
export type FunctionFileMethod = (typeof FILE_CAPABILITIES)[number]

export interface FunctionFileAccess {
  run(
    method: FunctionFileMethod,
    path: string,
    signal: AbortSignal,
    options?: { resolve?: boolean }
  ): Promise<ModJson>
}

export interface FunctionFileScope {
  workspace: string
  assertLive(): void
  queryTool(tool: string, input: Record<string, unknown>): Promise<ToolPermissionResult>
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path)
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

function kind(value: { isFile(): boolean; isDirectory(): boolean }): "file" | "dir" | "other" {
  return value.isFile() ? "file" : value.isDirectory() ? "dir" : "other"
}

function sameMetadata(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  )
}

/** Project-scoped reads. Content uses the same stable OS handles as host previews. */
export class ProjectFunctionFiles implements FunctionFileAccess {
  constructor(
    private readonly workspace: string,
    private readonly assertLive: () => void,
    private readonly publish: (value: ModJson, signal: AbortSignal) => Promise<ModJson>,
    private readonly queryTool?: FunctionFileScope["queryTool"]
  ) {}

  private async allowed(method: FunctionFileMethod, path: string): Promise<boolean> {
    if (!this.queryTool) return true
    const list = method === "fs.list"
    const answer = await this.queryTool(
      list ? "host:ls" : "host:read_file",
      list ? { path } : { file_path: path }
    )
    return answer.decision === "allow"
  }

  private async path(input: string): Promise<{ root: string; path: string }> {
    if (
      typeof input !== "string" ||
      input.length === 0 ||
      Buffer.byteLength(input) > 8192 ||
      [...input].some((character) => character.charCodeAt(0) < 32) ||
      Buffer.from(input).toString("utf8") !== input
    )
      throw new ModFunctionError("MODS_FS_PATH")
    const suffix = input.slice(parse(input).root.length)
    if (
      /:/.test(suffix) ||
      input.startsWith("\\\\") ||
      suffix
        .split(/[\\/]/)
        .some(
          (part) =>
            part !== "." &&
            part !== ".." &&
            (/[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
        )
    )
      throw new ModFunctionError("MODS_FS_PATH")
    const root = await realpath(this.workspace)
    if (relative(resolve(this.workspace), root) !== "")
      throw new ModFunctionError("MODS_FS_ROOT_CHANGED")
    const candidate = resolve(root, input)
    if (!inside(root, candidate)) throw new ModFunctionError("MODS_FS_OUTSIDE_PROJECT")
    const path = await realpath(candidate)
    if (!inside(root, path)) throw new ModFunctionError("MODS_FS_OUTSIDE_PROJECT")
    return { root, path }
  }

  async run(
    method: FunctionFileMethod,
    input: string,
    signal: AbortSignal,
    options?: { resolve?: boolean }
  ): Promise<ModJson> {
    const check = (): void => {
      signal.throwIfAborted()
      this.assertLive()
    }
    check()
    let result: ModJson
    let verifyMetadata: (() => Promise<void>) | undefined
    try {
      if (!(await this.allowed(method, resolve(this.workspace, input))))
        throw new ModFunctionError("MODS_FS_ACCESS_DENIED")
      check()
      const target = await this.path(input)
      check()
      if (!(await this.allowed(method, target.path)))
        throw new ModFunctionError("MODS_FS_ACCESS_DENIED")
      check()
      if (method === "fs.read") {
        const opened = await openStableFileHandle(target.root, target.path)
        try {
          check()
          result = (await readStableFileHandleBounded(opened, FUNCTION_READ_LIMIT)).toString("utf8")
          const resolved = await this.path(input)
          if (resolved.path !== target.path) throw new ModFunctionError("MODS_FS_CHANGED")
        } finally {
          await opened.handle.close()
        }
      } else if (method === "fs.list") {
        const before = await stat(target.path, { bigint: true })
        if (!before.isDirectory()) throw new ModFunctionError("ENOTDIR")
        const entries: Array<{ name: string; kind: string; size: number; isLink: boolean }> = []
        const directory = await opendir(target.path)
        let visited = 0
        for await (const entry of directory) {
          check()
          if (++visited > ENTRY_LIMIT) throw new ModFunctionError("MODS_FS_ENTRY_LIMIT")
          if (!(await this.allowed("fs.stat", join(target.path, entry.name)))) continue
          check()
          // Inspect the entry itself; never follow a child link to obtain listing metadata.
          const child = await lstat(join(target.path, entry.name)).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return undefined
              throw error
            }
          )
          check()
          if (!child) continue
          entries.push({
            name: entry.name,
            kind: kind(child),
            size: child.isFile() ? child.size : 0,
            isLink: child.isSymbolicLink()
          })
        }
        const resolved = await this.path(input)
        const after = await stat(resolved.path, { bigint: true })
        if (resolved.path !== target.path || before.dev !== after.dev || before.ino !== after.ino)
          throw new ModFunctionError("MODS_FS_CHANGED")
        result = entries.sort((a, b) => a.name.localeCompare(b.name))
      } else if (method === "fs.stat") {
        const spelling = resolve(target.root, input)
        const own = await lstat(spelling, { bigint: true })
        const value = await stat(target.path, { bigint: true })
        verifyMetadata = async () => {
          check()
          try {
            const resolved = await this.path(input)
            const [currentOwn, currentTarget] = await Promise.all([
              lstat(spelling, { bigint: true }),
              stat(target.path, { bigint: true })
            ])
            if (
              resolved.path !== target.path ||
              !sameMetadata(own, currentOwn) ||
              !sameMetadata(value, currentTarget)
            )
              throw new ModFunctionError("MODS_FS_CHANGED")
          } catch (error) {
            check()
            if (error instanceof ModFunctionError) throw error
            throw new ModFunctionError("MODS_FS_CHANGED")
          }
          check()
        }
        await verifyMetadata()
        const size = Number(value.size)
        const mtimeMs = Number(value.mtimeMs)
        if (!Number.isSafeInteger(size) || size < 0 || !Number.isFinite(mtimeMs))
          throw new ModFunctionError("MODS_FS_METADATA_LIMIT")
        result = {
          kind: kind(value),
          size,
          mtimeMs,
          isLink: own.isSymbolicLink(),
          ...(options?.resolve ? { realPath: target.path } : {})
        }
      } else {
        await stat(target.path)
        const resolved = await this.path(input)
        if (resolved.path !== target.path) throw new ModFunctionError("MODS_FS_CHANGED")
        result = true
      }
      if (!(await this.allowed(method, target.path)))
        throw new ModFunctionError("MODS_FS_ACCESS_DENIED")
    } catch (error) {
      check()
      if (method !== "fs.exists") {
        if (error instanceof ModFunctionError) throw error
        if (error instanceof StableBoundedReadError)
          throw new ModFunctionError(
            error.failure === "changed" ? "MODS_FS_CHANGED" : "MODS_FS_READ_LIMIT"
          )
        const code = (error as NodeJS.ErrnoException)?.code
        throw new ModFunctionError(
          code === "ENOENT"
            ? "MODS_FS_NOT_FOUND"
            : code === "EACCES" || code === "EPERM"
              ? "MODS_FS_ACCESS_DENIED"
              : "MODS_FS_FAILED"
        )
      }
      result = false
    }
    check()
    // No optional hook receives the raw host result before mandatory publication.
    const published = await this.publish(result, signal)
    check()
    if (!(await this.allowed(method, resolve(this.workspace, input)))) {
      check()
      if (method === "fs.exists") return false
      throw new ModFunctionError("MODS_FS_ACCESS_DENIED")
    }
    check()
    if (verifyMetadata) {
      await verifyMetadata()
      check()
    }
    return published
  }
}
