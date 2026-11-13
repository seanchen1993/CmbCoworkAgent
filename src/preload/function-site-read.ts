import {
  FUNCTION_DISPLAY_PROTOCOL,
  type FunctionSiteReadApi,
  type FunctionSiteReadRequest,
  type FunctionSiteRenderRequest
} from "../shared/mods/v2/display-read-protocol"
import type { FunctionSiteReadOutcome } from "../shared/mods/v2/sites"
import type { FunctionPaneSnapshot } from "../shared/mods/v2/ui"

interface SiteReadIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  sendSync(channel: string): unknown
}

/** IDs are local to one preload lifetime; no AbortSignal crosses contextBridge. */
export function createFunctionSiteReadBridge(ipc: SiteReadIpc): Required<FunctionSiteReadApi> {
  let namespace: string | undefined
  let sequence = 0
  return {
    nextSiteReadId(): string {
      if (namespace === undefined) {
        const value = ipc.sendSync("mods:function-site-read-scope")
        if (typeof value !== "string" || !/^[a-f0-9-]{36}$/.test(value))
          throw Error("MODS_DISPLAY_READ_SCOPE_INVALID")
        namespace = value
      }
      if (sequence >= Number.MAX_SAFE_INTEGER) throw Error("MODS_DISPLAY_READ_ID_EXHAUSTED")
      return `${namespace}:${++sequence}`
    },
    cancelSiteRead(readId: string): Promise<void> {
      return ipc.invoke("mods:function-site-read-cancel", { readId }).then(() => undefined)
    },
    siteRead(
      threadId,
      component,
      props,
      presentationId,
      messageId,
      expectedRequestId,
      ownerRequired,
      readId
    ): Promise<FunctionSiteReadOutcome> {
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
