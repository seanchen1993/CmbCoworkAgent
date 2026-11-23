import { describe, expect, it } from "vitest"
import {
  findVisibleAnchorsWithHiddenCheckpointTurns,
  mergeCheckpointAuthorityTranscriptMessages
} from "./checkpoint-transcript"
import type { CheckpointAuthorityTranscriptMessage as Message } from "./checkpoint-transcript"
import {
  alignReplayedToolExchanges,
  findReplayedToolExchangeAliases
} from "./tool-transcript-replay"

const user: Message = { id: "user", role: "user", content: "Inspect the fixture" }
const resultId = "a45d9be4-3ca7-4e24-ad61-9e0a55b0e465"

function exchange(occurrence = 1, args = { path: "fixture" }, content = "ok"): Message[] {
  const changes = (id: string, role: string) => ({
    id: occurrence === 1 ? id : `${id}::cmb-same-role-duplicate:${role}:${occurrence}`,
    provider_source_id: id,
    provider_occurrence: occurrence,
    role
  })
  return [
    {
      ...changes("shared-response", "assistant"),
      content: "Checking",
      tool_calls: [{ id: "shared-call", name: "inspect", args }]
    },
    { ...changes(resultId, "tool"), content, tool_call_id: "shared-call" }
  ]
}

describe("tool transcript replay", () => {
  it("aligns a complete cross-source exchange despite conflicting occurrence numbers", () => {
    const durable = [user, ...exchange(2)]
    const checkpoint = [user, ...exchange()]
    const aligned = alignReplayedToolExchanges(durable, checkpoint)
    expect(mergeCheckpointAuthorityTranscriptMessages(aligned, durable)).toEqual(durable)
    expect(checkpoint[1].id).toBe("shared-response")
  })

  it("requires a shared anchor, aligned position and only one matching cycle per source", () => {
    const checkpoint = [user, ...exchange()]
    for (const unmatched of [
      [...exchange(2)],
      [{ ...user, id: "hidden-goal-boundary" }, ...exchange(2)],
      [
        user,
        { role: "assistant", id: "intervening", content: "separate invocation" },
        ...exchange(2)
      ],
      [user, ...exchange(2), ...exchange(3)],
      [user, ...exchange(2, { path: "different" })],
      [user, ...exchange(2, { path: "fixture" }, "new result")],
      [user, exchange(2)[0]],
      [user, { ...exchange(2)[0], id: "different-physical-id" }, exchange(2)[1]]
    ]) {
      expect(alignReplayedToolExchanges(unmatched, checkpoint)).toBe(checkpoint)
    }
  })

  it("preserves different prompts even when the user message reused a raw ID", () => {
    const checkpoint = [{ ...user, provider_occurrence: 2 }, ...exchange()]
    const differentUser = { ...user, content: "Inspect a different fixture" }
    expect(alignReplayedToolExchanges([user, ...exchange(2)], checkpoint)).toBe(checkpoint)
    expect(
      alignReplayedToolExchanges([user, ...exchange(2)], [differentUser, ...exchange()])[0]
    ).toBe(differentUser)
    expect(
      alignReplayedToolExchanges([user, ...exchange(2)], [differentUser, ...exchange()])[1].id
    ).toBe("shared-response")
  })

  it("preserves hidden subturns and still aligns a subsequent visible turn", () => {
    const later = { ...user, id: "next-user" }
    const hidden = {
      id: "team-notification",
      type: "human",
      content: "notification",
      additional_kwargs: { cmb_internal_coordinator_notification: true }
    }
    const unsafe = findVisibleAnchorsWithHiddenCheckpointTurns({
      channel_values: {
        messages: [
          { ...user, type: "human" },
          hidden,
          ...exchange(),
          { ...later, type: "human" },
          ...exchange()
        ]
      }
    })
    expect([...unsafe]).toEqual([user.id])
    const checkpoint = [user, ...exchange(), later, ...exchange()]
    const canonical = [user, ...exchange(3), later, ...exchange(2)]
    // Give the two independent turns distinct result and assistant source IDs.
    for (const rows of [canonical, checkpoint]) {
      for (const row of rows.slice(-2)) {
        row.id = `later-${row.id}`
        row.provider_source_id = `later-${row.provider_source_id}`
      }
    }
    expect(alignReplayedToolExchanges(canonical, checkpoint, unsafe).map(({ id }) => id)).toEqual([
      ...checkpoint.slice(0, 4).map(({ id }) => id),
      ...canonical.slice(-2).map(({ id }) => id)
    ])
  })

  it("identifies adjacent replay with the same result execution ID", () => {
    const first = exchange()
    const second = exchange(2)
    const third = exchange(3)
    expect(findReplayedToolExchangeAliases([...first, ...second, ...third])).toEqual(
      new Map([
        [second[0].id, first[0].id],
        [second[1].id, first[1].id],
        [third[0].id, first[0].id],
        [third[1].id, first[1].id]
      ])
    )
  })

  it("keeps independent turns, result IDs, error states and unseen payloads", () => {
    const first = exchange()
    const second = exchange(2)
    const legacy = (rows: Message[]) =>
      rows.map((row) => ({
        ...row,
        id: row.id.replace(resultId, "legacy-result"),
        provider_source_id: row.provider_source_id?.replace(resultId, "legacy-result")
      }))
    for (const input of [
      [...first, user, ...second],
      [...first, ...exchange(2, { path: "elsewhere" })],
      [...first, second[0], { ...second[1], id: "result-from-another-execution" }],
      [...first, second[0], { ...second[1], status: "error", is_error: true }],
      [...first, { ...second[0], reasoning: "additional content" }, second[1]],
      [...legacy(first), ...legacy(second)]
    ]) {
      expect(findReplayedToolExchangeAliases(input).size).toBe(0)
    }
  })

  it("pairs parallel results by the full tool call ID", () => {
    const expand = ([assistant, result]: Message[]): Message[] => [
      {
        ...assistant,
        tool_calls: [...assistant.tool_calls!, { id: "other", name: "inspect", args: {} }]
      },
      result,
      {
        ...result,
        id: result.id.replace("a45d9be4", "c52d6ee4"),
        tool_call_id: "other",
        provider_source_id: result.provider_source_id?.replace("a45d9be4", "c52d6ee4")
      }
    ]
    const first = expand(exchange())
    const second = expand(exchange(2))
    expect(findReplayedToolExchangeAliases([...first, second[0], second[2], second[1]]).size).toBe(
      3
    )
    expect(findReplayedToolExchangeAliases([...first, second[0], second[1]]).size).toBe(0)
  })

  it("does not scan payloads for 10,000 rows in distinctly anchored turns", () => {
    let argumentReads = 0
    const payload = {
      get path() {
        argumentReads++
        return "fixture"
      }
    }
    const messages = Array.from({ length: 3_400 }, (_, index) => [
      { ...user, id: `unique-user-${index}` },
      ...exchange(1, payload)
    ]).flat()
    expect(findReplayedToolExchangeAliases(messages).size).toBe(0)
    expect(argumentReads).toBe(0)
    expect(alignReplayedToolExchanges(messages, messages)).toBe(messages)
    expect(argumentReads).toBe(0)
  })
})
