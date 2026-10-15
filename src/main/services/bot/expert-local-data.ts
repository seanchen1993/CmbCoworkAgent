import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import * as fs from "node:fs/promises"
import { join } from "node:path"
import type { ExpertMemoryList } from "../../../shared/bot/expert-memory"
import type { PartnerConnectionDescriptor } from "./partner-local-client"
import { PartnerLocalFault, partnerId } from "./partner-local-boundary"
import { parseExpertMemoryList } from "./expert-memory-validation"

export interface ExpertLocalData {
  path: string
  runtimePath: string
  sync(memories: ExpertMemoryList): Promise<void>
}
const key = (value: string) => createHash("sha256").update(value).digest("hex")
async function directory(path: string, recursive = false): Promise<void> {
  try {
    await fs.mkdir(path, { mode: 0o700, recursive })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  const s = await fs.lstat(path)
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    (process.platform !== "win32" && (s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o700))
  )
    throw Error("private directory required")
}
async function replace(path: string, name: string, value: unknown): Promise<void> {
  await directory(path)
  const parent = await fs.lstat(path),
    destination = join(path, name)
  const validateDestination = async () => {
    try {
      const s = await fs.lstat(destination)
      if (
        !s.isFile() ||
        s.isSymbolicLink() ||
        s.nlink !== 1 ||
        (process.platform !== "win32" &&
          (s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o600))
      )
        throw Error("private file required")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  await validateDestination()
  const temporary = join(path, `.${name}.${randomUUID()}.tmp`)
  const handle = await fs.open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  )
  try {
    const bytes = JSON.stringify(value) + "\n"
    if (Buffer.byteLength(bytes) > 524288) throw Error("cache bound")
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    await directory(path)
    const current = await fs.lstat(path)
    if (current.ino !== parent.ino || current.dev !== parent.dev) throw Error("directory changed")
    await validateDestination()
    await fs.rename(temporary, destination)
  } finally {
    await handle.close().catch(() => undefined)
    await fs.unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error
    })
  }
}
/** Rebuildable maintenance cache only. Never read by the executor or used to
 * authorize offline access. Namespace comes from trusted main configuration. */
export async function expertLocalData(
  root: string,
  namespace: string,
  descriptor: PartnerConnectionDescriptor,
  botId: string
): Promise<ExpertLocalData> {
  try {
    partnerId(botId)
    await fs.mkdir(root, { mode: 0o700, recursive: true })
    const base = await fs.lstat(root)
    // Existing application root may be 0755; do not chmod unrelated App data.
    // Every new Partner descendant is private 0700.
    if (
      !base.isDirectory() ||
      base.isSymbolicLink() ||
      (process.platform !== "win32" &&
        (base.uid !== process.getuid?.() || (base.mode & 0o022) !== 0))
    )
      throw Error("unsafe application root")
    let path = root
    const chain: Array<{ path: string; ino: number; dev: number }> = []
    for (const part of [
      "partner",
      key(namespace),
      key(`${descriptor.spaceId}\0${descriptor.ownerPrincipalId}`),
      "experts",
      key(botId)
    ]) {
      path = join(path, part)
      await directory(path)
      const s = await fs.lstat(path)
      chain.push({ path, ino: s.ino, dev: s.dev })
    }
    const runtimePath = join(path, "runtime")
    await directory(runtimePath)
    const metadata = {
      schemaVersion: 1,
      namespace: key(namespace),
      spaceId: descriptor.spaceId,
      principalId: descriptor.ownerPrincipalId,
      botId
    }
    await replace(path, "metadata.json", metadata)
    let syncedRevision: number | undefined
    return {
      path,
      runtimePath,
      async sync(memories) {
        try {
          parseExpertMemoryList(memories, descriptor.spaceId, botId)
          for (const item of chain) {
            await directory(item.path)
            const s = await fs.lstat(item.path)
            if (s.ino !== item.ino || s.dev !== item.dev) throw Error("cache ancestry changed")
          }
          if (syncedRevision === memories.revision) return
          await replace(path, "memory-cache.json", {
            ...metadata,
            syncedAt: new Date().toISOString(),
            revision: memories.revision,
            memories: memories.memories
          })
          syncedRevision = memories.revision
        } catch {
          throw new PartnerLocalFault("STORAGE_FAILURE")
        }
      }
    }
  } catch {
    throw new PartnerLocalFault("STORAGE_FAILURE")
  }
}
