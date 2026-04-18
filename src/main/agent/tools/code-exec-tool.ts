import { createHash, randomUUID } from "crypto"
import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import { ChatOpenAI } from "@langchain/openai"
import { tool } from "langchain"
import { z } from "zod"
import type { ApprovalDecision, ApprovalRequest } from "../../types"
import { CODE_EXEC_DEFAULT_TIMEOUT_MS } from "../../code-exec/constants"
import { CodeExecEngine } from "../../code-exec/engine"
import { LocalProcessRunner } from "../../code-exec/runner"
import {
  buildSavedCodeExecToolDraft,
  getSavedCodeExecToolForCode,
  persistSavedCodeExecTool
} from "../../code-exec/saved-tool-store"
import type { CodeExecMcpCall, CodeExecResult, CodeExecToolInput } from "../../code-exec/types"
import { sanitizeMcpExampleValue } from "../../mcp/tool-example-store"
import { getCustomModelConfigs, type CustomModelConfig } from "../../storage"
import type { ApprovalStore } from "../approval-store"
import type { McpCapabilityService } from "../../mcp/capability-types"

const DEFAULT_TIMEOUT_MS = CODE_EXEC_DEFAULT_TIMEOUT_MS
const SAVE_TOOL_REWRITE_FAILED_NOTE = "工具化改写失败，请点拒绝关闭。"
const SAVED_TOOL_REWRITE_SYSTEM_PROMPT = `
# ROLE
You are an expert Node.js developer. Your task is to refactor specific JavaScript async function bodies into highly reusable, generalized function bodies.

# OBJECTIVE
Rewrite the provided JavaScript async function body by aggressively extracting **hardcoded values and literals** (e.g., magic strings, specific IDs, hardcoded numbers) into a dynamic \`params\` object. You MUST guarantee **Functional Equivalence**: the rewritten code must produce the exact same return shapes and execution side effects as the original, given the original values as inputs.

# RULES & CONSTRAINTS

## 1. Parameter Extraction & Refactoring
- Extract **hardcoded literals** (quantities, absolute file paths, specific repository names, etc.) into \`params.<key>\`.
- Keep internal constants and obvious programmatic defaults inline.
- **CRITICAL LOGIC SHIFT:** If extracting a limit/quantity, you MUST refactor static hardcoded access (e.g., \`arr[0]\`) into dynamic array methods (e.g., \`.map()\`, \`.slice()\`) to handle ANY parameter value.
- **Decompose Composite Strings:** If a hardcoded string contains structural data (e.g., API queries like \`"repo:owner/name"\`, absolute URLs, or file paths), DO NOT extract the entire string as a single parameter. Break it down into atomic semantic parameters (e.g., \`params.owner\`, \`params.repo\`) and reconstruct the original string using template literals.
- **Global Parameter Reuse:** Identify duplicate hardcoded values across multiple function calls. You MUST map identical semantic values to a single shared parameter in the \`params\` object, rather than creating redundant parameters (e.g., use \`params.owner\` consistently instead of creating \`params.owner1\` and \`params.owner2\`).

## 2. Code Formatting Constraints
- \`rewritten_code\` must contain **raw inner statements only**. DO NOT wrap it in function signatures, IIFEs, classes, or exports.
- Include an explicit top-level \`return\` statement.
- Use \`mcp.$call("tool_id", args)\` exactly as provided.

## 3. Schema Generation
- \`tool_name\`: snake_case, short, reusable, capability-oriented.
- \`description\`: concise (do not mention code_exec, saved tools, JS, or wrappers).
- \`input_schema\`:
  - **DYNAMIC TYPING:** Accurately infer the \`"type"\` (\`"string"\`, \`"number"\`, or \`"boolean"\`) based on the original literal's data type.
  - **REQUIRED & DEFAULTS:** ALL extracted \`params\` MUST be added to the \`required\` array. Their \`default\` values MUST be the exact original literal values from the provided code.

# OUTPUT FORMAT
Output STRICTLY a valid JSON object.

{
  "tool_name": "string",
  "description": "string",
  "rewritten_code": "string",
  "input_schema": {
    "type": "object",
    "properties": {
      "param_name": {
        "type": "string | number | boolean",
        "description": "string",
        "default": "any"
      }
    },
    "required": ["array of strings"]
  }
}

# EXAMPLES

** Input:\`original_code\`:**
const result = await mcp.$call("mcp__github__search_pull_requests", {
  query: "repo:vllm-project/vllm",
  sort: "created",
  order: "desc",
  perPage: 2
});

if (!result.ok) {
  throw new Error(result.error);
}

const prs = result.data.items;
const prDetails = [];

for (const pr of prs) {
  const detailResult = await mcp.$call("mcp__github__pull_request_read", {
    method: "get",
    owner: "vllm-project",
    repo: "vllm",
    pullNumber: pr.number
  });

  prDetails.push(detailResult);
}

return {
  prs: prs.map(pr => ({
    title: pr.title,
    state: pr.state,
    user: pr.user?.login
  })),
  details: prDetails.map(d => d.data)
};

**Expected Output**:
{
  "tool_name": "query_github_repo_recent_details",
  "description": "Searches for recent pull requests in a specified GitHub repository and fetches their details.",
  "rewritten_code": "const query = \`repo:\${params.owner}/\${params.repo}\`;\\nconst result = await mcp.$call(\\"mcp__github__search_pull_requests\\", {\\n  query: query,\\n  sort: params.sort,\\n  order: params.order,\\n  perPage: params.perPage\\n});\\n\\nif (!result.ok) {\\n  throw new Error(result.error);\\n}\\n\\nconst prs = result.data.items;\\nconst prDetails = [];\\n\\nfor (const pr of prs) {\\n  const detailResult = await mcp.$call(\\"mcp__github__pull_request_read\\", {\\n    method: \\"get\\",\\n    owner: params.owner,\\n    repo: params.repo,\\n    pullNumber: pr.number\\n  });\\n  prDetails.push(detailResult);\\n}\\n\\nreturn {\\n  prs: prs.map(pr => ({\\n    title: pr.title,\\n    state: pr.state,\\n    user: pr.user?.login\\n  })),\\n  details: prDetails.map(d => d.data)\\n};",
  "input_schema": {
    "type": "object",
    "properties": {
      "owner": {
        "type": "string",
        "description": "The owner of the GitHub repository.",
        "default": "vllm-project"
      },
      "repo": {
        "type": "string",
        "description": "The name of the GitHub repository.",
        "default": "vllm"
      },
      "sort": {
        "type": "string",
        "description": "The field to sort the pull requests by.",
        "default": "created"
      },
      "order": {
        "type": "string",
        "description": "The order of the sorting (e.g., desc, asc).",
        "default": "desc"
      },
      "perPage": {
        "type": "number",
        "description": "The number of pull requests to fetch per page.",
        "default": 2
      }
    },
    "required": [
      "owner",
      "repo",
      "sort",
      "order",
      "perPage"
    ]
  }
}
`
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
  yoloMode: boolean
  capabilityService: McpCapabilityService
  approvalStore?: ApprovalStore
  requestApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>
}

interface SavedToolRewrite {
  toolName: string
  description: string
  rewrittenCode: string
  inputSchema: Record<string, unknown>
}

function mapDecisionToReview(type: ApprovalDecision["type"]): "approved" | "approved_session" | "denied" {
  switch (type) {
    case "approve":
      return "approved"
    case "approve_session":
      return "approved_session"
    default:
      return "denied"
  }
}

async function requestCodeExecApproval(
  context: CodeExecToolContext,
  input: CodeExecToolInput
): Promise<boolean> {
  if (context.yoloMode) return true
  if (!context.approvalStore || !context.requestApproval) return true

  const fingerprint = createHash("sha256")
    .update(JSON.stringify({
      code: input.code,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      workspacePath: context.workspacePath
    }))
    .digest("hex")

  const key = context.approvalStore.makeKey(`code_exec:${fingerprint}`, context.workspacePath, "code_exec")
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
        reason: "执行 code_exec 脚本需要审批",
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
      const prepareApproval = await context.requestApproval?.({
        id: randomUUID(),
        tool_call: {
          id: randomUUID(),
          name: "prepare_save_code_exec_tool",
          args: {}
        },
        safety_level: "needs_approval",
        operation: "prepare_save_code_exec_tool",
        code: input.code,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        cwd: context.workspacePath,
        reason: "",
        allowed_decisions: ["approve", "reject"],
        allowed_approval_types: ["approve", "reject"]
      })

      if (prepareApproval?.type !== "approve") return

      const rewrite = await generateSavedToolRewrite(context, {
        code: input.code,
        mcpCalls: result.meta?.mcpCalls ?? []
      })

      const dependencies = Array.from(new Set((result.meta?.mcpCalls ?? []).map((call) => call.toolId).filter(Boolean)))
      const metadataError = rewrite ? undefined : SAVE_TOOL_REWRITE_FAILED_NOTE
      const draft = rewrite
        ? buildSavedCodeExecToolDraft({
          toolName: rewrite.toolName,
          description: rewrite.description,
          inputSchema: rewrite.inputSchema,
          code: rewrite.rewrittenCode,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          dependencies
        })
        : null

      const approval = await context.requestApproval?.({
        id: randomUUID(),
        tool_call: {
          id: randomUUID(),
          name: "save_code_exec_tool",
          args: draft?.toolId ? { toolId: draft.toolId } : {}
        },
        safety_level: "needs_approval",
        operation: "save_code_exec_tool",
        code: rewrite?.rewrittenCode ?? input.code,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        savedToolName: rewrite?.toolName ?? "",
        savedToolId: draft?.toolId,
        savedToolDescription: rewrite?.description ?? "",
        savedToolMetadataError: metadataError,
        cwd: context.workspacePath,
        reason: metadataError
          ? "工具化改写失败，点拒绝关闭"
          : "工具信息已生成，确认后保存为可复用工具。可在自定义-编程式调用页面管理/启用",
        allowed_decisions: metadataError ? ["reject"] : ["approve", "reject"],
        allowed_approval_types: metadataError ? ["reject"] : ["approve", "reject"]
      })

      if (approval?.type === "approve" && rewrite) {
        const toolName = approval.savedToolName?.trim() || rewrite.toolName.trim()
        const description = approval.savedToolDescription?.trim() || rewrite.description.trim()
        if (!toolName || !description) {
          console.warn("[code_exec] save tool approval missing tool name or description")
          return
        }

        const finalDraft = buildSavedCodeExecToolDraft({
          toolName,
          description,
          inputSchema: rewrite.inputSchema,
          code: rewrite.rewrittenCode,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          dependencies
        })

        persistSavedCodeExecTool({
          ...finalDraft,
          description
        })
      }
    } catch (error) {
      console.warn("[code_exec] failed to prompt for tool promotion:", error)
    }
  })()

  return result.output
}

function resolveSidecarModelConfig(selectedModelId?: string): CustomModelConfig | null {
  const configs = getCustomModelConfigs()
  const requestedId = selectedModelId?.startsWith("custom:") ? selectedModelId.slice("custom:".length) : selectedModelId
  return requestedId
    ? (configs.find((item) => item.id === requestedId) || configs.find((item) => item.model === requestedId) || configs[0] || null)
    : (configs[0] ?? null)
}

function extractResponseText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item
        if (item && typeof item === "object" && "text" in item && typeof item.text === "string") {
          return item.text
        }
        return ""
      })
      .join("")
  }
  return ""
}

function stripSavedToolRewriteFormatting(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>\s*/gi, "")
    .replace(/^[\s\S]*?<\/think>\s*/i, "")
    .trim()
}

function extractBalancedJsonObjects(text: string): string[] {
  const results: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaping = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]

    if (inString) {
      if (escaping) {
        escaping = false
        continue
      }
      if (char === "\\") {
        escaping = true
        continue
      }
      if (char === "\"") {
        inString = false
      }
      continue
    }

    if (char === "\"") {
      inString = true
      continue
    }

    if (char === "{") {
      if (depth === 0) start = index
      depth += 1
      continue
    }

    if (char === "}") {
      if (depth === 0) continue
      depth -= 1
      if (depth === 0 && start >= 0) {
        results.push(text.slice(start, index + 1).trim())
        start = -1
      }
    }
  }

  return results
}

function parseSavedToolRewrite(raw: string): SavedToolRewrite | null {
  const candidates = (() => {
    const cleaned = stripSavedToolRewriteFormatting(raw)
    if (!cleaned) return []

    const results = [cleaned]
    for (const match of cleaned.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)) {
      if (match[1]?.trim()) {
        results.push(match[1].trim())
      }
    }

    results.push(...extractBalancedJsonObjects(cleaned))

    return Array.from(new Set(results.filter(Boolean)))
  })()

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>
      const toolName = typeof parsed.tool_name === "string" ? parsed.tool_name.trim() : ""
      const description = typeof parsed.description === "string" ? parsed.description.trim() : ""
      const rewrittenCode = typeof parsed.rewritten_code === "string" ? parsed.rewritten_code.trim() : ""
      const inputSchema =
        parsed.input_schema && typeof parsed.input_schema === "object" && !Array.isArray(parsed.input_schema)
          ? {
              type: "object",
              ...(parsed.input_schema as Record<string, unknown>)
            }
          : null
      if (!toolName || !description || !rewrittenCode || !inputSchema) continue
      return {
        toolName,
        description,
        rewrittenCode,
        inputSchema
      }
    } catch {
      continue
    }
  }

  return null
}

function buildExecutedMcpToolCallsPreview(mcpCalls: CodeExecMcpCall[]): Array<{
  tool_id: string
  args_preview: unknown
}> {
  return mcpCalls.map((call) => ({
    tool_id: call.toolId,
    args_preview: sanitizeMcpExampleValue(call.args)
  }))
}

async function generateSavedToolRewrite(
  context: CodeExecToolContext,
  input: {
    code: string
    mcpCalls: CodeExecMcpCall[]
  }
): Promise<SavedToolRewrite | null> {
  const config = resolveSidecarModelConfig(context.modelId)
  if (!config?.apiKey) {
    console.warn("[code_exec] skipped saved-tool rewrite generation: missing model config or API key")
    return null
  }

  const model = new ChatOpenAI({
    model: config.model,
    apiKey: config.apiKey,
    configuration: { baseURL: config.baseUrl },
    maxTokens: 16384,
    temperature: 0.1,
    streaming: false
  })

  const userPrompt = JSON.stringify({
    original_code: input.code,
    mcp_call_input_param: buildExecutedMcpToolCallsPreview(input.mcpCalls)
  }, null, 2)

  try {
    const response = await model.invoke(
      [
        new SystemMessage(SAVED_TOOL_REWRITE_SYSTEM_PROMPT),
        new HumanMessage(userPrompt)
      ],
      { callbacks: [] }
    )
    const raw = extractResponseText(response.content).trim()
    const rewrite = parseSavedToolRewrite(raw)
    if (!rewrite) {
      console.warn("[code_exec] failed to parse saved-tool rewrite response:", raw.slice(0, 2000))
      return null
    }
    return rewrite
  } catch (error) {
    console.warn("[code_exec] failed to generate saved-tool rewrite:", error)
    return null
  }
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
