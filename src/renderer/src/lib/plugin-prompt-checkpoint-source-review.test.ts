import { describe, expect, it } from "vitest"
import type { Message } from "../types"
import { mergeCheckpointAuthorityTranscriptMessages } from "../../../shared/checkpoint-transcript"
import {
  buildRestoredCheckpointTranscript,
  restoreDurableTranscriptOrdinals,
  sameGoalCommandMessage
} from "./goal-transcript"

const origin = { kind: "plugin" as const, name: "actual", asUser: true as const }

function user(id = "actual-user", overrides: Partial<Message> = {}): Message {
  return {
    id,
    role: "user",
    content: "/goal literal words",
    created_at: new Date(1000),
    ...overrides
  }
}

describe("trusted durable plugin source through checkpoint restoration", () => {
  it("restores source before checkpoint merge and retains it through later hydration", () => {
    const checkpoint = user()
    const durable = user(undefined, { ordinal: 3, prompt_origin: origin })
    const restored = restoreDurableTranscriptOrdinals([checkpoint], [durable])
    const merged = mergeCheckpointAuthorityTranscriptMessages(restored, [durable])
    const hydrated = mergeCheckpointAuthorityTranscriptMessages(merged, [checkpoint])

    expect(restored).toHaveLength(1)
    expect(restored[0]).toMatchObject({ ordinal: 3, prompt_origin: origin })
    expect(merged).toHaveLength(1)
    expect(hydrated).toHaveLength(1)
    expect(hydrated[0].prompt_origin).toEqual(origin)
    expect(hydrated[0].content).toBe(checkpoint.content)
    expect(checkpoint.prompt_origin).toBeUndefined()
  })

  it("also restores source when the checkpoint already has a durable ordinal", () => {
    const restored = restoreDurableTranscriptOrdinals(
      [user(undefined, { ordinal: 3 })],
      [user(undefined, { ordinal: 3, prompt_origin: origin })]
    )
    expect(restored[0]).toMatchObject({ ordinal: 3, prompt_origin: origin })
  })

  it("does not transfer a user source to an assistant with the same public id", () => {
    const checkpoint = user(undefined, { role: "assistant" })
    const durable = user(undefined, { ordinal: 3, prompt_origin: origin })
    const restored = restoreDurableTranscriptOrdinals([checkpoint], [durable])
    const merged = mergeCheckpointAuthorityTranscriptMessages(restored, [durable])

    expect(restored[0].prompt_origin).toBeUndefined()
    expect(restored[0].ordinal).toBeUndefined()
    expect(merged).toHaveLength(2)
    expect(merged.find(message => message.role === "assistant")?.prompt_origin).toBeUndefined()
    expect(merged.find(message => message.role === "user")?.prompt_origin).toEqual(origin)
  })

  it("does not join identical words with different host message ids", () => {
    const checkpoint = user("human")
    const durable = user("plugin", { ordinal: 3, prompt_origin: origin })
    const restored = restoreDurableTranscriptOrdinals([checkpoint], [durable])
    const merged = mergeCheckpointAuthorityTranscriptMessages(restored, [durable])

    expect(restored[0].prompt_origin).toBeUndefined()
    expect(restored[0].ordinal).toBeUndefined()
    expect(merged).toHaveLength(2)
    expect(merged.find(message => message.id === "human")?.prompt_origin).toBeUndefined()
    expect(merged.find(message => message.id === "plugin")?.prompt_origin).toEqual(origin)
  })

  it("does not borrow source from a different occurrence of the same provider id", () => {
    const checkpoint = user(undefined, { provider_source_id: "provider", provider_occurrence: 1 })
    const durable = user(undefined, { provider_source_id: "provider", provider_occurrence: 2,
      ordinal: 3, prompt_origin: origin })
    const restored = restoreDurableTranscriptOrdinals([checkpoint], [durable])
    const merged = mergeCheckpointAuthorityTranscriptMessages(restored, [durable])

    expect(restored[0].prompt_origin).toBeUndefined()
    expect(restored[0].ordinal).toBeUndefined()
    expect(merged).toHaveLength(2)
    expect(merged.find(message => message.provider_occurrence === 1)?.prompt_origin)
      .toBeUndefined()
    expect(merged.find(message => message.provider_occurrence === 2)?.prompt_origin).toEqual(origin)
  })

  it("does not adopt an invalid durable source stamp", () => {
    const invalid = { kind: "model", name: "forged" } as unknown as Message["prompt_origin"]
    const restored = restoreDurableTranscriptOrdinals(
      [user()], [user(undefined, { ordinal: 3, prompt_origin: invalid })]
    )
    expect(restored[0].ordinal).toBe(3)
    expect(restored[0].prompt_origin).toBeUndefined()
  })

  it("retains ordinary human Goal matching and does not invent a source", () => {
    const checkpoint = user("human")
    const durable = user("human", { ordinal: 3 })
    const restored = restoreDurableTranscriptOrdinals([checkpoint], [durable])
    const merged = mergeCheckpointAuthorityTranscriptMessages(restored, [durable])

    expect(merged).toHaveLength(1)
    expect(merged[0].prompt_origin).toBeUndefined()
    expect(merged[0].ordinal).toBe(3)
    expect(sameGoalCommandMessage(checkpoint, durable)).toBe(true)
  })

  it("does not use a plugin's literal Goal words as a human Goal duplicate", () => {
    const human = user("human")
    const plugin = user("plugin", { ordinal: 4, prompt_origin: origin })
    expect(sameGoalCommandMessage(human, plugin)).toBe(false)
    expect(sameGoalCommandMessage(plugin, human)).toBe(false)

    const checkpoint = [human, user("plugin")]
    const restored = restoreDurableTranscriptOrdinals(checkpoint, [plugin])
    const transcript = buildRestoredCheckpointTranscript(restored, restored, [])
    expect(transcript.map(message => message.id)).toEqual(["human", "plugin"])
    expect(transcript[0].prompt_origin).toBeUndefined()
    expect(transcript[1].prompt_origin).toEqual(origin)
  })
})
