import type { TaskMmdToolEntry } from "./types"
import { stripAnsiText } from "./sanitizer"

export function renderTaskMmdSystemBlock(mmd: string): string {
  return `\n\n## Current Task Map\n\nThe following Mermaid graph is a compact navigation aid for the current thread. Use it to remember completed work, active branches, blockers, and where to continue. It is not a replacement for the actual conversation or tool results.\n\n\`\`\`mermaid\n${mmd.trim()}\n\`\`\`\n`
}

export function renderTaskMmdCompilePrompt(
  existingMmd: string,
  entries: TaskMmdToolEntry[]
): string {
  const entryLines = entries
    .map((entry, index) => {
      const args = stripAnsiText(entry.argsPreview).replace(/\s+/g, " ").slice(0, 360)
      const result = stripAnsiText(entry.resultPreview).replace(/\s+/g, " ").slice(0, 520)
      return [
        `#${index + 1}`,
        `tool_call_id: ${entry.toolCallId}`,
        `scope: ${entry.scope}`,
        `tool: ${entry.toolName}`,
        `status: ${entry.status}`,
        `duration_ms: ${entry.durationMs}`,
        `args: ${args || "(empty)"}`,
        `result: ${result || "(empty)"}`
      ].join("\n")
    })
    .join("\n\n")

  return `You maintain a compact Mermaid task map for an AI coding agent.

Goal:
- Update the graph to show what has actually happened in the current task.
- Preserve useful existing nodes and edges.
- Add or update nodes for the new tool-call evidence.
- Do not invent future work that has not happened.

Status vocabulary:
- done: completed or verified work
- doing: currently active work
- paused: paused or waiting for more information
- blocked: failed command, error, or unresolved blocker

Graph rules:
- Use Mermaid flowchart TD.
- Keep node labels short and factual.
- When a node is about a file, keep the complete basename visible; omit directories before clipping the filename.
- Include status in each node label using "<br/>status: done" style.
- Prefer 5-20 nodes.
- Avoid raw secrets, long logs, stack traces, or full file contents.
- Output JSON only: {"mmd":"flowchart TD\\n  ..."}

Existing Mermaid:
\`\`\`mermaid
${stripAnsiText(existingMmd).trim() || "flowchart TD"}
\`\`\`

New tool-call evidence:
\`\`\`text
${entryLines || "(no entries)"}
\`\`\`
`
}
