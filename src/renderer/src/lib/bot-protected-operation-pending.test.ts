import { afterEach, expect, it, vi } from "vitest"
import {
  acknowledgePendingRoutine,
  inspectPendingRoutine,
  discardPendingRoutine,
  readPendingRoutine,
  rememberPendingRoutine
} from "./bot-routine-pending"
import {
  acknowledgePendingRoutineRun,
  inspectPendingRoutineRun,
  discardPendingRoutineRun,
  readPendingRoutineRun,
  rememberPendingRoutineRun
} from "./bot-routine-run-pending"
import {
  acknowledgePendingTrial,
  inspectPendingTrial,
  discardPendingTrial,
  readPendingTrial,
  rememberPendingTrial
} from "./bot-skill-trial-pending"
import {
  acknowledgePendingPluginPane,
  inspectPendingPluginPane,
  discardPendingPluginPane,
  readPendingPluginPane,
  rememberPendingPluginPane
} from "./bot-plugin-pane-pending"

const routine = {
  nonce: "original",
  botId: "owner",
  id: "routine",
  revision: 1,
  name: "检查",
  prompt: "原证据",
  enabled: true,
  timezone: "UTC",
  schedule: { kind: "cron" as const, expression: "0 9 * * *" }
}
const run = { nonce: "original", botId: "owner", id: "routine", revision: 1 }
const trial = {
  nonce: "original",
  botId: "owner",
  skillId: "skill",
  version: 1,
  inputs: "原输入",
  criteria: "原证据"
}
const plugin = {
  botId: "owner",
  conversationId: "conversation",
  target: "pane" as const,
  sessionId: "21111111-1111-4111-8111-111111111111",
  action: {
    pane: "review",
    generation: "31111111-1111-4111-8111-111111111111",
    intentId: "original-intent-001",
    plugin: "fixture",
    handle: 1,
    kind: "press" as const
  }
}
const cases = [
  {
    name: "routine save",
    key: "bot-routine-pending:owner:routine",
    input: routine,
    changed: { ...routine, enabled: false },
    remember: (value: unknown, epoch: string) =>
      rememberPendingRoutine(value as typeof routine, epoch),
    read: (epoch: string) => readPendingRoutine("owner", "routine", epoch),
    acknowledge: (value: unknown, epoch: string) =>
      acknowledgePendingRoutine(value as typeof routine, epoch)
  },
  {
    name: "routine run",
    key: "bot-routine-run-pending:owner:routine",
    input: run,
    changed: { ...run, revision: 2 },
    remember: (value: unknown, epoch: string) =>
      rememberPendingRoutineRun(value as typeof run, epoch),
    read: (epoch: string) => readPendingRoutineRun("owner", "routine", epoch),
    acknowledge: (value: unknown, epoch: string) =>
      acknowledgePendingRoutineRun(value as typeof run, epoch)
  },
  {
    name: "skill trial",
    key: "bot-skill-trial-pending:owner:skill",
    input: trial,
    changed: { ...trial, inputs: "新输入" },
    remember: (value: unknown, epoch: string) => rememberPendingTrial(value as typeof trial, epoch),
    read: (epoch: string) => readPendingTrial("owner", "skill", epoch),
    acknowledge: (value: unknown, epoch: string) =>
      acknowledgePendingTrial(value as typeof trial, epoch)
  },
  {
    name: "plugin gesture",
    key: 'bot-plugin-pane-pending:["owner","conversation",null,null]',
    input: plugin,
    changed: { ...plugin, action: { ...plugin.action, handle: 2 } },
    remember: (value: unknown, epoch: string) =>
      rememberPendingPluginPane(value as typeof plugin, epoch),
    read: (epoch: string) => readPendingPluginPane(plugin, epoch),
    acknowledge: (value: unknown, epoch: string) =>
      acknowledgePendingPluginPane(value as typeof plugin, epoch)
  }
]
function fixture() {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    }
  }
  vi.stubGlobal("localStorage", storage)
  return { values, storage }
}
afterEach(() => vi.unstubAllGlobals())
for (const item of cases) {
  it(`${item.name}: preserves unknown and retired requests until exact resolution`, () => {
    const { values } = fixture()
    item.remember(item.input, "original")
    const raw = values.get(item.key)
    expect(raw).toBeTruthy()
    item.remember(item.input, "original")
    expect(() => item.remember(item.changed, "original")).toThrow()
    expect(item.read("restored")).toBeNull()
    expect(() => item.remember(item.changed, "restored")).toThrow()
    expect(values.get(item.key)).toBe(raw)
  })
  it(`${item.name}: old same identity with changed payload cannot acknowledge another operation`, () => {
    const { values } = fixture()
    item.remember(item.input, "epoch")
    values.set(item.key, JSON.stringify({ dataEpoch: "epoch", input: item.changed }))
    expect(item.acknowledge(item.input, "epoch")).toBe(false)
    expect(item.read("epoch")).toEqual(item.changed)
    expect(item.acknowledge(item.changed, "epoch")).toBe(true)
    expect(values.size).toBe(0)
  })
  it(`${item.name}: does not replace a corrupt raw record or treat unreadable storage as empty`, () => {
    const { values, storage } = fixture()
    values.set(item.key, "broken record")
    expect(item.read("epoch")).toBeNull()
    expect(() => item.remember(item.input, "epoch")).toThrow()
    expect(values.get(item.key)).toBe("broken record")
    vi.stubGlobal("localStorage", {
      ...storage,
      getItem: () => {
        throw new Error("denied")
      }
    })
    expect(() => item.remember(item.input, "epoch")).toThrow()
    expect(values.get(item.key)).toBe("broken record")
  })
  it(`${item.name}: failed cleanup remains an exact retry and cannot become a fresh request`, () => {
    const { values, storage } = fixture()
    item.remember(item.input, "epoch")
    vi.stubGlobal("localStorage", {
      ...storage,
      removeItem: () => {
        throw new Error("quota")
      }
    })
    expect(item.acknowledge(item.input, "epoch")).toBe(false)
    expect(item.read("epoch")).toEqual(item.input)
    expect(() => item.remember(item.changed, "epoch")).toThrow()
    expect(values.size).toBe(1)
    vi.stubGlobal("localStorage", storage)
    expect(item.acknowledge(item.input, "epoch")).toBe(true)
  })
}

const recoveryPorts: Record<
  string,
  {
    inspect(epoch: string): { kind: string; raw?: string }
    discard(epoch: string, raw: string): boolean
    max: number
  }
> = {
  "routine save": {
    inspect: (epoch) => inspectPendingRoutine("owner", "routine", epoch),
    discard: (epoch, raw) => discardPendingRoutine("owner", "routine", epoch, raw),
    max: 400_000
  },
  "routine run": {
    inspect: (epoch) => inspectPendingRoutineRun("owner", "routine", epoch),
    discard: (epoch, raw) => discardPendingRoutineRun("owner", "routine", epoch, raw),
    max: 2048
  },
  "skill trial": {
    inspect: (epoch) => inspectPendingTrial("owner", "skill", epoch),
    discard: (epoch, raw) => discardPendingTrial("owner", "skill", epoch, raw),
    max: 120_000
  },
  "plugin gesture": {
    inspect: (epoch) => inspectPendingPluginPane(plugin, epoch),
    discard: (epoch, raw) => discardPendingPluginPane(plugin, epoch, raw),
    max: 220_000
  }
}
for (const item of cases) {
  it(`${item.name}: explicit archive is exact-raw guarded and cannot clear valid new work or inaccessible storage`, () => {
    const { values, storage } = fixture(),
      port = recoveryPorts[item.name]
    item.remember(item.input, "before")
    const raw = values.get(item.key)!
    expect(port.inspect("restored")).toMatchObject({ kind: "obsolete", raw })
    expect(port.discard("restored", "different raw")).toBe(false)
    const next = JSON.stringify({ dataEpoch: "restored", input: item.changed })
    values.set(item.key, next)
    expect(port.discard("restored", raw)).toBe(false)
    expect(port.discard("restored", next)).toBe(false)
    expect(values.get(item.key)).toBe(next)
    values.set(item.key, raw)
    expect(port.discard("restored", raw)).toBe(true)
    const oversized = "x".repeat(port.max + 1)
    values.set(item.key, oversized)
    expect(port.inspect("restored")).toMatchObject({ kind: "corrupt", raw: oversized })
    expect(() => item.remember(item.input, "restored")).toThrow()
    vi.stubGlobal("localStorage", {
      ...storage,
      getItem: () => {
        throw new Error("denied")
      }
    })
    expect(port.inspect("restored").kind).toBe("unreadable")
    expect(port.discard("restored", oversized)).toBe(false)
    expect(values.get(item.key)).toBe(oversized)
    vi.stubGlobal("localStorage", storage)
    expect(port.discard("restored", oversized)).toBe(true)
  })
}
