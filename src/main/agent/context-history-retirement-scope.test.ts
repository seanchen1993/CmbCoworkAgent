import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, isAbsolute } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { expect, it, vi } from "vitest"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

/** Execute the current production function body. Only the resolver/migration
 * await edges are injected; this is not a full resolver or IPC end-to-end test.
 */
function actualDelete(dependencies: Record<string, unknown>) {
  const path = fileURLToPath(new URL("./context-history-path.ts", import.meta.url))
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true)
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) &&
    node.name?.text === "deleteProjectThreadDataDirectory")
  if (!declaration) throw Error("Production retirement function missing")
  const body = declaration.getText(source).replace(/^export\s+/, "")
  const output = ts.transpileModule(body, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None
  } }).outputText
  return runInNewContext(output + "\ndeleteProjectThreadDataDirectory", dependencies) as
    (workspace: string, threadId: string, home?: string, current?: () => void) => Promise<void>
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mods-retirement-context-"))
  const paths = [join(root, "managed", "thread"), join(root, "legacy", "thread")]
  for (const path of paths) { mkdirSync(path, { recursive: true }); writeFileSync(join(path, "owner.txt"), "OLD") }
  const database = new DatabaseSync(":memory:")
  database.exec("CREATE TABLE threads(thread_id TEXT PRIMARY KEY,metadata TEXT)")
  const guard = () => {
    if (database.prepare("SELECT 1 FROM threads WHERE thread_id=?").get("thread"))
      throw Error("DELETED_THREAD_SOURCE_RETIRED")
  }
  const recreate = () => {
    database.prepare("INSERT INTO threads VALUES(?,?)").run("thread", '{"cmb_thread_incarnation":"NEW"}')
    for (const path of paths) writeFileSync(join(path, "owner.txt"), "NEW")
  }
  const remove = vi.fn(async (path: string, options: { recursive: boolean; force: boolean }) => {
    const suffix = relative(root, path)
    if (suffix.startsWith("..") || isAbsolute(suffix)) throw Error("Fixture attempted external deletion")
    await rm(path, options)
  })
  return { root, paths, database, guard, recreate, remove,
    close: () => { database.close(); rmSync(root, { recursive: true, force: true }) } }
}

it.each(["candidates", "migration", "user-home"] as const)(
  "does not clear caches or remove a new owner after held %s discovery", async edge => {
    const f = fixture(), entered = deferred<void>(), release = deferred<unknown>()
    const clear = vi.fn()
    const migrations = new Map<string, Promise<unknown>>([
      [f.paths[0], edge === "migration" ? release.promise : Promise.resolve()]
    ])
    const get = migrations.get.bind(migrations)
    vi.spyOn(migrations, "get").mockImplementation(path => {
      if (edge === "migration") entered.resolve()
      return get(path)
    })
    const deletingCache = vi.spyOn(migrations, "delete")
    const deleting = actualDelete({ threadDataMigrations: migrations,
      clearCompletedThreadDataMigrationsForTarget: clear, rm: f.remove,
      getProjectThreadDataDirectoryReadCandidates: async () => {
        if (edge === "candidates") { entered.resolve(); return release.promise }
        return f.paths
      },
      getProjectThreadDataDirectory: async () => { entered.resolve(); return release.promise }
    })
    const task = deleting(f.root, "thread", edge === "user-home" ? join(f.root, "home") : undefined,
      f.guard).then(() => undefined, error => error)
    try {
      await entered.promise
      f.recreate()
      release.resolve(edge === "candidates" ? f.paths : edge === "user-home" ? f.paths[0] : undefined)
      expect(await task).toMatchObject({ message: "DELETED_THREAD_SOURCE_RETIRED" })
      expect(clear).not.toHaveBeenCalled()
      expect(deletingCache).not.toHaveBeenCalled()
      expect(f.remove).not.toHaveBeenCalled()
      expect(migrations.has(f.paths[0])).toBe(true)
      for (const path of f.paths) expect(readFileSync(join(path, "owner.txt"), "utf8")).toBe("NEW")
    } finally {
      release.resolve(edge === "candidates" ? f.paths : edge === "user-home" ? f.paths[0] : undefined)
      await task
      f.close()
    }
  }
)

it("still clears the original caches and physically removes owned directories for a current source", async () => {
  const f = fixture(), clear = vi.fn()
  const migrations = new Map([[f.paths[0], Promise.resolve()]])
  const deleting = actualDelete({ threadDataMigrations: migrations,
    clearCompletedThreadDataMigrationsForTarget: clear, rm: f.remove,
    getProjectThreadDataDirectoryReadCandidates: async () => f.paths })
  try {
    await deleting(f.root, "thread", undefined, f.guard)
    expect(clear).toHaveBeenCalledTimes(2)
    expect(migrations.size).toBe(0)
    expect(f.remove).toHaveBeenCalledTimes(2)
    for (const path of f.paths) expect(existsSync(path)).toBe(false)
  } finally { f.close() }
})
