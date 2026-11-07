import { afterEach, expect, it, vi } from "vitest"
import { CheckpointMessageSnapshotRecoveryError } from "../checkpointer/sqljs-saver"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { ModError } from "../mods/errors"
import { getDurableRuntimeTail } from "./thread-runtime-tail"

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
  new CheckpointMessageSnapshotRecoveryError("local-checkpoint")
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
