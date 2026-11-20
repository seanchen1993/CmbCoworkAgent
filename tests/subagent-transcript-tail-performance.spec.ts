import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
  applyPersistedSubagentTranscriptRefs,
  appendSubagentLiveTextProjection,
  mergeSubagentTranscripts,
  mergeTranscriptMessage,
  restoreSubagentsFromTranscripts,
  selectMergedTranscriptRowsForPersistence,
  serializeSubagentTranscripts,
  upsertTranscriptMessages
} from "../src/renderer/src/lib/subagent-transcripts"
import type { Message, Subagent } from "../src/renderer/src/types"

const createdAt = new Date("2026-08-21T00:00:00.000Z")

function assistant(id: string, content: string, extra: Partial<Message> = {}): Message {
  return { id, role: "assistant", content, created_at: createdAt, ...extra }
}

function user(id: string, content: string): Message {
  return { id, role: "user", content, created_at: createdAt }
}

function poisonStablePrefixIndexes(messages: Message[], count: number): void {
  const stableValues = messages.slice(0, count)
  let armed = false
  for (let index = 0; index < count; index += 1) {
    Object.defineProperty(messages, index, {
      configurable: true,
      get(): Message {
        if (armed) throw new Error(`stable history index was read: ${index}`)
        return stableValues[index]
      },
      set(value: Message): void {
        stableValues[index] = value
      }
    })
  }
  armed = true
}

function testMainAndPendingTailUpdatesDoNotReadStableHistory(): void {
  const stablePrefix = Array.from({ length: 10_000 }, (_, index) =>
    user(`history-${index}`, `history ${index}`)
  )
  const mainBaseline = [
    ...stablePrefix,
    assistant("live-main", "head\n…[省略 9000 字]…\ntail-one", {
      content_is_projection: true,
      content_full_length: 10_000
    })
  ]
  const pendingBaseline = [
    ...stablePrefix,
    assistant("live-pending", "pending-one")
  ]
  const warmedMain = mergeSubagentTranscripts(
    { worker: mainBaseline },
    "worker",
    [
      assistant("live-main", "head\n…[省略 10000 字]…\ntail-two", {
        content_is_projection: true,
        content_full_length: 11_000
      })
    ]
  ).worker
  const warmedPending = upsertTranscriptMessages(pendingBaseline, [
    assistant("live-pending", "pending-one two")
  ])
  poisonStablePrefixIndexes(warmedMain, 10_000)
  poisonStablePrefixIndexes(warmedPending, 10_000)
  const nextMainFrame = assistant("live-main", "head\n…[省略 11000 字]…\ntail-three", {
    content_is_projection: true,
    content_full_length: 12_000
  })
  const nextMain = mergeSubagentTranscripts(
    { worker: warmedMain },
    "worker",
    [nextMainFrame]
  ).worker
  const nextPending = upsertTranscriptMessages(warmedPending, [
    assistant("live-pending", "pending-one two three")
  ])

  assert.equal(nextMain.length, 10_001)
  assert.equal(nextMain, warmedMain, "trusted content-only frames must retain the owned array")
  assert.equal(nextMain.at(-1)?.content_full_length, 12_000)
  assert.match(String(nextMain.at(-1)?.content), /tail-three$/)
  assert.equal(
    selectMergedTranscriptRowsForPersistence(nextMain, [nextMainFrame])[0],
    nextMain.at(-1),
    "persistence row selection must use the trusted tail without scanning the prefix"
  )
  assert.equal(nextPending.length, 10_001)
  assert.equal(
    nextPending,
    warmedPending,
    "pending persistence must retain its owned array on content-only frames"
  )
  assert.equal(nextPending.at(-1)?.content, "pending-one two three")
}

function testAmbiguousFramesKeepFullMergeSemantics(): void {
  const earlier = assistant("earlier", "draft")
  const tail = assistant("tail", "tail content")
  const warmed = upsertTranscriptMessages([], [earlier, tail])
  const replayedEarlier = upsertTranscriptMessages(warmed, [
    assistant("earlier", "draft corrected")
  ])
  assert.deepEqual(
    replayedEarlier.map((message) => message.content),
    ["draft corrected", "tail content"],
    "an out-of-order replay must update its original row instead of replacing the tail"
  )

  const args = { path: "src/index.ts" }
  const withToolIdentityChange = upsertTranscriptMessages(replayedEarlier, [
    assistant("tail", "tail content extended", {
      tool_calls: [{ id: "call-1", name: "read_file", args }]
    })
  ])
  assert.equal(withToolIdentityChange.at(-1)?.tool_calls?.[0]?.id, "call-1")

  const call = assistant("snapshot-call", "calling", {
    tool_calls: [{ id: "snapshot-tool-call", name: "read_file", args }]
  })
  const final = assistant("snapshot-final", "done")
  const tool: Message = {
    id: "snapshot-tool",
    role: "tool",
    content: "result",
    tool_call_id: "snapshot-tool-call",
    created_at: createdAt
  }
  const complete = upsertTranscriptMessages(
    [call, final],
    [call, tool, final],
    { completeSnapshot: true }
  )
  assert.deepEqual(
    complete.map((message) => message.id),
    ["snapshot-call", "snapshot-tool", "snapshot-final"],
    "complete snapshots must retain their authoritative ordering fallback"
  )
}

function testTrustedNewRowsAndToolBoundariesDoNotReadStableHistory(): void {
  const stablePrefix = Array.from({ length: 20_000 }, (_, index) =>
    user(`tool-history-${index}`, `history ${index}`)
  )
  const main = upsertTranscriptMessages([], stablePrefix, { completeSnapshot: true })
  const pending = upsertTranscriptMessages([], stablePrefix, { completeSnapshot: true })
  poisonStablePrefixIndexes(main, stablePrefix.length)
  poisonStablePrefixIndexes(pending, stablePrefix.length)

  for (const bucket of [main, pending]) {
    const owned = bucket
    for (let index = 0; index < 100; index += 1) {
      const assistantId = `live-call-${index}`
      const assistantFrame = assistant(assistantId, `calling ${index}`)
      assert.equal(upsertTranscriptMessages(owned, [assistantFrame]), owned)
      const toolCallFrame = assistant(assistantId, `calling ${index}`, {
        status: "streaming",
        tool_calls: [
          {
            id: `tool-call-${index}`,
            name: "read_file",
            args: { path: `src/file-${index}.ts` }
          }
        ]
      })
      assert.equal(
        upsertTranscriptMessages(owned, [toolCallFrame]),
        owned,
        "first tool-call metadata on the trusted tail must update in place"
      )
      const toolMessage: Message = {
        id: `tool-result-${index}`,
        role: "tool",
        content: `result ${index}`,
        tool_call_id: `tool-call-${index}`,
        created_at: createdAt
      }
      assert.equal(
        upsertTranscriptMessages(owned, [toolMessage]),
        owned,
        "a new unique live tool row must append without normalizing stable history"
      )
    }
    assert.equal(owned.length, stablePrefix.length + 200)
    assert.equal(owned.at(-1)?.id, "tool-result-99")
    const sentRows = owned.slice(-4)
    const multiRowRef = {
      v: 1 as const,
      sha256: "f".repeat(64),
      bytes: 32,
      kind: "content" as const
    }
    const registry = { worker: owned }
    assert.equal(
      applyPersistedSubagentTranscriptRefs(
        registry,
        { worker: sentRows },
        {
          worker: sentRows.map((message) => ({
            id: message.id,
            content_ref: multiRowRef
          }))
        }
      ),
      registry,
      "a multi-row persistence ACK must use the live id index instead of mapping history"
    )
    assert.equal(owned.at(-1)?.content_ref?.sha256, multiRowRef.sha256)
  }
}

function testPersistedTailRefsDoNotCopyStableHistory(): void {
  const messages = [
    ...Array.from({ length: 20_000 }, (_, index) => user(`persisted-${index}`, "old")),
    assistant("persisted-tail", "complete")
  ]
  poisonStablePrefixIndexes(messages, 20_000)
  const sentTail = assistant("persisted-tail", "complete")
  const contentRef = {
    v: 1 as const,
    sha256: "a".repeat(64),
    bytes: 8,
    kind: "content" as const
  }
  const current = { worker: messages }
  const attached = applyPersistedSubagentTranscriptRefs(
    current,
    { worker: [sentTail] },
    { worker: [{ id: sentTail.id, content_ref: contentRef }] }
  )
  assert.equal(attached.worker, messages)
  assert.equal(attached.worker.at(-1)?.content_ref?.sha256, contentRef.sha256)
}

function testTailUpdatesDoNotEnumerateTheBucketRegistry(): void {
  const workerMessages = upsertTranscriptMessages([], [
    assistant("registry-tail", "one")
  ])
  const rawRegistry: Record<string, Message[]> = { worker: workerMessages }
  for (let index = 0; index < 2_000; index += 1) {
    rawRegistry[`stable-worker-${index}`] = [assistant(`stable-${index}`, "stable")]
  }
  const registry = new Proxy(rawRegistry, {
    ownKeys(): ArrayLike<string | symbol> {
      throw new Error("content-only update enumerated the stable subagent registry")
    }
  })
  const merged = mergeSubagentTranscripts(
    registry,
    "worker",
    [assistant("registry-tail", "one two")]
  )
  assert.equal(merged, registry)
  assert.equal(merged.worker.at(-1)?.content, "one two")

  const ref = {
    v: 1 as const,
    sha256: "b".repeat(64),
    bytes: 7,
    kind: "content" as const
  }
  const attached = applyPersistedSubagentTranscriptRefs(
    registry,
    { worker: [assistant("registry-tail", "one two")] },
    { worker: [{ id: "registry-tail", content_ref: ref }] }
  )
  assert.equal(attached, registry)
  assert.equal(attached.worker.at(-1)?.content_ref?.sha256, ref.sha256)

  const threadContext = readFileSync(
    new URL("../src/renderer/src/lib/thread-context.tsx", import.meta.url),
    "utf8"
  )
  assert.doesNotMatch(
    threadContext,
    /\.\.\.currentState\.subagentTranscriptContentVersions/,
    "live content version bumps must not spread the 2k-subagent registry"
  )
  assert.match(
    threadContext,
    /subagentTranscriptsRevision:\s*currentState\.subagentTranscriptsRevision \+ 1/,
    "the O(1) version mutation must publish a new scalar so external-store subscribers update"
  )
}

function testBoundedLiveProjectionAndDeltaPersistence(): void {
  for (const length of [16_000, 16_001, 23_999, 24_000, 24_001]) {
    const source = "x".repeat(length - 1) + "z"
    const projected = appendSubagentLiveTextProjection(undefined, source)
    assert.equal(projected.totalLength, length)
    if (length <= 24_000) {
      assert.equal(projected.content, source, `length ${length} must remain lossless`)
    } else {
      assert.ok(projected.content.length <= 24_000)
      assert.match(projected.content, /z$/)
      assert.match(projected.content, /省略/)
    }
  }

  let projection = appendSubagentLiveTextProjection(undefined, "first-")
  let live = assistant("live-delta", projection.content, {
    content_is_projection: true,
    content_full_length: projection.totalLength,
    content_stream_delta: "first-",
    content_pending_delta: "first-"
  })
  const bootstrap = serializeSubagentTranscripts({ worker: [live] }).worker as Array<
    Record<string, unknown>
  >
  assert.equal(bootstrap[0].content, "first-")
  assert.equal(bootstrap[0].reasoning, "")
  assert.equal(bootstrap[0].subagent_live_text_bootstrap, true)

  const contentRef = {
    v: 1 as const,
    sha256: "c".repeat(64),
    bytes: 8,
    kind: "content" as const
  }
  const reasoningRef = {
    v: 1 as const,
    sha256: "d".repeat(64),
    bytes: 2,
    kind: "reasoning" as const
  }
  const registry = { worker: [live] }
  applyPersistedSubagentTranscriptRefs(
    registry,
    { worker: [live] },
    {
      worker: [
        {
          id: live.id,
          content_ref: contentRef,
          content_full_length: 6,
          reasoning_ref: reasoningRef,
          reasoning_full_length: 0
        }
      ]
    }
  )
  live = registry.worker[0]
  assert.equal(live.content_pending_delta, "")
  assert.equal(live.content_persisted_length, 6)

  projection = appendSubagentLiveTextProjection(projection, "second")
  const nextFrame = assistant("live-delta", projection.content, {
    content_is_projection: true,
    content_full_length: projection.totalLength,
    content_stream_delta: "second"
  })
  const originalStartsWith = String.prototype.startsWith
  String.prototype.startsWith = function poisonedStartsWith(): never {
    throw new Error("trusted delta must not compare the accumulated prefix")
  }
  try {
    live = mergeTranscriptMessage(live, nextFrame)
  } finally {
    String.prototype.startsWith = originalStartsWith
  }
  assert.equal(live.content_pending_delta, "second")
  const deltaManifest = serializeSubagentTranscripts({ worker: [live] }).worker as Array<
    Record<string, unknown>
  >
  assert.deepEqual(
    (deltaManifest[0].subagent_text_deltas as Record<string, unknown>).content,
    {
      v: 1,
      baseRefSha256: contentRef.sha256,
      baseLength: 6,
      targetLength: 12,
      delta: "second"
    }
  )
  assert.ok(JSON.stringify(deltaManifest).length < 2_000)
  const structuralDeltaManifest = serializeSubagentTranscripts({
    worker: [
      {
        ...live,
        status: "streaming",
        tool_calls: [{ id: "call-1", name: "lookup", args: { query: "journal" } }]
      }
    ]
  }).worker as Array<Record<string, unknown>>
  assert.deepEqual(
    (structuralDeltaManifest[0].subagent_text_deltas as Record<string, unknown>).content,
    {
      v: 1,
      baseRefSha256: contentRef.sha256,
      baseLength: 6,
      targetLength: 12,
      delta: "second"
    }
  )
  assert.deepEqual(structuralDeltaManifest[0].tool_calls, [
    { id: "call-1", name: "lookup", args: { query: "journal" } }
  ])

  // D may be in flight while E is merged into the next pending bucket. The D
  // acknowledgement must rebase that bucket to after-D so the next write is E,
  // not an overlapping D+E range that has to reread the full durable journal.
  const racedPending = {
    ...live,
    content: "first-secondthird",
    content_full_length: 17,
    content_pending_delta: "secondthird"
  }
  const racedPendingRegistry = { worker: [racedPending] }
  applyPersistedSubagentTranscriptRefs(
    racedPendingRegistry,
    { worker: [live] },
    {
      worker: [
        {
          id: live.id,
          content_ref: contentRef,
          content_full_length: 12,
          reasoning_ref: reasoningRef,
          reasoning_full_length: 0
        }
      ]
    }
  )
  assert.equal(racedPendingRegistry.worker[0].content_persisted_length, 12)
  assert.equal(racedPendingRegistry.worker[0].content_pending_delta, "third")
  const racedManifest = serializeSubagentTranscripts(racedPendingRegistry).worker as Array<
    Record<string, unknown>
  >
  assert.deepEqual(
    (racedManifest[0].subagent_text_deltas as Record<string, unknown>).content,
    {
      v: 1,
      baseRefSha256: contentRef.sha256,
      baseLength: 12,
      targetLength: 17,
      delta: "third"
    }
  )

  const secondAckRegistry = { worker: [live] }
  applyPersistedSubagentTranscriptRefs(
    secondAckRegistry,
    { worker: [live] },
    {
      worker: [
        {
          id: live.id,
          content_ref: contentRef,
          content_full_length: 12,
          reasoning_ref: reasoningRef,
          reasoning_full_length: 0
        }
      ]
    }
  )
  live = secondAckRegistry.worker[0]
  let payloadBytes = 0
  let deltaChars = 0
  for (let index = 0; index < 2_000; index += 1) {
    const delta = `${String(index).padStart(6, "0")}:${"q".repeat(24)}`
    deltaChars += delta.length
    projection = appendSubagentLiveTextProjection(projection, delta)
    live = mergeTranscriptMessage(
      live,
      assistant("live-delta", projection.content, {
        content_is_projection: true,
        content_full_length: projection.totalLength,
        content_stream_delta: delta
      })
    )
    const sent = live
    const manifest = serializeSubagentTranscripts({ worker: [sent] })
    const serialized = JSON.stringify(manifest)
    payloadBytes += serialized.length
    const marker = (
      ((manifest.worker as unknown[])[0] as Record<string, unknown>)
        .subagent_text_deltas as { content: { delta: string } }
    ).content
    assert.equal(marker.delta, delta)
    const registry = { worker: [live] }
    applyPersistedSubagentTranscriptRefs(registry, { worker: [sent] }, {
      worker: [
        {
          id: live.id,
          content_ref: contentRef,
          content_full_length: projection.totalLength,
          reasoning_ref: reasoningRef,
          reasoning_full_length: 0
        }
      ]
    })
    live = registry.worker[0]
    assert.equal(live.content_pending_delta, "")
    assert.ok(String(live.content).length <= 24_000)
  }
  assert.equal(live.content_persisted_length, 12 + deltaChars)
  assert.ok(payloadBytes < 4_000_000, `2k wire payloads grew to ${payloadBytes} bytes`)
}

function testRestoreTenThousandBucketsUsesIndexedCardsWithoutReverseCopies(): void {
  const transcripts: Record<string, Message[]> = {}
  const existing: Subagent[] = []
  for (let index = 0; index < 10_000; index += 1) {
    const subagentId = `restored-${index}`
    transcripts[subagentId] = [
      {
        id: `subagent-prompt-${subagentId}`,
        role: "user",
        content: `prompt ${index}`,
        subagent_tool_call_id: subagentId,
        created_at: createdAt
      },
      assistant(`subagent-final-${subagentId}`, `done ${index}`, {
        content_priority: 1,
        status: "success"
      })
    ]
    if (index < 5_000) {
      existing.push({
        id: subagentId,
        toolCallId: subagentId,
        name: `Existing ${index}`,
        description: "existing",
        status: "cancelled",
        spawnIndex: index
      })
    }
  }

  const originalFindIndex = Array.prototype.findIndex
  const originalReverse = Array.prototype.reverse
  try {
    Object.defineProperty(Array.prototype, "findIndex", {
      configurable: true,
      writable: true,
      value(): never {
        throw new Error("restore enumerated the growing card array")
      }
    })
    Object.defineProperty(Array.prototype, "reverse", {
      configurable: true,
      writable: true,
      value(): never {
        throw new Error("restore copied and reversed a transcript bucket")
      }
    })
    const restored = restoreSubagentsFromTranscripts(transcripts, existing)
    assert.equal(restored.length, 10_000)
    assert.equal(restored[0]?.status, "completed")
    assert.equal(restored.at(-1)?.id, "restored-9999")
    assert.equal(restored.at(-1)?.spawnIndex, 9_999)
  } finally {
    Object.defineProperty(Array.prototype, "findIndex", {
      configurable: true,
      writable: true,
      value: originalFindIndex
    })
    Object.defineProperty(Array.prototype, "reverse", {
      configurable: true,
      writable: true,
      value: originalReverse
    })
  }
}

testMainAndPendingTailUpdatesDoNotReadStableHistory()
testAmbiguousFramesKeepFullMergeSemantics()
testTrustedNewRowsAndToolBoundariesDoNotReadStableHistory()
testPersistedTailRefsDoNotCopyStableHistory()
testTailUpdatesDoNotEnumerateTheBucketRegistry()
testBoundedLiveProjectionAndDeltaPersistence()
testRestoreTenThousandBucketsUsesIndexedCardsWithoutReverseCopies()
console.log("subagent transcript tail performance contracts passed")
