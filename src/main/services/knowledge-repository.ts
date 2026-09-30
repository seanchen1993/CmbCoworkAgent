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
const HTTPS_CLONE_TIMEOUT_MS = 20_000

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
  timeout = GIT_TIMEOUT_MS
): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`, ...args],
    {
      cwd,
      env: {
        ...withoutGitRepositoryOverrides(process.env),
        GIT_TERMINAL_PROMPT: "0"
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

export async function validateKnowledgeRepositorySource(
  source: KnowledgeRepositorySource,
  signal?: AbortSignal
): Promise<KnowledgeRepositorySource & { ref: string }> {
  const normalized = normalizeSource(source)
  await git(["check-ref-format", "--branch", normalized.ref], process.cwd(), signal)
  return normalized
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
  root: string,
  signal?: AbortSignal
): Promise<string> {
  const branch = `refs/heads/${source.ref}`
  const probe = async (url: string, timeout: number): Promise<string> => {
    const output = await git(
      ["ls-remote", "--exit-code", "--heads", "--", url, branch],
      root,
      signal,
      timeout
    )
    const match = output.split("\n").find((line) => line.endsWith(`\t${branch}`))
    const commit = match?.split("\t", 1)[0]
    if (!commit || !/^[0-9a-f]{40,64}$/i.test(commit)) {
      throw new Error("知识库远端分支返回了无效 commit")
    }
    return commit
  }

  const https = source.url.toLowerCase().startsWith("https://")
  try {
    return await probe(source.url, https ? HTTPS_CLONE_TIMEOUT_MS : GIT_TIMEOUT_MS)
  } catch (error) {
    if (isAborted(error, signal) || !https || !source.sshUrl) throw error
    console.log("[knowledge_manage] HTTPS 远端检查失败或超时，回退使用 sshUrl 重试", {
      ref: source.ref
    })
    try {
      return await probe(source.sshUrl, GIT_TIMEOUT_MS)
    } catch (sshError) {
      if (isAborted(sshError, signal)) throw sshError
      throw new AggregateError([error, sshError], "知识库 HTTPS 远端检查失败，SSH 兜底也失败")
    }
  }
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
  if (localCommit) {
    const remoteCommit = await getRemoteCommit(normalized, root, options.signal)
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
    git(
      ["clone", "--depth", "1", "--single-branch", "--branch", normalized.ref, "--", url, checkout],
      root,
      options.signal,
      timeout
    )
  try {
    const https = normalized.url.toLowerCase().startsWith("https://")
    try {
      await clone(normalized.url, https ? HTTPS_CLONE_TIMEOUT_MS : GIT_TIMEOUT_MS)
    } catch (error) {
      // Cancellation is intentional and must not start another network request.
      if (isAborted(error, options.signal)) throw error
      if (!https || !normalized.sshUrl) throw error
      console.log("[knowledge_manage] HTTPS 克隆失败或超时，回退使用 sshUrl 重试", {
        ref: normalized.ref
      })
      await rm(checkout, { recursive: true, force: true })
      try {
        await clone(normalized.sshUrl, GIT_TIMEOUT_MS)
      } catch (sshError) {
        if (isAborted(sshError, options.signal)) throw sshError
        throw new AggregateError([error, sshError], "知识库 HTTPS 克隆失败，SSH 兜底也失败")
      }
    }
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
