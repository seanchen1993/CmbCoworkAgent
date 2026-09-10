import { describe, expect, it, vi } from "vitest"

vi.mock("../db", () => ({
  flushStrict: async () => undefined,
  upsertThreadMessages: () => 1
}))

const { StandardTurnStreamConsumer } = await import("./standard-turn-stream")

/**
 * The IM path drives skill attribution through the stream consumer. These cover
 * the seam itself — that raw chunks reach the recorder before the converter
 * turns them into renderer events, which is where the metadata attribution
 * needs is dropped.
 */
describe("StandardTurnStreamConsumer attribution seam", () => {
  function recordingAttribution(): {
    chunks: Array<[string, unknown]>
    onStreamChunk(mode: string, data: unknown): void
    getFileWritePaths(): string[]
  } {
    return {
      chunks: [],
      onStreamChunk(mode, data) {
        this.chunks.push([mode, data])
      },
      getFileWritePaths() {
        return ["src/from-recorder.ts"]
      }
    }
  }

  async function* stream(chunks: Array<[string, unknown]>): AsyncGenerator<unknown> {
    for (const chunk of chunks) yield chunk
  }

  it("forwards every raw stream chunk to the attribution recorder", async () => {
    const attribution = recordingAttribution()
    const consumer = new StandardTurnStreamConsumer("t1", undefined, undefined, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      attribution: attribution as any
    })

    await consumer.consume(
      stream([
        [
          "values",
          { skillsMetadata: [{ name: "s", path: "/ws/skills/s/SKILL.md" }], messages: [] }
        ],
        ["messages", [{ id: ["AIMessageChunk"], kwargs: { id: "a1", type: "ai" } }]]
      ])
    )

    expect(attribution.chunks.map(([mode]) => mode)).toEqual(["values", "messages"])
    expect(attribution.chunks[0][1]).toMatchObject({ skillsMetadata: [{ name: "s" }] })
  })

  it("exposes the recorder's write paths to the caller", () => {
    const consumer = new StandardTurnStreamConsumer("t1", undefined, undefined, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      attribution: recordingAttribution() as any
    })
    expect(consumer.getFileWritePaths()).toEqual(["src/from-recorder.ts"])
  })

  it("stays inert when the turn records no trace", async () => {
    const consumer = new StandardTurnStreamConsumer("t1")
    await expect(consumer.consume(stream([["values", { messages: [] }]]))).resolves.toBeUndefined()
    expect(consumer.getFileWritePaths()).toEqual([])
  })

  it("aborts mid-stream without swallowing the abort reason", async () => {
    const controller = new AbortController()
    const consumer = new StandardTurnStreamConsumer("t1")
    controller.abort(new Error("stop now"))
    await expect(
      consumer.consume(stream([["values", { messages: [] }]]), controller.signal)
    ).rejects.toThrow("stop now")
  })
})
