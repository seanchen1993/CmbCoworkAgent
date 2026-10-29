import type { ModConfigurationChangeEvent, ModUiChangeEvent } from "../../../shared/mods/types"

export interface FunctionSiteEventSource {
  onCardsChanged(callback: (event: ModUiChangeEvent) => void): () => void
  onConfigurationChanged(callback: (event?: ModConfigurationChangeEvent) => void): () => void
}

interface Subscription<Event> {
  callback: (event: Event) => void
  active: boolean
}

interface SharedListener<Event> {
  subscriptions: Set<Subscription<Event>>
  closed: boolean
  release?: () => void
}

const cardListeners = new WeakMap<FunctionSiteEventSource, SharedListener<ModUiChangeEvent>>()
const configurationListeners = new WeakMap<
  FunctionSiteEventSource,
  SharedListener<ModConfigurationChangeEvent | undefined>
>()

/** Share only transport listeners. Every slot keeps its own synchronous invalidation callback. */
function subscribe<Event>(
  listeners: WeakMap<FunctionSiteEventSource, SharedListener<Event>>,
  source: FunctionSiteEventSource,
  listen: (callback: (event: Event) => void) => () => void,
  callback: (event: Event) => void
): () => void {
  let listener = listeners.get(source)
  const created = !listener
  if (!listener) {
    listener = { subscriptions: new Set(), closed: false }
    listeners.set(source, listener)
  }
  const shared = listener
  const subscription = { callback, active: true }
  shared.subscriptions.add(subscription)

  const close = (): void => {
    shared.closed = true
    if (listeners.get(source) === shared) listeners.delete(source)
    const release = shared.release
    shared.release = undefined
    release?.()
  }
  if (created) {
    try {
      const release = listen((event) => {
        if (shared.closed) return
        let failed = false
        let firstError: unknown
        // New subscriptions wait for the next event. Removed subscriptions never run late.
        for (const entry of [...shared.subscriptions]) {
          if (shared.closed || !entry.active) continue
          try {
            entry.callback(event)
          } catch (error) {
            // One failed slot must not skip the remaining synchronous revocations.
            if (!failed) firstError = error
            failed = true
          }
        }
        if (failed) throw firstError
      })
      if (shared.closed) release()
      else shared.release = release
    } catch (error) {
      for (const entry of shared.subscriptions) entry.active = false
      shared.subscriptions.clear()
      close()
      throw error
    }
  }
  return () => {
    if (!subscription.active) return
    subscription.active = false
    shared.subscriptions.delete(subscription)
    if (shared.subscriptions.size === 0) close()
  }
}

export function subscribeFunctionSiteCardsChanged(
  source: FunctionSiteEventSource,
  callback: (event: ModUiChangeEvent) => void
): () => void {
  return subscribe(cardListeners, source, (listener) => source.onCardsChanged(listener), callback)
}

export function subscribeFunctionSiteConfigurationChanged(
  source: FunctionSiteEventSource,
  callback: (event?: ModConfigurationChangeEvent) => void
): () => void {
  return subscribe(
    configurationListeners,
    source,
    (listener) => source.onConfigurationChanged(listener),
    callback
  )
}
