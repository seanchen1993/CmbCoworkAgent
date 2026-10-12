import { observeOwnedShellParentEOF } from "./owned-shell-parent-lifetime"
import { lstat, realpath } from "node:fs/promises"
import { dirname, isAbsolute, join } from "node:path"
import { readPrivateJson, writePrivateJson, syncDirectory } from "./backup-io"
import { ownedShellReceiptSchema, OWNED_SHELL_RECEIPT_BYTES } from "./owned-shell-receipt-contract"
import { assertLinuxBotCgroup, closeLinuxBotCgroup } from "./linux-bot-cgroup"
import {
  nativeShellLifetimeRecord,
  nativeShellClosure,
  sameNativeOrigin
} from "./native-shell-lifetime"
/** Fresh immutable helper role. It is forked before owner self-entry, remains
 * outside the leaf, and is triggered by its authenticated live parent IPC EOF.
 * No normal command, model payload or saved PID reaches this entry. */
export async function runLinuxBotCgroupWitness(): Promise<void> {
  if (process.platform !== "linux" || !process.send)
    throw new Error("Linux native witness IPC is unavailable")
  const parent = observeOwnedShellParentEOF()
  const path = process.env.CMB_BOT_SHELL_RECEIPT_DIRECTORY,
    nonce = process.env.CMB_BOT_SHELL_CONTROL_NONCE
  if (!path || !isAbsolute(path) || (await realpath(path)) !== path)
    throw new Error("Invalid native resource directory")
  const root = dirname(path),
    rootPin = await lstat(root, { bigint: true }),
    slot = await lstat(path, { bigint: true })
  for (const pin of [rootPin, slot])
    if (
      !pin.isDirectory() ||
      pin.isSymbolicLink() ||
      (pin.mode & 0o077n) !== 0n ||
      (process.getuid && pin.uid !== BigInt(process.getuid()))
    )
      throw new Error("Native witness directory is not private")
  const record = nativeShellLifetimeRecord.parse(
    (await readPrivateJson(path, "native-resource.json", OWNED_SHELL_RECEIPT_BYTES)).value
  )
  if (
    record.origin.nonce !== nonce ||
    record.resource.kind !== "verified-linux-cgroup-v2" ||
    String(slot.dev) !== record.origin.directory.dev ||
    String(slot.ino) !== record.origin.directory.ino
  )
    throw new Error("Native witness scope differs from operation")
  const scope = record.resource
  await assertLinuxBotCgroup(scope)
  // A witness must not kill itself when it closes the leaf. Validate its own
  // actual namespace-relative cgroup path by membership, not by ppid/name.
  const own = await import("node:fs/promises").then((fs) =>
    fs.readFile("/proc/self/cgroup", "utf8")
  )
  if (own.length > 4096 || own.split("\n").some((line) => line.endsWith(`/cmb-bot-${scope.nonce}`)))
    throw new Error("Native witness is inside its controlled cgroup")
  parent.ready({ nativeWitnessReady: true })
  await parent.disconnected
  await closeLinuxBotCgroup(scope)
  const currentRoot = await lstat(root, { bigint: true }),
    currentSlot = await lstat(path, { bigint: true })
  if (
    currentRoot.isSymbolicLink() ||
    currentSlot.isSymbolicLink() ||
    currentRoot.dev !== rootPin.dev ||
    currentRoot.ino !== rootPin.ino ||
    currentSlot.dev !== slot.dev ||
    currentSlot.ino !== slot.ino
  )
    throw new Error("Native witness slot changed")
  const current = nativeShellLifetimeRecord.parse(
    (await readPrivateJson(path, "native-resource.json", OWNED_SHELL_RECEIPT_BYTES)).value
  )
  const owner = ownedShellReceiptSchema.parse(
    (await readPrivateJson(path, "owner.json", OWNED_SHELL_RECEIPT_BYTES)).value
  )
  if (!sameNativeOrigin(record, current) || !sameNativeOrigin(record, { ...record, origin: owner }))
    throw new Error("Native witness operation changed")
  await writePrivateJson(
    join(path, "closure.json"),
    nativeShellClosure.parse({ format: 2, scope: scope.kind, record: current, kernelEmpty: true })
  )
  await syncDirectory(path)
}
