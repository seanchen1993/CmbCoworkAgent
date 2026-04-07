import { tool } from "langchain"
import { z } from "zod"
import { existsSync, statSync } from "fs"
import { isAbsolute, join } from "path"
import type { MemoryStore } from "./store"
import { memoryFreshnessText } from "./manifest"

const SNIPPET_MAX_CHARS = 700

function truncateSnippet(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const cut = text.lastIndexOf("\n", maxChars)
  const end = cut > maxChars * 0.5 ? cut : maxChars
  return text.slice(0, end) + "\n…(truncated)"
}

export function createMemorySearchTool(store: MemoryStore) {
  return tool(
    async (input) => {
      const results = store.search(input.query, input.max_results ?? 5)
      if (results.length === 0) {
        return "No matching memories found."
      }
      return results
        .map((r, i) => {
          const source = `${r.path}#L${r.startLine}-${r.endLine}`
          const snippet = truncateSnippet(r.text, SNIPPET_MAX_CHARS)
          return `[${i + 1}] (Source: ${source})\n${snippet}`
        })
        .join("\n\n---\n\n")
    },
    {
      name: "memory_search",
      description:
        "Search your long-term memory for information from past conversations. " +
        "Use this before answering questions about prior work, decisions, dates, people, or preferences.",
      schema: z.object({
        query: z
          .string()
          .describe("Search query — use keywords related to what you want to recall"),
        max_results: z
          .number()
          .optional()
          .default(5)
          .describe("Maximum number of results to return")
      })
    }
  )
}

export function createMemoryGetTool(store: MemoryStore) {
  return tool(
    async (input) => {
      const content = store.readMemoryFile(input.path, input.from, input.lines)

      // Prepend freshness caveat for memories older than the threshold so the
      // agent verifies stale claims (file paths, decisions, preferences) before
      // asserting them as live facts.
      try {
        const fullPath = isAbsolute(input.path)
          ? input.path
          : join(store.getMemoryDir(), input.path)
        if (existsSync(fullPath)) {
          const caveat = memoryFreshnessText(statSync(fullPath).mtimeMs)
          if (caveat) return `${caveat}\n\n${content}`
        }
      } catch {
        // If the freshness check fails, fall through to returning the raw content.
      }

      return content
    },
    {
      name: "memory_get",
      description:
        "Read a specific memory file by path. Use this to get the full content " +
        "of a memory file after finding it via memory_search.",
      schema: z.object({
        path: z
          .string()
          .describe("Path to the memory file (e.g., 'feedback_lang.md' or absolute path)"),
        from: z.number().optional().describe("Start line number (1-indexed)"),
        lines: z.number().optional().describe("Number of lines to read")
      })
    }
  )
}
