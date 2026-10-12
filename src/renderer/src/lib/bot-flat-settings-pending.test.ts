import { describe, expect, it } from "vitest"
import { createPendingApprovalRuleStore } from "./bot-approval-pending"
import { createPendingAutoReviewStore } from "./bot-auto-review-pending"

const approval = {
  botId: "bot",
  ruleId: "rule",
  revision: 2,
  dataEpoch: "before",
  nonce: "first",
  behavior: "deny" as const
}
const review = {
  botId: "bot",
  revision: 2,
  dataEpoch: "before",
  nonce: "first",
  isEnabled: true,
  allowInstructions: ["run tests"],
  blockInstructions: ["push"]
}
const cases = [
  {
    name: "approval",
    create: createPendingApprovalRuleStore,
    input: approval,
    key: "cmb:bot-approval-rule:pending:bot",
    budget: 4096
  },
  {
    name: "auto review",
    create: createPendingAutoReviewStore,
    input: review,
    key: "cmb:bot-auto-review:pending:bot",
    budget: 256_000
  }
]
for (const config of cases)
  describe(config.name + " legacy flat protected records", () => {
    function fixture() {
      const values = new Map<string, string>()
      const faults = { read: false, write: false, remove: false }
      const storage = {
        getItem: (key: string) => {
          if (faults.read) throw Error("unreadable")
          return values.get(key) ?? null
        },
        setItem: (key: string, raw: string) => {
          if (faults.write) throw Error("quota")
          values.set(key, raw)
        },
        removeItem: (key: string) => {
          if (faults.remove) throw Error("denied")
          values.delete(key)
        }
      }
      // The table's constructors each retain their exact schema; spread inputs are narrowed per owner below.
      const store =
        config.name === "approval"
          ? createPendingApprovalRuleStore(() => storage)
          : createPendingAutoReviewStore(() => storage)
      return { values, faults, store }
    }
    const remember = (store: ReturnType<typeof fixture>["store"], input = config.input) => {
      if (config.name === "approval")
        (store as ReturnType<typeof createPendingApprovalRuleStore>).remember(
          input as typeof approval
        )
      else
        (store as ReturnType<typeof createPendingAutoReviewStore>).remember(input as typeof review)
    }
    const ack = (store: ReturnType<typeof fixture>["store"], input = config.input) =>
      config.name === "approval"
        ? (store as ReturnType<typeof createPendingApprovalRuleStore>).acknowledge(
            input as typeof approval
          )
        : (store as ReturnType<typeof createPendingAutoReviewStore>).acknowledge(
            input as typeof review
          )
    it("preserves exact existing flat bytes, key and foreign workspace recovery", () => {
      const f = fixture(),
        raw = JSON.stringify(config.input)
      f.values.set(config.key, raw)
      expect(f.store.inspect("bot", "before")).toEqual({ kind: "valid", input: config.input, raw })
      expect(f.store.inspect("bot", "after")).toEqual({
        kind: "obsolete",
        dataEpoch: "before",
        input: config.input,
        raw
      })
      expect(() =>
        remember(f.store, { ...config.input, dataEpoch: "after", nonce: "fresh" })
      ).toThrow("恢复前")
      expect(f.values.get(config.key)).toBe(raw)
      expect(f.store.inspect("foreign", "before")).toEqual({ kind: "empty" })
    })
    it("writes legacy flat format and blocks different intent even with the same nonce", () => {
      const f = fixture()
      remember(f.store)
      expect(JSON.parse(f.values.get(config.key)!)).toEqual(config.input)
      remember(f.store)
      expect(() => remember(f.store, { ...config.input, revision: 3 })).toThrow("尚未确认")
      expect(ack(f.store, { ...config.input, revision: 3 })).toBe(false)
      expect(ack(f.store)).toBe(true)
      expect(f.values.size).toBe(0)
    })
    it("requires exact reviewed raw to discard obsolete/corrupt, never removes a replacement", () => {
      const f = fixture()
      f.values.set(config.key, "{")
      expect(f.store.inspect("bot", "before")).toEqual({ kind: "corrupt", raw: "{" })
      expect(() => remember(f.store)).toThrow("无法核对")
      f.values.set(config.key, "different")
      expect(f.store.discard("bot", "before", "{")).toBe(false)
      expect(f.store.discard("bot", "before", "different")).toBe(true)
      f.values.set(config.key, JSON.stringify(config.input))
      expect(f.store.discard("bot", "before", JSON.stringify(config.input))).toBe(false)
      expect(f.store.discard("bot", "after", JSON.stringify(config.input))).toBe(true)
    })
    it("blocks unreadable, over-budget and foreign-key records; failed cleanup retains bytes", () => {
      const f = fixture()
      f.faults.read = true
      expect(f.store.inspect("bot", "before")).toEqual({ kind: "unreadable" })
      expect(() => remember(f.store)).toThrow("无法核对")
      f.faults.read = false
      f.values.set(config.key, " ".repeat(config.budget + 1))
      expect(f.store.inspect("bot", "before").kind).toBe("corrupt")
      f.values.set(config.key, JSON.stringify({ ...config.input, botId: "other" }))
      expect(f.store.inspect("bot", "before").kind).toBe("corrupt")
      f.values.clear()
      remember(f.store)
      f.faults.remove = true
      expect(ack(f.store)).toBe(false)
      expect(f.values.has(config.key)).toBe(true)
    })
  })
