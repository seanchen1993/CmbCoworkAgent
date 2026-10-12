import {
  windowsProvisioningTerminal,
  windowsProvisioningBinding
} from "./windows-provisioning-contract"
import { performance } from "node:perf_hooks"
import { lstat } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { readPrivateJson, writePrivateJson, syncDirectory } from "./backup-io"
import {
  ownedShellReceiptSchema,
  OWNED_SHELL_RECEIPT_BYTES,
  type OwnedShellReceipt
} from "./owned-shell-receipt-contract"
import {
  allocateLinuxBotCgroup,
  closeLinuxBotCgroup,
  assertLinuxBotCgroup,
  removeClosedLinuxBotCgroup,
  type LinuxBotResourceLimits,
  removeProvenClosedLinuxBotCgroup
} from "./linux-bot-cgroup"
import {
  nativeShellLifetimeRecord,
  nativeShellClosure,
  sameNativeOrigin,
  type NativeShellLifetimeRecord,
  type NativeShellClosure
} from "./native-shell-lifetime"

/** A strong provider's concrete operation slot. Control-plane caller supplies
 * the existing private receipt, held ownership guard and immutable helper SHA;
 * the model never selects a cgroup path or manufacture closure evidence. */
export async function prepareLinuxNativeShellResource(input: {
  directory: string
  origin: OwnedShellReceipt
  limits?: LinuxBotResourceLimits
  delegatedRoot: string
  helperSha256: string
  assertCurrent(signal: AbortSignal): Promise<void>
  signal: AbortSignal
}): Promise<{
  record: NativeShellLifetimeRecord
  assertCurrent(signal: AbortSignal): Promise<void>
  releaseClosed(): Promise<void>
}> {
  input.signal.throwIfAborted()
  await input.assertCurrent(input.signal)
  const origin = ownedShellReceiptSchema.parse(input.origin)
  if (origin.helperSha256 !== input.helperSha256)
    throw new Error("Linux provider differs from immutable owner artifact")
  const scope = await allocateLinuxBotCgroup(input.delegatedRoot, origin.nonce, input.limits)
  const record = nativeShellLifetimeRecord.parse({
    format: 1,
    origin,
    resource: { ...scope, providerSha256: input.helperSha256 }
  })
  let publicationStarted = false
  try {
    const assertCurrent = async (signal: AbortSignal) => {
      signal.throwIfAborted()
      await input.assertCurrent(signal)
      const pin = await lstat(input.directory, { bigint: true })
      if (
        pin.isSymbolicLink() ||
        !pin.isDirectory() ||
        String(pin.dev) !== origin.directory.dev ||
        String(pin.ino) !== origin.directory.ino
      )
        throw new Error("Linux resource operation slot changed")
      await assertLinuxBotCgroup(scope)
      signal.throwIfAborted()
    }
    await assertCurrent(input.signal)
    publicationStarted = true
    await writePrivateJson(join(input.directory, "native-resource.json"), record)
    await syncDirectory(input.directory)
    return {
      record,
      assertCurrent,
      releaseClosed: async () => {
        const proof = await readNativeShellResourceClosure(input.directory, origin)
        if (!proof || proof.scope !== "verified-linux-cgroup-v2")
          throw new Error("Linux physical closure is not proven")
        await removeProvenClosedLinuxBotCgroup(scope)
      }
    }
  } catch (error) {
    // No process has been started. If the slot write may already be durable,
    // retain its record and scope for held-lock cleanup instead of orphaning it.
    if (!publicationStarted) await removeClosedLinuxBotCgroup(scope).catch(() => {})
    throw error
  }
}
export async function readNativeShellResourceRecord(
  directory: string,
  origin: OwnedShellReceipt
): Promise<NativeShellLifetimeRecord | undefined> {
  let read
  try {
    read = await readPrivateJson(directory, "native-resource.json", OWNED_SHELL_RECEIPT_BYTES)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  const record = nativeShellLifetimeRecord.parse(read.value)
  if (!sameNativeOrigin(record, { ...record, origin: ownedShellReceiptSchema.parse(origin) }))
    throw new Error("Native resource origin differs from receipt")
  if (
    record.resource.providerSha256 !==
    (record.resource.kind === "verified-windows-atomic-job-v2"
      ? origin.nativeProviderSha256
      : origin.helperSha256)
  )
    throw new Error("Native provider differs from actual helper")
  const pin = await lstat(directory, { bigint: true })
  if (
    pin.isSymbolicLink() ||
    !pin.isDirectory() ||
    String(pin.dev) !== origin.directory.dev ||
    String(pin.ino) !== origin.directory.ino
  )
    throw new Error("Native operation slot was replaced")
  return record
}
export async function readNativeShellResourceClosure(
  directory: string,
  origin: OwnedShellReceipt
): Promise<NativeShellClosure | undefined> {
  const record = await readNativeShellResourceRecord(directory, origin)
  if (!record) return undefined
  let read
  try {
    read = await readPrivateJson(directory, "closure.json", OWNED_SHELL_RECEIPT_BYTES)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  // A weak format-1 group observation is never a strong format-2 proof.
  const proof = nativeShellClosure.parse(read.value)
  if (
    proof.neverLaunched &&
    (origin.runAuthorized || origin.helperPid !== undefined || origin.workerPid !== undefined)
  )
    throw new Error("Never-launched reservation was already started")
  if (!sameNativeOrigin(record, proof.record))
    throw new Error("Native kernel proof differs from actual operation")
  // Legacy Job flags remain diagnostic. Only the fixed atomic Job producer
  // and Linux kernel-backed provider may supply format-2 closure authority.
  if (
    proof.scope !== "verified-linux-cgroup-v2" &&
    proof.scope !== "verified-windows-atomic-job-v2"
  )
    return undefined
  if (
    record.resource.kind === "verified-windows-atomic-job-v2" &&
    record.resource.provisioning &&
    origin.runAuthorized &&
    !proof.neverLaunched
  ) {
    let terminal
    try {
      terminal = windowsProvisioningTerminal.parse(
        (await readPrivateJson(directory, "native-setup-terminal.json", 4096)).value
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
    if (
      terminal.nonce !== record.origin.nonce ||
      terminal.recordSha256 !== windowsProvisioningBinding(record) ||
      terminal.cliSha256 !== record.resource.provisioning.cliSha256
    )
      throw new Error("Windows provisioning terminal differs from owned scope")
  }
  return proof
}
export async function waitNativeShellResourceClosure(
  directory: string,
  origin: OwnedShellReceipt
): Promise<boolean> {
  const until = performance.now() + 10_000
  do {
    if (await readNativeShellResourceClosure(directory, origin)) {
      await syncDirectory(directory)
      return true
    }
    await delay(25)
  } while (performance.now() < until)
  return false
}

export async function releaseNativeShellResource(
  directory: string,
  origin: OwnedShellReceipt
): Promise<void> {
  const proof = await readNativeShellResourceClosure(directory, origin)
  if (!proof) throw new Error("Native physical resource has no durable closure proof")
  if (proof.record.resource.kind === "verified-windows-atomic-job-v2") return
  if (proof.record.resource.kind !== "verified-linux-cgroup-v2")
    throw new Error("Native cleanup platform is unavailable")
  await removeProvenClosedLinuxBotCgroup(proof.record.resource)
}

export type { NativeShellClosure } from "./native-shell-lifetime"

/** Only a still-unlaunched private receipt may use the held coordinator as the
 * outside witness. It closes the pinned kernel scope, not a saved numeric PID. */
export async function proveUnlaunchedLinuxNativeResource(
  directory: string,
  origin: OwnedShellReceipt
): Promise<void> {
  if (origin.runAuthorized || origin.helperPid !== undefined || origin.workerPid !== undefined)
    throw new Error("Native owner has already been launched")
  const record = await readNativeShellResourceRecord(directory, origin)
  if (!record || record.resource.kind !== "verified-linux-cgroup-v2")
    throw new Error("Unlaunched native resource record is unavailable")
  await closeLinuxBotCgroup(record.resource)
  const current = await readNativeShellResourceRecord(directory, origin)
  if (!current || !sameNativeOrigin(record, current))
    throw new Error("Native unlaunched resource changed")
  await writePrivateJson(
    join(directory, "closure.json"),
    nativeShellClosure.parse({ format: 2, scope: record.resource.kind, record, kernelEmpty: true })
  )
}
