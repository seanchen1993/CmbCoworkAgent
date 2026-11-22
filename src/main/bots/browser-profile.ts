import type { Cookie } from "electron"
import type { BrowserContext } from "playwright"

export interface BotBrowserProfileSource {
  enabled(): boolean
  prepare(): Promise<void>
  read(): Promise<Cookie[]>
  subscribe(listener: () => Promise<void>): () => void
}

/** Copy login state, never tabs or the shared workbench browser target. */
export async function syncBotBrowserProfile(
  context: Pick<BrowserContext, "addCookies">,
  source: BotBrowserProfileSource
): Promise<() => void> {
  if (!source.enabled()) return () => {}
  let disposed = false
  let pending: Promise<void> | undefined
  let dirty = false
  const sync = (): Promise<void> => {
    dirty = true
    return (pending ??= (async () => {
      while (dirty && !disposed && source.enabled()) {
        dirty = false
        const cookies = (await source.read())
          .filter(
            (cookie) =>
              !(cookie as Cookie & { partitionKey?: unknown }).partitionKey &&
              cookie.domain &&
              (cookie.expirationDate === undefined || cookie.expirationDate > Date.now() / 1000)
          )
          .map((cookie) => ({
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain!,
            path: cookie.path || "/",
            httpOnly: cookie.httpOnly,
            secure: cookie.secure,
            expires: cookie.expirationDate ?? -1,
            sameSite:
              cookie.sameSite === "no_restriction"
                ? ("None" as const)
                : cookie.sameSite === "strict"
                  ? ("Strict" as const)
                  : ("Lax" as const)
          }))
        // Bound protocol frames and avoid concurrent bursts for large Chrome profiles.
        for (
          let offset = 0;
          offset < cookies.length && !disposed && source.enabled();
          offset += 100
        )
          await context.addCookies(cookies.slice(offset, offset + 100))
      }
    })().finally(() => {
      pending = undefined
    }))
  }
  await source.prepare()
  const unsubscribe = source.subscribe(sync)
  const dispose = () => {
    disposed = true
    unsubscribe()
  }
  ;(context as BrowserContext).once?.("close", dispose)
  try {
    await sync()
  } catch {
    // Keep the subscription: a later explicit re-import can recover without restarting Bot.
    console.warn("[BotBrowser] Login import unavailable; use browser takeover or re-import Cookie")
  }
  return dispose
}

export async function connectBotBrowserProfile(context: BrowserContext): Promise<() => void> {
  const { getGlobalBrowserService } = await import("../browser/core/browser-service-registry")
  const source = getGlobalBrowserService()
  if (!source) return () => {}
  const { isBrowserProfileImportActive, ensureBrowserProfileAutoImport } =
    await import("../ipc/browser-profile-import")
  return syncBotBrowserProfile(context, {
    enabled: isBrowserProfileImportActive,
    prepare: () => ensureBrowserProfileAutoImport(source),
    read: () => source.readProfileCookies(),
    subscribe: (listener) => source.onProfileImported(listener)
  })
}
