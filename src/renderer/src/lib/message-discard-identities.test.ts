import { describe, expect, it } from "vitest"
import {
  buildMessageRoleCollisionId,
  buildMessageSameRoleDuplicateId,
  getMessageProviderOccurrenceIdentity,
  normalizeMessageRoleCollisionIds
} from "../../../shared/message-role-collision"
import {
  liveStreamMessageRole,
  normalizeAppendedLiveStreamMessageIds,
  normalizeLiveStreamMessageIds,
  type LiveStreamMessage
} from "./live-stream-messages"
import { resolveDiscardedLiveMessageIds } from "./message-discard-identities"
import { resolveRetainedCheckpointIdentities } from "./message-discard-checkpoint"

describe("indexed checkpoint identity rebasing", () => {
  it("preserves source-only checkpoint aliases without declaring an implicit first occurrence", () => {
    const cases: [LiveStreamMessage[], LiveStreamMessage[]][] = [
      [
        [{ id: "x", type: "system", provider_occurrence: 3 }],
        [
          { id: "x", type: "human", provider_source_id: "alias", provider_occurrence: 1 },
          { id: "x", type: "system", provider_source_id: "alias" },
          { id: "x", type: "system" }
        ]
      ],
      [
        [
          {
            id: buildMessageSameRoleDuplicateId("a", "assistant", 2),
            type: "ai",
            provider_occurrence: 2
          }
        ],
        [
          {
            id: buildMessageRoleCollisionId("a", "assistant"),
            type: "ai",
            provider_source_id: "b"
          },
          { id: "a", type: "ai" }
        ]
      ]
    ]
    for (const [baseline, stable] of cases) {
      const reference = [...baseline, ...normalizeLiveStreamMessageIds(baseline, stable)]
      expect(resolveRetainedCheckpointIdentities(baseline, stable)).toEqual({
        ids: new Set(reference.map((message) => message.id!)),
        identities: new Set(
          reference.map((message) =>
            getMessageProviderOccurrenceIdentity({ ...message, id: message.id! })
          )
        )
      })
    }
  })

  it("matches independently sampled source and occurrence metadata with a seeded LCG", () => {
    let seed = 714091
    const random = (limit: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % limit
    }
    const ids = [
      "a",
      "b",
      "c",
      "alias",
      buildMessageRoleCollisionId("a", "assistant"),
      buildMessageSameRoleDuplicateId("b", "assistant", 3)
    ]
    const snapshot = (): LiveStreamMessage[] =>
      Array.from({ length: random(8) }, () => ({
        id: ids[random(ids.length)],
        type: ["ai", "human", "tool", "system"][random(4)],
        ...(random(3) === 0 ? { provider_source_id: ["a", "b", "alias"][random(3)] } : {}),
        ...(random(3) === 0 ? { provider_occurrence: random(5) + 1 } : {})
      }))
    for (let index = 0; index < 10000; index++) {
      const baseline = snapshot()
      const stable = snapshot()
      const reference = [...baseline, ...normalizeLiveStreamMessageIds(baseline, stable)]
      expect(
        resolveRetainedCheckpointIdentities(baseline, stable),
        JSON.stringify({ index, baseline, stable })
      ).toEqual({
        ids: new Set(reference.map((message) => message.id!)),
        identities: new Set(
          reference.map((message) =>
            getMessageProviderOccurrenceIdentity({ ...message, id: message.id! })
          )
        )
      })
    }
  })

  it("matches the canonical IDs and identities for seeded mixed checkpoint snapshots", () => {
    let seed = 99
    const random = (limit: number): number => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return (seed >>> 0) % limit
    }
    const snapshot = (): LiveStreamMessage[] =>
      Array.from({ length: random(8) }, () => ({
        id: ["a", "b", "alias", buildMessageSameRoleDuplicateId("a", "assistant", 2)][random(4)],
        type: ["ai", "human", "system", "tool"][random(4)],
        ...(random(3) === 0
          ? {
              provider_source_id: ["a", "b"][random(2)],
              provider_occurrence: random(8) + 1
            }
          : {})
      }))
    for (let index = 0; index < 1000; index++) {
      const baseline = snapshot()
      const stable = snapshot()
      const reference = [...baseline, ...normalizeLiveStreamMessageIds(baseline, stable)]
      expect(
        resolveRetainedCheckpointIdentities(baseline, stable),
        JSON.stringify({ baseline, stable })
      ).toEqual({
        ids: new Set(reference.map((message) => message.id!)),
        identities: new Set(
          reference.map((message) =>
            getMessageProviderOccurrenceIdentity({
              ...message,
              id: message.id!,
              role: liveStreamMessageRole(message.type)
            })
          )
        )
      })
    }
  })

  it("matches snapshot normalization across roles, aliases, duplicates and high occurrences", () => {
    const variants: LiveStreamMessage[][] = [
      [],
      [{ id: "provider", type: "ai" }],
      [
        { id: "provider", type: "ai" },
        { id: "provider", type: "ai" }
      ],
      [
        { id: "provider", type: "system" },
        { id: "provider", type: "ai" }
      ],
      [{ id: "old-alias", type: "ai", provider_source_id: "provider", provider_occurrence: 8 }],
      [
        { id: "provider", type: "ai" },
        { id: "alias", type: "ai", provider_source_id: "provider", provider_occurrence: 2 }
      ],
      [
        { id: "alias", type: "ai", provider_source_id: "provider", provider_occurrence: 8 },
        { id: "provider", type: "ai" }
      ],
      [
        { id: "provider", type: "human" },
        { id: "call", type: "tool" },
        { id: "provider", type: "ai" }
      ],
      [
        { id: "a", type: "tool", provider_source_id: "b", provider_occurrence: 2 },
        { id: "b", type: "ai", provider_source_id: "a", provider_occurrence: 7 },
        { id: "alias", type: "ai" }
      ],
      [
        { id: "b", type: "human" },
        { id: "b", type: "ai" },
        { id: "alias", type: "system", provider_source_id: "b", provider_occurrence: 6 },
        { id: "a", type: "ai", provider_source_id: "b", provider_occurrence: 7 }
      ]
    ]
    for (const baseline of variants) {
      for (const stable of variants) {
        const reference = [...baseline, ...normalizeLiveStreamMessageIds(baseline, stable)]
        const expected = {
          ids: new Set(reference.map((message) => message.id!)),
          identities: new Set(
            reference.map((message) =>
              getMessageProviderOccurrenceIdentity({
                ...message,
                id: message.id!,
                role: liveStreamMessageRole(message.type)
              })
            )
          )
        }
        expect(
          resolveRetainedCheckpointIdentities(baseline, stable),
          JSON.stringify({ baseline, stable })
        ).toEqual(expected)
      }
    }
  })

  for (const count of [1000, 10000]) {
    it(`keeps identity reads linear for a ${count}-row checkpoint and 240 resident rows`, () => {
      let reads = 0
      const stable = Array.from({ length: count }, (_, index) => ({
        get id() {
          reads++
          return `message-${index}`
        },
        type: index % 2 ? "ai" : "human"
      }))
      const result = resolveDiscardedLiveMessageIds(
        new Set(),
        [{ id: "failed", type: "ai" }],
        stable,
        stable.slice(-240)
      )
      expect(result).toEqual(new Set(["failed"]))
      // The previous growing-transcript normalization reread these IDs quadratically.
      expect(reads).toBeLessThan(count * 300)
    })
  }
})

describe("discarded live message identities", () => {
  it("includes the actual role alias assigned against persisted history", () => {
    const messages = normalizeMessageRoleCollisionIds(
      [{ id: "shared", type: "system" }],
      [{ id: "shared", type: "ai", reasoning: "failed attempt" }]
    )
    const discarded = new Set(["shared"])
    expect(resolveDiscardedLiveMessageIds(discarded, messages)).toEqual(
      new Set([buildMessageRoleCollisionId("shared", "assistant")])
    )
    expect(discarded).toEqual(new Set(["shared"]))
  })

  for (const type of ["system", "tool"]) {
    it(`replaces a failed ${type} raw ID without discarding same-name assistant history`, () => {
      const messages = normalizeMessageRoleCollisionIds(
        [{ id: "shared", type: "ai" }],
        [{ id: "shared", type }]
      )
      expect(resolveDiscardedLiveMessageIds(new Set(["shared"]), messages)).toEqual(
        new Set([buildMessageRoleCollisionId("shared", type)])
      )
    })
  }

  it("resolves a collision suffix without guessing a particular suffix", () => {
    const occupied = buildMessageRoleCollisionId("shared", "assistant")
    const messages = normalizeMessageRoleCollisionIds(
      [
        { id: "shared", type: "system" },
        { id: occupied, type: "human" }
      ],
      [{ id: "shared", type: "ai" }]
    )
    expect(messages[0].id).toBe(buildMessageRoleCollisionId("shared", "assistant", 2))
    expect(resolveDiscardedLiveMessageIds(new Set(["shared"]), messages)).toContain(messages[0].id)
  })

  it("does not fan a provider ID out to separate occurrences or unrelated aliases", () => {
    const second = buildMessageSameRoleDuplicateId("shared", "assistant", 2)
    const third = buildMessageSameRoleDuplicateId("shared", "assistant", 3)
    const messages = [
      { id: second, type: "ai", provider_source_id: "shared", provider_occurrence: 2 },
      { id: third, type: "ai", provider_source_id: "shared", provider_occurrence: 3 },
      { id: "durable-alias", type: "ai", provider_source_id: "shared" }
    ]
    expect(resolveDiscardedLiveMessageIds(new Set(["shared"]), messages)).toEqual(
      new Set(["shared"])
    )
    expect(resolveDiscardedLiveMessageIds(new Set([second]), messages)).toEqual(new Set([second]))
  })

  it("preserves unknown discarded IDs and ignores unrelated or unidentified messages", () => {
    expect(
      resolveDiscardedLiveMessageIds(new Set(["absent"]), [
        { type: "ai" },
        { id: "other", type: "ai" }
      ])
    ).toEqual(new Set(["absent"]))
    expect(resolveDiscardedLiveMessageIds(new Set(), [{ id: "other", type: "ai" }])).toEqual(
      new Set()
    )
  })

  it("discards a cold-history duplicate even when transport omitted every discarded ID", () => {
    const persisted = [
      { id: "provider", type: "ai" },
      { id: "new-user", type: "human" }
    ]
    const attempt = normalizeAppendedLiveStreamMessageIds(persisted, [
      { id: "provider", type: "ai", reasoning: "failed reasoning" }
    ])
    const expected = new Set([buildMessageSameRoleDuplicateId("provider", "assistant", 2)])
    expect(resolveDiscardedLiveMessageIds(new Set(), attempt, persisted, persisted)).toEqual(
      expected
    )
    expect(
      resolveDiscardedLiveMessageIds(new Set(["provider"]), attempt, persisted, persisted)
    ).toEqual(expected)
  })

  it("keeps checkpointed steps and discards only the unfinished repeated occurrence", () => {
    const persisted = [{ id: "user", type: "human" }]
    const stable = [
      { id: "provider", type: "ai" },
      { id: "tool-result", type: "tool", tool_call_id: "call" },
      { id: "provider", type: "ai" }
    ]
    const third = buildMessageSameRoleDuplicateId("provider", "assistant", 3)
    const attempt = [
      { id: "provider", type: "ai" },
      { id: "tool-result", type: "tool", tool_call_id: "call" },
      { id: buildMessageSameRoleDuplicateId("provider", "assistant", 2), type: "ai" },
      { id: third, type: "ai" }
    ]
    expect(resolveDiscardedLiveMessageIds(new Set(), attempt, stable, persisted)).toEqual(
      new Set([third])
    )
  })

  for (const [historicalType, liveType] of [
    ["system", "ai"],
    ["ai", "system"],
    ["ai", "tool"]
  ]) {
    it(`keeps cold ${historicalType} history while discarding a same-ID ${liveType}`, () => {
      const persisted = [{ id: "shared", type: historicalType }]
      const attempt = normalizeAppendedLiveStreamMessageIds(persisted, [
        { id: "shared", type: liveType }
      ])
      expect(
        resolveDiscardedLiveMessageIds(new Set(["shared"]), attempt, persisted, persisted)
      ).toEqual(new Set([attempt[0].id]))
    })
  }

  it("preserves a stable aliased occurrence and retains unknown failed alias endpoints", () => {
    const persisted = [{ id: "provider", type: "ai" }]
    const stable = [
      {
        id: "checkpoint-alias",
        type: "ai",
        provider_source_id: "provider",
        provider_occurrence: 2
      }
    ]
    const attempt = [
      { id: "live-alias", type: "ai", provider_source_id: "provider", provider_occurrence: 2 },
      { id: "failed-alias", type: "ai", provider_source_id: "provider", provider_occurrence: 3 }
    ]
    expect(
      resolveDiscardedLiveMessageIds(
        new Set(["live-alias", "failed-alias", "old-failed-alias"]),
        attempt,
        stable,
        persisted
      )
    ).toEqual(new Set(["failed-alias", "old-failed-alias"]))
  })
})
