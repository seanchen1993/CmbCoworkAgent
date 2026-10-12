import {
  readNativeShellResourceClosure,
  readNativeShellResourceRecord,
  releaseNativeShellResource
} from "./linux-native-resource"
import { isOwnedShellStrongContainment } from "./owned-shell-receipt-contract"
import { readOwnedShellClosure } from "./owned-shell-closure"
import { lstat, mkdir, readdir, unlink, rmdir, realpath } from "node:fs/promises"
import { join, isAbsolute, resolve } from "node:path"
import { writePrivateJson, readPrivateJson, syncDirectory } from "./backup-io"

import {
  ownedShellReceiptSchema,
  hasOwnedShellPhysicalClosure,
  OWNED_SHELL_MAX_UNCONFIRMED,
  OWNED_SHELL_RECEIPT_BYTES,
  type OwnedShellReceipt
} from "./owned-shell-receipt-contract"
export {
  ownedShellReceiptSchema,
  OWNED_SHELL_MAX_UNCONFIRMED,
  OWNED_SHELL_RECEIPT_BYTES,
  type OwnedShellReceipt,
  type OwnedShellOrigin
} from "./owned-shell-receipt-contract"

/** Private bounded lifetime records; they never authorize replay or signalling
 * an old/reused PID. An interrupted Host leaves at most 64 slots (<2MiB JSON).
 * Confirmed closure removes the slot; unproven closure is preserved for review. */
export class OwnedShellReceiptSlot {
  private tail: Promise<void> = Promise.resolve()
  private terminal = false
  private constructor(
    readonly directory: string,
    private value: OwnedShellReceipt,
    private readonly rootIdentity: { dev: bigint; ino: bigint },
    private readonly root: string
  ) {}
  static async allocate(
    root: string,
    input: Omit<
      OwnedShellReceipt,
      "directory" | "format" | "phase" | "runAuthorized" | "helperPid" | "workerPid"
    >
  ): Promise<OwnedShellReceiptSlot> {
    const rootStat = await lstat(root, { bigint: true })
    if (
      !isAbsolute(root) ||
      resolve(root) !== root ||
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      (await realpath(root)) !== root ||
      (process.getuid && rootStat.uid !== BigInt(process.getuid())) ||
      (process.platform !== "win32" && (rootStat.mode & 0o077n) !== 0n)
    )
      throw new Error("Owned shell receipt root is not canonical and private")
    // Reject malformed origin before consuming a bounded slot.
    ownedShellReceiptSchema.parse({
      ...input,
      format: 1,
      phase: "allocated",
      runAuthorized: false,
      directory: { dev: "0", ino: "0" }
    })
    for (let slot = 0; slot < OWNED_SHELL_MAX_UNCONFIRMED; slot++) {
      const directory = join(root, `operation-${slot}`)
      try {
        await mkdir(directory, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue
        throw error
      }
      const stat = await lstat(directory, { bigint: true })
      const value = ownedShellReceiptSchema.parse({
        ...input,
        format: 1,
        phase: "allocated",
        runAuthorized: false,
        directory: { dev: String(stat.dev), ino: String(stat.ino) }
      })
      const result = new OwnedShellReceiptSlot(directory, value, rootStat, root)
      // writePrivateJson may have renamed before fsync failed. Preserve any
      // committed private record; failed allocation never starts a worker.
      await result.write(value)
      await syncDirectory(root)
      return result
    }
    throw new Error("有 64 个命令现场尚未确认结束，请先核对后再启动新的命令")
  }
  private async assertDirectory(): Promise<void> {
    const root = await lstat(this.root, { bigint: true }),
      current = await lstat(this.directory, { bigint: true })
    if (
      root.isSymbolicLink() ||
      root.dev !== this.rootIdentity.dev ||
      root.ino !== this.rootIdentity.ino ||
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      String(current.dev) !== this.value.directory.dev ||
      String(current.ino) !== this.value.directory.ino
    )
      throw new Error("Owned shell receipt directory was replaced")
  }
  private async write(value: OwnedShellReceipt): Promise<void> {
    await this.assertDirectory()
    if (Buffer.byteLength(JSON.stringify(value)) > OWNED_SHELL_RECEIPT_BYTES)
      throw new Error("Owned shell receipt exceeds its limit")
    await writePrivateJson(join(this.directory, "owner.json"), value)
    this.value = value
  }
  private serial(action: () => Promise<void>): Promise<void> {
    const next = this.tail.then(action)
    this.tail = next.catch(() => {})
    return next
  }
  ready(helperPid: number, workerPid: number): Promise<void> {
    return this.serial(async () => {
      if (this.terminal || this.value.phase !== "allocated")
        throw new Error("Owned shell readiness is no longer current")
      await this.write(
        ownedShellReceiptSchema.parse({
          ...this.value,
          phase: "worker-ready",
          helperPid,
          workerPid
        })
      )
    })
  }
  authorizeRun(): Promise<void> {
    return this.serial(async () => {
      if (this.terminal || this.value.phase !== "worker-ready")
        throw new Error("Owned shell run is no longer current")
      await this.write(
        ownedShellReceiptSchema.parse({
          ...this.value,
          phase: "run-authorized",
          runAuthorized: true
        })
      )
    })
  }
  static async reopenClosed(root: string, slot: number): Promise<OwnedShellReceiptSlot> {
    // Reopen only held-lock cleanup authority; no entry/PID is a new execution.
    if (!Number.isInteger(slot) || slot < 0 || slot >= OWNED_SHELL_MAX_UNCONFIRMED)
      throw new Error("Invalid cleanup slot")
    const rootPin = await lstat(root, { bigint: true })
    if (
      !isAbsolute(root) ||
      resolve(root) !== root ||
      !rootPin.isDirectory() ||
      rootPin.isSymbolicLink() ||
      (await realpath(root)) !== root ||
      (process.getuid && rootPin.uid !== BigInt(process.getuid())) ||
      (process.platform !== "win32" && (rootPin.mode & 0o077n) !== 0n)
    )
      throw new Error("Unsafe cleanup root")
    const directory = join(root, `operation-${slot}`),
      value = ownedShellReceiptSchema.parse(
        (await readPrivateJson(directory, "owner.json", OWNED_SHELL_RECEIPT_BYTES)).value
      )
    const closure = await readOwnedShellClosure(directory, value)
    if (
      !hasOwnedShellPhysicalClosure(value) &&
      (!closure || (value.runAuthorized && !isOwnedShellStrongContainment(closure.scope)))
    )
      throw new Error("Command physical closure has not been proven")
    if (
      isOwnedShellStrongContainment(value.containment) &&
      !(await readNativeShellResourceClosure(directory, value))
    )
      throw new Error("Native resource physical closure is unproven")
    const result = new OwnedShellReceiptSlot(directory, value, rootPin, root)
    await result.closed()
    return result
  }
  async waitControlledGroupClosure(): Promise<boolean> {
    const { waitOwnedShellGroupClosure } = await import("./owned-shell-closure")
    return waitOwnedShellGroupClosure(this.directory, this.value)
  }
  snapshot(): OwnedShellReceipt {
    return ownedShellReceiptSchema.parse(this.value)
  }
  closed(): Promise<void> {
    return this.serial(async () => {
      if (this.terminal) throw new Error("Owned shell resource is no longer current")
      if (
        isOwnedShellStrongContainment(this.value.containment) &&
        !(await readNativeShellResourceClosure(this.directory, this.value))
      )
        throw new Error("Native resource physical closure is unproven")
      if (this.value.runAuthorized && !isOwnedShellStrongContainment(this.value.containment))
        throw new Error("Controlled process-group closure is not physical cleanup authority")
      await this.write(ownedShellReceiptSchema.parse({ ...this.value, phase: "resource-closed" }))
    })
  }
  settle(knownClosed: boolean): Promise<void> {
    this.terminal = true
    return this.serial(async () => {
      await this.assertDirectory()
      const disk = ownedShellReceiptSchema.parse(
        (await readPrivateJson(this.directory, "owner.json", OWNED_SHELL_RECEIPT_BYTES)).value
      )
      if (JSON.stringify(disk) !== JSON.stringify(this.value))
        throw new Error("Owned shell receipt was changed")
      // Callers cannot turn group drain into a physical proof by passing true.
      knownClosed &&=
        !this.value.runAuthorized || isOwnedShellStrongContainment(this.value.containment)
      if (knownClosed && isOwnedShellStrongContainment(this.value.containment)) {
        const proof = await readNativeShellResourceClosure(this.directory, this.value)
        knownClosed = !!proof
        if (knownClosed && proof) await releaseNativeShellResource(this.directory, this.value)
      }
      if (!knownClosed) {
        await this.write({ ...this.value, phase: "closure-unproven" })
        return
      }
      // Exact owned files only. Unknown paths/symlinks are not cleanup authority.
      const names = await readdir(this.directory)
      if (
        names.some(
          (name) =>
            name !== "owner.json" &&
            name !== "control.sock" &&
            name !== "closure.json" &&
            name !== "native-resource.json" &&
            name !== "native-setup-authorized.json" &&
            name !== "native-setup-terminal.json"
        )
      )
        throw new Error("Owned shell control directory contains an unknown file")
      if (names.includes("native-resource.json"))
        await readNativeShellResourceRecord(this.directory, this.value)
      if (names.includes("closure.json")) await readOwnedShellClosure(this.directory, this.value)
      if (names.some((name) => name.startsWith("native-setup-"))) {
        const record = await readNativeShellResourceRecord(this.directory, this.value)
        if (
          !record ||
          record.resource.kind !== "verified-windows-atomic-job-v2" ||
          !record.resource.provisioning
        )
          throw new Error("Windows setup evidence has no owned provisioning record")
        const {
          windowsProvisioningAuthorization,
          windowsProvisioningTerminal,
          windowsProvisioningBinding
        } = await import("./windows-provisioning-contract")
        for (const name of names.filter((name) => name.startsWith("native-setup-"))) {
          const raw = (await readPrivateJson(this.directory, name, 4096)).value
          const evidence =
            name === "native-setup-terminal.json"
              ? windowsProvisioningTerminal.parse(raw)
              : windowsProvisioningAuthorization.parse(raw)
          if (
            evidence.nonce !== this.value.nonce ||
            evidence.recordSha256 !== windowsProvisioningBinding(record)
          )
            throw new Error("Windows setup evidence differs from owned record")
        }
      }
      for (const name of names) {
        const path = join(this.directory, name),
          stat = await lstat(path)
        if (
          stat.isSymbolicLink() ||
          (name !== "control.sock" ? !stat.isFile() || stat.nlink !== 1 : !stat.isSocket())
        )
          throw new Error("Owned shell control file was replaced")
        await unlink(path)
      }
      await rmdir(this.directory)
      await syncDirectory(this.root)
    })
  }
}

/** Read-only inspection. Old records remain evidence; they are neither effects
 * replay permission nor PID termination authority. Caller checks Host ownership. */
export async function inspectOwnedShellReceiptEntries(
  root: string
): Promise<Array<{ slot: number; value: OwnedShellReceipt }>> {
  const rootStat = await lstat(root, { bigint: true })
  if (
    !isAbsolute(root) ||
    resolve(root) !== root ||
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    (await realpath(root)) !== root ||
    (process.getuid && rootStat.uid !== BigInt(process.getuid())) ||
    (process.platform !== "win32" && (rootStat.mode & 0o077n) !== 0n)
  )
    throw new Error("Owned shell receipt root is not canonical and private")
  const names = await readdir(root)
  if (
    names.length > OWNED_SHELL_MAX_UNCONFIRMED ||
    names.some((name) => {
      const match = /^operation-(0|[1-9][0-9]*)$/.exec(name)
      return !match || Number(match[1]) >= OWNED_SHELL_MAX_UNCONFIRMED
    })
  )
    throw new Error("Owned shell receipt root contains an unknown slot")
  const receipts: Array<{ slot: number; value: OwnedShellReceipt }> = []
  const nonces = new Set<string>()
  for (let slot = 0; slot < OWNED_SHELL_MAX_UNCONFIRMED; slot++) {
    const directory = join(root, `operation-${slot}`)
    let stat
    try {
      stat = await lstat(directory, { bigint: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw error
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Owned shell record slot is unsafe")
    const value = ownedShellReceiptSchema.parse(
      (await readPrivateJson(directory, "owner.json", OWNED_SHELL_RECEIPT_BYTES)).value
    )
    if (String(stat.dev) !== value.directory.dev || String(stat.ino) !== value.directory.ino)
      throw new Error("Owned shell record slot identity changed")
    const afterSlot = await lstat(directory, { bigint: true })
    if (afterSlot.isSymbolicLink() || afterSlot.dev !== stat.dev || afterSlot.ino !== stat.ino)
      throw new Error("Owned shell record slot was replaced while inspecting")
    if (nonces.has(value.nonce)) throw new Error("Owned shell resource nonce is duplicated")
    nonces.add(value.nonce)
    const closure = await readOwnedShellClosure(directory, value)
    receipts.push({
      slot,
      value:
        closure && (!value.runAuthorized || isOwnedShellStrongContainment(closure.scope))
          ? { ...value, phase: "resource-closed" as const }
          : value.phase === "resource-closed" &&
              (!hasOwnedShellPhysicalClosure(value) ||
                (isOwnedShellStrongContainment(value.containment) && !closure))
            ? { ...value, phase: "closure-unproven" as const }
            : value
    })
  }
  const after = await lstat(root, { bigint: true })
  if (after.isSymbolicLink() || after.dev !== rootStat.dev || after.ino !== rootStat.ino)
    throw new Error("Owned shell receipt root was replaced")
  return receipts
}

export async function inspectOwnedShellReceipts(root: string): Promise<OwnedShellReceipt[]> {
  return (await inspectOwnedShellReceiptEntries(root)).map((entry) => entry.value)
}
