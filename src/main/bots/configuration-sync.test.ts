import { afterEach, expect, it, vi } from "vitest"
import { BotConfigurationSync } from "./configuration-sync"
import {
  notifyRuntimeConfigurationChanged,
  subscribeRuntimeConfiguration
} from "../runtime-configuration-events"

const cleanup: BotConfigurationSync[] = []
afterEach(async () => {
  for (const sync of cleanup.splice(0)) await sync.close()
  vi.useRealTimers()
})
function fixture(enabled = true) {
  vi.useFakeTimers()
  const services = {
    enabled: vi.fn(() => enabled),
    sync: vi.fn(async () => {}),
    subscribe: subscribeRuntimeConfiguration,
    failed: vi.fn()
  }
  const bridge = new BotConfigurationSync(services)
  cleanup.push(bridge)
  return { services, bridge }
}

it("refreshes an existing Host configuration at startup and on settings changes without a renderer", async () => {
  const { services, bridge } = fixture()
  await vi.advanceTimersByTimeAsync(100)
  expect(services.sync).toHaveBeenCalledTimes(1)
  for (let index = 0; index < 30; index++) notifyRuntimeConfigurationChanged()
  await vi.advanceTimersByTimeAsync(100)
  expect(services.sync).toHaveBeenCalledTimes(2)
  await bridge.close()
  notifyRuntimeConfigurationChanged()
  await vi.advanceTimersByTimeAsync(1000)
  expect(services.sync).toHaveBeenCalledTimes(2)
})

it("does not copy credentials before Bot has been used, then responds after activation", async () => {
  const { services } = fixture(false)
  await vi.advanceTimersByTimeAsync(100)
  expect(services.sync).not.toHaveBeenCalled()
  services.enabled.mockReturnValue(true)
  notifyRuntimeConfigurationChanged()
  await vi.advanceTimersByTimeAsync(100)
  expect(services.sync).toHaveBeenCalledTimes(1)
})

it("serializes writes and publishes a second change that arrived during a pending write", async () => {
  const { services } = fixture()
  let release!: () => void
  services.sync.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        release = done
      })
  )
  await vi.advanceTimersByTimeAsync(100)
  notifyRuntimeConfigurationChanged()
  await vi.advanceTimersByTimeAsync(1000)
  expect(services.sync).toHaveBeenCalledTimes(1)
  release()
  await vi.advanceTimersByTimeAsync(101)
  expect(services.sync).toHaveBeenCalledTimes(2)
})

it("retries failed writes, emits one credential-free notification per failure period, and stops retrying after close", async () => {
  const { services, bridge } = fixture()
  services.sync
    .mockRejectedValueOnce(new Error("contains-a-secret"))
    .mockRejectedValueOnce(new Error("contains-a-secret"))
  await vi.advanceTimersByTimeAsync(100)
  expect(services.failed).toHaveBeenCalledWith()
  await vi.advanceTimersByTimeAsync(1000)
  expect(services.sync).toHaveBeenCalledTimes(2)
  expect(services.failed).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(2000)
  expect(services.sync).toHaveBeenCalledTimes(3)
  services.sync.mockRejectedValueOnce(new Error("failed again"))
  notifyRuntimeConfigurationChanged()
  await vi.advanceTimersByTimeAsync(100)
  expect(services.failed).toHaveBeenCalledTimes(2)
  await bridge.close()
  await vi.advanceTimersByTimeAsync(60000)
  expect(services.sync).toHaveBeenCalledTimes(4)
})
