import { createHash } from "node:crypto"
import { lstat, mkdir, realpath } from "node:fs/promises"
import { createRequire } from "node:module"
import { join, resolve, dirname } from "node:path"
import { prepareMacBotShell } from "./mac-shell-sandbox"
import { BOT_OWNED_SHELL_RESOURCE_DIRECTORY } from "./owned-shell-maintenance-fence"
import { readBotOwnedShellArtifact, type BotHostShellBinding } from "./host-shell-factory"
import type { BotShellOwnedFactory } from "./shell-process"
import type { OwnedShellProcessOptions } from "./owned-shell-process"

/** Explicit physical fault-test compiler only. Production Host has no import
 * or environment switch to reach this inherited-process test backend. */
export async function createTrustedMacBotHostShellTestFactory(
  binding: BotHostShellBinding
): Promise<BotShellOwnedFactory> {
  if (process.platform !== "darwin") throw new Error("Mac physical Shell fixture requires macOS")
  const directory = await realpath(binding.directory)
  if (directory !== resolve(binding.directory)) throw new Error("Bot 后台目录含路径别名")
  const hostPin = await lstat(directory, { bigint: true })
  const controlRoot = join(directory, BOT_OWNED_SHELL_RESOURCE_DIRECTORY)
  await binding.assertOwnership(new AbortController().signal)
  await mkdir(controlRoot, { mode: 0o700 }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  })
  const controlPin = await lstat(controlRoot, { bigint: true })
  const helper = await readBotOwnedShellArtifact(binding.helperEntry),
    worker = await readBotOwnedShellArtifact(binding.workerEntry)
  // External modules can live in a separately installed service root. Resolve
  // the actual module directory once from the immutable worker location; this
  // is a Host read grant, not a request or writable PATH grant.
  const modules = createRequire(worker.entry).resolve("zod/package.json")
  const runtimeReadRoots = [await realpath(dirname(dirname(modules)))]
  const assertRoots = async (signal: AbortSignal) => {
    signal.throwIfAborted()
    await binding.assertOwnership(signal)
    for (const [path, pin] of [
      [directory, hostPin],
      [controlRoot, controlPin]
    ] as const) {
      const current = await lstat(path, { bigint: true })
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== pin.dev ||
        current.ino !== pin.ino ||
        (await realpath(path)) !== path ||
        (process.getuid && current.uid !== BigInt(process.getuid())) ||
        (current.mode & 0o077n) !== 0n
      )
        throw new Error("Bot 命令私有目录发生变化")
    }
    signal.throwIfAborted()
  }
  await assertRoots(new AbortController().signal)
  return async (request, signal): Promise<OwnedShellProcessOptions> => {
    await assertRoots(signal)
    const hostId = binding.hostId(),
      dataEpoch = binding.dataEpoch()
    // Worktree skill copies are materialized only after the trusted commit.
    // Bootstrap from the already-authorized project, never from an absent
    // future copy directory or an arbitrary parent chosen by the command.
    const startupCwd = await realpath(request.workspaceRoot ?? request.cwd)
    const startupPin = await lstat(startupCwd, { bigint: true })
    if (!startupPin.isDirectory() || startupPin.isSymbolicLink())
      throw new Error("Bot 命令启动工作区不是有效目录")
    const assertStartupCwd = async () => {
      const now = await lstat(startupCwd, { bigint: true })
      if (
        !now.isDirectory() ||
        now.isSymbolicLink() ||
        now.dev !== startupPin.dev ||
        now.ino !== startupPin.ino ||
        (await realpath(startupCwd)) !== startupCwd
      )
        throw new Error("Bot 命令启动工作区发生变化")
    }
    const prepared = await prepareMacBotShell(
      {
        ...request,
        protectedRoots: [directory, ...(request.protectedRoots ?? [])]
      },
      { entry: worker.entry, executable: process.execPath },
      runtimeReadRoots,
      // Rollup emits sibling chunks. Protect the actual installed code only;
      // the package/project root can still contain editable user source.
      [dirname(helper.entry), dirname(worker.entry)]
    )
    try {
      await assertRoots(signal)
      const launch = {
        entry: worker.entry,
        entrySha256: worker.sha256,
        cwd: request.cwd,
        startupCwd,
        executable: prepared.launcher.executable!,
        execArgv: prepared.launcher.execArgv ?? [],
        environment: Object.fromEntries(
          Object.entries(prepared.launcher.environment ?? {}).filter(
            (item): item is [string, string] => typeof item[1] === "string"
          )
        )
      }
      const policySha256 = createHash("sha256")
        .update(
          JSON.stringify({
            format: 1,
            platform: "darwin",
            arch: process.arch,
            filesystem: "macos-seatbelt-v1",
            lifetime: "controlled-inherited-group",
            helper: helper.sha256,
            worker: worker.sha256,
            hostPin: { dev: String(hostPin.dev), ino: String(hostPin.ino) },
            controlPin: {
              dev: String(controlPin.dev),
              ino: String(controlPin.ino)
            },
            launch
          })
        )
        .digest("hex")
      return {
        helper,
        launch,
        controlRoot,
        origin: { hostId, dataEpoch, policySha256 },
        assertCurrent: async (guardSignal) => {
          await assertRoots(guardSignal)
          await assertStartupCwd()
          if (binding.hostId() !== hostId || binding.dataEpoch() !== dataEpoch)
            throw new Error("Bot 命令运行环境已经变化")
        },
        releasePrepared: async (knownClosed) => {
          if (knownClosed) await prepared.close()
        }
      }
    } catch (error) {
      await prepared.close()
      throw error
    }
  }
}
