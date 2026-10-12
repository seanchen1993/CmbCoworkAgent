import { randomUUID } from "node:crypto"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { lstat } from "node:fs/promises"
import { join } from "node:path"
import { writePrivateJson, syncDirectory } from "./backup-io"
import {
  nativeShellClosure,
  nativeShellLifetimeRecord,
  type NativeShellLifetimeRecord
} from "./native-shell-lifetime"
import { ownedShellReceiptSchema, type OwnedShellReceipt } from "./owned-shell-receipt-contract"
import { verifyOwnedShellArtifact } from "./owned-shell-artifact"
import {
  windowsBotJobScope,
  windowsBotOwnerCapabilities,
  WindowsBotOwnerDecoder,
  type WindowsBotOwnerCapabilities
} from "./windows-native-contract"
import { startWindowsBotResourceController } from "./windows-bot-resource-controller"

export interface WindowsBotNativeProvider {
  artifact: { entry: string; sha256: string }
  capabilities: WindowsBotOwnerCapabilities
  limits: { pids: number; memoryBytes: number }
}
/** This actual native ABI/limits probe is not a command admission. The later
 * fixed sandbox probe's live PID must separately be found in this owned Job. */
export async function probeWindowsBotNativeOwner(
  artifact: { entry: string; sha256: string },
  signal: AbortSignal
): Promise<WindowsBotOwnerCapabilities> {
  if (process.platform !== "win32") throw new Error("Windows native ABI probe requires Windows")
  await verifyOwnedShellArtifact(artifact)
  signal.throwIfAborted()
  const nonce = randomUUID()
  return new Promise((resolve, reject) => {
    const child = spawn(artifact.entry, ["--capabilities-json-v2", nonce], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    })
    let value: WindowsBotOwnerCapabilities | undefined,
      failure: unknown,
      closed = false
    const fail = (error: unknown) => {
      failure ??= error
      child.kill()
    }
    const decoder = new WindowsBotOwnerDecoder((raw) => {
      if (value) throw new Error("Duplicate native ABI probe")
      value = windowsBotOwnerCapabilities.parse(raw)
      if (value.nonce !== nonce) throw new Error("Native ABI nonce differs")
    })
    const abort = () => fail(signal.reason ?? new Error("Native ABI probe cancelled"))
    const timer = setTimeout(() => fail(new Error("Native ABI probe timed out")), 8000)
    signal.addEventListener("abort", abort, { once: true })
    child.stdout.on("data", (bytes) => {
      try {
        decoder.feed(bytes)
      } catch (error) {
        fail(error)
      }
    })
    child.once("error", (error) => {
      failure ??= error
    })
    child.once("close", (code) => {
      closed = true
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      try {
        decoder.end()
        if (failure) throw failure
        if (code !== 0 || !value) throw new Error("Native ABI probe failed")
        resolve(value)
      } catch (error) {
        reject(error)
      }
    })
    if (signal.aborted && !closed) abort()
  })
}
export async function prepareWindowsNativeShellResource(input: {
  directory: string
  origin: OwnedShellReceipt
  provider: WindowsBotNativeProvider
  provisioning?: ReturnType<
    typeof import("./windows-provisioning-contract").windowsProvisioning.parse
  >
  signal: AbortSignal
  assertCurrent(signal: AbortSignal): Promise<void>
}): Promise<NativeShellLifetimeRecord> {
  input.signal.throwIfAborted()
  await input.assertCurrent(input.signal)
  const origin = ownedShellReceiptSchema.parse(input.origin)
  const caps = windowsBotOwnerCapabilities.parse(input.provider.capabilities)
  if (origin.nativeProviderSha256 !== input.provider.artifact.sha256)
    throw new Error("Windows resource provider differs from receipt")
  await verifyOwnedShellArtifact(input.provider.artifact)
  const pin = await lstat(input.directory, { bigint: true })
  if (
    !pin.isDirectory() ||
    pin.isSymbolicLink() ||
    String(pin.dev) !== origin.directory.dev ||
    String(pin.ino) !== origin.directory.ino
  )
    throw new Error("Windows operation slot changed")
  const scope = windowsBotJobScope.parse({
    format: 2,
    kind: "verified-windows-atomic-job-v2",
    protocol: caps.protocol,
    nonce: origin.nonce,
    bootId: caps.bootId,
    sessionId: caps.sessionId,
    jobName: `Local\\CMBDevClaw-Bot-${origin.nonce}`,
    providerSha256: input.provider.artifact.sha256,
    ...(input.provisioning ? { provisioning: input.provisioning } : {}),
    limits: input.provider.limits
  })
  const record = nativeShellLifetimeRecord.parse({ format: 1, origin, resource: scope })
  await writePrivateJson(join(input.directory, "native-resource.json"), record)
  await syncDirectory(input.directory)
  input.signal.throwIfAborted()
  return record
}
export interface WindowsNativeShellController {
  child: ChildProcessWithoutNullStreams
  ready: Promise<number>
  verifyMember(pid: number): Promise<void>
  stop(): void
}
/** Native controller is outside the unique Job. EOF closes its actual handle
 * scope. Forced controller death retains unproven evidence; leader exit alone
 * never permits receipt deletion or a result to claim physical closure. */
export function startWindowsNativeShellController(input: {
  provider: WindowsBotNativeProvider
  record: NativeShellLifetimeRecord
  directory: string
  executable: string
  helperEntry: string
  cwd: string
  environment: NodeJS.ProcessEnv
  timeoutMs: number
  failure(error: unknown): void
}): WindowsNativeShellController {
  const scope = windowsBotJobScope.parse(input.record.resource)
  const proof = nativeShellClosure.parse({
    format: 2,
    scope: scope.kind,
    record: input.record,
    kernelEmpty: true
  })
  return startWindowsBotResourceController({
    mode: "shell",
    artifact: input.provider.artifact,
    scope,
    request: {
      executable: input.executable,
      cwd: input.cwd,
      receiptDirectory: input.directory,
      jobName: scope.jobName,
      args: ["--max-old-space-size=128", input.helperEntry],
      timeoutMs: input.timeoutMs,
      limits: scope.limits,
      bootId: scope.bootId,
      sessionId: scope.sessionId,
      proof
    },
    environment: input.environment,
    failure: input.failure
  })
}

/** Called only by the live launcher before any native process was spawned.
 * A reserved Job name is not an allocated kernel resource; this separate
 * disposition never attests an executed command or upgrades a legacy scope. */
export async function closeUnlaunchedWindowsNativeReservation(
  directory: string,
  record: NativeShellLifetimeRecord
): Promise<void> {
  const scope = windowsBotJobScope.parse(record.resource)
  if (
    record.origin.runAuthorized ||
    record.origin.helperPid !== undefined ||
    record.origin.workerPid !== undefined
  )
    throw new Error("Windows reservation was already launched")
  const pin = await lstat(directory, { bigint: true })
  if (
    !pin.isDirectory() ||
    pin.isSymbolicLink() ||
    String(pin.dev) !== record.origin.directory.dev ||
    String(pin.ino) !== record.origin.directory.ino
  )
    throw new Error("Windows reservation changed")
  await writePrivateJson(
    join(directory, "closure.json"),
    nativeShellClosure.parse({
      format: 2,
      scope: scope.kind,
      record,
      kernelEmpty: true,
      neverLaunched: true
    })
  )
}
