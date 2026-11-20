import { describe, expect, it } from "vitest"
import { StreamAssistantText } from "./stream-assistant-text"

const ai = (id: string, content: unknown, mode = "delta", namespace = "") => [
  { id: ["AIMessageChunk"], kwargs: { id, content } },
  { cmb_stream_message_content_mode: mode, checkpoint_ns: namespace }
]

describe("assistant text consumed by Goal and Stop", () => {
  it("matches global values occurrences to current Goal segment cycles without rewriting history", () => {
    const run = new StreamAssistantText()
    const turn = new StreamAssistantText()
    run.processMessage(ai("same", "previous"))
    run.beginSegment()
    for (const text of [run, turn]) {
      text.processMessage(ai("same", "old first"))
      text.processMessage([{ id: ["ToolMessage"], kwargs: { id: "t", content: "result" } }, {}])
      text.processMessage(ai("same", "old second"))
      text.applySnapshot(
        {
          id: ["AIMessage"],
          kwargs: {
            id: "same",
            content: "corrected",
            additional_kwargs: {
              cmb_internal_provider_source_id: "same",
              cmb_internal_provider_occurrence: 8
            }
          }
        },
        undefined,
        1
      )
      text.applySnapshot(
        {
          id: ["AIMessage"],
          kwargs: {
            id: "same::second",
            content: "",
            additional_kwargs: {
              cmb_internal_provider_source_id: "same",
              cmb_internal_provider_occurrence: 9
            }
          }
        },
        undefined,
        2
      )
      text.processMessage(ai("same", "fresh"))
    }
    expect(run.text).toBe("previouscorrectedfresh")
    expect(turn.text).toBe("correctedfresh")
  })

  it("does not guess a local ordinal shared by two non-root namespaces", () => {
    const text = new StreamAssistantText()
    text.processMessage(ai("same", "root", "delta", "root-node"))
    text.processMessage(ai("same", "worker", "delta", "worker-node"))
    text.applySnapshot(
      {
        id: ["AIMessage"],
        kwargs: {
          id: "same",
          content: "ambiguous",
          additional_kwargs: {
            cmb_internal_provider_source_id: "same",
            cmb_internal_provider_occurrence: 8
          }
        }
      },
      undefined,
      1
    )
    expect(text.text).toBe("rootworker")
  })

  it.each(["HumanMessage", "ToolMessage"])(
    "claims values created after an existing %s boundary",
    (className) => {
      const text = new StreamAssistantText()
      text.processMessage([
        { id: [className], kwargs: { id: "boundary", content: "input" } },
        { checkpoint_ns: "agent" }
      ])
      text.applySnapshot({ id: ["AIMessage"], kwargs: { id: "a", content: "draft" } })
      text.processMessage(ai("a", "new", "snapshot", "agent"))
      expect(text.text).toBe("new")
    }
  )

  it("checks only boundaries after placeholder creation in the claiming scope", () => {
    const text = new StreamAssistantText()
    const tool = (namespace: string) => [
      { id: ["ToolMessage"], kwargs: { id: "tool", content: "result" } },
      { checkpoint_ns: namespace }
    ]
    text.processMessage(tool("agent"))
    text.applySnapshot({ id: ["AIMessage"], kwargs: { id: "a", content: "draft" } })
    text.processMessage(tool("worker"))
    text.processMessage(ai("a", "new", "snapshot", "agent"))
    expect(text.text).toBe("new")
    text.applySnapshot({ id: ["AIMessage"], kwargs: { id: "b", content: "before-boundary" } })
    text.processMessage(tool("agent"))
    text.processMessage(ai("b", "after-boundary", "snapshot", "agent"))
    expect(text.text).toBe("newbefore-boundaryafter-boundary")
  })

  it.each(["corrected", ""])(
    "adopts values-first text for scoped deltas and replacement %j",
    (replacement) => {
      const text = new StreamAssistantText()
      text.applySnapshot({ id: ["AIMessage"], kwargs: { id: "a", content: "draft" } })
      text.processMessage(ai("b", "other", "delta", "other"))
      text.processMessage(ai("a", " tail", "delta", "agent:run"))
      expect(text.text).toBe("draft tailother")
      text.processMessage(ai("a", replacement, "snapshot", "agent:run"))
      expect(text.text).toBe(replacement + "other")
      text.processMessage(ai("a", "!", "delta", "agent:run"))
      expect(text.text).toBe(replacement + "!other")
    }
  )

  it.each(["message", "values"])(
    "does not adopt a real empty-namespace %s into a different namespace",
    (source) => {
      const text = new StreamAssistantText()
      if (source === "message") text.processMessage(ai("a", "root"))
      else text.applySnapshot({ id: ["AIMessage"], kwargs: { id: "a", content: "root" } }, {})
      text.processMessage(ai("a", "worker", "snapshot", "worker"))
      expect(text.text).toBe("rootworker")
    }
  )

  it("requires an occurrence to claim one of multiple values-first provider identities", () => {
    const text = new StreamAssistantText()
    const message = (id: string, content: string, occurrence: number) => ({
      id: ["AIMessage"],
      kwargs: {
        id,
        content,
        additional_kwargs: {
          cmb_internal_provider_source_id: "same",
          cmb_internal_provider_occurrence: occurrence
        }
      }
    })
    text.applySnapshot(message("first", "one", 1))
    text.applySnapshot(message("second", "two", 2))
    text.processMessage([message("same", "corrected", 2), { checkpoint_ns: "agent" }])
    expect(text.text).toBe("onecorrected")
    text.processMessage(ai("same", "ambiguous", "snapshot", "worker"))
    expect(text.text).toBe("onecorrectedambiguous")
  })

  it("claims an unknown namespace only once and keeps subsequent scopes distinct", () => {
    const text = new StreamAssistantText()
    text.applySnapshot({ id: ["AIMessage"], kwargs: { id: "a", content: "draft" } })
    text.processMessage(ai("a", "root", "snapshot", "root-node"))
    text.processMessage(ai("a", "worker", "snapshot", "worker-node"))
    text.applySnapshot({ id: ["AIMessage"], kwargs: { id: "a", content: "ambiguous" } })
    expect(text.text).toBe("rootworker")
  })

  it("does not claim an earlier values placeholder across a tool boundary or Goal segment", () => {
    const text = new StreamAssistantText()
    text.applySnapshot({ id: ["AIMessage"], kwargs: { id: "a", content: "earlier" } })
    text.processMessage([
      { id: ["ToolMessage"], kwargs: { id: "t", content: "result" } },
      { checkpoint_ns: "agent" }
    ])
    text.processMessage(ai("a", "after-tool", "snapshot", "agent"))
    expect(text.text).toBe("earlierafter-tool")
    text.beginSegment()
    text.processMessage(ai("a", "new-turn", "snapshot", "agent"))
    expect(text.text).toBe("earlierafter-toolnew-turn")
  })

  it("replaces only the addressed message and keeps interleaved messages in order", () => {
    const text = new StreamAssistantText()
    text.processMessage(ai("a", "old"))
    text.processMessage(ai("b", "B"))
    text.processMessage(ai("a", "new", "snapshot"))
    text.processMessage(ai("a", "!"))
    expect(text.text).toBe("new!B")
  })

  it("separates namespaces and repeated provider IDs after a tool boundary", () => {
    const text = new StreamAssistantText()
    text.processMessage(ai("a", "first"))
    text.processMessage([
      { id: ["ToolMessage"], kwargs: { id: "a", content: "hidden result" } },
      {}
    ])
    text.processMessage(ai("a", "second"))
    text.processMessage(ai("a", "corrected", "snapshot"))
    text.processMessage(ai("a", "worker", "delta", "worker"))
    expect(text.text).toBe("firstcorrectedworker")
  })

  it("distinguishes empty replacements from empty usage-only and missing fields", () => {
    const text = new StreamAssistantText()
    text.processMessage(ai("a", "draft"))
    expect(text.processMessage(ai("a", ""))).toBe(false)
    expect(text.processMessage(ai("a", undefined, "snapshot"))).toBe(false)
    expect(text.text).toBe("draft")
    text.processMessage(ai("a", "", "snapshot"))
    expect(text.text).toBe("")
    text.processMessage(ai("a", "new"))
    expect(text.text).toBe("new")
  })

  it("rebases following deltas on the final values message", () => {
    const text = new StreamAssistantText()
    text.processMessage(ai("a", "draft"))
    text.applySnapshot({ id: ["AIMessage"], kwargs: { id: "a", content: "corrected" } })
    text.processMessage(ai("a", " tail"))
    expect(text.text).toBe("corrected tail")
  })

  it("starts a new Goal segment without replacing the previous turn's same ID", () => {
    const run = new StreamAssistantText()
    const turn = new StreamAssistantText()
    for (const text of [run, turn]) text.processMessage(ai("a", "previous"))
    run.beginSegment()
    turn.reset()
    for (const text of [run, turn]) text.processMessage(ai("a", "current", "snapshot"))
    expect(run.text).toBe("previouscurrent")
    expect(turn.text).toBe("current")
  })

  it("routes values to their own namespace and honors provider occurrences", () => {
    const text = new StreamAssistantText()
    text.processMessage(ai("a", "root"))
    text.processMessage(ai("a", "worker", "delta", "worker"))
    text.applySnapshot({ id: ["AIMessage"], kwargs: { id: "a", content: "corrected root" } })
    expect(text.text).toBe("corrected rootworker")
    text.applySnapshot(
      { id: ["AIMessage"], kwargs: { id: "a", content: "corrected worker" } },
      { checkpoint_ns: "worker" }
    )
    expect(text.text).toBe("corrected rootcorrected worker")

    text.processMessage([
      {
        id: ["AIMessageChunk"],
        kwargs: {
          id: "a::second",
          content: "second",
          additional_kwargs: {
            cmb_internal_provider_source_id: "a",
            cmb_internal_provider_occurrence: 2
          }
        }
      },
      {}
    ])
    text.applySnapshot({ id: ["AIMessage"], kwargs: { id: "a", content: "second final" } })
    expect(text.text).toBe("corrected rootcorrected workersecond final")
  })

  it("rebases values without namespace only when the message identity is unambiguous", () => {
    const text = new StreamAssistantText()
    text.processMessage(ai("a", "draft", "delta", "agent:run"))
    text.applySnapshot({ id: ["AIMessage"], kwargs: { id: "a", content: "corrected" } })
    text.processMessage(ai("a", " tail", "delta", "agent:run"))
    expect(text.text).toBe("corrected tail")
    text.processMessage(ai("a", "other", "delta", "worker:run"))
    text.applySnapshot({ id: ["AIMessage"], kwargs: { id: "a", content: "ambiguous" } })
    expect(text.text).toBe("corrected tailother")
  })

  it("bounds Stop text retention and marks any unrecoverable truncated gap", () => {
    const text = new StreamAssistantText(100)
    for (let i = 0; i < 1_000; i++) text.processMessage(ai("a", "x".repeat(100)))
    expect(text.retainedCharacters).toBe(100)
    expect(text.text).toBe("x".repeat(100) + "\n...(truncated)")
    text.processMessage(ai("a", "small", "snapshot"))
    expect(text.text).toBe("small")
    expect(text.retainedCharacters).toBe(5)
  })
})
