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
import path from "path"
import { ApprovalStore } from "./approval-store"
import { assessCommandSafety, derivePermanentApprovalPattern } from "./exec-policy"
import { LocalSandbox } from "./local-sandbox"
import type {
  ApprovalRequest,
  ApprovalDecision,
  ReviewDecision,
  ApprovalDecisionType
} from "../types"
import type { ExecuteResponse } from "deepagents"

/** Raw execution function signature (no approval logic). */
export type RawExecuteFn = (command: string, sandboxMode?: string) => Promise<ExecuteResponse>

/** Function to request interactive approval from the user (renderer). */
export type RequestApprovalFn = (req: ApprovalRequest) => Promise<ApprovalDecision>

/**
 * Generic prompt shown when a sandboxed command fails with output that looks like a
 * sandbox-induced denial. Mirrors Codex's `command failed; retry without sandbox?` —
 * intentionally non-specific so we don't have to enumerate every tool-specific failure.
 */
const SANDBOX_BYPASS_PROMPT_REASON =
  "命令在沙箱内执行失败，疑似受沙箱限制。是否允许我在沙箱外重试同一命令？"

export class ToolOrchestrator {
  constructor(
    private approvalStore: ApprovalStore,
    private rawExecute: RawExecuteFn,
    private requestApproval: RequestApprovalFn,
    private yoloMode: boolean = false
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
  async execute(command: string, cwd: string, sandboxMode: string): Promise<ExecuteResponse> {
    {
      console.log(`[Orchestrator] execute: "${command}" cwd=${cwd} sandbox=${sandboxMode} yolo=${this.yoloMode}`)

      // 1. Assess command safety — always check, even in YOLO mode
      const safety = assessCommandSafety(command, cwd, {
        windowsShell: process.platform === "win32" && sandboxMode !== "none" ? "powershell" : "unknown"
      })
      console.log(`[Orchestrator] safety: ${safety.level}${safety.reason ? ` (${safety.reason})` : ""}`)

      // 2. Forbidden commands → reject immediately, regardless of YOLO mode
      if (safety.level === "forbidden") {
        return {
          output: `Command forbidden: ${safety.reason}`,
          exitCode: 1,
          truncated: false
        }
      }

      // 3. YOLO mode: skip the initial command approval for safe + needs_approval
      // commands, but still require explicit approval before escaping the sandbox.
      if (this.yoloMode) {
        const result = await this.rawExecute(command, sandboxMode)
        return this.maybeRetryOutsideSandbox(command, cwd, sandboxMode, result)
      }

      // 4. Safe commands → execute directly
      if (safety.level === "safe") {
        console.log("[Orchestrator] safe → rawExecute")
        const result = await this.rawExecute(command, sandboxMode)
        return this.maybeRetryOutsideSandbox(command, cwd, sandboxMode, result)
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
        const result = await this.rawExecute(command, sandboxMode)
        return await this.maybeRetryOutsideSandbox(command, cwd, sandboxMode, result)
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
    result: ExecuteResponse
  ): Promise<ExecuteResponse> {
    if (sandboxMode === "none") return result
    // Single Codex-style bypass check — covers piped-spawn EPERM, git .git writes,
    // dubious ownership, ssh auth, generic EACCES/Access-is-denied/拒绝访问, etc.
    return this.maybeRequestSandboxBypass(command, cwd, sandboxMode, result)
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
    sandboxResult: ExecuteResponse
  ): Promise<ExecuteResponse> {
    const output = sandboxResult.output ?? ""
    if (!LocalSandbox.isLikelySandboxDenied(sandboxResult.exitCode, output)) {
      return sandboxResult
    }
    // Pick a tailored guidance message for known recovery-by-config-change cases
    // (e.g. error 1385 = elevated sandbox blocked by domain policy → tell the user
    // to switch sandbox mode, not just approve a per-command bypass). Falls back to
    // Codex's generic "command failed; retry without sandbox?" prompt otherwise.
    const promptReason = LocalSandbox.getSandboxBypassGuidance(output)
      ?? SANDBOX_BYPASS_PROMPT_REASON
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
      console.warn(`[Orchestrator] sandbox bypass rejected for "${command}" — returning original sandbox output`)
      return sandboxResult
    }
    console.warn(`[Orchestrator] sandbox bypass approved for "${command}" — retrying outside sandbox`)
    return this.rawExecute(command, "none")
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
      if (this.yoloMode) return true

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
      console.log(`[Orchestrator] approveFileOp: ${operation} "${filePath}" → ${approved ? "approved" : "rejected"}`)
      return approved
    }
  }

  /** Map renderer decision type to ReviewDecision. */
  private mapDecisionToReview(type: ApprovalDecisionType): ReviewDecision {
    switch (type) {
      case "approve": return "approved"
      case "approve_session": return "approved_session"
      case "approve_permanent": return "approved_permanent"
      case "reject": return "denied"
      default: return "denied"
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
