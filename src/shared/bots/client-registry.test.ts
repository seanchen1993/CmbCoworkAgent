import { describe, expect, it, vi } from "vitest"
import { BotClientRegistry } from "./client-registry"
import type { BotChangeEvent, BotClient, BotSnapshot } from "./contracts"

describe("Bot host registration", () => {
  it("wraps frozen contextBridge methods without violating Proxy invariants", async () => {
    const unsubscribe = vi.fn()
    const client = Object.freeze({
      hostId: "local",
      subscribe: vi.fn(() => unsubscribe),
      open: vi.fn(async () => ({ threadId: "t" })),
      filePreview: Object.freeze({})
    }) as unknown as BotClient
    const registry = new BotClientRegistry()
    registry.register(client)
    const adapter = registry.get("local")
    expect(adapter.hostId).toBe("local")
    expect(await adapter.open("a")).toEqual({ threadId: "t" })
    adapter.subscribe(vi.fn())()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(adapter.filePreview).toBe(client.filePreview)
  })
  it("never routes unknown remote hosts to the local adapter, and preserves class-backed clients", async () => {
    let receive: ((event: BotChangeEvent) => void) | undefined
    class RemoteFixture {
      readonly hostId = "remote-test"
      #revision = 7
      async snapshot(): Promise<BotSnapshot> {
        return {
          host: {
            id: this.hostId,
            kind: "remote",
            name: "test",
            protocolVersion: 1,
            capabilities: { browser: false, groups: false, schedules: false }
          },
          revision: this.#revision,
          bots: [],
          tasks: [],
          schedules: [],
          groups: [],
          activities: []
        }
      }
      async open() {
        return { threadId: String(this.#revision) }
      }
      subscribe(listener: (event: BotChangeEvent) => void) {
        receive = listener
        return () => {
          receive = undefined
        }
      }
    }
    const registry = new BotClientRegistry(),
      client = new RemoteFixture() as unknown as BotClient
    const unregister = registry.register(client),
      adapter = registry.get(client.hostId)
    expect(() => registry.get("local")).toThrow("尚未连接")
    expect(await adapter.open("bot")).toEqual({ threadId: "7" })
    expect((await adapter.snapshot()).revision).toBe(7)
    const listener = vi.fn(),
      unsubscribe = adapter.subscribe(listener)
    receive!({ hostId: "local", revision: 8 })
    receive!({ hostId: client.hostId, revision: 8 })
    expect(listener).toHaveBeenCalledTimes(1)
    for (const revision of [-1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      receive!({ hostId: client.hostId, revision })
    expect(listener).toHaveBeenCalledTimes(1)
    receive!({ hostId: client.hostId, revision: 0 })
    expect(listener).toHaveBeenLastCalledWith({ hostId: client.hostId, revision: 0 })
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    unregister()
    expect(() => registry.get(client.hostId)).toThrow("尚未连接")
  })
  it("rejects cross-host snapshots and unsupported protocol versions", async () => {
    const registry = new BotClientRegistry()
    const snapshot = { host: { id: "wrong-host", protocolVersion: 1 }, bots: [], groups: [] }
    registry.register({ hostId: "local", snapshot: async () => snapshot } as unknown as BotClient)
    await expect(registry.get("local").snapshot()).rejects.toThrow("身份或协议")
    snapshot.host.id = "local"
    snapshot.host.protocolVersion = 2
    await expect(registry.get("local").snapshot()).rejects.toThrow("身份或协议")
  })
})
