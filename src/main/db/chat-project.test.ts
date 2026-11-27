import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import {
  createThread,
  getDb,
  setThreadChatProject,
  updateThread,
  getThreadCore,
  initializeDatabase,
  closeDatabase
} from "./index"
import { saveWorkspaceProject, saveChatBinding, workspaceProject } from "./chat-project"
import { openNativeSqliteDatabase } from "./native-sqlite-adapter"
import {
  startChatProjectReporter,
  stopChatProjectReporter,
  notifyChatProjectEdit
} from "../services/chat-project-reporter"
import { getEventReporter } from "../services/event-reporter"
const config = vi.hoisted(() => ({ path: "" }))
vi.mock("../storage", () => ({
  getDbPath: () => config.path,
  getUserInfo: () => ({ sapId: "original" }),
  getMemorySessionOptInMigrationState: () => ({ migrated: true })
}))
vi.mock("../services/event-reporter", () => ({
  buildEvent: vi.fn((eventName, eventCategory, properties) => ({
    eventName,
    eventCategory,
    properties,
    sapId: "new-login",
    userName: "New user",
    ystId: "new-org"
  })),
  getEventReporter: vi.fn()
}))
const root = mkdtempSync(join(tmpdir(), "chat-project-test-"))
beforeAll(async () => {
  config.path = join(root, "threads.sqlite")
  const legacy = openNativeSqliteDatabase(config.path).database
  legacy.run(
    "CREATE TABLE workspace_project_defaults (path TEXT PRIMARY KEY, code TEXT NOT NULL, lean INTEGER NOT NULL)"
  )
  legacy.run("INSERT INTO workspace_project_defaults VALUES ('/old','P001',1)")
  legacy.close()
  await initializeDatabase()
})
afterAll(async () => {
  stopChatProjectReporter()
  await closeDatabase()
  rmSync(root, { recursive: true, force: true })
})

it("copies directory defaults once, isolates overrides, and keeps the pending historical mapping across restart", async () => {
  const a = { code: "临时A", name: "自定义名称", fromLean: false },
    b = { code: "P002", name: "精益项目名称", fromLean: true }
  const path = "/code/team"
  const create = (id: string, extra = {}) =>
    createThread(
      id,
      { workspacePath: path, ...extra },
      { newDurableTranscript: true, inheritWorkspaceProject: true }
    )
  const projectOf = (id: string) => JSON.parse(getThreadCore(id)!.metadata!).chatProject
  const db = getDb()
  expect(workspaceProject(db, "/old")).toEqual({ code: "P001", fromLean: true })
  saveWorkspaceProject(db, path, a)
  create("one")
  create("two")
  saveWorkspaceProject(db, path + "/", b)
  create("three")
  expect([projectOf("one"), projectOf("two"), projectOf("three")]).toEqual([a, a, b])
  setThreadChatProject("one", b)
  updateThread("one", { metadata: JSON.stringify({ workspacePath: path, chatProject: a }) })
  expect(projectOf("one")).toEqual(b)
  setThreadChatProject("two", null)
  saveChatBinding(db, "one", "chat", null, true)
  create("feature", { harnessFeature: { projectId: "h", slug: "f" } })
  expect(() => setThreadChatProject("feature", a)).toThrow("仅普通会话")
  expect(projectOf("feature")).toBeUndefined()
  saveWorkspaceProject(db, path, null)
  create("four")
  expect(projectOf("four")).toBeNull()
  await closeDatabase()
  await initializeDatabase()
  expect([projectOf("one"), projectOf("two"), projectOf("three")]).toEqual([b, null, b])
  expect(
    getDb().exec("SELECT mode,code,lean FROM chat_project_bindings WHERE thread_id='one'")[0].values
  ).toEqual([["chat", "P002", 1]])
})

it("stores the chosen default with the first conversation and rolls both back on failure", () => {
  const path = "/code/onboarding"
  const project = { code: "P006", fromLean: true }
  const options = { inheritWorkspaceProject: true, newWorkspaceProject: project }
  const db = getDb()
  // Force the last write to fail after the workspace and thread inserts succeeded.
  db.run(`CREATE TEMP TRIGGER fail_first_binding BEFORE INSERT ON chat_project_bindings
    WHEN new.thread_id='first' BEGIN SELECT RAISE(ABORT, 'test rollback'); END`)
  try {
    expect(() => createThread("first", { workspacePath: path }, options)).toThrow("test rollback")
    expect(getThreadCore("first")).toBeNull()
    expect(workspaceProject(db, path)).toBeNull()
  } finally {
    db.run("DROP TRIGGER fail_first_binding")
  }
  const first = createThread("first", { workspacePath: path }, options)
  expect(JSON.parse(first.metadata!).chatProject).toEqual(project)
  expect(workspaceProject(db, path)).toEqual(project)
})

it("tags generation and commit events with the current project and shares the lookup across files", async () => {
  const { buildEvent } = await vi.importActual<typeof import("../services/event-reporter")>(
    "../services/event-reporter"
  )
  const id = "root-of-child"
  createThread(id, {}, { inheritWorkspaceProject: true })
  setThreadChatProject(id, { code: "自定义", fromLean: false })
  const emit = (name: string) =>
    buildEvent(name, "code_adoption", { threadId: "child", rootThreadId: id }).properties
  const reads = vi.spyOn(getDb(), "exec")
  try {
    expect(emit("code_gen")).toMatchObject({
      generationMode: "chat",
      projectCode: "自定义",
      projectFromLean: false
    })
    expect(emit("code_adopt")).toMatchObject({ projectCode: "自定义" })
    expect(emit("code_commit_file")).not.toHaveProperty("projectCode")
    expect(
      reads.mock.calls.filter(([sql]) => sql.includes("SELECT sap_id,code,lean"))
    ).toHaveLength(1)
    setThreadChatProject(id, { code: "P004", fromLean: true })
    expect(emit("code_adopt")).toMatchObject({ projectCode: "P004", projectFromLean: true })
    setThreadChatProject(id, null)
    expect(emit("code_gen")).toMatchObject({ generationMode: "chat", projectCode: null })
  } finally {
    reads.mockRestore()
  }
})

it("ignores an old upload acknowledgement, retries offline delivery and retains the owner", async () => {
  const db = getDb()
  const id = "delivery"
  db.run("UPDATE chat_project_bindings SET next_attempt=NULL")
  createThread(id, {}, { newDurableTranscript: true, inheritWorkspaceProject: true })
  let release!: () => void
  const report = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, status: 200 })
        })
    )
    .mockResolvedValueOnce({ ok: false, retryable: true, retryAfterMs: 100 })
    .mockResolvedValue({ ok: true, status: 200 })
  vi.mocked(getEventReporter).mockReturnValue({ report })
  vi.useFakeTimers()
  try {
    startChatProjectReporter()
    await vi.advanceTimersByTimeAsync(1000)
    setThreadChatProject(id, { code: "P003", fromLean: true })
    notifyChatProjectEdit()
    release()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(report).toHaveBeenCalledTimes(2)
    expect(report.mock.calls[1][0].sapId).toBe("original")
    expect(report.mock.calls[0][0].eventId).not.toBe(report.mock.calls[1][0].eventId)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(report).toHaveBeenCalledTimes(3)
    expect(report.mock.calls[2][0].eventId).toBe(report.mock.calls[1][0].eventId)
    expect(report.mock.calls[2][0]).toMatchObject({
      eventName: "chat.project.binding",
      sapId: "original",
      userName: "original",
      properties: {
        rootThreadId: id,
        generationMode: "chat",
        projectCode: "P003",
        projectFromLean: true
      }
    })
    expect(report.mock.calls[2][0]).not.toHaveProperty("ystId")
    expect(
      db.exec("SELECT next_attempt FROM chat_project_bindings WHERE thread_id=?", [id])[0].values
    ).toEqual([[null]])
  } finally {
    stopChatProjectReporter()
    vi.useRealTimers()
  }
})
