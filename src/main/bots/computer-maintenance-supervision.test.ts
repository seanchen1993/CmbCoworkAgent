import { expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import type { BotComputerMaintenanceProgress } from "../../shared/bot-computer-maintenance-progress"
import {
  BOT_COMPUTER_FILE_IDLE_MS,
  BOT_COMPUTER_NATIVE_PHASE_MS
} from "../../shared/bot-computer-maintenance-progress"
import { ComputerMaintenanceSupervision } from "./computer-maintenance-supervision"

const wall = 1_000_000
const value = (): BotComputerMaintenanceProgress => ({
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
  startedAt: wall,
  updatedAt: wall,
  sequence: 1,
  entries: 0,
  bytes: 0
})

it("does not treat repeated live heartbeats as file progress", () => {
  let now = 0
  const guard = new ComputerMaintenanceSupervision(() => now)
  const progress = value()
  expect(guard.accept(progress, wall)).toBe(true)
  now = BOT_COMPUTER_FILE_IDLE_MS
  expect(guard.accept({ ...progress, sequence: 2, updatedAt: wall + now }, wall + now)).toBe(true)
  expect(guard.alive(wall + now)).toBe(false)
})

it("extends active file I/O only for actual counters and rejects owner/nonce replays", () => {
  let now = 0
  const guard = new ComputerMaintenanceSupervision(() => now)
  const progress = value()
  guard.accept(progress, wall)
  now = BOT_COMPUTER_FILE_IDLE_MS - 1
  const moved = { ...progress, sequence: 2, bytes: 4096, updatedAt: wall + now }
  expect(guard.accept(moved, wall + now)).toBe(true)
  expect(guard.accept(moved, wall + now)).toBe(false)
  expect(guard.accept({ ...moved, sequence: 3, nonce: randomUUID() }, wall + now)).toBe(false)
  expect(
    guard.accept({ ...moved, sequence: 3, owner: { ...moved.owner, pid: 101 } }, wall + now)
  ).toBe(false)
  now += 1
  expect(guard.alive(wall + now)).toBe(true)
})

it("keeps repeated large-file verification alive through real work without overflowing public counters", () => {
  let now = 0
  const guard = new ComputerMaintenanceSupervision(() => now)
  const progress = { ...value(), entries: 50_000, bytes: 20 * 1024 ** 3, workSequence: 0 }
  guard.accept(progress, wall)
  for (let index = 1; index <= 4; index++) {
    now += BOT_COMPUTER_FILE_IDLE_MS - 1
    const moved = { ...progress, sequence: index + 1, workSequence: index, updatedAt: wall + now }
    expect(guard.accept(moved, wall + now)).toBe(true)
    expect(guard.alive(wall + now)).toBe(true)
    expect(
      guard.accept({ ...moved, sequence: moved.sequence + 1, workSequence: index - 1 }, wall + now)
    ).toBe(false)
  }
  now += BOT_COMPUTER_FILE_IDLE_MS
  guard.accept({ ...progress, sequence: 6, workSequence: 4, updatedAt: wall + now }, wall + now)
  expect(guard.alive(wall + now)).toBe(false)
})

it("bounds a live native phase independently of its heartbeats", () => {
  let now = 0
  const guard = new ComputerMaintenanceSupervision(() => now)
  const progress = { ...value(), activity: "native-sqlite" as const }
  guard.accept(progress, wall)
  now = BOT_COMPUTER_NATIVE_PHASE_MS
  expect(guard.accept({ ...progress, updatedAt: wall + now, sequence: 2 }, wall + now)).toBe(true)
  expect(guard.alive(wall + now)).toBe(false)
})

it("rejects stale/future progress and expires a disappeared owner", () => {
  const guard = new ComputerMaintenanceSupervision(() => 0)
  const progress = value()
  expect(guard.accept(progress, wall + 10_001)).toBe(false)
  expect(guard.accept(progress, wall - 1001)).toBe(false)
  expect(guard.accept(progress, wall)).toBe(true)
  expect(guard.alive(wall + 10_001)).toBe(false)
})
