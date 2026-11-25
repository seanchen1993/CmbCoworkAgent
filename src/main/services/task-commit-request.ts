import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import path from "node:path"
import { promisify } from "node:util"
import { taskCommitCall } from "../agent/task-commit-call"
import { getDb } from "../db"
import { hasCleanTaskCommitBaseline } from "./task-commit-baseline"
import { verifyTaskCommitEdits } from "./task-commit-edits"
import { readCurrentTaskCommitBinding, readTaskCommitBinding } from "./task-commit-binding"
import { resolveTaskCommitTarget } from "./task-commit-target"
import {
  executeTaskBoundGitCommit,
  recoverTaskBoundCommitIndex,
  type TaskCommitIndexRecovery
} from "./task-bound-git-commit"
import { withoutGitRepositoryOverrides } from "./git-environment"
import {
  rememberTaskCommitIndex,
  recoverPendingTaskIndex,
  forgetTaskCommitIndex
} from "./task-commit-recovery"

const exec = promisify(execFile)
type Binding = NonNullable<Awaited<ReturnType<typeof readTaskCommitBinding>>>
type Request = {
  threadId: string
  binding: Binding
  target: string
  files: string[]
  suggestion: string
  signal?: AbortSignal
}
type Outcome = { status: "review" | "failed" | "committed"; message: string }
type Candidate = {
  sha: string
  branch: string
  time: number
  indexRecovery?: TaskCommitIndexRecovery
}
const pending = new Map<string, { digest: string; promise: Promise<Outcome> }>()

function commitMessage(card: string, suggestion: string): string | null {
  if (!card.trim()) return null
  const match = suggestion.trim().match(/#comment\s+([a-z]+):([\s\S]*?)\s*#CMBDevClaw\s*$/i)
  const summary = (match ? match[2] : suggestion).trim()
  if (!summary) return null
  const type = match?.[1].toLowerCase() ?? "fix"
  const knownType = /^(fix|feat|refactor|docs|style|test|chore)$/.test(type) ? type : "fix"
  return `${card} #comment ${knownType}:${summary} #CMBDevClaw`
}

export async function tryTaskBoundCommit(request: Request): Promise<Outcome> {
  const { threadId, binding, target, files, suggestion } = request
  const call = taskCommitCall.getStore()
  const message = commitMessage(binding.cardNumber, suggestion)
  if (call?.binding !== undefined && call.binding?.version !== binding.version) {
    return { status: "failed", message: "工具调用开始后任务提交设置已更改，请重新发起提交。" }
  }
  if (
    !message ||
    call?.threadId !== threadId ||
    !files.length ||
    !binding.repositoryPaths.some((root) => !path.relative(root, target))
  ) {
    return { status: "review", message: "请在桌面确认任务、目标工作树和提交信息。" }
  }
  if (
    files.some(
      (file) =>
        path.isAbsolute(file) ||
        file.split(/[\\/]/).some((part) => part === "." || part === ".." || !part) ||
        [":", "*", "?", "[", "\0"].some((marker) => file.includes(marker))
    )
  ) {
    return { status: "review", message: "请在桌面确认本次提交的具体文件。" }
  }
  const digest = createHash("sha256")
    .update(JSON.stringify([binding.version, target, message, [...files].sort()]))
    .digest("hex")
  const key = JSON.stringify([threadId, call.callId])
  const existing = pending.get(key)
  const conflict: Outcome = {
    status: "failed",
    message: "同一工具调用的提交参数已变更，请核对仓库。"
  }
  if (existing) return existing.digest === digest ? existing.promise : conflict
  const promise = executeRequest(request, call.callId, digest, message, conflict)
  pending.set(key, { digest, promise })
  try {
    return await promise
  } finally {
    pending.delete(key)
  }
}

async function executeRequest(
  request: Request,
  callId: string,
  digest: string,
  message: string,
  conflict: Outcome
): Promise<Outcome> {
  const { threadId, binding, target, files, signal } = request
  const gitRoot = binding.checkoutRoots?.[target] ?? target
  const db = getDb()
  const keys = [threadId, callId]
  const row = db.exec(
    `SELECT digest, candidate, result, recorded FROM task_commit_receipts
    WHERE thread_id = ? AND call_id = ?`,
    keys
  )[0]?.values[0]
  if (row && row[0] !== digest) return conflict
  let candidate: Candidate | undefined
  let warning: string | undefined
  let needsIndexRecovery = false
  const uncertain: Outcome = {
    status: "failed",
    message: "上次提交未收到完整回执，请核对 Git 历史。"
  }
  if (row) {
    if (typeof row[1] !== "string") return uncertain
    candidate = JSON.parse(row[1]) as Candidate
    if (!row[2] || row[3] === -1) {
      try {
        await exec(
          "git",
          ["-C", target, "merge-base", "--is-ancestor", candidate.sha, candidate.branch],
          {
            timeout: 10_000,
            windowsHide: true,
            env: withoutGitRepositoryOverrides(process.env, "workspace")
          }
        )
      } catch {
        const recovery = await recoverTaskBoundCommitIndex(
          target,
          candidate.sha,
          candidate.indexRecovery,
          candidate.branch
        )
        return {
          ...uncertain,
          message: `${uncertain.message} 候选 ${candidate.sha}。${recovery.reason ?? ""}`
        }
      }
      const recovered = await recoverTaskBoundCommitIndex(
        target,
        candidate.sha,
        candidate.indexRecovery,
        candidate.branch
      )
      if (!recovered.ok) {
        return {
          status: "committed",
          message: `已提交 ${candidate.sha}，索引需核对：${recovered.reason}`
        }
      }
    } else if (row[3]) {
      return { status: "committed", message: String(row[2]) }
    }
  } else {
    if (!hasCleanTaskCommitBaseline(binding.dirtyAtSelection, target, files)) {
      return { status: "review", message: "所选文件在任务授权前已有改动，请在桌面确认。" }
    }
    const revalidate = async () => {
      if (signal?.aborted) return false
      const resolved = await resolveTaskCommitTarget(
        threadId,
        binding.workspacePath,
        target,
        binding.version
      )
      return !("error" in resolved) && !path.relative(target, resolved.worktreePath)
    }
    if (!(await revalidate())) return { status: "failed", message: "提交授权已变更或请求已取消。" }
    const recoveryError = await recoverPendingTaskIndex(gitRoot)
    if (recoveryError) return { status: "failed", message: recoveryError }
    const preimages = new Map<string, string | null>()
    const repoFiles = files.map((file) =>
      path.relative(gitRoot, path.resolve(target, file)).split(path.sep).join("/")
    )
    const verifyEdits = () =>
      verifyTaskCommitEdits(threadId, binding.version, gitRoot, repoFiles, preimages)
    if (!(await verifyEdits())) {
      return { status: "review", message: "文件中含有无法归属到本任务的变更，请在桌面确认。" }
    }
    db.run("INSERT INTO task_commit_receipts(thread_id,call_id,digest) VALUES(?,?,?)", [
      ...keys,
      digest
    ])
    const outcome = await executeTaskBoundGitCommit({
      worktreePath: target,
      filePaths: files,
      message,
      revalidate: async () => (await verifyEdits()) && (await revalidate()),
      canPublish: () =>
        !signal?.aborted && readCurrentTaskCommitBinding(threadId)?.version === binding.version,
      onPrepared: async (prepared) => {
        if (
          !(await verifyTaskCommitEdits(
            threadId,
            binding.version,
            gitRoot,
            repoFiles,
            preimages,
            prepared
          ))
        ) {
          throw new Error("候选提交内容与任务生成的文件不一致，请在桌面确认。")
        }
        candidate = {
          sha: prepared.sha,
          branch: prepared.branch,
          time: Date.now(),
          indexRecovery: prepared.indexRecovery
        }
        db.run(
          "UPDATE task_commit_receipts SET candidate=? WHERE thread_id=? AND call_id=? AND digest=?",
          [JSON.stringify(candidate), ...keys, digest]
        )
        if (db.getRowsModified() !== 1) throw new Error("提交请求已失效")
        rememberTaskCommitIndex(threadId, gitRoot, prepared)
      }
    })
    if (outcome.status !== "committed") {
      if (candidate && outcome.status === "review") forgetTaskCommitIndex(gitRoot, candidate)
      // A known pre-publication rejection can go through normal desktop review.
      // An interrupted/unknown publication keeps its candidate for recovery.
      if (outcome.status === "review" || !candidate) {
        db.run("DELETE FROM task_commit_receipts WHERE thread_id=? AND call_id=? AND digest=?", [
          ...keys,
          digest
        ])
      }
      return { status: outcome.status, message: outcome.reason }
    }
    candidate = {
      ...candidate,
      sha: outcome.sha,
      branch: outcome.branch,
      time: candidate?.time ?? Date.now()
    }
    warning = outcome.warning
    needsIndexRecovery = outcome.needsIndexRecovery === true
  }
  const published = candidate
  const output = row?.[2]
    ? String(row[2])
    : [
        `已提交 ${binding.cardNumber} · ${target} · ${published.branch.replace(/^refs\/heads\//, "")} · ${published.sha}`,
        ...files,
        warning
      ]
        .filter(Boolean)
        .join("\n")
  try {
    db.run(
      "UPDATE task_commit_receipts SET result=?, recorded=? WHERE thread_id=? AND call_id=? AND digest=?",
      [output, needsIndexRecovery ? -1 : 0, ...keys, digest]
    )
    if (!row) {
      if (!needsIndexRecovery) forgetTaskCommitIndex(gitRoot, published)
      for (const file of files) {
        const absolute = path.resolve(target, file)
        db.run("DELETE FROM task_commit_edits WHERE thread_id=? AND version=? AND path=?", [
          threadId,
          binding.version,
          process.platform === "win32" ? absolute.toLowerCase() : absolute
        ])
      }
    }
    const { recordPublishedTaskCommit } = await import("../ipc/models")
    await recordPublishedTaskCommit({
      threadId,
      workspacePath: binding.workspacePath,
      worktreePath: target,
      commitSha: published.sha,
      branch: published.branch.replace(/^refs\/heads\//, ""),
      message,
      commitTimeMs: published.time
    })
    if (!needsIndexRecovery)
      db.run(
        "UPDATE task_commit_receipts SET recorded=1 WHERE thread_id=? AND call_id=? AND digest=?",
        [...keys, digest]
      )
  } catch (error) {
    console.warn("[TaskCommit] post-commit recording pending", published.sha, error)
  }
  return { status: "committed", message: output }
}
