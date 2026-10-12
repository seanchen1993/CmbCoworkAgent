import { expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { Writable } from "node:stream"
import {
  OWNED_SHELL_FRAME_BYTES,
  OwnedShellDecoder,
  OwnedShellWriter,
  ownedShellFrameSchema,
  type OwnedShellFrame
} from "./owned-shell-wire"

function encode(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value)),
    header = Buffer.allocUnsafe(4)
  header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}
it("parses the same legal progress stream independently of Socket chunk boundaries", () => {
  const nonce = randomUUID()
  const frames = Array.from({ length: 65 }, (_, i) => ({
    nonce,
    sequence: i + 1,
    type: "progress",
    value: { output: `step ${i}`, truncated: false }
  }))
  const bytes = Buffer.concat(frames.map(encode))
  expect(bytes.length).toBeLessThan(16 * 1024)
  const decode = (chunks: Buffer[]) => {
    const values: OwnedShellFrame[] = []
    const decoder = new OwnedShellDecoder(OWNED_SHELL_FRAME_BYTES, (value) =>
      values.push(ownedShellFrameSchema.parse(value))
    )
    for (const chunk of chunks) decoder.feed(chunk)
    decoder.end()
    return values
  }
  // These are real valid typed frames and the exact same bytes. Network
  // segmentation is not part of the authenticated owned-shell protocol.
  expect(decode([bytes])).toEqual(frames)
  expect(decode(Array.from(bytes, (value) => Buffer.from([value])))).toEqual(frames)
  expect(decode(frames.map(encode))).toEqual(frames)
})
it("keeps payload-size and truncated-frame rejection before any received value", () => {
  const receive = vi.fn()
  const oversized = Buffer.alloc(4)
  oversized.writeUInt32BE(OWNED_SHELL_FRAME_BYTES + 1)
  expect(() => new OwnedShellDecoder(OWNED_SHELL_FRAME_BYTES, receive).feed(oversized)).toThrow(
    "exceeds its limit"
  )
  const decoder = new OwnedShellDecoder(OWNED_SHELL_FRAME_BYTES, receive)
  decoder.feed(Buffer.from([0, 0, 0]))
  expect(() => decoder.end()).toThrow("truncated")
  expect(receive).not.toHaveBeenCalled()
})
it("coalesces real Writable backpressure to one pending progress and delivers the final without sequence gaps", () => {
  const writes: Buffer[] = [],
    releases: Array<(error?: Error | null) => void> = []
  const sink = new Writable({
    write(chunk, _encoding, done) {
      writes.push(Buffer.from(chunk))
      releases.push(done)
    }
  })
  const failure = vi.fn(),
    writer = new OwnedShellWriter(sink, OWNED_SHELL_FRAME_BYTES, failure)
  const nonce = randomUUID()
  let sequence = 0
  writer.send(() => ({ type: "accepted", nonce, sequence: ++sequence }))
  for (let i = 0; i < 65; i++) {
    writer.send(
      () => ({
        type: "progress",
        nonce,
        sequence: ++sequence,
        value: { output: `step ${i}`, truncated: false }
      }),
      { replaceable: true }
    )
    expect(writer.retainedFrames()).toBe(2)
  }
  writer.send(
    () => ({
      type: "candidate",
      nonce,
      sequence: ++sequence,
      outcome: { type: "result", value: { output: "done", exitCode: 0, truncated: false } }
    }),
    { discardProgress: true }
  )
  expect(writer.retainedFrames()).toBe(2)
  releases.shift()!()
  expect(writes).toHaveLength(2)
  releases.shift()!()
  expect(writer.retainedFrames()).toBe(0)
  const frames: OwnedShellFrame[] = []
  const decoder = new OwnedShellDecoder(OWNED_SHELL_FRAME_BYTES, (value) =>
    frames.push(ownedShellFrameSchema.parse(value))
  )
  decoder.feed(Buffer.concat(writes))
  decoder.end()
  expect(frames.map((frame) => [frame.type, frame.sequence])).toEqual([
    ["accepted", 1],
    ["candidate", 2]
  ])
  expect(failure).not.toHaveBeenCalled()
  writer.close()
  sink.destroy()
})
