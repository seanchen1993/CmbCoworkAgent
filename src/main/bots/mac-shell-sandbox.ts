import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { constants } from "node:fs"
import { dirname, isAbsolute, join, relative } from "node:path"
import { tmpdir } from "node:os"
import type { BotShellRequest } from "./shell-contract"
import type { BotOperationLauncher } from "./operation-process"
import { hasControlCharacters } from "./validation"
import {
  CODEX_SEATBELT_BASE,
  CODEX_SEATBELT_NETWORK,
  CODEX_SEATBELT_PLATFORM
} from "./upstream/codex-seatbelt-policy"

const executable = "/usr/bin/sandbox-exec"
const inside = (root: string, path: string) => {
  const part = relative(root, path)
  return part === "" || (part !== ".." && !part.startsWith("../") && !isAbsolute(part))
}
const literal = (path: string) => {
  if (!isAbsolute(path) || hasControlCharacters(path) || path.includes("\x7f"))
    throw new Error("沙箱目录必须为有效的绝对路径")
  return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

/** Paths are trusted Host inputs, never model tool arguments. Explicit denies
 * override platform/toolchain reads, including when a project is their parent. */
export function macBotShellPolicy(input: {
  readRoots: string[]
  writeRoots: string[]
  protectedRoots: string[]
  /** Trusted code/executable/module roots remain readable, never writable. */
  writeDeniedRoots?: string[]
}): string {
  const paths = (roots: string[]) =>
    [...new Set(roots)].map((root) => `(subpath ${literal(root)})`).join("\n")
  // A subpath deny alone can be bypassed by moving one of its ancestors,
  // changing the moved tree, then moving it back. Literal unlink denies keep
  // those directory identities in place without blocking sibling source edits.
  const ancestors = new Set<string>()
  for (const root of [...input.protectedRoots, ...(input.writeDeniedRoots ?? [])]) {
    literal(root)
    let parent = dirname(root)
    while (dirname(parent) !== parent) {
      ancestors.add(parent)
      parent = dirname(parent)
    }
  }
  const literalPaths = [...ancestors].map((root) => `(literal ${literal(root)})`).join("\n")
  return `${CODEX_SEATBELT_BASE}\n${CODEX_SEATBELT_PLATFORM}\n${CODEX_SEATBELT_NETWORK}
(allow file-read* file-test-existence ${paths(input.readRoots)})
; Executable discovery must be able to stat nonexistent PATH candidates (npm
; adds ancestors' node_modules/.bin). This does not permit reading file contents.
(allow file-read-metadata)
${input.writeRoots.length ? `(allow file-write* ${paths(input.writeRoots)})` : ""}
${input.protectedRoots.length ? `(deny file-read* file-write* file-test-existence ${paths(input.protectedRoots)})` : ""}
${input.writeDeniedRoots?.length ? `(deny file-write* ${paths(input.writeDeniedRoots)})` : ""}
${literalPaths ? `(deny file-write-unlink ${literalPaths})` : ""}
; Shell network effects retain the existing exact-action approval. Unix sockets
; remain denied: a task must not connect to the Host or desktop control channel.
(allow network-outbound (remote ip "*:*"))
(allow network-inbound (local ip "localhost:*"))
(allow network-bind (local ip "localhost:*"))
(allow mach-lookup (global-name "com.apple.TrustEvaluationAgent"))
`
}

async function canonicalRoots(roots: string[], required: boolean): Promise<string[]> {
  const result: string[] = []
  for (const root of roots) {
    literal(root)
    try {
      result.push(await realpath(root))
    } catch (error) {
      if (required || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  return [...new Set(result)]
}

async function runtimeRoot(entry: string): Promise<string> {
  const file = await realpath(entry)
  let directory = dirname(file)
  for (let count = 0; count < 8 && dirname(directory) !== directory; count++) {
    try {
      await access(join(directory, "package.json"))
      return directory
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    directory = dirname(directory)
  }
  // A self-contained launcher in /tmp must not grant all other temporary data.
  return file
}

/** Sandbox the disposable worker itself so its hooks and every descendant
 * inherit the same OS policy. No shell quoting and no unsandboxed retry. */
export async function prepareMacBotShell(
  request: BotShellRequest,
  launcher: BotOperationLauncher,
  runtimeReadRoots: readonly string[] = [],
  runtimeCodeRoots: readonly string[] = []
): Promise<{ launcher: BotOperationLauncher; close(): Promise<void> }> {
  await access(executable, constants.X_OK)
  const workspace = await realpath(
    request.worktree?.workspaceRoot ?? request.workspaceRoot ?? request.cwd
  )
  const protectedRoots = await canonicalRoots(request.protectedRoots ?? [], true)
  if (protectedRoots.some((root) => inside(root, workspace)))
    throw new Error("Bot 后台数据目录不能作为命令工作目录")
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "cmb-bot-command-")))
  const close = () => rm(temporary, { recursive: true, force: true })
  try {
    // Tool defaults (Git config, npm caches, etc.) need a usable home without
    // reading personal credentials or writing outside the command's sandbox.
    const home = join(temporary, "home")
    await mkdir(home, { mode: 0o700 })
    const binary = await realpath(launcher.executable ?? process.execPath)
    const application = binary.match(/^(.+\.app)\//)?.[1]
    const writeDeniedRoots = await canonicalRoots(
      [
        binary,
        launcher.entry,
        ...runtimeReadRoots,
        ...runtimeCodeRoots,
        ...(application ? [application] : [])
      ],
      true
    )
    // PATH entries are implicit tool-discovery grants. Reject filesystem roots
    // after resolving links and dot segments as well as their literal spelling.
    // An explicit project grant remains governed by the workspace contract.
    const toolPaths = await canonicalRoots(
      (process.env.PATH ?? "").split(":").filter((path) => isAbsolute(path)),
      false
    )
    const readRoots = await canonicalRoots(
      [
        workspace,
        request.cwd,
        temporary,
        // Installed runtime/code and standard native toolchains are read-only.
        await runtimeRoot(launcher.entry),
        ...runtimeReadRoots,
        application ?? (dirname(dirname(binary)) === "/" ? binary : dirname(dirname(binary))),
        "/bin",
        "/sbin",
        "/usr/bin",
        "/usr/sbin",
        "/usr/local",
        "/opt/homebrew",
        "/Library/Developer",
        "/Library/Frameworks",
        "/System/Library/OpenSSL",
        "/Applications/Xcode.app",
        ...(request.worktree ? [request.worktree.commonDir, request.worktree.worktreeRoot] : []),
        ...(request.hook?.source ? [request.hook.source.rootPath] : [])
      ],
      false
    )
    readRoots.push(...toolPaths.filter((path) => dirname(path) !== path))
    const policy = macBotShellPolicy({
      readRoots,
      // Git worktrees keep their index, objects and branch refs in the shared
      // metadata directory outside the checkout. Match the existing native
      // worktree contract; command approval and Git operation policy still
      // apply, and explicit private-data denies always take precedence.
      writeRoots: request.readOnly
        ? [temporary]
        : await canonicalRoots(
            [workspace, temporary, ...(request.worktree ? [request.worktree.commonDir] : [])],
            true
          ),
      protectedRoots,
      writeDeniedRoots
    })
    return {
      launcher: {
        entry: launcher.entry,
        executable,
        execArgv: ["-p", policy, binary, ...(launcher.execArgv ?? [])],
        environment: {
          TMPDIR: temporary,
          TMP: temporary,
          TEMP: temporary,
          HOME: home,
          CMB_BOT_COMMAND_SCRATCH: temporary
        }
      },
      close
    }
  } catch (error) {
    await close()
    throw error
  }
}
