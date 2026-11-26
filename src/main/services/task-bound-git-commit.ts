import { execFile, spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { constants, createReadStream } from "node:fs"
import * as fs from "node:fs/promises"
import path from "node:path"
import { createInterface } from "node:readline"
import { withoutGitRepositoryOverrides } from "./git-environment"
import { gitWorktreeWriteKey, prepareGitPanelWrite } from "./git-worktree-write-gate"

export interface TaskCommitCandidate {
  sha: string
  parent: string
  branch: string
  tree: string
  /** Exact Git paths relative to the repository root, including deleted rename sources. */
  files: string[]
  indexRecovery?: TaskCommitIndexRecovery
}

export interface TaskCommitIndexRecovery {
  parent: string
  previousDigest: string
  preparedDigest: string
  lockDevice: string
  lockInode: string
  pid: number
  processInstance: string
}

interface TaskBoundCommitOptions {
  worktreePath: string
  /** Exact files relative to the authorized operation directory. */
  filePaths: string[]
  message: string
  /** A user has explicitly reviewed this entire file selection, including partial stages. */
  reviewed?: boolean
  revalidate: () => Promise<boolean>
  canPublish?: () => boolean
  onPrepared?: (candidate: TaskCommitCandidate) => Promise<void>
}

export type TaskBoundCommitResult =
  | {
      status: "committed"
      sha: string
      branch: string
      files: string[]
      warning?: string
      needsIndexRecovery?: boolean
    }
  | { status: "review" | "failed"; reason: string }

const writers = new Map<string, Promise<void>>()
const gitTimeoutMs = 60_000
const processInstance = randomUUID()

class UnconfirmedPublication extends Error {}

async function indexDigest(filename: string): Promise<string> {
  const digest = createHash("sha256")
  for await (const chunk of createReadStream(filename)) digest.update(chunk)
  return digest.digest("hex")
}

async function sameLockFile(
  lockPath: string,
  expected: { dev: bigint; ino: bigint }
): Promise<boolean> {
  const actual = await fs
    .lstat(lockPath, { bigint: true })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null
      throw error
    })
  return !!actual && actual.isFile() && actual.dev === expected.dev && actual.ino === expected.ino
}

export async function acquireTaskBoundWorktreeWrite(gitDir: string): Promise<() => void> {
  const key = gitWorktreeWriteKey(await fs.realpath(gitDir))
  const previous = writers.get(key)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  writers.set(key, gate)
  await previous
  return () => {
    release()
    if (writers.get(key) === gate) writers.delete(key)
  }
}

function gitEnv(index?: string): NodeJS.ProcessEnv {
  return {
    ...withoutGitRepositoryOverrides(process.env, "workspace"),
    GIT_OPTIONAL_LOCKS: "0",
    GIT_EDITOR: ":",
    GIT_TERMINAL_PROMPT: "0",
    CMBDEVCLAW_INTERNAL_GIT: "1",
    ...(index ? { GIT_INDEX_FILE: index } : {})
  }
}

function git(
  cwd: string,
  args: string[],
  index?: string,
  input?: string,
  executable = "git"
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      executable,
      ["--literal-pathspecs", ...args],
      {
        cwd,
        env: gitEnv(index),
        windowsHide: true,
        timeout: gitTimeoutMs,
        maxBuffer: 16 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message))
        else resolve(stdout)
      }
    )
    child.stdin?.on("error", () => {
      /* Git reports input errors through its exit code. */
    })
    child.stdin?.end(input)
  })
}

const outputLine = (s: string): string => s.replace(/\r?\n$/, "")
const nulFields = (s: string): string[] => s.split("\0").filter(Boolean)

// Git 2.21 prints unrecognized rev-parse options to stdout and exits successfully.
// Read each value separately and resolve --git-path relative to the queried directory.
async function gitPath(cwd: string, ...args: string[]): Promise<string> {
  const value = outputLine(await git(cwd, ["rev-parse", ...args]))
  if (!value || value === args[0]) throw new Error("无法读取 Git 工作树路径")
  return path.resolve(cwd, value)
}

type GitOperation = "update-ref" | "hook"
let nativeGitVersion: Promise<string> | undefined

export function supportsTaskGitOperation(version: string, operation: GitOperation): boolean {
  const match = /\bgit version (\d+)\.(\d+)(?:\.(\d+))?/i.exec(version)
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  if (major !== 2) return major > 2
  if (operation === "hook") return minor >= 36
  // 2.33.1 backported the interactive update-ref stdout flush.
  return minor > 33 || (minor === 33 && Number(match[3] ?? 0) >= 1)
}

// Keep the user's Git for repository discovery, staging, filters, signing and commit-tree.
// Only the interactive ref transaction and git hook run need newer Git commands.
async function transactionGit(root: string, operation: GitOperation): Promise<string> {
  if (process.platform !== "win32") return "git"
  nativeGitVersion ??= git(root, ["--version"]).catch((error) => {
    nativeGitVersion = undefined
    throw error
  })
  if (supportsTaskGitOperation(await nativeGitVersion, operation)) return "git"
  const helper = path.join("task-commit-git", "cmd", "git.exe")
  const roots = process.resourcesPath ? [process.resourcesPath] : []
  if (process.defaultApp || !process.versions.electron) {
    roots.push(
      path.resolve(__dirname, "../../resources"),
      path.resolve(__dirname, "../../../resources")
    )
  }
  for (const base of roots) {
    const file = path.join(base, helper)
    if ((await fs.stat(file).catch(() => null))?.isFile()) return file
  }
  throw new Error(
    "当前应用缺少旧版 Git 的提交兼容组件。请安装新版应用；开发环境可运行 npm run prepare:task-commit-git。"
  )
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath)
    return true
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false
    throw error
  }
}

async function runTaskCommitHook(
  root: string,
  hooksDir: string,
  name: string,
  args: string[] = [],
  index?: string
): Promise<void> {
  const executable = await transactionGit(root, "hook")
  await git(
    root,
    ["-c", "core.hooksPath=" + hooksDir, "hook", "run", "--ignore-missing", name, "--", ...args],
    index,
    undefined,
    executable
  )
}

async function assertOrdinaryCommit(gitDir: string, hooksDir: string): Promise<void> {
  const states = [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "SQUASH_MSG",
    "rebase-merge",
    "rebase-apply",
    "sequencer",
    "BISECT_LOG"
  ]
  // These observe every index or reference transition. Private preparation would present
  // extra operations that are absent from one native commit.
  const hooks = ["post-index-change", "reference-transaction"]
  const checks = states
    .map((name) => path.join(gitDir, name))
    .concat(hooks.map((name) => path.join(hooksDir, name)))
  const active = await Promise.all(checks.map(exists))
  const index = active.indexOf(true)
  if (index >= 0)
    throw new Error(`当前 Git 状态或钩子需要人工提交（${path.basename(checks[index])}）`)
}

function exactPaths(files: string[]): boolean {
  return files.every(
    (name) =>
      name &&
      !name.includes("\0") &&
      !path.isAbsolute(name) &&
      !path.win32.isAbsolute(name) &&
      !name.startsWith(":") &&
      !name
        .split("/")
        .some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git") &&
      (process.platform !== "win32" || !name.includes("\\"))
  )
}

async function verifyPaths(
  root: string,
  scope: string,
  files: string[],
  headTypes?: Map<string, string>
): Promise<string[]> {
  const targets = files.map((name) => path.join(scope, name))
  const excluded = new Set<string>()
  const parents = new Set(targets.map((target) => path.dirname(target)))
  const redirected = new Set<string>()
  for (const directory of parents) {
    // Missing ancestors are valid for deletions. A junction in an existing ancestor
    // must not redirect a repository-relative name into another checkout.
    let parent = directory
    while (parent !== scope && !(await exists(parent))) parent = path.dirname(parent)
    if (path.relative(parent, await fs.realpath(parent)) !== "") {
      if (headTypes) {
        redirected.add(directory)
        continue
      }
      throw new Error(`提交文件父目录发生重定向：${directory}`)
    }
  }
  for (let start = 0; start < targets.length; start += 32) {
    await Promise.all(
      targets.slice(start, start + 32).map(async (target) => {
        if (redirected.has(path.dirname(target))) {
          excluded.add(target)
          return
        }
        const entry = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return null
          throw error
        })
        const headType = headTypes?.get(path.relative(root, target).split(path.sep).join("/"))
        if (
          headTypes &&
          (headType === "commit" ||
            headType === "tree" ||
            (!entry && headType !== "blob") ||
            (entry && !entry.isFile() && !entry.isSymbolicLink()))
        ) {
          excluded.add(target)
          return
        }
        if (entry && !entry.isFile() && !entry.isSymbolicLink()) {
          throw new Error(`需要明确的普通文件或 Git 符号链接：${target}`)
        }
      })
    )
  }
  return targets
    .filter((target) => !excluded.has(target))
    .map((target) => path.relative(root, target).split(path.sep).join("/"))
}

function gitPathChunks(files: string[]): string[][] {
  // Bound individual invocations below CreateProcess' command-line limit.
  const chunks: string[][] = [[]]
  let length = 0
  for (const file of files) {
    if (length + file.length > 12_000 && chunks[chunks.length - 1].length) {
      chunks.push([])
      length = 0
    }
    chunks[chunks.length - 1].push(file)
    length += file.length + 4
  }
  return chunks
}

async function checkSelection(
  root: string,
  files: string[],
  parent: string,
  reviewed: boolean,
  index: string
): Promise<void> {
  const selected = new Set(files)
  const seen = new Set<string>()
  const [staged, conflicts] = await Promise.all([
    git(root, ["diff", "--cached", "--name-status", "--find-renames", "-z", parent], index),
    git(root, ["ls-files", "-u", "-z"], index)
  ])
  if (conflicts) throw new Error("仓库中存在未解决的合并冲突")
  const stagedFields = nulFields(staged)
  for (let i = 0; i < stagedFields.length; ) {
    const code = stagedFields[i++]
    const oldPath = stagedFields[i++]
    if (code.startsWith("R") || code.startsWith("C")) {
      const newPath = stagedFields[i++]
      if (code.startsWith("R") && selected.has(oldPath) !== selected.has(newPath)) {
        throw new Error("重命名文件必须同时明确指定原路径和新路径")
      }
    }
  }
  for (const chunk of gitPathChunks(files)) {
    const fields = nulFields(
      await git(
        root,
        ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", ...chunk],
        index
      )
    )
    for (const field of fields) {
      const name = field.slice(3)
      const code = field.slice(0, 2)
      if (!selected.has(name)) throw new Error("提交路径包含未逐项指定的文件")
      if (!reviewed && code !== "??" && code[0] !== " " && code[1] !== " ") {
        throw new Error(`文件同时有暂存和未暂存改动，需人工核对：${name}`)
      }
      seen.add(name)
    }
  }
  if (seen.size !== selected.size) throw new Error("部分文件未匹配实际 Git 变更，请核对提交范围")
}

async function snapshotTree(
  root: string,
  index: string,
  parent: string,
  files: string[],
  gitOptions: string[] = []
) {
  // Start from an empty private index every time so Git hashes the current worktree content
  // rather than trusting stat data inherited from the user's index or an earlier check.
  await git(root, [...gitOptions, "read-tree", parent], index)
  for (const chunk of gitPathChunks(files)) {
    await git(root, [...gitOptions, "add", "-A", "--", ...chunk], index)
  }
  return outputLine(await git(root, [...gitOptions, "write-tree"], index))
}

/** Capture exactly the tree the commit service would construct from the authorized
 * preview. Only immutable Git objects are shared with the eventual submission. */
export async function captureTaskCommitPreviewTree(
  scope: string,
  files: string[],
  parent: string
): Promise<string> {
  return (await captureCommitPreview(scope, files, parent, false)).tree
}

/** Status lists can contain directory placeholders, dirty submodules and staged
 * changes whose worktree matches HEAD. They have no ordinary file content to publish. */
export async function captureEligibleTaskCommitPreview(
  scope: string,
  files: string[],
  parent: string
) {
  return captureCommitPreview(
    scope,
    files.map((file) => file.replace(/\/$/, "")),
    parent,
    true
  )
}

async function captureCommitPreview(
  scope: string,
  files: string[],
  parent: string,
  filter: boolean
) {
  if (!/^(?:[A-Fa-f0-9]{40}|[A-Fa-f0-9]{64})$/.test(parent) || !exactPaths(files)) {
    throw new Error("提交预览需要明确的父提交和工作区内相对文件")
  }
  const realScope = await fs.realpath(scope)
  const [rootPath, gitDir, head] = await Promise.all([
    gitPath(realScope, "--show-toplevel"),
    gitPath(realScope, "--absolute-git-dir"),
    git(realScope, ["rev-parse", "--verify", "HEAD^{commit}"]).then(outputLine)
  ])
  if (head !== parent) throw new Error("预览期间目标分支发生变化")
  const root = await fs.realpath(rootPath)
  const distinct = [...new Set(files)]
  let headTypes: Map<string, string> | undefined
  if (filter && distinct.length) {
    headTypes = new Map()
    const relativePaths = distinct.map((file) =>
      path.relative(root, path.join(realScope, file)).split(path.sep).join("/")
    )
    for (const paths of gitPathChunks(relativePaths)) {
      const entries = nulFields(await git(root, ["ls-tree", "-z", parent, "--", ...paths]))
      for (const row of entries) {
        const separator = row.indexOf("\t")
        headTypes.set(row.slice(separator + 1), row.slice(0, separator).split(" ")[1])
      }
    }
  }
  const selected = await verifyPaths(root, realScope, distinct, headTypes)
  if (!selected.length) {
    return {
      tree: outputLine(await git(root, ["rev-parse", parent + "^{tree}"])),
      files: [] as string[]
    }
  }
  const temporary = await fs.mkdtemp(path.join(gitDir, "task-commit-preview-"))
  try {
    // Do not fire repository hooks for a read-only preview's private index.
    const tree = await snapshotTree(root, path.join(temporary, "index"), parent, selected, [
      "-c",
      `core.hooksPath=${temporary}`
    ])
    if (!filter) return { tree, files: distinct }
    const changed = nulFields(
      await git(root, [
        "diff-tree",
        "-r",
        "--no-commit-id",
        "--name-only",
        "--no-renames",
        "-z",
        parent,
        tree
      ])
    )
    const expected = new Set(selected)
    if (changed.some((file) => !expected.has(file))) throw new Error("预览期间文件范围发生变化")
    return {
      tree,
      files: changed.map((file) =>
        path.relative(realScope, path.join(root, file)).split(path.sep).join("/")
      )
    }
  } finally {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function runHeadTransaction(
  root: string,
  branch: string,
  operation: string,
  subject: string,
  verify: () => Promise<void>,
  canPublish?: () => boolean
): Promise<void> {
  // update HEAD locks both the symbolic HEAD and its referent during "prepare".
  // Verify the branch while both locks are held. This also handles a checkout
  // switching to a different branch that happens to point at the same old SHA.
  const executable = await transactionGit(root, "update-ref")
  const config =
    executable === "git"
      ? []
      : [
          "-c",
          "core.hooksPath=" + path.dirname(await gitPath(root, "--git-path", "hooks/pre-commit"))
        ]
  const child = spawn(executable, [...config, "update-ref", "-m", subject, "--stdin"], {
    cwd: root,
    env: gitEnv(),
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  })
  const lines = createInterface({ input: child.stdout })
  let stderr = ""
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk
  })
  child.stdin.on("error", () => {
    /* exit status is authoritative */
  })
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", resolve)
  })
  void closed.catch(() => undefined)
  const timeout = setTimeout(() => child.kill(), gitTimeoutMs)
  let sentCommit = false
  let acknowledged = false
  try {
    child.stdin.write(`start\n${operation}\nprepare\n`)
    for await (const line of lines) {
      if (line === "commit: ok") acknowledged = true
      if (line !== "prepare: ok") continue
      if (outputLine(await git(root, ["symbolic-ref", "-q", "HEAD"])) !== branch) {
        throw new Error("提交前目标分支发生变化")
      }
      await verify()
      // Keep the live authorization check and the Git transaction decision in the same JS turn.
      if (canPublish && !canPublish()) throw new Error("发布前任务授权已变更或提交已取消")
      sentCommit = true
      child.stdin.end("commit\n")
    }
    if ((await closed) !== 0 || !acknowledged) throw new Error(stderr.trim() || "Git 引用事务失败")
  } catch (error) {
    if (sentCommit && !acknowledged) {
      throw new UnconfirmedPublication("Git 未确认目标分支是否更新，请按候选 SHA 核对后再操作")
    }
    throw error
  } finally {
    clearTimeout(timeout)
    if (!child.stdin.writableEnded) child.stdin.end("abort\n")
    await closed.catch(() => undefined)
    lines.close()
  }
}

async function commitWithIndexLock(
  options: TaskBoundCommitOptions,
  root: string,
  scope: string,
  gitDir: string,
  indexPath: string,
  hooksDir: string
): Promise<TaskBoundCommitResult> {
  const files = await verifyPaths(root, scope, [...new Set(options.filePaths)])
  const lockPath = indexPath + ".lock"
  const savedIndex = await fs.lstat(indexPath, { bigint: true })
  if (!savedIndex.isFile()) throw new Error("暂存区使用了特殊文件，请人工核对")
  if (await exists(lockPath)) throw new Error("Git 暂存区正由其他操作写入，请稍后重试")
  const temporary = await fs.mkdtemp(path.join(gitDir, "task-commit-"))
  let ownsIndexLock = false
  let pendingIndex: { dev: bigint; ino: bigint } | undefined
  let keepIndexLock = false
  let candidate: TaskCommitCandidate | undefined
  let published = false
  try {
    const nextIndex = path.join(temporary, "next")
    await fs.copyFile(indexPath, nextIndex, constants.COPYFILE_EXCL)
    const [parent, branch, sign, hooks, previousDigest] = await Promise.all([
      git(root, ["rev-parse", "--verify", "HEAD^{commit}"]).then(outputLine),
      git(root, ["symbolic-ref", "-q", "HEAD"]).then(outputLine),
      git(root, ["config", "--type=bool", "--default=false", "--get", "commit.gpgsign"]).then(
        outputLine
      ),
      fs.readdir(hooksDir).catch((error: NodeJS.ErrnoException): string[] => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return []
        throw error
      }),
      indexDigest(nextIndex),
      assertOrdinaryCommit(gitDir, hooksDir)
    ])
    if (!branch.startsWith("refs/heads/")) throw new Error("当前工作树没有可提交的本地分支")
    if (!(await options.revalidate())) throw new Error("任务绑定或已授权的变更范围发生变化")
    await checkSelection(root, files, parent, options.reviewed === true, nextIndex)
    const candidateIndex = path.join(temporary, "candidate")
    const tree = await snapshotTree(root, candidateIndex, parent, files)
    const diff = nulFields(
      await git(root, [
        "diff-tree",
        "-r",
        "--no-commit-id",
        "--name-only",
        "--no-renames",
        "-z",
        parent,
        tree
      ])
    )
    const selected = new Set(files)
    if (diff.length !== selected.size || !diff.every((file) => selected.has(file))) {
      throw new Error("候选提交树与明确选择的文件不一致")
    }
    const message = options.message.endsWith("\n") ? options.message : options.message + "\n"
    const preCommit = hooks.includes("pre-commit")
    const prepareMessage = hooks.includes("prepare-commit-msg")
    const checkMessage = hooks.includes("commit-msg")
    if (preCommit || prepareMessage || checkMessage) {
      const runHook = async (name: string, args: string[] = []) => {
        try {
          await runTaskCommitHook(root, hooksDir, name, args, candidateIndex)
        } catch (error) {
          throw new Error(
            `${name} 钩子拒绝或未能完成提交：${error instanceof Error ? error.message : error}`
          )
        }
      }
      if (preCommit) await runHook("pre-commit")
      if (prepareMessage || checkMessage) {
        const messagePath = path.join(temporary, "COMMIT_EDITMSG")
        await fs.writeFile(messagePath, message, { flag: "wx" })
        if (prepareMessage) await runHook("prepare-commit-msg", [messagePath, "message"])
        if (checkMessage) await runHook("commit-msg", [messagePath])
        if ((await fs.readFile(messagePath, "utf8")) !== message) {
          throw new Error("Git 钩子修改了已确认的任务卡提交消息，无法发布本次提交")
        }
      }
      if (outputLine(await git(root, ["write-tree"], candidateIndex)) !== tree) {
        throw new Error("Git 钩子改变了已确认的提交树，无法发布本次提交")
      }
    }
    const sha = outputLine(
      await git(
        root,
        ["commit-tree", tree, "-p", parent, ...(sign === "true" ? ["-S"] : []), "-F", "-"],
        candidateIndex,
        message
      )
    )
    const object = await git(root, ["cat-file", "commit", sha])
    const separator = object.indexOf("\n\n")
    if (
      !object.startsWith(`tree ${tree}\nparent ${parent}\n`) ||
      object.slice(separator + 2) !== message
    )
      throw new Error("候选提交校验失败")
    candidate = { sha, parent, branch, tree, files: diff }
    // Prepare the real index update on a copy. git reset touches only the exact
    // selected entries; unrelated staged changes and partial stages remain intact.
    for (const chunk of gitPathChunks(files)) {
      await git(root, ["reset", "-q", sha, "--", ...chunk], nextIndex)
    }
    await fs.chmod(nextIndex, Number(savedIndex.mode))
    pendingIndex = await fs.stat(nextIndex, { bigint: true })
    if (pendingIndex.ino === BigInt(0)) throw new Error("文件系统未提供可核对的暂存锁标识")
    if (options.onPrepared) {
      const preparedDigest = await indexDigest(nextIndex)
      candidate.indexRecovery = {
        parent,
        previousDigest,
        preparedDigest,
        lockDevice: String(pendingIndex.dev),
        lockInode: String(pendingIndex.ino),
        pid: process.pid,
        processInstance
      }
      await options.onPrepared(candidate)
    }
    // Atomically claim Git's lock without replacing any existing writer. The durable
    // receipt already identifies this exact inode even if the process dies immediately
    // after link(). Slow hooks and signing never leave an unidentifiable index.lock.
    await fs.link(nextIndex, lockPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") throw new Error("Git 暂存区正由其他操作写入，请稍后重试")
      throw new Error(`文件系统无法原子创建可恢复的 Git 暂存锁：${error.message}`)
    })
    ownsIndexLock = true
    if ((await indexDigest(indexPath)) !== previousDigest) {
      throw new Error("Git 暂存区在准备期间被修改")
    }
    try {
      await runHeadTransaction(
        root,
        branch,
        `update HEAD ${sha} ${parent}`,
        `commit: ${message.split("\n", 1)[0]}`,
        async () => {
          const [realScope, currentDir] = await Promise.all([
            fs.realpath(options.worktreePath),
            git(scope, ["rev-parse", "--absolute-git-dir"]).then(outputLine),
            assertOrdinaryCommit(gitDir, hooksDir),
            verifyPaths(root, scope, [...new Set(options.filePaths)])
          ])
          if (path.relative(scope, realScope) !== "" || path.relative(gitDir, currentDir) !== "") {
            throw new Error("工作树目录绑定已变化")
          }
          const currentTree = await snapshotTree(
            root,
            path.join(temporary, "verified"),
            parent,
            files
          )
          if (currentTree !== tree) throw new Error("文件内容在提交准备期间发生变化")
          if (!(await options.revalidate())) throw new Error("任务绑定或已授权的变更范围发生变化")
          const actualIndex = await fs.stat(indexPath, { bigint: true })
          if (
            actualIndex.ino !== savedIndex.ino ||
            actualIndex.ctimeNs !== savedIndex.ctimeNs ||
            actualIndex.size !== savedIndex.size
          )
            throw new Error("Git 暂存区在准备期间被修改")
        },
        options.canPublish
      )
    } catch (error) {
      if (!(error instanceof UnconfirmedPublication)) throw error
      const tip = await git(root, ["rev-parse", "--verify", branch])
        .then(outputLine)
        .catch(() => "")
      if (tip !== sha) {
        keepIndexLock = true
        throw error
      }
    }
    published = true
    keepIndexLock = true
    if (!(await sameLockFile(lockPath, pendingIndex))) throw new Error("暂存锁被替换，需核对索引")
    await fs.rename(lockPath, indexPath)
    ownsIndexLock = false
    if (hooks.includes("post-commit")) await runTaskCommitHook(root, hooksDir, "post-commit")
    return { status: "committed", sha, branch, files: diff }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (error instanceof UnconfirmedPublication) return { status: "failed", reason }
    if (candidate && published) {
      return {
        status: "committed",
        sha: candidate.sha,
        branch: candidate.branch,
        files: candidate.files,
        ...(ownsIndexLock ? { needsIndexRecovery: true } : {}),
        warning: reason
      }
    }
    return { status: "review", reason }
  } finally {
    if (
      ownsIndexLock &&
      !keepIndexLock &&
      pendingIndex &&
      (await sameLockFile(lockPath, pendingIndex))
    ) {
      await fs.unlink(lockPath)
    }
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Reconcile only the exact index.lock prepared for this published receipt. An unrelated
 * Git writer, a later ref movement, or manual index edits keep their existing state. */
export async function recoverTaskBoundCommitIndex(
  worktreePath: string,
  sha: string,
  recovery: TaskCommitIndexRecovery | undefined,
  branch: string
): Promise<{ ok: boolean; cleared?: true; reason?: string }> {
  if (!recovery) return { ok: true }
  let releaseQueue: (() => void) | undefined
  let releaseWrite: (() => void) | undefined
  const preparation = prepareGitPanelWrite("task-commit")
  try {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha) || !branch.startsWith("refs/heads/"))
      throw new Error("无法验证提交回执中的工作树")
    const [gitDir, indexPath] = await Promise.all([
      gitPath(worktreePath, "--absolute-git-dir"),
      gitPath(worktreePath, "--git-path", "index")
    ])
    const lockPath = indexPath + ".lock"
    releaseQueue = await acquireTaskBoundWorktreeWrite(gitDir)
    releaseWrite = await preparation.reserve(worktreePath, Promise.resolve(gitDir))
    // The receipt may already be persisted while its owner has yet to link index.lock.
    if (recovery.processInstance !== processInstance) {
      try {
        process.kill(recovery.pid, 0)
        throw new Error("原提交进程仍在运行，请稍后核对")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
      }
    }
    // Git's atomic lockfile rename consumes index.lock on successful installation.
    if (!(await exists(lockPath))) {
      const current = await indexDigest(indexPath)
      if (current === recovery.previousDigest) {
        const [tip, activeBranch] = await Promise.all([
          git(worktreePath, ["rev-parse", "--verify", "HEAD"]).then(outputLine),
          git(worktreePath, ["symbolic-ref", "-q", "HEAD"]).then(outputLine)
        ])
        if (tip === recovery.parent && activeBranch === branch) {
          return {
            ok: false,
            cleared: true,
            reason: "原分支和暂存区保持提交前状态，暂存锁已清除，请核对历史。"
          }
        }
        if (current !== recovery.preparedDigest) {
          throw new Error("暂存区仍是提交前内容且预备索引已丢失，请人工核对")
        }
      }
      return { ok: true }
    }
    const currentTip = outputLine(await git(worktreePath, ["rev-parse", "--verify", "HEAD"]))
    if (currentTip !== sha && currentTip !== recovery.parent) {
      throw new Error("目标分支已移动，已保留暂存锁，请按候选 SHA 核对")
    }
    await runHeadTransaction(
      worktreePath,
      branch,
      `verify HEAD ${currentTip}`,
      "verify commit index",
      async () => {
        // Git's prepared HEAD transaction is the cross-process recovery lock. Another
        // recovery may have finished while this one was waiting for the ref locks.
        if (!(await exists(lockPath))) {
          const required = currentTip === sha ? recovery.preparedDigest : recovery.previousDigest
          if ((await indexDigest(indexPath)) !== required)
            throw new Error("暂存区已变化，请人工核对")
          return
        }
        const lockStat = await fs.lstat(lockPath, { bigint: true })
        if (
          !lockStat.isFile() ||
          lockStat.ino === BigInt(0) ||
          String(lockStat.dev) !== recovery.lockDevice ||
          String(lockStat.ino) !== recovery.lockInode
        ) {
          throw new Error("现有暂存锁与提交回执中的文件身份不一致，请人工核对")
        }
        const [current, pending] = await Promise.all([
          indexDigest(indexPath),
          indexDigest(lockPath)
        ])
        if (pending !== recovery.preparedDigest || current !== recovery.previousDigest) {
          throw new Error("暂存锁或索引内容与提交回执不一致，请人工核对")
        }
        if (currentTip === sha) await fs.rename(lockPath, indexPath)
        else await fs.unlink(lockPath)
      }
    )
    if (currentTip !== sha) {
      return {
        ok: false,
        cleared: true,
        reason: "分支仍指向原父提交，已释放本请求遗留的暂存锁。请核对历史后再发起提交。"
      }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  } finally {
    releaseWrite?.()
    releaseQueue?.()
    preparation.dispose()
  }
}

export async function executeTaskBoundGitCommit(
  options: TaskBoundCommitOptions
): Promise<TaskBoundCommitResult> {
  if (
    !options.message?.trim() ||
    options.message.includes("\0") ||
    !options.filePaths?.length ||
    !exactPaths(options.filePaths)
  ) {
    return { status: "failed", reason: "提交需要有效消息和非空、精确的工作区内相对文件路径" }
  }
  const preparation = prepareGitPanelWrite("task-commit")
  let releasePanel: (() => void) | undefined
  let releaseSerial: (() => void) | undefined
  try {
    const scope = await fs.realpath(options.worktreePath)
    const [rootPath, gitDir, indexPath, hookPath] = await Promise.all([
      gitPath(scope, "--show-toplevel"),
      gitPath(scope, "--absolute-git-dir"),
      gitPath(scope, "--git-path", "index"),
      gitPath(scope, "--git-path", "hooks/pre-commit")
    ])
    const root = await fs.realpath(rootPath)
    releaseSerial = await acquireTaskBoundWorktreeWrite(gitDir)
    releasePanel = await preparation.reserve(scope, Promise.resolve(gitDir))
    return await commitWithIndexLock(
      options,
      root,
      scope,
      gitDir,
      indexPath,
      path.dirname(hookPath)
    )
  } catch (error) {
    return { status: "review", reason: error instanceof Error ? error.message : String(error) }
  } finally {
    releaseSerial?.()
    releasePanel?.()
    preparation.dispose()
  }
}
