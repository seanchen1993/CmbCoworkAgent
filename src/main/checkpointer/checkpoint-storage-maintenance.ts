import type { Worker } from "node:worker_threads"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import type { CheckpointForkBoundaryBackfill } from "./checkpoint-storage-schema"
import type { CheckpointDatabaseFileIdentity } from "./checkpoint-database-identity"
import { BoundedWorkerAdmission } from "../services/bounded-worker-admission"
import { FUNCTION_MOD_RESOURCE_BUDGETS } from "../../shared/mods/v2/resource-budgets"

const capacity = FUNCTION_MOD_RESOURCE_BUDGETS.checkpointMaintenance
const admission = new BoundedWorkerAdmission(capacity.active, capacity.wait, "checkpoint storage maintenance")

async function createMaintenanceWorker(databasePath: string,
  backfill: readonly CheckpointForkBoundaryBackfill[], defaultCodec: boolean, file: CheckpointDatabaseFileIdentity,
  assertCurrent: () => Promise<void>): Promise<Worker> {
  const options = { name: "checkpoint-storage-maintenance", workerData: { databasePath, backfill, defaultCodec, file },
    resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 } }
  if (import.meta.url.endsWith(".ts") && !process.versions.electron) {
    // Source Node tests use the same real worker without evaluating worker code on Main.
    const require = createRequire(import.meta.url)
    const { Worker } = await import("node:worker_threads")
    await assertCurrent()
    const loader = require.resolve("tsx/cjs")
    const entry = fileURLToPath(new URL("./checkpoint-storage-worker.ts", import.meta.url))
    return new Worker(`require(${JSON.stringify(loader)});require(${JSON.stringify(entry)})`,
      { ...options, eval: true })
  }
  const factory = await import("./checkpoint-storage-worker?nodeWorker")
  await assertCurrent()
  // Packaged Electron never falls back to Main parsing or source/development dependencies.
  return factory.default(options)
}

/** An ACK is not physical completion; the worker must release its SQLite handle and exit. */
export function waitForCheckpointStorageWorker(worker: Worker): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let acknowledged = false, failure: Error | undefined
    worker.on("message", (message: { ok?: boolean; message?: string }) => {
      if (message?.ok === true) acknowledged = true
      else failure ??= new Error(message?.message ?? "CHECKPOINT_STORAGE_MAINTENANCE_FAILED")
    })
    worker.once("error", error => { failure ??= error })
    worker.once("exit", code => {
      if (failure) reject(failure)
      else if (code !== 0 || !acknowledged) reject(new Error("CHECKPOINT_STORAGE_MAINTENANCE_INCOMPLETE"))
      else resolve()
    })
  })
}

export async function maintainCheckpointStorageInWorker(databasePath: string,
  backfill: readonly CheckpointForkBoundaryBackfill[], defaultCodec: boolean, file: CheckpointDatabaseFileIdentity,
  assertCurrent: () => Promise<void>, signal: AbortSignal): Promise<void> {
  let release: () => void
  try { release = await admission.acquire(signal) }
  catch (error) {
    if (error instanceof Error && error.name === "WORKER_ADMISSION_CAPACITY_EXCEEDED")
      throw Object.assign(new Error("本地会话维护队列繁忙，请稍后重试。诊断代码：CHECKPOINT_STORAGE_BUSY"),
        { name: "CHECKPOINT_STORAGE_BUSY", cause: error })
    throw error
  }
  try {
    signal.throwIfAborted()
    await assertCurrent()
    signal.throwIfAborted()
    const worker = await createMaintenanceWorker(databasePath, backfill, defaultCodec, file, async () => {
      signal.throwIfAborted()
      await assertCurrent()
      signal.throwIfAborted()
    })
    // Cancellation after creation cannot settle this promise or free its physical slot.
    await waitForCheckpointStorageWorker(worker)
  } catch (error) {
    if (error instanceof Error && (error.name === "CHECKPOINT_STORAGE_BUSY" ||
      error.message.startsWith("SQLJS_SAVER_") || (signal.aborted && error === signal.reason))) throw error
    throw Object.assign(new Error("CHECKPOINT_STORAGE_MAINTENANCE_FAILED", { cause: error }),
      { name: "CHECKPOINT_STORAGE_MAINTENANCE_FAILED" })
  } finally { release() }
}
