import {
  FUNCTION_DISPLAY_PROTOCOL,
  type FunctionSiteReadApi,
  type FunctionSiteReadRequest,
  type FunctionSiteRenderRequest
} from "../shared/mods/v2/display-read-protocol"
import type { FunctionSiteMountOutcome, FunctionSiteReadOutcome, FunctionUiSite } from "../shared/mods/v2/sites"
import type { FunctionPaneSnapshot } from "../shared/mods/v2/ui"

interface SiteReadIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  sendSync(channel: string): unknown
}

interface SiteMountBridge {
  siteMount(threadId: string, component: FunctionUiSite, messageId?: string): Promise<string | null>
  siteMountOutcome(
    threadId: string, component: FunctionUiSite, messageId?: string, expectedRequestId?: string
  ): Promise<FunctionSiteMountOutcome>
}

/** IDs are local to one preload lifetime; no AbortSignal crosses contextBridge. */
export function createFunctionSiteReadBridge(
  ipc: SiteReadIpc
): Required<FunctionSiteReadApi> & SiteMountBridge {
  let namespace: string | undefined
  let sequence = 0
  const ensureDocument = (): string => {
    if (namespace === undefined) {
      const value = ipc.sendSync("mods:function-site-read-scope")
      if (typeof value !== "string" || !/^[a-f0-9-]{36}$/.test(value))
        throw Error("MODS_DISPLAY_READ_SCOPE_INVALID")
      namespace = value
    }
    return namespace
  }
  return {
    nextSiteReadId(): string {
      const current = ensureDocument()
      if (sequence >= Number.MAX_SAFE_INTEGER) throw Error("MODS_DISPLAY_READ_ID_EXHAUSTED")
      return `${current}:${++sequence}`
    },
    async siteMount(threadId, component, messageId) {
      ensureDocument()
      return ipc.invoke("mods:function-site-mount", { threadId, component, messageId }) as
        Promise<string | null>
    },
    async siteMountOutcome(threadId, component, messageId, expectedRequestId) {
      ensureDocument()
      return ipc.invoke("mods:function-site-mount-outcome", {
        threadId, component, messageId, expectedRequestId
      }) as Promise<FunctionSiteMountOutcome>
    },
    cancelSiteRead(readId: string): Promise<void> {
      return ipc.invoke("mods:function-site-read-cancel", { readId }).then(() => undefined)
    },
    async siteRead(
      threadId,
      component,
      props,
      presentationId,
      messageId,
      expectedRequestId,
      ownerRequired,
      readId
    ): Promise<FunctionSiteReadOutcome> {
      ensureDocument()
      return ipc.invoke("mods:function-site-read", {
        threadId,
        component,
        props,
        presentationId,
        messageId,
        expectedRequestId,
        ownerRequired,
        readId,
        protocol: FUNCTION_DISPLAY_PROTOCOL
      } satisfies FunctionSiteReadRequest) as Promise<FunctionSiteReadOutcome>
    },
    siteRender(threadId, owner, props, readId): Promise<FunctionPaneSnapshot | null> {
      return ipc.invoke("mods:function-site-render", {
        threadId,
        owner,
        props,
        readId
      } satisfies FunctionSiteRenderRequest) as Promise<FunctionPaneSnapshot | null>
    }
  }
}
