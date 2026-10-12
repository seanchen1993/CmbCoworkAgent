import { afterEach, expect, it, vi } from "vitest"
import {
  acknowledgePendingGroup,
  readPendingGroup,
  rememberPendingGroup,
  inspectPendingGroup,
  discardPendingGroup,
  createPendingGroupStore
} from "./bot-group-pending"
const input = {
  id: "group",
  revision: 2,
  nonce: "update",
  name: "评审",
  description: "质量检查",
  members: ["a", "b"]
}
function storage() {
  const values = new Map<string, string>()
  let readFailure = false,
    writeFailure = false,
    cleanupFailure = false
  const port = {
    getItem: (key: string) => {
      if (readFailure) throw new Error("read denied")
      return values.get(key) ?? null
    },
    setItem: (key: string, value: string) => {
      if (writeFailure) throw new Error("quota")
      values.set(key, value)
    },
    removeItem: (key: string) => {
      if (cleanupFailure) throw new Error("cleanup denied")
      values.delete(key)
    }
  }
  return {
    values,
    port,
    failRead: (value: boolean) => {
      readFailure = value
    },
    failWrite: (value: boolean) => {
      writeFailure = value
    },
    failCleanup: (value: boolean) => {
      cleanupFailure = value
    }
  }
}
afterEach(() => vi.unstubAllGlobals())
it("preserves prior group keys/schema, exact replay, minimum members and other-group boundaries", () => {
  const f = storage()
  vi.stubGlobal("localStorage", f.port)
  rememberPendingGroup(input, "epoch")
  rememberPendingGroup(input, "epoch")
  expect([...f.values.keys()]).toEqual(["bot-group-pending:group"])
  expect(readPendingGroup("group", "epoch")).toEqual(input)
  expect(readPendingGroup("group", "restored")).toBeNull()
  expect(readPendingGroup("other", "epoch")).toBeNull()
  expect(readPendingGroup(undefined, "epoch")).toBeNull()
  const newer = { ...input, nonce: "next", revision: 3 }
  expect(() => rememberPendingGroup(newer, "epoch")).toThrow("尚未确认")
  expect(readPendingGroup("group", "epoch")).toEqual(input)
  expect(acknowledgePendingGroup(input, "epoch")).toBe(true)
  rememberPendingGroup(newer, "epoch")
  expect(acknowledgePendingGroup(input, "epoch")).toBe(false)
  expect(readPendingGroup("group", "epoch")).toEqual(newer)
  expect(acknowledgePendingGroup(newer, "epoch")).toBe(true)
  const single = { ...newer, members: ["a"] }
  rememberPendingGroup(single, "epoch")
  expect(readPendingGroup("group", "epoch")).toEqual(single)
  acknowledgePendingGroup(single, "epoch")
  const creation = {
    nonce: "create",
    name: "协作",
    description: "",
    members: ["a", "b"]
  }
  rememberPendingGroup(creation, "epoch")
  expect(readPendingGroup(undefined, "epoch")).toEqual(creation)
  acknowledgePendingGroup(creation, "epoch")
  expect(f.values.size).toBe(0)
  const singleCreation = { ...creation, members: ["a"] }
  rememberPendingGroup(singleCreation, "epoch")
  expect(readPendingGroup(undefined, "epoch")).toEqual(singleCreation)
  expect(acknowledgePendingGroup(singleCreation, "epoch")).toBe(true)
  expect(() => rememberPendingGroup({ ...creation, members: [] }, "epoch")).toThrow()
  expect(f.values.size).toBe(0)
})
it("does not overwrite a restored unknown request and archives only the reviewed exact value", () => {
  const f = storage(),
    pending = createPendingGroupStore(() => f.port)
  pending.remember(input, "epoch")
  const raw = f.values.get("bot-group-pending:group")!
  expect(pending.inspect("group", "replacement")).toMatchObject({
    kind: "obsolete",
    dataEpoch: "epoch",
    input
  })
  expect(() => pending.remember({ ...input, nonce: "fresh" }, "replacement")).toThrow("恢复前")
  expect(f.values.get("bot-group-pending:group")).toBe(raw)
  expect(pending.discard("group", "replacement", raw + "changed")).toBe(false)
  expect(pending.discard("group", "replacement", raw)).toBe(true)
  pending.remember({ ...input, nonce: "fresh" }, "replacement")
  expect(pending.discard("group", "replacement", raw)).toBe(false)
  expect(pending.read("group", "replacement")?.nonce).toBe("fresh")
})
it("classifies all malformed historical records and retains them until exact reviewed archival", () => {
  const f = storage()
  vi.stubGlobal("localStorage", f.port)
  for (const invalid of [
    { ...input, id: "other" },
    { ...input, revision: undefined },
    { ...input, members: ["a", "a"] },
    { ...input, members: [] },
    { ...input, extra: true }
  ]) {
    const raw = JSON.stringify({ dataEpoch: "epoch", input: invalid })
    f.values.set("bot-group-pending:group", raw)
    expect(inspectPendingGroup("group", "epoch")).toMatchObject({
      kind: "corrupt",
      raw
    })
    expect(readPendingGroup("group", "epoch")).toBeNull()
    expect(() => rememberPendingGroup(input, "epoch")).toThrow("无法核对")
    expect(f.values.get("bot-group-pending:group")).toBe(raw)
    expect(discardPendingGroup("group", "epoch", raw)).toBe(true)
  }
})
it("keeps unreadable storage blocked and prevents dispatch when the pending identity cannot be written", () => {
  const f = storage(),
    pending = createPendingGroupStore(() => f.port)
  f.failRead(true)
  expect(pending.inspect("group", "epoch").kind).toBe("unreadable")
  expect(() => pending.remember(input, "epoch")).toThrow("无法核对")
  expect(f.values.size).toBe(0)
  f.failRead(false)
  f.failWrite(true)
  expect(() => pending.remember(input, "epoch")).toThrow("尚未提交")
  expect(f.values.size).toBe(0)
})
it("requires the entire exact input for acknowledgement and retains a known ACK on cleanup failure", () => {
  const f = storage(),
    pending = createPendingGroupStore(() => f.port)
  pending.remember(input, "epoch")
  const raw = f.values.get("bot-group-pending:group")!
  expect(pending.acknowledge({ ...input, name: "different" }, "epoch")).toBe(false)
  expect(pending.acknowledge(input, "restored")).toBe(false)
  f.failCleanup(true)
  expect(pending.acknowledge(input, "epoch")).toBe(false)
  expect(f.values.get("bot-group-pending:group")).toBe(raw)
  f.failCleanup(false)
  expect(pending.acknowledge(input, "epoch")).toBe(true)
  expect(f.values.size).toBe(0)
})
it("keeps the original 32k historical budget and rejects a oversized/corrupt projection conservatively", () => {
  const f = storage(),
    pending = createPendingGroupStore(() => f.port),
    raw = "x".repeat(32_001)
  f.values.set("bot-group-pending:group", raw)
  expect(pending.inspect("group", "epoch")).toMatchObject({
    kind: "corrupt",
    raw
  })
  expect(() => pending.remember(input, "epoch")).toThrow("无法核对")
  expect(f.values.get("bot-group-pending:group")).toBe(raw)
})

it("binds an explicit request generation to its original envelope without rewriting legacy requests", () => {
  const f = storage(),
    pending = createPendingGroupStore(() => f.port)
  pending.remember({ ...input, expectedDataEpoch: "epoch" }, "epoch")
  expect(pending.read("group", "epoch")).toEqual({
    ...input,
    expectedDataEpoch: "epoch"
  })
  pending.acknowledge({ ...input, expectedDataEpoch: "epoch" }, "epoch")
  for (const expectedDataEpoch of ["different", "bad\0epoch"]) {
    const raw = JSON.stringify({
      dataEpoch: "epoch",
      input: { ...input, expectedDataEpoch }
    })
    f.values.set("bot-group-pending:group", raw)
    expect(pending.inspect("group", "epoch")).toMatchObject({
      kind: "corrupt",
      raw
    })
    expect(() => pending.remember(input, "epoch")).toThrow()
    expect(f.values.get("bot-group-pending:group")).toBe(raw)
    pending.discard("group", "epoch", raw)
  }
})
