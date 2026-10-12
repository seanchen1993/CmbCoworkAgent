import { app, safeStorage } from "electron"
import { Worker } from "node:worker_threads"
import { runMacSecretHelper } from "./mac-secret-helper"
import { BOT_MAC_SECRET_OWNER_WATCH } from "./mac-secret-owner-watch"

// No window, desktop single-instance lock, database, telemetry or secret logging.
app.dock?.hide()
const owner = new Worker(BOT_MAC_SECRET_OWNER_WATCH, { eval: true, execArgv: [], env: {} })
const watching = new Promise<void>((resolve) => owner.once("message", () => resolve()))
owner.on("error", () => app.exit(1))
let finishing = false
owner.on("exit", () => {
  if (!finishing) app.exit(1)
})
async function finish(code: number): Promise<void> {
  finishing = true
  await owner.terminate()
  app.exit(code)
}
process.stdin.on("error", () => app.exit(1))
process.stdout.on("error", () => app.exit(1))
void runMacSecretHelper({
  platform: process.platform,
  stdin: process.stdin,
  stdout: process.stdout,
  ready: () => Promise.all([app.whenReady(), watching]),
  storage: safeStorage
}).then(
  () => {
    void finish(0).catch(() => app.exit(1))
  },
  () => {
    void finish(1).catch(() => app.exit(1))
  }
)
