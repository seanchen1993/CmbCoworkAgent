import { afterEach, expect, it, vi } from "vitest"
import {
  acknowledgePendingBot,
  readPendingBot,
  rememberPendingBot,
  inspectPendingBot,
  discardPendingBotRecord,
  createPendingBotStore,
  type PendingBotSave
} from "./bot-editor-pending"

const input: PendingBotSave = {
  nonce: "create",
  name: "研发助手",
  instructions: "整理需求",
  modelRef: null,
  workspacePath: null,
  connectorIds: ["internal/docs"],
  avatarShape: "cloud",
  avatarColor: "violet"
}
afterEach(() => vi.unstubAllGlobals())
it("recovers exactly the pending profile, scoped to its Bot and database, without removing a newer save", () => {
  const items = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
    removeItem: (key: string) => items.delete(key)
  })
  rememberPendingBot(input, "epoch")
  expect(readPendingBot(undefined, "epoch")).toEqual(input)
  expect(readPendingBot(undefined, "restored")).toBeNull()
  expect(readPendingBot("bot", "epoch")).toBeNull()
  acknowledgePendingBot(input, "epoch")
  expect(items.size).toBe(0)
  const update = { ...input, nonce: "update", id: "bot", revision: 2 }
  rememberPendingBot(update, "epoch")
  const next = {
    ...update,
    nonce: "next",
    revision: 3,
    instructions: "下一份职责"
  }
  expect(() => rememberPendingBot(next, "epoch")).toThrow("尚未确认")
  // A separate completed writer can replace the record after the old ACK; old callbacks must not clear it.
  items.set([...items.keys()][0], JSON.stringify({ dataEpoch: "epoch", input: next }))
  acknowledgePendingBot(update, "epoch")
  expect(readPendingBot("bot", "epoch")).toEqual(next)
  const key = [...items.keys()][0]
  for (const invalid of [
    { ...next, id: "other" },
    { ...next, revision: undefined },
    { ...next, avatarShape: "invalid" },
    { ...next, connectorIds: ["same", "same"] },
    { ...next, instructions: "x".repeat(32_001) },
    { ...next, instructions: "\0" },
    { ...next, secret: "do not accept extra fields" }
  ]) {
    items.set(key, JSON.stringify({ dataEpoch: "epoch", input: invalid }))
    expect(readPendingBot("bot", "epoch")).toBeNull()
  }
  expect(inspectPendingBot("bot", "epoch").kind).toBe("corrupt")
  expect(() => rememberPendingBot(next, "epoch")).toThrow("无法核对")
  const raw = items.get(key)!
  expect(discardPendingBotRecord("bot", "epoch", raw)).toBe(true)
  rememberPendingBot(next, "epoch")
  acknowledgePendingBot(next, "epoch")
  expect(items.size).toBe(0)
})
it("does not submit a save that cannot retain its recovery identity", () => {
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {
      throw new Error("quota")
    }
  })
  expect(() => rememberPendingBot(input, "epoch")).toThrow("尚未提交")
})

it("preserves a Harness binding and its explicit policy on save retry, rejecting unknown grants", () => {
  const items = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
    removeItem: (key: string) => items.delete(key)
  })
  const bound: PendingBotSave = {
    ...input,
    harnessBinding: {
      projectId: "project",
      featureSlug: "feature",
      instructionWorkspacePaths: ["C:\\repos\\shared"],
      requestUserInputConfig: {
        allowAutoResolution: true,
        autoResolutionType: "select_first",
        defaultTimeoutMs: 30000
      }
    }
  }
  rememberPendingBot(bound, "epoch")
  expect(readPendingBot(undefined, "epoch")).toEqual(bound)
  expect(readPendingBot(undefined, "restored")).toBeNull()
  const key = [...items.keys()][0]
  for (const harnessBinding of [
    { ...bound.harnessBinding, grantAllPlugins: true },
    { ...bound.harnessBinding, projectId: "" },
    {
      ...bound.harnessBinding,
      instructionWorkspacePaths: Array.from({ length: 17 }, (_, index) => `C:\\repos\\${index}`)
    }
  ]) {
    items.set(key, JSON.stringify({ dataEpoch: "epoch", input: { ...bound, harnessBinding } }))
    expect(readPendingBot(undefined, "epoch")).toBeNull()
  }
})

it("keeps exact legacy/new requests, refuses obsolete replay and repairs only the reviewed damaged value", () => {
  const items = new Map<string, string>(),
    storage = {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => items.set(key, value),
      removeItem: (key: string) => items.delete(key)
    }
  const pending = createPendingBotStore(() => storage),
    scoped = { ...input, title: "标签", expectedDataEpoch: "epoch" }
  pending.remember(scoped, "epoch")
  expect(pending.read(undefined, "epoch")).toEqual(scoped)
  expect(pending.inspect(undefined, "new").kind).toBe("obsolete")
  expect(() => pending.remember({ ...input, nonce: "new" }, "new")).toThrow("恢复前")
  const obsolete = pending.inspect(undefined, "new")
  expect(obsolete.kind).toBe("obsolete")
  if (obsolete.kind !== "obsolete") throw new Error("expected old request")
  expect(pending.discard(undefined, "new", obsolete.raw + "x")).toBe(false)
  expect(pending.discard(undefined, "new", obsolete.raw)).toBe(true)
  pending.remember(input, "new")
  expect(pending.read(undefined, "new")).toEqual(input)
  expect(pending.acknowledge({ ...input, instructions: "changed" }, "new")).toBe(false)
  expect(pending.acknowledge(input, "new")).toBe(true)
  storage.setItem("bot-editor-pending:new", "bad")
  const corrupt = pending.inspect(undefined, "new")
  expect(corrupt.kind).toBe("corrupt")
  storage.setItem("bot-editor-pending:new", JSON.stringify({ dataEpoch: "new", input }))
  expect(pending.discard(undefined, "new", "bad")).toBe(false)
  expect(pending.read(undefined, "new")).toEqual(input)
})
it("distinguishes denied storage and keeps known acknowledgements when local cleanup fails", () => {
  let raw: string | null = null
  let fail = false
  const pending = createPendingBotStore(() => ({
    getItem: () => {
      if (fail) throw new Error("denied")
      return raw
    },
    setItem: (_, value) => {
      raw = value
    },
    removeItem: () => {
      throw new Error("denied")
    }
  }))
  pending.remember(input, "epoch")
  expect(pending.acknowledge(input, "epoch")).toBe(false)
  expect(pending.read(undefined, "epoch")).toEqual(input)
  fail = true
  expect(pending.inspect(undefined, "epoch").kind).toBe("unreadable")
  expect(() => pending.remember(input, "epoch")).toThrow("尚未提交")
})

// A valid profile can exceed the previous JSON bound after control characters are escaped.
it("can reread and acknowledge the fully bounded escaped profile it just persisted", () => {
  const items = new Map<string, string>()
  const pending = createPendingBotStore(() => ({
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value)
    },
    removeItem: (key) => {
      items.delete(key)
    }
  }))
  const large: PendingBotSave = {
    ...input,
    instructions: "\u0001".repeat(32_000),
    connectorIds: Array.from({ length: 64 }, (_, index) => `${index}:` + "\u0001".repeat(507)),
    harnessBinding: {
      projectId: "project",
      instructionWorkspacePaths: Array.from(
        { length: 16 },
        (_, index) => `${index}:` + "\\".repeat(4092)
      )
    }
  }
  pending.remember(large, "epoch")
  expect([...items.values()][0].length).toBeGreaterThan(512_000)
  expect(pending.read(undefined, "epoch")).toEqual(large)
  expect(pending.acknowledge(large, "epoch")).toBe(true)
  expect(items.size).toBe(0)
})

it("shares the single-line title contract and protects old invalid records without silently rewriting them", () => {
  const items = new Map<string, string>()
  const storage = createPendingBotStore(() => ({
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value)
    },
    removeItem: (key) => {
      items.delete(key)
    }
  }))
  for (const separator of ["\n", "\r", "\u2028", "\u2029"]) {
    expect(() => storage.remember({ ...input, title: `one${separator}` }, "epoch")).toThrow()
    expect(items.size).toBe(0)
  }
  const raw = JSON.stringify({ dataEpoch: "epoch", input: { ...input, title: "one\ntwo" } })
  items.set("bot-editor-pending:new", raw)
  expect(storage.inspect(undefined, "epoch")).toEqual({ kind: "corrupt", raw })
  expect(() => storage.remember(input, "epoch")).toThrow("无法核对")
  expect(items.get("bot-editor-pending:new")).toBe(raw)
})

it("accepts scoped updates while protecting legacy exact payload and outer epoch", () => {
  const values = new Map<string, string>(),
    pending = createPendingBotStore(() => ({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value)
      },
      removeItem: (key) => {
        values.delete(key)
      }
    }))
  const scoped = {
    ...input,
    id: "bot",
    revision: 1,
    expectedDataEpoch: "epoch"
  }
  pending.remember(scoped, "epoch")
  const raw = values.get("bot-editor-pending:bot")
  expect(pending.read("bot", "epoch")).toEqual(scoped)
  expect(() => pending.remember({ ...scoped, expectedDataEpoch: "other" }, "epoch")).toThrow()
  expect(values.get("bot-editor-pending:bot")).toBe(raw)
  expect(pending.acknowledge(scoped, "epoch")).toBe(true)
  const legacy = { ...input, id: "bot", revision: 1 }
  pending.remember(legacy, "epoch")
  expect(pending.read("bot", "epoch")).toEqual(legacy)
  expect(pending.read("bot", "epoch")).not.toHaveProperty("expectedDataEpoch")
})
