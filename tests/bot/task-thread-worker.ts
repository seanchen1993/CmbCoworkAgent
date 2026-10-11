/** Fixed disposable SQLite race probe; not an App startup/execution entrypoint. */
import { DatabaseSync } from "node:sqlite"
import { basename, dirname, resolve } from "node:path"
import { lstatSync } from "node:fs"
import { NativeSqliteAdapter } from "../../src/main/db/native-sqlite-adapter"
import { PartnerTaskThreadStore } from "../../src/main/services/bot/task-thread-store"

const path = process.argv[2]
if (
  !path ||
  resolve(path) !== path ||
  !basename(dirname(path)).startsWith("devclaw-bot-thread-test-") ||
  basename(path) !== "threads.sqlite" ||
  !lstatSync(path).isFile() ||
  !process.send
)
  throw Error("THREAD_PROBE_SELECTION")
const database = new NativeSqliteAdapter(new DatabaseSync(path, { timeout: 2000 }))
const store = new PartnerTaskThreadStore(database)
const timeout = setTimeout(() => process.exit(1), 10_000)
process.once("message", (message) => {
  try {
    if (message !== "ensure") throw Error("THREAD_PROBE_SELECTION")
    const binding = store.ensure({
      spaceId: "space",
      taskId: "task",
      stageId: "requirement-stage",
      runtimeNodeId: "node",
      groupId: "group",
      ownerPrincipalId: "owner",
      workspaceRef: "view",
      workspacePath: "/explicit-workspace"
    })
    if (
      store.ensure({
        spaceId: "space",
        taskId: "task",
        stageId: "requirement-stage",
        runtimeNodeId: "node",
        groupId: "group",
        ownerPrincipalId: "owner",
        workspaceRef: "view",
        workspacePath: "/explicit-workspace"
      }).localThreadId !== binding.localThreadId
    )
      throw Error("THREAD_PROBE_ASSERTION")
    database.close()
    clearTimeout(timeout)
    process.send?.({ kind: "binding", binding }, () => process.disconnect())
  } catch {
    database.close()
    clearTimeout(timeout)
    process.exit(1)
  }
})
process.send("ready")
