/** Routes exist only for a live Bot run. Transport/binding/lease checks are repeated on answer. */
export interface BotInteractionRoute {
  principalId: string
  conversationKey: string
  threadId: string
  prefix: string
  realm: string
  kind: "dm" | "group"
  botEventId?: string
  senderId?: string
  isCurrent: () => boolean
}
class BotInteractionRoutes {
  private routes = new Map<string, BotInteractionRoute>()
  private connected: ((realm: string, principal: string) => boolean) | null = null
  setTransport(check: (realm: string, principal: string) => boolean): () => void {
    this.connected = check
    return () => {
      if (this.connected === check) this.connected = null
    }
  }
  available(route: Pick<BotInteractionRoute, "realm" | "principalId">): boolean {
    return this.connected?.(route.realm, route.principalId) ?? false
  }
  enabled(): boolean {
    return this.connected !== null
  }
  register(route: BotInteractionRoute): () => void {
    this.routes.set(route.threadId, route)
    return () => {
      if (this.routes.get(route.threadId) === route) this.routes.delete(route.threadId)
    }
  }
  has(threadId: string): boolean {
    return this.routes.has(threadId)
  }
  get(threadId: string): BotInteractionRoute | null {
    const route = this.routes.get(threadId)
    if (!route || !this.available(route)) return null
    try {
      return route.isCurrent() ? route : null
    } catch {
      return null
    }
  }
}
export const botInteractionRoutes = new BotInteractionRoutes()
