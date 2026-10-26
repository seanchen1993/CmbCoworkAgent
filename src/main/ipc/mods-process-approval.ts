import type { MessageBoxOptions } from "electron"
import { createHash } from "node:crypto"
import type { BigIntStats } from "node:fs"
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rmdir,
  unlink,
  writeFile
} from "node:fs/promises"
import { join } from "node:path"
import { ModError } from "../mods/errors"
import type { FunctionProcessRequest } from "../mods/v2/process-sdk"

interface ProcessApprovalHost {
  showDialog(options: MessageBoxOptions): Promise<{ response: number }>
  openPath(path: string): Promise<string>
  assertCurrent(): void
  signal: AbortSignal
  /** Existing application profile directory; do not use a process-supplied TEMP override. */
  tempRoot: string
}

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
const preview = (value: unknown, limit: number): string => {
  const text = JSON.stringify(value).replace(
    /[\u0085\u2028\u2029]/gu,
    (character) => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0")
  )
  return text.length <= limit ? text : text.slice(0, limit) + "…（完整内容见请求文件）"
}

function summary(request: Readonly<FunctionProcessRequest>, digest: string): string {
  return [
    "此命令以当前系统用户权限运行，可访问本机文件和网络。",
    "参数和环境变量的完整值可通过“查看完整请求”核对。",
    `参数：${preview(request.argv, 320)}`,
    `工作目录：${preview(request.cwd, 180)}`,
    `环境变量名：${preview(Object.keys(request.env), 120)}`,
    `超时：${request.timeoutMs === undefined ? "未设置" : request.timeoutMs + " 毫秒"}`,
    `标准输入：${Buffer.byteLength(request.input ?? "")} 字节`,
    `输入 SHA-256：${hash(request.input ?? "")}`,
    `完整请求 SHA-256：${digest}`,
    "查看请求不会批准执行；关闭查看窗口后，仍需在此选择。"
  ].join("\n")
}

/** Presentation only: the caller retains and executes its original frozen request. */
export async function confirmFunctionProcess(
  modId: string,
  request: Readonly<FunctionProcessRequest>,
  host: ProcessApprovalHost
): Promise<void> {
  const assertCurrent = () => {
    host.signal.throwIfAborted()
    host.assertCurrent()
  }
  assertCurrent()
  const serialized = JSON.stringify(request, null, 2)
  const digest = hash(serialized)
  let directory: string | undefined
  let file: string | undefined
  let directoryIdentity: string | undefined
  let fileIdentity: string | undefined
  let failed = false
  let failure: unknown
  const identity = (value: BigIntStats) => `${value.dev}:${value.ino}`
  const verify = async () => {
    assertCurrent()
    try {
      const parent = await lstat(directory!, { bigint: true })
      const before = await lstat(file!, { bigint: true })
      if (
        !parent.isDirectory() ||
        parent.isSymbolicLink() ||
        identity(parent) !== directoryIdentity ||
        !before.isFile() ||
        before.isSymbolicLink() ||
        identity(before) !== fileIdentity ||
        before.size !== BigInt(Buffer.byteLength(serialized))
      )
        throw Error("changed")
      const bytes = await readFile(file!)
      const after = await lstat(file!, { bigint: true })
      if (
        identity(after) !== fileIdentity ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        hash(bytes) !== digest ||
        hash(JSON.stringify(request, null, 2)) !== digest
      )
        throw Error("changed")
    } catch {
      throw new ModError("MODS_PROCESS_REVIEW_CHANGED")
    }
    assertCurrent()
  }
  try {
    try {
      const root = await realpath(host.tempRoot)
      directory = await mkdtemp(join(root, "cmb-process-review-"))
      directoryIdentity = identity(await lstat(directory, { bigint: true }))
      await chmod(directory, 0o700)
      file = join(directory, "request.json")
      await writeFile(file, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 })
      fileIdentity = identity(await lstat(file, { bigint: true }))
      await chmod(file, 0o400)
    } catch {
      throw new ModError("MODS_PROCESS_REVIEW_UNAVAILABLE")
    }
    for (;;) {
      await verify()
      const choice = await host.showDialog({
        signal: host.signal,
        type: "question",
        title: "批准插件运行本机命令",
        message: `插件 ${preview(modId, 80)} 请求运行 ${preview(request.argv[0], 100)}`,
        detail: summary(request, digest),
        buttons: ["拒绝", "允许本次命令", "查看完整请求"],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      assertCurrent()
      if (choice.response === 0) throw new ModError("MODS_PROCESS_DENIED")
      await verify()
      if (choice.response === 1) break
      if (choice.response !== 2) throw new ModError("MODS_PROCESS_DENIED")
      // Only this host-created JSON path reaches the OS-associated viewer.
      // No request text is passed as a command, and the file never feeds execution.
      let error: string
      try {
        error = await host.openPath(file!)
      } catch {
        throw new ModError("MODS_PROCESS_REVIEW_UNAVAILABLE")
      }
      assertCurrent()
      if (error) throw new ModError("MODS_PROCESS_REVIEW_UNAVAILABLE")
    }
  } catch (error) {
    failed = true
    failure = error
  }
  // Remove only our fixed file and empty directory; never recursively delete a path.
  if (directory) {
    try {
      const parent = await lstat(directory, { bigint: true })
      if (
        !parent.isDirectory() ||
        parent.isSymbolicLink() ||
        identity(parent) !== directoryIdentity
      )
        throw Error("changed")
      if (file) {
        const info = await lstat(file, { bigint: true }).catch(() => undefined)
        if (info) {
          if (!info.isSymbolicLink() && identity(info) === fileIdentity) await chmod(file, 0o600)
          await unlink(file)
        }
      }
      await rmdir(directory)
    } catch {
      if (!failed) throw new ModError("MODS_PROCESS_REVIEW_CLEANUP_FAILED")
    }
  }
  if (failed) throw failure
  assertCurrent()
}
