import { BrowserWindow } from "electron"
import { execFile } from "child_process"
import { createHash } from "crypto"
import { existsSync } from "fs"
import * as fs from "fs/promises"
import * as path from "path"
import { promisify } from "util"
import type {
  AgentAutoCommitResult,
  AgentAutoCommitSettings
} from "../types"
import {
  getAgentAutoCommitSettings
} from "../storage"
import { trackEvent } from "./event-reporter"
import { getTracesDir } from "../agent/trace/collector"
import type { AgentTrace } from "../agent/trace/types"

const execFileAsync = promisify(execFile)
const GIT_EXEC_MAX_BUFFER_BYTES = 20 * 1024 * 1024
const GIT_CONTEXT_QUERY_TIMEOUT_MS = 10_000

const GIT_BASE_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_LFS_SKIP_SMUDGE: "1"
}

interface ExecFileError extends Error {
  stderr?: string | Buffer
  stdout?: string | Buffer
}

interface GitStatusEntry {
  path: string
  status: string
}

export interface AgentGitSnapshot {
  threadId: string
  workspacePath: string
  isGitRepo: boolean
  head: string | null
  branch: string | null
  dirtyFiles: string[]
  stagedFiles: string[]
  dirtyFingerprints: Record<string, string>
}

export type AgentFileMutationKind = "write" | "edit" | "upload"

const touchedFilesByThread = new Map<string, Set<string>>()

function getExecErrorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error || "")
  const execError = error as ExecFileError
  const stderr =
    typeof execError.stderr === "string"
      ? execError.stderr
      : execError.stderr
        ? execError.stderr.toString()
        : ""
  const stdout =
    typeof execError.stdout === "string"
      ? execError.stdout
      : execError.stdout
        ? execError.stdout.toString()
        : ""
  return (stderr || stdout || error.message || String(error)).trim()
}

function isDubiousOwnershipError(error: unknown): boolean {
  return getExecErrorText(error).toLowerCase().includes("detected dubious ownership")
}

function quoteArg(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value
  return `"${value.replace(/"/g, '\\"')}"`
}

async function addSafeDirectory(worktreePath: string): Promise<void> {
  await execFileAsync("git", ["config", "--global", "--add", "safe.directory", worktreePath])
}

async function runGit(
  worktreePath: string,
  args: string[],
  options?: { silent?: boolean; timeoutMs?: number; maxBufferBytes?: number }
): Promise<string> {
  const baseArgs = ["-C", worktreePath, ...args]
  const command = `git -C ${quoteArg(worktreePath)} ${args.map((arg) => quoteArg(arg)).join(" ")}`
  if (!options?.silent) console.log(`[AutoCommit][exec] ${command}`)
  try {
    const { stdout } = await execFileAsync("git", baseArgs, {
      env: GIT_BASE_ENV,
      timeout: options?.timeoutMs,
      maxBuffer: options?.maxBufferBytes ?? GIT_EXEC_MAX_BUFFER_BYTES
    })
    return stdout
  } catch (error) {
    if (!isDubiousOwnershipError(error)) throw error
    await addSafeDirectory(worktreePath)
    const { stdout } = await execFileAsync("git", baseArgs, {
      env: GIT_BASE_ENV,
      timeout: options?.timeoutMs,
      maxBuffer: options?.maxBufferBytes ?? GIT_EXEC_MAX_BUFFER_BYTES
    })
    return stdout
  }
}

function normalizeGitRelativePath(input: string): string {
  return String(input || "")
    .trim()
    .replace(/^"(.*)"$/, "$1")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "")
}

function toWorktreeRelativePath(worktreePath: string, rawPath: string): string | null {
  const trimmed = normalizeGitRelativePath(rawPath)
  if (!trimmed) return null
  const worktreeAbs = path.resolve(worktreePath)
  const rawResolved = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(worktreePath, rawPath)
  const rel = path.relative(worktreeAbs, rawResolved)
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    return normalizeGitRelativePath(rel)
  }
  return trimmed
}

function isRenameOrCopyStatus(status: string): boolean {
  const x = status[0]
  const y = status[1]
  return x === "R" || x === "C" || y === "R" || y === "C"
}

function parseStatusEntries(output: string): GitStatusEntry[] {
  if (!output.trim()) return []
  if (output.includes("\0")) {
    const entries = output.split("\0").filter(Boolean)
    const result: GitStatusEntry[] = []
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      if (entry.length < 4) continue
      const status = entry.slice(0, 2)
      const rawPath = entry.slice(3)
      if (!rawPath) continue
      if (isRenameOrCopyStatus(status) && i + 1 < entries.length) {
        result.push({ status, path: normalizeGitRelativePath(entries[i + 1]) })
        i += 1
      } else {
        result.push({ status, path: normalizeGitRelativePath(rawPath) })
      }
    }
    return result
  }

  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .flatMap((line): GitStatusEntry[] => {
      if (line.length < 4) return []
      const status = line.slice(0, 2)
      const rawPath = line.slice(3).split(" -> ").pop() || line.slice(3)
      const normalized = normalizeGitRelativePath(rawPath)
      return normalized ? [{ status, path: normalized }] : []
    })
}

async function runStatus(worktreePath: string): Promise<GitStatusEntry[]> {
  try {
    const out = await runGit(
      worktreePath,
      [
        "-c",
        "core.quotepath=false",
        "status",
        "--porcelain",
        "--untracked-files=all",
        "-z",
        "--",
        "."
      ],
      { silent: true, timeoutMs: 15_000 }
    )
    return parseStatusEntries(out)
  } catch {
    const out = await runGit(
      worktreePath,
      [
        "-c",
        "core.quotepath=false",
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--",
        "."
      ],
      { silent: true, timeoutMs: 15_000 }
    )
    return parseStatusEntries(out)
  }
}

function getStagedFiles(entries: GitStatusEntry[]): string[] {
  return entries
    .filter((entry) => entry.status[0] && entry.status[0] !== " " && entry.status[0] !== "?")
    .map((entry) => entry.path)
}

async function getFileFingerprint(worktreePath: string, relPath: string): Promise<string> {
  const absPath = path.join(worktreePath, relPath)
  try {
    const stat = await fs.stat(absPath)
    if (!stat.isFile()) return `non-file:${stat.size}:${stat.mtimeMs}`
    const buffer = await fs.readFile(absPath)
    return `sha256:${createHash("sha256").update(buffer).digest("hex")}`
  } catch {
    return "missing"
  }
}

async function getFingerprints(
  worktreePath: string,
  files: string[]
): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  await Promise.all(
    files.map(async (file) => {
      result[file] = await getFileFingerprint(worktreePath, file)
    })
  )
  return result
}

async function getCurrentBranch(worktreePath: string): Promise<string | null> {
  try {
    const branch = (
      await runGit(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"], {
        silent: true,
        timeoutMs: GIT_CONTEXT_QUERY_TIMEOUT_MS
      })
    ).trim()
    return branch && branch !== "HEAD" ? branch : null
  } catch {
    return null
  }
}

async function getHead(worktreePath: string): Promise<string | null> {
  try {
    const head = (
      await runGit(worktreePath, ["rev-parse", "HEAD"], {
        silent: true,
        timeoutMs: GIT_CONTEXT_QUERY_TIMEOUT_MS
      })
    ).trim()
    return head || null
  } catch {
    return null
  }
}

async function isGitRepo(workspacePath: string): Promise<boolean> {
  try {
    await runGit(workspacePath, ["rev-parse", "--show-toplevel"], {
      silent: true,
      timeoutMs: GIT_CONTEXT_QUERY_TIMEOUT_MS
    })
    return true
  } catch {
    return false
  }
}

export async function startAgentGitSnapshot(
  threadId: string,
  workspacePath: string | undefined
): Promise<AgentGitSnapshot | null> {
  touchedFilesByThread.set(threadId, new Set())
  if (!workspacePath) return null

  const settings = getAgentAutoCommitSettings()
  if (settings.mode === "off") return null

  if (!(await isGitRepo(workspacePath))) {
    return {
      threadId,
      workspacePath,
      isGitRepo: false,
      head: null,
      branch: null,
      dirtyFiles: [],
      stagedFiles: [],
      dirtyFingerprints: {}
    }
  }

  const [head, branch, entries] = await Promise.all([
    getHead(workspacePath),
    getCurrentBranch(workspacePath),
    runStatus(workspacePath)
  ])
  const dirtyFiles = Array.from(new Set(entries.map((entry) => entry.path)))
  return {
    threadId,
    workspacePath,
    isGitRepo: true,
    head,
    branch,
    dirtyFiles,
    stagedFiles: getStagedFiles(entries),
    dirtyFingerprints: await getFingerprints(workspacePath, dirtyFiles)
  }
}

export function recordAgentTouchedFile(
  threadId: string,
  workspacePath: string,
  filePath: string
): void {
  const rel = toWorktreeRelativePath(workspacePath, filePath)
  if (!rel) return
  let set = touchedFilesByThread.get(threadId)
  if (!set) {
    set = new Set()
    touchedFilesByThread.set(threadId, set)
  }
  set.add(rel)
}

export function discardAgentAutoCommitTracking(threadId: string): void {
  touchedFilesByThread.delete(threadId)
}

function cleanSummary(input: string | undefined): string {
  const cleaned = (input || "")
    .replace(/\s+/g, " ")
    .replace(/[#\r\n]+/g, " ")
    .trim()
  if (!cleaned) return "agent changes"
  return cleaned.length > 60 ? `${cleaned.slice(0, 60).trimEnd()}...` : cleaned
}

function buildDiffSummary(candidateFiles: string[]): string {
  if (candidateFiles.length === 0) return "agent changes"
  if (candidateFiles.length === 1) return `update ${path.basename(candidateFiles[0])}`
  const topDirs = Array.from(
    new Set(candidateFiles.map((file) => file.split("/")[0]).filter(Boolean))
  ).slice(0, 2)
  const scope = topDirs.length > 0 ? ` in ${topDirs.join(", ")}` : ""
  return `update ${candidateFiles.length} files${scope}`
}

function buildCommitMessage(
  settings: AgentAutoCommitSettings,
  threadId: string,
  userPrompt: string | undefined,
  candidateFiles: string[]
): { message?: string; reason?: string } {
  const cardNumber = settings.cardNumber?.trim()
  if (!cardNumber) {
    return { reason: "自动提交缺少卡片编号，请先在设置中填写卡片编号" }
  }

  const summary = cleanSummary(userPrompt)
  const diffSummary = buildDiffSummary(candidateFiles)
  let messageSummary = summary
  if (settings.messageStrategy === "template") {
    const template = settings.template?.trim()
    if (!template) {
      return { reason: "自动提交模板为空，已跳过提交" }
    }
    messageSummary = template
      .replaceAll("{threadId}", threadId)
      .replaceAll("{threadShort}", threadId.slice(0, 8))
      .replaceAll("{summary}", summary)
      .replaceAll("{diffSummary}", diffSummary)
      .replaceAll("{fileCount}", String(candidateFiles.length))
      .replaceAll("{files}", candidateFiles.join(", "))
  } else if (settings.messageStrategy === "diff") {
    messageSummary = diffSummary
  }

  return { message: `${cardNumber} #comment fix:${messageSummary} #CMBDevClaw` }
}

async function getUnmergedFiles(worktreePath: string): Promise<string[]> {
  const out = await runGit(worktreePath, ["diff", "--name-only", "--diff-filter=U"], {
    silent: true
  }).catch(() => "")
  return out
    .split("\n")
    .map((line) => normalizeGitRelativePath(line))
    .filter(Boolean)
}

async function getHeadCommitStats(
  worktreePath: string
): Promise<{ additions: number; deletions: number; fileCount: number }> {
  const out = await runGit(
    worktreePath,
    ["show", "--numstat", "--format=", "--no-renames", "HEAD"],
    { silent: true }
  ).catch(() => "")
  let additions = 0
  let deletions = 0
  let fileCount = 0
  for (const line of out.split("\n")) {
    const parts = line.trim().split("\t")
    if (parts.length < 3) continue
    const add = Number.parseInt(parts[0], 10)
    const del = Number.parseInt(parts[1], 10)
    if (Number.isFinite(add)) additions += add
    if (Number.isFinite(del)) deletions += del
    fileCount += 1
  }
  return { additions, deletions, fileCount }
}

function notifyWorkspaceFilesChanged(threadId: string, workspacePath: string): void {
  const getAllWindows = BrowserWindow?.getAllWindows
  if (typeof getAllWindows !== "function") return
  for (const win of getAllWindows.call(BrowserWindow)) {
    if (!win.isDestroyed()) {
      win.webContents.send("workspace:files-changed", { threadId, workspacePath })
    }
  }
}

async function clearLlmModifiedMetadata(threadId: string): Promise<void> {
  try {
    const { getThread, updateThread } = await import("../db")
    const thread = getThread(threadId)
    if (!thread) return
    let metadata: Record<string, unknown> = {}
    try {
      metadata = thread.metadata ? JSON.parse(thread.metadata) : {}
    } catch {
      metadata = {}
    }
    metadata.llmModifiedFiles = []
    metadata.llmFileHistory = {}
    metadata.llmRecentlyRevertedFiles = []
    updateThread(threadId, { metadata: JSON.stringify(metadata) })
  } catch (error) {
    if (error instanceof Error && error.message.includes("Database not initialized")) return
    console.warn("[AutoCommit] Failed to clear LLM modified metadata:", error)
  }
}

async function getThreadLlmModifiedFiles(
  threadId: string,
  workspacePath: string
): Promise<string[]> {
  try {
    const { getThread } = await import("../db")
    const thread = getThread(threadId)
    if (!thread) return []
    let metadata: Record<string, unknown> = {}
    try {
      metadata = thread.metadata ? JSON.parse(thread.metadata) : {}
    } catch {
      metadata = {}
    }
    const raw = metadata.llmModifiedFiles
    if (!Array.isArray(raw)) return []
    const files = new Set<string>()
    for (const item of raw) {
      if (typeof item !== "string") continue
      const rel = toWorktreeRelativePath(workspacePath, item)
      if (rel) files.add(rel)
    }
    return Array.from(files)
  } catch {
    return []
  }
}

async function collectThreadSkillStatsAsync(threadId: string): Promise<string[]> {
  try {
    const dir = path.join(getTracesDir(), threadId)
    let files: string[]
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith(".jsonl"))
    } catch {
      return []
    }
    if (files.length > 10) files = files.slice(-10)
    const skillSet = new Set<string>()
    for (const file of files) {
      const raw = await fs.readFile(path.join(dir, file), "utf-8")
      for (const line of raw.trim().split("\n")) {
        if (!line.trim()) continue
        try {
          const trace = JSON.parse(line) as AgentTrace
          if (Array.isArray(trace.usedSkills)) {
            for (const skill of trace.usedSkills) skillSet.add(skill)
          }
        } catch {
          // skip malformed trace line
        }
      }
    }
    return Array.from(skillSet)
  } catch {
    return []
  }
}

function trackAutoCommit(threadId: string, workspacePath: string, changedFiles: string[]): void {
  collectThreadSkillStatsAsync(threadId)
    .then(async (usedSkills) => {
      const [stats, branch] = await Promise.all([
        getHeadCommitStats(workspacePath),
        getCurrentBranch(workspacePath)
      ])
      trackEvent("git.commit.created", "git", {
        repoPath: workspacePath,
        branch: branch || "",
        filesChanged: stats.fileCount || changedFiles.length,
        insertions: stats.additions,
        deletions: stats.deletions,
        triggeredBy: "agent-auto",
        threadId,
        usedSkills,
        skillCount: usedSkills.length
      })
    })
    .catch((error) => console.warn("[AutoCommit] telemetry failed:", error))
}

export async function maybeAutoCommitAfterAgentRun({
  threadId,
  workspacePath,
  userPrompt,
  snapshot,
  confirm
}: {
  threadId: string
  workspacePath: string | undefined
  userPrompt?: string
  snapshot: AgentGitSnapshot | null
  confirm?: (result: AgentAutoCommitResult) => Promise<boolean>
}): Promise<AgentAutoCommitResult> {
  try {
    const settings = getAgentAutoCommitSettings()
    if (settings.mode === "off") {
      return { status: "disabled" }
    }

    if (!workspacePath) {
      return { status: "skipped", reasons: ["未配置工作区，已跳过自动提交"] }
    }
    if (!snapshot || !snapshot.isGitRepo) {
      return { status: "skipped", reasons: ["当前工作区不是 Git 仓库，已跳过自动提交"] }
    }
    if (!existsSync(workspacePath)) {
      return { status: "skipped", reasons: ["工作区路径不存在，已跳过自动提交"] }
    }

    const reasons: string[] = []
    const warnings: string[] = []
    const currentHead = await getHead(workspacePath)
    if (snapshot.head && currentHead && currentHead !== snapshot.head) {
      return {
        status: "skipped",
        reasons: ["Agent 执行期间 HEAD 发生变化，为避免误提交，已跳过自动提交"]
      }
    }

    const unmerged = await getUnmergedFiles(workspacePath)
    if (unmerged.length > 0) {
      return {
        status: "skipped",
        reasons: ["检测到冲突文件，自动提交已跳过"],
        skippedFiles: unmerged
      }
    }

    const entries = await runStatus(workspacePath)
    const endDirty = new Set(entries.map((entry) => entry.path))
    const startDirty = new Set(snapshot.dirtyFiles)
    const touched = touchedFilesByThread.get(threadId) ?? new Set<string>()
    const trackedByGitPanel = new Set(await getThreadLlmModifiedFiles(threadId, workspacePath))
    const agentReported = new Set([...touched, ...trackedByGitPanel])

    // Any pre-existing dirty file whose content changed during the run is a candidate.
    // We no longer require the file to be in `agentReported`: shell-tool side effects
    // (npm install, prettier --write, git mv, code-gen, etc.) never reach _onFileMutation,
    // so filtering by it caused legitimate agent changes to be skipped.
    const changedStartDirty = new Set<string>()
    await Promise.all(
      snapshot.dirtyFiles.map(async (file) => {
        if (!endDirty.has(file)) return
        const current = await getFileFingerprint(workspacePath, file)
        if (current !== snapshot.dirtyFingerprints[file]) changedStartDirty.add(file)
      })
    )

    const newDirtyFiles = Array.from(endDirty).filter((file) => !startDirty.has(file))
    const candidate = new Set<string>()
    for (const file of newDirtyFiles) {
      candidate.add(file)
    }
    for (const file of changedStartDirty) {
      candidate.add(file)
    }

    const candidateFiles = Array.from(candidate).sort()
    const skippedFiles = Array.from(endDirty)
      .filter((file) => !candidate.has(file))
      .sort()

    const preexistingIncluded = candidateFiles.filter((file) => startDirty.has(file))
    if (preexistingIncluded.length > 0) {
      warnings.push(
        `本次自动提交包含 ${preexistingIncluded.length} 个 Agent 开始前已有未提交改动、且本轮被修改的文件`
      )
    }
    if (newDirtyFiles.length > 0) {
      warnings.push(`本次自动提交包含 ${newDirtyFiles.length} 个本轮新增的脏文件`)
    }
    const unreportedCandidates = candidateFiles.filter((file) => !agentReported.has(file))
    if (unreportedCandidates.length > 0) {
      warnings.push(
        `其中 ${unreportedCandidates.length} 个文件未被 Agent 工具主动报告（可能来自 shell 命令或外部修改），如非预期请人工核对`
      )
    }

    // Foreign-staged gate: any `git add` performed during the run must be against a
    // file the agent itself reported via _onFileMutation / Git panel tracking. A user
    // who stages something manually is signaling intent the auto-commit must not
    // override — even if that file would otherwise qualify as a candidate (e.g. a
    // newly created file). Gating on `agentReported` (not on the broader `candidate`
    // set) preserves this protection after we relaxed candidate selection to also
    // capture unreported shell-tool side effects.
    const stagedEnd = new Set(getStagedFiles(entries))
    const foreignStaged = Array.from(stagedEnd).filter((file) => !agentReported.has(file))
    if (foreignStaged.length > 0) {
      return {
        status: "skipped",
        reasons: ["检测到非本轮 Agent 改动已暂存，为避免误提交，已跳过自动提交"],
        skippedFiles: foreignStaged,
        warnings
      }
    }

    if (candidateFiles.length === 0) {
      reasons.push("未发现本轮 Agent 产生的可提交改动，已跳过自动提交")
      if (skippedFiles.length > 0) {
        reasons.push("工作区仍有未提交改动，但这些文件不符合自动提交规则")
      }
      return { status: "skipped", reasons, skippedFiles, warnings }
    }

    const commitMessageResult = buildCommitMessage(settings, threadId, userPrompt, candidateFiles)
    if (!commitMessageResult.message) {
      return {
        status: "skipped",
        reasons: [commitMessageResult.reason || "未能生成提交信息，已跳过自动提交"],
        committedFiles: candidateFiles,
        skippedFiles,
        warnings
      }
    }
    const commitMessage = commitMessageResult.message

    const previewMessage = settings.push
      ? `准备自动提交并推送 ${candidateFiles.length} 个文件`
      : `准备自动提交 ${candidateFiles.length} 个文件`
    const preview: AgentAutoCommitResult = {
      status: "needs_confirmation",
      message: previewMessage,
      commitMessage,
      committedFiles: candidateFiles,
      skippedFiles,
      warnings
    }
    if (settings.mode === "ask") {
      const approved = await confirm?.(preview)
      if (!approved) {
        return {
          ...preview,
          status: "skipped",
          reasons: ["用户取消了本次自动提交"]
        }
      }
    }

    try {
      await runGit(workspacePath, ["add", "--", ...candidateFiles])
      await runGit(workspacePath, ["commit", "-m", commitMessage])
      const commitHash = await getHead(workspacePath)
      await clearLlmModifiedMetadata(threadId)
      notifyWorkspaceFilesChanged(threadId, workspacePath)
      trackAutoCommit(threadId, workspacePath, candidateFiles)

      let pushed: boolean | undefined
      let pushError: string | undefined
      if (settings.push) {
        try {
          await runGit(workspacePath, ["push"])
          pushed = true
        } catch (error) {
          // Commit already succeeded — don't roll it back. Report push failure as
          // a partial outcome so the user can retry manually.
          pushed = false
          pushError = getExecErrorText(error) || "推送失败"
        }
      }

      const successMessage = pushed
        ? `自动提交并推送成功：${candidateFiles.length} 个文件`
        : settings.push
          ? `自动提交成功（推送失败）：${candidateFiles.length} 个文件`
          : `自动提交成功：${candidateFiles.length} 个文件`
      return {
        status: "committed",
        message: successMessage,
        commitMessage,
        commitHash: commitHash ?? undefined,
        committedFiles: candidateFiles,
        skippedFiles,
        warnings,
        ...(pushed !== undefined ? { pushed } : {}),
        ...(pushError ? { pushError } : {})
      }
    } catch (error) {
      return {
        status: "failed",
        message: "自动提交失败",
        commitMessage,
        committedFiles: candidateFiles,
        skippedFiles,
        warnings,
        reasons: [getExecErrorText(error) || "提交失败"]
      }
    }
  } finally {
    touchedFilesByThread.delete(threadId)
  }
}
