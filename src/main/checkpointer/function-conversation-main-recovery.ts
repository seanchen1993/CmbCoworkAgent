import type { RunnableConfig } from "@langchain/core/runnables"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import type { FunctionConversationStore } from "../db/function-conversation-store"
import type { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { captureThreadIncarnation, matchesThreadIncarnation,
  type ThreadIncarnationRow } from "../services/thread-incarnation"
import { assertFunctionConversationState, readFunctionConversationState,
  type FunctionConversationDeliveryBinding, type FunctionConversationState } from
  "./function-conversation-delivery"

export function nativeFunctionConversationWorkspace(metadata: string | null): string | undefined {
  try {
    const parsed: unknown = JSON.parse(metadata ?? "{}")
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
    const value: unknown = Reflect.get(parsed, "workspacePath")
    return typeof value === "string" && value.length ? value : undefined
  } catch { return undefined }
}

interface MainRecoveryHost {
  readonly database: NativeSqliteAdapter
  readonly store: FunctionConversationStore
  readonly threadId: string
  /** Canonical workspace, resolved by the original native host, never by a public stamp. */
  readonly workspace: string
  readonly originalThread: ThreadIncarnationRow
  readonly signal: AbortSignal
  currentDatabase(): NativeSqliteAdapter
  readThread(): ThreadIncarnationRow | null | undefined
  assertCurrent(): void
}

/** Existing main data only; use solely with the Saver's original missing-row receipt. */
export function createMainFunctionConversationRecoveryCapture(host: MainRecoveryHost):
  (config: RunnableConfig, state: FunctionConversationState) => FunctionConversationDeliveryBinding {
  const { database, store, threadId, workspace, signal } = host
  const incarnation = Object.freeze(captureThreadIncarnation(host.originalThread))
  const originalWorkspace = nativeFunctionConversationWorkspace(host.originalThread.metadata)
  const currentDatabase = host.currentDatabase.bind(host), readThread = host.readThread.bind(host)
  const assertHost = host.assertCurrent.bind(host)
  const guard = () => {
    signal.throwIfAborted()
    assertHost()
    const row = readThread()
    if (currentDatabase() !== database || !matchesThreadIncarnation(row, incarnation) ||
      !row || nativeFunctionConversationWorkspace(row.metadata) !== originalWorkspace ||
      !originalWorkspace || !workspace)
      throw new ModFunctionError("MODS_CONVERSATION_THREAD_CHANGED")
  }
  guard()
  return (config, rawState) => {
    guard()
    if (config.configurable?.thread_id !== threadId ||
      config.configurable?.checkpoint_ns !== "" ||
      typeof config.configurable?.checkpoint_id !== "string" ||
      !config.configurable.checkpoint_id)
      throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_SCOPE")
    const state = readFunctionConversationState(rawState)
    const root = store.findMain({ threadId, workspace, incarnation, checkpointNamespace: "" }, guard)
    if (!root) throw new ModFunctionError("MODS_CONVERSATION_RECOVERY_REQUIRED")
    const target = store.selectBranch(root, state.branchId, guard)
    assertFunctionConversationState(target, state)
    guard()
    return Object.freeze({ target, checkpointThreadId: threadId,
      checkpointIncarnation: incarnation, signal, assertCurrent: guard })
  }
}
