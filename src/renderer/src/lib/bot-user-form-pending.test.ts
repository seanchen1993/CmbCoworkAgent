import { expect, it } from "vitest"
import { createBotUserFormPending, reconcileBotUserFormAnswer } from "./bot-user-form-pending"
import { createBotUserFormPrompt, type BotUserForm } from "../../../shared/bot-user-form"
import type { BotInteractionDetail } from "../../../shared/bot-run-history"
const form: BotUserForm = {
  title: "部署信息",
  fields: [{ id: "branch", type: "text", label: "分支", required: true }]
}
const input = {
  id: "original",
  runId: "run",
  conversationId: "room",
  threadRootId: "branch-root",
  revision: 1,
  dataEpoch: "initial",
  answer: '{"status":"submitted","values":{"branch":"main"}}',
  storedAt: 1
}
function fixture() {
  const values = new Map<string, string>()
  const storage = {
    get length() {
      return values.size
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    }
  }
  return { values, storage, pending: createBotUserFormPending(() => storage) }
}
const detail = (
  status: "pending" | "answered" | "expired" | "cancelled",
  answer: string | null = null
): BotInteractionDetail => ({
  interaction: {
    id: input.id,
    kind: "question",
    status,
    answer,
    prompt: createBotUserFormPrompt(form, "initial"),
    revision: status === "answered" ? 2 : 1,
    createdAt: 1,
    expiresAt: 2
  },
  secret: null,
  effects: []
})
it("uses the original protected core to retain exact unknown values and reject replacement or restoration", () => {
  const f = fixture()
  f.pending.remember(input)
  expect(f.pending.inspect(input.id, "initial")).toMatchObject({ kind: "valid", input })
  expect(() =>
    f.pending.remember({ ...input, answer: '{"status":"cancelled","values":{}}' })
  ).toThrow()
  expect(f.pending.inspect(input.id, "restored").kind).toBe("obsolete")
  expect(() => f.pending.remember({ ...input, dataEpoch: "restored" })).toThrow()
  expect(f.pending.acknowledge({ ...input, revision: 2 })).toBe(false)
  expect(f.pending.acknowledge(input)).toBe(true)
  expect(f.values.size).toBe(0)
})
it("explicitly blocks dispatch when local storage cannot save instead of pretending the record is durable", () => {
  const f = fixture()
  f.storage.setItem = () => {
    throw new Error("quota")
  }
  expect(() => f.pending.remember(input)).toThrow("本次尚未提交")
  expect(f.values.size).toBe(0)
  f.storage.getItem = () => {
    throw new Error("blocked")
  }
  expect(f.pending.inspect(input.id, "initial").kind).toBe("unreadable")
  expect(() => f.pending.remember(input)).toThrow("无法核对")
})
it("does not remove unknown records by TTL and bounds new unconfirmed records", async () => {
  const f = fixture()
  for (let index = 0; index < 16; index++) f.pending.remember({ ...input, id: `entry-${index}` })
  expect(() => f.pending.remember({ ...input, id: "entry-17", storedAt: Date.now() })).toThrow(
    "16次"
  )
  let reads = 0
  expect(
    await f.pending.reconcile(
      "initial",
      async (entry) => {
        reads++
        return {
          ...detail("pending"),
          interaction: { ...detail("pending").interaction, id: entry.id }
        }
      },
      () => true
    )
  ).toBe(0)
  expect(reads).toBe(16)
  expect(f.values.size).toBe(16)
})
it("a missing preview or changed answer is not acknowledgement; exact historical success and retirement are readable proof", () => {
  expect(reconcileBotUserFormAnswer(input, detail("pending"))).toBe("pending")
  expect(reconcileBotUserFormAnswer(input, detail("answered", input.answer))).toBe("answered")
  expect(
    reconcileBotUserFormAnswer(input, detail("answered", '{"status":"cancelled","values":{}}'))
  ).toBe("conflict")
  expect(reconcileBotUserFormAnswer(input, detail("expired"))).toBe("retired")
  expect(
    reconcileBotUserFormAnswer(input, {
      ...detail("pending"),
      interaction: { ...detail("pending").interaction, id: "new" }
    })
  ).toBe("conflict")
})
it("readonly reconciliation removes only exact confirmed/retired records, stops on owner change and never sends answers", async () => {
  const f = fixture()
  f.pending.remember(input)
  let live = true
  expect(
    await f.pending.reconcile(
      "initial",
      async () => {
        live = false
        return detail("answered", input.answer)
      },
      () => live
    )
  ).toBe(0)
  expect(f.values.size).toBe(1)
  expect(
    await f.pending.reconcile(
      "initial",
      async () => detail("answered", input.answer),
      () => true
    )
  ).toBe(1)
  expect(f.values.size).toBe(0)
})
it("obsolete records are archived only by explicit reconciliation and corrupt records remain fail-closed", async () => {
  const f = fixture()
  f.pending.remember(input)
  expect(
    await f.pending.reconcile(
      "replacement",
      async () => {
        throw new Error("must not read replacement as original")
      },
      () => true
    )
  ).toBe(1)
  f.values.set("bot-user-form-pending:original", "corrupt")
  expect(
    await f.pending.reconcile(
      "replacement",
      async () => detail("answered", input.answer),
      () => true
    )
  ).toBe(0)
  expect(f.values.size).toBe(1)
})
