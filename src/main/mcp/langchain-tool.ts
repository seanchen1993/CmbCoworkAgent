import { DynamicStructuredTool } from "@langchain/core/tools"
import { ToolMessage } from "@langchain/core/messages"
import { CallbackManager, parseCallbackConfigArg } from "@langchain/core/callbacks/manager"
import type { McpCapabilityService, McpCapabilityTool } from "./capability-types"
import { toEagerToolResponse } from "./result-utils"

function getRequiredMcpArgs(schema?: Record<string, unknown>): string[] {
  if (!schema || typeof schema !== "object") return []
  if (!Array.isArray(schema.required)) return []
  return schema.required.filter((item): item is string => typeof item === "string")
}

function buildLangChainMcpToolDescription(tool: McpCapabilityTool): string {
  const base = tool.description?.trim() ?? ""
  const requiredArgs = getRequiredMcpArgs(tool.inputSchema)

  if (requiredArgs.length === 0) {
    return base
  }

  const requiredSuffix = `Required args: ${requiredArgs.join(", ")}.`
  return base ? `${base} ${requiredSuffix}` : requiredSuffix
}

function isToolCallLike(arg: unknown): arg is { id?: string; args?: unknown } {
  return Boolean(arg && typeof arg === "object" && "args" in arg)
}

function stringifyContent(content: unknown): string {
  try {
    return JSON.stringify(content) ?? ""
  } catch {
    return String(content)
  }
}

function formatToolOutput(params: {
  content: unknown
  artifact?: unknown
  toolCallId?: string
  name: string
  metadata?: Record<string, unknown>
}): ToolMessage | unknown {
  const { content, artifact, toolCallId, name, metadata } = params
  if (!toolCallId) return content

  if (
    typeof content === "string" ||
    (Array.isArray(content) && content.every((item) => typeof item === "object"))
  ) {
    return new ToolMessage({
      status: "success",
      content,
      artifact,
      tool_call_id: toolCallId,
      name,
      metadata
    })
  }

  return new ToolMessage({
    status: "success",
    content: stringifyContent(content),
    artifact,
    tool_call_id: toolCallId,
    name,
    metadata
  })
}

class NonValidatingMcpTool extends DynamicStructuredTool {
  async call(arg: unknown, configArg?: unknown, tags?: string[]): Promise<unknown> {
    const config = parseCallbackConfigArg(
      configArg as Parameters<typeof parseCallbackConfigArg>[0]
    )
    if (config.runName === undefined) {
      config.runName = this.name
    }

    const input = isToolCallLike(arg) ? (arg.args ?? {}) : arg

    const callbackManager = CallbackManager.configure(
      config.callbacks,
      this.callbacks,
      config.tags || tags,
      this.tags,
      config.metadata,
      this.metadata,
      { verbose: this.verbose }
    )

    const toolCallId =
      (isToolCallLike(arg) ? arg.id : undefined)
      ?? ((config as { toolCall?: { id?: string } }).toolCall?.id)

    const runManager = await callbackManager?.handleToolStart(
      this.toJSON(),
      typeof arg === "string" ? arg : JSON.stringify(arg),
      config.runId,
      undefined,
      undefined,
      undefined,
      config.runName,
      toolCallId
    )

    delete config.runId

    let result: unknown
    try {
      result = await this._call(input as never, runManager, config as never)
    } catch (error) {
      await runManager?.handleToolError(error)
      throw error
    }

    let content: unknown
    let artifact: unknown
    if (this.responseFormat === "content_and_artifact") {
      if (!Array.isArray(result) || result.length !== 2) {
        throw new Error(
          `Tool response format is "content_and_artifact" but the output was not a two-tuple.\nResult: ${JSON.stringify(result)}`
        )
      }
      [content, artifact] = result
    } else {
      content = result
    }

    const formattedOutput = formatToolOutput({
      content,
      artifact,
      toolCallId,
      name: this.name,
      metadata: this.metadata
    })

    await runManager?.handleToolEnd(formattedOutput)
    return formattedOutput
  }
}

export function createEagerMcpTool(
  capabilityService: McpCapabilityService,
  tool: McpCapabilityTool
): DynamicStructuredTool {
  return new NonValidatingMcpTool({
    name: tool.toolId,
    description: buildLangChainMcpToolDescription(tool),
    schema: tool.inputSchema ?? { type: "object", properties: {} },
    responseFormat: "content_and_artifact",
    func: async (args) => {
      try {
        const result = await capabilityService.invoke(tool.capabilityId, args ?? {})
        return toEagerToolResponse(result)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[Runtime] MCP tool "${tool.toolName}" error (non-fatal):`, message)
        return [`MCP tool error: ${message}`, []]
      }
    }
  })
}
