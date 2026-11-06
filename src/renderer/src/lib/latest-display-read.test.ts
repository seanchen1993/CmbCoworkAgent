import { expect, it, vi } from "vitest"
import { createLatestDisplayRead } from "./latest-display-read"

const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

it("coalesces bursts and rejects the old reply before issuing one replacement", async () => {
  const first = Promise.withResolvers<string>()
  const read = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue("current")
  const publish = vi.fn()
  const reader = createLatestDisplayRead({ read, publish, failed: vi.fn() })
  for (let i = 0; i < 100; i++) reader.refresh()
  await settle()
  expect(read).toHaveBeenCalledTimes(1)
  for (let i = 0; i < 100; i++) reader.refresh()
  first.resolve("obsolete")
  await settle()
  expect(read).toHaveBeenCalledTimes(2)
  expect(publish.mock.calls).toEqual([["current"]])
  reader.close()
})

it("drops queued reads and pending completions when their surface closes", async () => {
  const pending = Promise.withResolvers<string>()
  const read = vi.fn(() => pending.promise),
    publish = vi.fn(),
    failed = vi.fn()
  const reader = createLatestDisplayRead({ read, publish, failed })
  reader.refresh()
  await settle()
  reader.refresh()
  reader.close()
  pending.resolve("closed")
  await settle()
  expect(read).toHaveBeenCalledTimes(1)
  expect(publish).not.toHaveBeenCalled()
  expect(failed).not.toHaveBeenCalled()
})

it("reports a current failure and can refresh again without a retry loop", async () => {
  const read = vi.fn().mockRejectedValueOnce(Error("unavailable")).mockResolvedValue("ok")
  const publish = vi.fn(),
    failed = vi.fn()
  const reader = createLatestDisplayRead({ read, publish, failed })
  reader.refresh()
  await settle()
  expect(failed).toHaveBeenCalledTimes(1)
  expect(read).toHaveBeenCalledTimes(1)
  reader.refresh()
  await settle()
  expect(publish).toHaveBeenCalledWith("ok")
  reader.close()
})
