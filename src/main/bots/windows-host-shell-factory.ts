import { windowsBotResourceLimits } from "./windows-native-contract"
import { probeWindowsBotNativeOwner } from "./windows-native-resource"
import { DEFAULT_LINUX_BOT_RESOURCE_LIMITS } from "./linux-bot-cgroup"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import type { BotHostShellBinding } from "./host-shell-factory"
import type { BotShellOwnedFactory } from "./shell-process"
import { BOT_OWNED_SHELL_RESOURCE_DIRECTORY } from "./owned-shell-maintenance-fence"
import { verifyNativeShellPackage } from "./native-shell-package"
import { botShellReadOnly, type BotShellRequest } from "./shell-contract"
import {
  insideWindowsNativeRoot as inside,
  pinWindowsNativeRoot as pin,
  assertWindowsNativeRoot as assertPin,
  windowsNativeToolRoots,
  windowsNativeModuleRoots,
  compileTrustedWindowsNativePreparation,
  type WindowsBotNativeConfiguration
} from "./windows-native-preparation"

export type WindowsBotShellConfiguration = WindowsBotNativeConfiguration
/** All configuration comes from the trusted Host startup. Native first-use
 * preparation is executed by the authenticated worker before its prepared ACK;
 * this function never asserts that static platform metadata passed a probe. */
export async function createWindowsBotHostShellFactory(
  binding: BotHostShellBinding,
  config: WindowsBotShellConfiguration,
  artifacts: {
    helper: { entry: string; sha256: string }
    worker: { entry: string; sha256: string }
    signal?: AbortSignal
  }
): Promise<BotShellOwnedFactory> {
  if (process.platform !== "win32")
    throw new Error("Windows native Host preparation requires Windows")
  const limits = windowsBotResourceLimits.parse(
    config.resourceLimits ?? DEFAULT_LINUX_BOT_RESOURCE_LIMITS
  )
  const directory = await realpath(binding.directory),
    host = await pin(directory)
  const ownerSignal = artifacts.signal ?? new AbortController().signal
  await binding.assertOwnership(ownerSignal)
  const controlRoot = join(directory, BOT_OWNED_SHELL_RESOURCE_DIRECTORY)
  await mkdir(controlRoot, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error
  })
  const control = await pin(controlRoot)
  const pkg = await verifyNativeShellPackage(
    config.packageDirectory,
    config.manifestSha256,
    ownerSignal
  )
  if (
    pkg.manifest.platform !== "win32" ||
    !pkg.setup ||
    !pkg.jobOwner ||
    pkg.manifest.ownerProtocol !== "cmb-atomic-windows-job-v2"
  )
    throw new Error("Windows atomic native package is incomplete")
  const capabilities = await probeWindowsBotNativeOwner(pkg.jobOwner!, ownerSignal)
  const home = join(directory, "native-codex-home")
  await mkdir(home, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error
  })
  const homePin = await pin(home)
  const moduleRoots = await windowsNativeModuleRoots([
    artifacts.helper.entry,
    artifacts.worker.entry
  ])
  const codeRoots = [
    ...moduleRoots,
    ...(await Promise.all(
      [
        ...new Set([
          dirname(artifacts.helper.entry),
          dirname(artifacts.worker.entry),
          pkg.directory,
          dirname(await realpath(process.execPath))
        ])
      ].map(pin)
    ))
  ]
  const assertCurrent = async (signal: AbortSignal) => {
    signal.throwIfAborted()
    await binding.assertOwnership(signal)
    for (const root of [host, control, homePin]) await assertPin(root)
    await pkg.assertCurrent(signal)
    signal.throwIfAborted()
  }
  await assertCurrent(ownerSignal)
  return async (request: BotShellRequest, signal: AbortSignal) => {
    await assertCurrent(signal)
    const hostId = binding.hostId(),
      dataEpoch = binding.dataEpoch()
    const workspace = await pin(
      request.worktree?.workspaceRoot ?? request.workspaceRoot ?? request.cwd
    )
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "cmb-bot-command-")))
    const scratch = await pin(temporary)
    const close = async () => {
      await assertPin(scratch)
      await rm(temporary, { recursive: true, force: false })
    }
    try {
      const scratchHome = join(temporary, "home")
      await mkdir(scratchHome, { mode: 0o700 })
      const denied = await Promise.all(
        [...new Set([directory, ...(request.protectedRoots ?? [])])].map(pin)
      )
      if (denied.some((root) => inside(root.path, workspace.path)))
        throw new Error("Bot protected directory cannot be a command workspace")
      const toolRoots = await windowsNativeToolRoots()
      const shared = request.worktree ? [await pin(request.worktree.commonDir)] : []
      if (
        [workspace, ...shared].some((write) =>
          codeRoots.some((code) => inside(code.path, write.path))
        )
      )
        throw new Error("Bot command workspace must not be inside installed runtime code")
      // Bootstrap compilation is private preparation, not a capability verdict.
      // The actual kernel witness and filesystem/control probe are mandatory
      // before OwnedShellProcess admits the first user command.
      const prepared = await compileTrustedWindowsNativePreparation({
        pkg,
        codexHome: home,
        cwd: request.cwd,
        workspace,
        readRoots: [workspace, ...shared, scratch, ...toolRoots, ...codeRoots],
        writeRoots: [
          scratch,
          ...(botShellReadOnly(request, "win32") ? [] : [workspace, ...shared])
        ],
        deniedRoots: denied,
        codeRoots,
        hostId,
        dataEpoch
      })
      const plan = prepared.plan
      await assertCurrent(signal)
      return {
        helper: artifacts.helper,
        launch: {
          entry: artifacts.worker.entry,
          entrySha256: artifacts.worker.sha256,
          cwd: request.cwd,
          startupCwd: workspace.path,
          executable: process.execPath,
          execArgv: [],
          nativePlan: plan,
          environment: {
            TMPDIR: temporary,
            TMP: temporary,
            TEMP: temporary,
            HOME: scratchHome,
            CMB_BOT_COMMAND_SCRATCH: temporary
          }
        },
        controlRoot,
        windowsNative: { artifact: pkg.jobOwner!, capabilities, limits },
        origin: {
          hostId,
          dataEpoch,
          policySha256: createHash("sha256")
            .update(
              JSON.stringify({
                profile: prepared.profile,
                manifest: pkg.manifestSha256,
                helper: artifacts.helper.sha256,
                worker: artifacts.worker.sha256
              })
            )
            .digest("hex")
        },
        assertCurrent: async (currentSignal: AbortSignal) => {
          await assertCurrent(currentSignal)
          await assertPin(workspace)
          await assertPin(scratch)
          if (binding.hostId() !== hostId || binding.dataEpoch() !== dataEpoch)
            throw new Error("Bot native environment changed")
        },
        releasePrepared: async (knownClosed: boolean) => {
          if (knownClosed) await close()
        }
      }
    } catch (error) {
      await close()
      throw error
    }
  }
}
