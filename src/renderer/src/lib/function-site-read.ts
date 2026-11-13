import type { ModObject } from "../../../shared/mods/types"
import type { FunctionSiteReadOutcome, FunctionUiSite } from "../../../shared/mods/v2/sites"
import type { FunctionPaneSnapshot } from "../../../shared/mods/v2/ui"

import type { FunctionSiteReadApi as SiteReadApi } from "../../../shared/mods/v2/display-read-protocol"
export type { FunctionSiteReadApi } from "../../../shared/mods/v2/display-read-protocol"

function invokeSiteRead<T>(
  api: SiteReadApi,
  signal: AbortSignal,
  invoke: (readId?: string) => Promise<T>
): Promise<T> {
  signal.throwIfAborted()
  const readId = api.nextSiteReadId?.()
  const cancel = () => {
    if (readId) void api.cancelSiteRead?.(readId).catch(() => {})
  }
  signal.addEventListener("abort", cancel, { once: true })
  try {
    // An aborted caller retains its physical queue slot until Main's actual reply.
    // Racing this Promise against abort would turn ignored cancellation into unbounded IPC.
    return Promise.resolve(invoke(readId)).finally(() =>
      signal.removeEventListener("abort", cancel)
    )
  } catch (error) {
    signal.removeEventListener("abort", cancel)
    throw error
  }
}

export function readFunctionSite(
  api: SiteReadApi,
  request: {
    threadId: string
    component: FunctionUiSite
    props: ModObject
    presentationId?: string
    messageId?: string
    expectedRequestId?: string
    ownerRequired?: boolean
  },
  signal: AbortSignal
): Promise<FunctionSiteReadOutcome> {
  return invokeSiteRead(api, signal, (readId) =>
    api.siteRead(
      request.threadId,
      request.component,
      request.props,
      request.presentationId,
      request.messageId,
      request.expectedRequestId,
      request.ownerRequired,
      ...(readId === undefined ? [] : ([readId] as const))
    )
  )
}

export function renderFunctionSite(
  api: SiteReadApi,
  request: {
    threadId: string
    owner: string
    props: ModObject
  },
  signal: AbortSignal
): Promise<FunctionPaneSnapshot | null> {
  return invokeSiteRead(api, signal, (readId) =>
    api.siteRender(
      request.threadId,
      request.owner,
      request.props,
      ...(readId === undefined ? [] : ([readId] as const))
    )
  )
}
