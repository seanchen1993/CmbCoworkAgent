import { Writable } from "node:stream"
import { expect, it } from "vitest"
import { ComputerCheckpointOutput } from "./computer-checkpoint-output"
it("bounds a paused parent to one written progress frame and the latest pending value", async () => {
  const frames: string[] = [],
    releases: (() => void)[] = [],
    stream = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        frames.push(chunk.toString())
        releases.push(() => callback())
      }
    }),
    output = new ComputerCheckpointOutput(stream, (error) => {
      throw error
    })
  for (let sequence = 0; sequence < 10_000; sequence++) output.progress({ sequence })
  expect(frames).toHaveLength(1)
  expect(stream.writableLength).toBeLessThan(100)
  releases.shift()!()
  expect(frames).toHaveLength(2)
  expect(JSON.parse(frames[1]).value.sequence).toBe(9999)
  const finished = output.result({ type: "result", ok: true, result: { action: "delete" } })
  releases.shift()!()
  await new Promise((resolve) => setImmediate(resolve))
  expect(frames).toHaveLength(3)
  releases.shift()!()
  await finished
  expect(JSON.parse(frames[2])).toMatchObject({ type: "result", ok: true })
})
it("aborts the owner on a broken stdout transport and never queues further progress", async () => {
  const error = new Error("closed parent"),
    failures: Error[] = [],
    stream = new Writable({
      write(_chunk, _encoding, callback) {
        callback(error)
      }
    }),
    output = new ComputerCheckpointOutput(stream, (error) => failures.push(error))
  output.progress({ sequence: 1 })
  await new Promise((resolve) => setImmediate(resolve))
  for (let i = 0; i < 1000; i++) output.progress({ sequence: i })
  expect(failures).toEqual([error])
  await expect(output.result({ type: "result" })).rejects.toBe(error)
})
