import { createHash } from "node:crypto"
import { lstat, realpath } from "node:fs/promises"
import { basename, win32, isAbsolute } from "node:path"
import type { ProcessProtocol } from "../agent/process-protocol"
import { nativeShellPlan, type NativeShellPlan } from "./native-shell-contract"

export interface BotNativeCommandInput {
  command: string
  shell: string
  isWindows: boolean
  cwd: string
  protocol?: ProcessProtocol
  signal?: AbortSignal
}
export interface BotNativeCommandLaunch {
  protocol: ProcessProtocol
  /** Only the native parent receives its provisioning home. The command is
   * denied that directory by the split profile regardless of ambient env. */
  environment: Record<string, string>
}
export type BotNativeCommandAdapter = (
  input: BotNativeCommandInput
) => Promise<BotNativeCommandLaunch>
function commandArguments(input: BotNativeCommandInput): { args: string[]; stdin: string } {
  if (input.protocol) {
    if (!input.protocol.shell)
      return {
        args: [input.protocol.executable, ...input.protocol.args],
        stdin: input.protocol.stdin
      }
    // The original Windows default Hook is a cmd shell string. Preserve that
    // exact interpreter boundary; credentials remain in trusted argv and are
    // never converted into helper shell/eval source.
    if (!input.isWindows || input.protocol.args.length)
      throw new Error("Bot 原生命令不支持此 Hook 启动方式")
    return {
      args: [input.shell, "/d", "/s", "/c", input.protocol.executable],
      stdin: input.protocol.stdin
    }
  }
  const shell = (input.isWindows ? win32.basename(input.shell) : basename(input.shell))
    .replace(/\.exe$/i, "")
    .toLowerCase()
  if (input.isWindows && ["bash", "sh", "zsh"].includes(shell))
    return { args: [input.shell], stdin: input.command + "\n" }
  if (input.isWindows && ["powershell", "pwsh"].includes(shell))
    return {
      args: [input.shell, "-NoProfile", "-NonInteractive", "-Command", input.command],
      stdin: ""
    }
  if (input.isWindows && shell === "cmd")
    return { args: [input.shell, "/d", "/s", "/c", input.command], stdin: "" }
  if (!input.isWindows) return { args: [input.shell, "-c", input.command], stdin: "" }
  throw new Error("Bot 原生命令解释器未接通")
}
export async function assertNativeShellRoots(
  plan: NativeShellPlan,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  for (const root of plan.roots) {
    const current = await lstat(root.path, { bigint: true })
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      String(current.dev) !== root.dev ||
      String(current.ino) !== root.ino ||
      (await realpath(root.path)) !== root.path
    )
      throw new Error("Bot 原生命令授权目录发生变化")
  }
  signal?.throwIfAborted()
}
/** Installed only by the authenticated owner before a real worker request.
 * Every LocalSandbox ordinary/Hook/background spawn uses this same adapter.
 * Legacy Cmb has no adapter, retaining its existing executor and defaults. */
export function createBotNativeCommandAdapter(
  raw: unknown,
  assertArtifacts: (signal?: AbortSignal) => Promise<void>
): BotNativeCommandAdapter {
  const plan = nativeShellPlan.parse(raw)
  if (
    (plan.platform === "linux" && !plan.bwrap) ||
    plan.platform !== process.platform ||
    plan.arch !== process.arch ||
    createHash("sha256").update(plan.policy).digest("hex") !== plan.policySha256
  )
    throw new Error("Bot 原生命令策略身份不匹配")
  const state = JSON.parse(plan.policy)
  if (
    state.permissionProfile?.type !== "managed" ||
    state.permissionProfile.file_system?.type !== "restricted" ||
    state.useLegacyLandlock !== false
  )
    throw new Error("Bot 原生命令必须使用严格拆分策略")
  return async (input) => {
    input.signal?.throwIfAborted()
    if (
      input.isWindows !== (plan.platform === "win32") ||
      input.cwd !== plan.cwd ||
      !isAbsolute(input.cwd) ||
      (await realpath(input.cwd)) !== input.cwd
    )
      throw new Error("Bot 原生命令工作目录不匹配")
    await assertNativeShellRoots(plan, input.signal)
    await assertArtifacts(input.signal)
    const invocation = commandArguments(input)
    const args = [
      "-c",
      'shell_environment_policy.inherit="all"',
      "-c",
      "shell_environment_policy.ignore_default_excludes=true",
      "-c",
      "shell_environment_policy.exclude=[]",
      "-c",
      "shell_environment_policy.include_only=[]",
      ...(plan.platform === "win32" ? ["-c", 'windows.sandbox="elevated"'] : []),
      "sandbox",
      plan.platform === "win32" ? "windows" : "linux",
      "--sandbox-state-json",
      plan.policy,
      "--",
      ...invocation.args
    ]
    if (
      args.length > 160 ||
      args.some((arg) => arg.includes("\0")) ||
      args.reduce((n, arg) => n + Buffer.byteLength(arg), 0) > 256 * 1024
    )
      throw new Error("Bot 原生命令启动参数过长")
    // Conservative encoded argv cap precedes CreateProcessW. It refuses the
    // command, and never retries without its managed filesystem profile.
    if (
      plan.platform === "win32" &&
      args.reduce((n, arg) => n + arg.length * 2 + 3, plan.cli.entry.length + 1) > 32767
    )
      throw new Error("Bot 目录授权和命令参数超过 Windows 启动上限")
    input.signal?.throwIfAborted()
    return {
      protocol: {
        executable: plan.cli.entry,
        args,
        shell: false,
        sensitiveArguments: true,
        stdin: invocation.stdin,
        onOutput: input.protocol?.onOutput ?? (() => {}),
        onInputFailure: input.protocol?.onInputFailure
      },
      environment: {
        ...(plan.platform === "win32" ? { CMB_BOT_RESOURCE_JOB: strictWindowsJobName() } : {}),
        CODEX_HOME: plan.codexHome,
        // Fixed source fork chooses only its digest-verified bundled bwrap;
        // ambient PATH remains available to approved commands, never to this
        // kernel helper selection. Missing flag support fails native probing.
        ...(plan.platform === "linux" ? { CMB_BOT_PINNED_BWRAP: "1" } : {})
      }
    }
  }
}
export const nativeCommandArgumentsForTest = commandArguments

function strictWindowsJobName(): string {
  const name = process.env.CMB_BOT_RESOURCE_JOB
  if (
    !name ||
    !/^Local\\CMBDevClaw-Bot-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      name
    )
  )
    throw new Error("Bot elevated command has no actual native Job owner")
  return name
}

/** Hashes are checked once by the independently pinned package reader. The
 * per-command worker verifies these same descriptors without rehashing 100MiB
 * binaries; kernel read-only mounts protect runtime files while commands run. */
export async function assertNativeShellArtifacts(
  plan: NativeShellPlan,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  for (const pin of plan.artifactPins) {
    const now = await lstat(pin.entry, { bigint: true })
    if (
      !now.isFile() ||
      now.isSymbolicLink() ||
      now.nlink !== 1n ||
      (await realpath(pin.entry)) !== pin.entry ||
      ["dev", "ino", "size", "mtimeNs", "ctimeNs"].some(
        (key) => String(now[key as keyof typeof now]) !== pin[key as keyof typeof pin]
      )
    )
      throw new Error("Native artifact changed after trusted package verification")
  }
  signal?.throwIfAborted()
}
