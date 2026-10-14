import type { ModGrant } from "../control-store"
import type { FunctionRegistration } from "../../../shared/mods/v2/contracts"
import type {
  FunctionApiMessage,
  FunctionSessionAppendArgs,
  FunctionSessionAppendResult,
  FunctionSessionMessagesArgs,
  FunctionSessionMessagesDeny
} from "../../../shared/mods/v2/session-append"
import type { FunctionSessionMessage } from "../../../shared/mods/v2/session"
import type { FunctionPlugin } from "./dispatcher"
import type { FunctionSessionAppendTicket } from "./session-append-ticket"

/** One invocation receipt; identity is the stable actual source, not this fresh receipt. */
export interface FunctionSessionAppendSource {
  readonly identity: object
  readonly registration?: FunctionRegistration
  readonly signal: AbortSignal
  assertCurrent(): void
}

export interface FunctionConversationOwnerContext {
  readonly owner: object
  readonly workspace: string
  readonly threadId: string
  readonly signal: AbortSignal
  readonly readOnly: boolean
  assertCurrent(): void
}

export interface FunctionConversationCallContext extends FunctionConversationOwnerContext {
  readonly plugin: FunctionPlugin
  readonly grant?: ModGrant
}

export type FunctionConversationMessages = FunctionSessionMessage[] | FunctionApiMessage[] |
  FunctionSessionMessagesDeny
export type FunctionConversationAppendRun = (
  ticket: FunctionSessionAppendTicket
) => Promise<FunctionSessionAppendResult>

/** Actual owner registration only. Implementations must not write candidate metadata. */
export interface FunctionConversationManagerHost {
  openConversationOwner?(context: FunctionConversationOwnerContext): () => void
  /** Called only after the actual manager map adopts this entry, or before active startup. */
  activateConversationOwner?(context: FunctionConversationOwnerContext): void
  appendSession?(
    context: FunctionConversationCallContext,
    args: FunctionSessionAppendArgs,
    source: FunctionSessionAppendSource,
    run: FunctionConversationAppendRun
  ): Promise<FunctionSessionAppendResult>
  readConversation?(
    context: FunctionConversationCallContext,
    args: FunctionSessionMessagesArgs
  ): Promise<FunctionConversationMessages>
}
