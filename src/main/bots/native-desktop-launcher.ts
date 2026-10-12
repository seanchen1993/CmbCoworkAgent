import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { spawn } from "node:child_process"
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { join, win32 } from "node:path"
import { createServer, type Socket } from "node:net"
import { PassThrough } from "node:stream"
import { setTimeout as delay } from "node:timers/promises"
import { performance } from "node:perf_hooks"
import { z } from "zod"
import { verifyNativeShellPackage } from "./native-shell-package"
import { verifyOwnedShellArtifact } from "./owned-shell-artifact"
import { nativeShellPlan, type NativeShellPlan } from "./native-shell-contract"
import { assertNativeShellRoots, assertNativeShellArtifacts } from "./native-shell-command"
import {
  windowsBotJobScope,
  windowsDesktopOwnerCapabilities,
  WindowsBotOwnerDecoder,
  windowsBotResourceLimits
} from "./windows-native-contract"
import {
  startWindowsBotResourceController,
  type WindowsBotResourceController
} from "./windows-bot-resource-controller"
import { botShellEnvironment } from "./shell-contract"
import { readPrivateJson, writePrivateJson, privateDirectory } from "./backup-io"
import { nativeProbeObservation } from "./native-shell-probe-command"
import {
  NativeDesktopFrameDecoder,
  NativeDesktopNoAllocationError,
  type NativeDesktopProcessLease
} from "./native-desktop-transport"
import {
  nativeDesktopBootstrapHello,
  nativeDesktopBootstrapConfiguration,
  nativeDesktopResourceRecord,
  nativeDesktopResourceClosure,
  nativeDesktopPolicyRoots,
  sameNativeDesktopResource,
  type NativeDesktopResourceRecord
} from "./native-desktop-resource"
import { nativeDesktopReady, type NativeDesktopScope } from "../../shared/bot-native-desktop"

/** Trusted Host startup/preparation only. Renderer/model cannot supply package,
 * bootstrap, policy roots, resource limits, scratch, or arbitrary native argv. */
export interface NativeDesktopLauncherInput {
  scope: NativeDesktopScope
  plan: NativeShellPlan
  packageDirectory: string
  manifestSha256: string
  bootstrap: { entry: string; sha256: string }
  controlRoot: string
  scratchRoot: string
  resourceLimits: { pids: number; memoryBytes: number }
  signal: AbortSignal
  assertOperational(): void
  assertCurrentSync(): void
  assertOwnership(signal: AbortSignal): Promise<void>
}
const probeEnvelope = z
  .object({
    type: z.literal("native-probe"),
    protocol: z.literal("cmb-native-desktop-bootstrap-v1"),
    version: z.literal(1),
    nonce: z.string().uuid(),
    observation: nativeProbeObservation
  })
  .strict()
async function pinDirectory(path: string) {
  const actual = await realpath(path),
    stat = await lstat(actual, { bigint: true })
  if (path !== actual || !stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Desktop private directory identity differs")
  return { path: actual, dev: String(stat.dev), ino: String(stat.ino) }
}
async function assertPin(pin: Awaited<ReturnType<typeof pinDirectory>>) {
  const current = await pinDirectory(pin.path)
  if (current.dev !== pin.dev || current.ino !== pin.ino)
    throw new Error("Desktop private directory changed")
}
const under = (root: string, path: string) => {
  const part = win32.relative(root, path)
  return part === "" || (part !== ".." && !part.startsWith("..\\") && !win32.isAbsolute(part))
}
function framed(value: unknown) {
  const data = Buffer.from(JSON.stringify(value)),
    header = Buffer.alloc(4)
  header.writeUInt32BE(data.length)
  return Buffer.concat([header, data])
}

async function probeOwner(artifact: { entry: string; sha256: string }, signal: AbortSignal) {
  await verifyOwnedShellArtifact(artifact)
  signal.throwIfAborted()
  const nonce = randomUUID()
  return new Promise<z.infer<typeof windowsDesktopOwnerCapabilities>>((resolve, reject) => {
    const child = spawn(artifact.entry, ["--desktop-capabilities-json-v1", nonce], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    })
    let value: z.infer<typeof windowsDesktopOwnerCapabilities> | undefined, failure: unknown
    const fail = (error: unknown) => {
      failure ??= error
      child.kill()
    }
    const decoder = new WindowsBotOwnerDecoder((raw) => {
      if (value) throw new Error("Duplicate desktop ABI result")
      value = windowsDesktopOwnerCapabilities.parse(raw)
      if (value.nonce !== nonce) throw new Error("Desktop ABI nonce differs")
    })
    const abort = () => fail(signal.reason ?? new Error("Desktop ABI cancelled"))
    signal.addEventListener("abort", abort, { once: true })
    const timer = setTimeout(() => fail(new Error("Desktop ABI probe timed out")), 8000)
    child.stdout.on("data", (bytes) => {
      try {
        decoder.feed(bytes)
      } catch (error) {
        fail(error)
      }
    })
    child.once("error", fail)
    child.once("close", (code) => {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      try {
        decoder.end()
        if (failure) throw failure
        if (code !== 0 || !value) throw new Error("Desktop ABI probe failed")
        resolve(value)
      } catch (error) {
        reject(error)
      }
    })
    if (signal.aborted) abort()
  })
}

/** Starts the native owner -> sealed Node bootstrap -> pinned Codex private
 * desktop -> pinned UIA/WGC worker. Its returned port is never a second agent. */
export async function launchNativeDesktop(input: NativeDesktopLauncherInput): Promise<
  NativeDesktopProcessLease & {
    policy: { readRoots: string[]; writeRoots: string[] }
    record: NativeDesktopResourceRecord
  }
> {
  let ownerStarted = false,
    controller: WindowsBotResourceController | undefined,
    socket: Socket | undefined
  let cleanupSocket: (() => void) | undefined
  let record: NativeDesktopResourceRecord | undefined
  let preparedSlot: Awaited<ReturnType<typeof pinDirectory>> | undefined
  let preparedScratch: Awaited<ReturnType<typeof pinDirectory>> | undefined
  try {
    if (process.platform !== "win32") throw new Error("原生桌面目前仅支持 Windows")
    input.signal.throwIfAborted()
    input.assertOperational()
    input.assertCurrentSync()
    await input.assertOwnership(input.signal)
    const plan = nativeShellPlan.parse(input.plan),
      policy = nativeDesktopPolicyRoots(plan)
    if (plan.arch !== process.arch) throw new Error("Desktop runtime architecture differs")
    const pkg = await verifyNativeShellPackage(
      input.packageDirectory,
      input.manifestSha256,
      input.signal
    )
    if (
      !pkg.desktopWorker ||
      pkg.desktopWorker.runtimeMode !== "readonly-installed" ||
      pkg.desktopWorker.assets.length === 0 ||
      !pkg.jobOwner ||
      pkg.manifest.desktopOwnerProtocol !== "cmb-native-desktop-owner-v1" ||
      pkg.cli.entry !== plan.cli.entry ||
      pkg.cli.sha256 !== plan.cli.sha256 ||
      pkg.nativeHelper.sha256 !== plan.nativeHelper.sha256
    )
      throw new Error("Desktop runtime package is incomplete")
    if (policy.writeRoots.some((root) => under(root, pkg.directory)))
      throw new Error("Desktop runtime must be outside every application write root")
    await verifyOwnedShellArtifact(input.bootstrap)
    await assertNativeShellArtifacts(plan, input.signal)
    await assertNativeShellRoots(plan, input.signal)
    const capabilities = await probeOwner(pkg.jobOwner, input.signal)
    const limits = windowsBotResourceLimits.parse(input.resourceLimits)
    await privateDirectory(input.controlRoot)
    const control = await pinDirectory(input.controlRoot),
      scratch = await pinDirectory(input.scratchRoot)
    if (!policy.writeRoots.some((root) => under(root, scratch.path)))
      throw new Error("Desktop scratch is outside its fixed write policy")
    const nonce = randomUUID(),
      token = randomBytes(32),
      channel = `\\\\.\\pipe\\CMBDevClaw-Desktop-${nonce}`
    const slot = await realpath(await mkdtemp(join(control.path, "desktop-"))),
      directory = await pinDirectory(slot)
    preparedSlot = directory
    const runtimeScratch = join(scratch.path, `desktop-${nonce}`)
    await mkdir(runtimeScratch, { mode: 0o700 })
    preparedScratch = await pinDirectory(runtimeScratch)
    await mkdir(join(runtimeScratch, "home"), { mode: 0o700 })
    const resource = windowsBotJobScope.parse({
      format: 2,
      kind: "verified-windows-atomic-job-v2",
      protocol: "cmb-atomic-windows-job-v2",
      nonce,
      bootId: capabilities.bootId,
      sessionId: capabilities.sessionId,
      jobName: `Local\\CMBDevClaw-Bot-${nonce}`,
      providerSha256: pkg.jobOwner.sha256,
      limits
    })
    record = nativeDesktopResourceRecord.parse({
      format: 1,
      kind: "cmb-native-desktop-resource-v1",
      ownerProtocol: "cmb-native-desktop-owner-v1",
      nonce,
      scope: input.scope,
      packageManifestSha256: pkg.manifestSha256,
      policySha256: plan.policySha256,
      bootstrap: input.bootstrap,
      worker: { entry: pkg.desktopWorker.entry, sha256: pkg.desktopWorker.sha256 },
      directory,
      scratchDirectory: scratch,
      resource
    })
    await writePrivateJson(join(slot, "desktop-resource.json"), record)
    const proof = nativeDesktopResourceClosure.parse({
      format: 1,
      kind: "cmb-native-desktop-closure-v1",
      record,
      kernelEmpty: true
    })
    const assertCurrent = async () => {
      input.signal.throwIfAborted()
      input.assertCurrentSync()
      await input.assertOwnership(input.signal)
      await assertPin(control)
      await assertPin(directory)
      await assertPin(scratch)
      await pkg.assertCurrent(input.signal)
      await assertNativeShellRoots(plan, input.signal)
      input.assertCurrentSync()
    }
    await assertCurrent()
    const output = new PassThrough({ highWaterMark: 128 * 1024 })
    let resolveReady!: (ready: z.infer<typeof nativeDesktopReady>) => void,
      rejectReady!: (error: unknown) => void
    const ready = new Promise<z.infer<typeof nativeDesktopReady>>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    void ready.catch(() => {})
    let connected = false,
      nativePrepared = false,
      handingOver = false,
      failure: unknown
    const fail = (error: unknown) => {
      failure ??= error
      rejectReady(error)
      controller?.stop()
      socket?.destroy()
      output.destroy(error instanceof Error ? error : new Error("Desktop startup failed"))
    }
    // No consumer exists before the returned transport is constructed. Preserve
    // startup errors for the ready promise without an unhandled stream event.
    output.on("error", () => {})
    const server = createServer((candidate) => {
      if (connected) {
        candidate.destroy()
        return
      }
      let authenticated = false,
        startupFrames = 0
      const decoder = new NativeDesktopFrameDecoder((raw) => {
        if (++startupFrames > 3) throw new Error("Desktop startup frame count differs")
        if (!authenticated) {
          const hello = nativeDesktopBootstrapHello.parse(raw)
          const offered = Buffer.from(hello.token, "hex")
          if (
            hello.nonce !== nonce ||
            offered.length !== token.length ||
            !timingSafeEqual(offered, token)
          ) {
            candidate.destroy()
            return
          }
          authenticated = true
          connected = true
          socket = candidate
          candidate.pause()
          void (async () => {
            const helperPid = await controller!.ready
            if (hello.bootstrapPid !== helperPid)
              throw new Error("Desktop bootstrap differs from actual native enrollment")
            await controller!.verifyMember(helperPid)
            await assertCurrent()
            const config = nativeDesktopBootstrapConfiguration.parse({
              type: "configure",
              protocol: "cmb-native-desktop-bootstrap-v1",
              version: 1,
              nonce,
              scope: input.scope,
              packageDirectory: pkg.directory,
              manifestSha256: pkg.manifestSha256,
              bootstrap: input.bootstrap,
              nativePlan: plan,
              runtimeMode: "readonly-installed",
              scratchDirectory: runtimeScratch,
              probe: {
                readSentinel: join(slot, "read-sentinel.json"),
                deniedWrite: join(pkg.directory, `runtime-write-probe-${nonce}.txt`),
                controlChannel: channel,
                releaseFile: join(runtimeScratch, "probe-release.json")
              }
            })
            candidate.write(framed(config), (error) => {
              if (error) fail(error)
            })
            candidate.resume()
          })().catch(fail)
          return
        }
        if (!nativePrepared) {
          const observed = probeEnvelope.parse(raw)
          if (
            observed.nonce !== nonce ||
            observed.observation.nonce !== nonce ||
            !observed.observation.pid ||
            !observed.observation.readDenied ||
            !observed.observation.writeDenied ||
            !observed.observation.controlDenied
          )
            throw new Error("Desktop native isolation probe failed")
          candidate.pause()
          void (async () => {
            await controller!.verifyMember(observed.observation.pid!)
            await assertCurrent()
            await writePrivateJson(join(runtimeScratch, "probe-release.json"), { nonce })
            nativePrepared = true
            candidate.resume()
          })().catch(fail)
          return
        }
        const worker = nativeDesktopReady.parse(raw)
        if (
          worker.nonce !== nonce ||
          worker.worker.sessionId !== resource.sessionId ||
          !/^CodexSandboxDesktop-[a-fA-F0-9]{1,32}$/.test(worker.worker.desktop)
        )
          throw new Error("Desktop worker identity differs")
        candidate.pause()
        void (async () => {
          await controller!.verifyMember(worker.worker.pid)
          await assertCurrent()
          handingOver = true
          candidate.removeListener("data", readStartup)
          output.write(framed(worker))
          candidate.pipe(output, { end: true })
          resolveReady(worker)
          candidate.resume()
        })().catch(fail)
      }, 64 * 1024)
      const readStartup = (bytes: Buffer) => {
        try {
          decoder.feed(bytes)
        } catch (error) {
          if (authenticated) fail(error)
          else candidate.destroy()
        }
      }
      candidate.on("data", readStartup)
      candidate.once("error", (error) => {
        if (authenticated) fail(error)
      })
      candidate.once("close", () => {
        if (authenticated && !handingOver)
          fail(new Error("Desktop bootstrap closed before admission"))
        else if (authenticated) controller?.stop()
      })
    })
    server.maxConnections = 4
    cleanupSocket = () => {
      server.close()
      socket?.destroy()
    }
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(channel, () => {
        server.removeListener("error", reject)
        resolve()
      })
    })
    server.on("error", fail)
    await writePrivateJson(join(slot, "read-sentinel.json"), { nonce })
    const timer = setTimeout(() => fail(new Error("Desktop native startup timed out")), 35_000)
    const abort = () => fail(input.signal.reason ?? new Error("Desktop startup cancelled"))
    input.signal.addEventListener("abort", abort, { once: true })
    try {
      await assertCurrent()
      ownerStarted = true
      controller = startWindowsBotResourceController({
        mode: "desktop",
        artifact: pkg.jobOwner,
        scope: resource,
        request: {
          executable: process.execPath,
          cwd: plan.startupCwd,
          receiptDirectory: slot,
          jobName: resource.jobName,
          args: ["--max-old-space-size=128", input.bootstrap.entry],
          limits,
          bootId: resource.bootId,
          sessionId: resource.sessionId,
          timeoutMs: 86_400_000,
          proof
        },
        environment: {
          ...botShellEnvironment(process.env),
          ELECTRON_RUN_AS_NODE: "1",
          CMB_NATIVE_DESKTOP_CHANNEL: channel,
          CMB_NATIVE_DESKTOP_TOKEN: token.toString("hex"),
          CMB_NATIVE_DESKTOP_NONCE: nonce
        },
        failure: fail
      })
      void controller.exited.then(() => {
        if (!handingOver) fail(new Error("Desktop native owner exited before startup"))
      })
      const worker = await ready
      if (failure || !socket) throw failure ?? new Error("Desktop native stream missing")
      let closing: Promise<void> | undefined
      const awaitKernelClosure = () =>
        (closing ??= (async () => {
          controller!.stop()
          await controller!.exited
          const until = performance.now() + 3000
          for (;;) {
            try {
              await assertPin(directory)
              const actual = nativeDesktopResourceClosure.parse(
                (await readPrivateJson(slot, "closure.json", 32 * 1024)).value
              )
              if (!sameNativeDesktopResource(record!, actual.record))
                throw new Error("Desktop native closure differs from original resource")
              cleanupSocket?.()
              return
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT" || performance.now() >= until)
                throw error
              await delay(25)
            }
          }
        })())
      return {
        identity: {
          nonce,
          jobName: resource.jobName,
          bootId: resource.bootId,
          sessionId: resource.sessionId,
          workerPid: worker.worker.pid,
          desktop: worker.worker.desktop,
          hostId: input.scope.hostId,
          dataEpoch: input.scope.dataEpoch
        },
        policy,
        record,
        stdin: socket,
        stdout: output,
        exited: controller.exited,
        assertCurrent: input.assertCurrentSync,
        verifyMember: async (pid) => {
          await assertCurrent()
          await controller!.verifyMember(pid)
          await assertCurrent()
        },
        stop: () => {
          controller!.stop()
        },
        awaitKernelClosure
      }
    } finally {
      clearTimeout(timer)
      input.signal.removeEventListener("abort", abort)
    }
  } catch (error) {
    controller?.stop()
    cleanupSocket?.()
    // Source-only package/configuration failures occurred before native start;
    // once the native controller may have launched, retain the GUI-specific
    // resource record and propagate uncertainty for Host recovery.
    if (!ownerStarted) {
      try {
        // No native start was attempted. Deleting only our still-pinned fresh
        // paths removes prelaunch records without fabricating kernel closure.
        for (const prepared of [preparedSlot, preparedScratch]) {
          if (!prepared) continue
          await assertPin(prepared)
          await rm(prepared.path, { recursive: true, force: false })
        }
      } catch (cleanupError) {
        throw new NativeDesktopNoAllocationError(
          new AggregateError([error, cleanupError], "Desktop prelaunch cleanup failed")
        )
      }
      throw new NativeDesktopNoAllocationError(error)
    }
    if (controller) await controller.exited
    throw error
  }
}
