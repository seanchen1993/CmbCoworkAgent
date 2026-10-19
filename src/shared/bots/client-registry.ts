import { BOT_PROTOCOL_VERSION, BotError, type BotClient } from "./contracts"

/** Registration is explicit: an unknown remote host must never fall back to the local machine. */
export class BotClientRegistry {
  private readonly clients = new Map<string, BotClient>()
  register(client: BotClient): () => void {
    if (!client.hostId || this.clients.has(client.hostId))
      throw new BotError("CONFLICT", "Bot 主机已注册或标识无效")
    const overrides: Pick<BotClient, "snapshot" | "subscribe"> = {
      async snapshot() {
        const snapshot = await client.snapshot()
        if (
          snapshot.host.id !== client.hostId ||
          snapshot.host.protocolVersion !== BOT_PROTOCOL_VERSION
        )
          throw new BotError("UNSUPPORTED_HOST", "Bot 主机身份或协议版本不匹配")
        if (
          snapshot.bots.some((bot) => bot.hostId !== client.hostId) ||
          snapshot.groups.some((group) => group.hostId !== client.hostId)
        )
          throw new BotError("CONFLICT", "Bot 数据包含其他主机的资源")
        return snapshot
      },
      subscribe(listener) {
        return client.subscribe((event) => {
          if (
            event.hostId === client.hostId &&
            Number.isSafeInteger(event.revision) &&
            event.revision >= 0
          )
            listener(event)
        })
      }
    }
    // Preserve prototype methods and private fields of future network client implementations.
    const methods = new Map<PropertyKey, unknown>()
    // Electron contextBridge freezes its exported object. Proxying that object directly
    // cannot replace non-configurable methods; a separate facade preserves invariants.
    const guarded = new Proxy({} as BotClient, {
      get(_target, key) {
        if (key === "snapshot" || key === "subscribe") return overrides[key]
        const value = Reflect.get(client, key, client)
        if (typeof value !== "function") return value
        if (!methods.has(key)) methods.set(key, value.bind(client))
        return methods.get(key)
      }
    })
    this.clients.set(client.hostId, guarded)
    return () => {
      if (this.clients.get(client.hostId) === guarded) this.clients.delete(client.hostId)
    }
  }
  get(hostId: string): BotClient {
    const client = this.clients.get(hostId)
    if (!client) throw new BotError("UNSUPPORTED_HOST", "此 Bot 主机尚未连接")
    return client
  }
}
