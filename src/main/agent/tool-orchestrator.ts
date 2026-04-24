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

      // 3. YOLO mode: skip approval for safe + needs_approval commands
      if (this.yoloMode) {
        return this.rawExecute(command, sandboxMode)
      }

      // 4. Safe commands → execute directly
      if (safety.level === "safe") {
        console.log("[Orchestrator] safe → rawExecute")
        return this.rawExecute(command, sandboxMode)
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

      // 6. Execute (with sandbox)
      try {
        const result = await this.rawExecute(command, sandboxMode)
        if (sandboxMode !== "none" && this.isSandboxDeniedResponse(result)) {
          return this.handleSandboxRetry(command, cwd, result.output)
        }
        return result
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

  private isSandboxDeniedResponse(result: ExecuteResponse): boolean {
    if (result.exitCode === 0) return false
    const msg = (result.output ?? "").toLowerCase()
    return (
      msg.includes("blocked by policy") ||
      msg.includes("setup refresh failed") ||
      msg.includes("sandbox blocked") ||
      msg.includes("sandbox denied") ||
      msg.includes("sandbox policy") ||
      msg.includes("沙箱阻止") ||
      msg.includes("沙箱拦截") ||
      msg.includes("沙箱拒绝")
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
