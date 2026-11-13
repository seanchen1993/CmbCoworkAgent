import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { expect, it, vi } from "vitest"

const source = ts.createSourceFile("threads.ts", readFileSync(resolve("src/main/ipc/threads.ts"), "utf8"),
  ts.ScriptTarget.Latest, true)
function handler(channel: string, scope: object) {
  let expression: ts.Expression | undefined, notifier: ts.FunctionDeclaration | undefined
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "notifyCommittedThreadChange") notifier = node
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(source) === "ipcMain" && node.expression.name.text === "handle" &&
      ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === channel) expression = node.arguments[1]
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!expression || !notifier) throw Error("actual handler missing")
  const code = ts.transpileModule(`${notifier.getText(source)}\n;(${expression.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  return runInNewContext(code, scope) as (event: null, input: unknown) => Promise<unknown>
}
function fixture(count = 1) {
  const row = { created_at: 123, metadata: '{"workspacePath":"C:/actual"}' }
  const notify = vi.fn(), write = vi.fn(() => count), core = vi.fn(() => row)
  class ThreadMutationLeaseExpiredError extends Error {}
  const append = handler("threads:appendMessages", {
    captureThreadMutationLease: () => ({}),
    withThreadMutationLeaseLock: async (_lease: unknown, work: () => unknown) => work(),
    normalizeIpcThreadMessage: (message: unknown) => message,
    upsertThreadMessages: write, getThreadCore: core,
    notifyRemoteThreadChanged: notify, ThreadMutationLeaseExpiredError, Array
  })
  return { append, row, notify, write, core, ThreadMutationLeaseExpiredError }
}

it("notifies from the actual committed row only after a successful append", async () => {
  const f = fixture(), order: string[] = []
  f.write.mockImplementation(() => { order.push("commit"); return 1 })
  f.notify.mockImplementation(() => { order.push("notify") })
  expect(await f.append(null, { threadId: "thread", messages: [{ id: "actual" }] })).toEqual({ count: 1 })
  expect(order).toEqual(["commit", "notify"])
  expect(f.notify).toHaveBeenCalledExactlyOnceWith("thread", "transcript", f.row)
})

it("does not notify for empty, malformed, failed or expired appends", async () => {
  const f = fixture(0)
  expect(await f.append(null, { threadId: "thread", messages: [] })).toEqual({ count: 0 })
  expect(await f.append(null, { threadId: "thread", messages: null })).toEqual({ count: 0 })
  const failure = Error("original write failed")
  f.write.mockImplementation(() => { throw failure })
  await expect(f.append(null, { threadId: "thread", messages: [{}] })).rejects.toBe(failure)
  f.write.mockImplementation(() => { throw new f.ThreadMutationLeaseExpiredError() })
  expect(await f.append(null, { threadId: "thread", messages: [{}] })).toEqual({ count: 0 })
  expect(f.notify).not.toHaveBeenCalled()
})

it("does not turn a committed append into failure when a renderer observer throws", async () => {
  const f = fixture()
  f.notify.mockImplementation(() => { throw Error("observer disappeared") })
  expect(await f.append(null, { threadId: "thread", messages: [{}] })).toEqual({ count: 1 })
  expect(f.write).toHaveBeenCalledTimes(1)
})

it("waits for thread creation and uses the host row rather than renderer metadata as the hint", async () => {
  const row = { created_at: 123, metadata: '{"workspacePath":"C:/actual"}' }, notify = vi.fn()
  let finish!: (value: { thread_id: string }) => void
  const create = handler("threads:create", {
    validateRendererThreadCreateMetadata() {},
    createThreadService: () => new Promise(resolve => { finish = resolve }),
    getThreadCore: () => row, notifyRemoteThreadChanged: notify
  })
  const creating = create(null, { workspacePath: "C:/renderer" })
  expect(notify).not.toHaveBeenCalled()
  finish({ thread_id: "actual" })
  await creating
  expect(notify).toHaveBeenCalledExactlyOnceWith("actual", "created", row)
})
