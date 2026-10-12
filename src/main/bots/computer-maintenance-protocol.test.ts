import { expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { ComputerMaintenanceFrames } from "./computer-maintenance-protocol"
import { ComputerCheckpointOutput } from "./computer-checkpoint-output"
import { BOT_COMPUTER_MAINTENANCE_FRAME_BYTES } from "../../shared/bot-computer-maintenance-progress"
import { Writable } from "node:stream"

const progress = {
  format: 1,
  owner: {
    pid: 100,
    hostTokenSha256: "a".repeat(64),
    root: { dev: "1", ino: "2" },
    lock: { dev: "1", ino: "3" }
  },
  nonce: randomUUID(),
  operation: "restore",
  phase: "prepare",
  component: "shared",
  activity: "file-io",
  startedAt: 1,
  updatedAt: 1,
  sequence: 1,
  entries: 0,
  bytes: 0
}
it("streams many progress frames while retaining only the current partial line", () => {
  let received = 0
  const frames = new ComputerMaintenanceFrames(() => received++)
  const line = Buffer.from(JSON.stringify({ type: "progress", value: progress }) + "\n")
  for (let index = 0; index < 1000; index++) {
    frames.push(line.subarray(0, 17))
    frames.push(line.subarray(17))
  }
  frames.push(
    Buffer.from(JSON.stringify({ type: "result", ok: true, result: { action: "restore" } }) + "\n")
  )
  expect(received).toBe(1000)
  expect(frames.finish()).toEqual({ type: "result", ok: true, result: { action: "restore" } })
})
it("refuses truncated, oversized, repeated or late terminal frames", () => {
  const incomplete = new ComputerMaintenanceFrames(() => {})
  incomplete.push(Buffer.from('{"type":"result"'))
  expect(() => incomplete.finish()).toThrow("未确认完成")
  const oversized = new ComputerMaintenanceFrames(() => {})
  expect(() => oversized.push(Buffer.alloc(BOT_COMPUTER_MAINTENANCE_FRAME_BYTES + 1, 32))).toThrow(
    "长度上限"
  )
  const complete = new ComputerMaintenanceFrames(() => {})
  const line = Buffer.from(
    JSON.stringify({ type: "result", ok: true, result: { action: "delete" } }) + "\n"
  )
  complete.push(line)
  expect(() => complete.push(line)).toThrow("迟到")
})
it("preserves an explicit failed terminal frame without claiming a completed operation", () => {
  const frames = new ComputerMaintenanceFrames(() => {})
  const terminal = {
    type: "result",
    ok: false,
    error: { code: "computer_checkpoint_incomplete", definitive: false, message: "尚未确认完成" }
  }
  const bytes = Buffer.from(JSON.stringify(terminal) + "\n")
  const split = bytes.indexOf(Buffer.from("尚")) + 1
  frames.push(bytes.subarray(0, split))
  frames.push(bytes.subarray(split))
  expect(frames.finish()).toEqual(terminal)
})

it("accepts the producer's bounded terminal diagnostic with JSON-escaped characters", async () => {
  const frames = new ComputerMaintenanceFrames(() => {})
  const output = new ComputerCheckpointOutput(
    new Writable({
      write(chunk, _encoding, callback) {
        try {
          frames.push(Buffer.from(chunk))
          callback()
        } catch (error) {
          callback(error instanceof Error ? error : new Error("invalid frame"))
        }
      }
    }),
    () => {}
  )
  const terminal = {
    type: "result",
    ok: false,
    error: {
      code: "computer_checkpoint_rejected",
      definitive: true,
      message: "\u0001".repeat(2000)
    }
  }
  expect(Buffer.byteLength(JSON.stringify(terminal))).toBeGreaterThan(8192)
  await output.result(terminal)
  expect(frames.finish()).toEqual(terminal)
})
