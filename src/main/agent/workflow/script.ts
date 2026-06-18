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

  const body = script.slice(metaStatement.end as number).replace(/^[;\s]*/, "")
  return { meta: parsedMeta.data as WorkflowMeta, body }
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
