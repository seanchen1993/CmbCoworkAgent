import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { expect, it, vi } from "vitest"
import {
  currentGitReadSignal,
  runWithGitReadSignal,
  throwIfGitReadCancelled
} from "../services/git-read-context"

const source = ts.createSourceFile(
  "models.ts",
  readFileSync(new URL("./models.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true
)
const declarations = source.statements.filter(
  (node) =>
    ts.isFunctionDeclaration(node) &&
    ["getCachedPromise", "probeWorkspaceGitContext"].includes(node.name?.text ?? "")
)
const compiled = ts.transpileModule(
  declarations.map((node) => node.getText(source)).join("\n") + "\nprobeWorkspaceGitContext",
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
).outputText

function fixture() {
  const clock = { now: 0 }
  const discover = vi.fn(async (path: string) => [
    {
      repoPath: path,
      gitRoot: path,
      workspaceRelativePath: ".",
      displayPath: ".",
      isWorkspaceRoot: true
    }
  ])
  const worktree = vi.fn(async () => false)
  const cache = new Map()
  const probe = runInNewContext(compiled, {
    workspaceProbeCache: cache,
    getCacheKeyForPath: (path: string) => path.toLowerCase(),
    discoverWorkspaceGitRepositories: discover,
    detectIsWorktreePath: worktree,
    currentGitReadSignal,
    throwIfGitReadCancelled,
    Date: { now: () => clock.now }
  }) as (path: string, reuse: boolean) => Promise<{ gitRoot: string | null }>
  return { probe, clock, discover, worktree, cache }
}

function workspaceHandler(name: string, cache: Map<unknown, unknown>) {
  let handler: ts.Expression | undefined
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "ipcMain.handle" &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === name
    )
      handler = node.arguments[1]
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!handler) throw Error("Missing actual workspace handler")
  const code = ts.transpileModule(
    "(" + handler.getText(source).replaceAll('await import("../db")', "testDatabase") + ")",
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
  ).outputText
  let metadata: Record<string, unknown> = { workspacePath: "C:/repo" }
  const read = () => ({ metadata: JSON.stringify(metadata) })
  const context = {
    workspaceProbeCache: cache,
    getCacheKeyForPath: (path: string) => path.toLowerCase(),
    GLOBAL_WORKSPACE_MUTATION_KEY: "global",
    workspaceMutationGate: { begin: () => 1, isCurrent: () => true, finish: () => {} },
    getThreadCoreSync: read,
    testDatabase: { getThreadCore: read },
    captureThreadIncarnation: () => ({}),
    assertThreadIncarnationCurrent: () => {},
    BrowserWindow: { fromWebContents: () => ({}) },
    store: { get: () => "C:/repo", set: () => {} },
    fs: { access: async () => {} },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ["C:/repo"] }) },
    prepareWorkspaceSelectionSandbox: async () => true,
    assertWorkspaceSwitchAllowed: async () => {},
    parseThreadMetadata: JSON.parse,
    workflowRunManager: { withThreadTransitionLease: (_id: string, run: () => unknown) => run() },
    withThreadRunMutationLock: (_id: string, run: () => unknown) => run(),
    assertNoThreadTranscriptBeforeWorkspaceChange: async () => true,
    mutateLatestThreadMetadata: (_id: string, update: (value: Record<string, unknown>) => void) => {
      const next = { ...metadata }
      update(next)
      metadata = next
    },
    bindThreadWorkspace: (value: Record<string, unknown>, path: string) => {
      value.workspacePath = path
    },
    startWatching: async () => "existing",
    resolveWorkspaceMutationPublication: () => ({ committed: true })
  }
  return runInNewContext(code, context) as (
    event: { sender: object },
    input: unknown
  ) => Promise<unknown>
}

it("reuses the settled mount probe across rapid chat switches and expires it", async () => {
  const f = fixture()
  for (let i = 0; i < 24; i++) expect((await f.probe("C:/repo", true)).gitRoot).toBe("C:/repo")
  expect(f.discover).toHaveBeenCalledTimes(1)
  expect(f.worktree).toHaveBeenCalledTimes(1)
  f.clock.now = 10_000
  await f.probe("C:/repo", true)
  expect(f.discover).toHaveBeenCalledTimes(2)
  await f.probe("C:/repo", false)
  expect(f.discover).toHaveBeenCalledTimes(3)
  await f.probe("C:/repo", true)
  expect(f.discover).toHaveBeenCalledTimes(4)
})

it("bounds workspaces and does not retain failed probes", async () => {
  const f = fixture()
  for (let i = 0; i < 70; i++) await f.probe("C:/repo-" + i, true)
  expect(f.cache.size).toBe(64)
  expect(f.cache.has("c:/repo-0")).toBe(false)
  f.discover.mockRejectedValueOnce(Error("read failed"))
  await expect(f.probe("C:/failed", true)).rejects.toThrow("read failed")
  await f.probe("C:/failed", true)
  expect(f.cache.has("c:/failed")).toBe(true)
})

it.each(["workspace:set", "workspace:select"])(
  "refreshes the next mount probe when the actual %s handler reselects the directory",
  async (name) => {
    const f = fixture()
    await f.probe("C:/repo", true)
    const handler = workspaceHandler(name, f.cache)
    const input = name === "workspace:set" ? { threadId: "chat", path: "C:/repo" } : "chat"
    expect(await handler({ sender: {} }, input)).toBe("C:/repo")
    await f.probe("C:/repo", true)
    expect(f.discover).toHaveBeenCalledTimes(2)
  }
)

it("does not let an aborted old probe poison the replacement's cached result", async () => {
  const f = fixture()
  const gate = Promise.withResolvers<Awaited<ReturnType<typeof f.discover>>>()
  f.discover.mockReturnValueOnce(gate.promise)
  const old = new AbortController(),
    next = new AbortController()
  const previous = runWithGitReadSignal(old.signal, () => f.probe("C:/repo", true))
  const rejected = expect(previous).rejects.toThrow("superseded")
  old.abort(Error("superseded"))
  expect(await runWithGitReadSignal(next.signal, () => f.probe("C:/repo", true))).toEqual(
    expect.objectContaining({ gitRoot: "C:/repo" })
  )
  gate.resolve([])
  await rejected
  await f.probe("C:/repo", true)
  expect(f.discover).toHaveBeenCalledTimes(2)
})

function promiseCacheFixture() {
  const clock = { now: 0 }
  const cache = new Map()
  const get = runInNewContext(
    ts.transpileModule(
      declarations.map((node) => node.getText(source)).join("\n") + "\ngetCachedPromise",
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
    ).outputText,
    { currentGitReadSignal, Date: { now: () => clock.now } }
  ) as <T>(cache: Map<unknown, unknown>, key: string, ttl: number, read: () => Promise<T>) => Promise<T>
  return { clock, cache, get: <T>(key: string, read: () => Promise<T>) => get(cache, key, 1000, read) }
}

it("bounds all shared Git read caches and sweeps expired paths without revisiting them", async () => {
  const f = promiseCacheFixture()
  for (let i = 0; i < 200; i++) await f.get("repo-" + i, async () => i)
  expect(f.cache.size).toBe(64)
  expect(f.cache.has("repo-0")).toBe(false)
  f.clock.now = 1000
  await f.get("new-repo", async () => "new")
  expect([...f.cache.keys()]).toEqual(["new-repo"])
})

it("keeps pending reads coalesced under capacity pressure and trims after completion", async () => {
  const f = promiseCacheFixture()
  const gates = Array.from({ length: 70 }, () => Promise.withResolvers<number>())
  const pending = gates.map((gate, i) => f.get("repo-" + i, () => gate.promise))
  expect(f.cache.size).toBe(70)
  f.clock.now = 2000
  const duplicate = vi.fn(async () => -1)
  expect(f.get("repo-0", duplicate)).toBe(pending[0])
  expect(duplicate).not.toHaveBeenCalled()
  gates.forEach((gate, i) => gate.resolve(i))
  expect(await Promise.all(pending)).toEqual(gates.map((_, i) => i))
  expect(f.cache.size).toBe(64)
})

it("isolates cancellable cache reads without an old failure removing the successor", async () => {
  const f = promiseCacheFixture()
  const first = Promise.withResolvers<number>()
  const second = Promise.withResolvers<number>()
  const previous = runWithGitReadSignal(new AbortController().signal,
    () => f.get("repo", () => first.promise))
  const failed = expect(previous).rejects.toThrow("old read cancelled")
  const current = runWithGitReadSignal(new AbortController().signal,
    () => f.get("repo", () => second.promise))
  expect(current).not.toBe(previous)
  first.reject(Error("old read cancelled"))
  await failed
  second.resolve(2)
  expect(await current).toBe(2)
  const duplicate = vi.fn(async () => 3)
  expect(await f.get("repo", duplicate)).toBe(2)
  expect(duplicate).not.toHaveBeenCalled()
})
