import assert from "node:assert/strict"
import { assertSupportedJsonSchema, validateJsonSchemaValue } from "../../src/main/agent/workflow/json-schema"

export interface FullAppStep {
  key: string
  name: "execute" | "read_file" | "workflow" | "task" | "structured_output"
  args: Record<string, unknown>
}

export function modelText(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(part => modelText(part?.text)).join("\n")
  return ""
}

/** Read actual native-tool output; never construct a scheduler/receipt answer in the model. */
export function toolJson(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>
  const text = modelText(value)
  const marked = text.lastIndexOf("APP_SAMPLE_RESULT=")
  if (marked >= 0) return toolJson(JSON.parse(text.slice(marked + "APP_SAMPLE_RESULT=".length).split("\n")[0]))
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{") continue
    let depth = 0, string = false, escaped = false
    for (let end = start; end < text.length; end++) {
      const char = text[end]
      if (string) {
        if (escaped) escaped = false
        else if (char === "\\") escaped = true
        else if (char === '"') string = false
      } else if (char === '"') string = true
      else if (char === "{") depth++
      else if (char === "}" && --depth === 0) {
        try { return toolJson(JSON.parse(text.slice(start, end + 1))) } catch { break }
      }
    }
  }
  throw Error(`Original native tool did not return a complete JSON object: ${text.slice(0, 300)}`)
}

export const shellQuote = (value: string): string =>
  `'${value.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`

/** Return only observed command facts through the real advertised Workflow result tool. */
export function originalWorkflowStructuredOutput(
  actual: Record<string, unknown> | undefined,
  tools: Array<{ function: { name: string; parameters?: Record<string, unknown> } }>
): FullAppStep {
  assert(actual, "A Workflow result requires an actual native command response")
  const schema = tools.find(tool => tool.function.name === "structured_output")?.function.parameters
  assert(schema, "Original Workflow structured_output tool must be advertised")
  assertSupportedJsonSchema(schema)
  const project = (value: unknown, node: unknown): unknown => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return value
    const shape = node as Record<string, unknown>
    if (Array.isArray(value)) return value.map(item => project(item, shape.items))
    if (!value || typeof value !== "object") return value
    const properties = shape.properties as Record<string, unknown> | undefined
    return Object.fromEntries(Object.entries(value).filter(([key]) =>
      shape.additionalProperties !== false || Boolean(properties && Object.hasOwn(properties, key)))
      .map(([key, item]) => [key, project(item,
        properties?.[key] ?? shape.additionalProperties)]))
  }
  // Additional CLI diagnostics may be omitted only when the public result schema forbids them.
  // Never fill missing fields, coerce types, change status, or synthesize a success verdict.
  const args = project(actual, schema) as Record<string, unknown>
  assert.deepEqual(validateJsonSchemaValue(schema, args), [], "Actual command result violates original Workflow schema")
  return { key: "original-structured-output", name: "structured_output", args }
}

/** A native agent without opts.schema has no result tool; preserve its actual final stdout. */
export function originalWorkflowWorkerReply(
  actual: Record<string, unknown> | undefined,
  tools: Array<{ function: { name: string; parameters?: Record<string, unknown> } }>,
  alreadyRecorded = false
): { content: string; step?: FullAppStep } {
  assert(actual, "A Workflow worker cannot return invented command output")
  const structured = tools.some(tool => tool.function.name === "structured_output")
  return { content: JSON.stringify(actual),
    ...(structured && !alreadyRecorded ? { step: originalWorkflowStructuredOutput(actual, tools) } : {}) }
}

/** Arguments for the original reviewed launcher, validated against its real parser by preflight. */
export function originalWorkflowLauncherArguments(input: {
  source: string
  workspace: string
  feature: string
  workflowWorkspace: string
  taskCardId: string
}): string[] {
  return ["--feature", input.feature, "--plugin-path", input.source,
    "--workspace", input.workspace, "--workflow-workspace", input.workflowWorkspace,
    "--task-card-id", input.taskCardId, "--json"]
}

/** Only commands literally supplied by the original fixed Workflow, after its example prefix. */
export function originalWorkflowCommands(prompt: string, source: string, review = false): string[] {
  const body = prompt.slice(prompt.indexOf("\n") + 1)
  const commands: string[] = []
  const matcher = /python -X utf8 "[^"\r\n]+\/hooks\/[^"\r\n]+\.py"/g
  for (const match of body.matchAll(matcher)) {
    let end = match.index! + match[0].length
    let quote = ""
    for (; end < body.length; end++) {
      const char = body[end]
      if (quote) { if (char === quote) quote = "" }
      else if (char === '"' || char === "'") quote = char
      else if (/[，；。\r\n`]/.test(char)) break
    }
    const command = body.slice(match.index, end).trim()
    if (review && command.includes(" fail ")) continue
    // The original status instruction includes an optional JSON-query example after
    // its actual command. A literal placeholder is documentation, never an IO choice.
    if (command.includes("/hooks/query_json_fields.py") && /<[A-Z_]+>/.test(command)) continue
    assert(!quote && !/[<>\r\n]/.test(command), `Non-executable original command: ${command}`)
    assert(command.startsWith(`python -X utf8 "${source.replaceAll("\\", "/")}/hooks/`) ||
      command.startsWith(`python -X utf8 "${source}/hooks/`), "Foreign workflow command")
    assert(!/(?:&&|\|\||;|\$\(|`)/.test(command), "No injected shell continuation")
    commands.push(command)
  }
  assert(commands.length, `Unrecognized original Workflow instruction: ${body.slice(0, 200)}`)
  return commands
}

export function workflowWorkerSteps(input: {
  prompt: string
  source: string
  workspace: string
  feature: string
  sample: string
}): { kind: string; steps: FullAppStep[] } {
  const { prompt, source, workspace, feature, sample } = input
  const body = prompt.slice(prompt.indexOf("\n") + 1)
  const execute = (key: string, command: string): FullAppStep => ({
    key, name: "execute", args: { command, cwd: workspace }
  })
  const runId = /(?:runId=|--run-id ")([^"，。\s]+)/.exec(body)?.[1]
  const batch = /Batch (B\d+)/.exec(body)?.[1]
  const sampleCommand = (action: string, extra: string[]) => ["python -I -B -X utf8",
    shellQuote(sample), action, "--plugin-root", shellQuote(source), "--workspace",
    shellQuote(workspace), "--feature", shellQuote(feature), ...extra].join(" ")
  if (body.startsWith("在插件创建的原生 Git worktree")) {
    assert(runId && batch)
    return { kind: "implementation", steps: [execute("actual-original-implementation",
      sampleCommand("implement", ["--run-id", shellQuote(runId), "--batch-id", batch]))] }
  }
  if (body.startsWith("在 Batch") && body.includes("完成该 Batch 的 UTest")) {
    assert(runId && batch)
    return { kind: "utest", steps: [execute("actual-original-utest",
      sampleCommand("utest", ["--run-id", shellQuote(runId), "--batch-id", batch]))] }
  }
  if (body.startsWith("对已草稿封存的 Batch")) {
    const worktree = /代码只在原生 worktree "([^"]+)"/.exec(body)?.[1]
    const tasks = /TASK 范围仅为 (\[[^\]]+\])/.exec(body)?.[1]
    assert(worktree && tasks)
    const task = JSON.parse(tasks) as string[]
    assert(task.length === 1 && ["T001", "T002"].includes(task[0]))
    // Execute only the success route after actual source is delivered to the model.
    const selected = originalWorkflowCommands(prompt, source, true)
    return { kind: "review", steps: [
      execute("start-original-review", selected[0]),
      { key: "read-real-production-source", name: "read_file", args: {
        file_path: `${worktree}/${task[0] === "T001" ? "cap.py" : "next.py"}` } },
      ...selected.slice(1).map((command, index) => execute(`review-${index}`, command))
    ] }
  }
  if (body.startsWith("在当前已合并 main 上执行唯一的 B-E2E")) {
    assert(runId)
    const worktrees = /临时验证 Worktree 中操作：(\{[^\n]+?\})；/.exec(body)?.[1]
    assert(worktrees)
    const paths = Object.values(JSON.parse(worktrees))
    assert(paths.length === 1 && typeof paths[0] === "string")
    return { kind: "e2e", steps: [execute("actual-original-e2e", sampleCommand("e2e", [
      "--run-id", shellQuote(runId), "--worktree", shellQuote(paths[0])]))] }
  }
  return { kind: "control", steps: originalWorkflowCommands(prompt, source)
    .map((command, index) => execute(`literal-original-command-${index}`, command)) }
}
