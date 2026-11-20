import type { ImTargetSnapshot } from "./conversation-state"

export interface ImRemoteInteractionRouteSnapshot {
  eventId: string
  principalId: string
  conversationKey: string
  threadId: string
  targetSnapshot: ImTargetSnapshot
}

interface RegisteredRoute extends ImRemoteInteractionRouteSnapshot {
  registration: symbol
}

/**
 * A selected target routes only future ordinary messages. An already-running
 * event keeps this immutable route so its approval and user-input interactions
 * remain addressable after the user switches to another Thread.
 */
export class ImRemoteInteractionRouteRegistry {
  private readonly routes = new Map<string, RegisteredRoute>()

  register(route: ImRemoteInteractionRouteSnapshot): () => void {
    const registration = Symbol(route.eventId)
    this.routes.set(route.threadId, {
      ...route,
      targetSnapshot: { ...route.targetSnapshot },
      registration
    })
    return () => {
      const current = this.routes.get(route.threadId)
      if (current?.registration === registration) this.routes.delete(route.threadId)
    }
  }

  get(threadId: string): ImRemoteInteractionRouteSnapshot | null {
    const route = this.routes.get(threadId)
    if (!route) return null
    return {
      eventId: route.eventId,
      principalId: route.principalId,
      conversationKey: route.conversationKey,
      threadId: route.threadId,
      targetSnapshot: { ...route.targetSnapshot }
    }
  }

  clear(): void {
    this.routes.clear()
  }
}

export const imRemoteInteractionRouteRegistry = new ImRemoteInteractionRouteRegistry()
