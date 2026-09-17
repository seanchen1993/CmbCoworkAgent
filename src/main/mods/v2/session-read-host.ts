import type { ModJson } from "../../../shared/mods/types"
import type { FunctionSessionReadMethod } from "../../../shared/mods/v2/session"
import type { ModsManager } from "../manager"
import { ModError } from "../errors"
import { readFunctionSessionRepo } from "./session-repo"
import { readColdFunctionSession } from "./session-cold-read"
import { readLiveFunctionSessionTranscript } from "./session-transcript"
import { readLiveContextUsage, projectContextUsage } from "../../agent/context-usage"
import type { FunctionSessionUsageArgs } from "../../../shared/mods/v2/session"

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
    if (method === "session.usage" && usageArgs.breakdown)
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
        return { context: projectContextUsage(session.contextWindow, usage), rateLimits: [] }
      }
      if (method === "session.turns" || method === "session.messages")
        return (await readLiveFunctionSessionTranscript(session.messages, method, signal, () => {
          assertLive()
          session.assertLive()
        })) as unknown as ModJson
    }
    if (method === "session.usage" && session.bound) {
      if (session.contextWindow === undefined) throw new ModError("MODS_CONTEXT_WINDOW_UNAVAILABLE")
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
