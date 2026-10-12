import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { dirname, isAbsolute, join } from "node:path"
import { tmpdir } from "node:os"
import type { CoworkBot } from "../../shared/bot-types"
import type { NativeDesktopScope } from "../../shared/bot-native-desktop"
import { DEFAULT_LINUX_BOT_RESOURCE_LIMITS } from "./linux-bot-cgroup"
import { windowsBotResourceLimits } from "./windows-native-contract"
import { verifyNativeShellPackage } from "./native-shell-package"
import { verifyOwnedShellArtifact } from "./owned-shell-artifact"
import {
  NativeDesktopNoAllocationError,
  type NativeDesktopProcessLease
} from "./native-desktop-transport"
import { launchNativeDesktop } from "./native-desktop-launcher"
import {
  assertWindowsNativeRoot,
  compileTrustedWindowsNativePlan,
  pinWindowsNativeRoot,
  windowsNativeToolRoots,
  windowsNativeModuleRoots,
  windowsNativeDefaultReadRoots,
  type WindowsBotNativeConfiguration
} from "./windows-native-preparation"
import { BOT_NATIVE_DESKTOP_RESOURCE_DIRECTORY } from "./native-desktop-maintenance"

/** Store/workspace/Host data are supplied only by Host startup. No model can
 * supply a workspace root, protected path, package, or entry to this factory. */
export interface WindowsNativeDesktopBinding {
  directory: string
  bootstrap: { entry: string; sha256: string }
  getBot(botId: string): Pick<CoworkBot, "id" | "workspacePath" | "deletedAt">
  sharedWorkspace: { path: string; assertCurrent(): void }
  hostId(): string
  dataEpoch(): string
  protectedRoots(): string[]
  signal: AbortSignal
  assertOperational(): void
  assertCurrentSync(): void
  assertOwnership(signal: AbortSignal): Promise<void>
}

/** Prepares the same strict native policy as Cmb's shell implementation; it
 * never manufactures a shell request/receipt to authorize a persistent GUI. */
export async function createWindowsNativeDesktopFactory(
  binding: WindowsNativeDesktopBinding,
  config: WindowsBotNativeConfiguration
): Promise<(scope: NativeDesktopScope) => Promise<NativeDesktopProcessLease>> {
  try {
    return await prepareWindowsNativeDesktopFactory(binding, config)
  } catch (error) {
    // Factory construction performs metadata/preparation only. It cannot have
    // allocated a Job, so configuration failures must not occupy a surface.
    throw error instanceof NativeDesktopNoAllocationError
      ? error
      : new NativeDesktopNoAllocationError(error)
  }
}

async function prepareWindowsNativeDesktopFactory(
  binding: WindowsNativeDesktopBinding,
  config: WindowsBotNativeConfiguration
): Promise<(scope: NativeDesktopScope) => Promise<NativeDesktopProcessLease>> {
  if (process.platform !== "win32")
    throw new NativeDesktopNoAllocationError(new Error("Windows native desktop requires Windows"))
  binding.assertOperational()
  binding.signal.throwIfAborted()
  await binding.assertOwnership(binding.signal)
  const directory = await realpath(binding.directory),
    host = await pinWindowsNativeRoot(directory)
  const controlRoot = join(directory, BOT_NATIVE_DESKTOP_RESOURCE_DIRECTORY),
    home = join(directory, "native-codex-home")
  for (const path of [controlRoot, home])
    await mkdir(path, { mode: 0o700 }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    })
  const control = await pinWindowsNativeRoot(controlRoot),
    homePin = await pinWindowsNativeRoot(home)
  const pkg = await verifyNativeShellPackage(
    config.packageDirectory,
    config.manifestSha256,
    binding.signal
  )
  if (
    !pkg.desktopWorker ||
    pkg.desktopWorker.runtimeMode !== "readonly-installed" ||
    pkg.desktopWorker.assets.length === 0 ||
    !pkg.setup ||
    !pkg.jobOwner ||
    pkg.manifest.desktopOwnerProtocol !== "cmb-native-desktop-owner-v1"
  )
    throw new NativeDesktopNoAllocationError(new Error("Desktop native distribution is incomplete"))
  await verifyOwnedShellArtifact(binding.bootstrap)
  const moduleRoots = await windowsNativeModuleRoots([binding.bootstrap.entry])
  const codeRoots = [
    ...moduleRoots,
    ...(await Promise.all(
      [
        ...new Set([
          dirname(binding.bootstrap.entry),
          pkg.directory,
          dirname(await realpath(process.execPath))
        ])
      ].map(pinWindowsNativeRoot)
    ))
  ]
  const limits = windowsBotResourceLimits.parse(
    config.resourceLimits ?? DEFAULT_LINUX_BOT_RESOURCE_LIMITS
  )
  const assertHost = async () => {
    binding.signal.throwIfAborted()
    binding.assertOperational()
    binding.assertCurrentSync()
    await binding.assertOwnership(binding.signal)
    for (const pin of [host, control, homePin]) await assertWindowsNativeRoot(pin)
    await pkg.assertCurrent(binding.signal)
    binding.assertCurrentSync()
  }
  await assertHost()
  return async (scope) => {
    let attemptedNative = false
    let scratch: Awaited<ReturnType<typeof pinWindowsNativeRoot>> | undefined
    const cleanup = async () => {
      if (!scratch) return
      await assertWindowsNativeRoot(scratch)
      await rm(scratch.path, { recursive: true, force: false })
      scratch = undefined
    }
    try {
      await assertHost()
      const hostId = binding.hostId(),
        dataEpoch = binding.dataEpoch()
      if (scope.hostId !== hostId || scope.dataEpoch !== dataEpoch)
        throw new Error("Desktop scope differs from current Host ownership")
      const bot = binding.getBot(scope.botId)
      if (bot.id !== scope.botId || bot.deletedAt !== null)
        throw new Error("Desktop Bot is unavailable")
      const declaredWorkspace = bot.workspacePath ?? binding.sharedWorkspace.path
      if (!isAbsolute(declaredWorkspace)) throw new Error("Desktop Bot workspace must be absolute")
      if (declaredWorkspace === binding.sharedWorkspace.path)
        binding.sharedWorkspace.assertCurrent()
      const workspace = await pinWindowsNativeRoot(declaredWorkspace)
      const temporary = await realpath(await mkdtemp(join(tmpdir(), "cmb-bot-desktop-")))
      scratch = await pinWindowsNativeRoot(temporary)
      const deniedRoots = await Promise.all(
        [...new Set([directory, ...binding.protectedRoots()])].map(pinWindowsNativeRoot)
      )
      const toolRoots = await windowsNativeToolRoots(),
        platformRoots = await windowsNativeDefaultReadRoots()
      const plan = await compileTrustedWindowsNativePlan({
        pkg,
        codexHome: home,
        cwd: workspace.path,
        workspace,
        readRoots: [workspace, scratch, ...toolRoots, ...codeRoots, ...platformRoots],
        writeRoots: [workspace, scratch],
        deniedRoots,
        codeRoots,
        hostId,
        dataEpoch
      })
      const assertCurrentSync = () => {
        binding.assertCurrentSync()
        const current = binding.getBot(scope.botId)
        if (
          binding.hostId() !== hostId ||
          binding.dataEpoch() !== dataEpoch ||
          current.deletedAt !== null ||
          (current.workspacePath ?? binding.sharedWorkspace.path) !== declaredWorkspace
        )
          throw new Error("Desktop Bot authorization changed")
        if (declaredWorkspace === binding.sharedWorkspace.path)
          binding.sharedWorkspace.assertCurrent()
      }
      await assertHost()
      assertCurrentSync()
      attemptedNative = true
      const lease = await launchNativeDesktop({
        scope,
        plan,
        packageDirectory: pkg.directory,
        manifestSha256: pkg.manifestSha256,
        bootstrap: binding.bootstrap,
        controlRoot,
        scratchRoot: scratch.path,
        resourceLimits: limits,
        signal: binding.signal,
        assertOperational: () => binding.assertOperational(),
        assertCurrentSync,
        assertOwnership: async (signal) => {
          await binding.assertOwnership(signal)
          await assertWindowsNativeRoot(workspace)
          if ((await realpath(declaredWorkspace)) !== workspace.path)
            throw new Error("Desktop workspace alias changed")
          assertCurrentSync()
        }
      })
      let closed: Promise<void> | undefined
      return {
        ...lease,
        awaitKernelClosure: () =>
          (closed ??= (async () => {
            // EOF or a leader PID cannot release scratch/records. Physical Job
            // emptiness must be proven by the actual external native owner.
            await lease.awaitKernelClosure()
            await cleanup()
            await assertWindowsNativeRoot(lease.record.directory)
            await rm(lease.record.directory.path, { recursive: true, force: false })
          })())
      }
    } catch (error) {
      if (!attemptedNative || error instanceof NativeDesktopNoAllocationError) {
        try {
          await cleanup()
        } catch (cleanupError) {
          throw new NativeDesktopNoAllocationError(
            new AggregateError([error, cleanupError], "Desktop preparation cleanup failed")
          )
        }
        throw error instanceof NativeDesktopNoAllocationError
          ? error
          : new NativeDesktopNoAllocationError(error)
      }
      // Actual native start may have happened. Retain its private record and
      // scratch for proof-driven maintenance rather than deleting live data.
      throw error
    }
  }
}
