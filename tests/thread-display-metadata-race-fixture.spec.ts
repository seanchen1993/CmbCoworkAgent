/** Node-only harness checks; this does not count as production worker/Electron validation. */
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Worker } from "node:worker_threads"
import {
  installThreadDisplayMetadataRace,
  type MetadataRaceGlobal
} from "./support/thread-display-metadata-race"
import {
  createThreadDisplayMetadataGuard,
  withThreadDisplayMetadataRetry
} from "../src/main/ipc/thread-display-read-retry"

async function main() {
  const directory = resolve("output/metadata-race-fixture-unit")
  mkdirSync(directory, { recursive: true })
  const privateRoot = mkdtempSync(join(directory, "run-"))
  const workspace = join(privateRoot, "workspace"),
    dataRoot = join(privateRoot, "data")
  mkdirSync(workspace)
  mkdirSync(dataRoot)
  const filename = join(dataRoot, "cmbcoworkagent.sqlite")
  const database = new DatabaseSync(filename)
  database.exec("CREATE TABLE threads(thread_id TEXT PRIMARY KEY,title TEXT,metadata TEXT)")
  for (const id of ["allowed", "security", "foreign"])
    database
      .prepare("INSERT INTO threads VALUES(?,?,?)")
      .run(
        id,
        id === "foreign" ? "not-a-fixture" : `METADATA_RACE_FIXTURE_${id}`,
        JSON.stringify({ workspacePath: workspace, cmb_thread_incarnation: id })
      )
  const previousHome = process.env.CMB_COWORK_AGENT_HOME
  process.env.CMB_COWORK_AGENT_HOME = dataRoot
  let worker: Worker | undefined,
    next = 0
  const pending = new Map<
    number,
    {
      resolve(value: { messages: Array<{ id: string }> }): void
      reject(error: unknown): void
      guard: () => void
    }
  >()
  const readMetadata = (id: string): string =>
    String(database.prepare("SELECT metadata FROM threads WHERE thread_id=?").get(id)!.metadata)
  const originalHandler = async (_event: unknown, request: { threadId: string }) =>
    withThreadDisplayMetadataRetry(
      undefined,
      () => ({
        ...createThreadDisplayMetadataGuard(readMetadata(request.threadId), () =>
          readMetadata(request.threadId)
        ),
        dispose: () => undefined
      }),
      (source) =>
        new Promise<{ messages: Array<{ id: string }> }>((resolve, reject) => {
          const requestId = ++next
          pending.set(requestId, { resolve, reject, guard: source.assertCurrent })
          worker!.postMessage({
            type: "read-page",
            requestId,
            databasePath: filename,
            threadId: request.threadId
          })
        })
    )
  const handlers = new Map([["threads:messages-page", originalHandler]])
  const electron = { ipcMain: { _invokeHandlers: handlers } } as unknown as Pick<
    typeof import("electron"),
    "ipcMain"
  >
  let installed = false
  try {
    assert.throws(
      () => installThreadDisplayMetadataRace(electron, { privateRoot: workspace, workspace }),
      /OUTSIDE_PRIVATE_ROOT/
    )
    installThreadDisplayMetadataRace(electron, { privateRoot, workspace })
    installed = true
    const observer = (globalThis as unknown as MetadataRaceGlobal).threadDisplayMetadataRace
    assert.throws(() => observer.arm("foreign", "llmFileHistory"), /OWNERSHIP_INVALID/)
    worker = new Worker(
      `const {parentPort}=require('node:worker_threads');
parentPort.on('message',request=>parentPort.postMessage({type:'read-page-result',requestId:request.requestId,ok:true,page:{messages:[{id:request.threadId}]},canonicalWitnesses:[]}));`,
      { eval: true, name: "thread-message-hydration" }
    )
    worker.on("message", (response) => {
      const request = pending.get(response.requestId)!
      pending.delete(response.requestId)
      try {
        request.guard()
        request.resolve(response.page)
      } catch (error) {
        request.reject(error)
      }
    })
    observer.arm("allowed", "llmFileHistory")
    assert.deepEqual(await handlers.get("threads:messages-page")!({}, { threadId: "allowed" }), {
      messages: [{ id: "allowed" }]
    })
    observer.arm("security", "workspace")
    await assert.rejects(
      handlers.get("threads:messages-page")!({}, { threadId: "security" }),
      /MODS_CONVERSATION_THREAD_CHANGED/
    )
    const result = observer.close()
    assert.deepEqual(result.failures, [])
    assert.equal(result.detached, true)
    assert.deepEqual(
      result.invocations.map((call) => [call.outcome, call.reads.length]),
      [
        ["resolved", 2],
        ["rejected", 1]
      ]
    )
    assert.equal(handlers.get("threads:messages-page"), originalHandler)
    assert.equal(Object.hasOwn(worker, "postMessage"), false)
    console.log(
      JSON.stringify({
        passed: true,
        scope: "Node-only fixture scheduling, private-root admission and cleanup",
        privateRoot
      })
    )
  } finally {
    if (installed) (globalThis as unknown as MetadataRaceGlobal).threadDisplayMetadataRace.close()
    await worker?.terminate()
    database.close()
    if (previousHome === undefined) delete process.env.CMB_COWORK_AGENT_HOME
    else process.env.CMB_COWORK_AGENT_HOME = previousHome
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
