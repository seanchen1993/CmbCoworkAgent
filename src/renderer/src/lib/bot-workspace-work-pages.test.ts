import { beforeEach, afterEach, expect, it, vi } from "vitest"
import { BotDomainError } from "../../../shared/bot-types"
import { BotStore } from "../../../main/bots/store"
import type { BotSnapshotRequest, BotRunOutputRequest } from "../../../shared/bot-run-output"
import type { BotWorkPageRequest, BotTrackedWorkRequest } from "../../../shared/bot-work-pages"
import { botTrackedWorkKey } from "../../../shared/bot-work-pages"
const api = vi.hoisted(() => ({
  status: vi.fn(),
  snapshot: vi.fn(),
  messages: vi.fn(),
  runOutput: vi.fn(),
  openRuns: vi.fn(),
  pendingInteractions: vi.fn(),
  trackedWork: vi.fn()
}))
vi.mock("./bot-api", () => ({ botApi: api }))
import { observeBotTrackedWorkRegistration } from "./bot-tracked-work"
import { botSteeringTarget } from "./bot-steering"
import { useBotWorkspaceStore } from "./bot-workspace-store"
const stores: BotStore[] = []
const cleanup: (() => void)[] = []
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
beforeEach(() => {
  const cache = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => cache.set(key, value),
    removeItem: (key: string) => cache.delete(key)
  })
})
afterEach(async () => {
  useBotWorkspaceStore.getState().setWorkPageOpen("tasks", false)
  useBotWorkspaceStore.getState().setWorkPageOpen("pending", false)
  useBotWorkspaceStore.getState().clearTaskOutputs(true)
  for (const release of cleanup.splice(0)) release()
  await tick()
  for (const store of stores.splice(0)) store.close()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})
function fixture() {
  const store = new BotStore(":memory:")
  stores.push(store)
  const first = store.createBot({ nonce: "first", name: "First" }),
    second = store.createBot({ nonce: "second", name: "Second" })
  store.send({ nonce: "first-task", conversationId: first.conversationId, text: "First task" })
  const a = store.claim("worker-a")!
  store.streamOutput(a.lease, "First output")
  store.send({ nonce: "second-task", conversationId: second.conversationId, text: "Second task" })
  const b = store.claim("worker-b")!
  store.streamOutput(b.lease, "Second output")
  const host = {
    hostId: "host",
    dataEpoch: store.dataEpoch(),
    platform: "darwin",
    protocol: 1,
    runtimeReady: true,
    error: null,
    capabilities: ["run-output-pages-v1", "work-pages-v1"]
  }
  api.status.mockResolvedValue(host)
  api.snapshot.mockImplementation(async (input: BotSnapshotRequest) => ({
    ...store.snapshot(input, "host"),
    hostId: "host"
  }))
  api.messages.mockImplementation(async (input: { conversationId: string }) =>
    store.messages(input.conversationId)
  )
  api.runOutput.mockImplementation(async (input: BotRunOutputRequest) => ({
    ...store.runOutput(input),
    hostId: "host"
  }))
  api.openRuns.mockImplementation(async (input: BotWorkPageRequest) =>
    store.workPages.openRuns(input, "host")
  )
  api.pendingInteractions.mockImplementation(async (input: BotWorkPageRequest) =>
    store.workPages.pendingInteractions(input, "host")
  )
  api.trackedWork.mockImplementation(async (input: BotTrackedWorkRequest) =>
    store.workPages.trackedWork(input, "host")
  )
  useBotWorkspaceStore.setState({
    snapshot: store.snapshot(),
    host,
    selected: first.conversationId,
    opening: {},
    messages: {},
    trackedWork: {},
    expandedTaskOutputId: null,
    runOutputs: {},
    transcriptError: null,
    viewportRestore: null,
    hasNewer: {},
    hasOlder: {}
  })
  useBotWorkspaceStore.getState().activateTaskOutputs()
  return { store, first, second, a, b, host }
}
it("negotiates the exact selected view, shows real total counts, and reads only explicit20-row task pages", async () => {
  const f = fixture()
  for (let index = 0; index < 44; index++)
    f.store.send({
      nonce: `queue-${index}`,
      conversationId: f.first.conversationId,
      text: "Queued task"
    })
  await useBotWorkspaceStore.getState().refresh({ preserveSelection: true })
  expect(api.snapshot).toHaveBeenLastCalledWith({
    runProjection: "summary",
    workProjection: "paged",
    hostId: "host",
    dataEpoch: "initial",
    view: { conversationId: f.first.conversationId }
  })
  expect(useBotWorkspaceStore.getState().snapshot?.work?.selected?.counts.total).toBe(45)
  expect(useBotWorkspaceStore.getState().snapshot!.runs.length).toBeLessThanOrEqual(4)
  expect(api.openRuns).not.toHaveBeenCalled()
  useBotWorkspaceStore.getState().setWorkPageOpen("tasks", true)
  await useBotWorkspaceStore.getState().refreshWorkPages()
  expect(api.openRuns).toHaveBeenCalledOnce()
  expect(useBotWorkspaceStore.getState().taskPage.items).toHaveLength(20)
  useBotWorkspaceStore.getState().navigateWorkPage("tasks", "next")
  await useBotWorkspaceStore.getState().refreshWorkPages()
  expect(api.openRuns).toHaveBeenCalledTimes(2)
  expect(useBotWorkspaceStore.getState().taskPage.pageIndex).toBe(1)
  expect(useBotWorkspaceStore.getState().taskPage.items).toHaveLength(20)
  expect(
    useBotWorkspaceStore.getState().taskPage.items.some((run) => run.botId === f.second.bot.id)
  ).toBe(false)
})
it("observes a page-outside exact run through tracked state and does not infer terminal from snapshot absence", async () => {
  const f = fixture()
  await useBotWorkspaceStore.getState().refresh({ preserveSelection: true })
  expect(useBotWorkspaceStore.getState().snapshot?.runs.some((run) => run.id === f.b.run.id)).toBe(
    false
  )
  const target = { kind: "run", botId: f.second.bot.id, runId: f.b.run.id } as const,
    key = botTrackedWorkKey(target)
  expect(useBotWorkspaceStore.getState().trackedWork[key]).toBeUndefined()
  const release = useBotWorkspaceStore.getState().trackWork(target)
  cleanup.push(release)
  await useBotWorkspaceStore.getState().refreshWorkPages()
  expect(useBotWorkspaceStore.getState().trackedWork[key].run?.status).toBe("running")
  f.store.finish(f.b.lease, "succeeded", "Final second answer")
  await useBotWorkspaceStore.getState().refresh({ preserveSelection: true })
  await useBotWorkspaceStore.getState().refreshWorkPages()
  expect(useBotWorkspaceStore.getState().trackedWork[key].run?.status).toBe("succeeded")
  release()
  expect(useBotWorkspaceStore.getState().trackedWork[key]).toBeUndefined()
})
it("lets a new selected Bot use the free output slot without waiting for the old slow scope, and late old output cannot publish", async () => {
  const f = fixture()
  let releaseOld!: () => void
  api.runOutput.mockImplementation((input: BotRunOutputRequest) => {
    const page = { ...f.store.runOutput(input), hostId: "host" }
    if (input.runId === f.a.run.id)
      return new Promise((resolve) => {
        releaseOld = () => resolve(page)
        cleanup.push(releaseOld)
      })
    return Promise.resolve(page)
  })
  await useBotWorkspaceStore.getState().refresh({ preserveSelection: true })
  await tick()
  expect(api.runOutput).toHaveBeenCalledTimes(1)
  useBotWorkspaceStore.getState().clearTaskOutputs()
  useBotWorkspaceStore.setState({ selected: f.second.conversationId })
  await useBotWorkspaceStore.getState().refresh({ preserveSelection: true })
  await tick()
  expect(api.runOutput).toHaveBeenCalledTimes(2)
  expect(useBotWorkspaceStore.getState().runOutputs[f.b.run.id].text).toBe("Second output")
  releaseOld()
  await tick()
  expect(useBotWorkspaceStore.getState().runOutputs[f.a.run.id]).toBeUndefined()
  expect(useBotWorkspaceStore.getState().runOutputs[f.b.run.id].text).toBe("Second output")
})

it("hydrates a single explicitly expanded page-outside run in addition to inline4, with no foreign body published", async () => {
  const f = fixture()
  const queue = Array.from(
    { length: 10 },
    (_, index) =>
      f.store.send({
        nonce: `expand-${index}`,
        conversationId: f.first.conversationId,
        text: "Queued task"
      }).runIds[0]
  )
  await useBotWorkspaceStore.getState().refresh({ preserveSelection: true })
  useBotWorkspaceStore.getState().setWorkPageOpen("tasks", true)
  await useBotWorkspaceStore.getState().refreshWorkPages()
  const inline = useBotWorkspaceStore.getState().snapshot!.runs
  const target = queue.find((id) => !inline.some((run) => run.id === id))!
  expect(useBotWorkspaceStore.getState().taskPage.items.some((run) => run.id === target)).toBe(true)
  f.store.db.run("INSERT INTO bot_run_outputs(run_id,text,updated_at) VALUES(?,?,?)", [
    target,
    "Expanded durable provisional body",
    Date.now()
  ])
  f.store.db.run(
    "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('run.output',?,?,?)",
    [target, JSON.stringify({ characters: "Expanded durable provisional body".length }), Date.now()]
  )
  await useBotWorkspaceStore.getState().refreshWorkPages()
  useBotWorkspaceStore.getState().expandTaskOutput(target)
  await useBotWorkspaceStore.getState().refresh({ preserveSelection: true })
  await tick()
  expect(useBotWorkspaceStore.getState().runOutputs[target].text).toBe(
    "Expanded durable provisional body"
  )
  expect(Object.keys(useBotWorkspaceStore.getState().runOutputs).length).toBeLessThanOrEqual(5)
  expect(useBotWorkspaceStore.getState().runOutputs[f.b.run.id]).toBeUndefined()
  useBotWorkspaceStore.getState().expandTaskOutput(null)
  await useBotWorkspaceStore.getState().refresh({ preserveSelection: true })
  await tick()
  expect(useBotWorkspaceStore.getState().runOutputs[target]).toBeUndefined()
})
it("does not commit an old selected-view frame after navigation, and retains old-Host negotiation", async () => {
  const f = fixture()
  const old = {
    ...f.store.snapshot(
      {
        runProjection: "summary",
        workProjection: "paged",
        hostId: "host",
        dataEpoch: "initial",
        view: { conversationId: f.first.conversationId }
      },
      "host"
    ),
    hostId: "host"
  }
  let release!: () => void
  api.snapshot.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve(old)
        cleanup.push(release)
      })
  )
  const pending = useBotWorkspaceStore.getState().refresh({ preserveSelection: true })
  await tick()
  useBotWorkspaceStore.getState().select(f.second.conversationId)
  release()
  await pending
  expect(useBotWorkspaceStore.getState().snapshot?.work?.selected?.view.conversationId).not.toBe(
    f.first.conversationId
  )
  api.status.mockResolvedValue({ ...f.host, capabilities: [] })
  api.snapshot.mockImplementation(async () => f.store.snapshot())
  await useBotWorkspaceStore.getState().refresh({ preserveSelection: true })
  expect(api.snapshot).toHaveBeenLastCalledWith(undefined)
  expect(useBotWorkspaceStore.getState().snapshot?.runs.some((run) => run.id === f.a.run.id)).toBe(
    true
  )
  expect(useBotWorkspaceStore.getState().snapshot?.runs.some((run) => run.id === f.b.run.id)).toBe(
    true
  )
})

it("uses the server's exact selected-root steering route rather than the presence of that root in inline4", async () => {
  const f = fixture()
  await useBotWorkspaceStore.getState().refresh({ preserveSelection: true })
  const snapshot = useBotWorkspaceStore.getState().snapshot!
  expect(snapshot.work?.selected?.steeringRunId).toBe(f.a.run.id)
  expect(botSteeringTarget({ ...snapshot, runs: [] }, f.first.conversationId)).toBe(f.a.run.id)
  expect(botSteeringTarget({ ...snapshot, runs: [] }, f.second.conversationId)).toBeUndefined()
})

it("routes additions to the actual running human skill trial in paged and legacy snapshots", async () => {
  const f = fixture()
  f.store.finish(f.a.lease, "succeeded", "done")
  const skill = f.store.saveSkill({
    botId: f.first.bot.id,
    name: "报表",
    instructions: "核对实际页面",
    enabled: true
  })
  const trial = f.store.trialSkill({
    nonce: "human-trial",
    botId: f.first.bot.id,
    skillId: skill.id,
    version: 1,
    inputs: "查看本机报表",
    criteria: "返回实际结果"
  })
  expect(f.store.claim("trial-host")!.run.id).toBe(trial.runId)
  await useBotWorkspaceStore.getState().refresh({ preserveSelection: true })
  expect(botSteeringTarget(useBotWorkspaceStore.getState().snapshot, f.first.conversationId)).toBe(
    trial.runId
  )
  expect(botSteeringTarget(f.store.snapshot(), f.first.conversationId)).toBe(trial.runId)
  expect(botSteeringTarget(f.store.snapshot(), f.second.conversationId)).toBe(f.b.run.id)
  // A forged source label without a same-owner durable trial is not a server route.
  f.store.db.run("DELETE FROM bot_skill_trials WHERE id=?", [trial.id])
  await useBotWorkspaceStore.getState().refresh({ preserveSelection: true })
  expect(
    botSteeringTarget(useBotWorkspaceStore.getState().snapshot, f.first.conversationId)
  ).toBeUndefined()
})

it("re-registers an exact mounted task through the real Store capacity bridge after a panel releases", () => {
  const workspace = useBotWorkspaceStore.getState()
  useBotWorkspaceStore.setState({ snapshot: null, host: null, trackedWork: {} })
  const releases = Array.from({ length: 64 }, (_, index) =>
    workspace.trackWork({ kind: "run", botId: "bot", runId: `capacity-${index}` })
  )
  const target = { kind: "run", botId: "bot", runId: "waiting-task" } as const
  const register = vi.fn(() => workspace.trackWork(target)),
    publish = vi.fn()
  const stop = observeBotTrackedWorkRegistration(
    "host/epoch/target",
    register,
    workspace.watchTrackedWorkCapacity,
    publish
  )
  cleanup.push(stop, ...releases)
  expect(register).toHaveBeenCalledOnce()
  expect(publish.mock.calls[0][0]?.message).toContain("任务过多")
  releases[0]()
  expect(register).toHaveBeenCalledTimes(2)
  expect(publish).toHaveBeenLastCalledWith(undefined)
  releases[1]()
  expect(register).toHaveBeenCalledTimes(2)
  stop()
})

for (const scenario of [
  "healthy-other-view",
  "newer-host-error-other-view",
  "newer-host-error-same-view"
] as const) {
  it(`does not publish an obsolete refresh failure over ${scenario}`, async () => {
    const f = fixture()
    await useBotWorkspaceStore.getState().refresh({ preserveSelection: true })
    let failOld!: () => void
    api.snapshot.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failOld = () => reject(new BotDomainError("not_found", "对话不存在"))
          cleanup.push(failOld)
        })
    )
    const old = useBotWorkspaceStore.getState().refresh({ preserveSelection: true })
    const oldFailure = expect(old).rejects.toMatchObject({ code: "not_found" })
    await tick()
    const selected =
      scenario === "newer-host-error-same-view" ? f.first.conversationId : f.second.conversationId
    if (selected !== f.first.conversationId) {
      useBotWorkspaceStore.getState().select(selected)
      await vi.waitFor(() => {
        expect(useBotWorkspaceStore.getState().opening[selected]).toBe(false)
        expect(useBotWorkspaceStore.getState().messages[selected]?.[0].text).toBe("Second task")
      })
    }
    const messages = useBotWorkspaceStore.getState().messages[selected]
    if (scenario !== "healthy-other-view") {
      api.snapshot.mockRejectedValueOnce(new BotDomainError("host_timeout", "当前后台响应超时"))
      await expect(
        useBotWorkspaceStore.getState().refresh({ preserveSelection: true })
      ).rejects.toMatchObject({ code: "host_timeout" })
      expect(useBotWorkspaceStore.getState().error).toBe("当前后台响应超时")
    }
    failOld()
    await oldFailure
    expect(useBotWorkspaceStore.getState().selected).toBe(selected)
    expect(useBotWorkspaceStore.getState().messages[selected]).toEqual(messages)
    expect(useBotWorkspaceStore.getState().error).toBe(
      scenario === "healthy-other-view" ? null : "当前后台响应超时"
    )
  })
}
