import { afterEach, expect, it, vi } from "vitest"
import { CheckpointMessageSnapshotRecoveryError } from "../checkpointer/sqljs-saver"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { ModError } from "../mods/errors"
import { getDurableRuntimeTail } from "./thread-runtime-tail"
import { mkdtemp, writeFile, unlink, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readCheckpointDatabaseFileIdentity, assertCheckpointDatabaseFileIdentity }
  from "../checkpointer/checkpoint-database-identity"

const checkpoint = vi.hoisted(() => vi.fn())
const readDatabase = vi.hoisted(() => vi.fn())
vi.mock("../agent/runtime", () => ({ withCheckpointer: checkpoint }))
// Native checkpoint helpers capture this function at import time without reading the DB.
vi.mock("../db", () => ({ getDb: readDatabase }))
vi.mock("../mods/manager", () => ({}))
afterEach(() => vi.resetAllMocks())

it.each([
  new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_CHANGED"),
  new ModError("MODS_CONVERSATION_RECOVERY_REQUIRED"),
  new CheckpointMessageSnapshotRecoveryError("local-checkpoint"),
  Object.assign(new Error("CHECKPOINT_STORAGE_BUSY"), { name: "CHECKPOINT_STORAGE_BUSY" }),
  Object.assign(new Error("CHECKPOINT_STORAGE_MAINTENANCE_FAILED"), { name: "CHECKPOINT_STORAGE_MAINTENANCE_FAILED" }),
  new Error("SQLJS_SAVER_CLOSING")
])("does not convert a refused history read into a new empty chat", async (error) => {
  checkpoint.mockRejectedValueOnce(error)
  await expect(getDurableRuntimeTail("ordinary")).rejects.toBe(error)
  expect(readDatabase).not.toHaveBeenCalled()
})

it("keeps the first-send path for a chat with no checkpoint", async () => {
  checkpoint.mockResolvedValueOnce(null)
  await expect(getDurableRuntimeTail("ordinary")).resolves.toEqual({
    messages: [],
    persistedMessages: [],
    checkpointHasInterrupt: false
  })
  expect(readDatabase).not.toHaveBeenCalled()
})

it("propagates a deleted pinned checkpoint file rather than returning an empty history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "checkpoint-tail-file-fence-"))
  try {
    const path = join(directory, "original.sqlite")
    await writeFile(path, "original file")
    const file = await readCheckpointDatabaseFileIdentity(path)
    await unlink(path)
    let failure: unknown
    try { await assertCheckpointDatabaseFileIdentity(path, file) }
    catch (error) { failure = error }
    expect(failure).toMatchObject({ message: "SQLJS_SAVER_DATABASE_IDENTITY_CHANGED", cause: { code: "ENOENT" } })
    checkpoint.mockRejectedValueOnce(failure)
    await expect(getDurableRuntimeTail("ordinary")).rejects.toBe(failure)
    expect(readDatabase).not.toHaveBeenCalled()
  } finally { await rm(directory, { recursive: true, force: true }) }
})
