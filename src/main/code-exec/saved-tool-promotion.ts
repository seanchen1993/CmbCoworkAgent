import {
  buildSavedCodeExecResultExample,
  inferSavedCodeExecSchema,
  parseCodeExecOutputValue
} from "./saved-tool-store"

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/

type SourceKind = "params" | "mcp_result"

interface ParamUsageState {
  optional: boolean
}

interface ExpressionAnalysis {
  ok: boolean
  objectLike: boolean
  paramUsage: Map<string, ParamUsageState>
  sourceKinds: Set<SourceKind>
}

interface McpCallAnalysis {
  dependency: string
  ok: boolean
}

export interface SavedToolPromotionReady {
  status: "ready"
  dependencies: string[]
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
  resultExample: unknown
}

export interface SavedToolPromotionBlocked {
  status: "blocked"
  dependencies: string[]
}

export type SavedToolPromotionResult = SavedToolPromotionReady | SavedToolPromotionBlocked

function mergeParamUsage(
  target: Map<string, ParamUsageState>,
  incoming: Map<string, ParamUsageState>
): void {
  for (const [key, value] of incoming) {
    const existing = target.get(key)
    if (!existing) {
      target.set(key, { optional: value.optional })
      continue
    }

    existing.optional = existing.optional && value.optional
  }
}

function cloneParamUsage(input: Map<string, ParamUsageState>): Map<string, ParamUsageState> {
  return new Map(Array.from(input.entries()).map(([key, value]) => [key, { optional: value.optional }]))
}

function createAnalysis(params: Array<{ key: string; optional: boolean }>, objectLike: boolean): ExpressionAnalysis {
  const paramUsage = new Map<string, ParamUsageState>()
  for (const param of params) {
    const existing = paramUsage.get(param.key)
    if (!existing) {
      paramUsage.set(param.key, { optional: param.optional })
      continue
    }
    existing.optional = existing.optional && param.optional
  }

  return {
    ok: true,
    objectLike,
    paramUsage,
    sourceKinds: new Set(params.length > 0 ? ["params"] : [])
  }
}

function blockedAnalysis(): ExpressionAnalysis {
  return {
    ok: false,
    objectLike: false,
    paramUsage: new Map(),
    sourceKinds: new Set()
  }
}

function createSourceAnalysis(sourceKinds: SourceKind[], objectLike = false): ExpressionAnalysis {
  return {
    ok: true,
    objectLike,
    paramUsage: new Map(),
    sourceKinds: new Set(sourceKinds)
  }
}

function maskStringsAndComments(source: string): string {
  const chars = source.split("")
  let index = 0

  while (index < chars.length) {
    const current = chars[index]
    const next = chars[index + 1] ?? ""

    if (current === "'" || current === "\"" || current === "`") {
      const quote = current
      index += 1
      while (index < chars.length) {
        if (chars[index] === "\\") {
          chars[index] = " "
          index += 1
          if (index < chars.length) chars[index] = " "
          index += 1
          continue
        }

        const char = chars[index]
        chars[index] = " "
        index += 1
        if (char === quote) break
      }
      continue
    }

    if (current === "/" && next === "/") {
      chars[index] = " "
      chars[index + 1] = " "
      index += 2
      while (index < chars.length && chars[index] !== "\n") {
        chars[index] = " "
        index += 1
      }
      continue
    }

    if (current === "/" && next === "*") {
      chars[index] = " "
      chars[index + 1] = " "
      index += 2
      while (index < chars.length) {
        const char = chars[index]
        const lookahead = chars[index + 1] ?? ""
        chars[index] = " "
        if (char === "*" && lookahead === "/") {
          if (index + 1 < chars.length) chars[index + 1] = " "
          index += 2
          break
        }
        index += 1
      }
      continue
    }

    index += 1
  }

  return chars.join("")
}

function findMatchingBracket(source: string, openIndex: number, openChar: string, closeChar: string): number {
  let depth = 0
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index]
    if (char === openChar) depth += 1
    else if (char === closeChar) {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function splitTopLevel(expression: string, delimiter: string): string[] {
  const masked = maskStringsAndComments(expression)
  const parts: string[] = []
  let depthParen = 0
  let depthBrace = 0
  let depthBracket = 0
  let start = 0

  for (let index = 0; index < masked.length; index += 1) {
    const char = masked[index]
    if (char === "(") depthParen += 1
    else if (char === ")") depthParen -= 1
    else if (char === "{") depthBrace += 1
    else if (char === "}") depthBrace -= 1
    else if (char === "[") depthBracket += 1
    else if (char === "]") depthBracket -= 1
    else if (char === delimiter && depthParen === 0 && depthBrace === 0 && depthBracket === 0) {
      parts.push(expression.slice(start, index))
      start = index + 1
    }
  }

  parts.push(expression.slice(start))
  return parts
}

function stripWrappingParens(expression: string): string {
  let result = expression.trim()
  while (result.startsWith("(") && result.endsWith(")")) {
    const endIndex = findMatchingBracket(result, 0, "(", ")")
    if (endIndex !== result.length - 1) break
    result = result.slice(1, -1).trim()
  }
  return result
}

function isPrimitiveLiteral(expression: string): boolean {
  const trimmed = expression.trim()
  if (!trimmed) return false
  if (trimmed === "true" || trimmed === "false" || trimmed === "null") return true
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return true
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return true
  }
  return false
}

function parseDirectParamReference(expression: string): { key: string; optional: boolean } | null {
  const trimmed = stripWrappingParens(expression)
  if (trimmed.includes("??")) {
    const operatorIndex = trimmed.indexOf("??")
    const left = trimmed.slice(0, operatorIndex).trim()
    const right = trimmed.slice(operatorIndex + 2).trim()
    const direct = parseDirectParamReference(left)
    if (direct && isPrimitiveLiteral(right)) {
      return { key: direct.key, optional: true }
    }
    return null
  }

  const dotMatch = trimmed.match(/^params\.([A-Za-z_$][A-Za-z0-9_$]*)$/)
  if (dotMatch) {
    return {
      key: dotMatch[1],
      optional: false
    }
  }

  const bracketMatch = trimmed.match(/^params\[\s*(['"])([^"'\\]+)\1\s*\]$/)
  if (bracketMatch) {
    return {
      key: bracketMatch[2],
      optional: false
    }
  }

  return null
}

function parseStringLiteral(expression: string): string | null {
  const trimmed = stripWrappingParens(expression)
  const quotedMatch = trimmed.match(/^(['"])([^"'\\]+)\1$/)
  return quotedMatch ? quotedMatch[2] : null
}

function parseObjectProperty(propertySource: string): { key: string; valueExpression: string } | null {
  const trimmed = propertySource.trim()
  if (!trimmed || trimmed.startsWith("...")) return null

  const colonIndex = (() => {
    const masked = maskStringsAndComments(trimmed)
    let depthParen = 0
    let depthBrace = 0
    let depthBracket = 0
    for (let index = 0; index < masked.length; index += 1) {
      const char = masked[index]
      if (char === "(") depthParen += 1
      else if (char === ")") depthParen -= 1
      else if (char === "{") depthBrace += 1
      else if (char === "}") depthBrace -= 1
      else if (char === "[") depthBracket += 1
      else if (char === "]") depthBracket -= 1
      else if (char === ":" && depthParen === 0 && depthBrace === 0 && depthBracket === 0) {
        return index
      }
    }
    return -1
  })()

  if (colonIndex < 0) {
    if (!IDENTIFIER_RE.test(trimmed)) return null
    return {
      key: trimmed,
      valueExpression: trimmed
    }
  }

  const rawKey = trimmed.slice(0, colonIndex).trim()
  const valueExpression = trimmed.slice(colonIndex + 1).trim()
  if (!valueExpression) return null
  if (rawKey.startsWith("[")) return null

  if (IDENTIFIER_RE.test(rawKey)) {
    return { key: rawKey, valueExpression }
  }

  const quotedMatch = rawKey.match(/^(['"])([^"'\\]+)\1$/)
  if (quotedMatch) {
    return { key: quotedMatch[2], valueExpression }
  }

  return null
}

function mergeExpressionAnalyses(values: ExpressionAnalysis[], objectLike: boolean): ExpressionAnalysis {
  const merged = createSourceAnalysis([], objectLike)
  for (const value of values) {
    mergeParamUsage(merged.paramUsage, value.paramUsage)
    for (const sourceKind of value.sourceKinds) {
      merged.sourceKinds.add(sourceKind)
    }
  }
  return merged
}

function parseMemberAccessExpression(
  expression: string
): { root: string; end: number } | null {
  const trimmed = stripWrappingParens(expression)
  if (!trimmed) return null

  let index = 0
  const root = readIdentifier(trimmed, index)
  if (!root) return null
  index = root.end

  while (index < trimmed.length) {
    while (/\s/.test(trimmed[index] ?? "")) index += 1

    if (trimmed[index] === ".") {
      index += 1
      while (/\s/.test(trimmed[index] ?? "")) index += 1
      const property = readIdentifier(trimmed, index)
      if (!property) return null
      index = property.end
      continue
    }

    if (trimmed[index] === "[") {
      const closeIndex = findMatchingBracket(trimmed, index, "[", "]")
      if (closeIndex < 0) return null
      const content = trimmed.slice(index + 1, closeIndex).trim()
      if (!content) return null

      const isNumericIndex = /^\d+$/.test(content)
      const isQuotedKey = /^(['"])([^"'\\]+)\1$/.test(content)
      if (!isNumericIndex && !isQuotedKey) return null

      index = closeIndex + 1
      continue
    }

    break
  }

  return {
    root: root.value,
    end: index
  }
}

function analyzeAwaitMcpCallExpression(
  expression: string,
  env: Map<string, ExpressionAnalysis>
): ExpressionAnalysis | null {
  const trimmed = stripWrappingParens(expression)
  if (!trimmed.startsWith("await ")) return null

  const masked = maskStringsAndComments(trimmed)
  const startIndex = 6
  if (!masked.startsWith("mcp.$call", startIndex)) return null

  let cursor = startIndex + "mcp.$call".length
  while (/\s/.test(masked[cursor] ?? "")) cursor += 1
  if (masked[cursor] !== "(") return null

  const closeIndex = findMatchingBracket(masked, cursor, "(", ")")
  if (closeIndex < 0) return null

  const trailing = trimmed.slice(closeIndex + 1).trim()
  if (trailing) return null

  const argsSource = trimmed.slice(cursor + 1, closeIndex).trim()
  const args = splitTopLevel(argsSource, ",").map((item) => item.trim()).filter(Boolean)
  if (args.length === 0 || args.length > 2) return null
  if (!parseStringLiteral(args[0])) return null
  if (args.length === 1) return createSourceAnalysis(["mcp_result"])

  const argAnalysis = analyzeExpression(args[1], env, true)
  if (!argAnalysis.ok) return null

  return createSourceAnalysis(["mcp_result"])
}

function analyzeExpression(
  expression: string,
  env: Map<string, ExpressionAnalysis>,
  requireObject = false
): ExpressionAnalysis {
  const trimmed = stripWrappingParens(expression)
  if (!trimmed) {
    return requireObject ? blockedAnalysis() : createAnalysis([], false)
  }

  const directParam = parseDirectParamReference(trimmed)
  if (directParam) {
    if (requireObject) return blockedAnalysis()
    return createAnalysis([directParam], false)
  }

  const awaitedMcpResult = analyzeAwaitMcpCallExpression(trimmed, env)
  if (awaitedMcpResult) {
    if (requireObject) return blockedAnalysis()
    return awaitedMcpResult
  }

  if (IDENTIFIER_RE.test(trimmed)) {
    const resolved = env.get(trimmed)
    if (!resolved) return blockedAnalysis()
    if (requireObject && !resolved.objectLike) return blockedAnalysis()
    return {
      ok: resolved.ok,
      objectLike: resolved.objectLike,
      paramUsage: cloneParamUsage(resolved.paramUsage),
      sourceKinds: new Set(resolved.sourceKinds)
    }
  }

  const memberAccess = parseMemberAccessExpression(trimmed)
  if (memberAccess && memberAccess.end === trimmed.length) {
    const resolvedRoot = env.get(memberAccess.root)
    if (!resolvedRoot || !resolvedRoot.sourceKinds.has("mcp_result")) {
      return blockedAnalysis()
    }
    if (requireObject) return blockedAnalysis()

    return {
      ok: true,
      objectLike: false,
      paramUsage: cloneParamUsage(resolvedRoot.paramUsage),
      sourceKinds: new Set(["mcp_result"])
    }
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const content = trimmed.slice(1, -1)
    const analyses: ExpressionAnalysis[] = []
    const properties = splitTopLevel(content, ",").map((item) => item.trim()).filter(Boolean)
    for (const property of properties) {
      const parsed = parseObjectProperty(property)
      if (!parsed) return blockedAnalysis()
      const valueAnalysis = analyzeExpression(parsed.valueExpression, env)
      if (!valueAnalysis.ok) return blockedAnalysis()
      analyses.push(valueAnalysis)
    }
    return mergeExpressionAnalyses(analyses, true)
  }

  return blockedAnalysis()
}

function parseTopLevelAssignments(code: string): Map<string, ExpressionAnalysis> {
  const env = new Map<string, ExpressionAnalysis>()
  for (const statement of splitTopLevel(code, ";")) {
    const trimmed = statement.trim()
    if (!trimmed) continue

    const match = trimmed.match(/^(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*([\s\S]+)$/)
    if (!match) continue

    const variableName = match[1]
    const expression = match[2].trim()
    const analysis = analyzeExpression(expression, env)
    if (analysis.ok) {
      env.set(variableName, analysis)
    }
  }
  return env
}

function readIdentifier(source: string, start: number): { value: string; end: number } | null {
  let index = start
  if (!/[A-Za-z_$]/.test(source[index] ?? "")) return null
  index += 1
  while (/[A-Za-z0-9_$]/.test(source[index] ?? "")) {
    index += 1
  }
  return {
    value: source.slice(start, index),
    end: index
  }
}

function isVariableReference(expression: string): boolean {
  return IDENTIFIER_RE.test(stripWrappingParens(expression))
}

function scanMcpCalls(code: string, env: Map<string, ExpressionAnalysis>): McpCallAnalysis[] {
  const masked = maskStringsAndComments(code)
  const results: McpCallAnalysis[] = []

  for (let index = 0; index < masked.length; index += 1) {
    if (!masked.startsWith("mcp.$call", index)) continue
    const previous = masked[index - 1] ?? ""
    if (/[A-Za-z0-9_$]/.test(previous)) continue

    let cursor = index + "mcp.$call".length
    while (/\s/.test(masked[cursor] ?? "")) cursor += 1
    if (masked[cursor] !== "(") {
      results.push({ dependency: "unknown", ok: false })
      continue
    }

    const closeIndex = findMatchingBracket(masked, cursor, "(", ")")
    if (closeIndex < 0) {
      results.push({ dependency: "unknown", ok: false })
      continue
    }

    const argsSource = code.slice(cursor + 1, closeIndex).trim()
    const args = splitTopLevel(argsSource, ",").map((item) => item.trim()).filter(Boolean)
    if (args.length === 0 || args.length > 2) {
      results.push({ dependency: "unknown", ok: false })
      index = closeIndex
      continue
    }

    const dependency = parseStringLiteral(args[0]) ?? "unknown"
    if (args.length === 1) {
      results.push({ dependency, ok: dependency !== "unknown" })
      index = closeIndex
      continue
    }

    const argAnalysis = analyzeExpression(args[1], env, true)
    results.push({ dependency, ok: dependency !== "unknown" && (argAnalysis.ok || isVariableReference(args[1])) })
    index = closeIndex
  }

  return results
}

function buildInputSchema(
  params: Record<string, unknown> | undefined,
  usage: Map<string, ParamUsageState>
): Record<string, unknown> {
  const sortedEntries = Array.from(usage.entries()).sort(([left], [right]) => left.localeCompare(right))
  const properties = Object.fromEntries(
    sortedEntries.map(([key]) => [key, inferSavedCodeExecSchema(params?.[key])])
  )
  const required = sortedEntries
    .filter(([, value]) => !value.optional)
    .map(([key]) => key)

  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {})
  }
}

function collectParamUsageFromCode(code: string): Map<string, ParamUsageState> {
  const usage = new Map<string, ParamUsageState>()

  const applyMatch = (key: string, optional: boolean): void => {
    const existing = usage.get(key)
    if (!existing) {
      usage.set(key, { optional })
      return
    }
    existing.optional = existing.optional && optional
  }

  const dotPattern = /params\.([A-Za-z_$][A-Za-z0-9_$]*)(\s*\?\?)?/g
  const bracketPattern = /params\[\s*(['"])([^"'\\]+)\1\s*\](\s*\?\?)?/g

  let dotMatch: RegExpExecArray | null
  while ((dotMatch = dotPattern.exec(code)) !== null) {
    applyMatch(dotMatch[1], Boolean(dotMatch[2]))
  }

  let bracketMatch: RegExpExecArray | null
  while ((bracketMatch = bracketPattern.exec(code)) !== null) {
    applyMatch(bracketMatch[2], Boolean(bracketMatch[3]))
  }

  return usage
}

export function analyzeCodeExecForSavedToolPromotion(input: {
  code: string
  params?: Record<string, unknown>
  output: string
}): SavedToolPromotionResult {
  const env = parseTopLevelAssignments(input.code)
  const calls = scanMcpCalls(input.code, env)
  const paramUsage = collectParamUsageFromCode(input.code)
  const dependencies = Array.from(new Set(calls.map((call) => call.dependency).filter(Boolean)))

  if (paramUsage.size === 0 || calls.some((call) => !call.ok)) {
    return {
      status: "blocked",
      dependencies
    }
  }

  const outputValue = parseCodeExecOutputValue(input.output)

  return {
    status: "ready",
    dependencies,
    inputSchema: buildInputSchema(input.params, paramUsage),
    outputSchema: inferSavedCodeExecSchema(outputValue),
    resultExample: buildSavedCodeExecResultExample(outputValue)
  }
}
