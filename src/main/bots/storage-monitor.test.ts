import { expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BotStorageMonitor } from "./storage-monitor"
import {
  GIB,
  classifyDiskPressure,
  readDiskVolumeSnapshots,
  type DiskVolumeSample
} from "./upstream/grok-disk-pressure"
import { BotStore } from "./store"
import { BotHost } from "./host"
import { createBotAPI } from "./rpc"

const volume = (available: number, deviceId = "fixture-device", total = 100) => ({
  volume: "Bot 数据所在磁盘",
  deviceId,
  availableBytes: available * GIB,
  totalBytes: total * GIB
})
it("retains Grok's absolute/relative pressure thresholds and recovery hysteresis", () => {
  expect(classifyDiskPressure(volume(15))).toBe("soft")
  expect(classifyDiskPressure(volume(5))).toBe("hard")
  expect(classifyDiskPressure(volume(9), "hard")).toBe("soft")
  expect(classifyDiskPressure(volume(8), "hard")).toBe("hard")
  expect(classifyDiskPressure(volume(20), "soft")).toBe("soft")
  expect(classifyDiskPressure(volume(21), "soft")).toBe("healthy")
  expect(classifyDiskPressure(volume(1, "small", 4))).toBe("hard")
  expect(classifyDiskPressure(volume(7, "small", 20))).toBe("soft")
})

it("keeps previous pressure on partial/failed samples and removes old volumes only after a complete sample", async () => {
  let next: DiskVolumeSample = { complete: true, snapshots: [volume(2)] },
    now = 1
  const monitor = new BotStorageMonitor(
    () => [],
    async () => next,
    () => now++
  )
  expect(monitor.view()).toMatchObject({ level: "unknown", checkedAt: null })
  await monitor.sample()
  expect(monitor.view()).toMatchObject({ level: "hard", complete: true })
  next = { complete: false, snapshots: [volume(50, "other")] }
  await monitor.sample()
  expect(monitor.view()).toMatchObject({ level: "hard", complete: false })
  expect(monitor.view().volumes).toHaveLength(2)
  next = { complete: true, snapshots: [{ ...volume(50), totalBytes: NaN }] }
  await monitor.sample()
  expect(monitor.view()).toMatchObject({ level: "hard", complete: false })
  next = { complete: true, snapshots: [volume(50, "other")] }
  await monitor.sample()
  expect(monitor.view()).toMatchObject({ level: "healthy", complete: true })
  expect(monitor.view().volumes).toHaveLength(1)
  monitor.close()
})

it("does not report healthy when volumes cannot be read or statistics are invalid", async () => {
  let fail = true
  const monitor = new BotStorageMonitor(
    () => [],
    async () => {
      if (fail) throw new Error("offline mount")
      return { complete: true, snapshots: [{ ...volume(10), availableBytes: -1 }, volume(101)] }
    }
  )
  await monitor.sample()
  expect(monitor.view()).toMatchObject({ level: "unknown", complete: false, volumes: [] })
  fail = false
  await monitor.sample()
  expect(monitor.view()).toMatchObject({ level: "unknown", complete: false, volumes: [] })
  monitor.close()
})

it("coalesces concurrent polling and ignores a filesystem reply after shutdown", async () => {
  let calls = 0,
    complete!: (value: DiskVolumeSample) => void
  const monitor = new BotStorageMonitor(
    () => [],
    () => {
      calls++
      return new Promise((resolve) => {
        complete = resolve
      })
    }
  )
  const first = monitor.sample(),
    second = monitor.sample()
  expect(first).toBe(second)
  await Promise.resolve()
  expect(calls).toBe(1)
  monitor.close()
  complete({ complete: true, snapshots: [volume(1)] })
  await first
  await monitor.sample()
  expect(monitor.view()).toMatchObject({ checkedAt: null, volumes: [] })
  expect(calls).toBe(1)
})

it("samples the actual native filesystem, deduplicates volumes and projects no file paths or device identities through Host status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cmb-disk-monitor-"))
  const store = new BotStore(join(directory, "bots.sqlite")),
    host = new BotHost(store)
  host.storage = new BotStorageMonitor(() => [
    { volume: "Bot 数据所在磁盘", path: directory },
    { volume: "同盘项目", path: directory }
  ])
  try {
    const actual = await readDiskVolumeSnapshots([
      { volume: "data", path: directory },
      { volume: "same", path: directory }
    ])
    expect(actual.complete).toBe(true)
    expect(actual.snapshots).toHaveLength(1)
    await host.storage.sample()
    const status = await createBotAPI(host).status()
    expect(status.storage?.complete).toBe(true)
    expect(status.storage?.volumes).toHaveLength(1)
    expect(status.storage!.volumes[0].totalBytes).toBeGreaterThan(0)
    expect(JSON.stringify(status.storage)).not.toContain(directory)
    expect(JSON.stringify(status.storage)).not.toContain("deviceId")
  } finally {
    host.storage.close()
    store.close()
    await rm(directory, { recursive: true, force: true })
  }
})
