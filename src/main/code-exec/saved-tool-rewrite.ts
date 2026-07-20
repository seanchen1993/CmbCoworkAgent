import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import { ChatOpenAI } from "@langchain/openai"
import { sanitizeMcpExampleValue } from "../mcp/tool-example-store"
import type { CustomModelConfig } from "../storage"
import { getDefaultModelConfig, getModelConfigByRef } from "../models/registry"
import type { CodeExecMcpCall } from "./types"

const MAX_SAVED_TOOL_METADATA_ERROR_LENGTH = 100
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

export interface SavedToolRewrite {
  toolName: string
  description: string
  rewrittenCode: string
  inputSchema: Record<string, unknown>
}

export interface SavedToolRewriteResult {
  rewrite: SavedToolRewrite | null
  error?: string
}

function resolveSidecarModelConfig(selectedModelId?: string): CustomModelConfig | null {
  return selectedModelId
    ? (getModelConfigByRef(selectedModelId) ?? getDefaultModelConfig())
    : getDefaultModelConfig()
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
      if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
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

export function parseSavedToolRewrite(raw: string): SavedToolRewrite | null {
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
      const rewrittenCode =
        typeof parsed.rewritten_code === "string" ? parsed.rewritten_code.trim() : ""
      const inputSchema =
        parsed.input_schema &&
        typeof parsed.input_schema === "object" &&
        !Array.isArray(parsed.input_schema)
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

export async function generateSavedToolRewrite(input: {
  modelId?: string
  code: string
  mcpCalls: CodeExecMcpCall[]
}): Promise<SavedToolRewriteResult> {
  const config = resolveSidecarModelConfig(input.modelId)
  if (!config?.apiKey) {
    const error = "缺少可用于工具改写的模型配置或 API Key"
    return { rewrite: null, error }
  }

  const model = new ChatOpenAI({
    model: config.model,
    apiKey: config.apiKey,
    configuration: { baseURL: config.baseUrl },
    maxTokens: config.maxOutputTokens,
    temperature: config.temperature,
    topP: config.topP,
    modelKwargs: {
      ...(config.topK && config.topK > 0 ? { top_k: config.topK } : {})
    },
    streaming: false
  })

  const userPrompt = JSON.stringify(
    {
      original_code: input.code,
      mcp_call_input_param: buildExecutedMcpToolCallsPreview(input.mcpCalls)
    },
    null,
    2
  )

  try {
    const response = await model.invoke(
      [new SystemMessage(SAVED_TOOL_REWRITE_SYSTEM_PROMPT), new HumanMessage(userPrompt)],
      { callbacks: [] }
    )
    const raw = extractResponseText(response.content).trim()
    const rewrite = parseSavedToolRewrite(raw)
    if (!rewrite) {
      console.warn("[code_exec] failed to parse saved-tool rewrite response:", raw.slice(0, 200))
      return { rewrite: null, error: "工具信息无法解析" }
    }
    return { rewrite }
  } catch (error) {
    console.warn("[code_exec] failed to generate saved-tool rewrite:", error)
    return {
      rewrite: null,
      error: truncateSavedToolMetadataError(getErrorMessage(error)) || "LLM API请求失败"
    }
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return ""
}

function truncateSavedToolMetadataError(message: string): string {
  const trimmed = message.trim()
  if (trimmed.length <= MAX_SAVED_TOOL_METADATA_ERROR_LENGTH) return trimmed
  return `${trimmed.slice(0, MAX_SAVED_TOOL_METADATA_ERROR_LENGTH - 3)}...`
}
