import { tool } from "langchain"
import { z } from "zod"
import { existsSync, statSync } from "fs"
import { isAbsolute, join } from "path"
import type { MemoryStore } from "./store"
import { memoryFreshnessText, MEMORY_FRESHNESS_DAYS } from "./manifest"

const SNIPPET_MAX_CHARS = 700

function truncateSnippet(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const cut = text.lastIndexOf("\n", maxChars)
  const end = cut > maxChars * 0.5 ? cut : maxChars
  return text.slice(0, end) + "\n…(truncated)"
}

function asStores(stores: MemoryStore | MemoryStore[]): MemoryStore[] {
  return Array.isArray(stores) ? stores : [stores]
}

export function createMemorySearchTool(storesInput: MemoryStore | MemoryStore[]) {
  const stores = asStores(storesInput)
  return tool(
    async (input) => {
      const limit = input.max_results ?? 5
      const seen = new Set<string>()
      const results = stores
        .flatMap((store) =>
          store.search(input.query, Math.max(limit, 5), { trackRecall: false }).map((result) => ({
            result,
            store
          }))
        )
        .filter(({ result }) => {
          const key = `${result.path}:${result.startLine}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        .sort((a, b) => (b.result.score ?? 0) - (a.result.score ?? 0))
        .slice(0, limit)
      for (const { store, result } of results) {
        store.recordRecall([{ path: result.path, startLine: result.startLine }])
      }
      if (results.length === 0) {
        return "No matching memories found."
      }
      const now = Date.now()
      const staleMs = MEMORY_FRESHNESS_DAYS * 24 * 60 * 60 * 1000
      return results
        .map(({ result: r }, i) => {
          const source = r.citation ?? `${r.path}#L${r.startLine}-${r.endLine}`
          const snippet = truncateSnippet(r.text, SNIPPET_MAX_CHARS)
          // Tag stale snippets so the agent knows to verify before asserting
          // — most agents call memory_search and use the snippet directly
          // without ever calling memory_get, so the caveat must live here too.
          let staleTag = ""
          try {
            if (existsSync(r.path)) {
              const ageMs = now - statSync(r.path).mtimeMs
              if (ageMs > staleMs) {
                const days = Math.floor(ageMs / (24 * 60 * 60 * 1000))
                staleTag = ` ⚠️ ${days}d old — verify before asserting`
              }
            }
          } catch {
            /* ignore stat failures */
          }
          return `[${i + 1}] (Source: ${source})${staleTag}\n${snippet}`
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

export function createMemoryGetTool(storesInput: MemoryStore | MemoryStore[]) {
  const stores = asStores(storesInput)
  return tool(
    async (input) => {
      const store =
        stores.find((candidate) => {
          const fullPath = isAbsolute(input.path)
            ? input.path
            : join(candidate.getMemoryDir(), input.path)
          return existsSync(fullPath)
        }) ?? stores[0]
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
