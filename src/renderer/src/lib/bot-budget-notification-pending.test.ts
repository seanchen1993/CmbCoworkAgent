import { describe, expect, it } from "vitest"
import type { BotUsageBudgetChange } from "../../../shared/bot-usage-budget"
import type { BotNotificationChange } from "../../../shared/bot-notifications"
import type { PendingSaveStorage, ProtectedSaveRecord } from "./bot-protected-save-pending"
import { createPendingBotBudgetStore } from "./bot-budget-pending"
import { createPendingNotificationStore } from "./bot-notification-pending"

interface PendingOwner<T extends { botId: string | null }> {
  inspect(botId: T["botId"], epoch: string): ProtectedSaveRecord<T>
  remember(input: T): void
  acknowledge(input: T): boolean
  discard(botId: T["botId"], epoch: string, raw: string): boolean
}
function describeOwner<T extends { botId: string | null; dataEpoch: string; nonce: string }>(
  name: string,
  input: T,
  create: (storage: () => PendingSaveStorage) => PendingOwner<T>
) {
  describe(name, () => {
    const setup = () => {
      const values = new Map<string, string>(),
        faults = { read: false, remove: false }
      const store = create(() => ({
        getItem(key) {
          if (faults.read) throw Error("unreadable")
          return values.get(key) ?? null
        },
        setItem(key, raw) {
          values.set(key, raw)
        },
        removeItem(key) {
          if (faults.remove) throw Error("denied")
          values.delete(key)
        }
      }))
      return { values, faults, store }
    }
    it("protects retired original and permits only exact reviewed archive", () => {
      const { values, store } = setup()
      store.remember(input)
      const raw = [...values.values()][0]
      expect(JSON.parse(raw)).toEqual(input)
      expect(store.inspect(input.botId, "after").kind).toBe("obsolete")
      expect(() => store.remember({ ...input, dataEpoch: "after", nonce: "new" })).toThrow()
      expect(store.discard(input.botId, "after", raw + " ")).toBe(false)
      expect(store.discard(input.botId, "after", raw)).toBe(true)
    })
    it("preserves corrupt/unreadable records and reports failed exact cleanup", () => {
      const { values, faults, store } = setup()
      store.remember(input)
      const key = [...values.keys()][0],
        raw = values.get(key)!
      faults.remove = true
      expect(store.acknowledge(input)).toBe(false)
      expect(values.get(key)).toBe(raw)
      faults.remove = false
      values.set(key, "{")
      expect(store.inspect(input.botId, "before").kind).toBe("corrupt")
      expect(() => store.remember(input)).toThrow()
      expect(values.get(key)).toBe("{")
      faults.read = true
      expect(store.inspect(input.botId, "before").kind).toBe("unreadable")
      expect(() => store.remember(input)).toThrow()
    })
  })
}
const botId = "03165af2-0d60-4bb4-a960-6fe665cc8e93"
for (const owner of [botId, null])
  describeOwner<BotUsageBudgetChange>(
    owner ? "budget Bot" : "budget user",
    { botId: owner, dataEpoch: "before", revision: 0, nonce: "exact", outputLimit: 100 },
    createPendingBotBudgetStore
  )
describeOwner<BotNotificationChange>(
  "notification",
  { botId, dataEpoch: "before", revision: 0, nonce: "exact", enabled: false },
  createPendingNotificationStore
)
