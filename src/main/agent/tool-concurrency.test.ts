import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { runInNewContext } from "node:vm"
import { ToolMessage } from "@langchain/core/messages"
import ts from "typescript"
import { describe, expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { LocalBotHost, type BotRunPort } from "../bots/host"
import { BotStore } from "../bots/store"

type Request = {
  toolCall: { name: string; id?: string; args?: unknown }
  runtime?: { signal?: AbortSignal }
}
type Middleware = {
  wrapToolCall(request: Request, handler: (request: Request) => Promise<unknown>): Promise<unknown>
}
type Gate = Middleware & {
  withFileLock(operation: () => Promise<unknown>): Promise<unknown>
  forQueue(queueId: string, workflowThreadId?: string): Middleware
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
const workflowTool = ts.createSourceFile(
  "workflow/tool.ts",
  readFileSync(new URL("./workflow/tool.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true
)
const errorFormatter = workflowTool.statements.find(
  (statement) =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === "formatActiveWorkflowError"
)!
const compiled = ts.transpileModule(
  `${errorFormatter.getText(workflowTool)}\n${source}\nglobalThis.createGate = createGradedToolConcurrencyMiddleware; globalThis.withFileLock = withToolFileWriteLock;`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }
).outputText

function createGate(
  userInputWithoutToolLock?: boolean,
  botBrowserToolsOwnFileLock?: boolean,
  options: {
    queueId?: string
    workflowThreadId?: string
    activeWorkflowThreadIds?: readonly string[]
  } = {}
): Gate {
  const queueId = options.queueId ?? "shared-test-workspace"
  const context = {
    console,
    exports: {},
    createMiddleware: (config: Middleware) => config,
    ToolMessage,
    workflowRunManager: {
      isActive: (threadId: string) => options.activeWorkflowThreadIds?.includes(threadId) ?? false,
      activeRunId: () => "wf_existing_run"
    },
    classifyCommandConcurrency: () => {
      throw new Error("Unexpected command in tool-lock test")
    },
    createGate: undefined as
      | undefined
      | ((
          id: string,
          enabled?: boolean,
          browser?: boolean,
          workflowThreadId?: string
        ) => Middleware),
    withFileLock: undefined as
      | undefined
      | ((id: string, operation: () => Promise<unknown>) => Promise<unknown>)
  }
  runInNewContext(compiled, context)
  const forQueue = (id: string, workflowThreadId?: string): Middleware =>
    context.createGate!(id, userInputWithoutToolLock, botBrowserToolsOwnFileLock, workflowThreadId)
  return Object.assign(forQueue(queueId, options.workflowThreadId), {
    withFileLock: (operation: () => Promise<unknown>) => context.withFileLock!(queueId, operation),
    forQueue
  })
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

describe("shared Bot workspaces", () => {
  it("serializes writes across conversations sharing a directory while other directories proceed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bot-workspace-lock-"))
    const file = join(dir, "shared.txt")
    writeFileSync(file, "")
    const gate = createGate(),
      entered = deferred(),
      finish = deferred()
    const a = gate.forQueue(`workspace:${dir}`, "private-thread")
    const b = gate.forQueue(`workspace:${dir}`, "group-task-thread")
    const other = gate.forQueue(`workspace:${dir}/other`, "other-group-thread")
    const writer = a.wrapToolCall(request("write_file", "a"), async () => {
      const before = readFileSync(file, "utf8")
      entered.resolve()
      await finish.promise
      writeFileSync(file, before + "A")
    })
    await entered.promise
    const next = vi.fn(async () => writeFileSync(file, readFileSync(file, "utf8") + "B"))
    const blocked = b.wrapToolCall(request("write_file", "b"), next)
    try {
      await other.wrapToolCall(request("write_file", "c"), async () =>
        writeFileSync(join(dir, "other.txt"), "C")
      )
      expect(next).not.toHaveBeenCalled()
      expect(readFileSync(join(dir, "other.txt"), "utf8")).toBe("C")
      finish.resolve()
      await Promise.all([writer, blocked])
      expect(readFileSync(file, "utf8")).toBe("AB")
    } finally {
      finish.resolve()
      await Promise.all([writer, blocked])
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("active workflow rejection", () => {
  it.each([
    { queueId: "bot-private", workflowThreadId: "private-thread" },
    { queueId: "bot-group-room", workflowThreadId: "group-member-thread" },
    { queueId: "workspace:/existing-project", workflowThreadId: "work-thread" },
    { queueId: "ordinary-thread", workflowThreadId: undefined }
  ])(
    "rejects before hooks or tools while a shared queue writer is held ($queueId)",
    async ({ queueId, workflowThreadId }) => {
      const threadId = workflowThreadId ?? queueId
      const gate = createGate(false, false, {
        queueId,
        workflowThreadId,
        activeWorkflowThreadIds: [threadId]
      })
      const leaf = gate.forQueue(queueId, `${threadId}-leaf`)
      const entered = deferred(),
        finish = deferred()
      const writer = leaf.wrapToolCall(request("write_file"), async () => {
        entered.resolve()
        await finish.promise
      })
      await entered.promise
      const downstream = vi.fn(async () => "must not execute hooks, Mods or the tool")
      const duplicate = gate.wrapToolCall(request("workflow", "duplicate-call"), downstream)
      try {
        await turn()
        expect(downstream).not.toHaveBeenCalled()
        const result = (await duplicate) as ToolMessage
        expect(ToolMessage.isInstance(result)).toBe(true)
        expect(result).toMatchObject({
          tool_call_id: "duplicate-call",
          name: "workflow",
          status: "error",
          content:
            "Tool execution failed: A dynamic workflow (wf_existing_run) is already running in this thread. Wait for its task-notification, or the user can cancel it from the workflow panel.\nPlease adjust your approach and try again if appropriate."
        })
        const laterWriter = vi.fn(async () => "later write")
        const later = leaf.wrapToolCall(request("write_file", "later-writer"), laterWriter)
        await turn()
        expect(laterWriter).not.toHaveBeenCalled()
        finish.resolve()
        await later
        expect(laterWriter).toHaveBeenCalledOnce()
      } finally {
        finish.resolve()
        await Promise.all([writer, duplicate])
      }
    }
  )

  it("keeps an inactive thread's launch behind the shared queue writer", async () => {
    const gate = createGate(false, false, {
      queueId: "bot-group-room",
      workflowThreadId: "idle-member-thread",
      activeWorkflowThreadIds: ["bot-group-room", "other-member-thread"]
    })
    const leaf = gate.forQueue("bot-group-room", "other-member-thread-leaf")
    const entered = deferred(),
      finish = deferred()
    const writer = leaf.wrapToolCall(request("write_file"), async () => {
      entered.resolve()
      await finish.promise
    })
    await entered.promise
    const launch = vi.fn(async () => "launched")
    const workflow = gate.wrapToolCall(request("workflow"), launch)
    try {
      await turn()
      expect(launch).not.toHaveBeenCalled()
    } finally {
      finish.resolve()
      await Promise.all([writer, workflow])
    }
    expect(launch).toHaveBeenCalledOnce()
  })

  it.each(["read_file", "write_file", "workflow-without-id"])(
    "keeps %s behind the writer even with an active workflow",
    async (name) => {
      const gate = createGate(false, false, {
        activeWorkflowThreadIds: ["shared-test-workspace"]
      })
      const entered = deferred(),
        finish = deferred()
      const writer = gate.wrapToolCall(request("write_file", "holder"), async () => {
        entered.resolve()
        await finish.promise
      })
      await entered.promise
      const handler = vi.fn(async () => "normal locked path")
      const call =
        name === "workflow-without-id" ? { toolCall: { name: "workflow" } } : request(name)
      const pending = gate.wrapToolCall(call, handler)
      try {
        await turn()
        expect(handler).not.toHaveBeenCalled()
      } finally {
        finish.resolve()
        await Promise.all([writer, pending])
      }
      expect(handler).toHaveBeenCalledOnce()
    }
  )

  it("preserves cancellation instead of returning a duplicate error for an aborted request", async () => {
    const gate = createGate(false, false, {
      activeWorkflowThreadIds: ["shared-test-workspace"]
    })
    const controller = new AbortController()
    const reason = new Error("Stopped before duplicate rejection")
    controller.abort(reason)
    const handler = vi.fn(async () => "must not run")
    await expect(
      gate.wrapToolCall({ ...request("workflow"), runtime: { signal: controller.signal } }, handler)
    ).rejects.toBe(reason)
    expect(handler).not.toHaveBeenCalled()
  })
})

describe("shared-workspace user input", () => {
  it("releases a contested room file after member removal without losing the survivor's update", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cmb-bot-room-lock-"))
    const file = join(directory, "result.txt"),
      protectedFile = join(directory, "existing.txt")
    writeFileSync(protectedFile, "EXISTING\n")
    const sqlite = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
    const db = new BotStore(sqlite, () => 1000),
      gate = createGate(true),
      entered = deferred()
    const input = { name: "Writer", instructions: "", color: "#ea2845", modelRef: null }
    const a = db.create(input),
      b = db.create({ ...input, name: "Survivor" })
    const original = db.update({ ...a, label: "Preserve", expectedVersion: a.version })
    const group = db.saveGroup({ name: "Legal shared room", memberIds: [a.id, b.id] })
    let survivorWrites = 0
    const runtime: BotRunPort = {
      onAvailable: () => () => {},
      acquire: (bot, task) => ({
        release() {},
        execute: async (signal) => {
          await gate.wrapToolCall(request("write_file", task.id), async () => {
            if (bot.id === a.id) {
              writeFileSync(file, "A_STARTED\n")
              entered.resolve()
              await new Promise<void>((resolve) =>
                signal.addEventListener("abort", () => resolve(), { once: true })
              )
              if (!signal.aborted) appendFileSync(file, "A_LATE\n")
            } else {
              expect(readFileSync(file, "utf8")).toBe("A_STARTED\n")
              appendFileSync(file, "B_DONE\n")
              survivorWrites++
            }
          })
          if (!signal.aborted) host.publishGroupMessage(task.id, "survivor-result", "B_DONE")
          return { state: "completed", explicitGroupMessages: true }
        }
      })
    }
    const host = new LocalBotHost(db, runtime)
    try {
      host.sendGroup({
        groupId: group.id,
        requestId: "contested-room-file",
        text: "Write only this room's result",
        targetBotIds: [a.id]
      })
      await entered.promise
      host.sendGroup({
        groupId: group.id,
        requestId: "contested-room-survivor",
        text: "Preserve the room's current record and append your result",
        targetBotIds: [b.id]
      })
      const roots = db.recentTasks(),
        removed = roots.find((task) => task.botId === a.id)!,
        survivor = roots.find((task) => task.botId === b.id)!
      // Public room turns now wait at admission, before reaching the unchanged file lock.
      await turn()
      expect(db.getTask(survivor.id).state).toBe("queued")
      expect(db.getTask(removed.id).state).toBe("running")
      expect(survivorWrites).toBe(0)
      expect(() => host.update({ ...original, name: "Stale", expectedVersion: a.version })).toThrow(
        "刷新"
      )
      expect(() =>
        host.update({ ...original, name: "Busy", expectedVersion: original.version })
      ).toThrow("停止")
      expect(db.getBot(a.id)).toEqual(original)
      const changed = host.saveGroup(
        { name: group.name, memberIds: [b.id] },
        { id: group.id, version: group.version }
      )
      expect(() => host.saveGroup({ name: "Stale", memberIds: [a.id, b.id] }, group)).toThrow()
      await vi.waitFor(() => expect(host.hasActiveRuns()).toBe(false))
      expect(db.getTask(removed.id).state).toBe("cancelled")
      expect(db.getTask(survivor.id)).toMatchObject({ state: "completed", error: null })
      expect(db.getGroup(group.id)).toEqual(changed)
      expect(db.getBot(a.id)).toEqual(original)
      expect(db.getBot(b.id)).toEqual(b)
      expect(survivorWrites).toBe(1)
      expect(readFileSync(file, "utf8")).toBe("A_STARTED\nB_DONE\n")
      expect(readFileSync(protectedFile, "utf8")).toBe("EXISTING\n")
      expect(db.recentTasks()).toHaveLength(2)
      expect(db.groupMessages(group.id).filter((message) => message.authorBotId)).toMatchObject([
        { authorBotId: b.id, text: "B_DONE" }
      ])
      expect(() => host.publishGroupMessage(removed.id, "late", "A_LATE")).toThrow()
    } finally {
      await host.stop()
      sqlite.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each([false, true])(
    "only lets explicit Bot room communication bypass a held writer with opt-in (%s)",
    async (enabled) => {
      const gate = createGate(enabled),
        finish = deferred()
      let sent = false,
        secondWrite = false
      const first = gate.wrapToolCall(request("write_file", "first"), () => finish.promise)
      const message = gate.wrapToolCall(request("bot_send_message"), async () => {
        sent = true
      })
      const second = gate.wrapToolCall(request("write_file", "second"), async () => {
        secondWrite = true
      })
      try {
        await turn()
        expect(sent).toBe(enabled)
        expect(secondWrite).toBe(false)
      } finally {
        finish.resolve()
        await Promise.all([first, message, second])
      }
      expect(sent).toBe(true)
      expect(secondWrite).toBe(true)
    }
  )

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
    null,
    {},
    { action: null },
    { action: 1 },
    { action: "new-file-action" },
    { action: "observe_extra" },
    '{"action":"observe"}',
    [{ action: "observe" }]
  ])(
    "retains the lock for an unknown or malformed browser action %j even with the trusted option",
    async (args) => {
      const gate = createGate(false, true),
        finish = deferred()
      let read = false,
        write = false
      const browser = gate.wrapToolCall(
        request("bot_browser", "unknown", args),
        () => finish.promise
      )
      const peer = gate.wrapToolCall(request("read_file"), async () => {
        read = true
      })
      const writer = gate.wrapToolCall(request("write_file"), async () => {
        write = true
      })
      try {
        await turn()
        expect(read).toBe(false)
        expect(write).toBe(false)
      } finally {
        finish.resolve()
        await Promise.all([browser, peer, writer])
      }
    }
  )
  it.each([
    "observe",
    "navigate",
    "click",
    "fill",
    "press",
    "scroll",
    "close",
    "dialog",
    "request_help",
    "hover",
    "drag",
    "select",
    "fill_form",
    "wait",
    "evaluate",
    "back"
  ])(
    "allows peer file tools during a trusted Bot browser %s wait while serializing file writers",
    async (action) => {
      const gate = createGate(false, true)
      const returned = deferred(),
        written = deferred()
      let read = false,
        firstWrite = false,
        secondWrite = false
      const browser = gate.wrapToolCall(
        request("bot_browser", "browser", { action }),
        () => returned.promise
      )
      const peer = gate.wrapToolCall(request("read_file"), async () => {
        read = true
      })
      const writer = gate.wrapToolCall(request("write_file", "first"), async () => {
        firstWrite = true
        await written.promise
      })
      const nextWriter = gate.wrapToolCall(request("write_file", "second"), async () => {
        secondWrite = true
      })
      try {
        await turn()
        expect(read).toBe(true)
        expect(firstWrite).toBe(true)
        expect(secondWrite).toBe(false)
        written.resolve()
        await Promise.all([writer, nextWriter])
        expect(secondWrite).toBe(true)
      } finally {
        written.resolve()
        returned.resolve()
        await Promise.all([browser, peer, writer, nextWriter])
      }
    }
  )

  it.each(["hover", "drag", "select", "fill_form", "wait", "evaluate", "back"])(
    "keeps browser %s behind the file gate without the trusted browser opt-in",
    async (action) => {
      for (const userInputWithoutToolLock of [false, true]) {
        const gate = createGate(userInputWithoutToolLock),
          returned = deferred()
        let read = false,
          write = false
        const browser = gate.wrapToolCall(
          request("bot_browser", "browser", { action }),
          () => returned.promise
        )
        const peer = gate.wrapToolCall(request("read_file"), async () => {
          read = true
        })
        const writer = gate.wrapToolCall(request("write_file"), async () => {
          write = true
        })
        try {
          await turn()
          expect(read).toBe(false)
          expect(write).toBe(false)
        } finally {
          returned.resolve()
          await Promise.all([browser, peer, writer])
        }
        expect(read).toBe(true)
        expect(write).toBe(true)
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
