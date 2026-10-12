import { lstat, opendir, realpath, rmdir, unlink } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { ComputerOwner } from "./computer-checkpoint-ports"

/** Stream one protocol-owned tree instead of retaining a large recursive rm
 * queue. The caller pins its root inode in a durable deletion receipt first.
 * At most 50k entries per attempt; a retry can finish an oversized raw safety
 * set without losing its persisted ownership proof. No links are followed. */
export async function removeComputerRecoveryTree(
  root: string,
  owner: ComputerOwner,
  signal: AbortSignal,
  progress: (entries: number) => void
) {
  const stamp = await lstat(root, { bigint: true })
  if (!stamp.isDirectory() || (await realpath(root)) !== resolve(root))
    throw new Error("原现场清理目录位置已变化")
  let entries = 0
  const visit = async (path: string, depth: number): Promise<void> => {
    signal.throwIfAborted()
    owner.assertCurrent()
    if (depth > 128 || entries >= 50_000)
      throw new Error("本次原现场清理已达到条目上限，请使用同一恢复现场重试")
    const info = await lstat(path, { bigint: true })
    if (info.dev !== stamp.dev) throw new Error("原现场清理拒绝跨文件系统访问")
    if (info.isDirectory() && !info.isSymbolicLink()) {
      if ((await realpath(path)) !== resolve(path)) throw new Error("原现场清理拒绝访问另一个目录")
      const directory = await opendir(path)
      for await (const child of directory) await visit(join(path, child.name), depth + 1)
      signal.throwIfAborted()
      owner.assertCurrent()
      if (entries >= 50_000) throw new Error("本次原现场清理已达到条目上限，请使用同一恢复现场重试")
      await rmdir(path)
    } else {
      signal.throwIfAborted()
      owner.assertCurrent()
      await unlink(path)
    }
    progress(++entries)
  }
  await visit(root, 0)
}
