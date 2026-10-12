import { afterEach, describe, expect, it, vi } from "vitest"
import { BotStore } from "../../../main/bots/store"
import { botStartupPreferenceScope, createBotStartupPreferences } from "./bot-startup-preferences"

const api = vi.hoisted(() => ({ snapshot: vi.fn(), status: vi.fn(), messages: vi.fn() }))
vi.mock("./bot-api", () => ({ botApi: api }))
const stores: BotStore[] = []
afterEach(() => {
  stores.splice(0).forEach((store) => store.close())
  vi.unstubAllGlobals()
})
function fixture() {
  const values = new Map<string, string>()
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value))
  }
  return { storage, preferences: createBotStartupPreferences(() => storage) }
}

describe("startup layout preferences", () => {
  it("retains only the last stable workspace, without persisting transient boards", () => {
    const f = fixture()
    expect(f.preferences.mainView()).toBe("thread")
    f.preferences.rememberMainView("bots")
    f.preferences.rememberMainView("dashboard")
    f.preferences.rememberMainView("customize")
    expect(createBotStartupPreferences(() => f.storage).mainView()).toBe("bots")
    f.preferences.rememberMainView("bots")
    expect(f.storage.setItem).toHaveBeenCalledTimes(1)
    f.preferences.rememberMainView("thread")
    expect(createBotStartupPreferences(() => f.storage).mainView()).toBe("thread")
  })

  it("bounds remembered workspaces and separates data replacements and remote paths", () => {
    const f = fixture()
    const scope = botStartupPreferenceScope("/workspace", "epoch-a")!
    f.preferences.rememberConversation(scope, "conversation-a")
    expect(createBotStartupPreferences(() => f.storage).conversation(scope)).toBe("conversation-a")
    expect(
      f.preferences.conversation(botStartupPreferenceScope("/workspace", "epoch-b"))
    ).toBeNull()
    expect(f.preferences.conversation(botStartupPreferenceScope("/other", "epoch-a"))).toBeNull()
    for (let i = 0; i < 8; i++)
      f.preferences.rememberConversation(
        botStartupPreferenceScope(`/workspace-${i}`, "epoch"),
        `c-${i}`
      )
    expect(f.preferences.conversation(scope)).toBeNull()
    const saved = [...f.storage.setItem.mock.calls].at(-1)![1]
    expect(JSON.parse(saved).scopes).toHaveLength(8)
    expect(saved.length).toBeLessThan(40 * 1024)
  })

  it.each(["{broken", "x".repeat(40 * 1024 + 1), '{"version":2,"scopes":[]}'])(
    "does not repair malformed layout during a read",
    (raw) => {
      const storage = { getItem: () => raw, setItem: vi.fn() }
      const preferences = createBotStartupPreferences(() => storage)
      expect(preferences.conversation(botStartupPreferenceScope("/workspace", "epoch"))).toBeNull()
      expect(preferences.mainView()).toBe("thread")
      expect(storage.setItem).not.toHaveBeenCalled()
    }
  )

  it("keeps navigation available when storage is denied and ignores missing host scope", () => {
    const preferences = createBotStartupPreferences(() => {
      throw new Error("storage denied")
    })
    expect(preferences.mainView()).toBe("thread")
    expect(preferences.conversation("scope")).toBeNull()
    expect(() => preferences.rememberMainView("bots")).not.toThrow()
    expect(() => preferences.rememberConversation("scope", "conversation")).not.toThrow()
    expect(botStartupPreferenceScope(undefined, "epoch")).toBeNull()
    expect(botStartupPreferenceScope("/workspace", undefined)).toBeNull()
  })

  it("restores a real conversation after renderer reload, and does not follow a deleted or foreign preference", async () => {
    const f = fixture()
    vi.stubGlobal("localStorage", f.storage)
    const store = new BotStore(":memory:")
    stores.push(store)
    const first = store.createBot({ nonce: "first", name: "First" })
    const second = store.createBot({ nonce: "second", name: "Second" })
    let workspace = "/workspace-a"
    api.status.mockImplementation(async () => ({
      protocol: 1,
      hostId: "restarted-host",
      platform: "darwin",
      runtimeReady: true,
      error: null,
      sharedWorkspace: workspace,
      dataEpoch: store.dataEpoch()
    }))
    api.snapshot.mockImplementation(async () => store.snapshot())
    api.messages.mockImplementation(async () => [])
    const scope = botStartupPreferenceScope(workspace, store.dataEpoch())!
    f.preferences.rememberConversation(scope, first.conversationId)
    vi.resetModules()
    const initial = (await import("./bot-workspace-store")).useBotWorkspaceStore
    await initial.getState().refresh()
    expect(initial.getState().selected).toBe(first.conversationId)
    initial.getState().select(second.conversationId)
    await vi.waitFor(() => expect(initial.getState().opening[second.conversationId]).toBe(false))
    vi.resetModules()
    const restarted = (await import("./bot-workspace-store")).useBotWorkspaceStore
    await restarted.getState().refresh()
    expect(restarted.getState().selected).toBe(second.conversationId)
    await vi.waitFor(() => expect(restarted.getState().opening[second.conversationId]).toBe(false))
    f.preferences.rememberConversation(scope, "deleted-conversation")
    vi.resetModules()
    const deleted = (await import("./bot-workspace-store")).useBotWorkspaceStore
    await deleted.getState().refresh()
    expect(store.snapshot().conversations.map((item) => item.id)).toContain(
      deleted.getState().selected
    )
    await vi.waitFor(() =>
      expect(deleted.getState().opening[deleted.getState().selected!]).toBe(false)
    )
    workspace = "/foreign-workspace"
    f.preferences.rememberConversation(scope, first.conversationId)
    vi.resetModules()
    const foreign = (await import("./bot-workspace-store")).useBotWorkspaceStore
    await foreign.getState().refresh()
    expect(foreign.getState().selected).toBe(store.snapshot().conversations[0].id)
    await vi.waitFor(() =>
      expect(foreign.getState().opening[foreign.getState().selected!]).toBe(false)
    )
    // Restoring layout never submits a task or changes the authoritative conversation roster.
    expect(store.snapshot().runs).toEqual([])
    expect(store.snapshot().conversations).toHaveLength(2)
  })
})
