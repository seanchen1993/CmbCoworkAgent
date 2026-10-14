import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { describe, expect, it, vi } from "vitest"

function historyHandler(scope: object) {
  const source = ts.createSourceFile(
    "threads.ts",
    readFileSync(resolve("src/main/ipc/threads.ts"), "utf8"),
    ts.ScriptTarget.Latest,
    true
  )
  const handlers: ts.Expression[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(source) === "ipcMain" &&
      node.expression.name.text === "handle" &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === "threads:history"
    ) {
      handlers.push(node.arguments[1])
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  expect(handlers).toHaveLength(1)
  const code = ts.transpileModule(`(${handlers[0].getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  return runInNewContext(code, scope) as (
    event: object,
    threadId: string
  ) => Promise<HistoryTuple[]>
}

function storedTuple() {
  return {
    config: { configurable: { thread_id: "history-thread", checkpoint_id: "checkpoint-1" } },
    parentConfig: { configurable: { thread_id: "history-thread", checkpoint_id: "parent-1" } },
    checkpoint: {
      id: "checkpoint-1",
      channel_values: { messages: [{ id: "message-1", content: "stored message" }] }
    },
    metadata: { source: "loop", step: 2, writes: { model: "original metadata" } },
    pendingWrites: [["task-1", "messages", { content: "HIDDEN_PENDING_CONTEXT" }]]
  }
}

type HistoryTuple = ReturnType<typeof storedTuple>
type Present = (display: HistoryTuple["checkpoint"], view?: object) => unknown

function fixture(options: { mode: "canonical" | "legacy" | "failure"; failure?: unknown }) {
  const tuple = storedTuple()
  const rawBefore = JSON.stringify(tuple)
  const safe = {
    id: tuple.checkpoint.id,
    channel_values: { messages: [{ id: "message-1", content: "visible message" }] }
  }
  const event = { sender: { id: 10 } }
  const read = {
    row: { id: "history-thread" },
    signal: new AbortController().signal,
    assertCurrent: vi.fn(),
    dispose: vi.fn()
  }
  const list = vi.fn(async function* () {
    yield tuple
  })
  const saver = { list }
  const capture = vi.fn(() => read)
  const warn = vi.fn()
  const display = vi.fn(
    async (
      checkpointer: object,
      actual: HistoryTuple,
      threadId: string,
      row: object,
      signal: AbortSignal,
      assertCurrent: () => void,
      present: Present
    ) => {
      expect(checkpointer).toBe(saver)
      expect(actual).toBe(tuple)
      expect(threadId).toBe("history-thread")
      expect(row).toBe(read.row)
      expect(signal).toBe(read.signal)
      expect(assertCurrent).toBe(read.assertCurrent)
      if (options.mode === "failure") throw options.failure
      // This stub selects the display callback branch, not a production Source qualification.
      return present(
        options.mode === "canonical" ? safe : actual.checkpoint,
        options.mode === "canonical" ? Object.freeze({}) : undefined
      )
    }
  )
  const handler = historyHandler({
    captureThreadDisplayRead: capture,
    withCheckpointer: async (_threadId: string, run: (value: object) => Promise<unknown>) =>
      run(saver),
    displayCheckpointTuple: display,
    console: { warn }
  })
  return { tuple, rawBefore, safe, event, read, list, capture, warn, display, handler }
}

describe("threads:history display tuples", () => {
  it("filters canonical pending writes from the full public tuple without changing Saver data", async () => {
    const f = fixture({ mode: "canonical" })
    const history = await f.handler(f.event, "history-thread")
    expect(history).toEqual([{ ...f.tuple, checkpoint: f.safe, pendingWrites: [] }])
    expect(JSON.stringify(history)).not.toContain("HIDDEN_PENDING_CONTEXT")
    expect(history[0].metadata).toBe(f.tuple.metadata)
    expect(history[0].parentConfig).toBe(f.tuple.parentConfig)
    expect(JSON.stringify(f.tuple)).toBe(f.rawBefore)
    expect(f.tuple.pendingWrites[0][2]).toEqual({ content: "HIDDEN_PENDING_CONTEXT" })
    expect(f.capture).toHaveBeenCalledWith(f.event, "history-thread")
    expect(f.list).toHaveBeenCalledExactlyOnceWith(
      { configurable: { thread_id: "history-thread" } },
      { limit: 50 }
    )
    expect(f.display).toHaveBeenCalledTimes(1)
    expect(f.read.dispose).toHaveBeenCalledTimes(1)
    expect(f.warn).not.toHaveBeenCalled()
  })

  it("preserves the complete legacy tuple, pending writes and metadata when there is no view", async () => {
    const f = fixture({ mode: "legacy" })
    const history = await f.handler(f.event, "history-thread")
    expect(history).toEqual([f.tuple])
    expect(history[0].pendingWrites).toBe(f.tuple.pendingWrites)
    expect(history[0].metadata).toBe(f.tuple.metadata)
    expect(history[0].checkpoint).toBe(f.tuple.checkpoint)
    expect(JSON.stringify(f.tuple)).toBe(f.rawBefore)
    expect(f.display).toHaveBeenCalledTimes(1)
    expect(f.read.dispose).toHaveBeenCalledTimes(1)
    expect(f.warn).not.toHaveBeenCalled()
  })

  it("propagates display failures including undefined and always disposes the read scope", async () => {
    for (const failure of [new Error("display failed"), undefined]) {
      const f = fixture({ mode: "failure", failure })
      await expect(f.handler(f.event, "history-thread")).rejects.toBe(failure)
      expect(f.warn).toHaveBeenCalledExactlyOnceWith("Failed to get thread history:", failure)
      expect(f.display).toHaveBeenCalledTimes(1)
      expect(f.read.dispose).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(f.tuple)).toBe(f.rawBefore)
    }
  })
})
