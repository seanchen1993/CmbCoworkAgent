import { execFile } from "node:child_process"
import { lstatSync, readdirSync } from "node:fs"
import { lstat, mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"
import { randomUUID } from "node:crypto"
import { ensureCodexExe } from "../agent/codex-sandbox-binary"
import { resolveWindowsBackgroundJobControllerPath } from "../agent/windows-background-job-controller-path"
import {
  runtimeDirectory,
  runtimeDirectoryIdentity
} from "../harness-board/project-runtime/safe-files"
import type { StageRecoveryCommandPolicy } from "../harness-board/project-runtime/stage-recovery-policy"

const runFile = promisify(execFile)
const protectedRoots = new Map<string, () => void>()
function captureProtectedRoot(root: string): () => void {
  const entries: Array<[string, string]> = []
  const signature = (path: string) => {
    const stat = lstatSync(path, { bigint: true })
    if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n)))
      fail("COMMAND_SCOPE_CHANGED")
    return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(
      ":"
    )
  }
  const visit = (path: string, depth: number) => {
    if (entries.length >= 8192 || depth > 16) fail("COMMAND_SCOPE_INVALID")
    entries.push([path, signature(path)])
    if (lstatSync(path).isDirectory())
      for (const name of readdirSync(path)) visit(join(path, name), depth + 1)
  }
  visit(root, 0)
  return () => {
    for (const [path, before] of entries)
      if (signature(path) !== before) fail("COMMAND_SCOPE_CHANGED")
  }
}
function fail(code: string): never {
  throw Error(`PROJECT_STAGE_DEBUG_${code}`)
}
function contains(root: string, target: string): boolean {
  const path = relative(root, target)
  return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`)
}

/** Harden immutable app-owned sources before their native execution guards are adopted.
 * Repeated use verifies the complete retained metadata instead of mutating its ACL again.
 */
export async function prepareStageRecoveryReadOnlyRoots(
  roots: readonly string[],
  guard: () => void,
  signal?: AbortSignal
): Promise<void> {
  if (process.platform !== "win32") fail("COMMAND_SANDBOX_UNAVAILABLE")
  const pending: string[] = []
  for (const input of new Set(roots)) {
    const root = runtimeDirectory(input)
    const previous = protectedRoots.get(root)
    if (previous) {
      try {
        previous()
        continue
      } catch {
        protectedRoots.delete(root)
      }
    }
    pending.push(root)
  }
  if (!pending.length) return
  guard()
  signal?.throwIfAborted()
  const system = join(process.env.SystemRoot ?? "C:/Windows", "System32")
  const options = { windowsHide: true, timeout: 5000, maxBuffer: 32768, signal }
  const identity = await runFile(
    join(system, "whoami.exe"),
    ["/user", "/fo", "csv", "/nh"],
    options
  )
  const sid = /S-1-5-(?:\d+-)*\d+/.exec(String(identity.stdout))?.[0]
  if (!sid) fail("COMMAND_SANDBOX_IDENTITY_UNAVAILABLE")
  for (const root of pending) {
    guard()
    signal?.throwIfAborted()
    await runFile(
      join(system, "icacls.exe"),
      [root, "/inheritance:r", "/remove:g", "*S-1-1-0", "/grant:r", `*${sid}:(OI)(CI)(F)`],
      options
    )
    guard()
    signal?.throwIfAborted()
    if (protectedRoots.size >= 256) protectedRoots.delete(protectedRoots.keys().next().value!)
    protectedRoots.set(root, captureProtectedRoot(root))
  }
}

/** Resolves the same app-owned Codex resource used by LocalSandbox. Never falls back to PATH. */
export async function resolveStageRecoverySandboxBinary(): Promise<string> {
  if (process.platform !== "win32") fail("COMMAND_SANDBOX_UNAVAILABLE")
  const packaged = !!process.versions.electron && process.defaultApp !== true
  const candidates = packaged
    ? process.resourcesPath
      ? [join(process.resourcesPath, "bin/win32/codex.exe")]
      : []
    : [
        resolve(__dirname, "../../resources/bin/win32/codex.exe"),
        resolve(__dirname, "../../../../resources/bin/win32/codex.exe"),
        resolve(process.cwd(), "resources/bin/win32/codex.exe")
      ]
  for (const candidate of candidates) {
    await ensureCodexExe(candidate)
    const stat = await lstat(candidate).catch(() => undefined)
    if (stat?.isFile() && !stat.isSymbolicLink()) return candidate
  }
  fail("COMMAND_SANDBOX_UNAVAILABLE")
}

export function buildStageRecoverySandboxArguments(input: {
  workspace: string
  shell: string
  args: string[]
}): string[] {
  const workspace = runtimeDirectory(input.workspace)
  // Override the private sandbox home and all mode inputs. No full-auto aliases, fallback,
  // package caches, repository commonDir or system TEMP are admitted as writable roots.
  return [
    "-c",
    'windows.sandbox="unelevated"',
    "-c",
    'sandbox_mode="workspace-write"',
    "-c",
    "sandbox_workspace_write.network_access=false",
    "-c",
    "sandbox_workspace_write.exclude_tmpdir_env_var=true",
    "-c",
    "sandbox_workspace_write.exclude_slash_tmp=true",
    "-c",
    `sandbox_workspace_write.writable_roots=[${JSON.stringify(workspace)}]`,
    "sandbox",
    "windows",
    "--",
    input.shell,
    ...input.args
  ]
}

/** Only native-owned retained roots may be supplied. The WRITE_RESTRICTED sandbox also
 * respects existing Everyone write ACLs, so inherited TEMP grants must not make an upstream
 * trial or immutable package writable. Preserve the host owner's access, remove that broad
 * group on each exact retained root, and never change a user's selected knowledge directory.
 */
export async function prepareStageRecoveryCommand(input: {
  workspace: string
  snapshotRoot: string
  policy: StageRecoveryCommandPolicy
  env: Record<string, string>
  shell: string
  args: string[]
  windowsShellCommand?: string
  stdin: string
  commandCwd?: string
  guard(): void
  signal?: AbortSignal
}): Promise<{
  executable: string
  args: string[]
  cwd: string
  env: Record<string, string>
  cleanup(): Promise<void>
}> {
  input.guard()
  input.signal?.throwIfAborted()
  if (process.platform !== "win32" || input.policy.networkAccess !== "explicitly-approved")
    fail("COMMAND_SANDBOX_UNAVAILABLE")
  const workspace = runtimeDirectory(input.workspace)
  const source = runtimeDirectory(input.snapshotRoot)
  const commandCwd = runtimeDirectory(input.commandCwd ?? workspace)
  if (!contains(workspace, commandCwd) && !contains(source, commandCwd))
    fail("COMMAND_SCOPE_INVALID")
  if (!input.policy.readOnlyRoots.length || input.policy.readOnlyRoots.length > 16)
    fail("COMMAND_SCOPE_INVALID")
  const roots = [...new Set([source, ...input.policy.readOnlyRoots.map(runtimeDirectory)])]
  if (roots.some((root) => contains(root, workspace) || contains(workspace, root)))
    fail("COMMAND_SCOPE_INVALID")
  const identities = [workspace, ...roots].map(runtimeDirectoryIdentity)
  const current = () => {
    input.guard()
    input.signal?.throwIfAborted()
    if (
      [workspace, ...roots].some(
        (root, index) => runtimeDirectoryIdentity(root) !== identities[index]
      )
    )
      fail("COMMAND_SCOPE_CHANGED")
  }
  const system = join(process.env.SystemRoot ?? "C:/Windows", "System32")
  const options = { windowsHide: true, timeout: 5000, maxBuffer: 32768, signal: input.signal }
  try {
    await prepareStageRecoveryReadOnlyRoots(roots, current, input.signal)
    await runFile(
      join(system, "icacls.exe"),
      [workspace, "/grant", "*S-1-1-0:(OI)(CI)(M)"],
      options
    )
  } catch {
    current()
    fail("COMMAND_SANDBOX_SETUP_FAILED")
  }
  current()
  // Creator workspaces are already deeply nested on Windows. Keep private protocol paths
  // bounded so the native controller and interpreter do not exceed legacy MAX_PATH.
  const temporary = join(workspace, ".dcr")
  await mkdir(temporary, { recursive: true })
  current()
  runtimeDirectory(temporary)
  const sandboxHome = await mkdtemp(join(temporary, "h-"))
  current()
  if (Buffer.byteLength(input.stdin) > 1_000_000) fail("HOOK_INPUT_LIMIT")
  const payload = join(temporary, `i-${randomUUID()}`)
  await writeFile(payload, input.stdin, { flag: "wx", mode: 0o600 })
  current()
  const temporaryIdentity = runtimeDirectoryIdentity(temporary)
  const executable = await resolveStageRecoverySandboxBinary()
  current()
  const controller = resolveWindowsBackgroundJobControllerPath()
  const args =
    input.windowsShellCommand === undefined
      ? [input.shell, "recovery-argv-file", payload, ...input.args]
      : [input.shell, "recovery-cmd-file", payload, input.windowsShellCommand]
  return {
    executable,
    args: buildStageRecoverySandboxArguments({ workspace, shell: controller, args }),
    cwd: workspace,
    env: {
      ...input.env,
      TEMP: temporary,
      TMP: temporary,
      TMPDIR: temporary,
      CODEX_HOME: sandboxHome,
      PYTHONDONTWRITEBYTECODE: "1",
      CMB_STAGE_RECOVERY_COMMAND_CWD: commandCwd
    },
    cleanup: async () => {
      try {
        if (
          runtimeDirectoryIdentity(workspace) !== identities[0] ||
          runtimeDirectoryIdentity(temporary) !== temporaryIdentity
        )
          return
        await unlink(payload)
      } catch {
        /* Preserve the exact execution result; changed private paths stay retained. */
      }
    }
  }
}
