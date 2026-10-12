import { nativeShellWorkerConfiguration, type NativeShellPlan } from "./native-shell-contract"
import {
  createBotNativeCommandAdapter,
  assertNativeShellArtifacts,
  assertNativeShellRoots
} from "./native-shell-command"
import {
  nativeIsolationProbeInvocation,
  readNativeIsolationProbe
} from "./native-shell-probe-command"
import { OwnedShellWorkerOutput } from "./owned-shell-worker-output"
import { safeSensitiveErrorText } from "../error-text"
import { basename, isAbsolute, join, resolve } from "node:path"
import { access, rm } from "node:fs/promises"
import { createLocalSandboxClass } from "../agent/local-sandbox-core"
import * as windows from "../agent/windows-sandbox-state"
import { ensureCodexExe } from "../agent/codex-sandbox-binary"
import { assessCommandSafety, getWorktreeShellIsolationViolation } from "../agent/exec-policy"
import { hookCommandInvocation } from "../hooks/command-invocation"
import { decodeHookOutput } from "../hooks/command-output"
import {
  botHookEnvironment,
  botShellEnvironment,
  botShellRequestSchema,
  botShellReadOnly
} from "./shell-contract"
import { botWorktreeSkillRoot, materializeBotWorktreeSkill } from "./worktree-skill"
import { executeBotBackgroundShell } from "./shell-background"

// This worker has no Mods or plugin hook namespace. The desktop executor keeps
// its existing service ports; exposing those capabilities here requires their
// real authorization adapter, never a mock Electron renderer.
const Sandbox = createLocalSandboxClass({
  ...windows,
  getWindowsSandboxMode: () => {
    throw new Error("Shell requires an explicit sandbox mode")
  },
  runElevatedSetupForPaths: async () => ({
    success: false,
    error: "请先在 CMBDevClaw 沙箱设置中完成管理员初始化"
  })
})
const controller = new AbortController()
// Only the trusted outer helper assigns this mode. It is never in the request,
// hook environment, or model-controlled command environment.
const resourceNonce = process.env.CMB_BOT_SHELL_RESOURCE_NONCE
const resourceOwnerPid = process.env.CMB_BOT_SHELL_RESOURCE_PID
const ownedResource = resourceNonce !== undefined || resourceOwnerPid !== undefined
if (
  ownedResource &&
  (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(resourceNonce ?? "") ||
    !/^[1-9][0-9]{0,9}$/.test(resourceOwnerPid ?? "") ||
    Number(resourceOwnerPid) !== process.ppid)
)
  throw new Error("Shell lifetime owner binding is invalid")
// Only the trusted launcher may assign a disposable directory. Ambient TMPDIR
// alone is never cleanup authority (the worker also runs without this wrapper).
const scratch = process.env.CMB_BOT_COMMAND_SCRATCH
if (
  scratch &&
  (!isAbsolute(scratch) ||
    resolve(scratch) !== scratch ||
    scratch !== process.env.TMPDIR ||
    !/^cmb-bot-command-[a-zA-Z0-9]{6}$/.test(basename(scratch)))
)
  throw new Error("命令临时目录标识无效")
let nativeConfiguration: ReturnType<typeof nativeShellWorkerConfiguration.parse> | undefined
let started = false
let prepared = false
let committed = false
let acceptCommit: (() => void) | undefined
/** Preparation may await runtime configuration, but cannot materialize a Hook
 * or run its command until the trusted owner commits this exact resource. */
async function awaitOwnedCommit(): Promise<void> {
  if (!ownedResource) return
  controller.signal.throwIfAborted()
  await new Promise<void>((resolveCommit, rejectCommit) => {
    const abort = (): void =>
      finish(controller.signal.reason ?? new Error("Shell preparation cancelled"))
    const finish = (error?: unknown): void => {
      controller.signal.removeEventListener("abort", abort)
      acceptCommit = undefined
      if (error !== undefined) rejectCommit(error)
      else resolveCommit()
    }
    acceptCommit = () => finish()
    prepared = true
    controller.signal.addEventListener("abort", abort, { once: true })
    process.send!({ prepared: true }, (error: Error | null) => {
      if (error) finish(error)
    })
    if (controller.signal.aborted) abort()
  })
  controller.signal.throwIfAborted()
}
let stopping: Promise<boolean> | undefined
let cleanupRunId: string | undefined
const cleanup = () =>
  (stopping ??= (async () => {
    controller.abort()
    const clean = ownedResource
      ? await Sandbox.stopOwnedLeadersAndWait(5000)
      : await Sandbox.killAllAndWait(5000)
    if (cleanupRunId) await Sandbox.revokeGrantedAclsForRun(cleanupRunId)
    // The parent may already have died, so its finally handler cannot own this
    // cleanup alone. Join descendants before removing their home/cache files.
    if (clean && scratch && !ownedResource) {
      try {
        await rm(scratch, { recursive: true, force: true })
      } catch {
        return false
      }
    }
    return clean
  })())

const ownedOutput = ownedResource
  ? new OwnedShellWorkerOutput(() => {
      void cleanup().finally(() => process.exit(1))
    })
  : undefined
if (!process.send) throw new Error("Bot shell worker requires its authenticated parent IPC channel")
process.once("disconnect", () => {
  void cleanup().finally(() => process.exit(1))
})
process.once("SIGTERM", () => {
  void cleanup().finally(() => process.exit(1))
})
process.on("message", (message: unknown) => {
  if (message && typeof message === "object" && "nativePlan" in message) {
    if (!ownedResource || started || nativeConfiguration)
      return void cleanup().finally(() => process.exit(1))
    try {
      nativeConfiguration = nativeShellWorkerConfiguration.parse(message)
    } catch {
      void cleanup().finally(() => process.exit(1))
    }
    return
  }
  if (message && typeof message === "object" && "cancel" in message) {
    void cleanup()
    return
  }
  if (message && typeof message === "object" && "commit" in message) {
    if (
      !ownedResource ||
      !started ||
      !prepared ||
      committed ||
      !acceptCommit ||
      Object.keys(message).length !== 1 ||
      message.commit !== resourceNonce
    ) {
      void cleanup().finally(() => process.exit(1))
      return
    }
    committed = true
    acceptCommit()
    return
  }
  if (started) return
  started = true
  void (async () => {
    const request = botShellRequestSchema.parse(message)
    cleanupRunId = request.runId
    if (!isAbsolute(request.cwd) || !isAbsolute(request.execution.resourceDirectory))
      throw new Error("Shell paths must be absolute")
    const mode = process.platform === "win32" ? request.execution.windowsSandbox : "none"
    const executable = join(request.execution.resourceDirectory, "bin", "win32", "codex.exe")
    if (mode !== "none" && !nativeConfiguration) {
      await ensureCodexExe(executable)
      await access(executable) // Never fall back to PATH or an unsandboxed command.
    }
    if (!nativeConfiguration) await Sandbox.ensureShellReady(mode)
    controller.signal.throwIfAborted()
    if (nativeConfiguration) {
      const plan = nativeConfiguration.nativePlan
      if (
        plan.platform !== process.platform ||
        !ownedResource ||
        !["linux", "win32"].includes(plan.platform)
      )
        throw new Error("Native command platform is unavailable")
      await assertNativeShellArtifacts(plan, controller.signal)
      await assertNativeShellRoots(plan, controller.signal)
      await executeNativePreparationProbe(plan, nativeConfiguration.probe)
    }
    await awaitOwnedCommit()
    if (request.hook?.source) {
      if (
        !request.worktree ||
        request.cwd !== botWorktreeSkillRoot(request.worktree, request.hook.source)
      )
        throw new Error("技能副本不属于当前隔离工作区")
      await materializeBotWorktreeSkill(request.worktree, request.hook.source, controller.signal)
    }
    const sandbox = new Sandbox({
      rootDir: request.cwd,
      worktreeIsolation: request.worktree,
      runId: request.runId,
      windowsSandbox: mode,
      codexExePath: executable,
      timeout: request.timeoutMs,
      maxOutputBytes: 1_000_000,
      abortSignal: controller.signal,
      env: { ...botShellEnvironment(process.env), ...botHookEnvironment(request.hook?.env ?? {}) },
      retrySpawnFailures: false,
      preserveSandboxMode: true,
      fenceProcessTree: true,
      ...(ownedResource ? { processOwnership: "inherited-worker-resource" as const } : {}),
      ...(nativeConfiguration
        ? {
            commandIsolation: createBotNativeCommandAdapter(
              nativeConfiguration.nativePlan,
              (signal) => assertNativeShellArtifacts(nativeConfiguration!.nativePlan, signal)
            )
          }
        : {})
    })
    // Commit/push remain owned by the Cmb Git workflow, not raw model commands.
    sandbox.setGitWorkflowCommitOnly(true)
    sandbox.setReadOnlyShellEnforced(botShellReadOnly(request))
    const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] }
    let outputBytes = 0
    let protocolOverflow = false
    let protocolInputFailed = false
    const protocol = request.hook
      ? {
          ...(request.hook.invocation
            ? { ...request.hook.invocation, shell: false, sensitiveArguments: true }
            : hookCommandInvocation({ command: request.command, shell: request.hook.shell })),
          stdin: request.hook.stdin,
          onInputFailure: () => {
            protocolInputFailed = true
          },
          onOutput: (stream: "stdout" | "stderr", bytes: Buffer) => {
            if (protocolOverflow) return
            outputBytes += bytes.length
            if (outputBytes > 1_000_000) {
              protocolOverflow = true
              controller.abort(new Error("Hook output exceeds 1 MB"))
            } else chunks[stream].push(bytes)
          }
        }
      : undefined
    if (protocol) {
      const syntax =
        request.hook?.shell === "powershell"
          ? "powershell"
          : request.hook?.shell || process.platform !== "win32"
            ? "posix"
            : "cmd"
      const violation =
        request.worktree &&
        getWorktreeShellIsolationViolation(
          request.command,
          request.cwd,
          request.worktree,
          [],
          syntax
        )
      if (violation) throw new Error(`Hook command forbidden: ${violation}`)
      const safety = assessCommandSafety(request.command, request.cwd, {
        enforceGitWorkflowCommitOnly: true,
        nativeGitWorktree: Boolean(request.worktree),
        shellSyntax: syntax
      })
      if (safety.level === "forbidden") throw new Error(`Hook command forbidden: ${safety.reason}`)
    }
    const result = request.background
      ? await executeBotBackgroundShell(
          sandbox,
          request,
          controller.signal,
          cleanup,
          (progress) => {
            if (ownedOutput) ownedOutput.progress(progress)
            else if (process.connected) process.send?.({ progress }, () => {})
          }
        )
      : protocol
        ? await sandbox.executeRaw(request.command, mode, request.timeoutMs, controller.signal, {
            protocol,
            cwd: request.cwd
          })
        : await sandbox.execute(request.command)
    // A partial JSON envelope must never become a normal allow/block decision.
    if (protocolOverflow) throw new Error("Hook output exceeds 1 MB; result requires review")
    if (protocolInputFailed) throw new Error("Hook stdin delivery failed; result requires review")
    const hook = protocol
      ? decodeHookOutput(Buffer.concat(chunks.stdout), Buffer.concat(chunks.stderr))
      : undefined
    const clean = await cleanup()
    if (!clean) throw new Error("命令执行环境未能确认 leader 停止，需人工核对")
    const candidate = { ...result, ...(hook ? { hook } : {}) }
    if (ownedOutput) ownedOutput.complete(candidate, () => process.disconnect())
    else if (process.connected) process.send!({ result: candidate }, () => process.disconnect())
  })().catch(async (error: unknown) => {
    await cleanup()
    if (ownedOutput)
      ownedOutput.error(
        safeSensitiveErrorText(error instanceof Error ? error.message : "命令执行失败", 2000),
        () => process.disconnect()
      )
    else if (process.connected)
      process.send!({ error: error instanceof Error ? error.message : "命令执行失败" }, () =>
        process.disconnect()
      )
  })
})

/** Fixed private preparation. The same already-entered cgroup remains alive
 * for the later commit; no model command is started by this probe. */
async function executeNativePreparationProbe(
  plan: NativeShellPlan,
  probe: ReturnType<typeof nativeShellWorkerConfiguration.parse>["probe"]
): Promise<void> {
  const buffers: Buffer[] = []
  let count = 0
  let probeReported = false
  const invocation = await nativeIsolationProbeInvocation({
    plan: { ...plan, cwd: plan.startupCwd },
    executable: process.execPath,
    ...probe,
    assertArtifacts: (signal) => assertNativeShellArtifacts(plan, signal),
    signal: controller.signal
  })
  invocation.protocol.onOutput = (stream, bytes) => {
    if (stream !== "stdout") return
    count += bytes.length
    if (count > 4096) {
      controller.abort(new Error("Native probe output exceeds its bound"))
      return
    }
    buffers.push(bytes)
    if (plan.platform === "win32" && !probeReported && bytes.includes(10)) {
      try {
        const observation = readNativeIsolationProbe(
          Buffer.concat(buffers, count).toString("utf8"),
          probe.nonce
        )
        if (!observation.pid) throw new Error("Windows live native probe PID is missing")
        probeReported = true
        process.send?.({ nativeProbePid: observation.pid }, (error) => {
          if (error) controller.abort(error)
        })
      } catch (error) {
        controller.abort(error)
      }
    }
  }
  let inputFailed = false
  invocation.protocol.onInputFailure = () => {
    inputFailed = true
  }
  const sandbox = new Sandbox({
    rootDir: plan.startupCwd,
    runId: `native-probe-${probe.nonce}`,
    timeout: 8000,
    maxOutputBytes: 4096,
    abortSignal: controller.signal,
    retrySpawnFailures: false,
    fenceProcessTree: true,
    processOwnership: "inherited-worker-resource",
    env: {
      ...botShellEnvironment(process.env),
      ...invocation.environment,
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {})
    }
  })
  const result = await sandbox.executeRaw(
    "[fixed native isolation probe]",
    "none",
    8000,
    controller.signal,
    { protocol: invocation.protocol, cwd: plan.startupCwd }
  )
  if (result.exitCode !== 0 || inputFailed)
    throw new Error("Native filesystem/control preparation probe did not complete")
  readNativeIsolationProbe(Buffer.concat(buffers, count).toString("utf8"), probe.nonce)
  if (plan.platform === "win32" && !probeReported)
    throw new Error("Windows native member probe was not observed live")
  controller.signal.throwIfAborted()
}
