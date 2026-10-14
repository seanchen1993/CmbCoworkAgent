import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { serialize } from "node:v8"
import {
  parseProjectCapabilityManifest,
  PROJECT_CAPABILITY_MAX_BYTES,
  type ProjectCapabilityView
} from "../../shared/project-capability"
import { HARNESS_ADAPTER_DETAIL_MAX_IPC_BYTES } from "./adapter-detail-protocol"

export const PROJECT_CAPABILITY_FILE = "devclaw.project.json"

function diagnostic(message = "无法读取项目能力声明；原项目模式仍可使用"): ProjectCapabilityView {
  return { status: "invalid", message }
}

function checkCancelled(signal?: AbortSignal): void {
  signal?.throwIfAborted()
}

/** Reads only the fixed static declaration in the already resolved, bound plugin root. */
export async function readProjectCapability(
  pluginRoot: string | undefined,
  signal?: AbortSignal
): Promise<ProjectCapabilityView | undefined> {
  checkCancelled(signal)
  if (!pluginRoot) return undefined
  try {
    if (!isAbsolute(pluginRoot)) return diagnostic()
    const root = await realpath(pluginRoot)
    checkCancelled(signal)
    const path = join(root, PROJECT_CAPABILITY_FILE)
    const before = await lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null
      throw error
    })
    checkCancelled(signal)
    if (!before) return undefined
    if (!before.isFile() || before.isSymbolicLink()) return diagnostic()
    if ((await realpath(path)) !== resolve(path)) return diagnostic()
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      checkCancelled(signal)
      const initial = await handle.stat({ bigint: true })
      if (
        !initial.isFile() ||
        initial.dev !== before.dev ||
        initial.ino !== before.ino ||
        initial.size > BigInt(PROJECT_CAPABILITY_MAX_BYTES)
      )
        return diagnostic()
      const bytes = Buffer.alloc(Number(initial.size))
      let offset = 0
      while (offset < bytes.length) {
        checkCancelled(signal)
        const result = await handle.read(bytes, offset, bytes.length - offset, offset)
        if (!result.bytesRead) break
        offset += result.bytesRead
      }
      const final = await handle.stat({ bigint: true })
      const after = await lstat(path, { bigint: true })
      checkCancelled(signal)
      if (
        offset !== bytes.length ||
        !after.isFile() ||
        after.isSymbolicLink() ||
        final.dev !== initial.dev ||
        final.ino !== initial.ino ||
        final.size !== initial.size ||
        final.mtimeNs !== initial.mtimeNs ||
        final.ctimeNs !== initial.ctimeNs ||
        after.dev !== initial.dev ||
        after.ino !== initial.ino ||
        after.size !== final.size ||
        after.mtimeNs !== final.mtimeNs ||
        after.ctimeNs !== final.ctimeNs ||
        (await realpath(pluginRoot)) !== root ||
        (await realpath(path)) !== resolve(path)
      ) {
        return diagnostic()
      }
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
      checkCancelled(signal)
      return { status: "ready", manifest: parseProjectCapabilityManifest(value) }
    } finally {
      await handle.close()
    }
  } catch {
    checkCancelled(signal)
    return diagnostic()
  }
}

/** Optional guidance must never make an otherwise valid legacy detail exceed its IPC budget. */
export function attachProjectCapability<T extends { projectCapability?: ProjectCapabilityView }>(
  detail: T,
  capability: ProjectCapabilityView | undefined,
  maxBytes = HARNESS_ADAPTER_DETAIL_MAX_IPC_BYTES
): void {
  if (!capability) return
  detail.projectCapability = capability
  if (serialize(detail).byteLength <= maxBytes) return
  detail.projectCapability = diagnostic("项目能力说明超过详情传输限额，已省略；原详情仍可使用")
  if (serialize(detail).byteLength > maxBytes) delete detail.projectCapability
}
