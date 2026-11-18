import type { IpcMainInvokeEvent } from "electron"
import {
  PROJECT_AGENT_RUN_CHANNEL,
  type ProjectAgentRunListener
} from "../../shared/project-agent-run"

/** Events return only to the invoking renderer and its one-use request channel. */
export function projectAgentProgress(
  event: IpcMainInvokeEvent,
  runId: unknown,
  signal?: AbortSignal
): ProjectAgentRunListener | undefined {
  if (runId === undefined) return undefined
  if (
    typeof runId !== "string" ||
    !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(runId)
  )
    throw new Error("运行标识无效，请重新发起分析")
  return (payload) => {
    if (!signal?.aborted && !event.sender.isDestroyed())
      event.sender.send(`${PROJECT_AGENT_RUN_CHANNEL}${runId}`, payload)
  }
}
