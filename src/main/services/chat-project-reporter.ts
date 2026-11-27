import { getDb } from "../db"
import { CHAT_PROJECT_EVENT } from "../../shared/chat-project"
import { buildEvent, getEventReporter } from "./event-reporter"

let timer: ReturnType<typeof setTimeout> | undefined
let active = false
let started = false
let retryAt = 0
let scheduledAt = 0

// Wakes on an edit and periodically for persisted work left by an earlier process.
function schedule(delay: number): void {
  if (!started || active) return
  const now = Date.now()
  const due = Math.max(now + delay, retryAt)
  if (timer && scheduledAt <= due) return
  clearTimeout(timer)
  scheduledAt = due
  timer = setTimeout(() => void drain(), due - now)
  timer.unref()
}

async function drain(): Promise<void> {
  timer = undefined
  active = true
  let nextDelay = 30_000
  try {
    const db = getDb()
    const rows = db.exec(
      `SELECT thread_id,sap_id,mode,code,lean,revision,attempts FROM chat_project_bindings
      WHERE next_attempt<=? ORDER BY next_attempt LIMIT 32`,
      [Date.now()]
    )[0].values
    for (const [id, sapId, mode, code, lean, revision, attempts] of rows) {
      if (!started) break
      const envelope = buildEvent(CHAT_PROJECT_EVENT, "code_adoption", {
        rootThreadId: id,
        generationMode: mode,
        projectCode: code,
        projectFromLean: lean === 1
      })
      const owner = typeof sapId === "string" ? sapId : envelope.sapId
      if (!owner) {
        db.run("UPDATE chat_project_bindings SET next_attempt=? WHERE thread_id=? AND revision=?", [
          Date.now() + 60_000,
          id,
          revision
        ])
        continue
      }
      if (!sapId)
        db.run("UPDATE chat_project_bindings SET sap_id=? WHERE thread_id=? AND sap_id IS NULL", [
          owner,
          id
        ])
      // During account switching never attach the new user's name or department to old data.
      const event =
        envelope.sapId === owner
          ? envelope
          : {
              eventName: envelope.eventName,
              eventCategory: envelope.eventCategory,
              sapId: owner,
              userName: owner,
              userIp: envelope.userIp,
              properties: envelope.properties,
              eventId: envelope.eventId,
              eventTime: envelope.eventTime
            }
      event.eventId = `chat-project-${id}-${revision}`
      // Sort by the durable revision, including on retry after a newer edit was sent.
      event.eventTime = new Date(Number(revision)).toISOString()
      const result = await getEventReporter().report(event)
      const delay = result.ok
        ? null
        : Math.max(
            result.retryAfterMs ?? 0,
            Math.min(600_000, 10_000 * 2 ** Math.min(Number(attempts), 6))
          )
      db.run(
        `UPDATE chat_project_bindings SET next_attempt=?, attempts=attempts+1
        WHERE thread_id=? AND revision=?`,
        [delay === null ? null : Date.now() + delay, id, revision]
      )
      if (!result.ok) {
        if (result.retryable) retryAt = Date.now() + (result.retryAfterMs ?? 30_000)
        break
      }
    }
    if (rows.length === 32) nextDelay = 1000
  } catch (error) {
    console.warn("[ChatProject] Binding delivery deferred", error)
  } finally {
    active = false
    schedule(nextDelay)
  }
}

export function startChatProjectReporter(): void {
  started = true
  schedule(1000)
}
export function notifyChatProjectEdit(): void {
  schedule(100)
}
export function stopChatProjectReporter(): void {
  started = false
  clearTimeout(timer)
  timer = undefined
}
