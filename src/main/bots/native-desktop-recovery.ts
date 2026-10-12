import { lstat, realpath, readdir, rm, rmdir, unlink } from "node:fs/promises"
import { basename, isAbsolute, join, resolve } from "node:path"
import { syncDirectory } from "./backup-io"
import {
  inspectNativeDesktopMaintenance,
  readNativeDesktopMaintenanceSlot,
  type NativeDesktopMaintenanceSlot
} from "./native-desktop-maintenance"
import {
  assertBotOwnedShellMaintenanceOwner,
  type OwnedShellMaintenanceOwner
} from "./owned-shell-maintenance-fence"

/** Reclaim only the native producer's exact durable kernel-empty record under
 * the existing Host lifetime lock. Unknown resources keep every original byte. */
export async function recoverClosedNativeDesktopResources(
  directory: string,
  owner: OwnedShellMaintenanceOwner
): Promise<void> {
  await assertBotOwnedShellMaintenanceOwner(directory, owner)
  const inventory = await inspectNativeDesktopMaintenance(directory)
  if (!inventory) return
  const assertDirectoryCurrent = async (entry: NativeDesktopMaintenanceSlot) => {
    await assertBotOwnedShellMaintenanceOwner(directory, owner)
    const root = await lstat(inventory.root.path, { bigint: true })
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      String(root.dev) !== inventory.root.dev ||
      String(root.ino) !== inventory.root.ino ||
      (await realpath(inventory.root.path)) !== inventory.root.path
    )
      throw new Error("Native resource root changed during recovery")
    const slot = await lstat(entry.record.directory.path, { bigint: true })
    if (
      !slot.isDirectory() ||
      slot.isSymbolicLink() ||
      String(slot.dev) !== entry.record.directory.dev ||
      String(slot.ino) !== entry.record.directory.ino ||
      (await realpath(entry.record.directory.path)) !== entry.record.directory.path
    )
      throw new Error("Native resource slot changed during recovery")
    await assertBotOwnedShellMaintenanceOwner(directory, owner)
  }
  const assertCurrent = async (entry: NativeDesktopMaintenanceSlot) => {
    await assertDirectoryCurrent(entry)
    const current = await readNativeDesktopMaintenanceSlot(entry.record.directory.path)
    if (
      current.recordSha256 !== entry.recordSha256 ||
      current.closureSha256 !== entry.closureSha256 ||
      !current.closureSha256
    )
      throw new Error("Native resource evidence changed during recovery")
    await assertBotOwnedShellMaintenanceOwner(directory, owner)
  }
  for (const entry of inventory.entries) {
    const scratch = entry.record.scratchDirectory
    // Early-format records have no recoverable scratch pin. Do not guess a
    // temp path or discard the only resource record that could identify it.
    if (!entry.closureSha256 || !scratch) continue
    await assertCurrent(entry)
    const slot = entry.record.directory.path
    const names = await readdir(slot)
    const allowed = new Set(["desktop-resource.json", "closure.json", "read-sentinel.json"])
    if (names.some((name) => !allowed.has(name)))
      throw new Error("Native resource slot contains an unknown file")
    for (const name of names) {
      const file = await lstat(join(slot, name), { bigint: true })
      if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1n)
        throw new Error("Native resource evidence file was replaced")
    }
    if (
      !isAbsolute(scratch.path) ||
      resolve(scratch.path) !== scratch.path ||
      !/^cmb-bot-desktop-[A-Za-z0-9]{6}$/.test(basename(scratch.path))
    )
      throw new Error("Native resource scratch path is invalid")
    const scratchStat = await lstat(scratch.path, { bigint: true }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    })
    if (scratchStat) {
      if (
        !scratchStat.isDirectory() ||
        scratchStat.isSymbolicLink() ||
        String(scratchStat.dev) !== scratch.dev ||
        String(scratchStat.ino) !== scratch.ino ||
        (await realpath(scratch.path)) !== scratch.path ||
        (process.getuid && scratchStat.uid !== BigInt(process.getuid())) ||
        (process.platform !== "win32" && (scratchStat.mode & 0o077n) !== 0n)
      )
        throw new Error("Native resource scratch directory was replaced")
      await assertCurrent(entry)
      const final = await lstat(scratch.path, { bigint: true })
      if (
        !final.isDirectory() ||
        final.isSymbolicLink() ||
        String(final.dev) !== scratch.dev ||
        String(final.ino) !== scratch.ino ||
        (await realpath(scratch.path)) !== scratch.path
      )
        throw new Error("Native scratch changed before cleanup")
      await rm(scratch.path, { recursive: true, force: false })
    }
    // Scratch may already be gone after a crash in the previous cleanup. The
    // matching retained proof still authorizes only this exact physical slot.
    await assertCurrent(entry)
    for (const name of names) {
      await assertDirectoryCurrent(entry)
      await unlink(join(slot, name))
    }
    await assertDirectoryCurrent(entry)
    await rmdir(slot)
    await syncDirectory(inventory.root.path)
  }
  await assertBotOwnedShellMaintenanceOwner(directory, owner)
}
