import { describe, expect, it } from "vitest"
import {
  readCheckpointReplayTurns,
  mergeCheckpointAuthorityTranscriptMessages
} from "./checkpoint-transcript"
import type { CheckpointAuthorityTranscriptMessage as Message } from "./checkpoint-transcript"
import {
  alignReplayedToolExchanges,
  findReplayedToolExchangeAliases,
  getAssistantReplayContent,
  prepareToolTranscriptReplayMerge
} from "./tool-transcript-replay"
import { getWorkerToolUiKey, resolveToolResultOwnership } from "./tool-result-ownership"
import { normalizeMessageContent } from "./thread-message-content"

const user: Message = { id: "user", role: "user", content: "Inspect the fixture" }
const resultId = "a45d9be4-3ca7-4e24-ad61-9e0a55b0e465"
const hiddenTeam = {
  id: "hidden-team",
  type: "human",
  content: "Notification",
  additional_kwargs: { cmb_internal_coordinator_notification: true }
}

function checkpointRows(rows: Message[]) {
  return rows.map((row) => ({
    ...row,
    type: row.role === "user" ? "human" : row.role === "assistant" ? "ai" : "tool"
  }))
}

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

  it("aligns independent exchanges that reused both provider IDs in the same turn", () => {
    const otherResultId = "1c711082-5111-4632-976d-7c05ee064c33"
    const [first] = exchange()
    const [second] = exchange(2)
    const [third] = exchange(3)
    const [, firstResult] = exchange()
    const secondResult = {
      ...firstResult,
      id: otherResultId,
      provider_source_id: otherResultId,
      content: "New execution"
    }
    const olderResponse = { ...first, content: "Earlier user reply", tool_calls: undefined }
    const durable = [
      { ...user, id: "earlier-user" },
      olderResponse,
      user,
      second,
      firstResult,
      third,
      secondResult
    ]
    const checkpoint = [user, first, firstResult, second, secondResult]
    const aligned = alignReplayedToolExchanges(durable, checkpoint)
    expect(mergeCheckpointAuthorityTranscriptMessages(aligned, durable)).toEqual(durable)
    expect(checkpoint[1].id).toBe(first.id)
    const blocked = [...checkpoint, { ...third, tool_calls: undefined, content: "Keep this row" }]
    expect(alignReplayedToolExchanges(durable, blocked)).toBe(blocked)
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
    const turns = readCheckpointReplayTurns({
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
    expect([...turns!.hiddenAnchors]).toEqual([user.id])
    const checkpoint = [user, ...exchange(), later, ...exchange()]
    const canonical = [user, ...exchange(3), later, ...exchange(2)]
    // Give the two independent turns distinct result and assistant source IDs.
    for (const rows of [canonical, checkpoint]) {
      for (const row of rows.slice(-2)) {
        row.id = `later-${row.id}`
        row.provider_source_id = `later-${row.provider_source_id}`
      }
    }
    expect(alignReplayedToolExchanges(canonical, checkpoint, turns).map(({ id }) => id)).toEqual([
      ...checkpoint.slice(0, 4).map(({ id }) => id),
      ...canonical.slice(-2).map(({ id }) => id)
    ])
  })

  it("aligns complete raw tool groups on either side of a hidden Team turn and keeps Goal scope", () => {
    const checkpoint = [user, ...exchange()]
    const raw = checkpointRows(checkpoint)
    const goalUser = { ...user, goal_id: "goal", active_window_id: "window" }
    const canonical = [goalUser, ...exchange(2)]
    for (const messages of [
      [...raw, hiddenTeam],
      [raw[0], hiddenTeam, ...raw.slice(1)]
    ]) {
      const turns = readCheckpointReplayTurns({ channel_values: { messages } })
      const aligned = alignReplayedToolExchanges(canonical, checkpoint, turns)
      expect(mergeCheckpointAuthorityTranscriptMessages(aligned, canonical)).toEqual(canonical)
      const conflicting = [{ ...user, goal_id: "another-goal" }, ...exchange()]
      expect(alignReplayedToolExchanges(canonical, conflicting, turns)).toBe(conflicting)
    }
  })

  it("uses a unique physical group when a checkpoint retained only the hidden turn", () => {
    const checkpoint = exchange()
    const canonical = [user, ...exchange(2)]
    const turns = readCheckpointReplayTurns({
      channel_values: { messages: [hiddenTeam, ...checkpointRows(checkpoint)] }
    })
    expect(alignReplayedToolExchanges(canonical, checkpoint, turns)).toEqual(exchange(2))
    const [first, firstTool] = exchange(2)
    const [second, secondTool] = exchange(3)
    const ambiguous = [
      user,
      { ...first, reasoning: "First evidence" },
      firstTool,
      { ...user, id: "later" },
      { ...second, reasoning: "Other evidence" },
      secondTool
    ]
    expect(alignReplayedToolExchanges(ambiguous, checkpoint, turns)).toBe(checkpoint)
  })

  it.each([
    [true, false],
    [false, true],
    [true, true]
  ])(
    "aligns before merging already-replayed tool groups (durable %s, checkpoint %s)",
    (durableHasCopy, checkpointHasCopy) => {
      const earlierResponse = {
        ...exchange()[0],
        content: "Older reply",
        tool_calls: undefined
      }
      const canonical = [
        { ...user, id: "earlier-user" },
        earlierResponse,
        user,
        ...exchange(2),
        ...(durableHasCopy ? exchange(3) : [])
      ]
      const checkpoint = [user, ...exchange(), ...(checkpointHasCopy ? exchange(2) : [])]
      const raw = checkpointRows(checkpoint)
      const turns = readCheckpointReplayTurns({
        channel_values: { messages: [raw[0], hiddenTeam, ...raw.slice(1)] }
      })
      const aligned = alignReplayedToolExchanges(canonical, checkpoint, turns)
      const merged = mergeCheckpointAuthorityTranscriptMessages(aligned, canonical)
      const aliases = findReplayedToolExchangeAliases(merged)
      expect(merged.filter(({ id }) => !aliases.has(id))).toEqual(canonical.slice(0, 5))
    }
  )

  it.each(["durable-view", "checkpoint-only", "fresh-result", "stale-before-fresh"])(
    "reconciles old observed drafts before checkpoint ordering (%s)",
    (mode) => {
      const [assistant, result] = exchange()
      const [typed, typedResult] = exchange(2)
      const [grown, grownResult] = exchange(3)
      const [replayed, replayedResult] = exchange(4)
      const nextUser = { ...user, id: "next-user" }
      const blocks = [
        { type: "text", index: 0, text: "Directory listing" },
        { type: "text", index: 1, text: "Read results" }
      ]
      const final = { ...grown, content: [{ ...blocks[0], text: "Directory listing checked" }, blocks[1]] }
      const replay = { ...replayed, content: blocks }
      const fresh = {
        ...replayedResult,
        id: "9c09fdd9-e146-4c2c-9b12-cac648551576",
        provider_source_id: undefined,
        provider_occurrence: 1,
        content: "A new physical execution result"
      }
      const durable = [
        user,
        { ...assistant, content: "Directory listing\nRead results" },
        result,
        { ...typed, content: blocks },
        typedResult,
        final,
        grownResult,
        nextUser,
        ...(mode === "durable-view" ? [replay, replayedResult] : [])
      ]
      const checkpoint = mode === "durable-view"
        ? durable
        : [
            nextUser,
            mode === "stale-before-fresh" ? { ...assistant, content: blocks } : replay,
            ...(mode === "stale-before-fresh" ? [result] : []),
            ...(mode === "checkpoint-only" ? [replayedResult] : []),
            ...(mode === "fresh-result" || mode === "stale-before-fresh" ? [fresh] : [])
          ]
      const turns = mode === "durable-view"
        ? undefined
        : readCheckpointReplayTurns({ channel_values: { messages: checkpointRows(checkpoint) } })
      const prepared = prepareToolTranscriptReplayMerge(durable, checkpoint, turns)
      const merged = mergeCheckpointAuthorityTranscriptMessages(prepared.checkpoint, prepared.durable, {
        useStableProviderOccurrences: Boolean(turns)
      })
      const aliases = findReplayedToolExchangeAliases(merged)
      const visible = merged.filter(({ id }) => !aliases.has(id))
      expect(visible.map(({ role }) => role)).toEqual(
        mode === "fresh-result" || mode === "stale-before-fresh"
          ? ["user", "assistant", "tool", "user", "assistant", "tool"]
          : ["user", "assistant", "tool", "user"]
      )
      expect(visible[1].content).toEqual(final.content)
      expect(visible[3].id).toBe(nextUser.id)
      if (mode === "stale-before-fresh") {
        const bindings = resolveToolResultOwnership(visible)
        expect(bindings.get(getWorkerToolUiKey(visible[4].id, "shared-call", 0))?.id).toBe(fresh.id)
      }
    }
  )

  it("selects the exact matching payload when both sources retained different versions", () => {
    const original = exchange(2, { path: "fixture" }, "Earlier output")
    const updated = exchange(3)
    const canonical = [user, ...original, ...updated]
    const checkpoint = [user, ...exchange(1, { path: "fixture" }, "Earlier output")]
    const aligned = alignReplayedToolExchanges(canonical, checkpoint)
    expect(mergeCheckpointAuthorityTranscriptMessages(aligned, canonical)).toEqual(canonical)
  })

  it("keeps matching evidence in a later visible turn even when an earlier turn has replay copies", () => {
    const newerUser = { ...user, id: "current-user" }
    const original = { ...exchange()[0], content: "Older reply", tool_calls: undefined }
    const durable = [
      { ...user, id: "earliest" },
      original,
      user,
      ...exchange(2),
      ...exchange(3),
      newerUser,
      ...exchange(4)
    ]
    const checkpoint = [newerUser, ...exchange()]
    const raw = checkpointRows(checkpoint)
    const turns = readCheckpointReplayTurns({
      channel_values: { messages: [raw[0], hiddenTeam, ...raw.slice(1)] }
    })
    const aligned = alignReplayedToolExchanges(durable, checkpoint, turns)
    expect(aligned.map(({ id }) => id)).toEqual([newerUser, ...exchange(4)].map(({ id }) => id))
    const merged = mergeCheckpointAuthorityTranscriptMessages(aligned, durable, {
      useStableProviderOccurrences: true
    })
    expect(merged.find(({ id }) => id === original.id)).toEqual(original)
    const aliases = findReplayedToolExchangeAliases(merged)
    expect(merged.filter(({ role, id }) => role === "tool" && !aliases.has(id))).toHaveLength(1)
  })

  it("removes the checkpoint copy that blocks a matched exchange across visible turns", () => {
    const original = { ...exchange()[0], content: "Older reply", tool_calls: undefined }
    const laterUser = { ...user, id: "later" }
    const canonical = [{ ...user, id: "earlier" }, original, user, ...exchange(2)]
    const checkpoint = [user, ...exchange(), laterUser, ...exchange(2)]
    const aligned = alignReplayedToolExchanges(canonical, checkpoint)
    expect(aligned.map(({ id }) => id)).toEqual(
      [user, ...exchange(2), laterUser].map(({ id }) => id)
    )
    const merged = mergeCheckpointAuthorityTranscriptMessages(aligned, canonical, {
      useStableProviderOccurrences: true
    })
    expect(merged.find(({ id }) => id === original.id)).toEqual(original)
  })

  it("retains verified checkpoint folding when the matching occurrence already has the right ID", () => {
    const original = { ...exchange()[0], content: "Older reply", tool_calls: undefined }
    const later = { ...user, id: "later" }
    const canonical = [{ ...user, id: "earlier" }, original, user, later, ...exchange(2)]
    const checkpoint = [user, ...exchange(), later, ...exchange(2)]
    const aligned = alignReplayedToolExchanges(canonical, checkpoint)
    expect(aligned).toEqual([user, later, ...exchange(2)])
    const merged = mergeCheckpointAuthorityTranscriptMessages(aligned, canonical, {
      useStableProviderOccurrences: true
    })
    expect(merged.find(({ id }) => id === original.id)).toEqual(original)
  })

  it.each([
    [true, false],
    [false, false],
    [false, true]
  ])(
    "keeps an older reply alongside checkpoint-only tool data (different execution %s, trimmed %s)",
    (differentExecution, trimmed) => {
      const original = { ...exchange()[0], content: "Older reply", tool_calls: undefined }
      const [existing, existingTool] = exchange(2, { path: "fixture" }, "Persisted output")
      const canonical = [{ ...user, id: "earlier" }, original, user, existing, existingTool]
      const [assistant, tool] = exchange(1, { path: "fixture" }, "Checkpoint output")
      // SQLite can still be on the prior version of the same result while the
      // checkpoint contains the new payload under the bare provider ID.
      const displayedTool = differentExecution
        ? { ...tool, id: "1c711082-5111-4632-976d-7c05ee064c33", provider_source_id: undefined }
        : tool
      const existingToolInDatabase = { ...existingTool, id: resultId, provider_occurrence: 1 }
      canonical[canonical.length - 1] = existingToolInDatabase
      const checkpoint = trimmed ? [assistant, displayedTool] : [user, assistant, displayedTool]
      const raw = checkpointRows(checkpoint)
      const turns = readCheckpointReplayTurns({
        channel_values: {
          messages: trimmed ? [hiddenTeam, ...raw] : [raw[0], hiddenTeam, ...raw.slice(1)]
        }
      })
      const aligned = alignReplayedToolExchanges(canonical, checkpoint, turns)
      const restored = mergeCheckpointAuthorityTranscriptMessages(aligned, canonical, {
        useStableProviderOccurrences: true
      })
      expect(restored.find(({ id }) => id === original.id)).toEqual(original)
      expect(restored.filter(({ role }) => role === "user").map(({ id }) => id)).toEqual([
        "earlier",
        user.id
      ])
      expect(restored.findIndex(({ id }) => id === original.id)).toBeLessThan(
        restored.findIndex(({ content }) => content === "Checkpoint output")
      )
      expect(
        restored
          .filter(({ role }) => role === "tool")
          .map(({ content }) => content)
          .sort()
      ).toEqual(["Checkpoint output", "Persisted output"])
    }
  )

  it("allows a same-turn checkpoint to complete an unfinished durable call", () => {
    const [assistant] = exchange()
    const checkpoint = [user, ...exchange()]
    const durable = [user, { ...assistant, content: "Partial assistant output" }]
    expect(alignReplayedToolExchanges(durable, checkpoint)).toBe(checkpoint)
  })

  it.each([
    { trimmed: false, content: "Checking the updated file" },
    { trimmed: true, content: "" },
    {
      trimmed: false,
      content: [
        { type: "reasoning", reasoning: "Inspect the file first" },
        { type: "text", text: "Checking" }
      ]
    }
  ])(
    "reuses the completed tool execution for checkpoint assistant revisions ($trimmed, $content)",
    ({ trimmed, content }) => {
      const oldReply = {
        ...exchange()[0],
        content: "Unrelated earlier reply",
        tool_calls: undefined
      }
      const assistant = { ...exchange()[0], content }
      const tool = exchange()[1]
      const durable = [{ ...user, id: "earlier" }, oldReply, user, exchange(2)[0], tool]
      const checkpoint = trimmed ? [assistant, tool] : [user, assistant, tool]
      const serialized = checkpointRows(checkpoint)
      const raw = trimmed
        ? [hiddenTeam, ...serialized]
        : [serialized[0], hiddenTeam, ...serialized.slice(1)]
      const turns = readCheckpointReplayTurns({ channel_values: { messages: raw } })
      const aligned = alignReplayedToolExchanges(durable, checkpoint, turns)
      const merged = mergeCheckpointAuthorityTranscriptMessages(aligned, durable, {
        useStableProviderOccurrences: true
      })
      expect(
        merged.filter(({ role, tool_calls }) => role === "assistant" && tool_calls?.length)
      ).toEqual([expect.objectContaining({ id: durable[3].id, content })])
      expect(merged.filter(({ role }) => role === "tool")).toHaveLength(1)
      expect(merged.find(({ id }) => id === oldReply.id)).toEqual(oldReply)
    }
  )

  it("does not split a bare same-turn tool execution when the assistant changes presentation", () => {
    const [assistant, tool] = exchange()
    const durable = [user, assistant, tool]
    for (const updated of [
      { ...assistant, content: "Extended wording" },
      { ...assistant, content: "" },
      { ...assistant, reasoning: "Reasoning arrived later" }
    ]) {
      const checkpoint = [user, updated, tool]
      expect(alignReplayedToolExchanges(durable, checkpoint)).toBe(checkpoint)
    }
  })

  it("folds multiple checkpoint presentations when they resolve to one completed call", () => {
    const [first, result] = exchange()
    const [copy, copiedResult] = exchange(2)
    const revised = { ...copy, content: "The latest wording" }
    const durable = [user, copy, result]
    const checkpoint = [user, first, result, revised, copiedResult]
    const aligned = alignReplayedToolExchanges(durable, checkpoint)
    expect(aligned.map(({ id }) => id)).toEqual(durable.map(({ id }) => id))
    expect(aligned[1].content).toBe(revised.content)
  })

  it.each([false, true])(
    "keeps durable exact copies folded after a checkpoint presentation revision (trimmed %s)",
    (trimmed) => {
      const older = { ...exchange()[0], content: "Unrelated earlier reply", tool_calls: undefined }
      const [assistant, tool] = exchange()
      const checkpoint = trimmed
        ? [{ ...assistant, content: "Revised wording" }, tool]
        : [user, { ...assistant, content: "Revised wording" }, tool]
      const rows = checkpointRows(checkpoint)
      const turns = readCheckpointReplayTurns({
        channel_values: { messages: trimmed ? [hiddenTeam, ...rows] : rows }
      })
      const durable = [{ ...user, id: "older" }, older, user, ...exchange(2), ...exchange(3)]
      const prepared = prepareToolTranscriptReplayMerge(durable, checkpoint, turns)
      const merged = mergeCheckpointAuthorityTranscriptMessages(
        prepared.checkpoint,
        prepared.durable,
        { useStableProviderOccurrences: true }
      )
      const aliases = findReplayedToolExchangeAliases(merged)
      const rendered = merged.filter(({ id }) => !aliases.has(id))
      expect(rendered.filter(({ role }) => role === "tool")).toHaveLength(1)
      expect(
        rendered.filter(({ tool_calls }) => tool_calls?.length).map(({ content }) => content)
      ).toEqual(["Revised wording"])
      expect(rendered.find(({ id }) => id === older.id)).toEqual(older)
      expect(
        durable.filter(({ tool_calls }) => tool_calls?.length).map(({ content }) => content)
      ).toEqual(["Checking", "Checking"])
    }
  )

  it.each([false, true])(
    "continues one text branch while retaining its siblings (partial %s)",
    (partial) => {
      const texts = [
        "Checking",
        "Checking version",
        "Checking version and status",
        "Checking directory"
      ]
      const batches = texts.map((content, index) => {
        const [assistant, result] = exchange(index + 1)
        const secondId = "ad506755-5e42-4cef-834f-eb1be0f11d27"
        const directory = {
          id: index ? `${secondId}::cmb-same-role-duplicate:tool:${index + 1}` : secondId,
          role: "tool",
          tool_call_id: "ls-call",
          name: "ls",
          content: "Current directory"
        }
        return [
          {
            ...assistant,
            content,
            tool_calls: [...assistant.tool_calls!, { id: "ls-call", name: "ls", args: {} }]
          },
          result,
          ...(partial ? [] : [directory])
        ]
      })
      const rows = [user, ...batches.flat()]
      const retained = batches[1]
      const aliases = findReplayedToolExchangeAliases(rows)
      expect(aliases).toEqual(new Map(batches[2].map((row, index) => [row.id, retained[index].id])))
      expect(getAssistantReplayContent(aliases, (id) => rows.find((row) => row.id === id))).toEqual(
        new Map([[retained[0].id, texts[2]]])
      )
    }
  )

  it.each([
    "text-blocks",
    "mixed-string",
    "same-image",
    "different-image",
    "different-execution",
    "different-reasoning",
    "equal-string-block",
    "equal-split-block",
    "early-indexed-block",
    "indexed-before-image",
    "unindexed-before-image",
    "different-annotation",
    "stable-annotation",
    "added-annotation",
    "annotation-only",
    "citation-before-existing",
    "new-index",
    "string-to-indexed",
    "added-image",
    "added-tool-block",
    "added-after-image"
  ])("retains the original row and exact structured continuation when proved (%s)", (mode) => {
    const [assistant, result] = exchange()
    const [revision, duplicate] = exchange(2)
    const image = { type: "image", source: { type: "url", url: "https://example.com/first.png" } }
    const hasImage = mode.endsWith("image")
    const addsBlock = mode.startsWith("added-") && mode !== "added-annotation"
    const appendedBlock = mode === "added-tool-block"
      ? { type: "tool_use", id: "shared-call", name: "inspect", input: { path: "fixture" } }
      : { ...image, source: { ...image.source, url: "https://example.com/appended.png" } }
    const gainsIndex = mode === "new-index" || mode === "string-to-indexed"
    const earlierCitation = mode === "citation-before-existing"
    const indexed =
      mode === "early-indexed-block" || mode === "indexed-before-image" || gainsIndex || earlierCitation
    const hasLaterParagraph = indexed || mode.endsWith("before-image")
    const annotations = [{ type: "citation", source: "url_citation", url: "https://example.com" }]
    const laterParagraph = {
      type: "text",
      index: 2,
      text: "File details",
      ...(earlierCitation
        ? { annotations: [{ ...annotations[0], url: "https://example.com/details" }] }
        : {})
    }
    const oldText = mode === "equal-split-block" ? "Checking\nFile details" : "Checking"
    const nextText =
      mode.startsWith("equal-") || mode === "annotation-only" || earlierCitation || addsBlock
        ? "Checking"
        : "Checking version and status"
    const earlier = {
      ...assistant,
      content:
        mode === "mixed-string" || mode === "equal-string-block" || mode === "string-to-indexed"
          ? oldText
          : [
              {
                type: "text",
                text: oldText,
                ...(indexed ? { index: 0 } : {}),
                ...(mode === "stable-annotation" ? { annotations } : {}),
                ...(mode === "different-annotation"
                  ? { annotations: [{ ...annotations[0], url: "https://example.com/other" }] }
                  : {})
              },
              ...(hasImage && mode !== "added-image" ? [image] : []),
              ...(hasLaterParagraph && !gainsIndex ? [laterParagraph] : [])
            ]
    }
    const later = {
      ...revision,
      content: [
        {
          type: "text",
          text: nextText,
          ...(indexed ? { index: 0 } : {}),
          ...(mode.endsWith("annotation") || mode === "annotation-only" || earlierCitation
            ? { annotations }
            : {})
        },
        ...(mode === "different-image"
          ? [{ ...image, source: { ...image.source, url: "https://example.com/second.png" } }]
          : hasImage && mode !== "added-image" ? [image] : []),
        ...(addsBlock ? [appendedBlock] : []),
        ...(hasLaterParagraph || mode === "equal-split-block" ? [laterParagraph] : [])
      ],
      ...(mode === "different-reasoning" ? { reasoning: "Independent reasoning" } : {})
    }
    const laterResult = mode === "different-execution"
      ? { ...duplicate, id: "9c09fdd9-e146-4c2c-9b12-cac648551576", provider_source_id: undefined }
      : duplicate
    const rows = [user, earlier, result, later, laterResult]
    const aliases = findReplayedToolExchangeAliases(rows)
    if (mode.startsWith("different-")) {
      expect(aliases.size).toBe(0)
    } else {
      expect(aliases).toEqual(new Map([[later.id, earlier.id], [duplicate.id, result.id]]))
      const content = getAssistantReplayContent(aliases, (id) => rows.find((row) => row.id === id))
      expect(content.get(earlier.id)).toBe(mode.startsWith("equal-") ? undefined : later.content)
    }
  })

  it.each([false, true])(
    "uses the proven continuation to compare replay across turns (match %s)",
    (sameText) => {
      const [first, firstResult] = exchange()
      const [firstRevision, firstCopy] = exchange(2)
      const [second, secondResult] = exchange(3)
      const [secondRevision, secondCopy] = exchange(4)
      const alpha = { ...firstRevision, content: "Checking alpha" }
      const beta = { ...secondRevision, content: sameText ? alpha.content : "Checking beta" }
      const rows = [
        user,
        first,
        firstResult,
        alpha,
        firstCopy,
        { ...user, id: "user-2" },
        second,
        secondResult,
        beta,
        secondCopy
      ]
      const aliases = findReplayedToolExchangeAliases(rows)
      const content = getAssistantReplayContent(aliases, (id) => rows.find((row) => row.id === id))
      expect(
        rows
          .filter(({ role, id }) => role === "assistant" && !aliases.has(id))
          .map((row) => [row.id, content.get(row.id) ?? row.content])
      ).toEqual(
        sameText
          ? [[first.id, alpha.content]]
          : [
              [first.id, alpha.content],
              [second.id, beta.content]
            ]
      )
    }
  )

  it.each([true, false])(
    "matches equivalent assistant representations across user turns (physical %s)",
    (sameExecution) => {
      const [first, originalResult] = exchange()
      const [later, replayedResult] = exchange(2)
      const otherUser = { ...user, id: "next-user" }
      const typed = { ...later, content: [{ type: "text", text: first.content }] }
      const finalResult = sameExecution
        ? replayedResult
        : {
            ...replayedResult,
            id: "9c09fdd9-e146-4c2c-9b12-cac648551576",
            provider_source_id: undefined
          }
      const rows = [user, first, originalResult, otherUser, typed, finalResult]
      expect(findReplayedToolExchangeAliases(rows)).toEqual(
        sameExecution
          ? new Map([[typed.id, first.id], [finalResult.id, originalResult.id]])
          : new Map()
      )
    }
  )

  it("keeps equivalent indexed block evidence for a later earlier-span update", () => {
    const [first, firstResult] = exchange()
    const [alternate, alternateResult] = exchange(2)
    const [later, laterResult] = exchange(3)
    const blocks = [
      { type: "text", index: 0, text: "Directory listing" },
      { type: "text", index: 1, text: "Read results" }
    ]
    const updated = [{ ...blocks[0], text: "Directory listing confirmed" }, blocks[1]]
    const rows = [
      user,
      { ...first, content: "Directory listing\nRead results" },
      firstResult,
      { ...alternate, content: blocks },
      alternateResult,
      { ...later, content: updated },
      laterResult
    ]
    const aliases = findReplayedToolExchangeAliases(rows)
    expect(aliases).toEqual(new Map([
      [alternate.id, first.id],
      [alternateResult.id, firstResult.id],
      [later.id, first.id],
      [laterResult.id, firstResult.id]
    ]))
    expect(getAssistantReplayContent(aliases, (id) => rows.find((row) => row.id === id)).get(
      first.id
    )).toBe(updated)
  })

  it.each(["draft", "intermediate", "fresh-result", "independent-continuation"])(
    "uses exact observed physical drafts after a local structured upgrade (%s)",
    (mode) => {
      const [first, firstResult] = exchange()
      const [middle, middleResult] = exchange(2)
      const [final, finalResult] = exchange(3)
      const [later, laterResult] = exchange(4)
      const [continued, continuedResult] = exchange(5)
      const nextUser = { ...user, id: "next-user" }
      const middleText = "Checking the directory"
      const revised = {
        ...final,
        content: [
          { type: "text", text: middleText },
          { type: "image", source: { type: "url", url: "https://example.com/report.png" } }
        ]
      }
      const replay = { ...later, content: mode === "intermediate" ? middleText : first.content }
      const copiedResult =
        mode === "fresh-result"
          ? { ...laterResult, id: "9c09fdd9-e146-4c2c-9b12-cac648551576",
              provider_source_id: undefined }
          : laterResult
      const rows = [
        user, first, firstResult, { ...middle, content: middleText }, middleResult,
        revised, finalResult, nextUser, replay, copiedResult,
        ...(mode === "independent-continuation"
          ? [{ ...continued, content: "Checking a different directory" }, continuedResult]
          : [])
      ]
      const aliases = findReplayedToolExchangeAliases(rows)
      expect(aliases.get(final.id)).toBe(first.id)
      if (mode === "draft" || mode === "intermediate") {
        expect(aliases.get(later.id)).toBe(first.id)
        expect(aliases.get(copiedResult.id)).toBe(firstResult.id)
      } else {
        expect(aliases.has(later.id)).toBe(false)
        expect(aliases.has(copiedResult.id)).toBe(false)
      }
      expect(getAssistantReplayContent(aliases, (id) => rows.find((row) => row.id === id)).get(
        first.id
      )).toBe(revised.content)
    }
  )

  it.each([false, true])(
    "keeps separate hidden replies with the same outcome (prefix %s)",
    (prefix) => {
      const [earlier, previousResult] = exchange()
      const [current] = exchange(2)
      const currentUser = { ...user, id: "current-user" }
      const resultId = "ad506755-5e42-4cef-834f-eb1be0f11d27"
      const result = {
        ...previousResult,
        id: resultId,
        provider_source_id: resultId,
        content: "Fresh result"
      }
      const alpha = { ...earlier, content: prefix ? "Checking" : "Checking alpha" }
      const beta = { ...current, content: "Checking beta" }
      const intervening = {
        id: "between-notifications",
        role: "assistant",
        content: "A separate reply"
      }
      const betaResult = {
        ...result,
        id: `${resultId}::cmb-same-role-duplicate:tool:2`,
        provider_occurrence: 2
      }
      const durable = [user, earlier, previousResult, currentUser, current, result]
      const checkpoint = [currentUser, alpha, result, intervening, beta, betaResult]
      const turns = readCheckpointReplayTurns({
        channel_values: {
          messages: [
            checkpointRows([currentUser])[0],
            hiddenTeam,
            ...checkpointRows([alpha, result, intervening]),
            { ...hiddenTeam, id: "second-hidden-notice" },
            ...checkpointRows([beta, betaResult])
          ]
        }
      })
      const prepared = prepareToolTranscriptReplayMerge(durable, checkpoint, turns)
      const merged = mergeCheckpointAuthorityTranscriptMessages(
        prepared.checkpoint,
        prepared.durable,
        { useStableProviderOccurrences: true }
      )
      const aliases = findReplayedToolExchangeAliases(merged)
      expect(merged.filter(({ id }) => !aliases.has(id)).map(({ content }) => content)).toEqual([
        user.content,
        earlier.content,
        previousResult.content,
        currentUser.content,
        alpha.content,
        result.content,
        intervening.content,
        beta.content,
        result.content
      ])
    }
  )

  it.each([
    "missing-first",
    "empty-late",
    "different-result",
    "error",
    "no-witness",
    "continued-prose",
    "newline-prose",
    "structured-continuation",
    "structured-newline",
    "saved-blocks",
    "checkpoint-blocks",
    "multiple-text-blocks",
    "inline-reasoning",
    "later-inline-reasoning",
    "retained-image",
    "retained-tool-use",
    "interleaved-blocks",
    "different-image",
    "moved-image",
    "bounded-text",
    "bounded-block",
    "bounded-image",
    "bounded-tool-use",
    "bounded-array-tool-use",
    "bounded-object-tool-use",
    "annotated-continuation"
  ])("keeps separate hidden replies with sparse checkpoint results (%s)", (mode) => {
    const lateEmpty = mode !== "missing-first"
    const [older, olderResult] = exchange()
    const [current] = exchange(2)
    const currentUser = { ...user, id: "current-user" }
    const boundary = {
      id: "between-hidden",
      role: "assistant",
      content: "An independent message"
    }
    const calls = [...current.tool_calls!, { id: "ls-call", name: "ls", args: {} }]
    const includesReasoning = mode.endsWith("inline-reasoning")
    const image = mode === "bounded-image"
      ? { type: "image", source: { type: "base64", data: "a".repeat(70_000) } }
      : { type: "image", source: { type: "url", url: "https://example.com/status.png" } }
    const retained =
      mode.endsWith("tool-use")
        ? {
            type: "tool_use",
            id: "ls-call",
            name: "ls",
            input:
              mode === "bounded-tool-use"
                ? { value: "a".repeat(70_000) }
                : mode === "bounded-array-tool-use"
                  ? { selections: Array.from({ length: 300 }, (_, index) => index) }
                  : mode === "bounded-object-tool-use"
                    ? { options: Object.fromEntries(
                        Array.from({ length: 200 }, (_, index) => [`option_${index}`, index])
                      ) }
                    : {}
          }
        : mode.includes("image") || mode === "interleaved-blocks"
          ? image
          : undefined
    const conflictingImage = mode === "different-image" || mode === "moved-image"
    const blocks = (text: string, stage: "first" | "saved" | "later") => {
      const annotations = mode === "annotated-continuation" && stage !== "first"
        ? [{ type: "citation", source: "url_citation", url: "https://example.com" }]
        : undefined
      const display = text.split("\n").map((text) => ({
        type: "text",
        text,
        ...(annotations ? { annotations } : {})
      }))
      const reasoning = { type: "reasoning", reasoning: `Reasoning for ${stage}` }
      if (
        includesReasoning &&
        stage !== "saved" &&
        (stage === "later" || mode === "inline-reasoning")
      ) {
        return [reasoning, ...display]
      }
      if (!retained) return display
      if (stage === "first" && mode === "bounded-image") {
        return [...display, { ...image, source: { type: "url", url: "https://example.com/first.png" } }]
      }
      if (stage === "later" && mode === "different-image") {
        return [...display, {
          ...image,
          source: { ...image.source, url: "https://example.com/new.png" }
        }]
      }
      if (stage === "later" && mode === "moved-image") return [retained, ...display]
      if (mode === "interleaved-blocks") {
        return [...display.slice(0, 1), retained, ...display.slice(1)]
      }
      return [...display, retained]
    }
    const savedBlocks =
      mode.startsWith("structured") || mode === "saved-blocks" || includesReasoning ||
      mode === "bounded-block" || mode === "annotated-continuation" || Boolean(retained)
    const checkpointBlocks =
      mode.startsWith("structured") || mode === "checkpoint-blocks" ||
      mode === "multiple-text-blocks" || includesReasoning || mode === "bounded-block" ||
      mode === "annotated-continuation" || Boolean(retained)
    const first = {
      ...older,
      tool_calls: calls,
      content: checkpointBlocks ? blocks("Checking", "first") : "Checking"
    }
    const bounded = mode.startsWith("bounded-")
    let savedText = mode === "multiple-text-blocks" || mode === "interleaved-blocks"
      ? "Checking\nNew directory"
      : "Checking the new directory"
    if (mode === "bounded-block") savedText += "x".repeat(61_000)
    if (mode === "bounded-text") savedText += "x".repeat(121_000)
    const continuation =
      bounded ||
      includesReasoning ||
      Boolean(retained) ||
      [
        "continued-prose",
        "structured-continuation",
        "saved-blocks",
        "checkpoint-blocks",
        "multiple-text-blocks",
        "annotated-continuation"
      ].includes(mode)
    const suffix =
      mode === "newline-prose" || mode === "structured-newline"
        ? "\n"
        : continuation
          ? " and reporting back"
          : ""
    const nextText = savedText + suffix
    const next = {
      ...current,
      tool_calls: calls,
      content: checkpointBlocks ? blocks(nextText, "later") : nextText
    }
    const resultId = "1c711082-5111-4632-976d-7c05ee064c33"
    const read = {
      ...olderResult,
      id: resultId,
      provider_source_id: resultId,
      content: "Read content"
    }
    const lsId = "ad506755-5e42-4cef-834f-eb1be0f11d27"
    const ls = {
      id: lsId,
      role: "tool",
      tool_call_id: "ls-call",
      name: "ls",
      content: "Listed files"
    }
    const draft = savedBlocks ? blocks(savedText, "saved") : savedText
    const persistedDraft = bounded ? normalizeMessageContent(normalizeMessageContent(draft)) : draft
    const durable = [
      user,
      older,
      olderResult,
      currentUser,
      {
        ...current,
        tool_calls: calls,
        content: lateEmpty ? persistedDraft : first.content
      },
      read,
      ls,
      boundary
    ]
    const firstResults = lateEmpty ? [read, ls] : []
    const differentExecution = mode === "different-result" || Boolean(suffix)
    const latestReadId = differentExecution ? "81cbcdce-733b-4d6f-86b5-261cb3d89d22" : resultId
    const nextResults = [
      {
        ...read,
        id: differentExecution ? latestReadId : `${resultId}::cmb-same-role-duplicate:tool:2`,
        provider_source_id: latestReadId,
        provider_occurrence: differentExecution ? 1 : 2,
        content: lateEmpty ? "" : read.content,
        ...(mode === "error" ? { status: "error", is_error: true } : {})
      },
      {
        ...ls,
        id: `${lsId}::cmb-same-role-duplicate:tool:2`,
        content: mode === "no-witness" ? "" : ls.content
      }
    ]
    const checkpoint = [currentUser, first, ...firstResults, boundary, next, ...nextResults]
    const turns = readCheckpointReplayTurns({
      channel_values: {
        messages: [
          ...checkpointRows([currentUser]),
          hiddenTeam,
          ...checkpointRows([first, ...firstResults, boundary]),
          { ...hiddenTeam, id: "second-hidden-notice" },
          ...checkpointRows([next, ...nextResults])
        ]
      }
    })
    const prepared = prepareToolTranscriptReplayMerge(durable, checkpoint, turns)
    const merged = mergeCheckpointAuthorityTranscriptMessages(
      prepared.checkpoint,
      prepared.durable,
      { useStableProviderOccurrences: true }
    )
    const aliases = findReplayedToolExchangeAliases(merged)
    const text = getAssistantReplayContent(aliases, (id) => merged.find((row) => row.id === id))
    const visible = merged.filter(({ id }) => !aliases.has(id))
    expect(
      visible
        .filter(({ role }) => role === "assistant")
        .map((row) => text.get(row.id) ?? row.content)
        .slice(-3)
    ).toEqual([
      conflictingImage ? blocks(savedText, "saved") : first.content,
      boundary.content,
      next.content
    ])
    if (lateEmpty) {
      const reply = visible.findLast(({ role }) => role === "assistant")!
      const result = resolveToolResultOwnership(visible).get(
        getWorkerToolUiKey(reply.id, "shared-call", 0)
      )
      expect(result?.content).toBe(mode === "empty-late" ? read.content : "")
    }
  })

  it.each([false, true])(
    "finds the correct structured result variant for a prose revision (trimmed %s)",
    (trimmed) => {
      const structured = (content: string) => [{ type: "text", text: content }]
      const [partial, partialTool] = exchange(2)
      const [final, finalTool] = exchange(3)
      const durable = [
        user,
        partial,
        { ...partialTool, content: structured("Partial") },
        final,
        { ...finalTool, content: structured("Final") }
      ]
      const [assistant, tool] = exchange()
      const revision = [
        { ...assistant, content: "Late checkpoint wording" },
        { ...tool, content: structured("Final") }
      ]
      const checkpoint = trimmed ? revision : [user, ...revision]
      const rows = checkpointRows(checkpoint)
      const turns = readCheckpointReplayTurns({
        channel_values: { messages: trimmed ? [hiddenTeam, ...rows] : rows }
      })
      const prepared = prepareToolTranscriptReplayMerge(durable, checkpoint, turns)
      const merged = mergeCheckpointAuthorityTranscriptMessages(
        prepared.checkpoint,
        prepared.durable,
        { useStableProviderOccurrences: true }
      )
      expect(merged.filter(({ role }) => role === "tool").map(({ content }) => content)).toEqual([
        structured("Partial"),
        structured("Final")
      ])
      expect(
        merged.filter(({ tool_calls }) => tool_calls?.length).map(({ content }) => content)
      ).toEqual(["Checking", "Late checkpoint wording"])
    }
  )

  it.each([true, false])(
    "keeps distinct versions when one occupies the intended occurrence (%s)",
    (matchesFirst) => {
      const original = { ...exchange()[0], content: "Older reply", tool_calls: undefined }
      const canonical = [{ ...user, id: "earlier" }, original, user, ...exchange(2)]
      const first = exchange(1, { path: "fixture" }, matchesFirst ? "ok" : "Other version")
      const second = exchange(2, { path: "fixture" }, matchesFirst ? "Other version" : "ok")
      const aligned = alignReplayedToolExchanges(canonical, [user, ...first, ...second])
      const merged = mergeCheckpointAuthorityTranscriptMessages(aligned, canonical, {
        useStableProviderOccurrences: true
      })
      expect(merged.find(({ id }) => id === original.id)).toEqual(original)
      expect(
        merged
          .filter(({ role }) => role === "tool")
          .map(({ content }) => content)
          .sort()
      ).toEqual(["Other version", "ok"])
    }
  )

  it("does not align collapsed ownership that the raw hidden boundary disproves", () => {
    const [older, olderResult] = exchange()
    const newer = { ...older, id: "newer-call", provider_source_id: undefined }
    const newerResult = {
      ...olderResult,
      id: "1c711082-5111-4632-976d-7c05ee064c33",
      provider_source_id: undefined
    }
    const checkpoint = [user, older, newer, newerResult, olderResult]
    const [u, a, b, r1, r2] = checkpointRows(checkpoint)
    const turns = readCheckpointReplayTurns({
      channel_values: { messages: [u, a, hiddenTeam, b, r1, r2] }
    })
    const canonical = [user, exchange(2)[0], newer, newerResult, olderResult]
    expect(alignReplayedToolExchanges(canonical, checkpoint, turns)).toBe(checkpoint)
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

  it("uses actual LangGraph run-scoped tool IDs and leaves distinct runs intact", () => {
    const scoped = (occurrence: number, runId: string, suffix = "shared-call") => {
      const [assistant, tool] = exchange(occurrence)
      const source = `run-${runId}-tool-${suffix}`
      return [
        assistant,
        {
          ...tool,
          id: tool.id.replace(resultId, source),
          provider_source_id: source
        }
      ]
    }
    const run = "01a2083d-0c02-779f-a925-59e67d731656"
    const first = scoped(1, run)
    const copy = scoped(2, run)
    const independent = scoped(3, "01a2083d-0c02-779f-a925-59e67d731657")
    expect(findReplayedToolExchangeAliases([...first, ...copy, ...independent])).toEqual(
      new Map([
        [copy[0].id, first[0].id],
        [copy[1].id, first[1].id]
      ])
    )
    expect(
      findReplayedToolExchangeAliases([
        ...scoped(1, run, "another-call"),
        ...scoped(2, run, "another-call")
      ]).size
    ).toBe(0)
  })

  it("folds host-generated Bot receipts by execution and preserves separate attempts", () => {
    const nativeReceipt = (occurrence: number, attempt: number) => {
      const [assistant, tool] = exchange(occurrence)
      const name = "bot_work_create"
      const source = `bot-attempt-${resultId}-${attempt}`
      return [
        { ...assistant, tool_calls: [{ id: "shared-call", name, args: {} }] },
        { ...tool, id: tool.id.replace(resultId, source), provider_source_id: source, name }
      ]
    }
    const first = nativeReceipt(1, 1)
    const replay = nativeReceipt(2, 1)
    const next = nativeReceipt(3, 2)
    expect(findReplayedToolExchangeAliases([...first, ...replay, ...next])).toEqual(
      new Map([
        [replay[0].id, first[0].id],
        [replay[1].id, first[1].id]
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
    const calls = [{ id: "shared-call", name: "bot_deliver_files", args: { path: "fixture" } }]
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

  it.each([false, true])(
    "keeps a real repeated assistant when an old result arrives before its own (late %s)",
    (late) => {
      const [original, originalResult] = exchange()
      const [current, stale] = exchange(2)
      const currentResult = {
        ...originalResult,
        id: "1c711082-5111-4632-976d-7c05ee064c33",
        provider_source_id: undefined,
        content: "New tool execution"
      }
      const laterResult = {
        ...currentResult,
        id: "ad506755-5e42-4cef-834f-eb1be0f11d27",
        content: "Another execution"
      }
      const rows = [
        user,
        original,
        originalResult,
        { ...user, id: "repeat" },
        current,
        stale,
        ...(late
          ? [
              { ...user, id: "later" },
              { ...original, id: "another-execution", provider_source_id: undefined },
              laterResult
            ]
          : []),
        currentResult
      ]
      const aliases = findReplayedToolExchangeAliases(rows)
      expect(aliases).toEqual(new Map([[stale.id, originalResult.id]]))
      const ownership = resolveToolResultOwnership(rows.filter(({ id }) => !aliases.has(id)))
      expect(ownership.get(getWorkerToolUiKey(current.id, "shared-call", 0))).toBe(currentResult)
    }
  )

  it("keeps a truthful result when an older owner sits outside the loaded page", () => {
    const [, originalResult] = exchange()
    const [current, stale] = exchange(2)
    const currentResult = {
      ...originalResult,
      id: "1c711082-5111-4632-976d-7c05ee064c33",
      provider_source_id: undefined,
      content: "New tool output"
    }
    const loaded = [originalResult, user, current, stale, currentResult]
    const aliases = findReplayedToolExchangeAliases(loaded)
    expect(aliases).toEqual(new Map([[stale.id, originalResult.id]]))
    const ownership = resolveToolResultOwnership(loaded.filter(({ id }) => !aliases.has(id)))
    expect(ownership.get(getWorkerToolUiKey(current.id, "shared-call", 0))).toBe(currentResult)
    expect(findReplayedToolExchangeAliases(loaded.slice(0, -1)).has(stale.id)).toBe(false)
  })

  it.each([false, true])(
    "reconciles a clipped stale checkpoint against both durable tool executions (hidden %s)",
    (hidden) => {
      const [earlier, originalResult] = exchange()
      const [current, stale] = exchange(2)
      const newUser = { ...user, id: "current-user" }
      const currentResult = {
        ...originalResult,
        id: "1c711082-5111-4632-976d-7c05ee064c33",
        provider_source_id: undefined,
        content: "New tool output"
      }
      const canonical = [user, earlier, originalResult, newUser, current, currentResult]
      const newAssistant = { ...earlier, content: "" }
      const checkpoint = hidden
        ? [newAssistant, originalResult, currentResult]
        : [newUser, newAssistant, stale, currentResult]
      const turns = hidden
        ? readCheckpointReplayTurns({
            channel_values: { messages: [hiddenTeam, ...checkpointRows(checkpoint)] }
          })
        : undefined
      const prepared = prepareToolTranscriptReplayMerge(canonical, checkpoint, turns)
      const merged = mergeCheckpointAuthorityTranscriptMessages(
        prepared.checkpoint,
        prepared.durable,
        { useStableProviderOccurrences: true }
      )
      expect(merged.map(({ id }) => id)).toEqual(canonical.map(({ id }) => id))
      expect(merged.find(({ id }) => id === current.id)?.content).toBe("")
      expect(
        resolveToolResultOwnership(merged).get(getWorkerToolUiKey(current.id, "shared-call", 0))
          ?.content
      ).toBe("New tool output")
    }
  )

  it("repairs both tool bindings before aligning offset checkpoint occurrences", () => {
    const [raw, originalResult] = exchange()
    const [one, stale] = exchange(2)
    const [two] = exchange(3)
    const older = { ...raw, content: "Earlier valid reply", tool_calls: undefined }
    const currentUser = { ...user, id: "current-user" }
    const currentResult = {
      ...originalResult,
      id: "1c711082-5111-4632-976d-7c05ee064c33",
      provider_source_id: undefined,
      content: "New tool output"
    }
    const canonical = [
      { ...user, id: "older-user" },
      older,
      user,
      one,
      originalResult,
      currentUser,
      two,
      currentResult
    ]
    const checkpoint = [user, raw, originalResult, currentUser, one, stale, currentResult]
    const prepared = prepareToolTranscriptReplayMerge(canonical, checkpoint)
    const merged = mergeCheckpointAuthorityTranscriptMessages(
      prepared.checkpoint,
      prepared.durable,
      { useStableProviderOccurrences: true }
    )
    expect(merged.map(({ id }) => id)).toEqual(canonical.map(({ id }) => id))
    expect(merged[1]).toEqual(older)
  })

  it("repairs a stale durable binding before matching a clean hidden checkpoint", () => {
    const [earlier, originalResult] = exchange()
    const [current, stale] = exchange(2)
    const newUser = { ...user, id: "current-user" }
    const currentResult = {
      ...originalResult,
      id: "1c711082-5111-4632-976d-7c05ee064c33",
      provider_source_id: undefined,
      content: "New tool output"
    }
    const canonical = [user, earlier, originalResult, newUser, current, stale, currentResult]
    const checkpoint = [{ ...earlier, content: "" }, currentResult]
    const turns = readCheckpointReplayTurns({
      channel_values: { messages: [hiddenTeam, ...checkpointRows(checkpoint)] }
    })
    const prepared = prepareToolTranscriptReplayMerge(canonical, checkpoint, turns)
    const merged = mergeCheckpointAuthorityTranscriptMessages(
      prepared.checkpoint,
      prepared.durable,
      { useStableProviderOccurrences: true }
    )
    expect(merged.map(({ id }) => id)).toEqual(
      canonical.filter(({ id }) => id !== stale.id).map(({ id }) => id)
    )
    expect(merged.find(({ id }) => id === current.id)?.content).toBe("")
  })

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true]
  ])(
    "omits a proved older whole exchange (current first %s, revised prior prose %s)",
    (currentFirst, revised) => {
      const [earlier, originalResult] = exchange()
      const [current] = exchange(2)
      const fresh = { ...current, content: "Updated current reply" }
      const currentResult = {
        ...originalResult,
        id: "1c711082-5111-4632-976d-7c05ee064c33",
        provider_source_id: undefined,
        content: "Current result"
      }
      const newUser = { ...user, id: "current-user" }
      const durable = [user, earlier, originalResult, newUser, current, currentResult]
      const currentRows = [fresh, currentResult]
      const earlierReplay = [
        revised ? { ...earlier, content: "Replayed older prose revised" } : earlier,
        originalResult
      ]
      const checkpoint = [
        newUser,
        ...(currentFirst ? [...currentRows, ...earlierReplay] : [...earlierReplay, ...currentRows])
      ]
      const prepared = prepareToolTranscriptReplayMerge(durable, checkpoint)
      const merged = mergeCheckpointAuthorityTranscriptMessages(
        prepared.checkpoint,
        prepared.durable,
        { useStableProviderOccurrences: true }
      )
      expect(merged.map(({ id }) => id)).toEqual(durable.map(({ id }) => id))
      expect(merged[1].content).toBe(earlier.content)
      expect(merged[4].content).toBe(fresh.content)
    }
  )

  it.each([
    "only-read",
    "stale-before-read",
    "only-ls-after-stale",
    "hidden-partial",
    "both-missing-ls",
    "both-missing-read",
    "mcp-file-link"
  ])("reconciles a partial parallel batch using a witnessed durable result (%s)", (variant) => {
    const [earlier, oldResult] = exchange()
    const currentUser = { ...user, id: "current-user" }
    const [current, replay] = exchange(2)
    const calls = [...current.tool_calls!, { id: "ls-call", name: "ls", args: {} }]
    const realRead = {
      ...oldResult,
      id: "1c711082-5111-4632-976d-7c05ee064c33",
      provider_source_id: undefined,
      content:
        variant === "mcp-file-link"
          ? [{ type: "text", text: "Current read output" }]
          : "Current read output"
    }
    const realLs = {
      ...oldResult,
      id: "ad506755-5e42-4cef-834f-eb1be0f11d27",
      provider_source_id: undefined,
      tool_call_id: "ls-call",
      name: "ls",
      content: "Current ls output"
    }
    const durable = [
      user,
      earlier,
      oldResult,
      currentUser,
      { ...current, tool_calls: calls },
      ...(variant === "both-missing-read" ? [] : [realRead]),
      ...(variant === "both-missing-ls" ? [] : [realLs])
    ]
    const newAssistant = { ...earlier, tool_calls: calls, content: "Authoritative current batch" }
    const observed =
      variant === "only-read"
        ? [realRead]
        : variant === "only-ls-after-stale" || variant === "both-missing-read"
          ? [replay, realLs]
          : variant === "mcp-file-link"
            ? [
                replay,
                {
                  ...realRead,
                  content: [
                    { type: "text", text: "Current read output" },
                    { type: "file", source_type: "url", url: "file:///fixture.txt" }
                  ]
                }
              ]
            : [replay, realRead]
    const checkpoint =
      variant === "hidden-partial"
        ? [newAssistant, ...observed]
        : [currentUser, newAssistant, ...observed]
    const turns =
      variant === "hidden-partial"
        ? readCheckpointReplayTurns({
            channel_values: {
              messages: [hiddenTeam, ...checkpointRows(checkpoint)]
            }
          })
        : undefined
    const prepared = prepareToolTranscriptReplayMerge(durable, checkpoint, turns)
    const merged = mergeCheckpointAuthorityTranscriptMessages(
      prepared.checkpoint,
      prepared.durable,
      { useStableProviderOccurrences: true }
    )
    expect(merged.map(({ id }) => id)).toEqual(durable.map(({ id }) => id))
    expect(merged[4].content).toBe(newAssistant.content)
    const bindings = resolveToolResultOwnership(merged)
    const read = bindings.get(getWorkerToolUiKey(current.id, "shared-call", 0))
    const ls = bindings.get(getWorkerToolUiKey(current.id, "ls-call", 1))
    expect(read?.id).toBe(variant === "both-missing-read" ? undefined : realRead.id)
    expect(ls?.id).toBe(variant === "both-missing-ls" ? undefined : realLs.id)
    if (variant === "mcp-file-link") {
      expect(read?.content).toEqual(observed[1].content)
    }
  })

  it("uses durable page evidence when both the earlier tool and its assistant are outside the window", () => {
    const [, original] = exchange()
    const [current, stale] = exchange(2)
    const latest = {
      ...original,
      id: "1c711082-5111-4632-976d-7c05ee064c33",
      provider_source_id: undefined,
      content: "New result"
    }
    const proven = { ...stale, historical_tool_replay_id: original.id }
    const [, next] = exchange(3)
    const nextCopy = { ...next, historical_tool_replay_id: original.id }
    const loaded = [user, current, proven, latest]
    expect(findReplayedToolExchangeAliases(loaded)).toEqual(new Map([[stale.id, original.id]]))
    expect(findReplayedToolExchangeAliases([user, current, proven, nextCopy, latest])).toEqual(
      new Map([
        [stale.id, original.id],
        [nextCopy.id, original.id]
      ])
    )
    const differentExecution = {
      ...nextCopy,
      provider_source_id: "ad506755-5e42-4cef-834f-eb1be0f11d27",
      id: "ad506755-5e42-4cef-834f-eb1be0f11d27::cmb-same-role-duplicate:tool:3",
      historical_tool_replay_id: "ad506755-5e42-4cef-834f-eb1be0f11d27",
      content: "Other older execution"
    }
    expect(
      findReplayedToolExchangeAliases([user, current, proven, differentExecution, latest])
    ).toEqual(
      new Map([
        [stale.id, original.id],
        [differentExecution.id, differentExecution.historical_tool_replay_id]
      ])
    )
    const [olderAssistant] = exchange()
    for (const copies of [
      [stale, differentExecution],
      [differentExecution, stale]
    ]) {
      const rows = [
        { ...user, id: "earlier-user" },
        olderAssistant,
        original,
        user,
        current,
        ...copies,
        latest
      ]
      expect(findReplayedToolExchangeAliases(rows)).toEqual(
        new Map([
          [stale.id, original.id],
          [differentExecution.id, differentExecution.historical_tool_replay_id]
        ])
      )
    }
    const otherOriginal = {
      ...differentExecution,
      id: differentExecution.historical_tool_replay_id,
      provider_occurrence: 1,
      historical_tool_replay_id: undefined
    }
    const residentCopy = { ...differentExecution, historical_tool_replay_id: undefined }
    const earlierRows = [
      { ...user, id: "earlier-user" },
      olderAssistant,
      original,
      { ...olderAssistant, id: "another-assistant" },
      otherOriginal
    ]
    for (const copies of [
      [stale, residentCopy],
      [residentCopy, stale],
      [stale, next]
    ]) {
      const aliases = findReplayedToolExchangeAliases([
        ...earlierRows,
        user,
        current,
        ...copies,
        latest
      ])
      expect(aliases).toEqual(new Map(copies.map((row) => [row.id, row.provider_source_id!])))
    }
    expect(findReplayedToolExchangeAliases([user, current, stale, latest]).size).toBe(0)
    const changed = mergeCheckpointAuthorityTranscriptMessages(
      [{ ...proven, content: "" }],
      [{ ...stale, content: "Longer and different payload" }]
    )
    expect(changed[0].historical_tool_replay_id).toBeUndefined()
  })

  it.each([
    "pending",
    "resume-first",
    "resume-last",
    "resumed-prose",
    "prose-after-results",
    "full-copy",
    "different-execution"
  ])("folds only the overlapping physical copies of an interrupted batch (%s)", (mode) => {
    const [first, read] = exchange()
    const [second, readCopy] = exchange(2)
    const declarations = [...first.tool_calls!, { id: "ls-call", name: "ls", args: {} }]
    const directory = {
      id: "ad506755-5e42-4cef-834f-eb1be0f11d27",
      role: "tool",
      name: "ls",
      tool_call_id: "ls-call",
      content: "Current directory"
    }
    const a = { ...first, tool_calls: declarations }
    const revised = ["resumed-prose", "prose-after-results", "full-copy"].includes(mode)
    const b = {
      ...second,
      tool_calls: declarations,
      content: revised ? `${first.content} and listing the directory` : second.content
    }
    const addFirst = [
      "resume-first",
      "prose-after-results",
      "full-copy",
      "different-execution"
    ].includes(mode)
    const otherRead =
      mode === "different-execution"
        ? { ...read, id: "1c711082-5111-4632-976d-7c05ee064c33", provider_source_id: undefined }
        : readCopy
    const rows = [
      user,
      a,
      read,
      ...(addFirst ? [directory] : []),
      b,
      otherRead,
      ...(mode === "resume-last" || mode === "resumed-prose" ? [directory] : []),
      ...(mode === "full-copy"
        ? [{ ...directory, id: `${directory.id}::cmb-same-role-duplicate:tool:2` }]
        : [])
    ]
    const aliases = findReplayedToolExchangeAliases(rows)
    const expected =
      mode === "different-execution"
        ? new Map()
        : new Map([
            [b.id, a.id],
            [readCopy.id, read.id]
          ])
    if (mode === "full-copy") expected.set(rows.at(-1)!.id, directory.id)
    expect(aliases).toEqual(expected)
    expect(findReplayedToolExchangeAliases(rows.slice(1))).toEqual(aliases)
    if (revised) {
      const visible = rows.filter(({ id }) => !aliases.has(id))
      expect(resolveToolResultOwnership(visible).get(getWorkerToolUiKey(a.id, "ls-call", 1))).toBe(
        directory
      )
      expect(getAssistantReplayContent(aliases, (id) => rows.find((row) => row.id === id))).toEqual(
        new Map([[a.id, b.content]])
      )
    }
    expect(
      rows.filter(({ id }) => !aliases.has(id)).filter(({ id }) => id === directory.id)
    ).toHaveLength(mode === "pending" ? 0 : 1)
  })

  it.each(["paused", "mcp", "checkpoint-only"])(
    "folds exact %s copies before combining sources",
    (kind) => {
      const [earlier, oldResult] = exchange()
      const [current, stale] = exchange(2)
      const [duplicate] = exchange(3)
      const currentUser = { ...user, id: "current-user" }
      const currentResult = {
        ...oldResult,
        id: "1c711082-5111-4632-976d-7c05ee064c33",
        provider_source_id: "1c711082-5111-4632-976d-7c05ee064c33",
        content: kind === "mcp" ? [{ type: "text", text: "Current output" }] : "Current output"
      }
      const resultCopy = {
        ...currentResult,
        id: `${currentResult.id}::cmb-same-role-duplicate:tool:2`,
        provider_occurrence: 2
      }
      const calls =
        kind === "mcp"
          ? current.tool_calls
          : [...current.tool_calls!, { id: "pending", name: "ls", args: {} }]
      const durable = [user, earlier, oldResult, currentUser]
      if (kind !== "checkpoint-only")
        durable.push(
          { ...current, tool_calls: calls },
          currentResult,
          { ...duplicate, tool_calls: calls },
          resultCopy
        )
      const latest = { ...earlier, tool_calls: calls, content: "Current checkpoint prose" }
      const output =
        kind === "mcp"
          ? {
              ...currentResult,
              content: [
                { type: "text", text: "Current output" },
                { type: "file", source_type: "url", url: "file:///run.txt" }
              ]
            }
          : currentResult
      const checkpoint = [
        currentUser,
        latest,
        stale,
        output,
        {
          ...current,
          tool_calls: calls,
          content: latest.content
        },
        { ...resultCopy, content: output.content }
      ]
      if (kind === "checkpoint-only") checkpoint.splice(2, 1)
      const prepared = prepareToolTranscriptReplayMerge(durable, checkpoint)
      const merged = mergeCheckpointAuthorityTranscriptMessages(
        prepared.checkpoint,
        prepared.durable,
        {
          useStableProviderOccurrences: true
        }
      )
      expect(merged.map(({ content }) => content)).toEqual([
        user.content,
        earlier.content,
        oldResult.content,
        currentUser.content,
        latest.content,
        output.content
      ])
    }
  )

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true]
  ])(
    "keeps the earliest complete tool batch (single %s, late shorter text %s)",
    (single, lateShorter) => {
      const [first, read] = exchange()
      const [second, readCopy] = exchange(2)
      const extended = "Checking the fixture and reporting status"
      const calls = [...first.tool_calls!]
      const extra = {
        id: "ad506755-5e42-4cef-834f-eb1be0f11d27",
        role: "tool",
        name: "ls",
        tool_call_id: "ls-call",
        content: "Directory output"
      }
      if (!single) calls.push({ id: extra.tool_call_id, name: extra.name, args: {} })
      const original = {
        ...first,
        content: lateShorter ? extended : first.content,
        tool_calls: calls
      }
      const replica = {
        ...second,
        content: lateShorter ? first.content : extended,
        tool_calls: calls
      }
      const unrelated = {
        id: "unrelated-assistant",
        role: "assistant",
        content: "Independent reply"
      }
      const rows = [
        user,
        original,
        read,
        ...(single ? [] : [extra]),
        unrelated,
        replica,
        readCopy,
        ...(single ? [] : [{ ...extra, id: `${extra.id}::cmb-same-role-duplicate:tool:2` }])
      ]
      const aliases = findReplayedToolExchangeAliases(rows)
      expect(rows.filter(({ id }) => !aliases.has(id)).map(({ id }) => id)).toEqual([
        user.id,
        original.id,
        read.id,
        ...(single ? [] : [extra.id]),
        unrelated.id
      ])
      const content = getAssistantReplayContent(aliases, (id) => rows.find((row) => row.id === id))
      expect(content.get(original.id) ?? original.content).toBe(extended)
    }
  )

  it.each(["equal", "mixed", "mixed-prefix"])(
    "keeps divergent presentations and folds copies within each (%s)",
    (mode) => {
      const moreResults = mode !== "equal"
      const [earlier, initialRead] = exchange()
      const declarations = [...earlier.tool_calls!, { id: "ls-call", name: "ls", args: {} }]
      if (moreResults) declarations.push({ id: "grep-call", name: "grep", args: {} })
      const short = { ...earlier, tool_calls: declarations }
      const [left, leftRead] = exchange(2)
      const [right, rightRead] = exchange(3)
      const [repeat, repeatRead] = exchange(4)
      const leftRevision = { ...left, tool_calls: declarations, content: "Checking the version" }
      const rightRevision = {
        ...right,
        tool_calls: declarations,
        content: "Checking the directory"
      }
      const repeatedLeft = {
        ...repeat,
        tool_calls: declarations,
        content:
          mode === "mixed-prefix"
            ? `${leftRevision.content} and reporting status`
            : leftRevision.content
      }
      const directory = {
        id: "ad506755-5e42-4cef-834f-eb1be0f11d27",
        role: "tool",
        name: "ls",
        tool_call_id: "ls-call",
        content: "Current directory"
      }
      for (const revisions of [
        [leftRevision, leftRead, rightRevision, rightRead],
        [rightRevision, rightRead, leftRevision, leftRead]
      ]) {
        const lsCopy = { ...directory, id: `${directory.id}::cmb-same-role-duplicate:tool:2` }
        const grep = {
          id: "81cbcdce-733b-4d6f-86b5-261cb3d89d22",
          role: "tool",
          name: "grep",
          tool_call_id: "grep-call",
          content: "Search output"
        }
        const rows = [
          user,
          short,
          initialRead,
          ...revisions,
          repeatedLeft,
          repeatRead,
          directory,
          ...(moreResults ? [lsCopy, grep] : [])
        ]
        const aliases = findReplayedToolExchangeAliases(rows)
        expect(aliases).toEqual(
          new Map([
            [repeatedLeft.id, leftRevision.id],
            [repeatRead.id, leftRead.id]
          ])
        )
        const retained = rows.filter(({ id }) => !aliases.has(id))
        expect(
          resolveToolResultOwnership(retained).get(getWorkerToolUiKey(short.id, "ls-call", 1))
        ).toBe(directory)
        if (mode === "mixed-prefix") {
          expect(
            getAssistantReplayContent(aliases, (id) => rows.find((row) => row.id === id))
          ).toEqual(new Map([[leftRevision.id, repeatedLeft.content]]))
        }
      }
    }
  )

  it.each([false, true])(
    "keeps a divergent partial continuation beside a full replay (reversed %s)",
    (reversed) => {
      const texts = reversed
        ? ["Checking alpha", "Checking", "Checking", "Checking beta"]
        : ["Checking", "Checking alpha", "Checking", "Checking beta"]
      const batches = texts.map((content, index) => {
        const [assistant, result] = exchange(index + 1)
        const toolId = "ad506755-5e42-4cef-834f-eb1be0f11d27"
        const directory = {
          id: index ? `${toolId}::cmb-same-role-duplicate:tool:${index + 1}` : toolId,
          role: "tool",
          name: "ls",
          tool_call_id: "ls-call",
          content: "Directory output"
        }
        return [
          {
            ...assistant,
            content,
            tool_calls: [...assistant.tool_calls!, { id: "ls-call", name: "ls", args: {} }]
          },
          result,
          ...(index < 2 ? [directory] : [])
        ]
      })
      const rows = [user, ...batches.flat()]
      const aliases = findReplayedToolExchangeAliases(rows)
      expect(
        rows.filter(({ id, role }) => role === "assistant" && !aliases.has(id)).map(({ id }) => id)
      ).toEqual([batches[0][0].id, batches[2][0].id])
      const content = getAssistantReplayContent(aliases, (id) => rows.find((row) => row.id === id))
      expect(content.get(batches[0][0].id) ?? batches[0][0].content).toBe("Checking alpha")
      expect(content.get(batches[2][0].id)).toBe("Checking beta")
    }
  )

  it.each([
    ["Checking beta", "Checking", "Checking alpha"],
    ["Checking", "Checking alpha", "Checking", "Checking beta"]
  ])("keeps incompatible text at opposite ends of a verified result chain (%j)", (...texts) => {
    const toolIds = [
      resultId,
      "ad506755-5e42-4cef-834f-eb1be0f11d27",
      "de0e2358-c06a-4b8d-88ee-87c8a75e04f5",
      "212aadc7-cda7-40f6-9252-ddce6e5d5a9b"
    ]
    const rows = [
      user,
      ...texts.flatMap((content, index) => {
        const [assistant] = exchange(index + 1)
        const calls = texts.map((_, slot) => ({
          id: `call-${slot}`,
          name: "inspect",
          args: { slot }
        }))
        const results = toolIds.slice(0, texts.length - index).map((id, slot) => ({
          id: index ? `${id}::cmb-same-role-duplicate:tool:${index + 1}` : id,
          role: "tool",
          name: "inspect",
          tool_call_id: calls[slot].id,
          content: `Output ${slot}`
        }))
        return [{ ...assistant, content, tool_calls: calls }, ...results]
      })
    ]
    const aliases = findReplayedToolExchangeAliases(rows)
    const content = getAssistantReplayContent(aliases, (id) => rows.find((row) => row.id === id))
    const visible = rows
      .filter(({ id, role }) => role === "assistant" && !aliases.has(id))
      .map((row) => content.get(row.id) ?? row.content)
      .sort()
    expect(visible).toEqual(
      texts.length === 4
        ? ["Checking", "Checking alpha", "Checking beta"]
        : ["Checking alpha", "Checking beta"]
    )
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
    expect(findReplayedToolExchangeAliases([...first, second[0], second[1]]).size).toBe(2)
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

  it.each([false, true])("keeps mixed prefix histories indexed (interleaved %s)", (interleaved) => {
    let reads = 0
    const cite = (url: string) => ({ type: "citation", url })
    const snapshotCount = 500
    const rows = [user, ...Array.from({ length: snapshotCount }, (_, index) => {
      const [assistant, result] = exchange(index + 1, {
        get path() {
          reads++
          return "fixture"
        }
      })
      return [
        {
          ...assistant,
          content: interleaved
            ? [
                { type: "text", index: 0, text: "Directory" + ".".repeat(Math.ceil(index / 2)) },
                { type: "text", index: 1, text: "Contents" + ".".repeat(Math.floor(index / 2)) }
              ]
            : [{
                type: "text",
                text: "Checking" + ".".repeat(index),
                annotations: [
                  cite("https://example.com/first"),
                  ...(index === snapshotCount - 1 ? [cite("https://example.com/last")] : [])
                ]
              }]
        },
        result
      ]
    }).flat()]
    expect(findReplayedToolExchangeAliases(rows).size).toBe((snapshotCount - 1) * 2)
    expect(reads).toBeLessThan(snapshotCount * 25)
  })

  it("compares replay-heavy durable groups once per checkpoint copy", () => {
    let argumentReads = 0
    const build = (first: number) => [
      user,
      ...Array.from({ length: 200 }, (_, index) =>
        exchange(first + index, {
          get path() {
            argumentReads++
            return "fixture"
          }
        })
      ).flat()
    ]
    const durable = build(2)
    const checkpoint = build(1)
    const aligned = alignReplayedToolExchanges(durable, checkpoint)
    expect(aligned.map(({ id }) => id)).toEqual(durable.slice(0, 3).map(({ id }) => id))
    expect(argumentReads).toBeLessThan(3_000)
  })
})
