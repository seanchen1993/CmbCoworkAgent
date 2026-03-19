/**
 * Tool Search Tool - MCP Tool Discovery and Lazy Loading
 *
 * This module implements a three-tool architecture for handling large MCP tool libraries:
 * - search_tool: Search for lazily loaded MCP tools
 * - load_tool: Load tool schemas
 * - mcp_call: Execute tools via indirect call
 */

import { tool } from "langchain"
import { z } from "zod"
import * as nodejieba from "nodejieba"

// =============================================================================
// Types
// =============================================================================

export interface McpToolMetadata {
  toolId: string        // Format: "serverName.toolName"
  serverName: string
  toolName: string
  description: string
}

export interface SearchOptions {
  topK: number
  mode: "bm25" | "keyword" | "regex"
  serverFilter?: string[]
}

interface McpToolEntry {
  metadata: McpToolMetadata
  tool: unknown  // The actual tool object
  schema?: object
}

// =============================================================================
// Schema Fix Utility
// =============================================================================

/**
 * Fix MCP tool schema: some MCP servers return `required: null` instead of `required: []`
 * which causes API errors. Normalize null/undefined to empty array.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fixMcpToolSchema(tool: any): void {
  if (tool.schema?.required == null) {
    tool.schema = { ...tool.schema, required: [] }
  }
}

// =============================================================================
// Simple BM25 Implementation (no external dependencies)
// =============================================================================

class SimpleBM25 {
  private documents: Map<string, { tokens: string[], doc: McpToolMetadata }> = new Map()
  private avgDocLength = 0
  private documentFrequency: Map<string, number> = new Map()
  private totalDocs = 0

  // BM25 parameters
  private readonly k1 = 1.5
  private readonly b = 0.75

  index(docId: string, text: string, doc: McpToolMetadata): void {
    const tokens = this.tokenize(text)
    this.documents.set(docId, { tokens, doc })

    // Update document frequency for each term
    const uniqueTokens = new Set(tokens)
    for (const token of uniqueTokens) {
      this.documentFrequency.set(token, (this.documentFrequency.get(token) ?? 0) + 1)
    }

    this.totalDocs = this.documents.size
    this.updateAvgDocLength()
  }

  private updateAvgDocLength(): void {
    let totalLength = 0
    for (const { tokens } of this.documents.values()) {
      totalLength += tokens.length
    }
    this.avgDocLength = this.totalDocs > 0 ? totalLength / this.totalDocs : 0
  }

  search(query: string, topK: number): McpToolMetadata[] {
    const queryTokens = this.tokenize(query)
    const scores: { doc: McpToolMetadata, score: number }[] = []

    for (const [_id, { tokens, doc }] of this.documents) {
      const score = this.computeScore(queryTokens, tokens)
      if (score > 0) {
        scores.push({ doc, score })
      }
    }

    return scores
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(s => s.doc)
  }

  private computeScore(queryTokens: string[], docTokens: string[]): number {
    if (docTokens.length === 0 || queryTokens.length === 0) return 0

    let score = 0
    const docLength = docTokens.length
    const termFrequency = new Map<string, number>()

    for (const token of docTokens) {
      termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1)
    }

    for (const queryToken of queryTokens) {
      const tf = termFrequency.get(queryToken) ?? 0
      if (tf === 0) continue

      const df = this.documentFrequency.get(queryToken) ?? 0
      const idf = Math.log((this.totalDocs - df + 0.5) / (df + 0.5) + 1)

      const numerator = tf * (this.k1 + 1)
      const denominator = tf + this.k1 * (1 - this.b + this.b * (docLength / this.avgDocLength))

      score += idf * (numerator / denominator)
    }

    return score
  }

  private tokenize(text: string): string[] {
    const tokens: string[] = []

    // Regex to detect Chinese characters (CJK Unified Ideographs)
    const chineseRegex = /[\u4e00-\u9fff]/

    // Split text into Chinese and non-Chinese segments
    // Pattern: match continuous Chinese or continuous non-Chinese
    const segmentPattern = /([\u4e00-\u9fff]+)|([^\u4e00-\u9fff]+)/g

    let match
    while ((match = segmentPattern.exec(text)) !== null) {
      const segment = match[0]

      if (chineseRegex.test(segment)) {
        // Chinese segment: use jieba for word segmentation
        const chineseTokens = nodejieba.cut(segment)
        for (const token of chineseTokens) {
          const trimmed = token.trim().toLowerCase()
          if (trimmed.length > 0) {
            tokens.push(trimmed)
          }
        }
      } else {
        // Non-Chinese segment: use original tokenization logic
        const englishTokens = segment.toLowerCase()
          // Handle camelCase and PascalCase: insert space before uppercase letters
          .replace(/([a-z])([A-Z])/g, "$1 $2")      // camelCase: "testName" → "test Name"
          .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2") // PascalCase/ACRONYM: "APIResponse" → "API Response"
          .replace(/[-_]/g, " ")
          .split(/[\s\-_.,;:!?()[\]{}'"\/\\]+/)
          .filter(t => t.length > 1)

        tokens.push(...englishTokens)
      }
    }

    return tokens
  }

  clear(): void {
    this.documents.clear()
    this.documentFrequency.clear()
    this.totalDocs = 0
    this.avgDocLength = 0
  }
}

// =============================================================================
// MCP Tool Registry
// =============================================================================

export class McpToolRegistry {
  private tools: Map<string, McpToolEntry> = new Map()
  // Track registered tool names to avoid duplicates from multiple connectors to the same server
  private registeredToolNames: Set<string> = new Set()
  private bm25: SimpleBM25 = new SimpleBM25()

  /**
   * Register MCP tools from a server
   * Duplicate tools from the same server are skipped (e.g., multiple connectors to same server)
   * Different servers with same tool names are allowed (e.g., ServerA.search and ServerB.search)
   */
  register(serverName: string, tools: unknown[]): void {
    let registered = 0
    for (const toolObj of tools) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const t = toolObj as any
      const toolName = t.name as string
      const description = (t.description as string) ?? ""

      // Use serverName:toolName as dedupe key to allow same tool names from different servers
      const dedupeKey = `${serverName}:${toolName}`
      if (this.registeredToolNames.has(dedupeKey)) {
        continue
      }

      const toolId = `${serverName}.${toolName}`

      const metadata: McpToolMetadata = {
        toolId,
        serverName,
        toolName,
        description
      }

      // Fix schema: some MCP servers return `required: null` instead of `required: []`
      fixMcpToolSchema(t)
      const schema = t.schema

      this.tools.set(toolId, {
        metadata,
        tool: t,
        schema
      })

      // Mark this server:tool combination as registered
      this.registeredToolNames.add(dedupeKey)
      registered++

      // Index in BM25 using server name, tool name and description
      const searchText = `${serverName} ${toolName} ${description}`
      this.bm25.index(toolId, searchText, metadata)
    }

    console.log(`[McpToolRegistry] Registered ${registered} tools from server "${serverName}" (${tools.length - registered} duplicates skipped)`)
  }

  /**
   * Search for tools using the specified mode
   */
  search(query: string, options: SearchOptions): McpToolMetadata[] {
    const { topK, mode, serverFilter } = options

    let results: McpToolMetadata[]

    switch (mode) {
      case "bm25":
        results = this.bm25.search(query, topK * 2) // Get more results for filtering
        break

      case "keyword":
        results = this.searchKeyword(query, topK * 2)
        break

      case "regex":
        results = this.searchRegex(query, topK * 2)
        break

      default:
        results = this.bm25.search(query, topK * 2)
    }

    // Apply server filter if specified
    if (serverFilter && serverFilter.length > 0) {
      results = results.filter(r => serverFilter.includes(r.serverName))
    }

    return results.slice(0, topK)
  }

  private searchKeyword(query: string, limit: number): McpToolMetadata[] {
    const queryLower = query.toLowerCase()
    const results: { doc: McpToolMetadata, score: number }[] = []

    for (const { metadata } of this.tools.values()) {
      const serverMatch = metadata.serverName.toLowerCase().includes(queryLower)
      const nameMatch = metadata.toolName.toLowerCase().includes(queryLower)
      const descMatch = metadata.description.toLowerCase().includes(queryLower)

      if (serverMatch || nameMatch || descMatch) {
        // Score: exact name match > name contains > server contains > description contains
        let score = 0
        if (metadata.toolName.toLowerCase() === queryLower) {
          score = 100
        } else if (nameMatch) {
          score = 50
        } else if (serverMatch) {
          score = 30
        } else {
          score = 10
        }
        results.push({ doc: metadata, score })
      }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(r => r.doc)
  }

  private searchRegex(pattern: string, limit: number): McpToolMetadata[] {
    let regex: RegExp
    try {
      regex = new RegExp(pattern, "i")
    } catch {
      // Invalid regex, fall back to keyword search
      return this.searchKeyword(pattern, limit)
    }

    const results: McpToolMetadata[] = []

    for (const { metadata } of this.tools.values()) {
      try {
        if (regex.test(metadata.serverName) || regex.test(metadata.toolName) || regex.test(metadata.description)) {
          results.push(metadata)
          if (results.length >= limit) break
        }
      } catch {
        // Regex execution error, skip this tool
        continue
      }
    }

    return results
  }

  /**
   * Load schemas for specified tools
   */
  loadSchema(toolIds: string[]): Map<string, object> {
    const result = new Map<string, object>()

    for (const toolId of toolIds) {
      const entry = this.tools.get(toolId)
      if (entry?.schema) {
        result.set(toolId, entry.schema)
      }
    }

    return result
  }

  /**
   * Get a tool by ID
   */
  getTool(toolId: string): McpToolEntry | undefined {
    return this.tools.get(toolId)
  }

  /**
   * Execute a tool
   */
  async call(toolId: string, args: Record<string, unknown>): Promise<unknown> {
    const entry = this.tools.get(toolId)
    if (!entry) {
      throw new Error(`Tool not found: ${toolId}`)
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = entry.tool as any

    if (typeof t.func !== "function") {
      throw new Error(`Tool ${toolId} is not executable`)
    }

    try {
      const result = await t.func(args)
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[McpToolRegistry] Tool "${toolId}" error:`, message)
      // Return error in MCP tool format (content_and_artifact)
      return [`MCP tool error: ${message}`, []]
    }
  }

  /**
   * Get all registered tool IDs
   */
  getToolIds(): string[] {
    return Array.from(this.tools.keys())
  }

  /**
   * Get count of registered tools
   */
  getToolCount(): number {
    return this.tools.size
  }

  /**
   * Check if a tool is registered
   */
  hasTool(toolId: string): boolean {
    return this.tools.has(toolId)
  }

  /**
   * Clear all registered tools
   */
  clear(): void {
    this.tools.clear()
    this.bm25.clear()
    this.registeredToolNames.clear()
  }
}

// =============================================================================
// Tool Schemas
// =============================================================================

const searchToolSchema = z.object({
  query: z.string().describe("Search query describing the tool capability you need"),
  top_k: z.number().optional().default(5).describe("Maximum number of results to return"),
  mode: z.enum(["bm25", "keyword", "regex"]).optional().default("bm25").describe(
    "Search mode: bm25 (semantic ranking), keyword (simple contains match), regex (pattern match)"
  ),
  server_filter: z.array(z.string()).optional().describe(
    "Optional list of server names to filter results"
  )
})

const loadToolSchema = z.object({
  tool_ids: z.array(z.string()).describe("List of tool IDs to load schemas for")
})

const mcpCallSchema = z.object({
  tool_id: z.string().describe("The ID of the tool to execute (format: serverName.toolName)"),
  arguments: z.object({}).passthrough().describe("Tool arguments as key-value pairs")
})

// =============================================================================
// Tool Factory Functions
// =============================================================================

/**
 * Create the search_tool for discovering lazily loaded MCP tools
 */
export function createSearchTool(registry: McpToolRegistry) {
  return tool(
    async (input) => {
      const { query, top_k, mode, server_filter } = input

      const options: SearchOptions = {
        topK: top_k ?? 5,
        mode: mode ?? "bm25",
        serverFilter: server_filter
      }

      const results = registry.search(query, options)

      const output = {
        query,
        mode: options.mode,
        total: results.length,
        tools: results.map(r => ({
          tool_id: r.toolId,
          server: r.serverName,
          name: r.toolName,
          description: r.description.slice(0, 200) + (r.description.length > 200 ? "..." : "")
        }))
      }

      return JSON.stringify(output, null, 2)
    },
    {
      name: "search_tool",
      description:
        "Search for available MCP tools. Use this to discover tools that can help with your task. " +
        "Returns a list of matching tools with their IDs, names, and descriptions. " +
        "After finding a tool, use load_tool to get its schema, then use mcp_call to execute it.\n\n" +
        "Search modes:\n" +
        "- bm25: Best for natural language queries, ranks results by relevance\n" +
        "- keyword: Simple text matching, faster but less intelligent\n" +
        "- regex: Pattern matching using regular expressions",
      schema: searchToolSchema
    }
  )
}

/**
 * Create the load_tool for loading tool schemas
 */
export function createLoadTool(registry: McpToolRegistry) {
  return tool(
    async (input) => {
      const { tool_ids } = input

      const schemas = registry.loadSchema(tool_ids)

      const tools: Array<{
        tool_id: string
        name: string
        schema?: object
        description: string
        usage: string
        error?: string
      }> = []

      for (const toolId of tool_ids) {
        const entry = registry.getTool(toolId)
        if (!entry) {
          tools.push({
            tool_id: toolId,
            name: "",
            description: "",
            usage: "",
            error: "Tool not found"
          })
          continue
        }

        tools.push({
          tool_id: toolId,
          name: entry.metadata.toolName,
          schema: schemas.get(toolId),
          description: entry.metadata.description,
          usage: `To use this tool, call: mcp_call(tool_id="${toolId}", arguments={...})`
        })
      }

      const result = {
        loaded_tools: tools,
        note: "These tools are now ready to use via mcp_call. They are NOT added to your tool_list (this is the lazy-load design to save context). When asked 'what tools do you have', mention that you have access to these lazy-loaded MCP tools via search_tool/mcp_call workflow."
      }

      return JSON.stringify(result, null, 2)
    },
    {
      name: "load_tool",
      description:
        "Load the schema and detailed information for specific MCP tools. " +
        "Use this after search_tool to get the parameter schema before calling a tool. " +
        "The schema tells you what parameters the tool accepts. " +
        "After loading, use mcp_call(tool_id, arguments) to execute the tool.",
      schema: loadToolSchema
    }
  )
}

/**
 * Create the mcp_call tool for executing MCP tools
 */
export function createMcpCallTool(registry: McpToolRegistry) {
  return tool(
    async (input) => {
      const { tool_id, arguments: args } = input

      // Verify tool exists
      if (!registry.hasTool(tool_id)) {
        return JSON.stringify({
          error: `Tool not found: ${tool_id}`,
          hint: "Use search_tool to find available tools"
        })
      }

      // Helper to execute with retry on connection errors
      const executeWithRetry = async (retries = 1): Promise<unknown> => {
        try {
          return await registry.call(tool_id, args)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          // Retry on connection-related errors (terminated, disconnected, etc.)
          if (retries > 0 && (message.includes("terminated") || message.includes("disconnected") || message.includes("ECONN"))) {
            console.log(`[mcp_call] Connection error for ${tool_id}, retrying...`)
            // Small delay before retry
            await new Promise(resolve => setTimeout(resolve, 500))
            return executeWithRetry(retries - 1)
          }
          throw error
        }
      }

      try {
        const result = await executeWithRetry()

        // Handle MCP tool response format
        if (Array.isArray(result) && result.length === 2) {
          const [content, _artifact] = result
          return JSON.stringify({
            tool_id,
            success: true,
            result: content
          })
        }

        return JSON.stringify({
          tool_id,
          success: true,
          result
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return JSON.stringify({
          tool_id,
          success: false,
          error: message
        })
      }
    },
    {
      name: "mcp_call",
      description:
        "Execute an MCP tool by its ID. Use this after:\n" +
        "1. search_tool to find the tool\n" +
        "2. load_tool to get its schema\n" +
        "Then call with the tool_id and required arguments.",
      schema: mcpCallSchema
    }
  )
}

/**
 * Create all three tool search tools
 */
export function createToolSearchTools(registry: McpToolRegistry): unknown[] {
  return [
    createSearchTool(registry),
    createLoadTool(registry),
    createMcpCallTool(registry)
  ]
}
