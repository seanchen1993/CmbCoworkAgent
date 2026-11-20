import { DatabaseSync } from "node:sqlite"
import { parentPort, workerData } from "node:worker_threads"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { searchDurableThreadMessages } from "./durable-message-search"
import type { DurableSearchRequest, DurableSearchReply } from "./durable-message-search-client"

const port = parentPort
if (!port) throw new Error("Durable search Worker requires a parent port")
const database = new DatabaseSync(workerData.databasePath, { readOnly: true, timeout: 250 })
const adapter = new NativeSqliteAdapter(database)

port.on("message", (request: DurableSearchRequest) => {
  const { owner, id, threadId, query, options, cancellation } = request
  const flag = new Int32Array(cancellation)
  const checkCancelled = () => {
    if (Atomics.load(flag, 0)) throw new Error("Thread search superseded")
  }
  let reply: DurableSearchReply
  try {
    checkCancelled()
    database.exec("BEGIN")
    const page = searchDurableThreadMessages(adapter, threadId, query, options, checkCancelled)
    checkCancelled()
    database.exec("COMMIT")
    reply = { owner, id, page }
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK")
    reply = { owner, id, error: error instanceof Error ? error.message : "Durable search failed" }
  }
  port.postMessage(reply)
})
