import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { describe, expect, it } from "vitest"

type Request = { toolCall: { name: string; id: string; args?: unknown } }
type Middleware = {
  wrapToolCall(request: Request, handler: (request: Request) => Promise<unknown>): Promise<unknown>
}
type Gate = Middleware & { withFileLock(operation: () => Promise<unknown>): Promise<unknown> }

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
  "BOT_BROWSER_ACTIONS",
  "isRecord",
  "executeCommandFromToolArgs",
  "classifyToolConcurrency",
  "shouldFastRejectActiveWorkflow",
  "AsyncRWLock",
  "AsyncSemaphore",
  "toolConcurrencyLocks",
  "taskConcurrencyLimiters",
  "getToolConcurrencyLock",
  "withToolFileWriteLock",
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
  `${source}\nglobalThis.createGate = createGradedToolConcurrencyMiddleware; globalThis.withFileLock = withToolFileWriteLock;`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }
).outputText

function createGate(
  userInputWithoutToolLock?: boolean,
  botBrowserToolsOwnFileLock?: boolean
): Gate {
  const context = {
    console,
    exports: {},
    createMiddleware: (config: Middleware) => config,
    workflowRunManager: { isActive: () => false },
    classifyCommandConcurrency: () => {
      throw new Error("Unexpected command in tool-lock test")
    },
    createGate: undefined as
      | undefined
      | ((id: string, enabled?: boolean, browser?: boolean) => Middleware),
    withFileLock: undefined as
      | undefined
      | ((id: string, operation: () => Promise<unknown>) => Promise<unknown>)
  }
  runInNewContext(compiled, context)
  return Object.assign(
    context.createGate!(
      "shared-test-workspace",
      userInputWithoutToolLock,
      botBrowserToolsOwnFileLock
    ),
    {
      withFileLock: (operation: () => Promise<unknown>) =>
        context.withFileLock!("shared-test-workspace", operation)
    }
  )
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
const request = (name: string, id = name, args?: unknown): Request => ({
  toolCall: { name, id, args }
})
const humanWaits = [
  { name: "request_user_input", args: undefined },
  { name: "bot_request_browser_help", args: undefined },
  { name: "bot_browser", args: { action: "request_help" } }
]

describe("shared-workspace user input", () => {
  it("lets an upload wait outside the file lock and serializes only its actual file phase", async () => {
    const gate = createGate(false, true)
    const returned = deferred(),
      attached = deferred(),
      finish = deferred()
    let peerRead = false,
      writerRan = false
    const upload = gate.wrapToolCall(
      request("bot_browser", "upload", { action: "upload" }),
      async () => {
        await returned.promise
        return gate.withFileLock(async () => {
          attached.resolve()
          await finish.promise
        })
      }
    )
    const read = gate.wrapToolCall(request("read_file"), async () => {
      peerRead = true
    })
    let write: Promise<unknown> | undefined
    try {
      await turn()
      expect(peerRead).toBe(true)
      returned.resolve()
      await attached.promise
      write = gate.wrapToolCall(request("write_file"), async () => {
        writerRan = true
      })
      await turn()
      expect(writerRan).toBe(false)
    } finally {
      returned.resolve()
      finish.resolve()
      await Promise.all([upload, read, write])
    }
    expect(writerRan).toBe(true)
  })

  it.each([
    undefined,
    {},
    { action: "new-file-action" },
    { action: "observe_extra" },
    '{"action":"observe"}',
    [{ action: "observe" }]
  ])(
    "retains the lock for an unknown or malformed browser action %j even with the trusted option",
    async (args) => {
      const gate = createGate(false, true),
        finish = deferred()
      let read = false
      const browser = gate.wrapToolCall(
        request("bot_browser", "unknown", args),
        () => finish.promise
      )
      const peer = gate.wrapToolCall(request("read_file"), async () => {
        read = true
      })
      try {
        await turn()
        expect(read).toBe(false)
      } finally {
        finish.resolve()
        await Promise.all([browser, peer])
      }
    }
  )
  it.each(["observe", "navigate", "click", "fill", "press", "scroll", "close", "dialog"])(
    "does not hold the file lock during a trusted Bot browser %s",
    async (action) => {
      const gate = createGate(false, true)
      const returned = deferred()
      let read = false
      const browser = gate.wrapToolCall(
        request("bot_browser", "browser", { action }),
        () => returned.promise
      )
      const peer = gate.wrapToolCall(request("read_file"), async () => {
        read = true
      })
      try {
        await turn()
        expect(read).toBe(true)
      } finally {
        returned.resolve()
        await Promise.all([browser, peer])
      }
    }
  )
  it.each(humanWaits)(
    "lets a peer read during $name, but keeps file writers serialized",
    async ({ name, args }) => {
      const gate = createGate(true)
      const answer = deferred()
      const writer = deferred()
      let asking = false
      let peerRead = false
      let secondWriter = false
      const question = gate.wrapToolCall(request(name, name, args), async () => {
        asking = true
        await answer.promise
      })
      const reading = gate.wrapToolCall(request("read_file"), async () => {
        peerRead = true
        return "peer-read"
      })
      const firstWrite = gate.wrapToolCall(request("write_file", "first"), () => writer.promise)
      const nextWrite = gate.wrapToolCall(request("write_file", "second"), async () => {
        secondWriter = true
      })
      try {
        await turn()
        expect(asking).toBe(true)
        expect(peerRead).toBe(true)
        expect(secondWriter).toBe(false)
        writer.resolve()
        await Promise.all([firstWrite, nextWrite])
        expect(secondWriter).toBe(true)
        await expect(reading).resolves.toBe("peer-read")
      } finally {
        writer.resolve()
        answer.resolve()
        await Promise.all([question, reading, firstWrite, nextWrite])
      }
    }
  )

  it.each(humanWaits)(
    "retains $name behavior unless the trusted host opts in",
    async ({ name, args }) => {
      const gate = createGate()
      const answer = deferred()
      let read = false
      const question = gate.wrapToolCall(request(name, name, args), () => answer.promise)
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
    }
  )

  it.each([
    { name: "bot_browser", args: undefined },
    { name: "bot_browser", args: { action: "observe" } },
    { name: "bot_browser", args: { action: "upload" } },
    { name: "bot_browser", args: { action: "request_help_extra" } },
    { name: "bot_browser", args: '{"action":"request_help"}' },
    { name: "bot_browser", args: [{ action: "request_help" }] },
    { name: "custom_tool", args: { action: "request_help" } },
    { name: "bot_request_browser_help_extra", args: undefined }
  ])("does not bypass unknown or file-capable $name ($args)", async ({ name, args }) => {
    const gate = createGate(true)
    const browser = deferred()
    let customRan = false
    const holding = gate.wrapToolCall(request(name, name, args), () => browser.promise)
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
