import { Socket } from "node:net"
import { once } from "node:events"
import { afterEach, expect, it, vi } from "vitest"
import { BOT_RPC_MAX_BYTES, decodeBotFrames, encodeBotFrame } from "./rpc"

afterEach(() => vi.restoreAllMocks())

it("copies one-byte fragments only once into a single bounded frame allocation", async () => {
  const value = { id: "fragmented", text: "中".repeat(1024) }
  const frame = encodeBotFrame(value)
  const socket = new Socket()
  const received: unknown[] = []
  const copy = vi.spyOn(Buffer.prototype, "copy")
  const concat = vi.spyOn(Buffer, "concat")
  const allocate = vi.spyOn(Buffer, "allocUnsafe")
  decodeBotFrames(socket, (value) => received.push(value))
  for (let offset = 0; offset < frame.length; offset++)
    socket.emit("data", frame.subarray(offset, offset + 1))
  expect(received).toEqual([value])
  let copied = 0
  for (const result of copy.mock.results)
    if (result.type === "return" && typeof result.value === "number") copied += result.value
  for (const [buffers] of concat.mock.calls) for (const buffer of buffers) copied += buffer.length
  expect(copied).toBeLessThanOrEqual(frame.length + 4)
  expect(allocate.mock.calls.map(([size]) => size).filter((size) => size > 4)).toEqual([
    frame.length - 4
  ])
  socket.destroy()
  await once(socket, "close")
})

it("parses coalesced frames and a fragmented residual header/body exactly once in order", async () => {
  const socket = new Socket(),
    received: unknown[] = []
  const values = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]
  const frames = values.map(encodeBotFrame)
  const initial = Buffer.concat([frames[0]!, frames[1]!, frames[2]!.subarray(0, 2)])
  decodeBotFrames(socket, (value) => received.push(value))
  socket.emit("data", initial)
  expect(received).toEqual(values.slice(0, 2))
  socket.emit("data", frames[2]!.subarray(2, 7))
  expect(received).toEqual(values.slice(0, 2))
  socket.emit("data", Buffer.concat([frames[2]!.subarray(7), frames[3]!]))
  expect(received).toEqual(values)
  socket.destroy()
  await once(socket, "close")
})

it.each([0, 1, BOT_RPC_MAX_BYTES + 1, 0xffffffff])(
  "rejects declared frame size %i before allocating or delivering body",
  async (size) => {
    const socket = new Socket(),
      received = vi.fn(),
      header = Buffer.alloc(4)
    header.writeUInt32BE(size)
    const allocate = vi.spyOn(Buffer, "allocUnsafe")
    decodeBotFrames(socket, received)
    socket.emit("data", header)
    expect(socket.destroyed).toBe(true)
    expect(received).not.toHaveBeenCalled()
    expect(allocate.mock.calls.every(([bytes]) => bytes <= 4)).toBe(true)
    await once(socket, "close")
  }
)

it("releases partial frame and listeners on native close and ignores any late data", async () => {
  const socket = new Socket(),
    received = vi.fn(),
    frame = encodeBotFrame({ text: "x".repeat(128 * 1024) })
  decodeBotFrames(socket, received)
  socket.emit("data", frame.subarray(0, 100))
  socket.destroy()
  await once(socket, "close")
  expect(socket.listenerCount("data")).toBe(0)
  socket.emit("data", frame.subarray(100))
  socket.emit("data", encodeBotFrame({ late: true }))
  expect(received).not.toHaveBeenCalled()
})

it("stops parsing coalesced residual frames immediately when the receiver closes the connection", async () => {
  const socket = new Socket(),
    received: unknown[] = []
  const value = { close: true },
    next = { mustNotRun: true }
  decodeBotFrames(socket, (value) => {
    received.push(value)
    socket.destroy()
  })
  socket.emit("data", Buffer.concat([encodeBotFrame(value), encodeBotFrame(next)]))
  expect(received).toEqual([value])
  await once(socket, "close")
})

it("closes malformed JSON or a throwing receiver and never delivers its trailing frame", async () => {
  for (const throws of [false, true]) {
    const socket = new Socket(),
      received = vi.fn(() => {
        if (throws) throw new Error("Receiver rejected")
      })
    const body = Buffer.from("bad json"),
      header = Buffer.alloc(4)
    header.writeUInt32BE(body.length)
    const first = throws ? encodeBotFrame({ valid: true }) : Buffer.concat([header, body])
    decodeBotFrames(socket, received)
    socket.emit("data", Buffer.concat([first, encodeBotFrame({ trailing: true })]))
    expect(socket.destroyed).toBe(true)
    expect(received).toHaveBeenCalledTimes(throws ? 1 : 0)
    await once(socket, "close")
  }
})
