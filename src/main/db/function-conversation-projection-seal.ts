import type { NativeSqliteAdapter } from "./native-sqlite-adapter"
import type { FunctionConversationProjectionColumns } from "./function-conversation-projection-receipt"
import { readStoredFunctionConversationProjection,
  type FunctionConversationProjectionSealInput, type FunctionConversationProjectionReadScope }
  from "./function-conversation-projection-read"

export type { FunctionConversationProjectionSealInput } from "./function-conversation-projection-read"

/**
 * Read-only data fence for an already sealed row, including inside the original writer transaction.
 * It neither certifies COMMIT nor constructs a Store, schema, capability or replacement receipt.
 */
export function assertStoredProjectionReceipt(db: NativeSqliteAdapter,
  input: FunctionConversationProjectionSealInput, scope?: FunctionConversationProjectionReadScope):
  FunctionConversationProjectionColumns {
  return readStoredFunctionConversationProjection(db, input, scope)
}
