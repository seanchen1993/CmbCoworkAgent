import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { describe, expect, it } from "vitest"

type Request = { toolCall: { name: string; id: string } }
type Middleware = {
  wrapToolCall(request: Request, handler: (request: Request) => Promise<unknown>): Promise<unknown>
}

// Execute the owning middleware and lock directly without booting the Electron/model runtime.
const runtime = ts.createSourceFile(
  "runtime.ts",
  readFileSync(new URL("./runtime.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true
)
const declarations = new Set([
  "EXCLUSIVE_TOOL_NAMES",
  "SHARED_TOOL_NAMES",
  "MAX_PARALLEL_TASK_SUBAGENTS",
  "isRecord",
  "executeCommandFromToolArgs",
  "classifyToolConcurrency",
  "shouldFastRejectActiveWorkflow",
  "AsyncRWLock",
  "AsyncSemaphore",
  "toolConcurrencyLocks",
  "taskConcurrencyLimiters",
  "getToolConcurrencyLock",
  "getTaskConcurrencyLimiter",
  "createGradedToolConcurrencyMiddleware"
])
const source = runtime.statements
  .filter((statement) => {
    if (ts.isVariableStatement(statement))
      return statement.declarationList.declarations.some(
        (declaration) =>
          ts.isIdentifier(declaration.name) && declarations.has(declaration.name.text)
      )
    return (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name !== undefined &&
      declarations.has(statement.name.text)
    )
  })
  .map((statement) => statement.getText(runtime))
  .join("\n")
const compiled = ts.transpileModule(
  `${source}\nglobalThis.createGate = createGradedToolConcurrencyMiddleware;`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }
).outputText

function createGate(userInputWithoutToolLock?: boolean): Middleware {
  const context = {
    console,
    createMiddleware: (config: Middleware) => config,
    workflowRunManager: { isActive: () => false },
    classifyCommandConcurrency: () => {
      throw new Error("Unexpected command in tool-lock test")
    },
    createGate: undefined as undefined | ((id: string, enabled?: boolean) => Middleware)
  }
  runInNewContext(compiled, context)
  return context.createGate!("shared-test-workspace", userInputWithoutToolLock)
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
const request = (name: string, id = name): Request => ({ toolCall: { name, id } })

describe("shared-workspace user input", () => {
  it("lets a peer read while a human choice is pending, but keeps file writers serialized", async () => {
    const gate = createGate(true)
    const answer = deferred()
    const writer = deferred()
    let asking = false
    let secondWriter = false
    const question = gate.wrapToolCall(request("request_user_input"), async () => {
      asking = true
      await answer.promise
    })
    const firstWrite = gate.wrapToolCall(request("write_file", "first"), () => writer.promise)
    const nextWrite = gate.wrapToolCall(request("write_file", "second"), async () => {
      secondWriter = true
    })
    try {
      await turn()
      expect(asking).toBe(true)
      expect(secondWriter).toBe(false)
      writer.resolve()
      await Promise.all([firstWrite, nextWrite])
      expect(secondWriter).toBe(true)
      await expect(gate.wrapToolCall(request("read_file"), async () => "peer-read")).resolves.toBe(
        "peer-read"
      )
    } finally {
      writer.resolve()
      answer.resolve()
      await Promise.all([question, firstWrite, nextWrite])
    }
  })

  it("retains existing behavior unless the trusted host opts in", async () => {
    const gate = createGate()
    const answer = deferred()
    let read = false
    const question = gate.wrapToolCall(request("request_user_input"), () => answer.promise)
    const reading = gate.wrapToolCall(request("read_file"), async () => {
      read = true
    })
    try {
      await turn()
      expect(read).toBe(false)
    } finally {
      answer.resolve()
      await Promise.all([question, reading])
    }
    expect(read).toBe(true)
  })

  it("does not bypass unknown or interactive browser tools", async () => {
    const gate = createGate(true)
    const browser = deferred()
    let customRan = false
    const holding = gate.wrapToolCall(request("bot_request_browser_help"), () => browser.promise)
    const custom = gate.wrapToolCall(request("custom_tool"), async () => {
      customRan = true
    })
    try {
      await turn()
      expect(customRan).toBe(false)
    } finally {
      browser.resolve()
      await Promise.all([holding, custom])
    }
    expect(customRan).toBe(true)
  })
})
