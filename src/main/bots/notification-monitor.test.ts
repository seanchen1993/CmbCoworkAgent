import { afterEach, expect, it, vi } from "vitest"
import { BotStore } from "./store"
import { BotNotificationMonitor } from "./notification-monitor"

const stores: BotStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
function fixture() {
  const store = new BotStore(":memory:", () => 10000)
  stores.push(store)
  const { conversationId } = store.createBot({ nonce: "owner", name: "Owner" })
  const reader = {
    snapshot: vi.fn(async () => store.snapshot()),
    events: vi.fn(async (after: number) => store.events(after, 2))
  }
  const ports = {
    connect: vi.fn(async () => reader),
    focused: () => false,
    now: () => 10000,
    frame: vi.fn(),
    show: vi.fn(),
    unavailable: vi.fn()
  }
  const monitor = new BotNotificationMonitor(ports)
  const finish = () => {
    store.send({ nonce: crypto.randomUUID(), conversationId, text: "Task" })
    const task = store.claim("host")!
    store.finish(task.lease, "succeeded", "Done")
  }
  return { store, reader, ports, monitor, finish }
}
it("seeds history silently, catches completions over pages and resumes after a lost connection", async () => {
  const f = fixture()
  f.finish()
  await f.monitor.poll()
  expect(f.ports.show).not.toHaveBeenCalled()
  f.reader.snapshot.mockRejectedValueOnce(new Error("offline"))
  await f.monitor.poll()
  expect(f.ports.unavailable).toHaveBeenCalledOnce()
  f.finish()
  await f.monitor.poll()
  await f.monitor.poll()
  expect(f.ports.show).toHaveBeenCalledOnce()
  expect(f.ports.connect).toHaveBeenCalledTimes(2)
  expect(f.reader.events).toHaveBeenCalled()
})
it("coalesces pending reads and rejects late callbacks after desktop shutdown", async () => {
  const f = fixture()
  let release!: (value: ReturnType<BotStore["snapshot"]>) => void
  f.reader.snapshot.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  const first = f.monitor.poll()
  expect(f.monitor.poll()).toBe(first)
  await Promise.resolve()
  f.monitor.stop()
  release(f.store.snapshot())
  await first
  expect(f.ports.frame).not.toHaveBeenCalled()
  expect(f.ports.show).not.toHaveBeenCalled()
  await f.monitor.poll()
  expect(f.reader.snapshot).toHaveBeenCalledOnce()
})
it("resets on restore or missing events instead of replaying historical results", async () => {
  const f = fixture()
  await f.monitor.poll()
  f.finish()
  f.reader.events.mockResolvedValueOnce([])
  await f.monitor.poll()
  await f.monitor.poll()
  expect(f.ports.show).not.toHaveBeenCalled()
  f.finish()
  f.store.db.run(
    "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('workspace.restored','restored','{}',10000)"
  )
  await f.monitor.poll()
  expect(f.ports.show).not.toHaveBeenCalled()
})
