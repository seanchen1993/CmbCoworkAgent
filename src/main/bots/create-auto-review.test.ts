import { afterEach, expect, it, vi } from "vitest"
import { BotStore } from "./store"
import { createAgentParameters } from "./upstream/grok-agent-profiles"

const stores: BotStore[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) store.close()
})
function fixture() {
  const store = new BotStore(":memory:")
  stores.push(store)
  return store
}
it.each([true, false])(
  "commits explicit review=%s with Bot creation before its introduction",
  (enabled) => {
    const store = fixture()
    const input = {
      nonce: "create",
      name: "Reviewer",
      autoReviewEnabled: enabled,
      introduction: { language: "zh-CN" }
    }
    const created = store.createBot(input)
    expect(store.autoReview.read(created.bot.id)).toMatchObject({
      revision: 1,
      isEnabled: enabled,
      allowInstructions: [],
      blockInstructions: []
    })
    const claim = store.claim("host")!
    expect(claim.run.botId).toBe(created.bot.id)
    expect(store.introductionForRun(claim.run.id)).toEqual({ language: "zh-CN" })
    expect(store.autoReview.read(claim.run.botId).isEnabled).toBe(enabled)
    expect(store.createBot(input)).toEqual(created)
    expect(store.autoReview.read(created.bot.id).revision).toBe(1)
    expect(() => store.createBot({ ...input, autoReviewEnabled: !enabled })).toThrow()
  }
)
it("keeps omitted legacy and model-created Bot policies manual, without adding a settings row", () => {
  const store = fixture()
  const input = { nonce: "legacy", name: "Legacy" }
  const created = store.createBot(input)
  expect(store.autoReview.read(created.bot.id)).toMatchObject({ revision: 0, isEnabled: false })
  expect(store.db.exec("SELECT * FROM bot_auto_review_settings")[0]?.values ?? []).toEqual([])
  expect(store.createBot(input)).toEqual(created)
  // The model-facing profile schema does not grant a new way to enable review.
  expect(
    createAgentParameters.parse({ name: "Teammate", description: "Help", autoReviewEnabled: true })
  ).not.toHaveProperty("autoReviewEnabled")
})
it("does not overwrite an existing policy when a lost creation acknowledgement is retried", () => {
  const store = fixture()
  const input = { nonce: "create", name: "Bot", autoReviewEnabled: true }
  const created = store.createBot(input)
  const changed = store.autoReview.change({
    ...store.autoReview.read(created.bot.id),
    isEnabled: false,
    blockInstructions: ["发布前先问我"],
    nonce: "disable"
  })
  expect(store.createBot(input)).toEqual(created)
  expect(store.autoReview.read(created.bot.id)).toEqual(changed)
  const legacy = store.createBot({ nonce: "legacy", name: "Existing" })
  const existingPolicy = store.autoReview.change({
    ...store.autoReview.read(legacy.bot.id),
    isEnabled: true,
    nonce: "explicit-user-change"
  })
  store.createBot({ nonce: "legacy", name: "Existing" })
  expect(store.autoReview.read(legacy.bot.id)).toEqual(existingPolicy)
})
it("rolls back Bot, introduction and receipt if its review settings cannot be initialized", () => {
  const store = fixture()
  const original = store.autoReview.initializeCreatedBot.bind(store.autoReview)
  const spy = vi
    .spyOn(store.autoReview, "initializeCreatedBot")
    .mockImplementation((botId, enabled) => {
      original(botId, enabled)
      throw new Error("commit failure")
    })
  const input = {
    nonce: "create",
    name: "Bot",
    autoReviewEnabled: true,
    introduction: { language: "zh-CN" }
  }
  expect(() => store.createBot(input)).toThrow("commit failure")
  expect(store.snapshot().bots).toHaveLength(0)
  expect(store.db.exec("SELECT * FROM bot_auto_review_settings")[0]?.values ?? []).toEqual([])
  expect(store.claim("host")).toBeNull()
  spy.mockRestore()
  expect(store.autoReview.read(store.createBot(input).bot.id).isEnabled).toBe(true)
})
it("rejects a malformed explicit policy without creating a Bot", () => {
  const store = fixture()
  expect(() =>
    store.createBot({
      nonce: "invalid",
      name: "Bot",
      autoReviewEnabled: "true" as unknown as boolean
    })
  ).toThrow("审核方式")
  expect(store.snapshot().bots).toHaveLength(0)
})
it("applies primary creation choices only to a genuinely new Bot, never an existing primary", () => {
  const store = fixture()
  const input = {
    ...store.primary.read(),
    nonce: "primary",
    profile: { name: "Primary", autoReviewEnabled: false }
  }
  const { revision, dataEpoch, nonce, profile } = input
  const created = store.primary.ensure({ revision, dataEpoch, nonce, profile })
  expect(store.autoReview.read(created.botId!).isEnabled).toBe(false)
  const next = store.primary.read()
  const result = store.primary.ensure({
    revision: next.revision,
    dataEpoch,
    nonce: "already-present",
    profile: { name: "Ignored", autoReviewEnabled: true }
  })
  expect(result.outcome).toBe("hasMainBot")
  expect(store.autoReview.read(created.botId!)).toMatchObject({ revision: 1, isEnabled: false })
})
