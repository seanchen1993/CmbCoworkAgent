import { tool } from "langchain"
import { z } from "zod"
import type { CodeIndexManager } from "./manager"
import type { CodeIndexSettings } from "./types"

const SNIPPET_MAX_CHARS = 1200

function truncateSnippet(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const cut = text.lastIndexOf("\n", maxChars)
  const end = cut > maxChars * 0.5 ? cut : maxChars
  return text.slice(0, end) + "\n...(truncated)"
}

export function createCodebaseSearchTool(manager: CodeIndexManager, settings: CodeIndexSettings) {
  return tool(
    async (input) => {
      const results = await manager.search(input.query, input.max_results ?? 10, settings)
      if (results.length === 0) {
        return "No matching code found in the codebase index."
      }
      return results
        .map((r, i) => {
          const loc = `${r.relativePath}#L${r.startLine}-L${r.endLine}`
          const ident = r.identifier ? ` (${r.type}: ${r.identifier})` : ""
          const snippet = truncateSnippet(r.content, SNIPPET_MAX_CHARS)
          return `[${i + 1}] ${loc}${ident}  score=${r.score.toFixed(3)}\n\`\`\`\n${snippet}\n\`\`\``
        })
        .join("\n\n---\n\n")
    },
    {
      name: "codebase_search",
      description:
        "Search the indexed codebase for relevant code using semantic (meaning-based) and keyword search. " +
        "Use this to find function implementations, class definitions, usage patterns, or any code related to a concept. " +
        "Works best with natural language queries describing what you're looking for.",
      schema: z.object({
        query: z.string().describe("Search query — describe what code you're looking for in natural language"),
        max_results: z.number().optional().default(10).describe("Maximum number of results to return (default: 10)"),
      }),
    },
  )
}

export function createCodebaseStatusTool(manager: CodeIndexManager) {
  return tool(
    async () => {
      const status = manager.getStatus()
      return JSON.stringify(status, null, 2)
    },
    {
      name: "codebase_index_status",
      description: "Get the current status of the codebase index (indexing state, chunk count, progress).",
      schema: z.object({}),
    },
  )
}
