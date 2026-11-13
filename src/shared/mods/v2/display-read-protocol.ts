import type { ModObject } from "../types"
import type { FunctionSiteReadOutcome, FunctionUiSite } from "./sites"
import type { FunctionPaneSnapshot } from "./ui"

export const FUNCTION_DISPLAY_PROTOCOL = "mods.display/v1" as const

/** Data-only transport. A read ID cancels work; it carries no grant or source proof. */
export interface FunctionSiteReadRequest {
  threadId: string
  component: FunctionUiSite
  props: ModObject
  presentationId?: string
  messageId?: string
  expectedRequestId?: string
  protocol?: unknown
  ownerRequired?: boolean
  readId?: string
}

export interface FunctionSiteRenderRequest {
  threadId: string
  owner: string
  props: ModObject
  readId?: string
}

export interface FunctionSiteReadCancellation {
  readId?: string
}

/** Keep optional argument positions and legacy call arity; only append an actual read ID. */
export type FunctionSiteReadArguments = [
  threadId: string,
  component: FunctionUiSite,
  props: ModObject,
  presentationId?: string,
  messageId?: string,
  expectedRequestId?: string,
  ownerRequired?: boolean,
  readId?: string
]
export type FunctionSiteRenderArguments = [
  threadId: string,
  owner: string,
  props: ModObject,
  readId?: string
]

export interface FunctionSiteReadApi {
  nextSiteReadId?(): string
  cancelSiteRead?(readId: string): Promise<void>
  siteRead(...args: FunctionSiteReadArguments): Promise<FunctionSiteReadOutcome>
  siteRender(...args: FunctionSiteRenderArguments): Promise<FunctionPaneSnapshot | null>
}
