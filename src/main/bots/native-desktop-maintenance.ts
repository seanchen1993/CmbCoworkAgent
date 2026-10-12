import { lstat, opendir, realpath } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { BotDomainError } from "../../shared/bot-types"
import { readPrivateJson } from "./backup-io"
import {
  nativeDesktopResourceRecord,
  nativeDesktopResourceClosure,
  sameNativeDesktopResource,
  type NativeDesktopResourceRecord
} from "./native-desktop-resource"

/** Physical GUI evidence stays outside all DB/workspace snapshots. A free Host
 * lock, process exit or missing stream does not attest that its Job is empty. */
export const BOT_NATIVE_DESKTOP_RESOURCE_DIRECTORY = "native-desktop-resources"
export interface NativeDesktopMaintenanceSlot {
  record: NativeDesktopResourceRecord
  recordSha256: string
  closureSha256?: string
}
export interface NativeDesktopMaintenanceEntries {
  root: { path: string; dev: string; ino: string }
  entries: NativeDesktopMaintenanceSlot[]
}

async function privateDirectory(path: string) {
  const pin = await lstat(path, { bigint: true })
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    !pin.isDirectory() ||
    pin.isSymbolicLink() ||
    (await realpath(path)) !== path ||
    (process.getuid && pin.uid !== BigInt(process.getuid())) ||
    (process.platform !== "win32" && (pin.mode & 0o077n) !== 0n)
  )
    throw new Error("Native resource directory is not canonical and private")
  return { path, dev: String(pin.dev), ino: String(pin.ino) }
}

/** Read the same pinned record and native-producer closure for both inspection
 * and held-lock cleanup. Missing closure preserves an unconfirmed resource. */
export async function readNativeDesktopMaintenanceSlot(
  slot: string
): Promise<NativeDesktopMaintenanceSlot> {
  const pin = await privateDirectory(slot)
  const file = await readPrivateJson(slot, "desktop-resource.json", 32 * 1024)
  const record = nativeDesktopResourceRecord.parse(file.value)
  if (
    record.directory.path !== slot ||
    record.directory.dev !== pin.dev ||
    record.directory.ino !== pin.ino
  )
    throw new Error("Native resource slot differs")
  let closureSha256: string | undefined
  try {
    const file = await readPrivateJson(slot, "closure.json", 32 * 1024)
    const closure = nativeDesktopResourceClosure.parse(file.value)
    if (!sameNativeDesktopResource(record, closure.record))
      throw new Error("Native closure differs from original resource")
    closureSha256 = file.sha256
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const after = await privateDirectory(slot)
  if (pin.dev !== after.dev || pin.ino !== after.ino)
    throw new Error("Native resource slot changed during inspection")
  return { record, recordSha256: file.sha256, ...(closureSha256 ? { closureSha256 } : {}) }
}

/** Bounded read-only inventory; this cannot terminate a Job or authorize replay. */
export async function inspectNativeDesktopMaintenance(
  directory: string
): Promise<NativeDesktopMaintenanceEntries | undefined> {
  const root = join(directory, BOT_NATIVE_DESKTOP_RESOURCE_DIRECTORY)
  let pin: Awaited<ReturnType<typeof privateDirectory>>
  try {
    pin = await privateDirectory(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  const reader = await opendir(root, { bufferSize: 16 })
  const entries: NativeDesktopMaintenanceSlot[] = []
  let count = 0
  for await (const entry of reader) {
    if (++count > 1024 || !entry.isDirectory() || !/^desktop-[A-Za-z0-9]{6}$/.test(entry.name))
      throw new Error("Native resource inventory is invalid or exceeds its bound")
    entries.push(await readNativeDesktopMaintenanceSlot(join(root, entry.name)))
  }
  const after = await privateDirectory(root)
  if (pin.dev !== after.dev || pin.ino !== after.ino)
    throw new Error("Native resource directory changed during inspection")
  return { root: pin, entries }
}

export async function assertNativeDesktopMaintenance(directory: string): Promise<void> {
  try {
    const inventory = await inspectNativeDesktopMaintenance(directory)
    if (inventory?.entries.some((entry) => !entry.closureSha256))
      throw new Error("Native physical closure is unproven")
  } catch (error) {
    const failure = new BotDomainError(
      "native_resource_requires_review",
      "有原生电脑尚未确认关闭，已暂停替换数据和工作文件；请保留现场并核对后台资源"
    )
    failure.cause = error
    throw failure
  }
}
