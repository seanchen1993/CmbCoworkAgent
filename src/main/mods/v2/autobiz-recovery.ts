import { createHash } from "node:crypto"
import { lstat } from "node:fs/promises"
import { join } from "node:path"
import type { AutobizRecoveryInspection } from "../../../shared/mods/v2/autobiz-recovery"
import {
  openStableFileHandle,
  readStableFileHandleBounded,
  type StableFileHandle
} from "../../services/stable-file-handle"
import { AutobizStateJournal } from "./autobiz-state-journal"

/** Bounded, explicit diagnostics. No plugin call, model, validator, file write or journal update. */
export async function inspectAutobizRecovery(
  workspace: string,
  operationId: string,
  assertLive: () => void
): Promise<AutobizRecoveryInspection> {
  assertLive()
  if (typeof operationId !== "string" || !/^[a-f0-9]{64}$/.test(operationId))
    throw Error("AUTOBIZ_RECOVERY_ID")
  const journal = new AutobizStateJournal(workspace, "", "read-only-inspection", true)
  let stored: ReturnType<AutobizStateJournal["inspect"]>
  try {
    stored = journal.inspect(operationId)
  } finally {
    journal.close()
  }
  const result: AutobizRecoveryInspection = {
    operationId,
    journalStatus: stored.status,
    state: "unavailable",
    observedAt: Date.now(),
    files: ["state.json", "STATE.md"].map((name, index) => ({
      path: `.autobizdevops/${name}`,
      before: stored.before[index],
      after: stored.after[index]
    }))
  }
  const handles: StableFileHandle[] = []
  try {
    const directory = await lstat(join(workspace, ".autobizdevops"))
    if (directory.isSymbolicLink() || !directory.isDirectory()) throw Error("unsafe path")
    for (const file of result.files) {
      const path = join(workspace, file.path)
      const info = await lstat(path)
      if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw Error("unsafe file")
      handles.push(await openStableFileHandle(workspace, path))
    }
    const hash = async (handle: StableFileHandle) =>
      createHash("sha256")
        .update(await readStableFileHandleBounded(handle, 262144))
        .digest("hex")
    const current = await Promise.all(handles.map(hash))
    // Reject a change while the other file was being read. This is still a diagnostic
    // snapshot, not the exclusive two-file lock held by the actual commit adapter.
    const verified = await Promise.all(handles.map(hash))
    if (current.some((value, index) => value !== verified[index])) throw Error("changed")
    result.files.forEach((file, index) => {
      file.current = current[index]
    })
    result.state = result.files.every((file) => file.current === file.before)
      ? "before"
      : result.files.every((file) => file.current === file.after)
        ? "after"
        : result.files.every((file) => file.current === file.before || file.current === file.after)
          ? "mixed"
          : "changed"
  } catch {
    result.state = "unavailable"
    result.files.forEach((file) => {
      delete file.current
    })
  } finally {
    await Promise.all(handles.map((handle) => handle.handle.close()))
  }
  assertLive()
  result.observedAt = Date.now()
  return result
}
