import {
  assertLinuxBotDelegation,
  linuxBotResourceLimits,
  DEFAULT_LINUX_BOT_RESOURCE_LIMITS
} from "./linux-bot-cgroup"
import { createHash } from "node:crypto"
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { dirname, isAbsolute, join, relative } from "node:path"
import { pathToFileURL } from "node:url"
import { tmpdir } from "node:os"
import type { BotHostShellBinding } from "./host-shell-factory"
import type { BotShellOwnedFactory } from "./shell-process"
import { BOT_OWNED_SHELL_RESOURCE_DIRECTORY } from "./owned-shell-maintenance-fence"
import { verifyNativeShellPackage } from "./native-shell-package"
import { compileBotPlatformPreparation, type BotPlatformRootPin } from "./bot-strict-platform"
import { nativeShellPlan } from "./native-shell-contract"
import { botShellReadOnly, type BotShellRequest } from "./shell-contract"

export interface LinuxBotShellConfiguration {
  packageDirectory: string
  manifestSha256: string
  resourceLimits?: { pids: number; memoryBytes: number }
  delegatedCgroupDirectory: string
}
const inside = (root: string, path: string) => {
  const part = relative(root, path)
  return part === "" || (part !== ".." && !part.startsWith("../") && !isAbsolute(part))
}
async function pin(path: string): Promise<BotPlatformRootPin> {
  const canonical = await realpath(path),
    current = await lstat(canonical, { bigint: true })
  if (!current.isDirectory() || current.isSymbolicLink())
    throw new Error("Bot native directory is invalid")
  return { path: canonical, dev: String(current.dev), ino: String(current.ino) }
}
async function assertPin(value: BotPlatformRootPin): Promise<void> {
  const now = await lstat(value.path, { bigint: true })
  if (
    !now.isDirectory() ||
    now.isSymbolicLink() ||
    String(now.dev) !== value.dev ||
    String(now.ino) !== value.ino ||
    (await realpath(value.path)) !== value.path
  )
    throw new Error("Bot native directory changed")
}
/** All configuration comes from the trusted Host startup. Native first-use
 * preparation is executed by the authenticated worker before its prepared ACK;
 * this function never asserts that static platform metadata passed a probe. */
export async function createLinuxBotHostShellFactory(
  binding: BotHostShellBinding,
  config: LinuxBotShellConfiguration,
  artifacts: {
    helper: { entry: string; sha256: string }
    worker: { entry: string; sha256: string }
    signal?: AbortSignal
  }
): Promise<BotShellOwnedFactory> {
  if (process.platform !== "linux") throw new Error("Linux native Host preparation requires Linux")
  const limits = linuxBotResourceLimits.parse(
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
  const control = await pin(controlRoot),
    delegated = await pin(config.delegatedCgroupDirectory)
  await assertLinuxBotDelegation(delegated.path)
  const pkg = await verifyNativeShellPackage(
    config.packageDirectory,
    config.manifestSha256,
    ownerSignal
  )
  if (pkg.manifest.platform !== "linux" || !pkg.bwrap)
    throw new Error("Linux native package is incomplete")
  const home = join(directory, "native-codex-home")
  await mkdir(home, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error
  })
  const homePin = await pin(home)
  const codeRoots = await Promise.all(
    [
      ...new Set([
        dirname(artifacts.helper.entry),
        dirname(artifacts.worker.entry),
        pkg.directory,
        dirname(await realpath(process.execPath))
      ])
    ].map(pin)
  )
  const assertCurrent = async (signal: AbortSignal) => {
    signal.throwIfAborted()
    await binding.assertOwnership(signal)
    for (const root of [host, control, delegated, homePin]) await assertPin(root)
    for (const path of [directory, controlRoot, home]) {
      const now = await lstat(path, { bigint: true })
      if ((now.mode & 0o077n) !== 0n || (process.getuid && now.uid !== BigInt(process.getuid())))
        throw new Error("Bot native control directory is not private")
    }
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
        [...new Set([directory, delegated.path, ...(request.protectedRoots ?? [])])].map(pin)
      )
      if (denied.some((root) => inside(root.path, workspace.path)))
        throw new Error("Bot protected directory cannot be a command workspace")
      const toolRoots: BotPlatformRootPin[] = []
      const toolPaths = [
        ...new Set(
          (process.env.PATH ?? "").split(":").filter((path) => isAbsolute(path) && path !== "/")
        )
      ]
      if (toolPaths.length > 32) throw new Error("Bot native PATH authorization exceeds its limit")
      for (const path of toolPaths) {
        try {
          const current = await pin(path)
          if (current.path !== "/") toolRoots.push(current)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
      }
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
      const preparation = await compileBotPlatformPreparation(
        {
          platform: "linux",
          arch: process.arch,
          cwd: workspace,
          readRoots: [workspace, ...shared, scratch, ...toolRoots, ...codeRoots],
          writeRoots: [
            scratch,
            ...(botShellReadOnly(request, "linux") ? [] : [workspace, ...shared])
          ],
          deniedRoots: denied,
          network: true,
          capability: {
            filesystem: "codex-linux-bwrap-split-v1",
            lifetime: "verified-linux-cgroup-v2",
            readDeny: false,
            controlChannelDeny: false,
            kernelProbe: "source-only",
            helperSha256: pkg.nativeHelper.sha256,
            sourceRevision: pkg.manifest.revision,
            helperProtocol: pkg.manifest.protocol,
            linuxHelperPath: pkg.nativeHelper.entry,
            linuxHelperSha256: pkg.nativeHelper.sha256,
            bwrapSha256: pkg.bwrap!.sha256
          }
        },
        {
          platform: "linux",
          arch: process.arch,
          inside,
          toFileURL: (path) => pathToFileURL(path).href,
          assertPinned: assertPin
        }
      )
      const actualPolicy = JSON.parse(preparation.policy)
      actualPolicy.sandboxCwd = pathToFileURL(request.cwd).href
      const policy = JSON.stringify(actualPolicy)
      const plan = nativeShellPlan.parse({
        format: 1,
        platform: "linux",
        arch: process.arch,
        revision: pkg.manifest.revision,
        cli: pkg.cli,
        nativeHelper: pkg.nativeHelper,
        bwrap: pkg.bwrap,
        codexHome: home,
        cwd: request.cwd,
        startupCwd: workspace.path,
        policy,
        policySha256: createHash("sha256").update(policy).digest("hex"),
        roots: preparation.pins,
        artifactPins: pkg.artifactPins,
        preparationBinding: createHash("sha256")
          .update(
            JSON.stringify({
              manifest: pkg.manifestSha256,
              policy: preparation.profile.policySha256,
              hostId,
              dataEpoch
            })
          )
          .digest("hex")
      })
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
        linuxDelegatedRoot: delegated.path,
        linuxResourceLimits: limits,
        origin: {
          hostId,
          dataEpoch,
          policySha256: createHash("sha256")
            .update(
              JSON.stringify({
                profile: preparation.profile,
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
