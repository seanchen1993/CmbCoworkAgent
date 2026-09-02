/**
 * Tool Orchestrator: approval + sandbox + retry pipeline.
 *
 * Sits between the agent framework and LocalSandbox's raw execute method.
 * Handles:
 *   1. Command safety assessment
 *   2. Cached / interactive approval (shell commands + file write/edit)
 *   3. Sandbox execution
 *   4. Sandbox-denial → block and inform user to switch sandbox mode
 */

import { randomUUID } from "crypto"
import { realpath } from "fs/promises"
import path from "path"
import { ApprovalStore } from "./approval-store"
import {
  assessCommandSafety,
  containsIndirectGitPush,
  derivePermanentApprovalPattern,
  extractGitCommitPathspecs,
  extractGitCommitMessage,
  hasUnsupportedGitCommitScope,
  isAmendOrFixupCommit,
  isChainedShellCommand,
  isForcePushCommand,
  isGitCommitCommand,
  isGitPushCommand,
  resolveGitCommandCwd,
  resolveGitPushCommandCwd,
  type CommandShellSyntax
} from "./exec-policy"
import { LocalSandbox } from "./local-sandbox"
import type {
  ApprovalRequest,
  ApprovalDecision,
  ReviewDecision,
  ApprovalDecisionType
} from "../types"
import {
  discoverWorkspaceGitRepositories,
  getGitRootForPath
} from "../services/git-repository-discovery"
import type { ExecuteResponse } from "deepagents"

/** Raw execution function signature (no approval logic). */
export type RawExecuteFn = (
  command: string,
  sandboxMode?: string,
  cwd?: string
) => Promise<ExecuteResponse>

/** Function to request interactive approval from the user (renderer). */
export type RequestApprovalFn = (req: ApprovalRequest) => Promise<ApprovalDecision>

/**
 * Generic prompt shown when a sandboxed command fails with output that looks like a
 * sandbox-induced denial. Mirrors Codex's `command failed; retry without sandbox?` —
 * intentionally non-specific so we don't have to enumerate every tool-specific failure.
 */
const SANDBOX_BYPASS_PROMPT_REASON =
  "命令在沙箱内执行失败，疑似受沙箱限制。是否允许我在沙箱外重试同一命令？"

const AGENT_COMMIT_NO_ELIGIBLE_FILES_MESSAGE = "Agent 指定的文件均被 Git ignore，未发起提交。"

function normalizeDirBoundaryKey(dir: string): string {
  const resolved = path.resolve(dir)
  if (process.platform === "win32") {
    return resolved
      .replace(/[\\/]+/g, "\\")
      .replace(/\\+$/, "")
      .toLowerCase()
  }
  return resolved.replace(/\/+$/, "") || "/"
}

function isPathInsideOrSame(targetPath: string, rootPath: string): boolean {
  const target = normalizeDirBoundaryKey(targetPath)
  const root = normalizeDirBoundaryKey(rootPath)
  const separator = process.platform === "win32" ? "\\" : "/"
  if (root === separator) return target === root || target.startsWith(separator)
  return target === root || target.startsWith(`${root}${separator}`)
}

async function resolveExistingDirForBoundary(
  dir: string
): Promise<{ path: string; exists: boolean }> {
  try {
    return { path: await realpath(dir), exists: true }
  } catch {
    return { path: path.resolve(dir), exists: false }
  }
}

async function representExistingPathWithinWorkspace(
  workspacePath: string,
  candidatePath: string
): Promise<string> {
  const [realWorkspace, realCandidate] = await Promise.all([
    resolveExistingDirForBoundary(workspacePath),
    resolveExistingDirForBoundary(candidatePath)
  ])
  if (
    realWorkspace.exists &&
    realCandidate.exists &&
    isPathInsideOrSame(realCandidate.path, realWorkspace.path)
  ) {
    const relative = path.relative(realWorkspace.path, realCandidate.path)
    return relative ? path.resolve(workspacePath, relative) : path.resolve(workspacePath)
  }
  return candidatePath
}

function isUnsupportedProjectedPathspec(filePath: string): boolean {
  const normalized = process.platform === "win32" ? filePath.replace(/\\/g, "/") : filePath
  const withoutTopMagic = normalized.startsWith(":/") ? normalized.slice(2) : normalized
  if (!normalized.startsWith(":/") && normalized.startsWith(":")) return true
  if (normalized.startsWith(":/") && /^[/!^:]/.test(withoutTopMagic)) return true
  return ["*", "?", "["].some((marker) => withoutTopMagic.includes(marker))
}

async function projectExplicitPathsToTarget(
  gitRoot: string,
  gitCommandCwd: string,
  targetPath: string,
  filePaths: string[],
  shellSyntax: CommandShellSyntax
): Promise<string[] | null> {
  const [realRoot, realGitCwd, realTarget] = await Promise.all([
    resolveExistingDirForBoundary(gitRoot),
    resolveExistingDirForBoundary(gitCommandCwd),
    resolveExistingDirForBoundary(targetPath)
  ])
  if (!realRoot.exists || !realGitCwd.exists || !realTarget.exists) return null

  const projected: string[] = []
  for (const filePath of filePaths) {
    if (isUnsupportedProjectedPathspec(filePath)) {
      projected.push(filePath)
      continue
    }
    const repositoryRelative = filePath.startsWith(":/")
    const rawPathWithoutMagic = repositoryRelative ? filePath.slice(2) || "." : filePath
    const msysDrivePath =
      process.platform === "win32" && shellSyntax === "posix"
        ? rawPathWithoutMagic.match(/^\/([A-Za-z])(?:\/(.*))?$/)
        : null
    const pathWithoutMagic = msysDrivePath
      ? `${msysDrivePath[1]}:/${msysDrivePath[2] || ""}`
      : rawPathWithoutMagic
    const basePath = repositoryRelative ? realRoot.path : realGitCwd.path
    const absolutePath = path.isAbsolute(pathWithoutMagic)
      ? path.resolve(pathWithoutMagic)
      : path.resolve(basePath, pathWithoutMagic)
    const relativeToTarget = path.relative(realTarget.path, absolutePath)
    const insideTarget =
      relativeToTarget === "" ||
      (relativeToTarget !== ".." &&
        !relativeToTarget.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relativeToTarget))
    const result = insideTarget ? relativeToTarget || "." : absolutePath
    projected.push(process.platform === "win32" ? result.replace(/\\/g, "/") : result)
  }
  return projected
}

type GitOperationKind = "commit" | "push"

const GIT_OPERATION_COPY: Record<
  GitOperationKind,
  {
    commandName: string
    actionName: string
    outsideWorkspaceMessage: string
    operationLabel: string
  }
> = {
  commit: {
    commandName: "git commit",
    actionName: "提交",
    outsideWorkspaceMessage:
      "`git commit` 的 -C 目标不在当前线程工作区内，任务卡片对话框无法安全展示或提交该仓库。" +
      "请在当前工作区内执行提交，或切换到对应工作区后再提交。",
    operationLabel: "Git 提交"
  },
  push: {
    commandName: "git push",
    actionName: "推送",
    outsideWorkspaceMessage:
      "`git push` 的 -C 目标不在当前线程工作区内，无法安全推送该仓库。" +
      "请在当前工作区内执行推送，或切换到对应工作区后再推送。",
    operationLabel: "Git 推送"
  }
}

async function validateGitCommandCwd(
  cwd: string,
  gitCommandCwd: string,
  operation: GitOperationKind
): Promise<string | null> {
  const copy = GIT_OPERATION_COPY[operation]
  const [realCwd, realGitCommandCwd] = await Promise.all([
    resolveExistingDirForBoundary(cwd),
    resolveExistingDirForBoundary(gitCommandCwd)
  ])
  if (!realGitCommandCwd.exists) {
    return `\`${copy.commandName}\` 的工作目录不存在，请确认 cd/-C 目标后再${copy.actionName}。`
  }
  if (isPathInsideOrSame(realGitCommandCwd.path, realCwd.path)) return null
  return copy.outsideWorkspaceMessage
}

async function validateGitOperationCwd(
  workspaceCwd: string,
  gitCommandCwd: string,
  operation: GitOperationKind
): Promise<string | null> {
  const existingError = await validateGitCommandCwd(workspaceCwd, gitCommandCwd, operation)
  if (existingError) return existingError
  const gitRoot = await getGitRootForPath(gitCommandCwd)
  if (gitRoot) return null

  const repositories = await discoverWorkspaceGitRepositories(workspaceCwd)
  const copy = GIT_OPERATION_COPY[operation]
  if (repositories.length > 0) {
    const repoList = repositories.map((repo) => repo.displayPath).join("，")
    return (
      `当前目录不是 Git 仓库，但工作区内发现 ${repositories.length} 个子仓库：${repoList}。` +
      `请进入具体子仓库后再执行 ${copy.operationLabel}，例如 \`cd <子仓库> && ${copy.commandName}\`。`
    )
  }
  return `当前目录不是 Git 仓库，无法执行 ${copy.operationLabel}。`
}

export class ToolOrchestrator {
  constructor(
    private approvalStore: ApprovalStore,
    private rawExecute: RawExecuteFn,
    private requestApproval: RequestApprovalFn,
    private readYoloMode: () => boolean = () => false,
    /**
     * Auto-approve file edits (write_file/edit_file) WITHOUT prompting, while
     * still gating shell execution. Used by dynamic-workflow subagents: the user
     * already approved the whole workflow at launch, so its background subagents
     * editing many files must not re-prompt per file (the official acceptEdits
     * semantics). Shell `execute` stays gated — it's the more dangerous op.
     */
    private autoApproveFileEdits: boolean = false,
    /** Isolated worktree runtimes must never retry a denied command on the host. */
    private sandboxEscapeAllowed: boolean = true,
    /** Thread workspace boundary; execute() cwd may be a nested shell directory. */
    private workspacePath?: string
  ) {}

  /**
   * Execute a command through the full approval + sandbox pipeline.
   *
   * Concurrency is now managed by the middleware-level RWLock in runtime.ts —
   * this method no longer serializes internally. Multiple calls may enter
   * approval concurrently so the renderer receives all requests immediately.
   *
   * @param command      Shell command string
   * @param cwd          Working directory
   * @param sandboxMode  Current sandbox mode (none/unelevated/elevated/readonly)
   */
  async execute(
    command: string,
    cwd: string,
    sandboxMode: string,
    shellSyntax: CommandShellSyntax = process.platform === "win32" ? "powershell" : "posix",
    outsideShellSyntax: CommandShellSyntax = shellSyntax
  ): Promise<ExecuteResponse> {
    {
      const yoloMode = this.readYoloMode()
      console.log(
        `[Orchestrator] execute: "${command}" cwd=${cwd} sandbox=${sandboxMode} yolo=${yoloMode}`
      )

      // 1. Assess command safety — always check, even in YOLO mode
      const safety = assessCommandSafety(command, cwd, {
        windowsShell:
          process.platform === "win32" && sandboxMode !== "none" ? "powershell" : "unknown",
        nativeGitWorktree: !this.sandboxEscapeAllowed,
        shellSyntax
      })
      console.log(
        `[Orchestrator] safety: ${safety.level}${safety.reason ? ` (${safety.reason})` : ""}`
      )

      // 2. Forbidden commands → reject immediately, regardless of YOLO mode
      if (safety.level === "forbidden") {
        return {
          output: `Command forbidden: ${safety.reason}`,
          exitCode: 1,
          truncated: false
        }
      }

      // Isolated workflow agents use native Git in their assigned checkout. Do not
      // route their add/commit commands through the ordinary task-card flow: Git must
      // preserve the agent's real index, hooks, signing and command semantics. The
      // LocalSandbox worktree guard has already rejected cross-worktree/shared-metadata
      // operations before execution reaches this orchestrator.

      // 2.5 git commit → route through the task-card commit dialog instead of a plain
      // approval. The renderer collects the task card + message, performs the commit via
      // workspace:commitWorktree (the same path as the Git Panel), and reports the result
      // back. This applies even in YOLO mode: a commit must always carry a task card and
      // the CMB message format, so it is the one operation YOLO still prompts for.
      if (this.sandboxEscapeAllowed && isGitCommitCommand(command, shellSyntax)) {
        // The dialog only performs the commit; a chained command (e.g.
        // `git commit -m x && git push`) would have its tail silently dropped. Refuse it
        // and tell the agent to run the commit on its own.
        if (isChainedShellCommand(command, shellSyntax)) {
          return {
            output:
              "检测到 `git commit` 与其他命令串联执行，任务卡片流程无法安全保留各段命令的路径和短路语义。" +
              '请直接使用 `git commit -m "摘要" -- <明确文件路径>`；如需切换目录，请单独执行 cd 或使用 git -C。',
            exitCode: 1,
            truncated: false
          }
        }
        // The dialog only ever creates a fresh commit, so --amend/--fixup/--squash would be
        // silently turned into a new commit (losing the amend/fixup/squash intent). Refuse
        // rather than mislead the agent with a "提交成功".
        if (isAmendOrFixupCommit(command, shellSyntax)) {
          return {
            output:
              "检测到 `git commit --amend/--fixup/--squash`，但任务卡片提交流程只会新建一条普通提交，" +
              "无法修补/压缩已有提交。请改为创建新的提交，或让用户在 Git 面板手动处理历史提交。",
            exitCode: 1,
            truncated: false
          }
        }
        if (hasUnsupportedGitCommitScope(command, shellSyntax)) {
          return {
            output:
              "检测到任务卡片提交流程无法安全复现的 Git 文件范围选项（如 -a、--patch 或 " +
              '--pathspec-from-file）。请先运行 git status，再使用 `git commit -m "摘要" -- <明确文件路径>` 重试。',
            exitCode: 1,
            truncated: false
          }
        }
        return this.requestCardCommit(command, cwd, shellSyntax)
      }

      // A push from an app-owned transient branch is never silently approved by
      // YOLO mode. LocalSandbox has already limited the refspec to this worktree's
      // assigned branch; ask once, then execute the original native Git command so
      // credentials and remote behavior are not rewritten by the source-workspace
      // Git Panel flow.
      if (!this.sandboxEscapeAllowed && containsIndirectGitPush(command, shellSyntax)) {
        return {
          output:
            "Command forbidden: isolated worktree push must be issued directly as `git push <remote> HEAD` for explicit approval",
          exitCode: 1,
          truncated: false
        }
      }
      if (!this.sandboxEscapeAllowed && isGitPushCommand(command, shellSyntax)) {
        if (isForcePushCommand(command, shellSyntax)) {
          return {
            output: "Command forbidden: force push from an isolated workflow worktree is blocked",
            exitCode: 1,
            truncated: false
          }
        }
        const approval = await this.requestApproval({
          id: randomUUID(),
          tool_call: { id: randomUUID(), name: "execute", args: { command } },
          safety_level: "needs_approval",
          operation: "execute",
          command,
          cwd,
          reason: "Push the assigned isolated workflow branch to its matching remote branch?",
          allowed_decisions: ["approve", "reject"],
          allowed_approval_types: ["approve", "reject"]
        })
        const decision = this.mapDecisionToReview(approval.type)
        if (decision === "denied" || decision === "abort") {
          return { output: "Command rejected by user.", exitCode: 1, truncated: false }
        }
        return this.rawExecute(command, sandboxMode, cwd)
      }

      // 2.6 git push → route a plain (non-force) push through workspace:pushWorktree — the
      // same robust, unsandboxed mechanism the Git Panel uses. Running push inside the
      // sandbox often hangs on Git Credential Manager prompts and times out. This branch is
      // intentionally before the YOLO shortcut so YOLO pushes can still use the Git Panel
      // path; the renderer auto-accepts git_push requests in YOLO mode. Force pushes and
      // chained pushes keep the raw path (pushWorktree only performs a plain
      // `push -u origin <current branch>`), and we only route when the push actually targets
      // the current cwd — a `git -C <other>` push to a different repo would otherwise be
      // silently redirected to the thread's worktree.
      if (
        this.sandboxEscapeAllowed &&
        isGitPushCommand(command, shellSyntax) &&
        !isForcePushCommand(command, shellSyntax) &&
        !isChainedShellCommand(command, shellSyntax)
      ) {
        const gitCommandCwd = resolveGitPushCommandCwd(command, cwd, shellSyntax)
        if (isPathInsideOrSame(gitCommandCwd, cwd)) {
          return this.requestWorktreePush(command, cwd, gitCommandCwd)
        }
      }

      // 3. YOLO mode: skip the initial command approval for safe + needs_approval
      // commands, but still require explicit approval before escaping the sandbox.
      if (yoloMode) {
        const result = await this.rawExecute(command, sandboxMode, cwd)
        return this.maybeRetryOutsideSandbox(command, cwd, sandboxMode, result, outsideShellSyntax)
      }

      // 4. Safe commands → execute directly
      if (safety.level === "safe") {
        console.log("[Orchestrator] safe → rawExecute")
        const result = await this.rawExecute(command, sandboxMode, cwd)
        return this.maybeRetryOutsideSandbox(command, cwd, sandboxMode, result, outsideShellSyntax)
      }

      // 5. Needs approval → check cache, then ask user
      const key = this.approvalStore.makeKey(command, cwd, sandboxMode)
      // derivePermanentApprovalPattern returns a prefix-based pattern for known safe executables,
      // or null for unknown executables. For unknown executables, fall back to exact-match pattern
      // (the raw command text) — this still allows "always allow" but requires exact same command.
      const prefixPattern = derivePermanentApprovalPattern(command)
      const patternKey = prefixPattern ?? this.approvalStore.makePatternKey(command)

      console.log("[Orchestrator] needs_approval → requesting user approval...")

      const decision = await this.approvalStore.withCachedApproval(
        key,
        patternKey,
        async (): Promise<ReviewDecision> => {
          const approval = await this.requestApproval({
            id: randomUUID(),
            tool_call: { id: randomUUID(), name: "execute", args: { command } },
            safety_level: "needs_approval",
            operation: "execute",
            command,
            cwd,
            reason: safety.reason,
            allowed_decisions: ["approve", "reject"],
            // Always offer permanent approval — for known executables it uses prefix match,
            // for unknown executables it uses exact match (still useful for repeated commands).
            allowed_approval_types: ["approve", "approve_session", "approve_permanent", "reject"]
          })
          return this.mapDecisionToReview(approval.type)
        },
        {
          allowPermanentMatch: true,
          allowPermanentStore: true,
          commandForPatternMatch: command
        }
      )

      if (decision === "denied" || decision === "abort") {
        return {
          output: "Command rejected by user.",
          exitCode: 1,
          truncated: false
        }
      }

      // 6. Execute (with sandbox), then offer a one-shot bypass prompt if the failure
      // looks sandbox-induced.
      try {
        const result = await this.rawExecute(command, sandboxMode, cwd)
        return await this.maybeRetryOutsideSandbox(
          command,
          cwd,
          sandboxMode,
          result,
          outsideShellSyntax
        )
      } catch (err) {
        // 7. Sandbox denial → block and inform user
        if (sandboxMode !== "none" && this.isSandboxDenialError(err)) {
          return this.handleSandboxRetry(
            command,
            cwd,
            `沙箱阻止了此操作: ${err instanceof Error ? err.message : String(err)}`
          )
        }
        throw err
      }
    }
  }

  /**
   * Handle a `git commit` the agent issued by popping the task-card commit dialog in the
   * renderer. The renderer is the single owner of the actual commit (it calls
   * workspace:commitWorktree, exactly like the Git Panel), so this method only requests
   * the interactive flow and translates its outcome into an ExecuteResponse for the agent.
   * We never run the raw `git commit` ourselves — that keeps the CMB commit-message format
   * (`<card> #comment <type>:<msg> #CMBDevClaw`) enforced in one place.
   */
  private async requestCardCommit(
    command: string,
    cwd: string,
    shellSyntax: CommandShellSyntax
  ): Promise<ExecuteResponse> {
    const suggestedCommitMessage = extractGitCommitMessage(command, shellSyntax)
    const gitCommandCwd = resolveGitCommandCwd(command, cwd, shellSyntax)
    const workspaceBoundary = this.workspacePath ?? cwd
    const gitCommandCwdError = await validateGitCommandCwd(
      workspaceBoundary,
      gitCommandCwd,
      "commit"
    )
    if (gitCommandCwdError) {
      return {
        output: gitCommandCwdError,
        exitCode: 1,
        truncated: false
      }
    }
    const extractedPathspecs = Array.from(new Set(extractGitCommitPathspecs(command, shellSyntax)))
    if (extractedPathspecs.length === 0) {
      return {
        output:
          "任务卡片提交流程必须指定明确文件路径，不能安全复现裸 `git commit` 的暂存区/未暂存片段语义。" +
          '请先运行 git status，再使用 `git commit -m "摘要" -- <明确文件路径>` 重试。',
        exitCode: 1,
        truncated: false
      }
    }

    let gitRoot = await getGitRootForPath(gitCommandCwd)
    let operationTarget: string | undefined
    let suggestedGitRepositories: ApprovalRequest["suggestedGitRepositories"]
    let suggestedCommitFilePaths: string[]
    let suggestedCommitFileBasePath: string

    if (!gitRoot) {
      const repositories = await discoverWorkspaceGitRepositories(gitCommandCwd)
      if (repositories.length === 0) {
        return {
          output: "当前目录不是 Git 仓库，且未发现可提交的子仓库。",
          exitCode: 1,
          truncated: false
        }
      }
      if (repositories.length > 1) {
        suggestedGitRepositories = repositories.map((repository) => ({
          path: repository.repoPath,
          displayPath: repository.displayPath,
          gitRoot: repository.gitRoot
        }))
        suggestedCommitFilePaths = extractedPathspecs
        suggestedCommitFileBasePath = gitCommandCwd
      } else {
        gitRoot = repositories[0].gitRoot
        operationTarget = repositories[0].repoPath
        suggestedCommitFileBasePath = operationTarget
        const projectedPaths = await projectExplicitPathsToTarget(
          gitRoot,
          gitCommandCwd,
          operationTarget,
          extractedPathspecs,
          shellSyntax
        )
        if (!projectedPaths) {
          return {
            output: "无法可靠映射 Git 提交路径；为避免提交到错误范围，本次操作已取消。",
            exitCode: 1,
            truncated: false
          }
        }
        suggestedCommitFilePaths = projectedPaths
      }
    } else {
      const [representedGitRoot, realWorkspace, realGitRoot] = await Promise.all([
        representExistingPathWithinWorkspace(workspaceBoundary, gitRoot),
        resolveExistingDirForBoundary(workspaceBoundary),
        resolveExistingDirForBoundary(gitRoot)
      ])
      operationTarget =
        realWorkspace.exists &&
        realGitRoot.exists &&
        isPathInsideOrSame(realGitRoot.path, realWorkspace.path)
          ? representedGitRoot
          : path.resolve(workspaceBoundary)
      suggestedCommitFileBasePath = operationTarget
      const projectedPaths = await projectExplicitPathsToTarget(
        gitRoot,
        gitCommandCwd,
        operationTarget,
        extractedPathspecs,
        shellSyntax
      )
      if (!projectedPaths) {
        return {
          output: "无法可靠映射 Git 提交路径；为避免提交到错误范围，本次操作已取消。",
          exitCode: 1,
          truncated: false
        }
      }
      suggestedCommitFilePaths = projectedPaths
    }
    console.log(
      `[Orchestrator] git commit → task-card dialog (cwd=${cwd}, gitCwd=${gitCommandCwd})`
    )
    const decision = await this.requestApproval({
      id: randomUUID(),
      tool_call: { id: randomUUID(), name: "execute", args: { command } },
      safety_level: "needs_approval",
      operation: "git_commit",
      command,
      cwd,
      suggestedCommitMessage,
      suggestedCommitFilePaths,
      suggestedCommitFileBasePath,
      suggestedGitWorktreePath: operationTarget,
      suggestedGitRepositories,
      suggestedCommitFileSelectionSource: "pathspec",
      reason: "Git 提交需要选择任务卡片并确认",
      allowed_decisions: ["approve", "reject"],
      allowed_approval_types: ["approve", "reject"]
    })

    if (decision.type !== "approve") {
      return {
        output: "用户取消了本次提交（未选择任务卡片或已取消提交对话框）。",
        exitCode: 1,
        truncated: false
      }
    }

    const result = decision.commitResult
    if (result?.success) {
      const detail = result.commitMessage ? `：${result.commitMessage}` : ""
      return { output: `提交成功${detail}`, exitCode: 0, truncated: false }
    }
    if (result?.error === AGENT_COMMIT_NO_ELIGIBLE_FILES_MESSAGE) {
      return {
        output: AGENT_COMMIT_NO_ELIGIBLE_FILES_MESSAGE,
        exitCode: 1,
        truncated: false
      }
    }
    return {
      output: `提交失败：${result?.error || "未知错误"}`,
      exitCode: 1,
      truncated: false
    }
  }

  /**
   * Handle a plain `git push` by routing it through the renderer's workspace:pushWorktree —
   * the same path the Git Panel push button uses (unsandboxed `push -u origin <branch>` in
   * the main process, with LFS compat + adoption push-marking). This avoids the sandbox
   * credential-prompt hang/timeout. We never run the raw `git push` ourselves; the renderer
   * performs the push and reports the outcome back via decision.pushResult.
   */
  private async requestWorktreePush(
    command: string,
    cwd: string,
    gitCommandCwd: string
  ): Promise<ExecuteResponse> {
    const gitCommandCwdError = await validateGitOperationCwd(cwd, gitCommandCwd, "push")
    if (gitCommandCwdError) {
      return {
        output: gitCommandCwdError,
        exitCode: 1,
        truncated: false
      }
    }
    console.log(
      `[Orchestrator] git push → workspace:pushWorktree (cwd=${cwd}, gitCwd=${gitCommandCwd})`
    )
    const decision = await this.requestApproval({
      id: randomUUID(),
      tool_call: { id: randomUUID(), name: "execute", args: { command } },
      safety_level: "needs_approval",
      operation: "git_push",
      command,
      cwd,
      suggestedGitWorktreePath: gitCommandCwd,
      reason: "Git 推送将通过 Git 面板的推送机制执行（push -u origin <当前分支>）",
      allowed_decisions: ["approve", "reject"],
      allowed_approval_types: ["approve", "reject"]
    })

    const result = decision.pushResult
    if (decision.type !== "approve") {
      if (decision.type === "error" || result) {
        return {
          output: `推送失败：${result?.error || "未知错误"}`,
          exitCode: 1,
          truncated: false
        }
      }
      return { output: "用户取消了本次推送。", exitCode: 1, truncated: false }
    }

    if (result?.success) {
      return { output: "推送成功（push -u origin 当前分支）。", exitCode: 0, truncated: false }
    }
    return {
      output: `推送失败：${result?.error || "未知错误"}`,
      exitCode: 1,
      truncated: false
    }
  }

  /**
   * After a sandboxed rawExecute call returns, check whether the failure is one we can
   * recover from by re-running outside the sandbox (git metadata writes, piped sub-spawns).
   * If so, ask the user; on approval re-run with `mode="none"`. Used by both the
   * foreground execute() path and LocalSandbox.executeBackground so background `npm run
   * build` tasks get the same prompt UX as foreground commands.
   */
  async maybeRetryOutsideSandbox(
    command: string,
    cwd: string,
    sandboxMode: string,
    result: ExecuteResponse,
    outsideShellSyntax: CommandShellSyntax = process.platform === "win32" ? "powershell" : "posix"
  ): Promise<ExecuteResponse> {
    if (sandboxMode === "none") return result
    if (!this.sandboxEscapeAllowed) return result
    // Single Codex-style bypass check — covers piped-spawn EPERM, git .git writes,
    // dubious ownership, ssh auth, generic EACCES/Access-is-denied/拒绝访问, etc.
    return this.maybeRequestSandboxBypass(command, cwd, sandboxMode, result, outsideShellSyntax)
  }

  /**
   * Mirrors Codex's `command failed; retry without sandbox?` flow
   * (codex-rs/core/src/tools/orchestrator.rs::build_denial_reason_from_output).
   *
   * If `LocalSandbox.isLikelySandboxDenied` finds a sandbox-denial keyword in the output,
   * surface a single-shot approval prompt with `retry_reason` populated so the renderer
   * shows the amber retry banner. On approve we re-run with `mode="none"`; on reject we
   * return the original sandbox output back to the agent so it can adjust its plan.
   *
   * Detection is output-only — wrappers like `cd workdir && cmd`, `pwsh -c "..."`, or
   * background tasks all benefit, and we don't need to hand-curate per-tool detectors.
   */
  private async maybeRequestSandboxBypass(
    command: string,
    cwd: string,
    sandboxMode: string,
    sandboxResult: ExecuteResponse,
    outsideShellSyntax: CommandShellSyntax
  ): Promise<ExecuteResponse> {
    const output = sandboxResult.output ?? ""
    if (!LocalSandbox.isLikelySandboxDenied(sandboxResult.exitCode, output, command)) {
      return sandboxResult
    }
    // Pick a tailored guidance message for known recovery-by-config-change cases
    // (e.g. error 1385 = elevated sandbox blocked by domain policy → tell the user
    // to switch sandbox mode, not just approve a per-command bypass). Falls back to
    // Codex's generic "command failed; retry without sandbox?" prompt otherwise.
    const promptReason =
      LocalSandbox.getSandboxBypassGuidance(output) ?? SANDBOX_BYPASS_PROMPT_REASON
    console.warn(`[Orchestrator] sandbox bypass eligible for "${command}" (sandbox=${sandboxMode})`)
    const approval = await this.requestApproval({
      id: randomUUID(),
      tool_call: { id: randomUUID(), name: "execute", args: { command } },
      safety_level: "needs_approval",
      operation: "execute",
      command,
      cwd,
      reason: promptReason,
      retry_reason: promptReason,
      allowed_decisions: ["approve", "reject"],
      allowed_approval_types: ["approve", "reject"]
    })
    const decision = this.mapDecisionToReview(approval.type)
    if (decision === "denied" || decision === "abort") {
      // Surface the original sandbox failure to the agent so it can adjust its plan.
      console.warn(
        `[Orchestrator] sandbox bypass rejected for "${command}" — returning original sandbox output`
      )
      return sandboxResult
    }
    console.warn(
      `[Orchestrator] sandbox bypass approved for "${command}" — retrying outside sandbox`
    )
    const outsideSafety = assessCommandSafety(command, cwd, {
      shellSyntax: outsideShellSyntax,
      windowsShell: outsideShellSyntax === "powershell" ? "powershell" : "unknown"
    })
    if (outsideSafety.level === "forbidden") {
      return {
        output: `Command retry forbidden after shell change: ${outsideSafety.reason}`,
        exitCode: 1,
        truncated: false
      }
    }
    if (
      isGitCommitCommand(command, outsideShellSyntax) ||
      isGitPushCommand(command, outsideShellSyntax)
    ) {
      return this.execute(command, cwd, "none", outsideShellSyntax, outsideShellSyntax)
    }
    return this.rawExecute(command, "none", cwd)
  }

  /**
   * Approve a file write or edit operation.
   * Returns true if approved, false if rejected.
   * Skipped in YOLO mode (no orchestrator set on LocalSandbox).
   *
   * Concurrency handled by middleware-level RWLock — no internal serialization.
   */
  async approveFileOp(
    operation: "write_file" | "edit_file",
    filePath: string,
    cwd: string
  ): Promise<boolean> {
    {
      if (this.readYoloMode() || this.autoApproveFileEdits) return true

      const key = this.approvalStore.makeKey(`${operation}:${filePath}`, cwd, "file")
      // Directory-based pattern for permanent approval: file:write:/dir/* or file:edit:/dir/*
      const dir = path.dirname(filePath).replace(/\\/g, "/")
      const patternKey = `file:${operation}:${dir}/*`

      console.log(`[Orchestrator] approveFileOp: ${operation} "${filePath}" cwd=${cwd}`)

      const decision = await this.approvalStore.withCachedApproval(
        key,
        patternKey,
        async (): Promise<ReviewDecision> => {
          const approval = await this.requestApproval({
            id: randomUUID(),
            tool_call: { id: randomUUID(), name: operation, args: { filePath } },
            safety_level: "needs_approval",
            operation,
            filePath,
            cwd,
            reason: operation === "write_file" ? "文件写入操作需要审批" : "文件编辑操作需要审批",
            allowed_decisions: ["approve", "reject"],
            allowed_approval_types: ["approve", "approve_session", "approve_permanent", "reject"]
          })
          return this.mapDecisionToReview(approval.type)
        },
        {
          allowPermanentMatch: true,
          allowPermanentStore: true,
          commandForPatternMatch: `file:${operation}:${filePath.replace(/\\/g, "/")}`
        }
      )

      const approved = decision !== "denied" && decision !== "abort"
      console.log(
        `[Orchestrator] approveFileOp: ${operation} "${filePath}" → ${approved ? "approved" : "rejected"}`
      )
      return approved
    }
  }

  /** Map renderer decision type to ReviewDecision. */
  private mapDecisionToReview(type: ApprovalDecisionType): ReviewDecision {
    switch (type) {
      case "approve":
        return "approved"
      case "approve_session":
        return "approved_session"
      case "approve_permanent":
        return "approved_permanent"
      case "reject":
        return "denied"
      default:
        return "denied"
    }
  }

  /** Check if an error looks like a sandbox permission denial. */
  private isSandboxDenialError(err: unknown): boolean {
    if (!(err instanceof Error)) return false
    const msg = err.message.toLowerCase()
    return (
      msg.includes("access is denied") ||
      msg.includes("permission denied") ||
      msg.includes("operation not permitted") ||
      msg.includes("sandbox blocked") ||
      msg.includes("sandbox denied") ||
      msg.includes("sandbox policy")
    )
  }

  private async handleSandboxRetry(
    _command: string,
    _cwd: string,
    retryReason: string
  ): Promise<ExecuteResponse> {
    // In elevated mode, do NOT offer unsandboxed retry — just block the command
    // and tell the user to switch to unelevated mode if they need this operation.
    return {
      output: `⚠️ 操作被沙箱拦截：${retryReason}\n\n此命令在 Elevated 沙箱模式下无法执行。如需执行此类操作，请在设置中切换到 Unelevated 沙箱模式后重试。`,
      exitCode: 1,
      truncated: false
    }
  }
}
