import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { describe, expect, it, vi } from "vitest"
import { captureThreadIncarnation, matchesThreadIncarnation } from "../services/thread-incarnation"

const source = ts.createSourceFile("agent.ts", readFileSync(resolve("src/main/ipc/agent.ts"), "utf8"),
  ts.ScriptTarget.Latest, true)

function fixture() {
  let database = {}
  let row: { created_at: number; metadata: string } | null = {
    created_at: 1,
    metadata: JSON.stringify({ workspacePath: "C:/original", cmb_thread_incarnation: "original" })
  }
  let resolveWorkspace!: (value: string | undefined) => void
  const workspace = new Promise<string | undefined>(resolve => { resolveWorkspace = resolve })
  const restore = vi.fn(async (_options: unknown): Promise<unknown[]> => [])
  const bind = vi.fn(), track = vi.fn(() => "binding"), send = vi.fn(), snapshots = vi.fn(() => [])
  const window = { isDestroyed: () => false }
  let helper: ts.FunctionDeclaration | undefined, endpoint: ts.Expression | undefined
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "captureCoordinatorWorkerRestoreSource")
      helper = node
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(source) === "ipcMain" && node.expression.name.text === "handle" &&
      ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === "agent:coordinator-workers")
      endpoint = node.arguments[1]
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!helper || !endpoint) throw Error("Actual source guard/endpoint missing")
  const code = ts.transpileModule(`${helper.getText(source)}\n;({ capture: captureCoordinatorWorkerRestoreSource, endpoint: ${endpoint.getText(source)} })`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  const compiled = runInNewContext(code, {
    getDb: () => database,
    getThreadRuntimeScope: () => row,
    captureThreadIncarnation, matchesThreadIncarnation,
    parseStandardThreadMetadata: (metadata: string | null) => JSON.parse(metadata ?? "{}"),
    readCoordinatorWorkspacePath: () => workspace,
    BrowserWindow: { fromWebContents: () => window },
    beginCoordinatorWorkerRestore: () => new AbortController(),
    finishCoordinatorWorkerRestore: vi.fn(),
    trackCoordinatorWorkerUpdateBinding: track,
    sendCoordinatorWorkerEventToChannels: send,
    coordinatorWorkerManager: { restoreWorkersForThread: restore, bindWorkerUpdates: bind, readWorkers: snapshots },
    limitCoordinatorWorkersForRenderer: (value: unknown) => value,
    DOMException, Error, console: { warn: vi.fn() }
  }) as {
    capture: (threadId: string) => { assertCurrent(): void } | undefined
    endpoint: (event: object, payload: object) => Promise<unknown[]>
  }
  return {
    ...compiled, restore, bind, track, send, snapshots, resolveWorkspace,
    invoke: (subscribeUpdates = true) => compiled.endpoint({ sender: {} }, { threadId: "thread", subscribeUpdates }),
    replace: () => { row = { created_at: 2, metadata: JSON.stringify({ workspacePath: "C:/original", cmb_thread_incarnation: "replacement" }) } },
    changeWorkspace: () => { row = { ...row!, metadata: JSON.stringify({ workspacePath: "C:/replacement", cmb_thread_incarnation: "original" }) } },
    changeTitle: () => { row = { ...row!, metadata: JSON.stringify({ workspacePath: "C:/original", cmb_thread_incarnation: "original", title: "new" }) } },
    deleteRow: () => { row = null },
    replaceDatabase: () => { database = {} }
  }
}

describe("actual coordinator history IPC source scope", () => {
  it.each(["replace", "changeWorkspace", "deleteRow", "replaceDatabase"] as const)(
    "refuses %s during the original workspace await before binding or restore", async change => {
      const f = fixture(), result = f.invoke()
      f[change]()
      f.resolveWorkspace("C:/original")
      expect(await result).toEqual([])
      expect(f.track).not.toHaveBeenCalled()
      expect(f.restore).not.toHaveBeenCalled()
      expect(f.bind).not.toHaveBeenCalled()
      expect(f.snapshots).not.toHaveBeenCalled()
    }
  )

  it("retains same-incarnation title changes and passes a host guard into the real restore call", async () => {
    const f = fixture(), result = f.invoke()
    f.changeTitle()
    f.resolveWorkspace("C:/original")
    await result
    expect(f.restore).toHaveBeenCalledOnce()
    const options = f.restore.mock.calls[0][0] as unknown as { assertCurrent(): void }
    expect(options.assertCurrent).toBeTypeOf("function")
    expect(() => options.assertCurrent()).not.toThrow()
    f.replace()
    expect(() => options.assertCurrent()).toThrow("Coordinator worker source changed")
  })

  it("drops old updates and old restore responses after same-ID replacement", async () => {
    const f = fixture()
    let finish!: () => void
    f.restore.mockImplementation(() => new Promise(resolve => { finish = () => resolve([]) }))
    const result = f.invoke()
    f.resolveWorkspace("C:/original")
    await vi.waitFor(() => expect(f.restore).toHaveBeenCalledOnce())
    const options = f.restore.mock.calls[0][0] as unknown as { onUpdate(event: object): void }
    f.replace()
    options.onUpdate({ worker: {} })
    finish()
    expect(await result).toEqual([])
    expect(f.send).not.toHaveBeenCalled()
    expect(f.snapshots).not.toHaveBeenCalled()
  })

  it("does not revive an absent host row", async () => {
    const f = fixture()
    f.deleteRow()
    expect(await f.invoke()).toEqual([])
    expect(f.restore).not.toHaveBeenCalled()
  })
})
