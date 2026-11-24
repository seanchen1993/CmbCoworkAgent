import type { IpcRenderer, IpcRendererEvent } from "electron"
import type { SchedulerRendererEvent } from "../main/agent/stream-converter"

type Delta = Extract<SchedulerRendererEvent, { type: "message-delta" }>
const MAX_PREVIEWS = 64
const MAX_TEXT = 32 * 1024

/** Opening a live task can happen after its first (or only) token. Retain just
 * its uncommitted reply until the renderer subscribes. Durable turns and
 * already visible tasks use the normal transcript and stream paths. */
export function createBotWorkStreamPreview(ipc: IpcRenderer) {
  const pending = new Map<string, { read(): Delta | undefined; stop(): void }>()
  ipc.on("scheduler:thread-activity", (_event, activity: { threadId: string; type: string; botWork?: boolean }) => {
    const { threadId, type } = activity
    if (type === "done" || type === "error") {
      pending.get(threadId)?.stop()
      return
    }
    if (type !== "started" || !activity.botWork) return
    const channel = `scheduler:stream:${threadId}`
    pending.get(threadId)?.stop()
    if (ipc.listenerCount(channel)) return
    // Only preview memory is bounded. The Host continues to run every task.
    if (pending.size >= MAX_PREVIEWS) pending.values().next().value?.stop()
    let latest: Delta | undefined
    const receive = (_: IpcRendererEvent, event: SchedulerRendererEvent) => {
      if (event.type === "message-delta" && !event.subagentId) {
        if (!event.content) return
        const prior = latest?.id === event.id && latest.provider_occurrence === event.provider_occurrence ? latest.content : ""
        const content = event.contentMode === "snapshot" ? event.content : prior + event.content
        if (content.length > MAX_TEXT) { stop(); return }
        latest = { type: "message-delta", id: event.id, content, contentMode: "snapshot",
          provider_source_id: event.provider_source_id, provider_occurrence: event.provider_occurrence }
      } else if ((event.type === "full-messages" || event.type === "turn-messages") &&
          latest && event.messages.some(message => message.id === latest?.id)) {
        latest = undefined
      } else if (event.type === "custom" &&
          (event.data.type === "message_id_alias" || event.data.type === "current_run_user_injected")) {
        latest = undefined
      }
    }
    const stop = () => {
      ipc.removeListener(channel, receive)
      pending.delete(threadId)
    }
    pending.set(threadId, { read: () => latest, stop })
    ipc.on(channel, receive)
  })
  return (threadId: string) => {
    const entry = pending.get(threadId)
    const latest = entry?.read()
    entry?.stop()
    return latest
  }
}
