import { parse, type Node } from "acorn"
import { z } from "zod"
import { WorkflowScriptError, type ParsedWorkflowScript, type WorkflowMeta } from "./types"

/**
 * Workflow script validation.
 *
 * A valid script starts with `export const meta = {…}` where the initializer
 * is a pure literal (no variables, calls, spreads, or template interpolation).
 * The remainder of the source is the script body executed inside the sandbox.
 *
 * The backing models are mid-tier, so validation is forgiving about common
 * slips (markdown fences, a missing `export` keyword) while staying strict
 * about everything that matters for deterministic resume.
 */

const META_REQUIREMENT =
  "`export const meta = { name, description, phases }` must be the FIRST statement in the script"

/**
 * Pre-parse size cap (512 KiB), matching Claude Code's documented limit. acorn's
 * parse runs synchronously on the Electron main process, so an oversized script
 * would block the event loop and freeze the UI — reject by byte length first.
 */
export const MAX_WORKFLOW_SCRIPT_BYTES = 524_288

const workflowMetaSchema = z
  .object({
    name: z.string().trim().min(1, "meta.name must be a non-empty string").max(120),
    description: z.string().trim().min(1, "meta.description must be a non-empty string").max(500),
    title: z.string().trim().max(200).optional(),
    whenToUse: z.string().trim().max(500).optional(),
    phases: z
      .array(
        z.object({
          title: z.string().trim().min(1, "phase title must be a non-empty string").max(120),
          detail: z.string().trim().max(300).optional(),
          model: z.string().trim().max(120).optional()
        })
      )
      .max(50)
      .optional()
  })
  .passthrough()

interface AcornNode extends Node {
  type: string
  [key: string]: unknown
}

/** Strips a wrapping markdown code fence the model may have left around the script. */
export function stripMarkdownFence(source: string): string {
  const trimmed = source.trim()
  const fenceMatch = trimmed.match(/^```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n?```$/)
  return fenceMatch ? fenceMatch[1] : source
}

/**
 * Evaluates an AST node that must be a pure literal. Throws on anything
 * computed (identifiers, calls, spreads, template interpolation, …).
 */
function evaluatePureLiteral(node: AcornNode): unknown {
  switch (node.type) {
    case "Literal": {
      const value = (node as { value?: unknown }).value
      if (
        value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        return value
      }
      throw new WorkflowScriptError(`unsupported literal kind: ${String(value)}`)
    }
    case "TemplateLiteral": {
      const expressions = node.expressions as AcornNode[]
      if (expressions.length > 0) {
        throw new WorkflowScriptError("template literals with ${…} interpolation are not allowed")
      }
      const quasis = node.quasis as Array<{ value: { cooked?: string; raw: string } }>
      return quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join("")
    }
    case "UnaryExpression": {
      const operator = node.operator as string
      const argument = evaluatePureLiteral(node.argument as AcornNode)
      if (typeof argument !== "number") {
        throw new WorkflowScriptError(`unary ${operator} on a non-number value`)
      }
      if (operator === "-") return -argument
      if (operator === "+") return argument
      throw new WorkflowScriptError(`unsupported unary operator: ${operator}`)
    }
    case "ObjectExpression": {
      const result: Record<string, unknown> = {}
      for (const property of node.properties as AcornNode[]) {
        if (property.type !== "Property") {
          throw new WorkflowScriptError("spread properties are not allowed")
        }
        if (property.computed) {
          throw new WorkflowScriptError("computed object keys are not allowed")
        }
        const keyNode = property.key as AcornNode
        const key =
          keyNode.type === "Identifier"
            ? (keyNode.name as string)
            : keyNode.type === "Literal" && typeof keyNode.value === "string"
              ? keyNode.value
              : null
        if (key === null) {
          throw new WorkflowScriptError("object keys must be identifiers or string literals")
        }
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          throw new WorkflowScriptError(`reserved object key is not allowed: ${key}`)
        }
        result[key] = evaluatePureLiteral(property.value as AcornNode)
      }
      return result
    }
    case "ArrayExpression": {
      const elements = node.elements as Array<AcornNode | null>
      return elements.map((element) => {
        if (!element) throw new WorkflowScriptError("array holes are not allowed")
        if (element.type === "SpreadElement") {
          throw new WorkflowScriptError("spread elements are not allowed")
        }
        return evaluatePureLiteral(element)
      })
    }
    default:
      throw new WorkflowScriptError(
        `expression of type ${node.type} is not a pure literal (no variables, function calls, or spreads)`
      )
  }
}

function extractMetaDeclarator(statement: AcornNode): AcornNode | null {
  // Accept both `export const meta = …` and a bare `const meta = …` so a
  // model that forgets the `export` keyword still produces a runnable script.
  const declaration =
    statement.type === "ExportNamedDeclaration"
      ? (statement.declaration as AcornNode | null)
      : statement.type === "VariableDeclaration"
        ? statement
        : null
  if (!declaration || declaration.type !== "VariableDeclaration") return null
  if (declaration.kind !== "const") return null
  const declarators = declaration.declarations as AcornNode[]
  if (declarators.length !== 1) return null
  const declarator = declarators[0]
  const id = declarator.id as AcornNode
  if (id.type !== "Identifier" || id.name !== "meta") return null
  return declarator
}

/**
 * Parses and validates a workflow script. Returns the validated meta plus the
 * script body (source after the meta statement). Throws WorkflowScriptError
 * with a model-actionable message on any problem.
 */
export function validateWorkflowScript(source: string): ParsedWorkflowScript {
  // Reject oversized input BEFORE acorn parse (synchronous on the main process →
  // a huge script would freeze the UI). This is the common choke point for both
  // entry points — inline `script` and `scriptPath`-read files both funnel
  // through here — so one byte-length gate covers both.
  const sourceBytes = Buffer.byteLength(source, "utf8")
  if (sourceBytes > MAX_WORKFLOW_SCRIPT_BYTES) {
    throw new WorkflowScriptError(
      `workflow script is too large: ${sourceBytes} bytes exceeds the ${MAX_WORKFLOW_SCRIPT_BYTES}-byte (512 KiB) limit`
    )
  }
  const script = stripMarkdownFence(source)
  if (!script.trim()) {
    throw new WorkflowScriptError("workflow script is empty")
  }

  let program: AcornNode
  try {
    // Top-level return/await are legal in a workflow body — the runtime wraps
    // it in an async IIFE before execution.
    program = parse(script, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowHashBang: false
    }) as unknown as AcornNode
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // acorn's bare "(line:col)" is too thin for a model to act on — show the actual
    // offending line with the error position marked, plus a fix-and-retry hint, so the
    // model can SEE and correct the syntax instead of guessing from a column number.
    const loc = (error as { loc?: { line?: number; column?: number } }).loc
    let context = ""
    if (loc && typeof loc.line === "number") {
      const badLine = script.split("\n")[loc.line - 1]
      if (typeof badLine === "string") {
        const col = typeof loc.column === "number" ? loc.column : 0
        const start = Math.max(0, col - 50)
        const head = (start > 0 ? "…" : "") + badLine.slice(start, col)
        const tail = badLine.slice(col, col + 50) + (badLine.length > col + 50 ? "…" : "")
        context = `\n  at line ${loc.line}, col ${col}:  ${head}»HERE»${tail}`
      }
    }
    throw new WorkflowScriptError(
      `workflow script has a syntax error: ${message}.${context}\n  Fix this syntax error and call the workflow tool again with the corrected script.`
    )
  }

  const statements = program.body as AcornNode[]
  if (statements.length === 0) {
    throw new WorkflowScriptError(META_REQUIREMENT)
  }

  const metaStatement = statements[0]
  const declarator = extractMetaDeclarator(metaStatement)
  if (!declarator || !declarator.init) {
    throw new WorkflowScriptError(META_REQUIREMENT)
  }

  let metaValue: unknown
  try {
    metaValue = evaluatePureLiteral(declarator.init as AcornNode)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new WorkflowScriptError(`meta must be a pure literal: ${message}`)
  }

  const parsedMeta = workflowMetaSchema.safeParse(metaValue)
  if (!parsedMeta.success) {
    const issues = parsedMeta.error.issues
      .map((issue) => `${issue.path.join(".") || "meta"}: ${issue.message}`)
      .join("; ")
    throw new WorkflowScriptError(`invalid meta: ${issues}`)
  }

  for (const statement of statements.slice(1)) {
    if (
      statement.type === "ImportDeclaration" ||
      statement.type === "ExportNamedDeclaration" ||
      statement.type === "ExportDefaultDeclaration" ||
      statement.type === "ExportAllDeclaration"
    ) {
      throw new WorkflowScriptError(
        "import/export statements are not allowed in the script body — workflow scripts are " +
          "self-contained plain JavaScript using only the injected globals " +
          "(agent, parallel, pipeline, phase, log, args, budget, workflow)"
      )
    }
  }
  // Expression-form module access (`import("fs")`, `import.meta`) parses fine
  // as a module but would surface a cryptic V8 error inside the sandbox —
  // reject it here with the same actionable message.
  forEachAstNode(program, (node) => {
    if (node.type === "ImportExpression" || node.type === "MetaProperty") {
      throw new WorkflowScriptError(
        "dynamic import() and import.meta are not allowed — workflow scripts are self-contained " +
          "plain JavaScript using only the injected globals"
      )
    }
  })
  assertDeterministicAst(program)

  const body = script.slice(metaStatement.end as number).replace(/^[;\s]*/, "")
  return { meta: parsedMeta.data as WorkflowMeta, body }
}

type ScopeStack = Array<ReadonlySet<string>>

function assertDeterministicAst(program: AcornNode): void {
  visitScopedAst(program, [collectProgramScope(program)])
}

function visitScopedAst(node: AcornNode, scopes: ScopeStack): void {
  const blockedApi = blockedNondeterministicApi(node, scopes)
  if (blockedApi) {
    throw new WorkflowScriptError(
      `${blockedApi} is unavailable in workflow scripts (breaks resume). ` +
        "Pass timestamps/randomness in via args, or vary agent prompts/labels by index."
    )
  }

  if (isFunctionNode(node)) {
    visitFunctionAst(node, scopes)
    return
  }
  if (node.type === "ClassExpression" && node.id && (node.id as AcornNode).type === "Identifier") {
    visitAstChildren(node, [...scopes, new Set([(node.id as { name: string }).name])])
    return
  }
  if (node.type === "BlockStatement") {
    visitAstChildren(node, [...scopes, collectBlockScope(node)])
    return
  }
  if (node.type === "StaticBlock") {
    visitAstChildren(node, [...scopes, collectStaticBlockScope(node)])
    return
  }
  if (node.type === "CatchClause") {
    const catchScope = new Set<string>()
    if (node.param) addPatternNames(node.param as AcornNode, catchScope)
    visitAstChildren(node, [...scopes, catchScope])
    return
  }
  if (node.type === "ForStatement") {
    visitForStatementAst(node, scopes)
    return
  }
  if (node.type === "ForInStatement" || node.type === "ForOfStatement") {
    visitForInOfStatementAst(node, scopes)
    return
  }
  if (node.type === "SwitchStatement") {
    visitSwitchStatementAst(node, scopes)
    return
  }

  visitAstChildren(node, scopes)
}

function visitAstChildren(node: AcornNode, scopes: ScopeStack): void {
  const stack = astChildrenOf(node)
  while (stack.length > 0) {
    const child = stack.pop()!
    if (needsScopedVisit(child)) {
      visitScopedAst(child, scopes)
      continue
    }
    const blockedApi = blockedNondeterministicApi(child, scopes)
    if (blockedApi) {
      throw new WorkflowScriptError(
        `${blockedApi} is unavailable in workflow scripts (breaks resume). ` +
          "Pass timestamps/randomness in via args, or vary agent prompts/labels by index."
      )
    }
    pushAstChildren(stack, child)
  }
}

function needsScopedVisit(node: AcornNode): boolean {
  return (
    isFunctionNode(node) ||
    (node.type === "ClassExpression" && Boolean(node.id)) ||
    node.type === "BlockStatement" ||
    node.type === "StaticBlock" ||
    node.type === "CatchClause" ||
    node.type === "ForStatement" ||
    node.type === "ForInStatement" ||
    node.type === "ForOfStatement" ||
    node.type === "SwitchStatement"
  )
}

function astChildrenOf(node: AcornNode): AcornNode[] {
  const children: AcornNode[] = []
  pushAstChildren(children, node)
  return children
}

function pushAstChildren(stack: AcornNode[], node: AcornNode): void {
  const values = Object.values(node)
  for (let i = values.length - 1; i >= 0; i--) {
    const value = values[i]
    if (Array.isArray(value)) {
      for (let j = value.length - 1; j >= 0; j--) {
        const item = value[j]
        if (item && typeof item === "object" && typeof (item as AcornNode).type === "string") {
          stack.push(item as AcornNode)
        }
      }
    } else if (
      value &&
      typeof value === "object" &&
      typeof (value as AcornNode).type === "string"
    ) {
      stack.push(value as AcornNode)
    }
  }
}

function visitFunctionAst(node: AcornNode, scopes: ScopeStack): void {
  const functionNameScope = collectFunctionNameScope(node)
  const paramScope = new Set(functionNameScope)
  for (const param of (node.params ?? []) as AcornNode[]) addPatternNames(param, paramScope)
  const paramScopes = [...scopes, paramScope]
  for (const param of (node.params ?? []) as AcornNode[]) visitScopedAst(param, paramScopes)

  const body = node.body as AcornNode | undefined
  if (!body) return
  const bodyScope = new Set(paramScope)
  collectFunctionScopedVarNames(body, bodyScope)
  if (body.type === "BlockStatement") {
    collectDirectLexicalNames((body.body ?? []) as AcornNode[], bodyScope)
  }
  visitScopedAst(body, [...scopes, bodyScope])
}

function visitForStatementAst(node: AcornNode, scopes: ScopeStack): void {
  const forScope = collectForHeadScope(node.init as AcornNode | null | undefined)
  const loopScopes = forScope.size > 0 ? [...scopes, forScope] : scopes
  if (node.init) visitScopedAst(node.init as AcornNode, loopScopes)
  if (node.test) visitScopedAst(node.test as AcornNode, loopScopes)
  if (node.update) visitScopedAst(node.update as AcornNode, loopScopes)
  if (node.body) visitScopedAst(node.body as AcornNode, loopScopes)
}

function visitForInOfStatementAst(node: AcornNode, scopes: ScopeStack): void {
  if (node.right) visitScopedAst(node.right as AcornNode, scopes)
  const forScope = collectForHeadScope(node.left as AcornNode | null | undefined)
  const loopScopes = forScope.size > 0 ? [...scopes, forScope] : scopes
  if (node.left) visitScopedAst(node.left as AcornNode, loopScopes)
  if (node.body) visitScopedAst(node.body as AcornNode, loopScopes)
}

function visitSwitchStatementAst(node: AcornNode, scopes: ScopeStack): void {
  if (node.discriminant) visitScopedAst(node.discriminant as AcornNode, scopes)
  const switchScope = collectSwitchScope(node)
  const caseScopes = switchScope.size > 0 ? [...scopes, switchScope] : scopes
  for (const switchCase of (node.cases ?? []) as AcornNode[]) {
    if (switchCase.test) visitScopedAst(switchCase.test as AcornNode, caseScopes)
    for (const statement of (switchCase.consequent ?? []) as AcornNode[]) {
      visitScopedAst(statement, caseScopes)
    }
  }
}

function blockedNondeterministicApi(node: AcornNode, scopes: ScopeStack): string | null {
  if (node.type === "CallExpression") {
    const callee = node.callee as AcornNode
    if (isGlobalDateReference(callee, scopes)) return "Date()"
    if (isMemberCall(callee, "Date", "now", scopes)) return "Date.now()"
    if (isMemberCall(callee, "Math", "random", scopes)) return "Math.random()"
    if (isDateConstructorNowCall(callee, scopes)) return "Date.now()"
    if (isDatePrototypeConstructorNowCall(callee, scopes)) return "Date.now()"
    const indirectCall = nondeterministicCallApplyTarget(callee, scopes)
    if (indirectCall) return indirectCall
    const boundCall = nondeterministicBindCallTarget(callee, scopes)
    if (boundCall) return boundCall
    const bareReferenceCall = nondeterministicCallableReference(callee, scopes)
    if (bareReferenceCall) return bareReferenceCall
  }
  if (node.type === "NewExpression") {
    const callee = node.callee as AcornNode
    const args = Array.isArray(node.arguments) ? node.arguments : []
    if (isGlobalDateReference(callee, scopes) && args.length === 0) {
      return "new Date()"
    }
  }
  return null
}

function nondeterministicCallApplyTarget(node: AcornNode, scopes: ScopeStack): string | null {
  if (node.type === "SequenceExpression") {
    const expressions = node.expressions as AcornNode[] | undefined
    const last = expressions?.[expressions.length - 1]
    return last ? nondeterministicCallApplyTarget(last, scopes) : null
  }
  if (node.type !== "MemberExpression") return null
  const method = propertyNameOf(node)
  if (method !== "call" && method !== "apply") return null
  return nondeterministicCallableReference(node.object as AcornNode, scopes)
}

function nondeterministicBindCallTarget(node: AcornNode, scopes: ScopeStack): string | null {
  if (node.type === "SequenceExpression") {
    const expressions = node.expressions as AcornNode[] | undefined
    const last = expressions?.[expressions.length - 1]
    return last ? nondeterministicBindCallTarget(last, scopes) : null
  }
  if (node.type !== "CallExpression") return null
  const callee = node.callee as AcornNode
  if (callee.type !== "MemberExpression" || propertyNameOf(callee) !== "bind") return null
  return nondeterministicCallableReference(callee.object as AcornNode, scopes)
}

function nondeterministicCallableReference(node: AcornNode, scopes: ScopeStack): string | null {
  if (node.type === "SequenceExpression") {
    const expressions = node.expressions as AcornNode[] | undefined
    const last = expressions?.[expressions.length - 1]
    return last ? nondeterministicCallableReference(last, scopes) : null
  }
  if (isGlobalDateReference(node, scopes)) return "Date()"
  if (isMemberCall(node, "Date", "now", scopes)) return "Date.now()"
  if (isMemberCall(node, "Math", "random", scopes)) return "Math.random()"
  if (isDateConstructorNowCall(node, scopes)) return "Date.now()"
  if (isDatePrototypeConstructorNowCall(node, scopes)) return "Date.now()"
  return null
}

function isMemberCall(
  node: AcornNode,
  objectName: "Date" | "Math",
  propertyName: string,
  scopes: ScopeStack
): boolean {
  if (node.type !== "MemberExpression") return false
  const object = node.object as AcornNode
  return (
    propertyNameOf(node) === propertyName &&
    (objectName === "Date"
      ? isGlobalDateReference(object, scopes)
      : isGlobalMathReference(object, scopes))
  )
}

function isDateConstructorNowCall(node: AcornNode, scopes: ScopeStack): boolean {
  if (node.type !== "MemberExpression" || propertyNameOf(node) !== "now") return false
  const constructorMember = node.object as AcornNode
  if (constructorMember.type !== "MemberExpression" || propertyNameOf(constructorMember) !== "constructor") {
    return false
  }
  const constructed = constructorMember.object as AcornNode
  return (
    constructed.type === "NewExpression" &&
    isGlobalDateReference(constructed.callee as AcornNode, scopes)
  )
}

function isDatePrototypeConstructorNowCall(node: AcornNode, scopes: ScopeStack): boolean {
  if (node.type !== "MemberExpression" || propertyNameOf(node) !== "now") return false
  const constructorMember = node.object as AcornNode
  if (constructorMember.type !== "MemberExpression" || propertyNameOf(constructorMember) !== "constructor") {
    return false
  }
  const prototypeMember = constructorMember.object as AcornNode
  return (
    prototypeMember.type === "MemberExpression" &&
    propertyNameOf(prototypeMember) === "prototype" &&
    isGlobalDateReference(prototypeMember.object as AcornNode, scopes)
  )
}

function isGlobalDateReference(node: AcornNode, scopes: ScopeStack): boolean {
  if (node.type === "Identifier") return node.name === "Date" && !isBound("Date", scopes)
  return isGlobalThisMember(node, "Date", scopes)
}

function isGlobalMathReference(node: AcornNode, scopes: ScopeStack): boolean {
  if (node.type === "Identifier") return node.name === "Math" && !isBound("Math", scopes)
  return isGlobalThisMember(node, "Math", scopes)
}

function isGlobalThisMember(node: AcornNode, propertyName: string, scopes: ScopeStack): boolean {
  if (node.type !== "MemberExpression") return false
  const object = node.object as AcornNode
  return (
    object.type === "Identifier" &&
    object.name === "globalThis" &&
    !isBound("globalThis", scopes) &&
    propertyNameOf(node) === propertyName
  )
}

function propertyNameOf(node: AcornNode): string | undefined {
  if (node.type !== "MemberExpression") return undefined
  const property = node.property as AcornNode
  if (!node.computed && property.type === "Identifier") return property.name as string
  return staticStringOf(property)
}

function staticStringOf(node: AcornNode | undefined): string | undefined {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value
  if (node?.type === "TemplateLiteral" && Array.isArray(node.expressions) && node.expressions.length === 0) {
    const quasis = node.quasis as Array<{ value: { cooked?: string; raw: string } }>
    return quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join("")
  }
  if (node?.type === "BinaryExpression" && node.operator === "+") {
    const left = staticStringOf(node.left as AcornNode)
    const right = staticStringOf(node.right as AcornNode)
    if (left !== undefined && right !== undefined) return left + right
  }
  return undefined
}

function isBound(name: string, scopes: ScopeStack): boolean {
  for (let i = scopes.length - 1; i >= 0; i--) {
    if (scopes[i].has(name)) return true
  }
  return false
}

function collectProgramScope(program: AcornNode): Set<string> {
  const names = new Set<string>()
  collectFunctionScopedVarNames(program, names)
  collectDirectLexicalNames((program.body ?? []) as AcornNode[], names)
  return names
}

function collectFunctionNameScope(node: AcornNode): Set<string> {
  const names = new Set<string>()
  if (
    (node.type === "FunctionExpression" || node.type === "FunctionDeclaration") &&
    node.id &&
    (node.id as AcornNode).type === "Identifier"
  ) {
    names.add((node.id as { name: string }).name)
  }
  return names
}

function collectBlockScope(block: AcornNode): Set<string> {
  const names = new Set<string>()
  collectDirectLexicalNames((block.body ?? []) as AcornNode[], names)
  return names
}

function collectForHeadScope(head: AcornNode | null | undefined): Set<string> {
  const names = new Set<string>()
  if (head?.type === "VariableDeclaration" && head.kind !== "var") {
    for (const declarator of (head.declarations ?? []) as AcornNode[]) {
      addPatternNames(declarator.id as AcornNode, names)
    }
  }
  return names
}

function collectSwitchScope(node: AcornNode): Set<string> {
  const names = new Set<string>()
  for (const switchCase of (node.cases ?? []) as AcornNode[]) {
    collectDirectLexicalNames((switchCase.consequent ?? []) as AcornNode[], names)
  }
  return names
}

function collectStaticBlockScope(block: AcornNode): Set<string> {
  const names = collectBlockScope(block)
  collectFunctionScopedVarNames(block, names)
  return names
}

function collectDirectLexicalNames(statements: AcornNode[], names: Set<string>): void {
  for (const statement of statements) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? (statement.declaration as AcornNode | null) : statement
    if (!declaration) continue
    if (declaration.type === "VariableDeclaration" && declaration.kind !== "var") {
      for (const declarator of (declaration.declarations ?? []) as AcornNode[]) {
        addPatternNames(declarator.id as AcornNode, names)
      }
    } else if (
      (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") &&
      declaration.id &&
      (declaration.id as AcornNode).type === "Identifier"
    ) {
      names.add((declaration.id as { name: string }).name)
    }
  }
}

function collectFunctionScopedVarNames(root: AcornNode, names: Set<string>): void {
  const stack: Array<{ node: AcornNode; isRoot: boolean }> = [{ node: root, isRoot: true }]
  while (stack.length > 0) {
    const { node, isRoot } = stack.pop()!
    if (!isRoot && (isFunctionNode(node) || node.type === "StaticBlock")) continue
    if (node.type === "VariableDeclaration" && node.kind === "var") {
      for (const declarator of (node.declarations ?? []) as AcornNode[]) {
        addPatternNames(declarator.id as AcornNode, names)
      }
    }
    const values = Object.values(node)
    for (let i = values.length - 1; i >= 0; i--) {
      const value = values[i]
      if (Array.isArray(value)) {
        for (let j = value.length - 1; j >= 0; j--) {
          const item = value[j]
          if (item && typeof item === "object" && typeof (item as AcornNode).type === "string") {
            stack.push({ node: item as AcornNode, isRoot: false })
          }
        }
      } else if (
        value &&
        typeof value === "object" &&
        typeof (value as AcornNode).type === "string"
      ) {
        stack.push({ node: value as AcornNode, isRoot: false })
      }
    }
  }
}

function isFunctionNode(node: AcornNode): boolean {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  )
}

function addPatternNames(node: AcornNode, names: Set<string>): void {
  switch (node.type) {
    case "Identifier":
      names.add(node.name as string)
      break
    case "ObjectPattern":
      for (const property of (node.properties ?? []) as AcornNode[]) {
        if (property.type === "RestElement") addPatternNames(property.argument as AcornNode, names)
        else if (property.type === "Property") addPatternNames(property.value as AcornNode, names)
      }
      break
    case "ArrayPattern":
      for (const element of (node.elements ?? []) as Array<AcornNode | null>) {
        if (element) addPatternNames(element, names)
      }
      break
    case "RestElement":
      addPatternNames(node.argument as AcornNode, names)
      break
    case "AssignmentPattern":
      addPatternNames(node.left as AcornNode, names)
      break
  }
}

/** Depth-first visit of every AST node (plain-object walk, no acorn-walk dependency). */
function forEachAstNode(root: AcornNode, visit: (node: AcornNode) => void): void {
  const stack: AcornNode[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()!
    visit(node)
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === "object" && typeof (item as AcornNode).type === "string") {
            stack.push(item as AcornNode)
          }
        }
      } else if (
        value &&
        typeof value === "object" &&
        typeof (value as AcornNode).type === "string"
      ) {
        stack.push(value as AcornNode)
      }
    }
  }
}
