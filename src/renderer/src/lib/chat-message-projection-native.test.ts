import { describe, expect, it } from "vitest"
import type { Message } from "../types"
import { createChatMessageProjector } from "./chat-message-projection"
import { createLiveDisplayMessageProjector } from "./live-display-message-projection"
import type { LiveStreamMessage } from "./live-stream-messages"
import { normalizeAppendedLiveStreamMessageIds } from "./live-stream-messages"

const raw = (id = "P", occurrence = 1): Message => ({
  id,
  role: "assistant",
  content: "answer",
  created_at: new Date(1),
  provider_source_id: "P",
  provider_occurrence: occurrence
})
const kept = (id = "U"): Message => ({
  ...raw(id),
  function_row: {
    conversationId: "c",
    branchId: "b",
    uuid: id,
    sequence: 1,
    door: "response",
    messageType: "assistant",
    origin: { kind: "model", model: "test" }
  }
})

describe("kept answer and transitional live display", () => {
  it("keeps one answer when the SDK echoes a saved UUID without provider metadata", () => {
    const baseline = [kept()]
    const display = createLiveDisplayMessageProjector()(baseline, [
      { id: "U", type: "ai", content: "late untrusted content", reasoning: "hidden" }
    ])
    expect(display.messages[0].function_row).toBeUndefined()
    expect(createChatMessageProjector()(baseline, display.messages, undefined).messages).toEqual(
      baseline
    )
  })

  it.each([{ provider_source_id: "P" }, { provider_occurrence: 1 }])(
    "recovers only missing fields of an exact saved UUID (%#)",
    (fields) => {
      const baseline = [kept()]
      const display = createLiveDisplayMessageProjector()(baseline, [
        { id: "U", type: "ai", content: "answer", ...fields }
      ])
      expect(display.messages[0].function_row).toBeUndefined()
      expect(createChatMessageProjector()(baseline, display.messages, undefined).messages).toEqual(
        baseline
      )
    }
  )

  it.each<LiveStreamMessage>([
    { provider_source_id: "other" },
    { provider_source_id: "" },
    { provider_occurrence: 2 },
    { provider_occurrence: 0 },
    { function_row_invalid: true },
    { function_row: kept("V").function_row },
    { type: "human" },
    { id: "V" }
  ])("does not repair conflicting, invalid or unrelated echoes (%#)", (fields) => {
    const baseline = [kept()]
    const display = createLiveDisplayMessageProjector()(baseline, [
      { id: "U", type: "ai", content: "answer", ...fields }
    ])
    expect(
      createChatMessageProjector()(baseline, display.messages, undefined).messages
    ).toHaveLength(2)
  })

  it("does not infer a tuple from duplicate saved UUIDs", () => {
    const baseline = [kept(), kept()]
    const display = createLiveDisplayMessageProjector()(baseline, [
      { id: "U", type: "ai", content: "answer" }
    ])
    expect(display.messages[0].provider_source_id).not.toBe("P")
  })

  it("does not hide an ambiguous raw baseline ID behind collision normalization", () => {
    const native = { ...kept(), type: "ai" }
    const echo = { id: "U", type: "ai", content: "answer" }
    const display = normalizeAppendedLiveStreamMessageIds([native, echo], [echo])
    expect(display[0].provider_source_id).not.toBe("P")
  })

  it("converges through cached projection when the saved row arrives after its live echo", () => {
    const projectLive = createLiveDisplayMessageProjector()
    const projectChat = createChatMessageProjector()
    const incoming = [{ id: "U", type: "ai", content: "answer" }]
    const empty: Message[] = []
    const first = projectLive(empty, incoming)
    expect(projectChat(empty, first.messages, undefined, 0, first).messages).toHaveLength(1)
    const baseline = [kept()]
    const second = projectLive(baseline, incoming)
    expect(projectChat(baseline, second.messages, undefined, 0, second).messages).toEqual(baseline)
  })

  it("shows one kept answer while its raw occurrence awaits append ACK", () => {
    const baseline = [kept()]
    const project = createChatMessageProjector()
    const first = project(baseline, [raw()], undefined)
    expect(first.messages).toEqual(baseline)
    expect(project(baseline, [{ ...raw(), content: "late delta" }], undefined).messages).toEqual(
      baseline
    )
  })

  it.each([
    raw("P", 2),
    { ...raw(), role: "user" as const },
    kept("V"),
    { ...raw(), function_row_invalid: true as const },
    { ...kept(), id: "wrong" }
  ])("preserves separate occurrences, roles, native UUIDs and invalid markers (%#)", (live) => {
    expect(createChatMessageProjector()([kept()], [live], undefined).messages).toHaveLength(2)
  })

  it("does not choose one of ambiguous canonical occurrences", () => {
    expect(
      createChatMessageProjector()([kept(), kept("V")], [raw()], undefined).messages
    ).toHaveLength(3)
  })

  it("does not refill host-redacted reasoning or tools from the live layer", () => {
    const baseline = [kept()]
    const result = createChatMessageProjector()(
      baseline,
      [
        {
          ...raw("U"),
          reasoning: "must remain hidden",
          tool_calls: [{ id: "tool", name: "x", args: {} }]
        }
      ],
      undefined
    )
    expect(result.messages).toEqual(baseline)
  })

  it("invalidates layout when provider metadata changes without an ID change", () => {
    const baseline = [kept()]
    const project = createChatMessageProjector()
    expect(project(baseline, [raw()], undefined).messages).toHaveLength(1)
    expect(
      project(baseline, [{ ...raw(), provider_source_id: "other" }], undefined).messages
    ).toHaveLength(2)
    expect(project(baseline, [kept("P")], undefined).messages).toHaveLength(2)
  })

  it("rebuilds same-array baseline tail identity on native promotion and tuple replacement", () => {
    const baseline = [raw("U")]
    const live = [raw()]
    const project = createChatMessageProjector()
    expect(project(baseline, live, undefined, 0).messages).toHaveLength(2)
    baseline[0] = kept()
    expect(project(baseline, live, undefined, 1).messages).toEqual([kept()])
    baseline[0] = { ...kept(), provider_occurrence: 2 }
    expect(project(baseline, live, undefined, 2).messages).toHaveLength(2)
    baseline[0] = kept()
    expect(project(baseline, live, undefined, 3).messages).toHaveLength(1)
  })

  it("honors actual cumulative live identity revisions through the cached display API", () => {
    const baseline = [kept()]
    const projectLive = createLiveDisplayMessageProjector()
    const projectChat = createChatMessageProjector()
    const frame = (provider: string) =>
      projectLive(baseline, [
        {
          id: "P",
          type: "ai",
          content: "answer",
          provider_source_id: provider,
          provider_occurrence: 1
        }
      ])
    const first = frame("P")
    expect(projectChat(baseline, first.messages, undefined, 0, first).messages).toHaveLength(1)
    const second = frame("other")
    expect(projectChat(baseline, second.messages, undefined, 0, second).messages).toHaveLength(2)
    const third = frame("P")
    expect(projectChat(baseline, third.messages, undefined, 0, third).messages).toHaveLength(1)
  })
})
