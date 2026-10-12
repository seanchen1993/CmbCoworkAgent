import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { useBotWorkspaceStore } from "./bot-workspace-store"
import type { BotErrorTraySnapshot } from "../../../shared/bot-error-trays"
import type { BotHostStatus } from "../../../shared/bot-api"
import type { BotWorkspaceSnapshot } from "../../../shared/bot-types"

const initial = useBotWorkspaceStore.getState()
const host: BotHostStatus = {
  protocol: 1,
  hostId: "tray-host",
  platform: "test",
  runtimeReady: true,
  error: null,
  capabilities: ["error-trays"]
}
const trays = (revision: number, hostId = host.hostId): BotErrorTraySnapshot => ({
  hostId,
  dataEpoch: "tray-epoch",
  revision,
  items: []
})
const envelope = (revision: number, cursor = 1): BotWorkspaceSnapshot => ({
  cursor,
  dataEpoch: "tray-epoch",
  bots: [],
  conversations: [],
  runs: [],
  interactions: [],
  errorTrays: trays(revision)
})
const api = {
  snapshot: vi.fn(),
  status: vi.fn(),
  messages: vi.fn(),
  dismissErrorTray: vi.fn(),
  clearErrorTrays: vi.fn()
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset())
  vi.stubGlobal("window", { api: { bots: api } })
  api.snapshot.mockResolvedValue(envelope(10))
  api.status.mockResolvedValue(host)
  api.messages.mockResolvedValue([])
  useBotWorkspaceStore.setState({ ...initial, snapshot: envelope(9), host }, true)
})
afterEach(() => {
  useBotWorkspaceStore.setState(initial, true)
  vi.unstubAllGlobals()
})

it("projects a dismissal ahead of a held transcript and cannot resurrect it at final publication", async () => {
  const loaded = deferred<[]>(),
    entered = deferred<void>()
  const conversation = {
    id: "conversation",
    kind: "direct" as const,
    name: "Test",
    members: [],
    revision: 1,
    createdAt: 0
  }
  useBotWorkspaceStore.setState({
    selected: conversation.id,
    snapshot: { ...envelope(9), conversations: [conversation] }
  })
  api.snapshot.mockResolvedValue({ ...envelope(10, 2), conversations: [conversation] })
  api.messages.mockImplementation(() => {
    entered.resolve()
    return loaded.promise
  })
  const refresh = useBotWorkspaceStore.getState().refresh()
  await entered.promise
  expect(useBotWorkspaceStore.getState().errorTrays?.revision).toBe(10)
  api.dismissErrorTray.mockResolvedValue(trays(11))
  await useBotWorkspaceStore.getState().dismissErrorTray({
    hostId: host.hostId,
    dataEpoch: "tray-epoch",
    id: "13c4b921-51bd-4c16-8be7-957d090863a7",
    revision: 10
  })
  loaded.resolve([])
  await refresh
  expect(useBotWorkspaceStore.getState().errorTrays?.revision).toBe(11)
  expect(useBotWorkspaceStore.getState().snapshot?.errorTrays?.revision).toBe(11)
})

it("does not tie notification changes to the database cursor", async () => {
  await useBotWorkspaceStore.getState().refresh()
  api.snapshot.mockResolvedValue(envelope(12))
  await useBotWorkspaceStore.getState().refresh()
  expect(useBotWorkspaceStore.getState().errorTrays?.revision).toBe(12)
  expect(useBotWorkspaceStore.getState().snapshot?.cursor).toBe(1)
})

it("rejects a mutation receipt from a retired Host", async () => {
  await useBotWorkspaceStore.getState().refresh()
  api.clearErrorTrays.mockResolvedValue(trays(99, "retired-host"))
  await useBotWorkspaceStore
    .getState()
    .clearErrorTrays({ hostId: host.hostId, dataEpoch: "tray-epoch", throughRevision: 10 })
  expect(useBotWorkspaceStore.getState().errorTrays?.revision).toBe(10)
})

it.each(["status", "snapshot"] as const)(
  "does not let an older Host envelope override a later accepted Host (held %s)",
  async (held) => {
    const oldSnapshot = deferred<BotWorkspaceSnapshot>(),
      oldHost = deferred<BotHostStatus>(),
      enteredSnapshot = deferred<void>()
    const newer = { ...envelope(1), errorTrays: trays(1, "new-host") }
    // Frame negotiation reads status before snapshot. Bind each deferred reply
    // to the request that actually entered that stage, not its assumed call order.
    if (held === "status") {
      api.status.mockReturnValueOnce(oldHost.promise)
      api.snapshot.mockResolvedValueOnce(newer).mockResolvedValueOnce(envelope(99))
    } else {
      api.snapshot.mockImplementationOnce(() => {
        enteredSnapshot.resolve()
        return oldSnapshot.promise
      })
    }
    const oldRefresh = useBotWorkspaceStore.getState().refresh()
    try {
      if (held === "snapshot") await enteredSnapshot.promise
      api.snapshot.mockResolvedValue(newer)
      api.status.mockResolvedValue({ ...host, hostId: "new-host" })
      await useBotWorkspaceStore.getState().refresh()
      oldSnapshot.resolve(envelope(99))
      oldHost.resolve(host)
      await oldRefresh
      expect(useBotWorkspaceStore.getState().host?.hostId).toBe("new-host")
      expect(useBotWorkspaceStore.getState().errorTrays?.hostId).toBe("new-host")
    } finally {
      oldSnapshot.resolve(envelope(99))
      oldHost.resolve(host)
      await oldRefresh
    }
  }
)
