import { createHash, randomUUID } from "crypto"
import { tool } from "langchain"
import { z } from "zod"
import type { ApprovalDecision, ApprovalRequest } from "../../types"
import { CODE_EXEC_DEFAULT_TIMEOUT_MS } from "../../code-exec/constants"
import { CodeExecEngine } from "../../code-exec/engine"
import { LocalProcessRunner } from "../../code-exec/runner"
import { analyzeCodeExecForSavedToolPromotion } from "../../code-exec/saved-tool-promotion"
import {
  buildSavedCodeExecToolDraft,
  getSavedCodeExecToolForCode,
  persistSavedCodeExecTool
} from "../../code-exec/saved-tool-store"
import type { CodeExecResult, CodeExecToolInput } from "../../code-exec/types"
import type { ApprovalStore } from "../approval-store"
import type { McpCapabilityService } from "../../mcp/capability-types"

const DEFAULT_TIMEOUT_MS = CODE_EXEC_DEFAULT_TIMEOUT_MS
const SAVED_CODE_EXEC_DRAFT_TOOL_NAME = "code_exec_draft"
const SAVED_CODE_EXEC_DRAFT_DESCRIPTION = "从会话保存的编程式工具脚本草稿"
const EMPTY_INPUT_SCHEMA = {
  type: "object",
  properties: {}
}
const codeExecSchema = z.object({
  code: z
    .string()
    .describe(
      'JavaScript async function-body code for one ad hoc run. Put run-specific constants directly in the body, call MCP tools with await mcp.$call(tool_id, args), and return a JSON-serializable value. Example: const args = { limit: 5 }; const result = await mcp.$call("mcp__provider__tool_name", args); if (!result.ok) throw new Error(result.error); return { data: result.data };'
    )
})

interface CodeExecToolContext {
  workspacePath: string
  threadId?: string
  modelId?: string
  readYoloMode: () => boolean
  capabilityService: McpCapabilityService
  approvalStore?: ApprovalStore
  requestApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>
}

function mapDecisionToReview(
  type: ApprovalDecision["type"]
): "approved" | "approved_session" | "denied" {
  switch (type) {
    case "approve":
      return "approved"
    case "approve_session":
      return "approved_session"
    default:
      return "denied"
  }
}

function createSavedCodeExecDraftToolName(): string {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 3)
  return `${SAVED_CODE_EXEC_DRAFT_TOOL_NAME}_${suffix}`
}

function getToolNameFromSavedToolId(toolId: string): string {
  return toolId.replace(/^saved__?/, "").trim() || SAVED_CODE_EXEC_DRAFT_TOOL_NAME
}

async function requestCodeExecApproval(
  context: CodeExecToolContext,
  input: CodeExecToolInput
): Promise<boolean> {
  if (context.readYoloMode()) return true
  if (!context.approvalStore || !context.requestApproval) return true

  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        code: input.code,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        workspacePath: context.workspacePath
      })
    )
    .digest("hex")

  const key = context.approvalStore.makeKey(
    `code_exec:${fingerprint}`,
    context.workspacePath,
    "code_exec"
  )
  const patternKey = `code_exec:${fingerprint}`

  const decision = await context.approvalStore.withCachedApproval(
    key,
    patternKey,
    async () => {
      const approval = await context.requestApproval?.({
        id: randomUUID(),
        tool_call: {
          id: randomUUID(),
          name: "code_exec",
          args: {
            code: input.code,
            timeoutMs: DEFAULT_TIMEOUT_MS
          }
        },
        safety_level: "needs_approval",
        operation: "code_exec",
        code: input.code,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        cwd: context.workspacePath,
        reason: "执行编程式工具调用脚本需要审批",
        allowed_decisions: ["approve", "reject"],
        allowed_approval_types: ["approve", "approve_session", "reject"]
      })

      return mapDecisionToReview(approval?.type ?? "reject")
    },
    {
      allowPermanentMatch: false,
      allowPermanentStore: false,
      commandForPatternMatch: patternKey
    }
  )

  return decision !== "denied"
}

function buildSavedToolDraftFromSuccessfulRun(input: CodeExecToolInput, result: CodeExecResult) {
  const promotion = analyzeCodeExecForSavedToolPromotion({ code: input.code })
  const executedDependencies = Array.from(
    new Set((result.meta?.mcpCalls ?? []).map((call) => call.toolId).filter(Boolean))
  )
  const dependencies =
    executedDependencies.length > 0
      ? executedDependencies
      : promotion.dependencies.filter((dependency) => dependency !== "unknown")

  return buildSavedCodeExecToolDraft({
    toolName: createSavedCodeExecDraftToolName(),
    description: SAVED_CODE_EXEC_DRAFT_DESCRIPTION,
    inputSchema: promotion.status === "ready" ? promotion.inputSchema : EMPTY_INPUT_SCHEMA,
    code: input.code,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    dependencies,
    rewriteReady: false
  })
}

function maybePromoteCodeExecAsTool(
  context: CodeExecToolContext,
  input: CodeExecToolInput,
  result: CodeExecResult
): string {
  if (getSavedCodeExecToolForCode(input.code, DEFAULT_TIMEOUT_MS, { includeDisabled: true })) {
    return result.output
  }

  // YOLO skips execution approvals, but successful one-off scripts can still ask whether
  // they should be promoted into reusable tools.
  if (!context.requestApproval) return result.output

  void (async () => {
    try {
      const draft = buildSavedToolDraftFromSuccessfulRun(input, result)
      const savedToolName = getToolNameFromSavedToolId(draft.toolId)
      const approval = await context.requestApproval?.({
        id: randomUUID(),
        tool_call: {
          id: randomUUID(),
          name: "save_code_exec_tool",
          args: { toolId: draft.toolId }
        },
        safety_level: "needs_approval",
        operation: "save_code_exec_tool",
        code: input.code,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        savedToolName,
        savedToolId: draft.toolId,
        savedToolDescription: SAVED_CODE_EXEC_DRAFT_DESCRIPTION,
        cwd: context.workspacePath,
        reason:
          "将本次执行的脚本保存为草稿，在自定义-编程式工具调用完成改写和试运行后即可作为工具使用。",
        allowed_decisions: ["approve", "reject"],
        allowed_approval_types: ["approve", "reject"]
      })

      if (approval?.type === "approve") {
        persistSavedCodeExecTool(draft)
      }
    } catch (error) {
      console.warn("[code_exec] failed to prompt for tool promotion:", error)
    }
  })()

  return result.output
}

export function createCodeExecTool(context: CodeExecToolContext) {
  const engine = new CodeExecEngine(new LocalProcessRunner(context.capabilityService))

  return tool(
    async (input) => {
      const approved = await requestCodeExecApproval(context, input)
      if (!approved) {
        return "Code execution rejected by user."
      }

      const result = await engine.execute({
        code: input.code,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        workspacePath: context.workspacePath,
        threadId: context.threadId
      })

      if (result.ok) {
        return maybePromoteCodeExecAsTool(context, input, result)
      }

      return result.output
    },
    {
      name: "code_exec",
      description: `
      Write an async JavaScript function body for an ad hoc MCP workflow. You must strictly adhere to the following rules:
      1. Before generating this script, you MUST use \`inspect_tool\` to get the exact schemas of all MCP tools you intend to call. Do not guess the tool arguments.
      2. Call MCP tools ONLY using await mcp.$call(tool_id, args).
      3. Script MUST return the final execution result as a JSON-serializable value (the system will automatically serialize it to a string). Note: The execution environment cannot observe console.log outputs; never rely on printing to pass your final results.
      4. Use pure JavaScript only. It is STRICTLY PROHIBITED to use any Node.js APIs (e.g., require, fs, path).`,
      schema: codeExecSchema
    }
  )
}
