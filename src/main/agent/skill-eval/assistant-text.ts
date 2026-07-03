import type { AgentTrace, TraceNode } from "../trace/types"

const TERMINAL_MESSAGE_NAMES = new Set(["Run Completed", "Run Error", "Run Cancelled"])
const PLACEHOLDER_TERMINAL_OUTPUTS = new Set(["run completed", "run cancelled", "run error"])

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function isPlaceholderTerminalOutput(text: string): boolean {
  return PLACEHOLDER_TERMINAL_OUTPUTS.has(text.trim().toLowerCase())
}

export function getSkillEvalTerminalMessageNode(trace: AgentTrace): TraceNode | null {
  const nodes = Array.isArray(trace.nodes) ? trace.nodes : []
  const root = nodes.find((node) => node.type === "trace")
  const terminalMessages = nodes.filter(
    (node) =>
      node.type === "message" &&
      node.parentId === root?.id &&
      Boolean(node.name && TERMINAL_MESSAGE_NAMES.has(node.name))
  )
  return terminalMessages[terminalMessages.length - 1] ?? null
}

export function getSkillEvalAssistantText(trace: AgentTrace): string {
  const steps = trace.steps ?? []
  const lastStepText = cleanText(steps[steps.length - 1]?.assistantText)
  if (lastStepText) return lastStepText

  let longestStepText = ""
  for (const step of steps) {
    const text = cleanText(step.assistantText)
    if (text.length > longestStepText.length) longestStepText = text
  }
  if (longestStepText) return longestStepText

  const modelCalls = Array.isArray(trace.modelCalls) ? trace.modelCalls : []
  for (let index = modelCalls.length - 1; index >= 0; index -= 1) {
    const content = cleanText(modelCalls[index]?.outputMessage?.content)
    if (content) return content
  }

  const terminalOutput = cleanText(getSkillEvalTerminalMessageNode(trace)?.output)
  if (terminalOutput && !isPlaceholderTerminalOutput(terminalOutput)) return terminalOutput
  return ""
}
