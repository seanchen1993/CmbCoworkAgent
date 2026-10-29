import { readFileSync } from "node:fs"
import ts from "typescript"
import { describe, expect, it, vi } from "vitest"
import { AsyncRWLock, AsyncSemaphore } from "./async-lock"
import { classifyCommandConcurrency } from "./exec-policy"

interface ToolRequest {
  toolCall: { id: string; name: string }
  runtime?: { signal?: AbortSignal }
}

type Handler = (request: ToolRequest) => Promise<string>

interface ConcurrencyMiddleware {
  wrapToolCall: (request: ToolRequest, handler: Handler) => Promise<string>
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function request(name: string, signal?: AbortSignal): ToolRequest {
  return { toolCall: { id: name, name }, runtime: { signal } }
}

function createHarness() {
  // Run the production middleware without importing Electron or initializing the
  // full agent runtime. Keep the process-level maps in the extracted section so
  // separate turns still share the same thread lock, as they do in the app.
  const source = readFileSync(new URL("./runtime.ts", import.meta.url), "utf8")
  function section(startMarker: string, endMarker: string) {
    const start = source.indexOf(startMarker)
    const end = source.indexOf(endMarker, start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    return source.slice(start, end)
  }
  const extracted = [
    section("const EXCLUSIVE_TOOL_NAMES =", "type RuntimePromptToolPolicy ="),
    section("function isRecord(", "function createTrustedToolFilePreviewContextMiddleware")
  ].join("\n")
  const compiled = ts.transpileModule(extracted.replace("export function", "function"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText
  const activeWorkflows = new Set<string>()
  const load = new Function(
    "AsyncRWLock",
    "AsyncSemaphore",
    "createMiddleware",
    "classifyCommandConcurrency",
    "workflowRunManager",
    `${compiled}\nreturn createGradedToolConcurrencyMiddleware`
  )
  const create = load(
    AsyncRWLock,
    AsyncSemaphore,
    (middleware: ConcurrencyMiddleware) => middleware,
    classifyCommandConcurrency,
    { isActive: (queueId: string) => activeWorkflows.has(queueId) }
  ) as (queueId: string) => ConcurrencyMiddleware
  return { create, activeWorkflows }
}

describe("graded tool concurrency cancellation", () => {
  it("cancels a queued execute immediately and lets a new turn read the same thread", async () => {
    const { create } = createHarness()
    const turn = create("thread")
    const controller = new AbortController()
    const started = deferred()
    const release = deferred()
    const running = turn.wrapToolCall(request("execute", controller.signal), async () => {
      started.resolve()
      await release.promise
      return "first execute settled"
    })
    await started.promise

    const queuedHandler = vi.fn(async () => "must not execute")
    const queued = turn.wrapToolCall(request("execute", controller.signal), queuedHandler)
    const canceled = expect(queued).rejects.toMatchObject({ name: "AbortError" })
    controller.abort()
    await canceled
    expect(queuedHandler).not.toHaveBeenCalled()

    // A new turn creates another middleware, but must retain the original lock
    // until its still-running holder has finished settling after cancellation.
    const readStarted = deferred()
    const nextHandler = vi.fn(async () => {
      readStarted.resolve()
      return "file contents"
    })
    const next = create("thread").wrapToolCall(request("read_file"), nextHandler)
    await Promise.resolve()
    expect(nextHandler).not.toHaveBeenCalled()
    release.resolve()
    await running
    await readStarted.promise
    await expect(next).resolves.toBe("file contents")
    expect(queuedHandler).not.toHaveBeenCalled()
  })

  it("removes a canceled shared waiter without blocking subsequent readers", async () => {
    const { create } = createHarness()
    const middleware = create("thread")
    const started = deferred()
    const release = deferred()
    const writer = middleware.wrapToolCall(request("execute"), async () => {
      started.resolve()
      await release.promise
      return "written"
    })
    await started.promise

    const controller = new AbortController()
    const handler = vi.fn(async () => "stale read")
    const queued = middleware.wrapToolCall(request("read_file", controller.signal), handler)
    const canceled = expect(queued).rejects.toMatchObject({ name: "AbortError" })
    controller.abort()
    await canceled
    release.resolve()
    await writer
    await expect(
      create("thread").wrapToolCall(request("read_file"), async () => "fresh read")
    ).resolves.toBe("fresh read")
    expect(handler).not.toHaveBeenCalled()
  })

  it("cancels a queued task before a subagent slot becomes available", async () => {
    const { create } = createHarness()
    const middleware = create("thread")
    const started = [deferred(), deferred(), deferred()]
    const release = deferred()
    const running = started.map((entry) =>
      middleware.wrapToolCall(request("task"), async () => {
        entry.resolve()
        await release.promise
        return "subagent finished"
      })
    )
    await Promise.all(started.map((entry) => entry.promise))

    const controller = new AbortController()
    const handler = vi.fn(async () => "must not launch")
    const queued = middleware.wrapToolCall(request("task", controller.signal), handler)
    const canceled = expect(queued).rejects.toMatchObject({ name: "AbortError" })
    controller.abort()
    await canceled
    expect(handler).not.toHaveBeenCalled()

    release.resolve()
    await Promise.all(running)
    await expect(
      create("thread").wrapToolCall(request("task"), async () => "new subagent")
    ).resolves.toBe("new subagent")
    expect(handler).not.toHaveBeenCalled()
  })

  it.each(["execute", "read_file", "task"])(
    "rechecks cancellation after an immediately granted %s lock before dispatch",
    async (toolName) => {
      const { create } = createHarness()
      const controller = new AbortController()
      const handler = vi.fn(async () => "must not dispatch")
      const pending = create("thread").wrapToolCall(request(toolName, controller.signal), handler)
      const canceled = expect(pending).rejects.toMatchObject({ name: "AbortError" })
      controller.abort()
      await canceled
      expect(handler).not.toHaveBeenCalled()
      await expect(
        create("thread").wrapToolCall(request("execute"), async () => "lock released")
      ).resolves.toBe("lock released")
    }
  )

  it.each(["execute", "read_file", "task", "workflow"])(
    "does not dispatch an already canceled %s request, including fast paths",
    async (toolName) => {
      const { create, activeWorkflows } = createHarness()
      activeWorkflows.add("thread")
      const controller = new AbortController()
      controller.abort()
      const handler = vi.fn(async () => "must not dispatch")
      await expect(
        create("thread").wrapToolCall(request(toolName, controller.signal), handler)
      ).rejects.toMatchObject({ name: "AbortError" })
      expect(handler).not.toHaveBeenCalled()
    }
  )

  it("releases the lock when the tool handler fails", async () => {
    const { create } = createHarness()
    await expect(
      create("thread").wrapToolCall(request("execute"), async () => {
        throw new Error("execute failed")
      })
    ).rejects.toThrow("execute failed")
    await expect(
      create("thread").wrapToolCall(request("read_file"), async () => "read works")
    ).resolves.toBe("read works")
  })
})
