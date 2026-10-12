import {
  assertLinuxBotDelegation,
  linuxBotResourceLimits,
  DEFAULT_LINUX_BOT_RESOURCE_LIMITS
} from "./linux-bot-cgroup"
import {
  prepareLinuxNativeShellResource,
  proveUnlaunchedLinuxNativeResource,
  waitNativeShellResourceClosure
} from "./linux-native-resource"
import {
  closeUnlaunchedWindowsNativeReservation,
  prepareWindowsNativeShellResource,
  startWindowsNativeShellController,
  type WindowsBotNativeProvider,
  type WindowsNativeShellController
} from "./windows-native-resource"
import { assertNativeShellArtifacts, assertNativeShellRoots } from "./native-shell-command"
import type { NativeShellLifetimeRecord } from "./native-shell-lifetime"
import { writePrivateJson } from "./backup-io"
import { safeSensitiveErrorText } from "../error-text"
import { BotDomainError } from "../../shared/bot-types"
import { assertBotShellCurrent } from "./shell-current-guard"
import { OwnedShellReceiptSlot, type OwnedShellOrigin } from "./owned-shell-receipts"
import { verifyOwnedShellArtifact } from "./owned-shell-artifact"
import { spawn, type ChildProcess } from "node:child_process"
import { chmod, lstat, realpath, mkdtemp, rm, readdir, unlink, rmdir } from "node:fs/promises"
import { createHash, randomUUID, randomBytes } from "node:crypto"
import { createServer, type Socket } from "node:net"
import { isAbsolute, join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import {
  botShellEnvironment,
  recordBotShellIsolation,
  botShellRequestSchema,
  type BotShellProgress,
  type BotShellRequest,
  type BotShellResult
} from "./shell-contract"
import {
  OWNED_SHELL_FRAME_BYTES,
  OWNED_SHELL_REQUEST_BYTES,
  OwnedShellDecoder,
  OwnedShellWriter,
  ownedShellFrameSchema,
  ownedShellLaunchSchema,
  type OwnedShellLaunch
} from "./owned-shell-wire"

export class BotOwnedShellUnknown extends BotDomainError {
  constructor(
    readonly requestMayHaveStarted: boolean,
    readonly resourceClosed: boolean,
    message: string
  ) {
    super("bot_shell_unknown", safeSensitiveErrorText(message, 2000))
    this.name = "BotOwnedShellUnknown"
  }
}
export interface OwnedShellResource {
  nonce: string
  helperPid: number
  workerPid: number
  /** This label must never be promoted to arbitrary-daemon containment. */
  containment:
    | "controlled-inherited-group"
    | "verified-windows-job"
    | "verified-linux-cgroup-v2"
    | "verified-windows-atomic-job-v2"
}
export interface OwnedShellProcessOptions {
  helper: { entry: string; sha256: string }
  launch: OwnedShellLaunch
  /** Host-owned pinned private root; never taken from command/request cwd. */
  controlRoot: string
  origin: OwnedShellOrigin
  /** Native result for the actual binary/principal, never a platform guess. */
  linuxResourceLimits?: { pids: number; memoryBytes: number }
  linuxDelegatedRoot?: string
  windowsNative?: WindowsBotNativeProvider
  windowsJobVerified?: boolean
  windowsControlChannelVerified?: boolean
  /** Existing Host ownership + runtime/policy/lease guard. It may wait for
   * configuration, so it is awaited before commit and again before admission. */
  assertCurrent(signal: AbortSignal): Promise<void>
  resourceReady?: (value: OwnedShellResource) => void
  /** Trusted Host preparation cleanup. Unknown closure must retain its scratch
   * and receipt; cleanup is invoked before confirmed receipt removal. */
  releasePrepared?: (knownClosed: boolean) => Promise<void>
}

async function drainGroup(pid: number): Promise<boolean> {
  // Existence probe only. A reused/non-empty group is rejected; never kill it
  // after the stable owner has exited. Physical closure has a fixed deadline.
  const until = Date.now() + 3000
  do {
    try {
      process.kill(-pid, 0)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ESRCH") return true
      // Darwin can report EPERM during dead-group reaping. It is never proof
      // of closure; give the same bounded drain deadline, then fail unknown.
      if (code !== "EPERM") throw error
    }
    await delay(25)
  } while (Date.now() < until)
  return false
}
async function validatePrivateRoot(directory: string): Promise<string> {
  if (!isAbsolute(directory) || resolve(directory) !== directory)
    throw new Error("Owned shell control root is not absolute")
  const stat = await lstat(directory)
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.nlink < 1 ||
    (process.getuid && stat.uid !== process.getuid()) ||
    (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
  )
    throw new Error("Owned shell control root is not private")
  const canonical = await realpath(directory)
  if (canonical !== directory) throw new Error("Owned shell control root has a path alias")
  return canonical
}

/** Exactly one request is run. Result/leader exit are only candidates. The
 * operation resolves after the trusted outer lifetime owner has closed and its
 * controlled resource has drained; unknown effects are never replayed here. */
export class BotOwnedShellProcess {
  constructor(private readonly options: OwnedShellProcessOptions) {}
  /** Admission is the resource commit ACK plus the last Host/Harness/config
   * guard. Background callers await it inside their existing mutation fence;
   * completion stays attached to the existing effect/job receipt. */
  start(
    raw: BotShellRequest,
    signal: AbortSignal,
    progress?: (value: BotShellProgress) => void
  ): {
    admitted: Promise<void>
    completion: Promise<BotShellResult>
  } {
    let resolveAdmission!: () => void, rejectAdmission!: (error: unknown) => void
    const admitted = new Promise<void>((resolve, reject) => {
      resolveAdmission = resolve
      rejectAdmission = reject
    })
    // execute() callers need only completion, and may never observe admission.
    // Installing a rejection observer does not change either promise's result.
    void admitted.catch(() => {})
    const completion = this.executeOnce(raw, signal, progress, resolveAdmission)
    void completion.catch(rejectAdmission)
    return { admitted, completion }
  }
  execute(
    raw: BotShellRequest,
    signal: AbortSignal,
    progress?: (value: BotShellProgress) => void
  ): Promise<BotShellResult> {
    return this.start(raw, signal, progress).completion
  }
  private async executeOnce(
    raw: BotShellRequest,
    signal: AbortSignal,
    progress: ((value: BotShellProgress) => void) | undefined,
    admit: () => void
  ): Promise<BotShellResult> {
    signal.throwIfAborted()
    const request = botShellRequestSchema.parse(raw),
      launch = ownedShellLaunchSchema.parse(this.options.launch)
    if (
      (launch.nativePlan !== undefined) !==
      (this.options.linuxDelegatedRoot !== undefined || this.options.windowsNative !== undefined)
    )
      throw new Error("Native policy and its physical owner must be supplied together")
    if (launch.cwd !== request.cwd)
      throw new Error("Owned shell startup cwd differs from the approved command")
    if (Buffer.byteLength(JSON.stringify(request)) > OWNED_SHELL_REQUEST_BYTES)
      throw new Error("Owned shell request exceeds its limit")
    if (
      process.platform === "win32" &&
      (!this.options.windowsNative || launch.nativePlan?.platform !== "win32")
    )
      throw new Error("Windows atomic Job provider has not passed native preparation")
    if (this.options.linuxDelegatedRoot) {
      await assertLinuxBotDelegation(this.options.linuxDelegatedRoot)
      linuxBotResourceLimits.parse(
        this.options.linuxResourceLimits ?? DEFAULT_LINUX_BOT_RESOURCE_LIMITS
      )
    }
    const root = await validatePrivateRoot(this.options.controlRoot)
    await assertBotShellCurrent(this.options.assertCurrent, signal)
    await verifyOwnedShellArtifact(this.options.helper)
    await verifyOwnedShellArtifact({ entry: launch.entry, sha256: launch.entrySha256 })
    signal.throwIfAborted()
    const nonce = randomUUID(),
      token = randomBytes(32).toString("hex")
    const scratch = launch.environment.CMB_BOT_COMMAND_SCRATCH
    const scratchIdentity = scratch ? await lstat(scratch, { bigint: true }) : undefined
    if (
      scratch &&
      (!scratchIdentity?.isDirectory() ||
        scratchIdentity.isSymbolicLink() ||
        (await realpath(scratch)) !== scratch)
    )
      throw new Error("Owned shell scratch identity is unsafe")
    // Long data-directory paths cannot fit Darwin's AF_UNIX path. Keep the
    // endpoint in its own canonical 0700 slot with durable inode identity;
    // the control token/receipt stays in Host-private rollback-excluded data.
    const endpoint =
      process.platform === "win32"
        ? undefined
        : await realpath(await mkdtemp("/tmp/cmb-bot-channel-"))
    const endpointPin = endpoint ? await lstat(endpoint, { bigint: true }) : undefined
    let operationOrigin = this.options.origin
    if (launch.nativePlan && endpoint && endpointPin) {
      const policy = JSON.parse(launch.nativePlan.policy)
      if (
        policy.permissionProfile?.file_system?.type !== "restricted" ||
        !Array.isArray(policy.permissionProfile.file_system.entries)
      )
        throw new Error("Invalid native filesystem policy")
      policy.permissionProfile.file_system.entries.push({
        path: { type: "path", path: endpoint },
        access: "deny"
      })
      launch.nativePlan.policy = JSON.stringify(policy)
      launch.nativePlan.policySha256 = createHash("sha256")
        .update(launch.nativePlan.policy)
        .digest("hex")
      launch.nativePlan.roots.push({
        path: endpoint,
        dev: String(endpointPin.dev),
        ino: String(endpointPin.ino)
      })
      operationOrigin = {
        ...operationOrigin,
        policySha256: createHash("sha256")
          .update(
            JSON.stringify({
              origin: operationOrigin,
              policy: launch.nativePlan.policySha256,
              endpoint: {
                path: endpoint,
                dev: String(endpointPin.dev),
                ino: String(endpointPin.ino)
              }
            })
          )
          .digest("hex")
      }
    }
    let receipt: OwnedShellReceiptSlot
    try {
      receipt = await OwnedShellReceiptSlot.allocate(root, {
        ...operationOrigin,
        nonce,
        runId: request.runId,
        containment:
          process.platform === "win32"
            ? "verified-windows-atomic-job-v2"
            : this.options.linuxDelegatedRoot
              ? "verified-linux-cgroup-v2"
              : "controlled-inherited-group",
        ...(endpoint && endpointPin
          ? {
              endpoint: {
                path: endpoint,
                dev: String(endpointPin.dev),
                ino: String(endpointPin.ino)
              }
            }
          : {}),
        ...(this.options.windowsNative
          ? { nativeProviderSha256: this.options.windowsNative.artifact.sha256 }
          : {}),
        helperSha256: this.options.helper.sha256,
        workerSha256: launch.entrySha256,
        ...(scratch && scratchIdentity
          ? {
              scratch: {
                path: scratch,
                dev: String(scratchIdentity.dev),
                ino: String(scratchIdentity.ino)
              }
            }
          : {})
      })
    } catch (error) {
      if (endpoint) await rm(endpoint, { recursive: true, force: true })
      throw error
    }
    const directory = receipt.directory
    let nativeResource: Awaited<ReturnType<typeof prepareLinuxNativeShellResource>> | undefined
    let windowsRecord: NativeShellLifetimeRecord | undefined
    let windowsController: WindowsNativeShellController | undefined
    let windowsHelperPid: number | undefined
    let windowsProbe: Promise<void> | undefined
    const channel =
      process.platform === "win32"
        ? `\\\\.\\pipe\\cmb-bot-shell-${nonce}`
        : join(endpoint!, "control.sock")
    if (process.platform !== "win32" && Buffer.byteLength(channel) > 100) {
      await receipt.settle(true)
      throw new Error("Owned shell control path exceeds the platform socket limit")
    }
    const server = createServer()
    const guardController = new AbortController()
    const guardSignal = AbortSignal.any([signal, guardController.signal])
    let child: ChildProcess | undefined,
      socket: Socket | undefined,
      output: OwnedShellWriter | undefined
    let sentSequence = 0,
      receivedSequence = 0,
      hello = false,
      ready = false,
      requestSent = false,
      prepared = false,
      committed = false,
      runAuthorized = false,
      accepted = false,
      fencing = false
    let cancelRequested = false
    let ownerClosed = false,
      resourceClosed = false,
      controlledResourceClosed = false,
      candidate:
        | { type: "result"; value: BotShellResult }
        | { type: "error"; message: string }
        | undefined
    let admissionCheck: Promise<void> | undefined
    let failure: Error | undefined, stopTimer: ReturnType<typeof setTimeout> | undefined
    let detachMonitoring: (() => void) | undefined
    const clearPrivateControl = async (): Promise<void> => {
      socket?.destroy()
      output?.close()
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
      const knownClosed = resourceClosed || child?.pid === undefined
      if (knownClosed && launch.nativePlan?.platform === "linux" && child?.pid === undefined) {
        await assertBotShellCurrent(this.options.assertCurrent, new AbortController().signal)
        await proveUnlaunchedLinuxNativeResource(directory, receipt.snapshot())
      }
      if (knownClosed && child?.pid === undefined && windowsRecord) {
        await assertBotShellCurrent(this.options.assertCurrent, new AbortController().signal)
        await closeUnlaunchedWindowsNativeReservation(directory, windowsRecord)
      }
      // Persist closure before disposing preparation. If disposal/fsync fails,
      // startup can distinguish cleanup-pending from physical closure unknown.
      if (knownClosed) await receipt.closed()
      if (knownClosed && scratch && scratchIdentity) {
        const current = await lstat(scratch, { bigint: true })
        if (
          !current.isDirectory() ||
          current.isSymbolicLink() ||
          (await realpath(scratch)) !== scratch ||
          current.dev !== scratchIdentity.dev ||
          current.ino !== scratchIdentity.ino
        )
          throw new Error("Owned shell scratch directory was replaced")
      }
      if (knownClosed && nativeResource) await nativeResource.releaseClosed()
      await this.options.releasePrepared?.(knownClosed)
      if (knownClosed && endpoint && endpointPin) {
        const current = await lstat(endpoint, { bigint: true })
        if (
          current.isSymbolicLink() ||
          !current.isDirectory() ||
          current.dev !== endpointPin.dev ||
          current.ino !== endpointPin.ino ||
          (await realpath(endpoint)) !== endpoint
        )
          throw new Error("Owned shell endpoint identity changed")
        const files = await readdir(endpoint)
        if (files.some((n) => n !== "control.sock"))
          throw new Error("Owned shell endpoint contains unknown data")
        for (const name of files) {
          const file = join(endpoint, name),
            pin = await lstat(file)
          if (pin.isSymbolicLink() || !pin.isSocket())
            throw new Error("Owned shell endpoint is not owned")
          await unlink(file)
        }
        await rmdir(endpoint)
      }
      await receipt.settle(knownClosed)
    }
    const releasePrivateControl = async (): Promise<void> => {
      try {
        await clearPrivateControl()
      } catch (error) {
        // Cleanup must not turn a committed command into a pre-execution error.
        throw new BotOwnedShellUnknown(
          committed,
          resourceClosed || child?.pid === undefined,
          error instanceof Error ? error.message : "命令现场清理未完成，需人工核对"
        )
      }
    }
    try {
      if (launch.nativePlan) {
        if (
          process.platform === "linux" &&
          this.options.linuxDelegatedRoot &&
          launch.nativePlan.platform === "linux"
        ) {
          nativeResource = await prepareLinuxNativeShellResource({
            directory,
            origin: receipt.snapshot(),
            delegatedRoot: this.options.linuxDelegatedRoot,
            limits: this.options.linuxResourceLimits,
            helperSha256: this.options.helper.sha256,
            assertCurrent: this.options.assertCurrent,
            signal
          })
        } else if (
          process.platform === "win32" &&
          this.options.windowsNative &&
          launch.nativePlan.platform === "win32"
        ) {
          windowsRecord = await prepareWindowsNativeShellResource({
            directory,
            origin: receipt.snapshot(),
            provider: this.options.windowsNative,
            assertCurrent: this.options.assertCurrent,
            signal
          })
          nativeResource = {
            record: windowsRecord,
            assertCurrent: async (currentSignal) => {
              await this.options.assertCurrent(currentSignal)
              await assertNativeShellArtifacts(launch.nativePlan!, currentSignal)
              await assertNativeShellRoots(launch.nativePlan!, currentSignal)
              currentSignal.throwIfAborted()
            },
            releaseClosed: async () => {}
          }
        } else throw new Error("Native resource provider is unavailable")
      }
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(channel, () => {
          server.removeListener("error", reject)
          resolve()
        })
      })
      if (process.platform !== "win32") await chmod(channel, 0o600)
      return await new Promise<BotShellResult>((resolveResult, rejectResult) => {
        const send = (type: string, rest: object = {}) =>
          output?.send(() => ({ type, nonce, sequence: ++sentSequence, ...rest }))
        const hardStop = (): void => {
          if (!child?.pid || ownerClosed || child.exitCode !== null || child.signalCode !== null)
            return
          try {
            if (process.platform === "win32") child.kill("SIGKILL")
            else process.kill(-child.pid, "SIGKILL")
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH")
              failure ??=
                error instanceof Error ? error : new Error("Owned shell resource could not close")
          }
        }
        const stop = (): void => {
          if (ownerClosed || cancelRequested) return
          cancelRequested = true
          guardController.abort(failure ?? signal.reason ?? new Error("Shell resource stopped"))
          send("cancel")
          windowsController?.stop()
          stopTimer ??= setTimeout(hardStop, process.platform === "win32" ? 12_000 : 8000)
        }
        const fail = (error: unknown): void => {
          failure ??= error instanceof Error ? error : new Error("Owned shell transport failed")
          stop()
        }
        const timeout = setTimeout(
          () => fail(new Error("命令执行超时，结果需人工核对")),
          request.timeoutMs + 15_000
        )
        const connectTimeout = setTimeout(() => fail(new Error("命令资源启动超时")), 30_000)
        signal.addEventListener("abort", stop, { once: true })
        server.on("error", fail)
        // Encoding or spawning may throw synchronously before a child exists.
        // Those paths still dispose the same observers in the outer finally.
        detachMonitoring = () => {
          clearTimeout(timeout)
          clearTimeout(connectTimeout)
          if (stopTimer) clearTimeout(stopTimer)
          signal.removeEventListener("abort", stop)
          server.removeListener("error", fail)
        }
        server.on("connection", (incoming) => {
          if (socket) {
            incoming.destroy()
            fail(new Error("Duplicate owned shell control connection"))
            return
          }
          socket = incoming
          if (process.platform === "win32") {
            incoming.pause()
            void windowsController!.ready
              .then((pid) => {
                windowsHelperPid = pid
                if (!cancelRequested && !ownerClosed) incoming.resume()
              })
              .catch(fail)
          }
          output = new OwnedShellWriter(incoming, OWNED_SHELL_REQUEST_BYTES, fail)
          const decoder = new OwnedShellDecoder(OWNED_SHELL_FRAME_BYTES, (rawFrame) => {
            const frame = ownedShellFrameSchema.parse(rawFrame)
            if (frame.nonce !== nonce || frame.sequence !== ++receivedSequence || candidate)
              throw new Error("Invalid owned shell frame identity/order")
            if (frame.type === "hello") {
              if (
                hello ||
                frame.token !== token ||
                frame.helperPid !== (process.platform === "win32" ? windowsHelperPid : child?.pid)
              )
                throw new Error("Foreign shell resource owner")
              hello = true
              send("start", { launch })
            } else if (frame.type === "ready") {
              if (
                !hello ||
                ready ||
                frame.helperPid !== (process.platform === "win32" ? windowsHelperPid : child?.pid)
              )
                throw new Error("Invalid shell worker readiness")
              ready = true
              clearTimeout(connectTimeout)
              this.options.resourceReady?.({
                nonce,
                helperPid: frame.helperPid,
                workerPid: frame.workerPid,
                containment:
                  process.platform === "win32"
                    ? "verified-windows-atomic-job-v2"
                    : this.options.linuxDelegatedRoot
                      ? "verified-linux-cgroup-v2"
                      : "controlled-inherited-group"
              })
              void (async () => {
                // A pending config/model/policy lookup must not permit the
                // first effect after the owner/lease was lost while awaiting.
                await receipt.ready(frame.helperPid, frame.workerPid)
                await assertBotShellCurrent(async (currentSignal) => {
                  await this.options.assertCurrent(currentSignal)
                  await nativeResource?.assertCurrent(currentSignal)
                }, guardSignal)
                if (signal.aborted || cancelRequested || ownerClosed) return stop()
                requestSent = true
                send("run", { request })
              })().catch(fail)
            } else if (frame.type === "native-probe") {
              if (!ready || !requestSent || prepared || windowsProbe || !windowsController)
                throw new Error("Unexpected native membership probe")
              windowsProbe = (async () => {
                await windowsController!.verifyMember(frame.pid)
                await assertBotShellCurrent(this.options.assertCurrent, guardSignal)
                if (!scratch) throw new Error("Windows probe release scratch is missing")
                await writePrivateJson(join(scratch, "native-probe-release.json"), { nonce })
              })()
              void windowsProbe.catch(fail)
            } else if (frame.type === "prepared") {
              if (!ready || !requestSent || prepared || committed)
                throw new Error("Invalid shell preparation")
              prepared = true
              void (async () => {
                if (windowsController) {
                  if (!windowsProbe)
                    throw new Error("Windows live sandbox membership proof is missing")
                  await windowsProbe
                }
                // Preparation completed without a command or Hook first effect.
                // The durable record is conservative across commit ACK loss.
                await assertBotShellCurrent(async (currentSignal) => {
                  await this.options.assertCurrent(currentSignal)
                  await nativeResource?.assertCurrent(currentSignal)
                }, guardSignal)
                if (signal.aborted || cancelRequested || ownerClosed) return stop()
                // Remain conservative if the durable write committed before
                // its acknowledgement or the following live guard failed.
                runAuthorized = true
                await receipt.authorizeRun()
                await assertBotShellCurrent(async (currentSignal) => {
                  await this.options.assertCurrent(currentSignal)
                  await nativeResource?.assertCurrent(currentSignal)
                }, guardSignal)
                if (signal.aborted || cancelRequested || ownerClosed) return stop()
                committed = true
                send("commit")
              })().catch(fail)
            } else if (frame.type === "accepted") {
              if (!prepared || !committed || accepted) throw new Error("Invalid shell admission")
              accepted = true
              admissionCheck = (async () => {
                await assertBotShellCurrent(async (currentSignal) => {
                  await this.options.assertCurrent(currentSignal)
                  await nativeResource?.assertCurrent(currentSignal)
                }, guardSignal)
                if (signal.aborted || cancelRequested || failure || (ownerClosed && !fencing))
                  throw new Error("Shell admission is no longer current")
                admit()
              })()
              void admissionCheck.catch(fail)
            } else if (frame.type === "progress") {
              if (!ready || !accepted) throw new Error("Shell progress before execution")
              progress?.(frame.value)
            } else {
              if (!ready || !requestSent || (frame.outcome.type === "result" && !accepted))
                throw new Error("Shell result before execution")
              candidate = frame.outcome
              fencing = true
              send("fence")
            }
          })
          incoming.on("data", (bytes) => {
            try {
              decoder.feed(bytes)
            } catch (error) {
              fail(error)
            }
          })
          incoming.once("end", () => {
            try {
              decoder.end()
            } catch (error) {
              fail(error)
            }
          })
          incoming.once("error", fail)
          incoming.once("close", () => {
            if (!fencing && !ownerClosed) fail(new Error("命令控制通道断开，结果需人工核对"))
          })
        })
        const environment = {
          ...botShellEnvironment(process.env),
          ELECTRON_RUN_AS_NODE: "1",
          CMB_BOT_SHELL_CONTROL_CHANNEL: channel,
          CMB_BOT_SHELL_CONTROL_NONCE: nonce,
          CMB_BOT_SHELL_CONTROL_TOKEN: token,
          CMB_BOT_SHELL_RECEIPT_DIRECTORY: directory,
          CMB_BOT_SHELL_OWNER_MODE:
            process.platform === "win32"
              ? "windows-atomic-job-v2"
              : nativeResource
                ? "linux-cgroup"
                : "posix-group"
        }
        if (process.platform === "win32") {
          if (!windowsRecord || !this.options.windowsNative)
            throw new Error("Windows resource preparation is absent")
          windowsController = startWindowsNativeShellController({
            provider: this.options.windowsNative,
            record: windowsRecord,
            directory,
            executable: process.execPath,
            helperEntry: this.options.helper.entry,
            cwd: launch.startupCwd ?? launch.cwd,
            environment,
            timeoutMs: request.timeoutMs + 30_000,
            failure: fail
          })
          child = windowsController.child
        } else {
          child = spawn(process.execPath, ["--max-old-space-size=128", this.options.helper.entry], {
            stdio: ["ignore", "ignore", "ignore"],
            detached: true,
            windowsHide: true,
            env: environment
          })
        }
        child.once("error", fail)
        child.once("close", () => {
          ownerClosed = true
          detachMonitoring?.()
          detachMonitoring = undefined
          void (async () => {
            controlledResourceClosed =
              child?.pid === undefined ||
              (process.platform === "win32"
                ? await waitNativeShellResourceClosure(directory, receipt.snapshot())
                : nativeResource
                  ? await waitNativeShellResourceClosure(directory, receipt.snapshot())
                  : (await drainGroup(child.pid)) && (await receipt.waitControlledGroupClosure()))
            resourceClosed =
              controlledResourceClosed && (!runAuthorized || nativeResource !== undefined)
            if (admissionCheck) {
              try {
                await admissionCheck
              } catch (error) {
                failure ??= error instanceof Error ? error : new Error("Shell admission failed")
              }
            }
            // A complete validated business result and physical cleanup are
            // separate facts. Preserve the former, retain a weak-scope receipt,
            // and prohibit maintenance while closure remains unproven.
            if (!controlledResourceClosed || signal.aborted || failure || !candidate || !fencing) {
              rejectResult(
                new BotOwnedShellUnknown(
                  committed,
                  resourceClosed,
                  failure?.message ??
                    (signal.aborted
                      ? "命令已取消，需核对已产生的效果"
                      : "命令资源断开，结果需人工核对")
                )
              )
            } else if (candidate.type === "error")
              rejectResult(new BotOwnedShellUnknown(committed, resourceClosed, candidate.message))
            else
              resolveResult(
                prepared && accepted && resourceClosed && nativeResource !== undefined
                  ? recordBotShellIsolation(
                      candidate.value,
                      process.platform === "win32"
                        ? "windows-codex-atomic-job-v2"
                        : "linux-codex-cgroup-v2"
                    )
                  : candidate.value
              )
          })().catch(rejectResult)
        })
        if (signal.aborted) stop()
      })
    } finally {
      detachMonitoring?.()
      detachMonitoring = undefined
      await releasePrivateControl()
    }
  }
}
