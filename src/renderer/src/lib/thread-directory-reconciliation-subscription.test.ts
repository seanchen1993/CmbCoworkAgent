import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { expect, it, vi } from "vitest"
import {
  rendererTranscriptSourceScope, sameTranscriptIncarnation, ThreadResidentTranscripts
} from "./thread-resident-transcript"

/** Execute the real subscription argument. This also fails if the old
 * unconditional subscribe(reconcileDirectory) returns during a later refactor.
 */
function actualDirectorySubscriber() {
  const path = fileURLToPath(new URL("./thread-context.tsx", import.meta.url))
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let subscriber: ts.Expression | undefined
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "stopDirectory" &&
      node.initializer && ts.isCallExpression(node.initializer) &&
      node.initializer.expression.getText(source) === "useAppStore.subscribe")
      subscriber = node.initializer.arguments[0]
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!subscriber) throw Error("Actual directory subscriber missing")
  const reconcileDirectory = vi.fn(), wake = vi.fn()
  const callback = runInNewContext(ts.transpileModule(`(${subscriber.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText, { reconcileDirectory, wake }) as (state: object, previous: object) => void
  return { callback, reconcileDirectory, wake }
}

it("does no directory traversal for unrelated store updates but preserves every wake", () => {
  const { callback, reconcileDirectory, wake } = actualDirectorySubscriber()
  const directory = { threads: [], currentThreadId: "A", accountRevision: 0 }
  for (let index = 0; index < 1000; index++)
    callback({ ...directory, windowFocused: index % 2 === 0 }, directory)
  expect(reconcileDirectory).not.toHaveBeenCalled()
  expect(wake).toHaveBeenCalledTimes(1000)
})

it("reconciles actual immutable directory, selection and account changes", () => {
  const { callback, reconcileDirectory, wake } = actualDirectorySubscriber()
  const directory = { threads: [], currentThreadId: "A", accountRevision: 0 }
  for (const change of [{ threads: [] }, { currentThreadId: "B" },
    { currentThreadId: null }, { accountRevision: 1 }]) callback({ ...directory, ...change }, directory)
  expect(reconcileDirectory).toHaveBeenCalledTimes(4)
  expect(wake).not.toHaveBeenCalled()
})

type DirectoryRow = Parameters<typeof rendererTranscriptSourceScope>[0] & { thread_id: string }
type DirectorySource = ReturnType<typeof rendererTranscriptSourceScope>

/** Run the actual reconciliation closure, including its restore/owner ordering. */
function actualDirectoryReconciler(rows: DirectoryRow[], ids: string[],
  missing?: { id: string; restore: DirectorySource }) {
  const path = fileURLToPath(new URL("./thread-context.tsx", import.meta.url))
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const matches: ts.ArrowFunction[] = []
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "reconcileDirectory" &&
      node.initializer && ts.isArrowFunction(node.initializer)) matches.push(node.initializer)
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (matches.length !== 1) throw Error("Actual directory reconciliation must be unique")
  const initialized = new Set(ids), scopes = new Map<string, DirectorySource>()
  const residents = new ThreadResidentTranscripts(), wake = vi.fn()
  const observe = vi.fn(() => missing?.restore)
  const initialize = vi.fn((id: string, scope: DirectorySource) => {
    initialized.add(id)
    residents.enter(id, scope)
  })
  const reset = vi.fn((id: string, scope: DirectorySource) => residents.enter(id, scope))
  const reconcile = runInNewContext(ts.transpileModule(
    `let reconciling = false; (${matches[0].getText(source)})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
    }).outputText, {
    useAppStore: { getState: () => ({ threads: rows, currentThreadId: missing?.id,
      accountRevision: 3 }) },
    currentMissingSource: { threadId: missing?.id, observe }, isThreadRetired: () => false,
    initializeThread: initialize, initializedThreadsRef: { current: initialized },
    rendererTranscriptSourceScope, sameTranscriptIncarnation, directoryScopes: scopes,
    residentTranscripts: residents, resetResidentTranscript: reset, wake
  }) as () => void
  return { reconcile, initialized, scopes, residents, observe, initialize, reset, wake }
}

const directoryRow = (id: string, token: string, workspacePath?: string): DirectoryRow => ({
  thread_id: id, created_at: new Date(1),
  metadata: { cmb_thread_incarnation: token, ...(workspacePath ? { workspacePath } : {}) }
})

it("keeps the first duplicate row and includes a resident restored before indexing", () => {
  const first = directoryRow("A", "first", "C:/first")
  const second = directoryRow("A", "second", "C:/second")
  const restored = rendererTranscriptSourceScope(first)
  const f = actualDirectoryReconciler([first, second], [], { id: "A", restore: restored })
  f.reconcile()
  expect(f.observe).toHaveBeenCalledExactlyOnceWith({ currentThreadId: "A", account: 3,
    retired: false, rowPresent: true, scope: restored })
  expect(f.initialize).toHaveBeenCalledExactlyOnceWith("A", restored)
  expect(f.scopes.get("A")).toEqual(restored)
  expect(f.residents.get("A")?.scope).toEqual(restored)
  expect(f.wake).toHaveBeenCalledTimes(1)
})

it("keeps missing/stale/new-incarnation and workspace-only resident decisions", () => {
  const row = directoryRow("A", "actual", "C:/new-workspace")
  const f = actualDirectoryReconciler([row], ["A", "missing"])
  const actual = rendererTranscriptSourceScope(row)
  f.scopes.set("A", rendererTranscriptSourceScope(directoryRow("A", "previous")))
  const current = f.residents.enter("A", actual)
  f.reconcile()
  expect(f.reset).not.toHaveBeenCalled() // A newer page already owns this incarnation.
  expect(f.residents.get("A")).toBe(current)
  expect(f.scopes.has("missing")).toBe(true)
  expect(f.scopes.get("missing")).toBeUndefined()
  f.residents.enter("A", rendererTranscriptSourceScope(directoryRow("A", "old")))
  f.scopes.set("A", rendererTranscriptSourceScope(directoryRow("A", "previous")))
  f.reconcile()
  expect(f.reset).toHaveBeenCalledExactlyOnceWith("A", actual)
  const same = f.residents.enter("A", rendererTranscriptSourceScope(
    directoryRow("A", "actual", "C:/old-workspace")))
  f.reconcile()
  expect(f.residents.get("A")).toBe(same)
  expect(same.scope).toEqual(actual)
  expect(f.reset).toHaveBeenCalledTimes(1)
})

it("scans directory IDs at most once for many residents and skips empty residents", () => {
  let reads = 0
  const rows = Array.from({ length: 10000 }, (_, index) => ({
    get thread_id() { reads++; return `row-${index}` },
    created_at: new Date(1), metadata: {}
  }))
  const ids = ["row-9999", "row-8000", "row-7000", "absent"]
  const f = actualDirectoryReconciler(rows, ids)
  f.reconcile()
  // One directory pass plus one original source-scope conversion per found resident.
  expect(reads).toBe(rows.length + ids.length - 1)
  reads = 0
  actualDirectoryReconciler(rows, []).reconcile()
  expect(reads).toBe(0)
})
