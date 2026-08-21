/**
 * Regression tests for lossless, byte-bounded subagent transcript sidecars.
 *
 * Run:
 *   npx tsx tests/subagent-transcript-content-store.spec.ts
 */

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SUBAGENT_TRANSCRIPT_INLINE_BYTES,
  fingerprintSubagentTranscriptContent,
  isSubagentTranscriptBlobRef,
  type SubagentTranscriptBlobRef
} from "../src/shared/subagent-transcript-storage.ts"

type UnknownRecord = Record<string, unknown>
type ContentStore = typeof import("../src/main/services/subagent-transcript-content-store.ts")

function asRecord(value: unknown, label: string): UnknownRecord {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be a record`)
  return value as UnknownRecord
}

function firstMessage(manifests: Record<string, unknown>, subagentId: string): UnknownRecord {
  const messages = manifests[subagentId]
  assert(Array.isArray(messages), `${subagentId} manifest must contain a message array`)
  assert(messages.length > 0, `${subagentId} manifest must contain at least one message`)
  return asRecord(messages[0], `${subagentId} first message`)
}

function requireBlobRef(
  value: unknown,
  kind: SubagentTranscriptBlobRef["kind"]
): SubagentTranscriptBlobRef {
  assert(isSubagentTranscriptBlobRef(value, kind), `expected a valid ${kind} blob ref`)
  return value
}

function blobFile(root: string, ref: SubagentTranscriptBlobRef): string {
  return join(root, ref.sha256.slice(0, 2), `${ref.sha256}.json`)
}

function serializedBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8")
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function testLargeContentAndToolCallsRoundTrip(
  store: ContentStore,
  retainedHashes: Set<string>
): Promise<void> {
  const content = `正文开头🙂${"中间内容🚀".repeat(8_000)}正文结尾🏁`
  const toolCalls = [
    {
      id: "large-tool-call",
      name: "write_report",
      args: { payload: `参数开始🧰${"工具参数📦".repeat(8_000)}参数结束✅` }
    }
  ]
  const reasoning = `思考开头🧠${"推理过程🔎".repeat(8_000)}思考结尾💡`
  const compacted = await store.compactSubagentTranscriptManifests({
    "large-round-trip": [
      { id: "large-message", role: "assistant", content, reasoning, tool_calls: toolCalls }
    ]
  })
  const manifestMessage = firstMessage(compacted.manifests, "large-round-trip")
  const contentRef = requireBlobRef(manifestMessage.content_ref, "content")
  const reasoningRef = requireBlobRef(manifestMessage.reasoning_ref, "reasoning")
  const toolCallsRef = requireBlobRef(manifestMessage.tool_calls_ref, "tool_calls")
  retainedHashes.add(contentRef.sha256)
  retainedHashes.add(reasoningRef.sha256)
  retainedHashes.add(toolCallsRef.sha256)

  assert.equal(contentRef.bytes, serializedBytes(content).byteLength)
  assert.equal(reasoningRef.bytes, serializedBytes(reasoning).byteLength)
  assert.equal(toolCallsRef.bytes, serializedBytes(toolCalls).byteLength)
  assert.equal(manifestMessage.content_is_projection, true)
  assert.equal(manifestMessage.reasoning_is_projection, true)
  assert(
    serializedBytes(manifestMessage.reasoning).byteLength <= SUBAGENT_TRANSCRIPT_INLINE_BYTES,
    "the reasoning projection must stay within the inline byte limit"
  )
  assert.equal(manifestMessage.tool_calls, undefined)

  const hydrated = await store.hydrateSubagentTranscriptManifests(compacted.manifests)
  const hydratedMessage = firstMessage(hydrated, "large-round-trip")
  assert.deepEqual(serializedBytes(hydratedMessage.content), serializedBytes(content))
  assert.equal(hydratedMessage.reasoning, reasoning)
  assert.equal(hydratedMessage.reasoning_is_projection, undefined)
  assert.deepEqual(serializedBytes(hydratedMessage.tool_calls), serializedBytes(toolCalls))
}

async function testHydrationConcurrencyIsBounded(
  store: ContentStore,
  retainedHashes: Set<string>
): Promise<void> {
  let active = 0
  let maxActive = 0
  const values = Array.from({ length: 320 }, (_, index) => index)
  const mapped = await store.mapSubagentTranscriptHydrationBounded(values, async (value) => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise<void>((resolve) => setImmediate(resolve))
    active -= 1
    return value * 2
  })
  assert(maxActive > 1, "the bounded mapper should retain useful read parallelism")
  assert(
    maxActive <= store.SUBAGENT_TRANSCRIPT_HYDRATION_CONCURRENCY,
    "the bounded mapper must never exceed the file-read concurrency limit"
  )
  assert.deepEqual(mapped, values.map((value) => value * 2), "bounded mapping must preserve order")

  const content = `共享大正文${"hydrate-ref".repeat(4_000)}`
  const compacted = await store.compactSubagentTranscriptManifests({
    seed: [{ id: "seed-message", role: "assistant", content }]
  })
  const seedMessage = firstMessage(compacted.manifests, "seed")
  const sharedRef = requireBlobRef(seedMessage.content_ref, "content")
  retainedHashes.add(sharedRef.sha256)
  const manyMessages = Array.from({ length: 320 }, (_, index) => ({
    ...seedMessage,
    id: `many-message-${index}`,
    content_ref: sharedRef
  }))
  const hydrated = await store.hydrateSubagentTranscriptManifests({ many: manyMessages })
  const hydratedMessages = hydrated.many
  assert(Array.isArray(hydratedMessages) && hydratedMessages.length === manyMessages.length)
  assert.equal(asRecord(hydratedMessages[0], "first hydrated message").content, content)
  assert.equal(
    asRecord(hydratedMessages[hydratedMessages.length - 1], "last hydrated message").content,
    content
  )

  active = 0
  maxActive = 0
  const manyBuckets = Object.fromEntries(
    Array.from({ length: 320 }, (_, index) => [
      `bucket-${index}`,
      [{ id: `bucket-message-${index}`, ordinal: index }]
    ])
  )
  const hydratedBuckets = await store.hydrateSubagentTranscriptManifests(
    manyBuckets,
    async (rawMessage) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise<void>((resolve) => setImmediate(resolve))
      active -= 1
      return { ...asRecord(rawMessage, "cross-bucket message"), hydrated: true }
    }
  )
  assert(maxActive > 1, "single-message buckets should hydrate concurrently across buckets")
  assert(
    maxActive <= store.SUBAGENT_TRANSCRIPT_HYDRATION_CONCURRENCY,
    "cross-bucket hydration must retain the global file-read concurrency bound"
  )
  assert.deepEqual(
    Object.keys(hydratedBuckets),
    Object.keys(manyBuckets),
    "cross-bucket hydration must preserve bucket order"
  )
  for (let index = 0; index < 320; index += 1) {
    const message = firstMessage(hydratedBuckets, `bucket-${index}`)
    assert.equal(message.ordinal, index)
    assert.equal(message.hydrated, true)
  }
}

async function testKindsCannotCollide(
  store: ContentStore,
  retainedHashes: Set<string>
): Promise<void> {
  const identicalJson = [
    {
      id: "same-json",
      name: "same_json",
      args: { payload: "identical-json-payload".repeat(2_000) }
    }
  ]
  const compacted = await store.compactSubagentTranscriptManifests({
    "kind-separation": [
      {
        id: "same-json-message",
        role: "assistant",
        content: identicalJson,
        tool_calls: identicalJson
      }
    ]
  })
  const manifestMessage = firstMessage(compacted.manifests, "kind-separation")
  const contentRef = requireBlobRef(manifestMessage.content_ref, "content")
  const toolCallsRef = requireBlobRef(manifestMessage.tool_calls_ref, "tool_calls")
  retainedHashes.add(contentRef.sha256)
  retainedHashes.add(toolCallsRef.sha256)

  assert.notEqual(contentRef.sha256, toolCallsRef.sha256)
  assert.equal(contentRef.bytes, toolCallsRef.bytes)

  const hydrated = await store.hydrateSubagentTranscriptManifests(compacted.manifests)
  const hydratedMessage = firstMessage(hydrated, "kind-separation")
  assert.deepEqual(hydratedMessage.content, identicalJson)
  assert.deepEqual(hydratedMessage.tool_calls, identicalJson)
}

async function testMultibyteManifestContentIsByteBounded(
  store: ContentStore,
  retainedHashes: Set<string>
): Promise<void> {
  const content = `头部🙂${"中文正文🚀".repeat(20_000)}尾部🏁`
  const compacted = await store.compactSubagentTranscriptManifests({
    "multibyte-preview": [
      { id: "multibyte-message", role: "assistant", content }
    ]
  })
  const manifestMessage = firstMessage(compacted.manifests, "multibyte-preview")
  const contentRef = requireBlobRef(manifestMessage.content_ref, "content")
  retainedHashes.add(contentRef.sha256)

  assert.equal(typeof manifestMessage.content, "string")
  assert.equal(manifestMessage.content_is_projection, true)
  assert(
    serializedBytes(manifestMessage.content).byteLength <= SUBAGENT_TRANSCRIPT_INLINE_BYTES,
    "the JSON-serialized multibyte content field must stay within the inline byte limit"
  )

  const hydrated = await store.hydrateSubagentTranscriptManifests(compacted.manifests)
  assert.equal(firstMessage(hydrated, "multibyte-preview").content, content)
}

async function testCorruptSameHashBlobSelfHeals(
  store: ContentStore,
  root: string,
  retainedHashes: Set<string>
): Promise<void> {
  const content = `需要自愈🙂${"完整正文".repeat(10_000)}`
  const serialized = JSON.stringify(content)
  const sha256 = createHash("sha256")
    .update("content")
    .update("\0")
    .update(serialized)
    .digest("hex")
  const expectedRef: SubagentTranscriptBlobRef = {
    v: 1,
    sha256,
    bytes: Buffer.byteLength(serialized, "utf8"),
    kind: "content"
  }
  const target = blobFile(root, expectedRef)
  await mkdir(join(root, sha256.slice(0, 2)), { recursive: true })
  await writeFile(target, JSON.stringify({ v: 1, kind: "content", value: "damaged" }), "utf8")

  const compacted = await store.compactSubagentTranscriptManifests({
    "self-heal": [{ id: "self-heal-message", role: "assistant", content }]
  })
  const actualRef = requireBlobRef(
    firstMessage(compacted.manifests, "self-heal").content_ref,
    "content"
  )
  retainedHashes.add(actualRef.sha256)
  assert.deepEqual(actualRef, expectedRef)

  const healedEnvelope = JSON.parse(await readFile(target, "utf8")) as UnknownRecord
  assert.equal(healedEnvelope.kind, "content")
  assert.equal(healedEnvelope.value, content)
  const hydrated = await store.hydrateSubagentTranscriptManifests(compacted.manifests)
  assert.equal(firstMessage(hydrated, "self-heal").content, content)
}

async function testGarbageCollection(
  store: ContentStore,
  root: string,
  retainedHashes: Set<string>
): Promise<void> {
  const kept = await store.compactSubagentTranscriptManifests({
    kept: [{ id: "kept-message", role: "assistant", content: "kept".repeat(10_000) }]
  })
  const removed = await store.compactSubagentTranscriptManifests({
    removed: [
      { id: "removed-message", role: "assistant", content: "unreferenced".repeat(10_000) }
    ]
  })
  const keptRef = requireBlobRef(firstMessage(kept.manifests, "kept").content_ref, "content")
  const removedRef = requireBlobRef(
    firstMessage(removed.manifests, "removed").content_ref,
    "content"
  )
  retainedHashes.add(keptRef.sha256)

  const junkPrefix = "ff"
  const junkDir = join(root, junkPrefix)
  const tempPath = join(junkDir, `.${"f".repeat(64)}.manual.tmp`)
  const corruptPath = join(junkDir, `${"e".repeat(64)}.json.corrupt.manual`)
  await mkdir(junkDir, { recursive: true })
  await writeFile(tempPath, "temporary", "utf8")
  await writeFile(corruptPath, "corrupt", "utf8")

  const oldTime = new Date(Date.now() - 60_000)
  await Promise.all([
    utimes(blobFile(root, keptRef), oldTime, oldTime),
    utimes(blobFile(root, removedRef), oldTime, oldTime),
    utimes(tempPath, oldTime, oldTime),
    utimes(corruptPath, oldTime, oldTime)
  ])

  const removedCount = await store.pruneUnreferencedSubagentTranscriptBlobs(retainedHashes, 0)
  assert.equal(removedCount, 3)
  assert.equal(await pathExists(blobFile(root, keptRef)), true)
  assert.equal(await pathExists(blobFile(root, removedRef)), false)
  assert.equal(await pathExists(tempPath), false)
  assert.equal(await pathExists(corruptPath), false)

  const hydratedKept = await store.hydrateSubagentTranscriptManifests(kept.manifests)
  assert.equal(
    firstMessage(hydratedKept, "kept").content,
    "kept".repeat(10_000),
    "a referenced blob must remain readable after garbage collection"
  )
}

async function testCompactionIsIdempotentAndManifestRowsStaySmall(
  store: ContentStore
): Promise<void> {
  const prompt = `任务开头🙂${"完整提示🚀".repeat(4_000)}任务结尾🏁`
  const content = `结论开头${"完整正文".repeat(4_000)}结论结尾`
  const reasoning = `推理开头${"完整推理".repeat(4_000)}推理结尾`
  const first = await store.compactSubagentTranscriptManifests({
    task: [
      {
        id: "subagent-prompt-task",
        role: "user",
        content: prompt,
        subagent_description: prompt,
        subagent_tool_call_id: "task"
      },
      {
        id: "subagent-final-task",
        role: "assistant",
        content,
        reasoning,
        content_priority: 1,
        status: "success"
      }
    ]
  })
  const messages = first.manifests.task as UnknownRecord[]
  assert.equal(typeof messages[0].subagent_prompt_fingerprint, "string")
  assert.equal(typeof messages[1].subagent_content_fingerprint, "string")
  assert.equal(typeof messages[1].subagent_reasoning_fingerprint, "string")
  assert(
    serializedBytes(messages[0].subagent_description).byteLength <= 1_024,
    "card descriptions must remain byte-bounded"
  )
  for (const message of messages) {
    if (typeof message.content === "string") {
      assert(serializedBytes(message.content).byteLength <= SUBAGENT_TRANSCRIPT_INLINE_BYTES)
    }
    if (typeof message.reasoning === "string") {
      assert(serializedBytes(message.reasoning).byteLength <= SUBAGENT_TRANSCRIPT_INLINE_BYTES)
    }
  }

  const second = await store.compactSubagentTranscriptManifests(first.manifests)
  assert.equal(second.changed, false, "compacting an already compact manifest must be idempotent")
  assert.deepEqual(second.manifests, first.manifests)

  const hydrated = await store.hydrateSubagentTranscriptManifests(first.manifests)
  const hydratedMessages = hydrated.task as UnknownRecord[]
  assert.equal(hydratedMessages[0].content, prompt)
  assert.equal(hydratedMessages[1].content, content)
  assert.equal(hydratedMessages[1].reasoning, reasoning)

  const template = messages[1]
  const simulatedLargeBucket = Array.from({ length: 10_000 }, (_, index) => ({
    ...template,
    id: `simulated-message-${index}`
  }))
  assert(
    serializedBytes(simulatedLargeBucket).byteLength / simulatedLargeBucket.length < 2_500,
    "sidecar manifest rows must remain small even when the transcript has 10k messages"
  )
}

function testStartupIndexNeverDropsBuckets(store: ContentStore): void {
  const transcripts = Object.fromEntries(
    Array.from({ length: 40 }, (_, index) => {
      const id = `startup-task-${index}`
      const promptContent = `prompt-${index}-${"x".repeat(2_000)}`
      const finalContent = `final-${index}-${"y".repeat(2_000)}`
      return [
        id,
        [
          {
            id: `subagent-prompt-${id}`,
            role: "user",
            content: promptContent,
            subagent_tool_call_id: `raw-${index}`,
            subagent_invocation_scope: `task-v1-${index}`,
            subagent_description: `description-${index}-${"描述🙂".repeat(2_000)}`
          },
          {
            id: `subagent-final-${id}`,
            role: "assistant",
            content: finalContent,
            content_priority: 1,
            status: "success"
          }
        ]
      ]
    })
  )
  const startup = store.buildSubagentTranscriptStartupManifests(transcripts, 2)
  assert.deepEqual(
    Object.keys(startup),
    Object.keys(transcripts).reverse(),
    "the bounded recent-first startup page must return its card rows in chronological order"
  )
  for (const [id, rawMessages] of Object.entries(startup)) {
    assert(Array.isArray(rawMessages) && rawMessages.length === 2)
    const prompt = asRecord(rawMessages[0], `${id} startup prompt`)
    assert.equal(prompt.subagent_tool_call_id, `raw-${id.slice("startup-task-".length)}`)
    assert.equal(prompt.subagent_startup_projection, true)
    const index = id.slice("startup-task-".length)
    assert.equal(
      prompt.subagent_prompt_fingerprint,
      fingerprintSubagentTranscriptContent(`prompt-${index}-${"x".repeat(2_000)}`),
      "startup must fingerprint the full legacy prompt before projection"
    )
    assert(
      serializedBytes(prompt.subagent_description).byteLength <= 1_024,
      "legacy startup descriptions must remain byte-bounded"
    )
    const final = asRecord(rawMessages[1], `${id} startup final`)
    assert.equal(
      final.subagent_content_fingerprint,
      fingerprintSubagentTranscriptContent(`final-${index}-${"y".repeat(2_000)}`),
      "startup must fingerprint the full legacy final before projection"
    )
  }
}

function testStartupProjectionMergePreservesDurableFields(store: ContentStore): void {
  const id = "startup-merge"
  const durableContent = `完整结果${"中间正文".repeat(2_000)}`
  const durableReasoning = `完整推理${"中间思路".repeat(2_000)}`
  const contentRef = {
    v: 1,
    sha256: "a".repeat(64),
    bytes: 12_345,
    kind: "content"
  }
  const reasoningRef = {
    v: 1,
    sha256: "b".repeat(64),
    bytes: 12_346,
    kind: "reasoning"
  }
  const toolCallsRef = {
    v: 1,
    sha256: "c".repeat(64),
    bytes: 12_347,
    kind: "tool_calls"
  }
  const durable = [
    {
      id: `subagent-final-${id}`,
      role: "assistant",
      content: durableContent,
      reasoning: durableReasoning,
      content_ref: contentRef,
      reasoning_ref: reasoningRef,
      tool_calls_ref: toolCallsRef,
      content_priority: 1,
      status: "success",
      subagent_content_fingerprint: "full-content-fp",
      subagent_reasoning_fingerprint: "full-reasoning-fp"
    }
  ]
  const startup = store.buildSubagentTranscriptStartupManifests({ [id]: durable }, 2)[
    id
  ] as UnknownRecord[]
  const correction = {
    ...startup[0],
    status: "error",
    is_error: true
  }
  const merged = store.mergeSubagentTranscriptManifestMessages(durable, [correction])
  const final = asRecord(merged[0], "merged startup correction")
  assert.equal(final.content, durableContent)
  assert.equal(final.reasoning, durableReasoning)
  assert.deepEqual(final.content_ref, contentRef)
  assert.deepEqual(final.reasoning_ref, reasoningRef)
  assert.deepEqual(final.tool_calls_ref, toolCallsRef)
  assert.equal(final.status, "error")
  assert.equal(final.is_error, true)
  assert.equal(final.subagent_startup_projection, undefined)
}

function testManifestPagingIsBounded(store: ContentStore): void {
  const messages = Array.from({ length: 10_000 }, (_, index) => ({ id: `message-${index}` }))
  const latest = store.sliceSubagentTranscriptManifestPage(messages)
  assert.equal(latest.messages.length, 100)
  assert.equal(latest.start, 9_900)
  assert.equal(latest.nextBefore, 9_900)
  assert.equal(asRecord(latest.messages[0], "latest first").id, "message-9900")
  const earlier = store.sliceSubagentTranscriptManifestPage(messages, latest.nextBefore)
  assert.equal(earlier.start, 9_800)
  assert.equal(asRecord(earlier.messages[99], "earlier last").id, "message-9899")
}

async function testManifestPagingHonorsHydrationByteBudget(store: ContentStore): Promise<void> {
  const tenMiB = 10 * 1024 * 1024
  const messages = Array.from({ length: 100 }, (_, index) => ({
    id: `large-ref-${index}`,
    role: "assistant",
    content: "bounded projection",
    content_is_projection: true,
    content_ref: {
      v: 1,
      sha256: index.toString(16).padStart(64, "0"),
      bytes: tenMiB,
      kind: "content"
    }
  }))
  const page = store.sliceSubagentTranscriptManifestPage(messages)
  assert.equal(page.messages.length, 3, "a 32 MiB page must not select 100 ten-MiB blobs")
  let hydratedCount = 0
  await store.hydrateSubagentTranscriptManifestPage(page, async (message) => {
    hydratedCount += 1
    return message
  })
  assert.equal(hydratedCount, 3, "only messages inside the hydration budget may read blobs")

  const oversized = store.sliceSubagentTranscriptManifestPage(
    [
      {
        id: "oversized-ref",
        role: "assistant",
        content: "bounded projection",
        content_is_projection: true,
        content_ref: {
          v: 1,
          sha256: "f".repeat(64),
          bytes: 40 * 1024 * 1024,
          kind: "content"
        }
      }
    ],
    undefined,
    100,
    32 * 1024 * 1024
  )
  assert.equal(oversized.messages.length, 1)
  assert.equal(oversized.deferredHydration, true)
  hydratedCount = 0
  await store.hydrateSubagentTranscriptManifestPage(oversized, async (message) => {
    hydratedCount += 1
    return message
  })
  assert.equal(hydratedCount, 0, "an individually oversized blob must not auto-hydrate")
}

function testPrefixHintsNeverDeleteUnmatchedHistory(store: ContentStore): void {
  const first = { id: "draft-prefix-1", role: "assistant", content: "older answer" }
  const latest = { id: "draft-prefix-2", role: "assistant", content: "latest draft" }
  const final = {
    id: "subagent-final-prefix",
    role: "assistant",
    content: "latest draft completed",
    content_priority: 1,
    replaced_message_ids: [latest.id],
    replaced_message_id_prefixes: ["draft-prefix-"]
  }
  const merged = store.mergeSubagentTranscriptManifestMessages([first, latest], [final])
  assert.deepEqual(
    merged.map((message) => asRecord(message, "prefix merged row").id),
    [first.id, final.id],
    "a prefix recovery hint must not delete every matching historical assistant"
  )

  const incompatible = {
    id: "subagent-final-compatible",
    role: "assistant",
    content: "different failure",
    content_priority: 1,
    status: "error",
    is_error: true,
    compatible_replaced_message_id_prefixes: ["compatible-draft-"]
  }
  const partial = {
    id: "compatible-draft-1",
    role: "assistant",
    content: "unrelated successful explanation"
  }
  const compatibleMerged = store.mergeSubagentTranscriptManifestMessages(
    [partial],
    [incompatible]
  )
  assert.equal(compatibleMerged.length, 2, "a compatible prefix hint must not delete by wildcard")
}

async function main(): Promise<void> {
  const previousHome = process.env.HOME
  const previousUserProfile = process.env.USERPROFILE
  const home = await mkdtemp(join(tmpdir(), "cmb-subagent-content-store-"))
  process.env.HOME = home
  process.env.USERPROFILE = home
  try {
    const store = await import("../src/main/services/subagent-transcript-content-store.ts")
    const { getSubagentTranscriptContentDir } = await import("../src/main/storage.ts")
    const root = getSubagentTranscriptContentDir()
    assert(root.startsWith(home), "the content store must be isolated inside the temporary home")

    const retainedHashes = new Set<string>()
    await testLargeContentAndToolCallsRoundTrip(store, retainedHashes)
    await testHydrationConcurrencyIsBounded(store, retainedHashes)
    await testKindsCannotCollide(store, retainedHashes)
    await testMultibyteManifestContentIsByteBounded(store, retainedHashes)
    await testCorruptSameHashBlobSelfHeals(store, root, retainedHashes)
    await testGarbageCollection(store, root, retainedHashes)
    await testCompactionIsIdempotentAndManifestRowsStaySmall(store)
    testStartupIndexNeverDropsBuckets(store)
    testStartupProjectionMergePreservesDurableFields(store)
    testManifestPagingIsBounded(store)
    await testManifestPagingHonorsHydrationByteBudget(store)
    testPrefixHintsNeverDeleteUnmatchedHistory(store)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousUserProfile
    await rm(home, { recursive: true, force: true })
  }
  console.log("subagent-transcript-content-store.spec.ts passed")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
