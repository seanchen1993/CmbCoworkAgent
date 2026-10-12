import { describe, expect, it } from "vitest"
import { createPendingMemoryRetryStore } from "./bot-memory-pending"
import { createPendingBackupScheduleStore } from "./bot-backup-pending"

const nonce = "c5b47e1e-1b9e-4d82-b1a9-1c6b6c4745ce"
const otherNonce = "bc16b0ae-26ac-4bf9-bdcc-dbc27f968f04"
const botId = "03165af2-0d60-4bb4-a960-6fe665cc8e93"
function fixture(kind: "memory" | "backup") {
  const values = new Map<string, string>()
  let unreadable = false,
    removeFails = false
  const storage = {
    getItem(key: string) {
      if (unreadable) throw Error("unreadable")
      return values.get(key) ?? null
    },
    setItem: (key: string, raw: string) => {
      values.set(key, raw)
    },
    removeItem(key: string) {
      if (removeFails) throw Error("denied")
      values.delete(key)
    }
  }
  const memory = createPendingMemoryRetryStore(() => storage),
    backup = createPendingBackupScheduleStore(() => storage),
    input = { botId, revision: 1, dataEpoch: "before", nonce },
    backupInput = { nonce, dataEpoch: "before", revision: 0, enabled: true, intervalHours: 8 },
    key =
      kind === "memory"
        ? `cmb:bot-memory-retry:pending:${botId}`
        : "cmb:bot-backup-schedule:pending",
    store =
      kind === "memory"
        ? {
            remember: (dataEpoch = "before", requestNonce = nonce, revision = 1) =>
              memory.remember({ ...input, dataEpoch, nonce: requestNonce, revision }),
            inspect: (epoch: string) => memory.inspect(botId, epoch),
            acknowledge: (revision = 1) => memory.acknowledge({ ...input, revision }),
            discard: (epoch: string, raw: string) => memory.discard(botId, epoch, raw),
            raw: JSON.stringify(input)
          }
        : {
            remember: (dataEpoch = "before", requestNonce = nonce, revision = 0) =>
              backup.remember({ ...backupInput, dataEpoch, nonce: requestNonce, revision }),
            inspect: (epoch: string) => backup.inspect(epoch),
            acknowledge: (revision = 0) => backup.acknowledge({ ...backupInput, revision }),
            discard: (epoch: string, raw: string) => backup.discard(epoch, raw),
            raw: JSON.stringify(backupInput)
          }
  return {
    values,
    key,
    store,
    unreadable: () => {
      unreadable = true
    },
    removeFails: (enabled: boolean) => {
      removeFails = enabled
    }
  }
}
for (const kind of ["memory", "backup"] as const)
  describe(`${kind} actual legacy-flat pending ownership`, () => {
    it("keeps the original flat encoding and permits only exact idempotent remember", () => {
      const f = fixture(kind)
      f.store.remember()
      expect(f.values.get(f.key)).toBe(f.store.raw)
      f.store.remember()
      expect(() => f.store.remember("before", otherNonce)).toThrow("尚未确认")
      expect(f.values.get(f.key)).toBe(f.store.raw)
    })
    it("preserves a retired request instead of silently replacing it after restore", () => {
      const f = fixture(kind)
      f.store.remember()
      expect(f.store.inspect("after").kind).toBe("obsolete")
      expect(() => f.store.remember("after", otherNonce)).toThrow("恢复前")
      expect(f.values.get(f.key)).toBe(f.store.raw)
    })
    it("blocks corrupt/unreadable storage and archives only the reviewed raw bytes", () => {
      const f = fixture(kind)
      f.values.set(f.key, "{")
      expect(() => f.store.remember()).toThrow("无法核对")
      expect(f.store.discard("before", "wrong")).toBe(false)
      expect(f.store.discard("before", "{")).toBe(true)
      f.unreadable()
      expect(f.store.inspect("before")).toEqual({ kind: "unreadable" })
      expect(() => f.store.remember()).toThrow("无法核对")
    })
    it("requires exact whole intent for ACK instead of nonce-only cleanup", () => {
      const f = fixture(kind)
      f.store.remember()
      expect(f.store.acknowledge(99)).toBe(false)
      expect(f.values.get(f.key)).toBe(f.store.raw)
      expect(f.store.acknowledge()).toBe(true)
      expect(f.values.has(f.key)).toBe(false)
    })
    it("reports failed cleanup without permitting a new intent and permits local-only retry", () => {
      const f = fixture(kind)
      f.store.remember()
      f.removeFails(true)
      expect(f.store.acknowledge()).toBe(false)
      expect(() => f.store.remember("before", otherNonce)).toThrow("尚未确认")
      f.removeFails(false)
      expect(f.store.acknowledge()).toBe(true)
      expect(f.values.has(f.key)).toBe(false)
    })
    it("reads a validated envelope without rewriting legacy bytes and rejects epoch disagreement", () => {
      const f = fixture(kind),
        input = JSON.parse(f.store.raw),
        raw = JSON.stringify({ input, dataEpoch: "before" })
      f.values.set(f.key, raw)
      expect(f.store.inspect("before").kind).toBe("valid")
      expect(f.values.get(f.key)).toBe(raw)
      f.values.set(f.key, JSON.stringify({ input, dataEpoch: "other" }))
      expect(f.store.inspect("before").kind).toBe("corrupt")
    })
    it("keeps the original per-domain byte cap and never archives a changed raw record", () => {
      const f = fixture(kind),
        raw = "x".repeat(kind === "memory" ? 2049 : 4097)
      f.values.set(f.key, raw)
      expect(f.store.inspect("before").kind).toBe("corrupt")
      f.values.set(f.key, "changed")
      expect(f.store.discard("before", raw)).toBe(false)
      expect(f.values.get(f.key)).toBe("changed")
    })
  })
