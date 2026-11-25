import { execFile } from "child_process"
import { mkdir, mkdtemp, realpath, rename, rm, stat } from "fs/promises"
import { join } from "path"
import { promisify } from "util"
import { getCmbCoworkAgentDataRoot } from "../app-data-root"
import { withoutGitRepositoryOverrides } from "./git-environment"
import type { KnowledgeWorkspaceRole } from "../../shared/knowledge-base-types"
import { knowledgeDirectory } from "./knowledge-base-state"

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 120_000
const HTTPS_TIMEOUT_MS = 20_000
const BRANCH_VALIDATION_TIMEOUT_MS = 10_000

export interface KnowledgeRepositorySource {
  idKey: string
  role: KnowledgeWorkspaceRole
  url: string
  /** Branch name, such as main or release/2026. */
  ref?: string
  sshUrl?: string
}

export interface KnowledgeRepositoryResult extends KnowledgeRepositorySource {
  ref: string
  path: string
  commit: string
  updated: boolean
}

export class KnowledgeRepositoryLocalChangesError extends Error {
  readonly code = "KNOWLEDGE_LOCAL_CHANGES"

  constructor(message = "本地知识库存在未提交或未推送的改动，已暂停更新") {
    super(message)
    this.name = "KnowledgeRepositoryLocalChangesError"
  }
}

function normalizeSource(
  source: KnowledgeRepositorySource
): KnowledgeRepositorySource & { ref: string } {
  const url = source.url?.trim()
  const idKey = source.idKey?.trim()
  const ref = source.ref?.trim() || "main"
  const sshUrl = source.sshUrl?.trim()
  if (
    !idKey ||
    !url ||
    url.includes("\0") ||
    ref.includes("\0") ||
    url.startsWith("-") ||
    sshUrl?.includes("\0") ||
    sshUrl?.startsWith("-")
  ) {
    throw new Error("知识库 Git 地址和分支不能为空或包含非法字符")
  }
  knowledgeDirectory(idKey, source.role)
  if (!source.ref?.trim()) console.log("[knowledge_manage] 未配置 ref，回退使用 main 分支")
  return { idKey, role: source.role, url, ref, ...(sshUrl ? { sshUrl } : {}) }
}

async function git(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  timeout = GIT_TIMEOUT_MS,
  sshCommand?: string
): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    [
      "-c",
      `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
      "-c",
      "core.askPass=",
      ...args
    ],
    {
      cwd,
      env: {
        ...withoutGitRepositoryOverrides(process.env),
        GCM_INTERACTIVE: "never",
        GIT_ASKPASS: "",
        GIT_TERMINAL_PROMPT: "0",
        SSH_ASKPASS: "",
        SSH_ASKPASS_REQUIRE: "never",
        ...(sshCommand ? { GIT_SSH_COMMAND: sshCommand } : {})
      },
      timeout,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      signal
    }
  )
  return stdout.trim()
}

function isAborted(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error as Error).name === "AbortError"
}

async function nonInteractiveSshCommand(
  cwd: string,
  signal?: AbortSignal
): Promise<string | undefined> {
  let config = ""
  try {
    config = await git(
      ["config", "--null", "--get-regexp", "^(core\\.sshcommand|ssh\\.variant)$"],
      cwd,
      signal
    )
  } catch (error) {
    // git config exits with 1 when none of the requested keys are set.
    if (isAborted(error, signal) || (error as { code?: number }).code !== 1) throw error
  }
  const settings = new Map(
    config
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf("\n")
        return [entry.slice(0, separator), entry.slice(separator + 1)] as const
      })
  )
  const configuredCommand = process.env.GIT_SSH_COMMAND ?? settings.get("core.sshcommand")
  const sshPath = process.env.GIT_SSH || "ssh"
  const command = configuredCommand?.trimStart()
  const executable = command?.match(/^(?:"[^"]+"|'[^']+'|\S+)/)?.[0]
  const name = (executable ? executable.replace(/^['"]|['"]$/g, "") : sshPath)
    .split(/[\\/]/)
    .at(-1)
    ?.toLowerCase()
    .replace(/\.exe$/, "")
  const variant = (
    process.env.GIT_SSH_VARIANT ??
    settings.get("ssh.variant") ??
    "auto"
  ).toLowerCase()
  // Git's simple variant is for custom commands that accept only the host and remote command.
  if (variant === "simple") return undefined
  const client = variant === "auto" ? name : variant
  const batchOption =
    client === "plink" || client === "putty" || client === "tortoiseplink"
      ? "-batch"
      : "-o BatchMode=yes"
  // Keep the user's SSH executable and options, with batch mode taking precedence.
  if (command && executable)
    return `${executable} ${batchOption}${command.slice(executable.length)}`
  return sshPath === "ssh"
    ? `ssh ${batchOption}`
    : `'${sshPath.replaceAll("'", "'\\''")}' ${batchOption}`
}

async function withPreferredRemote<T>(
  source: KnowledgeRepositorySource,
  operation: "远端检查" | "克隆",
  run: (url: string, timeout: number) => Promise<T>,
  signal?: AbortSignal,
  prepareFallback?: () => Promise<void>
): Promise<T> {
  const https = source.url.toLowerCase().startsWith("https://")
  const primaryTimeout = https ? HTTPS_TIMEOUT_MS : GIT_TIMEOUT_MS
  if (!source.sshUrl || source.sshUrl === source.url) return run(source.url, primaryTimeout)

  try {
    return await run(source.sshUrl, GIT_TIMEOUT_MS)
  } catch (sshError) {
    if (isAborted(sshError, signal)) throw sshError
    const fallback = https ? "HTTPS" : "配置的仓库地址"
    console.log(`[knowledge_manage] SSH ${operation}失败或超时，回退使用 ${fallback} 重试`, {
      ref: source.ref
    })
    await prepareFallback?.()
    signal?.throwIfAborted()
    try {
      return await run(source.url, primaryTimeout)
    } catch (primaryError) {
      if (isAborted(primaryError, signal)) throw primaryError
      // The existing error formatter uses the configured primary URL's error.
      throw new AggregateError(
        [primaryError, sshError],
        `知识库 SSH 和 ${fallback} ${operation}均失败`
      )
    }
  }
}

export async function validateKnowledgeRepositorySource(
  source: KnowledgeRepositorySource,
  signal?: AbortSignal
): Promise<KnowledgeRepositorySource & { ref: string }> {
  const normalized = normalizeSource(source)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), BRANCH_VALIDATION_TIMEOUT_MS)
  try {
    await git(
      ["check-ref-format", "--branch", normalized.ref],
      process.cwd(),
      signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    )
    return normalized
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Git 分支配置检查超时（10 秒）")
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function getReusableLocalCommit(
  destination: string,
  source: KnowledgeRepositorySource & { ref: string },
  signal?: AbortSignal
): Promise<string | null> {
  try {
    const directory = await stat(destination)
    if (!directory.isDirectory()) {
      console.log("[knowledge_manage] 本地知识库目录无效，回退重新克隆")
      return null
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }

  try {
    const topLevel = await git(["rev-parse", "--show-toplevel"], destination, signal)
    if ((await realpath(topLevel)) !== (await realpath(destination))) {
      console.log("[knowledge_manage] 本地知识库不是目标仓库，回退重新克隆")
      return null
    }
    const changes = await knowledgeWorkspaceHasChanges(destination, signal)
    if (changes) {
      throw new KnowledgeRepositoryLocalChangesError()
    }
    let upstream: string
    try {
      upstream = await git(
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
        destination,
        signal
      )
    } catch (error) {
      if (isAborted(error, signal)) throw error
      throw new KnowledgeRepositoryLocalChangesError("无法确认本地知识库 upstream，已暂停更新")
    }
    const ahead = await git(["rev-list", "--count", `${upstream}..HEAD`], destination, signal)
    if (Number.parseInt(ahead, 10) > 0) throw new KnowledgeRepositoryLocalChangesError()
    const branch = await git(["symbolic-ref", "--short", "HEAD"], destination, signal)
    const origin = await git(["remote", "get-url", "origin"], destination, signal)
    if (branch !== source.ref || (origin !== source.url && origin !== source.sshUrl)) return null
    const commit = await git(["rev-parse", "--verify", "HEAD^{commit}"], destination, signal)
    return commit
  } catch (error) {
    if (isAborted(error, signal) || error instanceof KnowledgeRepositoryLocalChangesError)
      throw error
    console.log("[knowledge_manage] 本地知识库无法复用，回退重新克隆")
    return null
  }
}

async function getRemoteCommit(
  source: KnowledgeRepositorySource & { ref: string },
  runGit: (args: string[], timeout: number) => Promise<string>,
  signal?: AbortSignal
): Promise<string> {
  const branch = `refs/heads/${source.ref}`
  const probe = async (url: string, timeout: number): Promise<string> => {
    const output = await runGit(["ls-remote", "--exit-code", "--heads", "--", url, branch], timeout)
    const match = output.split("\n").find((line) => line.endsWith(`\t${branch}`))
    const commit = match?.split("\t", 1)[0]
    if (!commit || !/^[0-9a-f]{40,64}$/i.test(commit)) {
      throw new Error("知识库远端分支返回了无效 commit")
    }
    return commit
  }

  return withPreferredRemote(source, "远端检查", probe, signal)
}

export async function knowledgeWorkspaceHasChanges(
  path: string,
  signal?: AbortSignal
): Promise<boolean> {
  return Boolean(await git(["status", "--porcelain", "--untracked-files=normal"], path, signal))
}

/**
 * Synchronize one Git branch into <app data>/knowledge/<idKey>/<role>.
 *
 * Callers must await completion before synchronizing the same source again.
 * This primitive does not schedule background work or manage active readers.
 * The returned checkout is an app-owned cache; local edits pause synchronization.
 * An unchanged, clean checkout is reused after checking the remote branch head.
 */
export async function syncKnowledgeRepository(
  source: KnowledgeRepositorySource,
  options: { signal?: AbortSignal } = {}
): Promise<KnowledgeRepositoryResult> {
  const normalized = await validateKnowledgeRepositorySource(source, options.signal)
  const root = join(getCmbCoworkAgentDataRoot(), "knowledge")
  const destination = knowledgeDirectory(normalized.idKey, normalized.role)
  await mkdir(join(root, normalized.idKey), { recursive: true })
  const localCommit = await getReusableLocalCommit(destination, normalized, options.signal)
  const sshCommand = await nonInteractiveSshCommand(root, options.signal)
  const runGit = (args: string[], timeout: number): Promise<string> =>
    git(args, root, options.signal, timeout, sshCommand)
  if (localCommit) {
    const remoteCommit = await getRemoteCommit(normalized, runGit, options.signal)
    if (remoteCommit === localCommit) {
      options.signal?.throwIfAborted()
      return { ...normalized, path: destination, commit: localCommit, updated: false }
    }
  }
  const staging = await mkdtemp(join(root, ".sync-"))
  const checkout = join(staging, "checkout")
  const backup = join(staging, "previous")
  let hadPrevious = false
  let preserveBackup = false
  const clone = (url: string, timeout: number): Promise<string> =>
    runGit(
      ["clone", "--depth", "1", "--single-branch", "--branch", normalized.ref, "--", url, checkout],
      timeout
    )
  try {
    await withPreferredRemote(normalized, "克隆", clone, options.signal, () =>
      rm(checkout, { recursive: true, force: true })
    )
    // --branch also accepts tags; this API deliberately requires a branch.
    const commit = await git(
      ["rev-parse", "--verify", `refs/heads/${normalized.ref}^{commit}`],
      checkout,
      options.signal
    )
    options.signal?.throwIfAborted()
    try {
      await rename(destination, backup)
      hadPrevious = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    try {
      await rename(checkout, destination)
    } catch (error) {
      if (hadPrevious) {
        console.log("[knowledge_manage] 知识库替换失败，回退恢复旧版本")
        try {
          await rename(backup, destination)
        } catch (restoreError) {
          preserveBackup = true
          throw new AggregateError([error, restoreError], `知识库替换失败，旧版本保留在 ${backup}`)
        }
      }
      throw error
    }
    return { ...normalized, path: destination, commit, updated: true }
  } finally {
    // Cleanup must not turn a successful replacement into a reported sync failure.
    if (!preserveBackup) await rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}
