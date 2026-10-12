import { protectWindows } from "./credential-protection"
import { randomUUID } from "node:crypto"
import { mkdir, open, rename, unlink } from "node:fs/promises"
import { dirname } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { CapabilitySource } from "../mcp/capability-core"
import type { CmbModelSettings } from "../models/model-factory"
import type { BotExecutionConfig } from "./shell-contract"
import type { BotModsConfig } from "./mods-config"
import { assertBotModelSnapshotCurrent, BotModelSnapshotPendingError } from "./model-config-fence"
import { syncDirectory } from "./backup-io"
import {
  openStableFileHandle,
  readStableFileHandleBounded,
  StableBoundedReadError
} from "../services/stable-file-handle"

export interface BotModelSnapshot {
  version: 1
  /** Desktop/user timezone; a Linux Host may run in a different timezone. */
  timezone?: string
  instructionSources?: import("./global-instructions").BotInstructionSources
  /** Desktop setting; each run pins its value before executing the graph. */
  graphRecursionLimit?: number
  failureFuse?: import("./failure-fuse-policy").BotFailureFusePolicy
  toolStrategy?: import("../../shared/agent-runtime-limits").AgentToolStrategy
  workflowWorktreeTimeoutMinutes?: number
  workflowWorktreeRemoveTimeoutMinutes?: number
  mcpSources?: CapabilitySource[]
  execution?: BotExecutionConfig
  mods?: BotModsConfig
  skillSources?: import("./skill-catalog-contract").BotSkillCatalogSources
  hookSources?: import("./runtime-hook-source").BotRuntimeHookSources
  harnessSources?: import("./harness-context-contract").BotHarnessSources
  defaultRef: string | null
  models: (CmbModelSettings & { ref: string; name: string; maxTokens?: number })[]
}

export async function writeBotModelSnapshot(
  path: string,
  snapshot: BotModelSnapshot
): Promise<void> {
  const plain = Buffer.from(JSON.stringify(snapshot), "utf8")
  if (plain.length > 1024 * 1024) throw new Error("Bot 模型配置过大")
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const bytes = process.platform === "win32" ? await protectWindows(plain, false) : plain
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(temp, "wx", 0o600)
    try {
      await file.writeFile(bytes)
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temp, path)
    // A file fsync does not make its renamed directory entry durable on POSIX.
    // Do this before Desktop clears the pending generation and lets a Host read
    // the new credential-bearing snapshot.
    await syncDirectory(dirname(path))
  } finally {
    await unlink(temp).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
  }
}

async function readBotModelSnapshotOnce(path: string): Promise<BotModelSnapshot> {
  assertBotModelSnapshotCurrent(path)
  const file = await openStableFileHandle(dirname(path), path)
  try {
    const bytes = await readStableFileHandleBounded(file, 2 * 1024 * 1024)
    const plain = process.platform === "win32" ? await protectWindows(bytes, true) : bytes
    const value = JSON.parse(plain.toString("utf8")) as BotModelSnapshot
    await file.assertPathIdentity()
    assertBotModelSnapshotCurrent(path)
    if (value.version !== 1 || !Array.isArray(value.models))
      throw new Error("Bot 模型配置格式不正确")
    return value
  } finally {
    await file.handle.close()
  }
}

/**
 * Read one immutable configuration generation. A rename-published snapshot can
 * briefly retain stale filesystem metadata on some local filesystems. Retry one
 * fresh capability only for that transient "changed" observation; every retry
 * repeats the pending fence and the callers still compare the selected
 * configuration fingerprint before an external effect is committed.
 */
export async function readBotModelSnapshot(path: string): Promise<BotModelSnapshot> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await readBotModelSnapshotOnce(path)
    } catch (error) {
      if (attempt === 0 && error instanceof StableBoundedReadError && error.failure === "changed") {
        // Yield once so a completed atomic rename's metadata is observed through
        // a new descriptor. This never retries a size violation or a config fence.
        await delay(0)
        continue
      }
      throw error
    }
  }
  throw new Error("Unreachable model configuration read state")
}

/** Initial task admission can race a publication after the Host's queue check.
 * Wait before selecting any model or executing effects. In-flight configuration
 * guards must continue using readBotModelSnapshot: revocation is not a retry.
 * Pending publication can outlive a window; cancellation/lease loss ends waiting.
 */
export async function readInitialBotModelSnapshot(
  path: string,
  signal: AbortSignal,
  onWaiting: () => void
): Promise<BotModelSnapshot> {
  let waiting = false
  for (;;) {
    signal.throwIfAborted()
    try {
      const snapshot = await readBotModelSnapshot(path)
      signal.throwIfAborted()
      return snapshot
    } catch (error) {
      if (!(error instanceof BotModelSnapshotPendingError)) throw error
      if (!waiting) {
        waiting = true
        onWaiting()
      }
      // No file reads or event writes in a busy loop. The Host still renews and
      // validates this lease; no provider, tool or saved effect has been invoked.
      await delay(500, undefined, { signal })
    }
  }
}
