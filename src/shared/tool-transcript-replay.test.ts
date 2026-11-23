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

  it("aligns an older result with no saved status to its explicit success snapshot", () => {
    const [assistant, tool] = exchange(2)
    const durable = [user, assistant, { ...tool, status: "success" }]
    const checkpoint = [user, ...exchange()]
    expect(alignReplayedToolExchanges(durable, checkpoint).map(({ id }) => id)).toEqual(
      durable.map(({ id }) => id)
    )
  })

  it("requires a shared anchor, aligned position and only one matching cycle per source", () => {
    const checkpoint = [user, ...exchange()]
    for (const unmatched of [
      [...exchange(2)],
      [{ ...user, id: "hidden-goal-boundary" }, ...exchange(2)],
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

  it("retains surrounding reasoning and final replies when a strong execution moved slots", () => {
    const reasoning: Message = {
      id: "reasoning",
      role: "assistant",
      content: "",
      reasoning: "Keep this"
    }
    const final: Message = { id: "final", role: "assistant", content: "Done" }
    const checkpoint = [user, ...exchange(), final]
    const durable = [user, reasoning, ...exchange(2), final]
    const aligned = alignReplayedToolExchanges(durable, checkpoint)
    expect(mergeCheckpointAuthorityTranscriptMessages(aligned, durable)).toEqual(durable)
    const legacy = (rows: Message[]) =>
      rows.map((row) => ({
        ...row,
        id: row.id.replace(resultId, "legacy-result"),
        provider_source_id: row.provider_source_id?.replace(resultId, "legacy-result")
      }))
    const legacyCheckpoint = legacy(checkpoint)
    expect(alignReplayedToolExchanges(legacy(durable), legacyCheckpoint)).toBe(legacyCheckpoint)
  })

  it("folds exact execution copies after another answer and in interleaved snapshots", () => {
    const [assistant, tool] = exchange()
    const [copy, copyTool] = exchange(2)
    const [lastCopy, lastTool] = exchange(3)
    const final: Message = { id: "final", role: "assistant", content: "Done" }
    const expected = new Map([
      [copy.id, assistant.id],
      [copyTool.id, tool.id],
      [lastCopy.id, assistant.id],
      [lastTool.id, tool.id]
    ])
    expect(
      findReplayedToolExchangeAliases([assistant, tool, final, copy, copyTool, lastCopy, lastTool])
    ).toEqual(expected)
    expect(
      findReplayedToolExchangeAliases([assistant, copy, lastCopy, tool, copyTool, lastTool])
    ).toEqual(expected)
    const changed = { ...copyTool, content: "Different" }
    const changedTrace = findReplayedToolExchangeAliases([assistant, copy, tool, lastTool, changed])
    expect(changedTrace.get(copy.id)).toBe(assistant.id)
    expect(changedTrace.has(changed.id)).toBe(false)
  })

  it("preserves exact-row Bot file delivery authorizations", () => {
    const [assistant, tool] = exchange()
    const [copy, copyTool] = exchange(2)
    const first = { ...assistant, botHistoryDeliveryScope: { producerWorkId: "previous" } }
    const second = {
      ...copy,
      botHistoryDeliveryScope: {
        producerWorkId: "previous",
        legacySnapshotPrefix: "authorized/path"
      }
    }
    expect(findReplayedToolExchangeAliases([first, tool, second, copyTool]).size).toBe(0)
    const checkpoint = [user, first, tool]
    expect(alignReplayedToolExchanges([user, second, copyTool], checkpoint)).toBe(checkpoint)
  })

  it("collapses a result-only replay when its owning assistant is unambiguous", () => {
    const [assistant, tool] = exchange()
    const [, copy] = exchange(2)
    expect(findReplayedToolExchangeAliases([assistant, tool, copy])).toEqual(
      new Map([[copy.id, tool.id]])
    )
    const otherAssistant = { ...assistant, id: "other-execution" }
    expect(findReplayedToolExchangeAliases([otherAssistant, assistant, tool, copy]).size).toBe(0)
    const separator: Message = { id: "separator", role: "assistant", content: "Still working" }
    expect(findReplayedToolExchangeAliases([assistant, tool, separator, copy])).toEqual(
      new Map([[copy.id, tool.id]])
    )
    expect(findReplayedToolExchangeAliases([assistant, separator, tool, copy])).toEqual(
      new Map([[copy.id, tool.id]])
    )
    expect(
      findReplayedToolExchangeAliases([otherAssistant, separator, assistant, tool, copy]).size
    ).toBe(0)
    const legacy = { ...otherAssistant, tool_calls: [{ id: "shared-call" }] }
    expect(findReplayedToolExchangeAliases([legacy, separator, assistant, tool, copy]).size).toBe(0)
    const multipleOwners = {
      ...assistant,
      tool_calls: [...assistant.tool_calls!, ...assistant.tool_calls!]
    }
    expect(findReplayedToolExchangeAliases([multipleOwners, separator, tool, copy]).size).toBe(0)
  })

  it("folds exact tool-only replays of a later payload without erasing the earlier version", () => {
    const [assistant, tool] = exchange(1, { path: "fixture" }, "Partial output")
    const [, final] = exchange(2)
    const [, replay] = exchange(3)
    expect(findReplayedToolExchangeAliases([assistant, tool, final, replay])).toEqual(
      new Map([[replay.id, final.id]])
    )
  })

  it("keeps Bot delivery cards on the receipt selected by persisted batch authorization", () => {
    const [assistant, tool] = exchange()
    const calls = assistant.tool_calls!.map((call) => ({ ...call, name: "bot_deliver_files" }))
    const oldResult = { ...tool, name: "bot_deliver_files", content: "Old receipt" }
    const newResult = {
      ...oldResult,
      id: "ad506755-5e42-4cef-834f-eb1be0f11d27",
      provider_source_id: undefined,
      content: "New receipt"
    }
    const [, copy] = exchange(2)
    const replay = { ...oldResult, id: copy.id, provider_occurrence: 2 }
    const rows = [
      user,
      { ...assistant, tool_calls: calls },
      oldResult,
      { ...user, id: "new-user" },
      { ...assistant, id: "new-batch", tool_calls: calls },
      replay,
      newResult
    ]
    expect(findReplayedToolExchangeAliases(rows).size).toBe(0)
    const [copyAssistant] = exchange(2)
    const exactBatchCopy = { ...copyAssistant, tool_calls: calls }
    const earlierBatch = { ...assistant, tool_calls: calls }
    const intervening = { ...assistant, id: "interim", tool_calls: undefined }
    expect(
      findReplayedToolExchangeAliases([
        user,
        earlierBatch,
        intervening,
        oldResult,
        exactBatchCopy,
        replay
      ]).size
    ).toBe(0)
    const checkpoint = [user, exactBatchCopy, replay]
    expect(alignReplayedToolExchanges([user, earlierBatch, oldResult], checkpoint)).toBe(checkpoint)
  })

  it("repairs a replay even when another proposal temporarily displaces its canonical result", () => {
    const [assistant, tool] = exchange()
    const withCall = (id: string) => ({ ...assistant, id, provider_source_id: undefined })
    const withPrompt = (id: string) => ({ ...user, id })
    const withResult = (id: string, content: string) => ({
      ...tool,
      id,
      provider_source_id: undefined,
      content
    })
    const copy = (result: Message) => ({
      ...result,
      id: `${result.id}::cmb-same-role-duplicate:tool:2`,
      provider_occurrence: 2
    })
    const earlierResult = withResult(resultId, "Earlier completed result")
    const veryLateResult = withResult("89668b32-971a-43fa-81aa-ce014c243774", "Late first result")
    const newResult = withResult("ad506755-5e42-4cef-834f-eb1be0f11d27", "New result")
    const rows = [
      withPrompt("first-user"),
      withCall("first-call"),
      withPrompt("second-user"),
      withCall("second-call"),
      earlierResult,
      withCall("third-call"),
      copy(earlierResult),
      veryLateResult,
      withPrompt("third-user"),
      withCall("fourth-call"),
      copy(veryLateResult),
      newResult
    ]
    expect(findReplayedToolExchangeAliases(rows)).toEqual(
      new Map([[copy(veryLateResult).id, veryLateResult.id]])
    )
  })

  it("recognizes full replays of a late completed call", () => {
    const [assistant, tool] = exchange()
    const [replay, replayTool] = exchange(2)
    const final: Message = { id: "finished", role: "assistant", content: "Done" }
    const replayFinal = { ...final, id: "unrelated-reply" }
    const expected = new Map([
      [replay.id, assistant.id],
      [replayTool.id, tool.id]
    ])
    expect(
      findReplayedToolExchangeAliases([user, assistant, final, tool, replay, replayTool])
    ).toEqual(expected)
    expect(
      findReplayedToolExchangeAliases([
        user,
        assistant,
        final,
        tool,
        replay,
        replayFinal,
        replayTool
      ])
    ).toEqual(expected)
    expect(
      findReplayedToolExchangeAliases([user, assistant, replay, final, tool, replayTool])
    ).toEqual(expected)
    const reusedFinal = { ...final, id: "shared-response::cmb-same-role-duplicate:assistant:3" }
    expect(
      findReplayedToolExchangeAliases([user, assistant, replay, reusedFinal, tool, replayTool])
    ).toEqual(expected)
  })

  it("retires a uniquely resolved older owner before folding a later exchange", () => {
    const [assistant, tool] = exchange()
    const [replay, replayTool] = exchange(2)
    const previous = { ...assistant, id: "earlier-assistant" }
    const previousUser = { ...user, id: "earlier-user" }
    const previousResult = {
      ...tool,
      id: "earlier-result",
      provider_source_id: undefined,
      content: "Earlier result"
    }
    const secondPrevious = { ...previous, id: "another-earlier-assistant" }
    const secondPreviousResult = {
      ...previousResult,
      id: "another-earlier-result",
      content: "Second earlier result"
    }
    const rows = [
      previousUser,
      previous,
      secondPrevious,
      user,
      previousResult,
      secondPreviousResult,
      assistant,
      tool,
      replay,
      replayTool
    ]
    expect(findReplayedToolExchangeAliases(rows)).toEqual(
      new Map([
        [replay.id, assistant.id],
        [replayTool.id, tool.id]
      ])
    )
    const withoutOldResults = rows.filter(
      ({ id }) => id !== previousResult.id && id !== secondPreviousResult.id
    )
    expect(findReplayedToolExchangeAliases(withoutOldResults).get(replay.id)).toBe(assistant.id)
  })

  it("uses physical result identity across users and keeps different executions separate", () => {
    const [assistant, tool] = exchange()
    const [replay, replayTool] = exchange(2)
    const nextUser = { ...user, id: "later" }
    expect(
      findReplayedToolExchangeAliases([user, assistant, tool, nextUser, replay, replayTool])
    ).toEqual(
      new Map([
        [replay.id, assistant.id],
        [replayTool.id, tool.id]
      ])
    )
    expect(findReplayedToolExchangeAliases([user, assistant, tool, nextUser, replayTool])).toEqual(
      new Map([[replayTool.id, tool.id]])
    )
    expect(
      findReplayedToolExchangeAliases([
        user,
        assistant,
        tool,
        nextUser,
        replay,
        {
          ...replayTool,
          id: "c02ca9d7-95da-4bbb-a2d9-0d101b12a420",
          provider_source_id: undefined,
          provider_occurrence: undefined
        }
      ]).size
    ).toBe(0)
  })

  it("retains partial evidence and folds subsequent exact complete copies", () => {
    const first = exchange(1, { path: "fixture" }, "partial data")
    const final = exchange(2)
    const replay = exchange(3)
    expect(findReplayedToolExchangeAliases([...first, ...final, ...replay])).toEqual(
      new Map([
        [replay[0].id, final[0].id],
        [replay[1].id, final[1].id]
      ])
    )
  })

  it("folds a replay of an older complete exchange after a newer version", () => {
    const earlier = exchange(1, { path: "fixture" }, "Earlier output")
    const updated = exchange(2)
    const earlierReplay = exchange(3, { path: "fixture" }, "Earlier output")
    const updatedReplay = exchange(4)
    const rows = [user, ...earlier, ...updated, ...earlierReplay, ...updatedReplay]
    expect(findReplayedToolExchangeAliases(rows)).toEqual(
      new Map([
        [earlierReplay[0].id, earlier[0].id],
        [earlierReplay[1].id, earlier[1].id],
        [updatedReplay[0].id, updated[0].id],
        [updatedReplay[1].id, updated[1].id]
      ])
    )
  })

  it("does not throw on non-array historical tool-call payloads", () => {
    const invalid = {
      id: "legacy",
      role: "assistant",
      content: "Readable",
      tool_calls: { length: 1 }
    } as unknown as Message
    const messages = [user, invalid, ...exchange()]
    expect(findReplayedToolExchangeAliases(messages).size).toBe(0)
    expect(alignReplayedToolExchanges(messages, messages)).toBe(messages)
    const [assistant, result] = exchange()
    const malformedResult = { ...result, tool_call_id: 17 } as unknown as Message
    const malformed = [user, assistant, malformedResult]
    expect(alignReplayedToolExchanges(malformed, malformed)).toBe(malformed)
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
      [...first, user, ...second.map((row) => ({ ...row, goal_id: "another-goal" }))],
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

  it("indexes many versions of one result without comparing every payload pair", () => {
    const [assistant, tool] = exchange()
    let payloadReads = 0
    const versions = Array.from({ length: 1_000 }, (_, index) =>
      [index * 2 + 2, index * 2 + 3].map((occurrence) => ({
        ...tool,
        id: `${resultId}::cmb-same-role-duplicate:tool:${occurrence}`,
        provider_occurrence: occurrence,
        get content() {
          payloadReads++
          return `Saved version ${index}`
        }
      }))
    )
    const aliases = findReplayedToolExchangeAliases([assistant, tool, ...versions.flat()])
    expect(aliases.size).toBe(1_000)
    expect(aliases.get(versions[999][1].id)).toBe(versions[999][0].id)
    expect(payloadReads).toBeLessThan(16_000)
  })
})
