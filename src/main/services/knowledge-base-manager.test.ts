import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { KnowledgeWorkspaceRole } from "../../shared/knowledge-base-types"

const mocks = vi.hoisted(() => ({
  getUserInfo: vi.fn(),
  getThreadCore: vi.fn(),
  syncKnowledgeRepository: vi.fn(),
  knowledgeWorkspaceHasChanges: vi.fn()
}))
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return { ...actual, rm: vi.fn(actual.rm) }
})
vi.mock("../storage", () => ({ getUserInfo: mocks.getUserInfo }))
vi.mock("../db", () => ({ getThreadCore: mocks.getThreadCore }))
vi.mock("./knowledge-repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./knowledge-repository")>()),
  syncKnowledgeRepository: mocks.syncKnowledgeRepository,
  knowledgeWorkspaceHasChanges: mocks.knowledgeWorkspaceHasChanges
}))
import {
  assertSelectableKnowledgeBaseIds,
  deleteKnowledgeBase,
  isKnowledgeDepositionBlocked,
  listKnowledgeBases,
  prepareKnowledgeDeposition,
  refreshKnowledgeBases,
  refreshKnowledgeBasesInBackground,
  resolveProjectKnowledgeBases,
  startKnowledgeBaseManager,
  stopKnowledgeBaseManager,
  syncKnowledgeBase
} from "./knowledge-base-manager"
import {
  knowledgeDirectory,
  knowledgeStatePath,
  mergeCloudKnowledgeState,
  readKnowledgeState,
  writeKnowledgeState
} from "./knowledge-base-state"
import { KnowledgeRepositoryLocalChangesError } from "./knowledge-repository"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../agent/thread-run-lease"

let root: string
const item = {
  idKey: "kb-main",
  name: "Main knowledge",
  description: "",
  ownerId: "",
  ownerName: "",
  repoUrl: "https://git.example.test/main.git",
  sshUrl: null,
  gitRef: "main"
}

beforeEach(async () => {
  const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
  vi.mocked(rm).mockReset().mockImplementation(actualFs.rm)
  root = await mkdtemp(join(tmpdir(), "knowledge-manager-"))
  vi.stubEnv("DEV", false)
  vi.stubEnv("CMB_COWORK_AGENT_HOME", root)
  vi.stubEnv("VITE_ENTERPRISE_PROJECT_QUERY_URL", "https://example.test/api/daas/project/query")
  mocks.getUserInfo.mockReturnValue({
    sapId: "00012345",
    pathName: "总行 / a组",
    originPathId: "root/a",
    ystAccessToken: "not-for-query"
  })
  mocks.getThreadCore.mockReset()
  mocks.knowledgeWorkspaceHasChanges.mockReset().mockResolvedValue(false)
  mocks.syncKnowledgeRepository
    .mockReset()
    .mockImplementation(async (source: { idKey: string; role: KnowledgeWorkspaceRole }) => {
      const path = knowledgeDirectory(source.idKey, source.role)
      await mkdir(join(path, ".git"), { recursive: true })
      return { ...source, path, commit: "a".repeat(40), updated: true }
    })
  cloud([item])
})
afterEach(async () => {
  stopKnowledgeBaseManager()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
  await actualFs.rm(root, { recursive: true, force: true })
})
function cloud(items: unknown[]) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify({ code: 200, data: { items } })))
}
async function seed(success = false) {
  const state = mergeCloudKnowledgeState(null, [item])
  if (success) {
    for (const workspace of state.knowledgeBases[0].workspaces) {
      workspace.status = "success"
      await mkdir(join(knowledgeDirectory(item.idKey, workspace.role), ".git"), { recursive: true })
    }
  }
  await writeKnowledgeState(state)
  return state
}

it("posts only the three identity fields and syncs both workspaces without local filtering", async () => {
  const fetchMock = cloud([item, { ...item, idKey: "another", name: "Another" }])
  const result = await refreshKnowledgeBases()
  expect(fetchMock).toHaveBeenCalledWith("https://example.test/devclaw/knowledge-config/query", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ sapId: "00012345", pathName: "总行 / a组", originPathId: "root/a" }),
    signal: expect.any(AbortSignal)
  })
  expect(mocks.syncKnowledgeRepository).toHaveBeenCalledTimes(4)
  expect(result).toMatchObject({
    ready: true,
    queryError: null,
    syncingIds: [],
    writeSyncingIds: []
  })
  expect(result.knowledgeBases.map((entry) => entry.idKey)).toEqual([item.idKey, "another"])
  expect(result.knowledgeBases[0]).toMatchObject({
    type: "public",
    localValid: true,
    workspaces: [
      { role: "read", status: "success" },
      { role: "write", status: "success" }
    ]
  })
  const state = JSON.parse(await readFile(knowledgeStatePath(), "utf8"))
  expect(state).not.toHaveProperty("pathName")
  expect(state.knowledgeBases[0]).not.toHaveProperty("syncedSourceKey")
})

it("uses empty strings for missing identity values", async () => {
  mocks.getUserInfo.mockReturnValue(null)
  await refreshKnowledgeBases()
  expect(globalThis.fetch).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ body: '{"sapId":"","pathName":"","originPathId":""}' })
  )
})

it("syncs three development libraries without a cloud request and resolves independent selections", async () => {
  vi.stubEnv("DEV", true)
  const result = await refreshKnowledgeBases()
  expect(globalThis.fetch).not.toHaveBeenCalled()
  expect(result.knowledgeBases).toMatchObject([
    {
      idKey: "test-agents-main",
      repoUrl: "https://github.com/seikou00/testAgents.git",
      gitRef: "main",
      type: "public",
      workspaces: [
        { role: "read", status: "success" },
        { role: "write", status: "success" }
      ]
    },
    {
      idKey: "hello-world-master",
      repoUrl: "https://github.com/octocat/Hello-World.git",
      gitRef: "master",
      type: "public",
      workspaces: [
        { role: "read", status: "success" },
        { role: "write", status: "success" }
      ]
    },
    {
      idKey: "test-agents-main-2",
      name: "测试知识库 2",
      repoUrl: "https://github.com/seikou00/testAgents.git",
      gitRef: "main",
      type: "public",
      workspaces: [
        { role: "read", status: "success" },
        { role: "write", status: "success" }
      ]
    }
  ])
  expect(mocks.syncKnowledgeRepository).toHaveBeenCalledTimes(6)
  const ids = ["test-agents-main", "test-agents-main-2"]
  await expect(assertSelectableKnowledgeBaseIds(ids)).resolves.toEqual(ids)
  await expect(resolveProjectKnowledgeBases(ids)).resolves.toEqual([
    { id: ids[0], name: "测试知识库", path: knowledgeDirectory(ids[0], "read") },
    { id: ids[1], name: "测试知识库 2", path: knowledgeDirectory(ids[1], "read") }
  ])
})

it("marks an absent library unavailable, stops updates, and still resolves a successful existing binding", async () => {
  await seed(true)
  cloud([])
  const result = await refreshKnowledgeBases()
  expect(result.knowledgeBases[0].visibility).toBe("unavailable")
  expect(mocks.syncKnowledgeRepository).not.toHaveBeenCalled()
  await expect(syncKnowledgeBase(item.idKey)).rejects.toThrow("当前不可见")
  await expect(resolveProjectKnowledgeBases([item.idKey])).resolves.toEqual([
    { id: item.idKey, name: item.name, path: knowledgeDirectory(item.idKey, "read") }
  ])
})

it("reports partial success and persists write blockage without affecting read", async () => {
  await seed()
  mocks.syncKnowledgeRepository.mockImplementation(async (source) => {
    if (source.role === "write") throw new KnowledgeRepositoryLocalChangesError()
    await mkdir(join(knowledgeDirectory(source.idKey, source.role), ".git"), { recursive: true })
    return { path: knowledgeDirectory(source.idKey, source.role), updated: true }
  })
  const result = await syncKnowledgeBase(item.idKey)
  expect(result.status).toBe("partial")
  expect(result.message).toContain("读取内容更新成功")
  expect(result.message).toContain("沉淀工作区暂停更新")
  expect((await readKnowledgeState())?.knowledgeBases[0].workspaces).toEqual([
    { role: "read", status: "success", lastError: null },
    { role: "write", status: "blocked", lastError: expect.stringContaining("本地") }
  ])
  await expect(resolveProjectKnowledgeBases([item.idKey])).resolves.toHaveLength(1)
})

it("continues after a read failure, rejects failed read content, and allows valid write deposition", async () => {
  await seed(true)
  mocks.syncKnowledgeRepository.mockRejectedValueOnce(new Error("network failed"))
  const result = await syncKnowledgeBase(item.idKey)
  expect(result.status).toBe("partial")
  expect(mocks.syncKnowledgeRepository).toHaveBeenCalledTimes(2)
  await expect(resolveProjectKnowledgeBases([item.idKey])).resolves.toEqual([])
  await expect(assertSelectableKnowledgeBaseIds([item.idKey])).rejects.toThrow("当前不可用")
  await expect(prepareKnowledgeDeposition([item.idKey])).resolves.toEqual({
    path: knowledgeDirectory(item.idKey, "write")
  })
})

it("preserves unchanged project bindings and allows explicit clearing", async () => {
  await seed()
  await expect(assertSelectableKnowledgeBaseIds([item.idKey], [item.idKey])).resolves.toEqual([
    item.idKey
  ])
  await expect(assertSelectableKnowledgeBaseIds([])).resolves.toEqual([])
  await expect(assertSelectableKnowledgeBaseIds([item.idKey])).rejects.toThrow("当前不可用")
})

it("warns about dirty write content without blocking deposition, including failed or blocked workspaces", async () => {
  const state = await seed(true)
  for (const status of ["blocked", "failed"] as const) {
    state.knowledgeBases[0].workspaces[1].status = status
    await writeKnowledgeState(state)
    mocks.knowledgeWorkspaceHasChanges.mockResolvedValue(true)
    await expect(prepareKnowledgeDeposition([item.idKey])).resolves.toEqual({
      path: knowledgeDirectory(item.idKey, "write"),
      warning: expect.stringContaining("未提交")
    })
  }
  expect(mocks.knowledgeWorkspaceHasChanges).toHaveBeenCalledWith(
    knowledgeDirectory(item.idKey, "write")
  )
})

it("blocks unbound or missing write workspaces and never falls back to read", async () => {
  await seed()
  await mkdir(join(knowledgeDirectory(item.idKey, "read"), ".git"), { recursive: true })
  await expect(prepareKnowledgeDeposition([])).rejects.toThrow("请先在项目设置中配置知识库")
  await expect(prepareKnowledgeDeposition([item.idKey])).rejects.toThrow("工作区不可用")
})

it.each([
  { gitRef: 42 },
  { gitRef: "invalid..branch" },
  { sshUrl: {} },
  { repoUrl: "--invalid-source" }
])(
  "retains cached configuration and still updates Git on an invalid cloud response: %j",
  async (invalid) => {
    await seed(true)
    cloud([{ ...item, name: "Changed", ...invalid }])
    const result = await refreshKnowledgeBases()
    expect(result.queryError).toBeTruthy()
    expect((await readKnowledgeState())?.knowledgeBases[0].name).toBe(item.name)
    expect(mocks.syncKnowledgeRepository).toHaveBeenCalledTimes(2)
  }
)

it("exposes query failure without cache and succeeds on the next manual refresh", async () => {
  vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error("offline"))
  await expect(refreshKnowledgeBases()).resolves.toMatchObject({
    ready: false,
    queryError: "offline",
    knowledgeBases: []
  })
  expect(mocks.syncKnowledgeRepository).not.toHaveBeenCalled()
  await expect(refreshKnowledgeBases()).resolves.toMatchObject({ ready: true, queryError: null })
})

it.each(["headers", "body"])(
  "aborts hanging %s after five seconds and updates cached Git normally",
  async (phase) => {
    await seed()
    let signal: AbortSignal | undefined
    vi.mocked(globalThis.fetch).mockImplementation(async (_url, options) => {
      signal = options?.signal ?? undefined
      const hang = (): Promise<never> =>
        new Promise((_resolve, reject) => {
          signal!.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true }
          )
        })
      if (phase === "headers") return hang()
      return { status: 200, json: hang } as unknown as Response
    })
    vi.useFakeTimers()
    const pending = refreshKnowledgeBases()
    await vi.waitFor(() => expect(signal).toBeDefined())
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(pending).resolves.toMatchObject({
      ready: true,
      refreshing: false,
      queryError: expect.stringContaining("5 秒")
    })
    expect(signal?.aborted).toBe(true)
    expect(mocks.syncKnowledgeRepository).toHaveBeenCalledTimes(2)
  }
)

it("reserves a single-library update before reading state and updates both roles without querying cloud", async () => {
  await seed()
  const first = syncKnowledgeBase(item.idKey)
  await expect(syncKnowledgeBase(item.idKey)).rejects.toThrow("同步正在进行")
  await first
  expect(mocks.syncKnowledgeRepository).toHaveBeenCalledTimes(2)
  expect(globalThis.fetch).not.toHaveBeenCalled()
  await expect(syncKnowledgeBase("missing")).rejects.toThrow("配置不存在")
  await expect(syncKnowledgeBase(item.idKey)).resolves.toMatchObject({ status: "downloaded" })
})

it("pauses write for a running deposition but continues read updates", async () => {
  await seed(true)
  mocks.getThreadCore.mockReturnValue({
    metadata: JSON.stringify({
      workspacePath: knowledgeDirectory(item.idKey, "write"),
      harnessProjectSession: { projectId: "project", kind: "system-constraints-update" }
    })
  })
  claimLocalThreadRunLease({ threadId: "deposition", owner: "desktop", runId: "run" })
  try {
    await expect(syncKnowledgeBase(item.idKey)).resolves.toMatchObject({ status: "partial" })
    expect(mocks.syncKnowledgeRepository).toHaveBeenCalledTimes(1)
    expect(mocks.syncKnowledgeRepository).toHaveBeenCalledWith(
      expect.objectContaining({ role: "read" })
    )
    expect((await listKnowledgeBases()).knowledgeBases[0].workspaces[1].inUse).toBe(true)
    // Starting another deposition is not excluded by a running deposition.
    await expect(prepareKnowledgeDeposition([item.idKey])).resolves.toHaveProperty("path")
  } finally {
    releaseLocalThreadRunLease("deposition", "desktop", "run")
  }
  await expect(syncKnowledgeBase(item.idKey)).resolves.toMatchObject({ status: "downloaded" })
})

it("blocks deposition only while its write role is updating, never during read updates", async () => {
  await seed(true)
  let finishRead!: () => void
  let finishWrite!: () => void
  mocks.syncKnowledgeRepository.mockImplementation(async (source) => {
    await new Promise<void>((done) => {
      if (source.role === "read") finishRead = done
      else finishWrite = done
    })
    return { updated: false }
  })
  const metadata = {
    workspacePath: knowledgeDirectory(item.idKey, "write"),
    harnessProjectSession: { kind: "system-constraints-update" }
  }
  const pending = syncKnowledgeBase(item.idKey)
  await vi.waitFor(() => expect(finishRead).toBeDefined())
  expect(isKnowledgeDepositionBlocked(metadata)).toBe(false)
  finishRead()
  await vi.waitFor(() => expect(finishWrite).toBeDefined())
  expect(isKnowledgeDepositionBlocked(metadata)).toBe(true)
  expect(
    isKnowledgeDepositionBlocked({ ...metadata, harnessProjectSession: { kind: "chat" } })
  ).toBe(false)
  await expect(prepareKnowledgeDeposition([item.idKey])).rejects.toThrow("正在同步")
  finishWrite()
  await pending
  expect(isKnowledgeDepositionBlocked(metadata)).toBe(false)
})

it("uses only the normal periodic refresh for failures", async () => {
  vi.mocked(globalThis.fetch).mockRejectedValue(new Error("offline"))
  vi.useFakeTimers()
  vi.spyOn(Math, "random").mockReturnValue(0.5)
  startKnowledgeBaseManager()
  expect(globalThis.fetch).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(5 * 60_000)
  await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1))
  await vi.waitFor(async () => expect((await listKnowledgeBases()).refreshing).toBe(false))
  await vi.advanceTimersByTimeAsync(60_000)
  expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(83 * 60_000)
  expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(60_000)
  await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2))
  await vi.waitFor(async () => expect((await listKnowledgeBases()).refreshing).toBe(false))
})

it("reuses pending automatic refreshes without postponing them and keeps manual refresh immediate", async () => {
  vi.useFakeTimers()
  vi.spyOn(Math, "random").mockReturnValue(0.5)
  const fetchMock = cloud([]).mockImplementation(
    async () => new Response(JSON.stringify({ code: 200, data: { items: [] } }))
  )
  startKnowledgeBaseManager()
  startKnowledgeBaseManager()
  await vi.advanceTimersByTimeAsync(2 * 60_000)
  refreshKnowledgeBasesInBackground()
  await refreshKnowledgeBases()
  expect(fetchMock).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(3 * 60_000 - 1)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  await vi.waitFor(async () => expect((await listKnowledgeBases()).refreshing).toBe(false))
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it("randomizes every periodic interval and merges a pending automatic refresh at the periodic trigger", async () => {
  vi.useFakeTimers()
  vi.spyOn(Math, "random")
    .mockReturnValueOnce(0)
    .mockReturnValueOnce(0)
    .mockReturnValueOnce(1 - Number.EPSILON)
    .mockReturnValue(0.5)
  const fetchMock = cloud([]).mockImplementation(
    async () => new Response(JSON.stringify({ code: 200, data: { items: [] } }))
  )
  startKnowledgeBaseManager()
  await vi.advanceTimersByTimeAsync(1)
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  await vi.waitFor(async () => expect((await listKnowledgeBases()).refreshing).toBe(false))
  await vi.advanceTimersByTimeAsync(75 * 60_000 - 2)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  await vi.waitFor(async () => expect((await listKnowledgeBases()).refreshing).toBe(false))
  await vi.advanceTimersByTimeAsync(104 * 60_000)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  refreshKnowledgeBasesInBackground()
  await vi.advanceTimersByTimeAsync(60_000)
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
  await vi.waitFor(async () => expect((await listKnowledgeBases()).refreshing).toBe(false))
  await vi.advanceTimersByTimeAsync(5 * 60_000)
  expect(fetchMock).toHaveBeenCalledTimes(3)
})

it("skips an automatic refresh while a manual refresh is still running", async () => {
  vi.useFakeTimers()
  vi.spyOn(Math, "random").mockReturnValue(0.5)
  let finishRead!: () => void
  mocks.syncKnowledgeRepository.mockImplementationOnce(
    () => new Promise((resolve) => (finishRead = () => resolve({ updated: false })))
  )
  const pending = refreshKnowledgeBases()
  await vi.waitFor(() => expect(finishRead).toBeDefined())
  refreshKnowledgeBasesInBackground()
  await vi.advanceTimersByTimeAsync(5 * 60_000)
  expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  expect(mocks.syncKnowledgeRepository).toHaveBeenCalledTimes(1)
  finishRead()
  await pending
})

it("cancels pending startup, identity and periodic refreshes when stopped", async () => {
  vi.useFakeTimers()
  vi.spyOn(Math, "random").mockReturnValue(0.5)
  const fetchMock = cloud([]).mockImplementation(
    async () => new Response(JSON.stringify({ code: 200, data: { items: [] } }))
  )
  startKnowledgeBaseManager()
  stopKnowledgeBaseManager()
  await vi.advanceTimersByTimeAsync(120 * 60_000)
  expect(fetchMock).not.toHaveBeenCalled()
  refreshKnowledgeBasesInBackground()
  stopKnowledgeBaseManager()
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  expect(fetchMock).not.toHaveBeenCalled()
})

it("stores a single friendly description from the first underlying failure and deduplicates the toast", async () => {
  await seed()
  const first = new Error(
    `Command failed: git clone ${item.repoUrl}\nremote: \u001b[31mIncorrect username or password (access token)\u001b[0m\nfatal: Authentication failed`
  )
  const second = new Error("Remote branch master1 not found in upstream origin")
  mocks.syncKnowledgeRepository.mockRejectedValue(
    new AggregateError([first, second], "知识库 HTTPS 克隆失败，SSH 兜底也失败")
  )
  const log = vi.spyOn(console, "warn").mockImplementation(() => undefined)
  const result = await syncKnowledgeBase(item.idKey)
  const message = "仓库认证失败，请检查本机 Git 凭据是否有效，并确认账号具有仓库访问权限。"
  expect(result).toMatchObject({
    status: "failed",
    message: `读取内容、沉淀工作区更新失败：${message}`
  })
  const saved = (await readKnowledgeState())!.knowledgeBases[0]
  expect(saved.workspaces.map((workspace) => workspace.lastError)).toEqual([message, message])
  expect(saved.lastSuccessfulSyncAt).toBeUndefined()
  expect(log).toHaveBeenCalledTimes(2)
  const logs = log.mock.calls.map((call) => call[0]).join("\n")
  expect(logs).toContain("Authentication failed")
  expect(logs).not.toContain(item.repoUrl)
  expect(logs).not.toContain("master1")
  expect(logs).not.toContain("\u001b")
})

it("keeps different workspace failure descriptions separate", async () => {
  await seed()
  mocks.syncKnowledgeRepository
    .mockRejectedValueOnce(new Error("fatal: Authentication failed"))
    .mockRejectedValueOnce(new Error("Remote branch main not found in upstream origin"))
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  const result = await syncKnowledgeBase(item.idKey)
  expect(result.message).toContain("读取内容更新失败：仓库认证失败")
  expect(result.message).toContain("沉淀工作区更新失败：配置的知识库分支不存在")
})

it("records one GMT+8 success time only when both workspaces succeed, including an up-to-date check", async () => {
  await seed()
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-10-21T02:03:04Z"))
  await syncKnowledgeBase(item.idKey)
  expect((await readKnowledgeState())!.knowledgeBases[0].lastSuccessfulSyncAt).toBe(
    "2026-10-21 10:03:04"
  )
  vi.setSystemTime(new Date("2026-10-21T03:04:05Z"))
  mocks.syncKnowledgeRepository.mockResolvedValue({ updated: false })
  await expect(syncKnowledgeBase(item.idKey)).resolves.toMatchObject({ status: "up_to_date" })
  const saved = JSON.parse(await readFile(knowledgeStatePath(), "utf8"))
  expect(saved.knowledgeBases[0].lastSuccessfulSyncAt).toBe("2026-10-21 11:04:05")
  expect(
    saved.knowledgeBases[0].workspaces.every(
      (workspace) => !Object.hasOwn(workspace, "lastSuccessfulSyncAt")
    )
  ).toBe(true)
})

it.each(["failure", "blocked"])(
  "preserves the last full success time on a partial %s",
  async (reason) => {
    const state = await seed(true)
    state.knowledgeBases[0].lastSuccessfulSyncAt = "2026-10-20 15:30:00"
    await writeKnowledgeState(state)
    mocks.syncKnowledgeRepository.mockRejectedValueOnce(
      reason === "blocked"
        ? new KnowledgeRepositoryLocalChangesError()
        : new Error("Connection timed out")
    )
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    await expect(syncKnowledgeBase(item.idKey)).resolves.toMatchObject({ status: "partial" })
    expect((await readKnowledgeState())!.knowledgeBases[0].lastSuccessfulSyncAt).toBe(
      "2026-10-20 15:30:00"
    )
  }
)

it("signals preview refresh after read updates even when write fails, without refreshing on list polls", async () => {
  await seed(true)
  const before = (await listKnowledgeBases()).knowledgeBases[0].previewRevision
  mocks.syncKnowledgeRepository.mockRejectedValueOnce(new Error("network failure"))
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  await syncKnowledgeBase(item.idKey)
  const afterFailure = (await listKnowledgeBases()).knowledgeBases[0].previewRevision
  expect(afterFailure).toBe(before + 1)
  expect((await listKnowledgeBases()).knowledgeBases[0].previewRevision).toBe(afterFailure)
  mocks.syncKnowledgeRepository
    .mockResolvedValueOnce({ updated: false })
    .mockRejectedValueOnce(new KnowledgeRepositoryLocalChangesError())
  await syncKnowledgeBase(item.idKey)
  expect((await listKnowledgeBases()).knowledgeBases[0].previewRevision).toBe(afterFailure + 1)
  expect(
    JSON.parse(await readFile(knowledgeStatePath(), "utf8")).knowledgeBases[0]
  ).not.toHaveProperty("previewRevision")
})

it("resolves multiple bindings in selection order with stable ids, skipping unavailable content", async () => {
  const other = { ...item, idKey: "kb-other", name: "Other" }
  cloud([item, other])
  await refreshKnowledgeBases()
  await expect(
    assertSelectableKnowledgeBaseIds([other.idKey, item.idKey, other.idKey])
  ).resolves.toEqual([other.idKey, item.idKey])
  await expect(
    resolveProjectKnowledgeBases([other.idKey, "missing", item.idKey, other.idKey])
  ).resolves.toEqual([
    { id: other.idKey, name: other.name, path: knowledgeDirectory(other.idKey, "read") },
    { id: item.idKey, name: item.name, path: knowledgeDirectory(item.idKey, "read") }
  ])
  await expect(assertSelectableKnowledgeBaseIds([item.idKey, "missing"])).rejects.toThrow(
    "当前不可用"
  )
  await expect(assertSelectableKnowledgeBaseIds(["old", other.idKey], ["old"])).resolves.toEqual([
    "old",
    other.idKey
  ])
  await expect(resolveProjectKnowledgeBases([])).resolves.toEqual([])
})

it("requires an explicit bound target for multi-library deposition", async () => {
  const other = { ...item, idKey: "kb-other", name: "Other" }
  cloud([item, other])
  await refreshKnowledgeBases()
  const ids = [item.idKey, other.idKey]
  await expect(prepareKnowledgeDeposition(ids)).rejects.toThrow("请选择要沉淀的知识库")
  await expect(prepareKnowledgeDeposition(ids, "unbound")).rejects.toThrow("未绑定")
  await expect(prepareKnowledgeDeposition(ids, other.idKey)).resolves.toEqual({
    path: knowledgeDirectory(other.idKey, "write")
  })
  await expect(assertSelectableKnowledgeBaseIds([])).resolves.toEqual([])
})

it("deletes both local workspaces and only the selected state record, including uncommitted content", async () => {
  const other = { ...item, idKey: "other", name: "Other" }
  cloud([item, other])
  await refreshKnowledgeBases()
  for (const role of ["read", "write"] as const) {
    await writeFile(join(knowledgeDirectory(item.idKey, role), "uncommitted.md"), "local changes")
  }
  const projectPath = join(root, "project-binding.json")
  const project = JSON.stringify({ knowledgeBaseIds: [item.idKey] })
  await writeFile(projectPath, project)
  await deleteKnowledgeBase(item.idKey)
  expect((await readKnowledgeState())?.knowledgeBases.map((entry) => entry.idKey)).toEqual([
    other.idKey
  ])
  for (const role of ["read", "write"] as const) {
    await expect(
      readFile(join(knowledgeDirectory(item.idKey, role), "uncommitted.md"))
    ).rejects.toThrow()
    await expect(readFile(knowledgeDirectory(item.idKey, role))).rejects.toMatchObject({
      code: "ENOENT"
    })
  }
  expect(await readFile(projectPath, "utf8")).toBe(project)
  await expect(resolveProjectKnowledgeBases([item.idKey])).resolves.toEqual([])
  await expect(resolveProjectKnowledgeBases([other.idKey])).resolves.toHaveLength(1)
  expect((await listKnowledgeBases()).deletingId).toBeNull()
})

it("removes an unavailable library with missing directories and rejects invalid or missing ids", async () => {
  const saved = await seed()
  saved.knowledgeBases[0].visibility = "unavailable"
  await writeKnowledgeState(saved)
  await expect(deleteKnowledgeBase("../outside")).rejects.toThrow("安全映射")
  await expect(deleteKnowledgeBase("missing")).rejects.toThrow("配置不存在")
  await deleteKnowledgeBase(item.idKey)
  expect(await readKnowledgeState()).toEqual({ schemaVersion: 1, knowledgeBases: [] })
})

it("prevents deletion during sync or refresh", async () => {
  await seed(true)
  const syncing = syncKnowledgeBase(item.idKey)
  await expect(deleteKnowledgeBase(item.idKey)).rejects.toThrow("同步或刷新正在进行")
  await syncing
  const refreshing = refreshKnowledgeBases()
  await expect(deleteKnowledgeBase(item.idKey)).rejects.toThrow("同步或刷新正在进行")
  await refreshing
  expect((await readKnowledgeState())?.knowledgeBases).toHaveLength(1)
})

it.each([
  { kind: "system-constraints-update", role: "write", blocked: true },
  { kind: "system-constraints-update", role: "read", blocked: false },
  { kind: "feature", role: "write", blocked: false }
] as const)(
  "blocks deletion only for a running deposition in its write directory: %j",
  async ({ kind, role, blocked }) => {
    await seed(true)
    mocks.getThreadCore.mockReturnValue({
      metadata: JSON.stringify({
        workspacePath: knowledgeDirectory(item.idKey, role),
        harnessProjectSession: { projectId: "p", kind }
      })
    })
    claimLocalThreadRunLease({ threadId: "delete-test", owner: "desktop", runId: "run" })
    try {
      if (blocked) {
        await expect(deleteKnowledgeBase(item.idKey)).rejects.toThrow("正在用于系统约束沉淀")
        expect((await readKnowledgeState())?.knowledgeBases).toHaveLength(1)
      } else {
        await deleteKnowledgeBase(item.idKey)
        expect((await readKnowledgeState())?.knowledgeBases).toHaveLength(0)
      }
    } finally {
      releaseLocalThreadRunLease("delete-test", "desktop", "run")
    }
    if (blocked) {
      await deleteKnowledgeBase(item.idKey)
      expect((await readKnowledgeState())?.knowledgeBases).toHaveLength(0)
    }
  }
)

it.each(["read", "write"] as const)(
  "retains state when %s directory removal fails and permits a later retry",
  async (role) => {
    await seed(true)
    const before = await readKnowledgeState()
    if (role === "write")
      vi.mocked(rm).mockImplementationOnce(vi.mocked(rm).getMockImplementation()!)
    vi.mocked(rm).mockRejectedValueOnce(new Error("directory removal failed"))
    await expect(deleteKnowledgeBase(item.idKey)).rejects.toThrow("directory removal failed")
    expect(await readKnowledgeState()).toEqual(before)
    expect((await listKnowledgeBases()).deletingId).toBeNull()
    await deleteKnowledgeBase(item.idKey)
    expect((await readKnowledgeState())?.knowledgeBases).toHaveLength(0)
  }
)

it("reserves deletion before file operations and pauses new updates and deposition until finished", async () => {
  await seed(true)
  const originalRemove = vi.mocked(rm).getMockImplementation()!
  let finish!: () => void
  const hold = new Promise<void>((resolve) => {
    finish = resolve
  })
  vi.mocked(rm).mockImplementationOnce(async (...args) => {
    await hold
    return originalRemove(...args)
  })
  const deleting = deleteKnowledgeBase(item.idKey)
  try {
    await vi.waitFor(async () => expect((await listKnowledgeBases()).deletingId).toBe(item.idKey))
    await expect(deleteKnowledgeBase(item.idKey)).rejects.toThrow("正在删除")
    await expect(syncKnowledgeBase(item.idKey)).rejects.toThrow("正在删除")
    await expect(prepareKnowledgeDeposition([item.idKey])).rejects.toThrow("正在同步")
    expect(
      isKnowledgeDepositionBlocked({
        workspacePath: knowledgeDirectory(item.idKey, "write"),
        harnessProjectSession: { projectId: "p", kind: "system-constraints-update" }
      })
    ).toBe(true)
    await expect(refreshKnowledgeBases()).resolves.toMatchObject({ deletingId: item.idKey })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  } finally {
    finish()
    await deleting
  }
  expect((await listKnowledgeBases()).deletingId).toBeNull()
})

it("restores a deleted library on the next refresh when still returned by the server", async () => {
  await seed(true)
  await deleteKnowledgeBase(item.idKey)
  await refreshKnowledgeBases()
  expect((await listKnowledgeBases()).knowledgeBases).toMatchObject([
    { idKey: item.idKey, localValid: true }
  ])
  expect(mocks.syncKnowledgeRepository).toHaveBeenCalledTimes(2)
})
