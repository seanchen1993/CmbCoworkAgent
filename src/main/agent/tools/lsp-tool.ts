import { tool } from "langchain"
import { z } from "zod"
import { existsSync } from "fs"
import { execFileSync } from "child_process"
import {
  startLsp,
  isLspRunning,
  lspDefinition,
  lspReferences,
  lspHover,
  lspImplementation,
  lspDocumentSymbols,
  lspWorkspaceSymbol,
  lspDiagnostics,
  lspPrepareCallHierarchy,
  lspIncomingCalls,
  lspOutgoingCalls
} from "../../lsp"
import type {
  LspLocation, LspSymbol, LspDiagnostic,
  LspCallHierarchyItem, LspCallHierarchyIncomingCall, LspCallHierarchyOutgoingCall
} from "../../types"

const ACTIONS = [
  "definition", "references", "hover", "implementation",
  "document_symbols", "workspace_symbol", "diagnostics",
  "prepare_call_hierarchy", "incoming_calls", "outgoing_calls"
] as const

const VALID_ACTIONS = new Set<string>(ACTIONS)

const lspSchema = z.object({
  action: z.string().describe(
    "Action to perform: definition, references, hover, implementation, document_symbols, workspace_symbol, diagnostics, prepare_call_hierarchy, incoming_calls, outgoing_calls"
  ),
  filePath: z.string().optional().describe(
    "Absolute file path. Required for definition/references/hover/implementation/document_symbols/diagnostics and call hierarchy actions."
  ),
  line: z.number().optional().describe(
    "1-based line number. Required for definition/references/hover/implementation and call hierarchy actions."
  ),
  column: z.number().optional().describe(
    "1-based column number. Required for definition/references/hover/implementation and call hierarchy actions."
  ),
  query: z.string().optional().describe(
    "Search query. Required for workspace_symbol."
  )
})

interface LspToolContext {
  workspacePath: string
}

function filterGitIgnored(locations: LspLocation[], projectRoot: string): LspLocation[] {
  if (locations.length === 0) return locations
  const uniquePaths = [...new Set(locations.map(l => l.file))]

  try {
    const result = execFileSync("git", ["check-ignore", "--stdin"], {
      cwd: projectRoot,
      input: uniquePaths.join("\n"),
      encoding: "utf-8",
      timeout: 5000
    })
    const ignoredPaths = new Set(result.trim().split(/\r?\n/).filter(Boolean))
    if (ignoredPaths.size === 0) return locations
    const filtered = locations.filter(l => !ignoredPaths.has(l.file))
    console.log(`[LSP] gitignore filtered: ${locations.length} → ${filtered.length} locations`)
    return filtered
  } catch {
    // Exit code 1 = no paths ignored; exit code 128 = not a git repo
    return locations
  }
}

function formatLocations(locations: LspLocation[], label: string): string {
  if (locations.length === 0) return `No ${label} found.`
  const lines = locations.map((loc) =>
    `  ${loc.file}:${loc.line}:${loc.column}`
  )
  return `${label} (${locations.length}):\n${lines.join("\n")}`
}

function formatSymbols(symbols: LspSymbol[]): string {
  if (symbols.length === 0) return "No symbols found."
  const lines = symbols.map((s) => {
    const location = s.file ? `${s.file}:${s.line}` : ""
    const container = s.containerName ? ` (in ${s.containerName})` : ""
    return `  ${s.kind} ${s.name}${container}${location ? ` — ${location}` : ""}`
  })
  return `Symbols (${symbols.length}):\n${lines.join("\n")}`
}

function formatDiagnostics(diags: LspDiagnostic[]): string {
  if (diags.length === 0) return "No diagnostics (all clean)."
  const lines = diags.map((d) =>
    `  [${d.severity}] ${d.file}:${d.line}:${d.column} — ${d.message}${d.source ? ` (${d.source})` : ""}`
  )
  return `Diagnostics (${diags.length}):\n${lines.join("\n")}`
}

function formatCallHierarchyItems(items: LspCallHierarchyItem[]): string {
  if (items.length === 0) return "No call hierarchy items found at this position."
  const lines = items.map(i =>
    `  ${i.kind} ${i.name}${i.detail ? ` — ${i.detail}` : ""} at ${i.file}:${i.selectionRange.startLine}`
  )
  return `Call hierarchy items (${items.length}):\n${lines.join("\n")}`
}

function formatIncomingCalls(calls: LspCallHierarchyIncomingCall[]): string {
  if (calls.length === 0) return "No incoming calls found."
  const lines = calls.map(c =>
    `  ${c.from.kind} ${c.from.name} at ${c.from.file}:${c.from.selectionRange.startLine}`
  )
  return `Incoming calls (${calls.length}):\n${lines.join("\n")}`
}

function formatOutgoingCalls(calls: LspCallHierarchyOutgoingCall[]): string {
  if (calls.length === 0) return "No outgoing calls found."
  const lines = calls.map(c =>
    `  ${c.to.kind} ${c.to.name} at ${c.to.file}:${c.to.selectionRange.startLine}`
  )
  return `Outgoing calls (${calls.length}):\n${lines.join("\n")}`
}

export function createLspTool(context: LspToolContext) {
  return tool(
    async (input) => {
      const { workspacePath } = context

      // Validate action
      if (!VALID_ACTIONS.has(input.action)) {
        return `Error: Invalid action "${input.action}". Valid actions: ${ACTIONS.join(", ")}`
      }

      // Auto-start LSP if not running
      if (!isLspRunning(workspacePath)) {
        try {
          await startLsp(workspacePath)
        } catch (e) {
          return `Error: Failed to start Java LSP — ${e instanceof Error ? e.message : String(e)}`
        }
      }

      // Validate file exists (lsp/index.ts handles size check + open)
      if (input.filePath && !existsSync(input.filePath)) {
        return `Error: File not found: ${input.filePath}`
      }

      try {
        switch (input.action) {
          case "definition": {
            if (!input.filePath || !input.line || !input.column) {
              return "Error: filePath, line, and column are required for definition"
            }
            const locations = await lspDefinition(workspacePath, input.filePath, input.line, input.column)
            const filtered = filterGitIgnored(locations, workspacePath)
            return formatLocations(filtered, "Definitions")
          }

          case "references": {
            if (!input.filePath || !input.line || !input.column) {
              return "Error: filePath, line, and column are required for references"
            }
            const locations = await lspReferences(workspacePath, input.filePath, input.line, input.column)
            const filtered = filterGitIgnored(locations, workspacePath)
            return formatLocations(filtered, "References")
          }

          case "hover": {
            if (!input.filePath || !input.line || !input.column) {
              return "Error: filePath, line, and column are required for hover"
            }
            const result = await lspHover(workspacePath, input.filePath, input.line, input.column)
            if (!result) return "No hover information available at this position."
            return `Hover info:\n${result.contents}`
          }

          case "implementation": {
            if (!input.filePath || !input.line || !input.column) {
              return "Error: filePath, line, and column are required for implementation"
            }
            const locations = await lspImplementation(workspacePath, input.filePath, input.line, input.column)
            const filtered = filterGitIgnored(locations, workspacePath)
            return formatLocations(filtered, "Implementations")
          }

          case "document_symbols": {
            if (!input.filePath) {
              return "Error: filePath is required for document_symbols"
            }
            const symbols = await lspDocumentSymbols(workspacePath, input.filePath)
            return formatSymbols(symbols)
          }

          case "workspace_symbol": {
            if (!input.query) {
              return "Error: query is required for workspace_symbol"
            }
            const symbols = await lspWorkspaceSymbol(workspacePath, input.query)
            return formatSymbols(symbols)
          }

          case "diagnostics": {
            const diags = lspDiagnostics(workspacePath, input.filePath)
            return formatDiagnostics(diags)
          }

          case "prepare_call_hierarchy": {
            if (!input.filePath || !input.line || !input.column) {
              return "Error: filePath, line, and column are required for prepare_call_hierarchy"
            }
            const items = await lspPrepareCallHierarchy(workspacePath, input.filePath, input.line, input.column)
            return formatCallHierarchyItems(items)
          }

          case "incoming_calls": {
            if (!input.filePath || !input.line || !input.column) {
              return "Error: filePath, line, and column are required for incoming_calls"
            }
            const calls = await lspIncomingCalls(workspacePath, input.filePath, input.line, input.column)
            return formatIncomingCalls(calls)
          }

          case "outgoing_calls": {
            if (!input.filePath || !input.line || !input.column) {
              return "Error: filePath, line, and column are required for outgoing_calls"
            }
            const calls = await lspOutgoingCalls(workspacePath, input.filePath, input.line, input.column)
            return formatOutgoingCalls(calls)
          }

          default:
            return `Error: unknown action: ${input.action}`
        }
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`
      }
    },
    {
      name: "java_lsp",
      description:
        "Java Language Server tool for precise code intelligence. Provides definition lookup, find references, " +
        "hover type info, implementations, document/workspace symbols, diagnostics, and call hierarchy.\n\n" +
        "ACTIONS:\n" +
        "- definition: Jump to definition of symbol at position (filePath, line, column)\n" +
        "- references: Find all references of symbol at position (filePath, line, column)\n" +
        "- hover: Get type/documentation info at position (filePath, line, column)\n" +
        "- implementation: Find implementations of interface/abstract method (filePath, line, column)\n" +
        "- document_symbols: List all symbols in a file (filePath)\n" +
        "- workspace_symbol: Search symbols across the project (query)\n" +
        "- diagnostics: Get compilation errors/warnings (optional filePath to filter)\n" +
        "- prepare_call_hierarchy: Get call hierarchy items at position (filePath, line, column)\n" +
        "- incoming_calls: Find all callers of the function at position (filePath, line, column)\n" +
        "- outgoing_calls: Find all functions called by the function at position (filePath, line, column)\n\n" +
        "All line and column numbers are 1-based. The LSP server starts automatically on first use.",
      schema: lspSchema
    }
  )
}
