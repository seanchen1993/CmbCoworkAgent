import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createHash } from "node:crypto"
import { Worker } from "node:worker_threads"
import { DatabaseSync } from "node:sqlite"
import { HumanMessage } from "@langchain/core/messages"
import { build } from "esbuild"
import { afterAll, afterEach, beforeAll, expect, it } from "vitest"
import { CheckpointRuntimeProjectionClient } from "./runtime-projection-client"
import { createDefaultCheckpointMetadataCodec } from "./checkpoint-metadata-codec"
import { resolveCheckpointDatabaseIdentity } from "./checkpoint-database-identity"
import { preparedNativeSourcePlanDigest } from "./function-conversation-canonical-display-worker"
import type { PreparedNativeDataSource } from "./runtime-projection-protocol"

let root: string, workerEntry: string
let beforeSources: string[]
const sourcePaths = [
  "runtime-projection-protocol.ts",
  "runtime-projection-client.ts",
  "runtime-projection-worker.ts",
  "legacy-transcript-worker-driver.ts",
  "runtime-projection-store.ts",
  "function-conversation-canonical-display-worker.ts"
].map((name) => resolve("src/main/checkpointer", name))
const sourceHashes = () =>
  Promise.all(
    sourcePaths.map(async (path) =>
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex")
    )
  )
const owned: Array<() => Promise<void>> = []
beforeAll(async () => {
  beforeSources = await sourceHashes()
  root = await mkdtemp(join(tmpdir(), "prepared-native-actual-worker-"))
  workerEntry = join(root, "current-source-worker.cjs")
  await build({
    entryPoints: [resolve("src/main/checkpointer/runtime-projection-worker.ts")],
    outfile: workerEntry,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    logLevel: "silent"
  })
  expect(await sourceHashes()).toEqual(beforeSources)
})
afterEach(async () => {
  for (const cleanup of owned.splice(0).reverse()) await cleanup()
})
afterAll(async () => {
  try {
    if (beforeSources) expect(await sourceHashes()).toEqual(beforeSources)
  } finally {
    if (root) await rm(root, { recursive: true, force: true })
  }
})

it("uses the current compiled isolated actor, original driver/codec and true final/exit", async () => {
  const path = join(root, "actual.sqlite"),
    database = new DatabaseSync(path)
  database.exec("CREATE TABLE owned_fixture(value TEXT)")
  const identity = await resolveCheckpointDatabaseIdentity(path),
    workers: Worker[] = [],
    exits: number[] = []
  const client = new CheckpointRuntimeProjectionClient(async () => {
    const worker = new Worker(workerEntry, {
      name: "prepared-native-actual-source",
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 }
    })
    workers.push(worker)
    worker.once("exit", (code) => exits.push(code))
    return worker
  })
  owned.push(async () => {
    try {
      await client.close()
    } finally {
      database.close()
    }
  })
  const serde = createDefaultCheckpointMetadataCodec()
  const messages = [
    new HumanMessage({ id: "original", content: "actual isolated default codec 原文" })
  ]
  const [checkpointType, checkpointBytes] = await serde.dumpsTyped({
    id: "new-point",
    ts: "original-ts",
    channel_values: {
      cmbFunctionConversation: {
        version: 1,
        logicalSessionId: "logical",
        conversationId: "conversation",
        branchId: "branch",
        frontier: 0
      },
      messages: { __cmb_sqljs_external_messages_v1: true, messageCount: 1 }
    }
  })
  const [metadataType, metadataBytes] = await serde.dumpsTyped({ source: "loop", step: 1 })
  const [suffixType, suffixBytes] = await serde.dumpsTyped(messages)
  const source: PreparedNativeDataSource = {
    file: identity.capturedFile!,
    parentCheckpointId: "old-point",
    checkpoint: { type: checkpointType, bytes: checkpointBytes },
    metadata: { type: metadataType, bytes: metadataBytes },
    messages: {
      type: suffixType,
      bytes: suffixBytes,
      parentCheckpointId: null,
      prefixLength: 0,
      messageCount: 1,
      expectedParentCount: null,
      expectedParentGeneration: null
    }
  }
  let pulls = 0
  const facts = await client.readPreparedNativeData(path, "physical", "namespace", "new-point", {
    checkpointSource: { identity, file: identity.capturedFile!, assertCurrent: () => undefined },
    readSource: () => {
      pulls++
      return source
    }
  })
  expect(pulls).toBe(1)
  expect(workers).toHaveLength(1)
  expect(facts).toMatchObject({
    checkpointId: "new-point",
    parentCheckpointId: "old-point",
    nativeMessageCount: 1,
    stamped: [],
    chainSeal: [],
    sealedPlanDigest: preparedNativeSourcePlanDigest(source)
  })
  expect(facts.nativeSnapshotDigest).toBe(
    createHash("sha256")
      .update(JSON.stringify(messages.map((message) => JSON.stringify(message.toDict()))))
      .digest("hex")
  )
  await client.close()
  expect(exits).toHaveLength(1)
  expect(exits.every((code) => Number.isInteger(code))).toBe(true)
})
