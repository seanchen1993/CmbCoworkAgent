import { EventEmitter } from "node:events"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { describe, expect, it, vi } from "vitest"
import { captureThreadIncarnation, matchesThreadIncarnation } from "../services/thread-incarnation"
import {
  createThreadDisplayMetadataGuard,
  withThreadDisplayMetadataRetry
} from "./thread-display-read-retry"
import { ForegroundHydrationGeneration } from "../../renderer/src/lib/thread-hydration"
import { createThreadMessageWindowIntentCoordinator } from "../../renderer/src/lib/thread-message-window-intent"

// Exercise the actual IPC handler and capture function without loading Electron or a worker bundle.
const source = ts.createSourceFile(
  "threads.ts",
  readFileSync(new URL("./threads.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true
)
function expression(name: string): string {
  let found: ts.Node | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(source) === "ipcMain" &&
      node.expression.name.text === "handle" &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === name
    )
      found = node.arguments[1]
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!found) throw Error(`Missing IPC source: ${name}`)
  return ts.transpileModule(`(${found.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
}
const captureCode = expression("captureThreadDisplayRead")
const handlerCode = expression("threads:messages-page")

class Sender extends EventEmitter {
  id = 10
  mainFrame = {}
  destroyed = false
  isDestroyed() {
    return this.destroyed
  }
}
interface ReadSource {
  assertCurrent(): void
  verify(witnesses: readonly object[]): void
}
interface Page {
  attempt: number
  messages: string[]
}
interface ReadScope {
  assertCurrent(): void
  canRetryMetadata(error: unknown): boolean
  dispose(): void
}
type Handler = (
  event: { sender: Sender },
  request: {
    threadId: string
    options?: { requestScope?: "foreground-hydration"; targetMessageId?: string }
  }
) => Promise<Page>

function fixture() {
  const sender = new Sender(),
    event = { sender }
  let database = {},
    row: { created_at: number; metadata: string } | null = {
      created_at: 1,
      metadata: JSON.stringify({
        cmb_thread_incarnation: "original",
        workspacePath: "/project",
        hostProjectRuntime: { projectId: "project", operationId: "operation" }
      })
    }
  const scopes: ReadScope[] = [],
    sources: ReadSource[] = [],
    accepted: object[] = []
  const capture = runInNewContext(captureCode, {
    getDb: () => database,
    getThreadCore: () => row && { ...row },
    captureThreadIncarnation,
    matchesThreadIncarnation,
    AbortController,
    Error,
    createThreadDisplayMetadataGuard
  }) as (event: { sender: Sender }, id: string) => ReadScope
  let onResponse: (attempt: number) => void = () => {}
  let beforeReject = () => {}
  const workerUnavailable = Error("worker-unavailable"),
    warn = vi.fn()
  const verify = vi.fn((_threadId: string, witnesses: readonly object[], guard: () => void) => {
    guard()
    accepted.push(...witnesses)
    guard()
  })
  const worker = vi.fn(
    async (
      _threadId: string,
      _options: unknown,
      _sender: number,
      current: ReadSource
    ): Promise<Page> => {
      sources.push(current)
      const attempt = sources.length
      current.assertCurrent()
      await Promise.resolve()
      onResponse(attempt)
      try {
        current.verify([{ attempt }])
      } catch (error) {
        beforeReject()
        throw error
      }
      return { attempt, messages: [`verified-page-${attempt}`] }
    }
  )
  const handler = runInNewContext(handlerCode, {
    captureThreadDisplayRead: (owner: { sender: Sender }, id: string) => {
      const scope = capture(owner, id)
      scopes.push(scope)
      return scope
    },
    withThreadDisplayMetadataRetry,
    verifyCanonicalThreadDisplayWitnesses: verify,
    readThreadMessagesPageInWorker: worker,
    isThreadMessageHydrationWorkerUnavailable: (error: unknown) => error === workerUnavailable,
    console: { warn },
    setImmediate
  }) as Handler
  return {
    sender,
    event,
    scopes,
    sources,
    accepted,
    worker,
    verify,
    handler,
    workerUnavailable,
    warn,
    run: () =>
      handler(event, { threadId: "thread", options: { requestScope: "foreground-hydration" } }),
    onResponse: (callback: typeof onResponse) => {
      onResponse = callback
    },
    beforeReject: (callback: typeof beforeReject) => {
      beforeReject = callback
    },
    patch: (patch: Record<string, unknown>) => {
      row = { ...row!, metadata: JSON.stringify({ ...JSON.parse(row!.metadata), ...patch }) }
    },
    replaceDatabase: () => {
      database = {}
    },
    deleteThread: () => {
      row = null
    },
    setMetadata: (metadata: string) => {
      row = { ...row!, metadata }
    }
  }
}

describe("thread message page metadata invalidation", () => {
  it("returns the original verified page when its source is unchanged", async () => {
    const f = fixture()
    await expect(f.run()).resolves.toEqual({ attempt: 1, messages: ["verified-page-1"] })
    expect(f.sources).toHaveLength(1)
    expect(f.accepted).toEqual([{ attempt: 1 }])
    expect(f.sender.eventNames()).toEqual([])
  })

  it.each([
    ["llmModifiedFiles", ["new.ts"]],
    ["llmFileHistory", { "new.ts": { added: 1 } }],
    ["llmRecentlyRevertedFiles", ["new.ts"]]
  ])("reads a fresh page and witnesses once after %s changes", async (key, value) => {
    const f = fixture()
    f.onResponse((attempt) => {
      if (attempt === 1) f.patch({ [key as string]: value })
    })
    await expect(f.run()).resolves.toEqual({ attempt: 2, messages: ["verified-page-2"] })
    expect(f.sources).toHaveLength(2)
    expect(f.sources[0].verify).not.toBe(f.sources[1].verify)
    expect(f.accepted).toEqual([{ attempt: 2 }])
    expect(() => f.scopes[0].assertCurrent()).toThrow("MODS_CONVERSATION_THREAD_CHANGED")
    expect(f.sender.eventNames()).toEqual([])
  })

  it("rejects another metadata change on the replacement without a third read", async () => {
    const f = fixture()
    f.onResponse((attempt) => f.patch({ llmModifiedFiles: [`${attempt}.ts`] }))
    await expect(f.run()).rejects.toThrow("MODS_CONVERSATION_THREAD_CHANGED")
    expect(f.sources).toHaveLength(2)
    expect(f.accepted).toEqual([])
    expect(f.sender.eventNames()).toEqual([])
  })

  it.each([
    ["workspacePath", "/other"],
    ["agentMode", "workflow"],
    ["hostProjectRuntime", { projectId: "replacement", operationId: "other" }],
    ["remoteReadOnly", true],
    ["remoteState", "historical"],
    ["targetKind", "inbox"],
    ["parentThreadId", "other"],
    ["harnessFeature", { projectId: "other" }],
    ["unknownFutureAuthority", true],
    ["cmb_thread_incarnation", "replacement"]
  ])("does not retry a simultaneous change to %s", async (key, value) => {
    const f = fixture()
    f.onResponse(() => f.patch({ llmModifiedFiles: ["new.ts"], [key as string]: value }))
    await expect(f.run()).rejects.toThrow("MODS_CONVERSATION_THREAD_CHANGED")
    expect(f.sources).toHaveLength(1)
    expect(f.accepted).toEqual([])
  })

  it.each(["database", "deleted", "sender", "frame", "destroyed"])(
    "does not retry when the original %s changes",
    async (kind) => {
      const f = fixture()
      f.onResponse(() => {
        f.patch({ llmModifiedFiles: ["new.ts"] })
        if (kind === "database") f.replaceDatabase()
        if (kind === "deleted") f.deleteThread()
        if (kind === "sender") f.event.sender = new Sender()
        if (kind === "frame") f.sender.mainFrame = {}
        if (kind === "destroyed") f.sender.destroyed = true
      })
      await expect(f.run()).rejects.toThrow("MODS_CONVERSATION_THREAD_CHANGED")
      expect(f.sources).toHaveLength(1)
      expect(f.accepted).toEqual([])
      expect(f.sender.eventNames()).toEqual([])
    }
  )

  it("does not adopt a security change after the retryable failure was captured", async () => {
    const f = fixture()
    f.onResponse(() => f.patch({ llmModifiedFiles: ["new.ts"] }))
    f.beforeReject(() => f.patch({ workspacePath: "/revoked" }))
    await expect(f.run()).rejects.toThrow("MODS_CONVERSATION_THREAD_CHANGED")
    expect(f.sources).toHaveLength(1)
    expect(f.accepted).toEqual([])
  })

  it.each(["project", "database", "incarnation", "unknown", "deleted"])(
    "keeps the replacement's full source guard when %s changes",
    async (kind) => {
      const f = fixture()
      f.onResponse((attempt) => {
        if (attempt === 1) f.patch({ llmModifiedFiles: ["new.ts"] })
        else if (kind === "project")
          f.patch({ hostProjectRuntime: { projectId: "replacement", operationId: "other" } })
        else if (kind === "database") f.replaceDatabase()
        else if (kind === "incarnation") f.patch({ cmb_thread_incarnation: "replacement" })
        else if (kind === "unknown") f.patch({ unknownFutureAuthority: true })
        else f.deleteThread()
      })
      await expect(f.run()).rejects.toThrow("MODS_CONVERSATION_THREAD_CHANGED")
      expect(f.sources).toHaveLength(2)
      expect(f.accepted).toEqual([])
    }
  )

  it.each([undefined, { targetMessageId: "target" }])(
    "bounds background and targeted reads without a foreground owner: %j",
    async (options) => {
      const f = fixture()
      f.onResponse((attempt) => f.patch({ llmModifiedFiles: [`${attempt}.ts`] }))
      await expect(f.handler(f.event, { threadId: "thread", options })).rejects.toThrow(
        "MODS_CONVERSATION_THREAD_CHANGED"
      )
      expect(f.sources).toHaveLength(2)
      expect(f.accepted).toEqual([])
      expect(f.sender.eventNames()).toEqual([])
    }
  )

  it("preserves the independent worker-unavailable recovery for each captured read", async () => {
    const f = fixture()
    f.onResponse((attempt) => {
      if (attempt === 1 || attempt === 3) throw f.workerUnavailable
      if (attempt === 2) f.patch({ llmModifiedFiles: ["new.ts"] })
    })
    await expect(f.run()).resolves.toEqual({ attempt: 4, messages: ["verified-page-4"] })
    expect(f.sources).toHaveLength(4)
    expect(f.sources[0]).toBe(f.sources[1])
    expect(f.sources[2]).toBe(f.sources[3])
    expect(f.sources[0]).not.toBe(f.sources[2])
    expect(f.accepted).toEqual([{ attempt: 4 }])
    expect(f.warn).toHaveBeenCalledTimes(2)
  })

  it("does not retry forged errors or failed witness verification", async () => {
    const f = fixture()
    f.verify.mockImplementation(() => {
      throw Error("MODS_CONVERSATION_THREAD_CHANGED")
    })
    f.onResponse(() => f.patch({ llmModifiedFiles: ["new.ts"] }))
    await expect(f.run()).rejects.toThrow("MODS_CONVERSATION_THREAD_CHANGED")
    expect(f.sources).toHaveLength(1)
  })

  it("does not turn malformed or duplicate-key metadata into retry evidence", () => {
    for (const original of [null, "{", "[]", '{"workspacePath":"a","workspacePath":"b"}']) {
      const guard = createThreadDisplayMetadataGuard(
        original,
        () => '{"workspacePath":"b","llmModifiedFiles":[]}'
      )
      let failure: unknown
      try {
        guard.assertCurrent()
      } catch (error) {
        failure = error
      }
      expect(guard.canRetryMetadata(failure)).toBe(false)
    }
  })

  it("cannot borrow another original read's retryable error", () => {
    const before = '{"workspacePath":"a"}',
      after = '{"workspacePath":"a","llmFileHistory":{}}'
    const first = createThreadDisplayMetadataGuard(before, () => after)
    const second = createThreadDisplayMetadataGuard(before, () => after)
    let failure: unknown
    try {
      first.assertCurrent()
    } catch (error) {
      failure = error
    }
    expect(first.canRetryMetadata(failure)).toBe(true)
    expect(second.canRetryMetadata(failure)).toBe(false)
  })

  it("keeps navigation cancellation and renderer generation discard semantics", async () => {
    const f = fixture(),
      foreground = new ForegroundHydrationGeneration("thread")
    const token = foreground.capture("thread")!
    f.onResponse(() => {
      f.patch({ llmModifiedFiles: ["new.ts"] })
      foreground.transition("other")
      f.sender.emit("did-start-navigation")
    })
    await expect(f.run()).rejects.toMatchObject({ name: "AbortError" })
    expect(f.sources).toHaveLength(1)
    expect(foreground.isCurrent(token)).toBe(false)
    expect(f.accepted).toEqual([])
    expect(f.sender.eventNames()).toEqual([])
  })

  it("never lets an older foreground retry supersede a newer page request", async () => {
    const f = fixture()
    let newer: Promise<Page> | undefined
    f.onResponse((attempt) => {
      if (attempt === 1) f.patch({ llmModifiedFiles: ["new.ts"] })
    })
    f.beforeReject(() => {
      newer = f.run()
    })
    await expect(f.run()).rejects.toThrow("MODS_CONVERSATION_THREAD_CHANGED")
    await expect(newer).resolves.toEqual({ attempt: 2, messages: ["verified-page-2"] })
    expect(f.sources).toHaveLength(2)
    expect(f.accepted).toEqual([{ attempt: 2 }])
  })

  it("keeps navigation cancellation attached throughout the replacement read", async () => {
    const f = fixture()
    f.onResponse((attempt) => {
      if (attempt === 1) f.patch({ llmModifiedFiles: ["new.ts"] })
      else f.sender.emit("did-start-navigation")
    })
    await expect(f.run()).rejects.toMatchObject({ name: "AbortError" })
    expect(f.sources).toHaveLength(2)
    expect(f.accepted).toEqual([])
    expect(f.sender.eventNames()).toEqual([])
  })

  it("leaves a successful replacement subject to the original renderer navigation generation", async () => {
    const f = fixture(),
      foreground = new ForegroundHydrationGeneration("thread")
    const token = foreground.capture("thread")!
    f.onResponse((attempt) => {
      if (attempt === 1) f.patch({ llmModifiedFiles: ["new.ts"] })
      else foreground.transition("other")
    })
    await expect(f.run()).resolves.toEqual({ attempt: 2, messages: ["verified-page-2"] })
    expect(foreground.isCurrent(token)).toBe(false)
    expect(f.sources).toHaveLength(2)
  })

  it.each([undefined, { targetMessageId: "target" }])(
    "keeps the original renderer window intent for background or targeted responses: %j",
    async (options) => {
      const f = fixture(),
        windows = createThreadMessageWindowIntentCoordinator()
      const intent = windows.begin("thread", options ? "target" : "hydrate")
      f.onResponse((attempt) => {
        if (attempt === 1) f.patch({ llmModifiedFiles: ["new.ts"] })
        else windows.begin("thread", "target")
      })
      await expect(f.handler(f.event, { threadId: "thread", options })).resolves.toEqual({
        attempt: 2,
        messages: ["verified-page-2"]
      })
      expect(windows.isCurrent(intent)).toBe(false)
      expect(f.sources).toHaveLength(2)
    }
  )
})
