import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { BotHostLock } from "./host-lock"
import { BotHostLog } from "./host-log"

async function main(): Promise<void> {
  const dataIndex = process.argv.indexOf("--data-dir")
  if (dataIndex === -1 || !process.argv[dataIndex + 1]) throw new Error("--data-dir is required")
  const directory = resolve(process.argv[dataIndex + 1])
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const lock = BotHostLock.acquire(directory)
  if (!lock) return
  try {
    // Install before importing the executor: module-load failures must also leave
    // a bounded, redacted diagnostic when the desktop has already disconnected.
    new BotHostLog(directory).install()
    process.once("uncaughtExceptionMonitor", (error, origin) => {
      console.error("[BotHost] Uncaught failure", { origin, error })
    })
    console.info("[BotHost] Starting")
    const { startBotHost } = await import("./host-runtime-entry")
    await startBotHost(directory, lock)
  } catch (error) {
    console.error("[BotHost] Startup failed", error)
    // Keep the lifetime lock until process exit if cleanup itself failed.
    // The OS releases it, including when an import failed before any worker started.
    process.exitCode = 1
  }
}

void main().catch((error) => {
  console.error("[BotHost]", error instanceof Error ? error.message : "Startup failed")
  process.exitCode = 1
})
