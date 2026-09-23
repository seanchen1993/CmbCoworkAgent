import type { ModJson } from "../../../shared/mods/types"
import type { FunctionSessionReadMethod } from "../../../shared/mods/v2/session"
import type { ModsManager } from "../manager"
import { ModError } from "../errors"
import { readFunctionSessionRepo } from "./session-repo"
import { readColdFunctionSession } from "./session-cold-read"
import { readLiveFunctionSessionTranscript } from "./session-transcript"
import {
  readLiveContextUsage,
  projectContextUsage,
  projectContextBreakdown
} from "../../agent/context-usage"
import type { FunctionSessionUsageArgs } from "../../../shared/mods/v2/session"
import { getLocalThreadRunLease } from "../../agent/thread-run-lease"

/** Metadata has a live read scope, never an execution lease or a fabricated agent. */
export async function queryFunctionSessionRead(
  manager: ModsManager,
  assertPlainThread: (threadId: string) => void,
  assertWorkspace: () => void,
  workspace: string,
  threadId: string,
  method: FunctionSessionReadMethod,
  signal: AbortSignal,
  readCold = readColdFunctionSession,
  usageArgs: FunctionSessionUsageArgs = {}
): Promise<ModJson> {
  if (
    (usageArgs.breakdown !== undefined &&
      usageArgs.breakdown !== "summary" &&
      usageArgs.breakdown !== "full") ||
    usageArgs.columns !== undefined &&
    (!Number.isSafeInteger(usageArgs.columns) || usageArgs.columns <= 0)
  )
    throw new ModError("MODS_SESSION_USAGE_ARGUMENT")
  signal.throwIfAborted()
  assertWorkspace()
  const scope = manager.functionRuntimeScope(workspace, threadId)
  const assertLive = () => {
    signal.throwIfAborted()
    scope.assertLive()
    assertWorkspace()
    if (!scope.bound) assertPlainThread(threadId)
  }
  assertLive()
  const session = manager.captureFunctionSession(workspace, threadId)
  try {
    session.assertLive()
    if (
      method === "session.usage" &&
      usageArgs.breakdown !== undefined &&
      (!session.model || !session.request || session.messages === undefined)
    )
      throw new ModError("MODS_CONTEXT_BREAKDOWN_UNAVAILABLE")
    if (method === "session.repo") {
      const check = () => {
        assertLive()
        session.assertLive()
      }
      const value = await readFunctionSessionRepo(scope.workspace, signal, check)
      check()
      return value ? { ...value } : null
    }
    if (method === "session.model" && session.model !== undefined) return session.model
    if (method === "session.model" && session.bound) throw new ModError("MODS_SESSION_UNAVAILABLE")
    if (session.messages !== undefined) {
      if (method === "session.usage" && session.contextWindow !== undefined) {
        const usage = await readLiveContextUsage(
          session.messages,
          session.contextState,
          signal,
          () => {
            assertLive()
            session.assertLive()
          }
        )
        assertLive()
        session.assertLive()
        const baseContext = projectContextUsage(session.contextWindow, usage)
        if (usageArgs.breakdown) {
          if (!session.model || !session.request)
            throw new ModError("MODS_CONTEXT_BREAKDOWN_UNAVAILABLE")
          return {
            context: {
              ...baseContext,
              breakdown: projectContextBreakdown({
                detail: usageArgs.breakdown,
                columns: usageArgs.columns,
                model: session.model,
                window: session.contextWindow,
                systemMessage: session.request.systemMessage,
                tools: session.request.tools,
                messages: session.request.messages,
                contextSources: session.request.contextSources,
                apiUsage: usage
              })
            },
            rateLimits: []
          }
        }
        return { context: baseContext, rateLimits: [] }
      }
      if (method === "session.turns" || method === "session.messages")
        return (await readLiveFunctionSessionTranscript(session.messages, method, signal, () => {
          assertLive()
          session.assertLive()
        })) as unknown as ModJson
    }
    if (method === "session.usage" && session.bound) {
      if (session.contextWindow === undefined) throw new ModError("MODS_CONTEXT_WINDOW_UNAVAILABLE")
      if (usageArgs.breakdown) throw new ModError("MODS_CONTEXT_BREAKDOWN_UNAVAILABLE")
      return { context: projectContextUsage(session.contextWindow), rateLimits: [] }
    }
    const result = await readCold(threadId, method, signal)
    assertLive()
    session.assertLive()
    result.assertLive()
    return result.value
  } finally {
    session.release()
  }
}

/**
 * Explicit compaction is a checkpoint mutation. It is therefore only exposed
 * while the desktop main runtime is idle; a plugin cannot mutate the same
 * checkpoint from inside the turn that is currently executing it.
 */
export async function compactFunctionSession(
  manager: ModsManager,
  assertPlainThread: (threadId: string) => void,
  assertWorkspace: () => void,
  workspace: string,
  threadId: string,
  instructions: string,
  signal: AbortSignal
): Promise<ModJson> {
  signal.throwIfAborted()
  assertWorkspace()
  if (getLocalThreadRunLease(threadId))
    throw new ModError("MODS_CONTEXT_COMPACTION_ACTIVE")
  const scope = manager.functionRuntimeScope(workspace, threadId)
  const assertLive = () => {
    signal.throwIfAborted()
    scope.assertLive()
    assertWorkspace()
    if (!scope.bound) assertPlainThread(threadId)
  }
  assertLive()
  const session = manager.captureFunctionSession(workspace, threadId)
  try {
    session.assertLive()
    if (!session.bound || !session.compact || session.messages === undefined)
      throw new ModError("MODS_SESSION_UNAVAILABLE")
    const value = await session.compact(
      instructions,
      session.messages,
      session.contextState ?? {},
      signal
    )
    assertLive()
    session.assertLive()
    return value
  } finally {
    session.release()
  }
}
