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
  onQuestionUndeliverable?: (requestId: string) => void
  /** Present only on a project execution delegated from this Bot conversation. */
  featureGate?: {
    projectId: string
    slug: string
    projectName: string
    featureName: string
    threadTitle: string
    publicText: (value: string) => string
    onUndeliverable: (gateId: string) => void
  }
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
  private registered(threadId: string): BotInteractionRoute | undefined {
    // Runtime subthreads append "__<scope>" to their owning conversation id.
    let key = threadId
    while (true) {
      const route = this.routes.get(key)
      if (route) return route
      const parent = key.lastIndexOf("__")
      if (parent < 0) return undefined
      key = key.slice(0, parent)
    }
  }
  has(threadId: string): boolean {
    return this.registered(threadId) !== undefined
  }
  get(threadId: string): BotInteractionRoute | null {
    const route = this.registered(threadId)
    if (!route || !this.available(route)) return null
    try {
      return route.isCurrent() ? route : null
    } catch {
      return null
    }
  }
}
export const botInteractionRoutes = new BotInteractionRoutes()

/** A managed retry waits after its execution turn has ended. Scope its route to
 * the pending decision, not to a live runtime or to all future Feature turns. */
class BotFeatureDecisionRoutes {
  private routes = new Map<string, BotInteractionRoute>()
  register(id: string, route: BotInteractionRoute): void {
    this.routes.set(id, route)
  }
  remove(id: string): void {
    this.routes.delete(id)
  }
  has(id: string): boolean {
    return this.routes.has(id)
  }
  get(id: string): BotInteractionRoute | null {
    const route = this.routes.get(id)
    if (!route || !botInteractionRoutes.available(route)) return null
    try {
      return route.isCurrent() ? route : null
    } catch {
      return null
    }
  }
}
export const botFeatureDecisionRoutes = new BotFeatureDecisionRoutes()
