import { afterEach, expect, it, vi } from "vitest"
import { BotStore } from "../../../main/bots/store"
import type { BotRunOutputPage, BotRunOutputRequest } from "../../../shared/bot-run-output"
const api = vi.hoisted(() => ({
  status: vi.fn(),
  snapshot: vi.fn(),
  messages: vi.fn(),
  runOutput: vi.fn()
}))
vi.mock("./bot-api", () => ({ botApi: api }))
import { useBotWorkspaceStore } from "./bot-workspace-store"
const stores: BotStore[] = []
const pendingReleases: (() => void)[] = []
afterEach(async () => {
  useBotWorkspaceStore.getState().clearTaskOutputs(true)
  for (const release of pendingReleases.splice(0)) release()
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (const store of stores.splice(0)) store.close()
  vi.clearAllMocks()
})
function fixture() {
  const store = new BotStore(":memory:")
  stores.push(store)
  const { conversationId } = store.createBot({ nonce: "bot", name: "Owner" })
  store.send({ nonce: "task", conversationId, text: "Task" })
  const claim = store.claim("host")!
  store.streamOutput(claim.lease, "Provisional body")
  const host = {
    hostId: "host",
    dataEpoch: store.dataEpoch(),
    platform: "darwin",
    protocol: 1,
    runtimeReady: true,
    error: null,
    capabilities: ["run-output-pages-v1"]
  }
  api.status.mockResolvedValue(host)
  api.snapshot.mockImplementation(async () => ({
    ...store.snapshot({ runProjection: "summary" }),
    hostId: host.hostId
  }))
  api.messages.mockImplementation(async () => store.messages(conversationId))
  let release!: () => void
  api.runOutput.mockImplementation((input: BotRunOutputRequest) => {
    const page: BotRunOutputPage = { ...store.runOutput(input), hostId: "host" }
    return new Promise<BotRunOutputPage>((resolve) => {
      release = () => resolve(page)
      pendingReleases.push(release)
    })
  })
  useBotWorkspaceStore.setState({
    snapshot: null,
    host: null,
    selected: conversationId,
    opening: {},
    messages: {},
    expandedTaskOutputId: null,
    runOutputs: {},
    transcriptError: null,
    viewportRestore: null,
    hasNewer: {},
    hasOlder: {}
  })
  useBotWorkspaceStore.getState().activateTaskOutputs()
  return { store, conversationId, claim, release: () => release() }
}
it("publishes pending approval and final transcript without awaiting slow output, then refuses late resurrection", async () => {
  const f = fixture()
  f.store.db.run(
    "INSERT INTO bot_interactions(id,run_id,kind,prompt,status,expires_at,created_at) VALUES('approval',?,'approval','Exact reviewed operation','pending',9999999999999,1)",
    [f.claim.lease.runId]
  )
  await useBotWorkspaceStore.getState().refresh({ preserveSelection: true })
  expect(api.runOutput).toHaveBeenCalledOnce()
  expect(useBotWorkspaceStore.getState().snapshot?.interactions[0].id).toBe("approval")
  expect(useBotWorkspaceStore.getState().messages[f.conversationId].at(-1)?.text).toBe("Task")
  f.store.finish(f.claim.lease, "succeeded", "Final durable answer")
  await useBotWorkspaceStore.getState().refresh({ preserveSelection: true })
  const terminalCursor = useBotWorkspaceStore.getState().snapshot!.cursor
  expect(useBotWorkspaceStore.getState().snapshot?.runs).toEqual([])
  expect(useBotWorkspaceStore.getState().messages[f.conversationId].at(-1)?.text).toBe(
    "Final durable answer"
  )
  f.release()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(useBotWorkspaceStore.getState().runOutputs).toEqual({})
  expect(useBotWorkspaceStore.getState().snapshot?.cursor).toBe(terminalCursor)
})
it("allows slow valid output after newer same-scope polls and blocks an unmounted late publish", async () => {
  const f = fixture()
  await useBotWorkspaceStore.getState().refresh({ preserveSelection: true })
  await useBotWorkspaceStore.getState().refresh({ preserveSelection: true })
  expect(api.runOutput).toHaveBeenCalledOnce()
  f.release()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(useBotWorkspaceStore.getState().runOutputs[f.claim.lease.runId].text).toBe(
    "Provisional body"
  )
  f.store.streamOutput(f.claim.lease, "Provisional body plus tail")
  await useBotWorkspaceStore.getState().refresh({ preserveSelection: true })
  useBotWorkspaceStore.getState().clearTaskOutputs(true)
  f.release()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(useBotWorkspaceStore.getState().runOutputs).toEqual({})
})
