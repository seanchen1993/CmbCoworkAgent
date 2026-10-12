import { observeOwnedShellParentEOF } from "./owned-shell-parent-lifetime"
import { readNativeShellResourceClosure, type NativeShellClosure } from "./linux-native-resource"
import { z } from "zod"
import { lstat, realpath } from "node:fs/promises"
import { dirname, join, isAbsolute } from "node:path"
import { readPrivateJson, writePrivateJson, syncDirectory } from "./backup-io"
import {
  ownedShellReceiptSchema,
  OWNED_SHELL_RECEIPT_BYTES,
  type OwnedShellReceipt
} from "./owned-shell-receipt-contract"
import { setTimeout as delay } from "node:timers/promises"

const pid = z.number().int().positive().max(0x7fffffff)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const ownedShellClosureSchema = z
  .object({
    format: z.literal(1),
    nonce: z.string().uuid(),
    hostId: z.string().min(1).max(512),
    dataEpoch: z.string().min(1).max(512),
    policySha256: hash,
    runId: z.string().min(1).max(512),
    helperSha256: hash,
    workerSha256: hash,
    scratch: ownedShellReceiptSchema.shape.scratch,
    endpoint: ownedShellReceiptSchema.shape.endpoint,
    directory: z
      .object({ dev: z.string().regex(/^[0-9]+$/), ino: z.string().regex(/^[0-9]+$/) })
      .strict(),
    helperPid: pid,
    workerPid: pid.optional(),
    scope: z.literal("controlled-inherited-group")
  })
  .strict()
export type OwnedShellClosure = z.infer<typeof ownedShellClosureSchema>
function sameBase(value: OwnedShellClosure, receipt: OwnedShellReceipt): boolean {
  return (
    ["nonce", "hostId", "dataEpoch", "policySha256", "runId", "helperSha256", "workerSha256"].every(
      (key) => value[key as keyof OwnedShellClosure] === receipt[key as keyof OwnedShellReceipt]
    ) &&
    value.directory.dev === receipt.directory.dev &&
    value.directory.ino === receipt.directory.ino &&
    JSON.stringify(value.scratch) === JSON.stringify(receipt.scratch) &&
    JSON.stringify(value.endpoint) === JSON.stringify(receipt.endpoint) &&
    (receipt.helperPid === undefined || receipt.helperPid === value.helperPid) &&
    (receipt.workerPid === undefined || receipt.workerPid === value.workerPid)
  )
}
export async function readOwnedShellClosure(
  directory: string,
  receipt: OwnedShellReceipt
): Promise<OwnedShellClosure | NativeShellClosure | undefined> {
  let read
  try {
    read = await readPrivateJson(directory, "closure.json", OWNED_SHELL_RECEIPT_BYTES)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  if (
    typeof read.value === "object" &&
    read.value !== null &&
    "format" in read.value &&
    read.value.format === 2
  )
    return readNativeShellResourceClosure(directory, receipt)
  if (
    receipt.containment === "verified-linux-cgroup-v2" ||
    receipt.containment === "verified-windows-atomic-job-v2"
  )
    throw new Error("Linux resource requires a strong kernel closure proof")
  const proof = ownedShellClosureSchema.parse(read.value)
  if (!sameBase(proof, receipt)) throw new Error("Owned shell closure identity changed")
  const stat = await lstat(directory, { bigint: true })
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    String(stat.dev) !== receipt.directory.dev ||
    String(stat.ino) !== receipt.directory.ino
  )
    throw new Error("Owned shell closure directory changed")
  return proof
}
export async function waitOwnedShellGroupClosure(
  directory: string,
  receipt: OwnedShellReceipt
): Promise<boolean> {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await readOwnedShellClosure(directory, receipt)) {
      await syncDirectory(directory)
      return true
    }
    await delay(25)
  }
  return false
}
/** This sidecar proves only that the controlled inherited group disappeared.
 * It is diagnostic evidence, never physical closure of all task descendants.
 * Trusted observer only. This process is outside the controlled task group;
 * it never signals a recorded PID and never starts/replays a command. An actual
 * IPC parent disconnect triggers a bounded existence probe and one proof write. */
export async function runOwnedShellClosureWitness(): Promise<void> {
  if (process.platform === "win32" || !process.send)
    throw new Error("POSIX closure witness IPC is unavailable")
  const parent = observeOwnedShellParentEOF(),
    helperPid = process.ppid
  const directory = process.env.CMB_BOT_SHELL_RECEIPT_DIRECTORY,
    nonce = process.env.CMB_BOT_SHELL_CONTROL_NONCE
  if (!directory || !isAbsolute(directory) || (await realpath(directory)) !== directory)
    throw new Error("Invalid closure witness path")
  const root = dirname(directory),
    rootPin = await lstat(root, { bigint: true }),
    slot = await lstat(directory, { bigint: true })
  if (
    rootPin.isSymbolicLink() ||
    !rootPin.isDirectory() ||
    slot.isSymbolicLink() ||
    !slot.isDirectory() ||
    (process.getuid &&
      (rootPin.uid !== BigInt(process.getuid()) || slot.uid !== BigInt(process.getuid()))) ||
    (rootPin.mode & 0o077n) !== 0n ||
    (slot.mode & 0o077n) !== 0n
  )
    throw new Error("Closure witness root is unsafe")
  const receipt = ownedShellReceiptSchema.parse(
    (await readPrivateJson(directory, "owner.json", OWNED_SHELL_RECEIPT_BYTES)).value
  )
  if (
    receipt.nonce !== nonce ||
    String(slot.dev) !== receipt.directory.dev ||
    String(slot.ino) !== receipt.directory.ino
  )
    throw new Error("Closure witness identity changed")
  let workerPid: number | undefined,
    finished = false
  process.on("message", (raw: unknown) => {
    try {
      const value = z.object({ workerPid: pid }).strict().parse(raw)
      if (workerPid !== undefined) throw new Error("Duplicate witness worker")
      workerPid = value.workerPid
      process.send!({ witnessWorkerReady: true }, (error) => {
        if (error) {
          process.exitCode = 1
          process.disconnect?.()
        }
      })
    } catch {
      process.exitCode = 1
      process.disconnect?.()
    }
  })
  parent.ready({ witnessReady: true })
  await parent.disconnected
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      process.kill(-helperPid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        finished = true
        break
      }
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error
    }
    await delay(25)
  }
  if (!finished) return // unknown is retained; no old PID kill or cleanup
  const proof = ownedShellClosureSchema.parse({
    format: 1,
    nonce: receipt.nonce,
    hostId: receipt.hostId,
    dataEpoch: receipt.dataEpoch,
    policySha256: receipt.policySha256,
    runId: receipt.runId,
    helperSha256: receipt.helperSha256,
    workerSha256: receipt.workerSha256,
    directory: receipt.directory,
    ...(receipt.scratch ? { scratch: receipt.scratch } : {}),
    ...(receipt.endpoint ? { endpoint: receipt.endpoint } : {}),
    helperPid,
    ...(workerPid !== undefined ? { workerPid } : {}),
    scope: "controlled-inherited-group"
  })
  try {
    const currentRoot = await lstat(root, { bigint: true }),
      currentSlot = await lstat(directory, { bigint: true })
    if (
      currentRoot.dev !== rootPin.dev ||
      currentRoot.ino !== rootPin.ino ||
      currentSlot.dev !== slot.dev ||
      currentSlot.ino !== slot.ino ||
      currentRoot.isSymbolicLink() ||
      currentSlot.isSymbolicLink()
    )
      throw new Error("Closure witness slot was replaced")
    const current = ownedShellReceiptSchema.parse(
      (await readPrivateJson(directory, "owner.json", OWNED_SHELL_RECEIPT_BYTES)).value
    )
    if (!sameBase(proof, current)) throw new Error("Closure witness operation changed")
    await writePrivateJson(join(directory, "closure.json"), proof)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}
