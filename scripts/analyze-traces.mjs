#!/usr/bin/env node
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const DEFAULT_TOP = 20
const DEFAULT_MIN_JSON_ITEMS = 20
const DEFAULT_HOMOGENEOUS_RATIO = 0.8

function usage() {
  return `Usage:
  node scripts/analyze-traces.mjs [options]

Options:
  --dir <path>                 Trace root directory. Defaults to CMB_COWORK_TRACES_DIR,
                               then CMB_COWORK_AGENT_HOME/traces, then ~/.cmbcoworkagent/traces.
  --json                       Print machine-readable JSON instead of Markdown.
  --top <n>                    Number of top tools to show. Default: ${DEFAULT_TOP}.
  --min-json-items <n>         Minimum array length to count as large JSON. Default: ${DEFAULT_MIN_JSON_ITEMS}.
  --homogeneous-ratio <0-1>    Minimum same-shape ratio in sampled JSON array. Default: ${DEFAULT_HOMOGENEOUS_RATIO}.
  --help                       Show this help.

The script only prints aggregate metrics and never prints trace message contents.
`
}

function parseArgs(argv) {
  const args = {
    dir: undefined,
    json: false,
    top: DEFAULT_TOP,
    minJsonItems: DEFAULT_MIN_JSON_ITEMS,
    homogeneousRatio: DEFAULT_HOMOGENEOUS_RATIO,
    help: false
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--help" || arg === "-h") {
      args.help = true
      continue
    }
    if (arg === "--json") {
      args.json = true
      continue
    }
    if (arg === "--dir") {
      args.dir = argv[++i]
      continue
    }
    if (arg === "--top") {
      args.top = parsePositiveInteger(argv[++i], "--top")
      continue
    }
    if (arg === "--min-json-items") {
      args.minJsonItems = parsePositiveInteger(argv[++i], "--min-json-items")
      continue
    }
    if (arg === "--homogeneous-ratio") {
      args.homogeneousRatio = parseRatio(argv[++i], "--homogeneous-ratio")
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  return args
}

function parsePositiveInteger(value, name) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${value}`)
  }
  return parsed
}

function parseRatio(value, name) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new Error(`${name} must be in (0, 1], got ${value}`)
  }
  return parsed
}

function defaultTraceDir() {
  if (process.env.CMB_COWORK_TRACES_DIR) return process.env.CMB_COWORK_TRACES_DIR
  if (process.env.CMB_COWORK_AGENT_HOME) {
    return path.join(process.env.CMB_COWORK_AGENT_HOME, "traces")
  }
  return path.join(os.homedir(), ".cmbcoworkagent", "traces")
}

function walkFiles(root, out = []) {
  if (!fs.existsSync(root)) return out
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      walkFiles(fullPath, out)
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(fullPath)
    }
  }
  return out
}

function safeText(value) {
  if (typeof value === "string") return value
  if (value == null) return ""
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return String(value)
  }
}

function parseMaybeJson(text) {
  const trimmed = text.trim()
  if (!trimmed || !(trimmed.startsWith("{") || trimmed.startsWith("["))) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

function shapeOf(value) {
  if (Array.isArray(value)) return "array"
  if (!value || typeof value !== "object") return typeof value
  return Object.keys(value).sort().join("|")
}

function findLargeHomogeneousArray(value, options) {
  const seen = new Set()

  function visit(node, depth) {
    if (depth > 5 || node == null || typeof node !== "object") return null
    if (seen.has(node)) return null
    seen.add(node)

    if (Array.isArray(node)) {
      if (node.length >= options.minJsonItems) {
        const sample = node.slice(0, Math.min(node.length, 50))
        const shapeCounts = new Map()
        for (const item of sample) {
          const shape = shapeOf(item)
          shapeCounts.set(shape, (shapeCounts.get(shape) ?? 0) + 1)
        }
        const topCount = Math.max(...shapeCounts.values())
        const ratio = topCount / sample.length
        if (ratio >= options.homogeneousRatio) {
          return {
            length: node.length,
            sampled: sample.length,
            homogeneousRatio: ratio,
            shapeCount: shapeCounts.size
          }
        }
      }

      for (const item of node.slice(0, 20)) {
        const hit = visit(item, depth + 1)
        if (hit) return hit
      }
      return null
    }

    for (const key of Object.keys(node).slice(0, 50)) {
      const hit = visit(node[key], depth + 1)
      if (hit) return hit
    }
    return null
  }

  return visit(value, 0)
}

function detectContentKinds(text, options) {
  const lineCount = text ? text.split(/\r?\n/).length : 0
  const parsedJson = parseMaybeJson(text)
  const largeJson = parsedJson === undefined ? null : findLargeHomogeneousArray(parsedJson, options)
  const hasJson = parsedJson !== undefined
  const hasLargeResultRef = text.includes("/large_tool_results/")
  const hasConversationHistoryRef = text.includes(".cmbdevclaw/conversation_history")

  const logSignals = [
    /\b(ERROR|FATAL|CRITICAL|Exception|Traceback|FAILED|FAILURE|WARN(?:ING)?)\b/i,
    /\bnpm ERR!\b/i,
    /\bBUILD (?:FAILURE|SUCCESS)\b/i,
    /\b\d+\s+(?:passed|failed|skipped|errors?|warnings?)\b/i,
    /\bTests?:\s+\d+/i,
    /\bSuites?:\s+\d+/i,
    /\[Command (?:failed|succeeded) with exit code \d+\]/i
  ].some((pattern) => pattern.test(text))

  const searchLike =
    countRegexMatches(text, /(^|\n)(?:[A-Za-z]:\\)?[^:\n]{1,240}:\d+:/g) >= 5 ||
    countRegexMatches(text, /(^|\n)\s+\d+:\s+/g) >= 10

  const diffLike =
    /(^|\n)diff --git /.test(text) ||
    (/(^|\n)--- /.test(text) && /(^|\n)\+\+\+ /.test(text) && /(^|\n)@@ /.test(text))

  return {
    hasJson,
    largeJson,
    logLike: lineCount >= 10 && logSignals,
    searchLike,
    diffLike,
    hasLargeResultRef,
    hasConversationHistoryRef
  }
}

function countRegexMatches(text, pattern) {
  let count = 0
  for (const _match of text.matchAll(pattern)) count += 1
  return count
}

function emptyBucket() {
  return {
    count: 0,
    chars: 0,
    approxTokens: 0,
    jsonChars: 0,
    jsonCount: 0,
    largeJsonChars: 0,
    largeJsonCount: 0,
    logLikeChars: 0,
    logLikeCount: 0,
    searchLikeChars: 0,
    searchLikeCount: 0,
    diffLikeChars: 0,
    diffLikeCount: 0,
    largeResultRefs: 0,
    conversationHistoryRefs: 0
  }
}

function addToMap(map, key, chars, kinds) {
  const name = key || "unknown"
  const bucket = map.get(name) ?? emptyBucket()
  bucket.count += 1
  bucket.chars += chars
  bucket.approxTokens = Math.round(bucket.chars / 4)
  if (kinds.hasJson) {
    bucket.jsonCount += 1
    bucket.jsonChars += chars
  }
  if (kinds.largeJson) {
    bucket.largeJsonCount += 1
    bucket.largeJsonChars += chars
  }
  if (kinds.logLike) {
    bucket.logLikeCount += 1
    bucket.logLikeChars += chars
  }
  if (kinds.searchLike) {
    bucket.searchLikeCount += 1
    bucket.searchLikeChars += chars
  }
  if (kinds.diffLike) {
    bucket.diffLikeCount += 1
    bucket.diffLikeChars += chars
  }
  if (kinds.hasLargeResultRef) bucket.largeResultRefs += 1
  if (kinds.hasConversationHistoryRef) bucket.conversationHistoryRefs += 1
  map.set(name, bucket)
}

function addRole(roleMap, role, chars) {
  const key = role || "unknown"
  const bucket = roleMap.get(key) ?? { count: 0, chars: 0, approxTokens: 0 }
  bucket.count += 1
  bucket.chars += chars
  bucket.approxTokens = Math.round(bucket.chars / 4)
  roleMap.set(key, bucket)
}

function topMap(map, top, sortKey = "chars") {
  return [...map.entries()]
    .map(([name, stats]) => ({ name, ...stats }))
    .sort((a, b) => (b[sortKey] ?? 0) - (a[sortKey] ?? 0))
    .slice(0, top)
}

function pct(value, total) {
  if (!total) return 0
  return Number(((value / total) * 100).toFixed(2))
}

function sumMapField(map, field) {
  let sum = 0
  for (const value of map.values()) sum += value[field] ?? 0
  return sum
}

function parentToolName(trace, node) {
  if (!node || !Array.isArray(trace.nodes)) return "unknown"
  const parent = trace.nodes.find((candidate) => candidate && candidate.id === node.parentId)
  return parent?.name || "unknown"
}

function analyzeTrace(trace, result, options) {
  result.traces += 1

  const modelCalls = Array.isArray(trace.modelCalls) ? trace.modelCalls : []
  for (const call of modelCalls) {
    result.modelCalls += 1
    const usage = call?.tokenUsage ?? {}
    if (
      usage.inputTokens !== undefined ||
      usage.outputTokens !== undefined ||
      usage.totalTokens !== undefined
    ) {
      result.callsWithUsage += 1
      result.providerTokenUsage.inputTokens += Number(usage.inputTokens ?? 0)
      result.providerTokenUsage.outputTokens += Number(usage.outputTokens ?? 0)
      result.providerTokenUsage.totalTokens += Number(usage.totalTokens ?? 0)
      result.providerTokenUsage.cacheReadTokens += Number(usage.cacheReadTokens ?? 0)
      result.providerTokenUsage.cacheCreationTokens += Number(usage.cacheCreationTokens ?? 0)
    }

    const inputMessages = Array.isArray(call?.inputMessages) ? call.inputMessages : []
    for (const msg of inputMessages) {
      const text = safeText(msg?.content)
      const chars = text.length
      result.estimatedInput.chars += chars
      addRole(result.roleInput, msg?.role, chars)
      const kinds = detectContentKinds(text, options)
      if (msg?.role === "tool") {
        addToMap(result.toolInputByName, msg?.name, chars, kinds)
      }
      if (kinds.hasConversationHistoryRef) result.estimatedInput.conversationHistoryRefs += 1
    }
  }

  const nodes = Array.isArray(trace.nodes) ? trace.nodes : []
  for (const node of nodes) {
    if (node?.type !== "tool_result") continue
    const text = safeText(node.output)
    const kinds = detectContentKinds(text, options)
    addToMap(result.toolResultByName, parentToolName(trace, node), text.length, kinds)
  }

  // Legacy fallback for older traces without nodes/modelCalls.
  const steps = Array.isArray(trace.steps) ? trace.steps : []
  for (const step of steps) {
    const toolCalls = Array.isArray(step?.toolCalls) ? step.toolCalls : []
    for (const toolCall of toolCalls) {
      if (toolCall?.result === undefined) continue
      const text = safeText(toolCall.result)
      const kinds = detectContentKinds(text, options)
      addToMap(result.legacyStepResultsByName, toolCall.name, text.length, kinds)
    }
  }
}

function createResult(root, files) {
  return {
    traceRoot: root,
    files,
    traces: 0,
    parseErrors: 0,
    modelCalls: 0,
    callsWithUsage: 0,
    providerTokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0
    },
    estimatedInput: {
      chars: 0,
      approxTokens: 0,
      conversationHistoryRefs: 0
    },
    roleInput: new Map(),
    toolInputByName: new Map(),
    toolResultByName: new Map(),
    legacyStepResultsByName: new Map()
  }
}

function finalizeResult(result, top) {
  result.estimatedInput.approxTokens = Math.round(result.estimatedInput.chars / 4)

  const toolInputChars = sumMapField(result.toolInputByName, "chars")
  const toolInputLargeJsonChars = sumMapField(result.toolInputByName, "largeJsonChars")
  const toolInputLogChars = sumMapField(result.toolInputByName, "logLikeChars")
  const toolInputSearchChars = sumMapField(result.toolInputByName, "searchLikeChars")
  const toolInputDiffChars = sumMapField(result.toolInputByName, "diffLikeChars")

  const toolResultChars = sumMapField(result.toolResultByName, "chars")
  const toolResultLargeJsonChars = sumMapField(result.toolResultByName, "largeJsonChars")
  const toolResultLogChars = sumMapField(result.toolResultByName, "logLikeChars")

  const plain = {
    traceRoot: result.traceRoot,
    files: result.files,
    traces: result.traces,
    parseErrors: result.parseErrors,
    modelCalls: result.modelCalls,
    callsWithUsage: result.callsWithUsage,
    providerTokenUsage: result.providerTokenUsage,
    estimatedInput: {
      ...result.estimatedInput,
      toolChars: toolInputChars,
      toolApproxTokens: Math.round(toolInputChars / 4),
      toolPctByChars: pct(toolInputChars, result.estimatedInput.chars),
      toolLargeJsonChars: toolInputLargeJsonChars,
      toolLargeJsonApproxTokens: Math.round(toolInputLargeJsonChars / 4),
      toolLargeJsonPctOfInputChars: pct(toolInputLargeJsonChars, result.estimatedInput.chars),
      toolLargeJsonPctOfToolChars: pct(toolInputLargeJsonChars, toolInputChars),
      toolLogLikeChars: toolInputLogChars,
      toolLogLikeApproxTokens: Math.round(toolInputLogChars / 4),
      toolLogLikePctOfInputChars: pct(toolInputLogChars, result.estimatedInput.chars),
      toolLogLikePctOfToolChars: pct(toolInputLogChars, toolInputChars),
      toolSearchLikeChars: toolInputSearchChars,
      toolSearchLikePctOfToolChars: pct(toolInputSearchChars, toolInputChars),
      toolDiffLikeChars: toolInputDiffChars,
      toolDiffLikePctOfToolChars: pct(toolInputDiffChars, toolInputChars)
    },
    toolResults: {
      chars: toolResultChars,
      approxTokens: Math.round(toolResultChars / 4),
      largeJsonChars: toolResultLargeJsonChars,
      largeJsonPctOfToolResultChars: pct(toolResultLargeJsonChars, toolResultChars),
      logLikeChars: toolResultLogChars,
      logLikePctOfToolResultChars: pct(toolResultLogChars, toolResultChars)
    },
    topRoleInput: topMap(result.roleInput, top),
    topToolInputByChars: topMap(result.toolInputByName, top),
    topToolInputByLargeJsonChars: topMap(result.toolInputByName, top, "largeJsonChars").filter(
      (item) => item.largeJsonChars > 0
    ),
    topToolInputByLogLikeChars: topMap(result.toolInputByName, top, "logLikeChars").filter(
      (item) => item.logLikeChars > 0
    ),
    topToolResultByChars: topMap(result.toolResultByName, top),
    topToolResultByLargeJsonChars: topMap(
      result.toolResultByName,
      top,
      "largeJsonChars"
    ).filter((item) => item.largeJsonChars > 0),
    topToolResultByLogLikeChars: topMap(result.toolResultByName, top, "logLikeChars").filter(
      (item) => item.logLikeChars > 0
    ),
    largeResultRefsByTool: topMap(result.toolResultByName, top, "largeResultRefs").filter(
      (item) => item.largeResultRefs > 0
    ),
    conversationHistoryRefsByToolInput: topMap(
      result.toolInputByName,
      top,
      "conversationHistoryRefs"
    ).filter((item) => item.conversationHistoryRefs > 0),
    legacyStepResultsByChars: topMap(result.legacyStepResultsByName, top)
  }

  return plain
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value)
}

function markdownTable(rows, columns) {
  if (rows.length === 0) return "_None._\n"
  const header = `| ${columns.map((column) => column.label).join(" | ")} |`
  const divider = `| ${columns.map(() => "---").join(" | ")} |`
  const body = rows.map((row) => {
    return `| ${columns
      .map((column) => {
        const value = column.value(row)
        return typeof value === "number" ? formatNumber(value) : String(value)
      })
      .join(" | ")} |`
  })
  return [header, divider, ...body].join("\n") + "\n"
}

function renderMarkdown(summary) {
  const lines = []
  lines.push("# Trace Compression Opportunity Report", "")
  lines.push(`Trace root: \`${summary.traceRoot}\``, "")
  lines.push("## Summary", "")
  lines.push(
    markdownTable(
      [
        ["Files", summary.files],
        ["Traces", summary.traces],
        ["Parse errors", summary.parseErrors],
        ["Model calls", summary.modelCalls],
        ["Model calls with usage", summary.callsWithUsage],
        ["Provider input tokens", summary.providerTokenUsage.inputTokens],
        ["Provider output tokens", summary.providerTokenUsage.outputTokens],
        ["Provider total tokens", summary.providerTokenUsage.totalTokens],
        ["Estimated input chars", summary.estimatedInput.chars],
        ["Estimated input approx tokens", summary.estimatedInput.approxTokens],
        ["Tool input chars", summary.estimatedInput.toolChars],
        ["Tool input pct by chars", `${summary.estimatedInput.toolPctByChars}%`],
        ["Tool large JSON chars", summary.estimatedInput.toolLargeJsonChars],
        ["Tool large JSON pct of input", `${summary.estimatedInput.toolLargeJsonPctOfInputChars}%`],
        ["Tool log-like chars", summary.estimatedInput.toolLogLikeChars],
        ["Tool log-like pct of input", `${summary.estimatedInput.toolLogLikePctOfInputChars}%`],
        ["Tool result chars", summary.toolResults.chars],
        ["Large result refs", summary.largeResultRefsByTool.reduce((sum, row) => sum + row.largeResultRefs, 0)],
        ["Conversation history refs", summary.estimatedInput.conversationHistoryRefs]
      ].map(([metric, value]) => ({ metric, value })),
      [
        { label: "Metric", value: (row) => row.metric },
        { label: "Value", value: (row) => row.value }
      ]
    )
  )

  lines.push("## Top Tool Inputs By Chars", "")
  lines.push(
    markdownTable(summary.topToolInputByChars, [
      { label: "Tool", value: (row) => row.name },
      { label: "Messages", value: (row) => row.count },
      { label: "Chars", value: (row) => row.chars },
      { label: "Approx Tokens", value: (row) => row.approxTokens },
      { label: "Log Chars", value: (row) => row.logLikeChars },
      { label: "Large JSON Chars", value: (row) => row.largeJsonChars },
      { label: "Large Refs", value: (row) => row.largeResultRefs }
    ])
  )

  lines.push("## Top Tool Inputs By Log-Like Chars", "")
  lines.push(
    markdownTable(summary.topToolInputByLogLikeChars, [
      { label: "Tool", value: (row) => row.name },
      { label: "Messages", value: (row) => row.logLikeCount },
      { label: "Log Chars", value: (row) => row.logLikeChars },
      { label: "All Chars", value: (row) => row.chars }
    ])
  )

  lines.push("## Top Tool Inputs By Large JSON Chars", "")
  lines.push(
    markdownTable(summary.topToolInputByLargeJsonChars, [
      { label: "Tool", value: (row) => row.name },
      { label: "Messages", value: (row) => row.largeJsonCount },
      { label: "Large JSON Chars", value: (row) => row.largeJsonChars },
      { label: "All Chars", value: (row) => row.chars }
    ])
  )

  lines.push("## Top Tool Results By Chars", "")
  lines.push(
    markdownTable(summary.topToolResultByChars, [
      { label: "Tool", value: (row) => row.name },
      { label: "Results", value: (row) => row.count },
      { label: "Chars", value: (row) => row.chars },
      { label: "Approx Tokens", value: (row) => row.approxTokens },
      { label: "Log Chars", value: (row) => row.logLikeChars },
      { label: "Large JSON Chars", value: (row) => row.largeJsonChars },
      { label: "Large Refs", value: (row) => row.largeResultRefs }
    ])
  )

  lines.push("## Large Result References By Tool", "")
  lines.push(
    markdownTable(summary.largeResultRefsByTool, [
      { label: "Tool", value: (row) => row.name },
      { label: "Refs", value: (row) => row.largeResultRefs },
      { label: "Chars", value: (row) => row.chars }
    ])
  )

  if (summary.legacyStepResultsByChars.length > 0) {
    lines.push("## Legacy Step Results By Chars", "")
    lines.push(
      markdownTable(summary.legacyStepResultsByChars, [
        { label: "Tool", value: (row) => row.name },
        { label: "Results", value: (row) => row.count },
        { label: "Chars", value: (row) => row.chars }
      ])
    )
  }

  lines.push("## Reading The Numbers", "")
  lines.push("- Large JSON pct > 10% suggests a SmartCrusher-style JSON spike may be worthwhile.")
  lines.push("- Log-like pct > 20% suggests an execute/task_output log compressor spike may be worthwhile.")
  lines.push("- Many large result refs suggest improving reversible retrieval/search UX may be worthwhile.")
  lines.push("- Percentages are char-based estimates. Provider token usage is reported separately when traces contain usage metadata.")

  return lines.join("\n")
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(usage())
    return
  }

  const root = path.resolve(args.dir ?? defaultTraceDir())
  const files = walkFiles(root)
  const result = createResult(root, files.length)
  const detectorOptions = {
    minJsonItems: args.minJsonItems,
    homogeneousRatio: args.homogeneousRatio
  }

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8")
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        analyzeTrace(JSON.parse(line), result, detectorOptions)
      } catch {
        result.parseErrors += 1
      }
    }
  }

  const summary = finalizeResult(result, args.top)
  if (args.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  } else {
    process.stdout.write(`${renderMarkdown(summary)}\n`)
  }
}

try {
  main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`)
  process.stderr.write(usage())
  process.exitCode = 1
}
