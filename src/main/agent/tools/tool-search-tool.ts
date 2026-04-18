/**
 * Tool Search Tool - MCP Tool Discovery and Lazy Loading
 *
 * This module implements a three-tool architecture for handling large MCP tool libraries:
 * - search_tool: Search for lazily loaded MCP tools
 * - inspect_tool: Inspect tool schemas and script signatures
 * - invoke_deferred_tool: Execute a deferred MCP tool or saved tool
 */

import { tool } from "langchain"
import { z } from "zod"
import { CodeExecEngine } from "../../code-exec/engine"
import { LocalProcessRunner } from "../../code-exec/runner"
import {
  getSavedCodeExecTool,
  listSavedCodeExecTools,
  parseCodeExecOutputValue,
  type SavedCodeExecTool
} from "../../code-exec/saved-tool-store"
import type { McpCapabilityService, McpInvocationResult, McpCapabilityTool } from "../../mcp/capability-types"
import { getMcpErrorMessage, getUsefulMcpResultData } from "../../mcp/result-utils"
import { renderToolHints } from "../../mcp/type-hints"
import { getStoredToolExample } from "../../mcp/tool-example-store"
import {
  buildMcpToolSearchDoc,
  buildSavedToolSearchDoc,
  findExactToolIdOrNameMatches,
  matchesExactSearchValue,
  searchToolDocs,
  type ToolSearchDoc,
  type ToolSearchCaller
} from "./tool-search/search-strategy"

async function invokeWithRetry(
  service: McpCapabilityService,
  idOrAlias: string,
  args: Record<string, unknown>,
  retries = 1
): Promise<McpInvocationResult> {
  try {
    return await service.invoke(idOrAlias, args)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const shouldRetry = retries > 0 && (
      message.includes("terminated") ||
      message.includes("disconnected") ||
      message.includes("ECONN")
    )

    if (!shouldRetry) throw error
    await new Promise((resolve) => setTimeout(resolve, 500))
    return invokeWithRetry(service, idOrAlias, args, retries - 1)
  }
}

const invokeDeferredToolSchema = z.object({
  tool_id: z
    .string()
    .describe("Exact deferred-only tool_id returned by search_tool or listed in <deferred-tool-ids>"),
  tool_args: z
    .object({})
    .passthrough()
    .describe("Tool arguments matching the schema returned by inspect_tool(caller=\"invoke_deferred_tool\")")
})

interface ToolSearchContext {
  workspacePath: string
  threadId?: string
}

interface ToolSearchOptions {
  codeExecRouteEnabled: boolean
  savedToolsEnabled: boolean
  deferredRouteEnabled: boolean
}

type SearchToolEntry = {
  toolId: string
  source: "mcp" | "saved_tool"
  allowCallers: ToolSearchCaller[]
  description?: string
}

interface SearchDocCacheEntry {
  snapshot: string
  docs: ToolSearchDoc[]
}

function buildMcpSearchSnapshot(tools: McpCapabilityTool[]): string {
  return JSON.stringify(tools.map((tool) => ([
    tool.capabilityId,
    tool.toolId,
    tool.toolName,
    tool.providerDisplayName,
    tool.providerAlias,
    tool.description ?? "",
    tool.visibility
  ])))
}

function buildSavedToolSearchSnapshot(tools: SavedCodeExecTool[]): string {
  return JSON.stringify(tools.map((tool) => ([
    tool.toolId,
    tool.description,
    tool.dependencies
  ])))
}

function getCachedMcpSearchDocs(
  cache: SearchDocCacheEntry,
  tools: McpCapabilityTool[],
  options: ToolSearchOptions
): ToolSearchDoc[] {
  const snapshot = buildMcpSearchSnapshot(tools)
  if (cache.snapshot === snapshot) return cache.docs

  cache.snapshot = snapshot
  cache.docs = tools.map((tool) => buildMcpToolSearchDoc(tool, {
    allowCallers: getMcpToolAllowCallers(tool, options)
  }))
  return cache.docs
}

function getCachedSavedToolSearchDocs(
  cache: SearchDocCacheEntry,
  tools: SavedCodeExecTool[]
): ToolSearchDoc[] {
  const snapshot = buildSavedToolSearchSnapshot(tools)
  if (cache.snapshot === snapshot) return cache.docs

  cache.snapshot = snapshot
  cache.docs = tools.map((tool) => buildSavedToolSearchDoc(tool))
  return cache.docs
}

function getMcpToolAllowCallers(
  tool: McpCapabilityTool,
  options: ToolSearchOptions
): ToolSearchCaller[] {
  const allowCallers: ToolSearchCaller[] = []
  if (tool.visibility === "lazy") allowCallers.push("invoke_deferred_tool")
  if (options.codeExecRouteEnabled) allowCallers.push("code_exec")
  return allowCallers
}

function toMcpSearchToolEntry(
  tool: McpCapabilityTool,
  options: ToolSearchOptions
): SearchToolEntry {
  return {
    toolId: tool.toolId,
    source: "mcp",
    allowCallers: getMcpToolAllowCallers(tool, options),
    description: tool.description
  }
}

function toSavedSearchToolEntry(tool: SavedCodeExecTool): SearchToolEntry {
  return {
    toolId: tool.toolId,
    source: "saved_tool",
    allowCallers: ["invoke_deferred_tool"],
    description: tool.description
  }
}

function findExactSearchMatches(
  query: string,
  searchableMcpTools: McpCapabilityTool[],
  savedTools: SavedCodeExecTool[],
  options: ToolSearchOptions,
  maxResults: number
): SearchToolEntry[] {
  const exactMatches = new Map<string, SearchToolEntry>()

  const addMcpMatches = (tools: McpCapabilityTool[]): void => {
    for (const tool of findExactToolIdOrNameMatches(tools, query)) {
      exactMatches.set(tool.toolId, toMcpSearchToolEntry(tool, options))
    }
  }

  const addSavedToolMatches = (): void => {
    for (const tool of savedTools) {
      if (!matchesExactSearchValue(tool.toolId, query)) continue
      exactMatches.set(tool.toolId, toSavedSearchToolEntry(tool))
    }
  }

  addMcpMatches(searchableMcpTools)
  addSavedToolMatches()
  return Array.from(exactMatches.values()).slice(0, maxResults)
}

async function getMissingSavedToolDependencies(
  service: McpCapabilityService,
  dependencies: string[]
): Promise<string[]> {
  if (dependencies.length === 0) return []

  const availableTools = await service.listTools()
  const availableToolIds = new Set(availableTools.map((tool) => tool.toolId))
  return dependencies.filter((dependency) => !availableToolIds.has(dependency))
}

function createCallerSchema(
  allowedCallers: ToolSearchCaller[],
  description: string
) {
  return z.enum(allowedCallers as [ToolSearchCaller, ...ToolSearchCaller[]])
    .optional()
    .default(allowedCallers[0])
    .describe(description)
}

function createSearchCallerSchema(options: ToolSearchOptions) {
  const allowedCallers: ToolSearchCaller[] = options.codeExecRouteEnabled
    ? ["invoke_deferred_tool", "code_exec"]
    : ["invoke_deferred_tool"]

  return z.object({
    query: z
      .string()
      .describe(
        "tool in `<deferred-tool-ids>` or normalized capability phrase. For example: 'github issue create', 'search wiki detail', or '团队 风险 列表'. Prefer full words over abbreviations. For caller=invoke_deferred_tool, search only deferred-only tools."
      ),
    max_results: z.number().optional().default(5).describe("Maximum number of results to return"),
    caller: createCallerSchema(
      allowedCallers,
      options.codeExecRouteEnabled
        ? "Which route this search is for. Use invoke_deferred_tool only to discover deferred tools. Use code_exec only after you have already decided to write a code_exec script and need MCP tool_ids for that script."
        : "Which route this search is for. The only valid value is invoke_deferred_tool, which searches deferred-only tools."
    )
  })
}

function createInspectCallerSchema(allowedCallers: ToolSearchCaller[]) {
  return z.object({
    tool_ids: z.array(z.string()).describe("tool_ids to inspect"),
    caller: createCallerSchema(
      allowedCallers,
      allowedCallers.length === 2
        ? "Which route this inspection is for. Use invoke_deferred_tool only for deferred tools before invoke_deferred_tool. Use code_exec only after you have already decided to write a code_exec script and need MCP schemas or call examples."
        : allowedCallers[0] === "code_exec"
          ? "Which route this inspection is for. The only valid value is code_exec. Use it only when authoring a code_exec script."
          : "Which route this inspection is for. The only valid value is invoke_deferred_tool, which is only for deferred-only tools and saved tools before invoke_deferred_tool."
    )
  })
}

export function createSearchTool(service: McpCapabilityService, options: ToolSearchOptions) {
  const lazyMcpDocCache: SearchDocCacheEntry = { snapshot: "", docs: [] }
  const allMcpDocCache: SearchDocCacheEntry = { snapshot: "", docs: [] }
  const savedToolDocCache: SearchDocCacheEntry = { snapshot: "", docs: [] }

  return tool(
    async (input) => {
      const caller = String(input.caller ?? "invoke_deferred_tool")
      const isCodeExecCaller = options.codeExecRouteEnabled && caller === "code_exec"
      const allMcpTools = await service.listTools()
      const searchableMcpTools = allMcpTools.filter(
        (tool) => isCodeExecCaller || tool.visibility === "lazy"
      )
      const savedTools =
        !options.savedToolsEnabled || isCodeExecCaller ? [] : listSavedCodeExecTools()
      const exactMatches = findExactSearchMatches(
        input.query,
        searchableMcpTools,
        savedTools,
        options,
        input.max_results ?? 5
      )

      if (exactMatches.length > 0) {
        return JSON.stringify(
          {
            tools: exactMatches.map((tool) => ({
              tool_id: tool.toolId,
              source: tool.source,
              allow_callers: tool.allowCallers,
              description: (tool.description ?? "").slice(0, 200)
            }))
          },
          null,
          2
        )
      }

      const mcpDocs = getCachedMcpSearchDocs(
        isCodeExecCaller ? allMcpDocCache : lazyMcpDocCache,
        searchableMcpTools,
        options
      )
      const savedDocs =
        savedTools.length > 0 ? getCachedSavedToolSearchDocs(savedToolDocCache, savedTools) : []

      const tools: SearchToolEntry[] = searchToolDocs(
        [...mcpDocs, ...savedDocs],
        input.query,
        input.max_results ?? 5
      ).map((doc) => ({
        toolId: doc.toolId,
        source: doc.source,
        allowCallers: doc.allowCallers,
        description: doc.description
      }))

      return JSON.stringify(
        {
          tools: tools.map((tool) => ({
            tool_id: tool.toolId,
            source: tool.source,
            allow_callers: tool.allowCallers,
            description: (tool.description ?? "").slice(0, 200)
          }))
        },
        null,
        2
      )
    },
    {
      name: "search_tool",
      description: options.codeExecRouteEnabled
        ? "Search deferred tools by capability phrase or exact tool_id. For caller=invoke_deferred_tool, search only deferred tools. For caller=code_exec, search MCP tools only after you have already decided to author a code_exec script. Returns each tool's source and allow_callers."
        : "Search deferred tools for invoke_deferred_tool by capability phrase or exact tool_id. Search only deferred tools. Returns each tool's source and allow_callers.",
      schema: createSearchCallerSchema(options)
    }
  )
}

export function createInspectTool(service: McpCapabilityService, options: ToolSearchOptions) {
  const allowedCallers: ToolSearchCaller[] = [
    ...(options.deferredRouteEnabled ? ["invoke_deferred_tool" as const] : []),
    ...(options.codeExecRouteEnabled ? ["code_exec" as const] : [])
  ]

  return tool(
    async (input) => {
      const caller = String(input.caller ?? allowedCallers[0])
      const loadedTools = await Promise.all(input.tool_ids.map(async (idOrAlias) => {
        const savedTool = getSavedCodeExecTool(idOrAlias, { includeDisabled: true })
        if (savedTool) {
          if (!options.savedToolsEnabled) {
            return {
              tool_id: savedTool.toolId,
              source: "saved_tool",
              allow_callers: ["invoke_deferred_tool"],
              error: "Saved tools are disabled in settings."
            }
          }

          if (!savedTool.enabled) {
            return {
              tool_id: savedTool.toolId,
              source: "saved_tool",
              allow_callers: ["invoke_deferred_tool"],
              error: "Saved tool is disabled."
            }
          }

          if (caller === "code_exec") {
            return {
              tool_id: savedTool.toolId,
              source: "saved_tool",
              allow_callers: ["invoke_deferred_tool"],
              error: "Saved code_exec tools cannot be called from code_exec. Load the underlying MCP tool instead."
            }
          }

          return {
            tool_id: savedTool.toolId,
            source: "saved_tool",
            allow_callers: ["invoke_deferred_tool"],
            schema: savedTool.inputSchema
          }
        }

        const resolved = await service.getTool(idOrAlias)
        if (!resolved) {
          return {
            tool_id: idOrAlias,
            source: "mcp",
            allow_callers: [],
            error:
              caller === "code_exec"
                ? "Only MCP tools may be inspected for code_exec. Saved tools, built-in tools, and other non-MCP tools are not allowed."
                : "Tool not found"
          }
        }

        if (caller === "invoke_deferred_tool" && resolved.visibility !== "lazy") {
          return {
            tool_id: resolved.toolId,
            source: "mcp",
            allow_callers: getMcpToolAllowCallers(resolved, options),
            error: "This MCP tool is already directly callable from the tool list. Call it directly instead of using the deferred workflow."
          }
        }

        const loadedTool: Record<string, unknown> = {
          tool_id: resolved.toolId,
          source: "mcp",
          allow_callers: getMcpToolAllowCallers(resolved, options),
          schema: resolved.inputSchema,
          output_schema: resolved.outputSchema
        }

        if (caller === "code_exec") {
          const storedExample = getStoredToolExample(resolved)
          const hints = renderToolHints(resolved)

          loadedTool.code_exec = {
            call_example: hints.callExample,
            ...(storedExample ? { result_example: storedExample.resultExample } : {})
          }
        }

        return loadedTool
      }))

      return JSON.stringify({
        loaded_tools: loadedTools
      }, null, 2)
    },
    {
      name: "inspect_tool",
      description:
        allowedCallers.length === 2
          ? "Inspect discovered tool_ids. Use caller=invoke_deferred_tool only for deferred-only tools and saved tools before invoke_deferred_tool. Use caller=code_exec only after you have already decided to write a code_exec script and need MCP schemas or call examples. Do not use inspect_tool before an ordinary direct call to a callable tool."
          : allowedCallers[0] === "code_exec"
            ? "Inspect discovered MCP tool_ids only when authoring a code_exec script. Returns loaded_tools[] with schema, output_schema, and code_exec call hints. Do not use inspect_tool before an ordinary direct call to a callable tool."
            : "Inspect discovered deferred-only tool_ids and saved tool_ids before invoke_deferred_tool. Do not use inspect_tool for ordinary direct calls to tools already present in the callable tool list.",
      schema: createInspectCallerSchema(allowedCallers)
    }
  )
}

export function createInvokeDeferredTool(
  service: McpCapabilityService,
  context: ToolSearchContext,
  options: ToolSearchOptions
) {
  const engine = new CodeExecEngine(new LocalProcessRunner(service))

  return tool(
    async (input) => {
      const savedTool = getSavedCodeExecTool(input.tool_id, { includeDisabled: true })
      if (savedTool) {
        if (!options.savedToolsEnabled) {
          return JSON.stringify({
            ok: false,
            error: "Saved tools are disabled in settings."
          }, null, 2)
        }

        if (!savedTool.enabled) {
          return JSON.stringify({
            ok: false,
            error: "Saved tool is disabled."
          }, null, 2)
        }

        const missingDependencies = await getMissingSavedToolDependencies(service, savedTool.dependencies)
        if (missingDependencies.length > 0) {
          const dependencyList = missingDependencies.join(", ")
          return JSON.stringify({
            ok: false,
            error:
              `Saved tool dependency unavailable: ${dependencyList}. ` +
              "The underlying MCP connector or tool is not currently enabled. " +
              "Re-enable the connector, then retry this saved tool."
          }, null, 2)
        }

        const result = await engine.execute({
          code: savedTool.code,
          params: input.tool_args ?? {},
          timeoutMs: savedTool.timeoutMs,
          workspacePath: context.workspacePath,
          threadId: context.threadId
        })

        if (!result.ok) {
          return JSON.stringify({
            ok: false,
            error: result.error || result.output
          }, null, 2)
        }

        return JSON.stringify({
          ok: true,
          data: parseCodeExecOutputValue(result.output)
        }, null, 2)
      }

      const resolvedTool = await service.getTool(input.tool_id)
      if (!resolvedTool) {
        return JSON.stringify({
          ok: false,
          error: `Tool not found: ${input.tool_id}`
        }, null, 2)
      }

      if (resolvedTool.visibility !== "lazy") {
        return JSON.stringify({
          ok: false,
          error: `Tool ${resolvedTool.toolId} is already directly callable from the tool list. Call it directly instead of using invoke_deferred_tool.`
        }, null, 2)
      }

      try {
        const result = await invokeWithRetry(service, input.tool_id, input.tool_args ?? {})

        if (result.isError) {
          return JSON.stringify({
            ok: false,
            error: getMcpErrorMessage(result)
          }, null, 2)
        }

        return JSON.stringify({
          ok: true,
          data: getUsefulMcpResultData(result)
        }, null, 2)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return JSON.stringify({
          ok: false,
          error: message
        }, null, 2)
      }
    },
    {
      name: "invoke_deferred_tool",
      description:
        "Execute a deferred-only MCP tool or saved tool by tool_id. You must inspect the tool first with inspect_tool(caller=\"invoke_deferred_tool\") and use the exact returned schema. Do not use this for tools that are already directly callable from the tool list. Returns { ok: true, data } on success or { ok: false, error } on failure.",
      schema: invokeDeferredToolSchema
    }
  )
}

export async function createToolSearchTools(
  service: McpCapabilityService,
  context: ToolSearchContext,
  options?: Partial<ToolSearchOptions>
): Promise<unknown[]> {
  const codeExecRouteEnabled = options?.codeExecRouteEnabled === true
  const savedToolsEnabled = options?.savedToolsEnabled !== false
  const tools = await service.listTools()
  const savedTools = savedToolsEnabled ? listSavedCodeExecTools() : []
  const lazyTools = tools.filter((tool) => tool.visibility === "lazy")
  const hasMcpTools = tools.length > 0
  const hasLazyTools = lazyTools.length > 0
  const hasSavedTools = savedTools.length > 0
  const needsDeferredBridge = hasLazyTools || hasSavedTools
  const shouldInjectInspectTool = needsDeferredBridge || (codeExecRouteEnabled && hasMcpTools)

  if (!shouldInjectInspectTool) return []

  if (!needsDeferredBridge) {
    return [createInspectTool(service, {
      codeExecRouteEnabled,
      savedToolsEnabled,
      deferredRouteEnabled: false
    })]
  }

  return [
    createSearchTool(service, {
      codeExecRouteEnabled,
      savedToolsEnabled,
      deferredRouteEnabled: true
    }),
    createInspectTool(service, {
      codeExecRouteEnabled,
      savedToolsEnabled,
      deferredRouteEnabled: true
    }),
    createInvokeDeferredTool(service, context, {
      codeExecRouteEnabled,
      savedToolsEnabled,
      deferredRouteEnabled: true
    })
  ]
}
