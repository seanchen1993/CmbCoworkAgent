import { expect, it, vi } from "vitest"
import { watchFlowOwner } from "./flow-owner-watch"
import type { FlowActiveSummary } from "../../../shared/mods/flows/types"

const owner: FlowActiveSummary = {
  runId: "run-a",
  threadId: "chat-a",
  flowName: "work",
  status: "running"
}

it("rechecks own scope after another chat releases and automatically clears occupancy", async () => {
  let changed!: () => void
  let occupancy: FlowActiveSummary | null = owner
  let visible: FlowActiveSummary | null = owner
  const stop = vi.fn()
  const read = vi.fn(async () => occupancy)
  const close = watchFlowOwner(
    (callback) => {
      changed = callback
      return stop
    },
    read,
    (value) => {
      visible = value
    }
  )
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  changed()
  await vi.waitFor(() => expect(visible).toBe(owner))
  occupancy = null
  changed()
  await vi.waitFor(() => expect(visible).toBeNull())
  close()
  expect(stop).toHaveBeenCalledOnce()
})

it("coalesces progress events and drops responses after scope cleanup", async () => {
  let changed!: () => void
  let resolve!: (value: FlowActiveSummary | null) => void
  const read = vi.fn(
    () =>
      new Promise<FlowActiveSummary | null>((done) => {
        resolve = done
      })
  )
  const accept = vi.fn()
  const close = watchFlowOwner(
    (callback) => {
      changed = callback
      return () => {}
    },
    read,
    accept
  )
  for (let i = 0; i < 100; i++) changed()
  expect(read).toHaveBeenCalledTimes(1)
  resolve(owner)
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  expect(accept).toHaveBeenCalledExactlyOnceWith(owner)
  close()
  resolve(null)
  changed()
  await Promise.resolve()
  expect(accept).toHaveBeenCalledTimes(1)
  expect(read).toHaveBeenCalledTimes(2)
})

it("does not clear occupancy when the scoped read rejects", async () => {
  const accept = vi.fn()
  const close = watchFlowOwner(
    () => () => {},
    async () => {
      throw Error("scope changed")
    },
    accept
  )
  await Promise.resolve()
  expect(accept).not.toHaveBeenCalled()
  close()
})
