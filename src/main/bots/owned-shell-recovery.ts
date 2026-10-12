import { lstat, realpath, readdir, unlink, rmdir, rm } from "node:fs/promises"
import { basename, isAbsolute, join } from "node:path"
import { hasOwnedShellPhysicalClosure } from "./owned-shell-receipt-contract"
import { inspectOwnedShellReceiptEntries, OwnedShellReceiptSlot } from "./owned-shell-receipts"
import {
  BOT_OWNED_SHELL_RESOURCE_DIRECTORY,
  assertBotOwnedShellMaintenanceOwner,
  type OwnedShellMaintenanceOwner
} from "./owned-shell-maintenance-fence"

/** Cleanup only of durable confirmed closure, after the normal startup fence.
 * Never signals a PID, executes a command, clears unknowns or restores a DB. */
export async function recoverClosedBotShellResources(
  directory: string,
  owner: OwnedShellMaintenanceOwner
): Promise<void> {
  const root = join(directory, BOT_OWNED_SHELL_RESOURCE_DIRECTORY)
  await assertBotOwnedShellMaintenanceOwner(directory, owner)
  let entries
  try {
    entries = await inspectOwnedShellReceiptEntries(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  for (const entry of entries) {
    if (!hasOwnedShellPhysicalClosure(entry.value)) continue
    await assertBotOwnedShellMaintenanceOwner(directory, owner)
    const slot = await OwnedShellReceiptSlot.reopenClosed(root, entry.slot)
    for (const [kind, pin] of [
      ["scratch", entry.value.scratch],
      ["endpoint", entry.value.endpoint]
    ] as const) {
      if (!pin) continue
      if (
        !isAbsolute(pin.path) ||
        (await realpath(pin.path).catch((error) => {
          if (error.code === "ENOENT") return pin.path
          throw error
        })) !== pin.path ||
        !(
          kind === "scratch"
            ? /^cmb-bot-command-[a-zA-Z0-9]{6}$/
            : /^cmb-bot-channel-[a-zA-Z0-9]{6}$/
        ).test(basename(pin.path))
      )
        throw new Error("Bot 命令清理目录身份无效")
      const current = await lstat(pin.path, { bigint: true }).catch((error) => {
        if (error.code === "ENOENT") return null
        throw error
      })
      if (!current) continue
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        String(current.dev) !== pin.dev ||
        String(current.ino) !== pin.ino ||
        (process.getuid && current.uid !== BigInt(process.getuid())) ||
        (process.platform !== "win32" && (current.mode & 0o077n) !== 0n)
      )
        throw new Error("Bot 命令清理目录已被替换")
      await assertBotOwnedShellMaintenanceOwner(directory, owner)
      if (kind === "scratch") await rm(pin.path, { recursive: true, force: false })
      else {
        const names = await readdir(pin.path)
        if (names.some((name) => name !== "control.sock"))
          throw new Error("Bot 命令通道目录包含未知文件")
        for (const name of names) {
          const file = join(pin.path, name),
            stat = await lstat(file)
          if (stat.isSymbolicLink() || !stat.isSocket()) throw new Error("Bot 命令通道文件身份无效")
          await unlink(file)
        }
        await rmdir(pin.path)
      }
    }
    await assertBotOwnedShellMaintenanceOwner(directory, owner)
    await slot.settle(true)
  }
}
