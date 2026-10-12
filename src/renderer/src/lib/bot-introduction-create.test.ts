import { expect, it, vi } from "vitest"
import { createPendingBotStore } from "./bot-editor-pending"
import { createBotQuickCreateController, type BotQuickCreateScope } from "./bot-quick-create"
import type { BotCreateInput, CoworkBot } from "../../../shared/bot-types"

function fixture(capability = true) {
  const entries = new Map<string, string>()
  const pending = createPendingBotStore(() => ({
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value)
    },
    removeItem: (key) => {
      entries.delete(key)
    }
  }))
  const defaults = () => ({
    name: "新 Bot",
    instructions: "",
    modelRef: null,
    workspacePath: null,
    connectorIds: [],
    avatarShape: null,
    avatarColor: null
  })
  const scope: BotQuickCreateScope = {
    dataEpoch: "epoch",
    selected: null,
    lease: null,
    capabilities: [
      "scoped-bot-create",
      "mutation-data-epoch-v2",
      ...(capability ? ["bot-introduction-v1"] : [])
    ]
  }
  const create = vi.fn(async (input: BotCreateInput) => ({
    conversationId: "conversation",
    bot: {
      id: "bot",
      name: input.name,
      instructions: "",
      modelRef: null,
      workspacePath: null,
      revision: 1,
      hidden: false,
      pinned: false,
      deletedAt: null,
      createdAt: 1,
      updatedAt: 1
    } satisfies CoworkBot
  }))
  const controller = createBotQuickCreateController({
    scope: () => scope,
    defaults,
    create,
    refresh: async () => {},
    select: () => {},
    pending,
    nonce: () => "fresh"
  })
  return { defaults, pending, create, controller }
}

it("only a fresh explicit empty human creation opts into the supported introduction", async () => {
  const fresh = fixture()
  await fresh.controller.start()
  expect(fresh.create.mock.calls[0]![0].introduction).toEqual({ language: "zh-CN" })
  const oldHost = fixture(false)
  await oldHost.controller.start()
  expect(oldHost.create.mock.calls[0]![0]).not.toHaveProperty("introduction")
  const drafted = fixture()
  await drafted.controller.start({
    openNonce: "selection",
    sourceRevision: "draft",
    current: () => true,
    adopt: () => true,
    ready: () => true
  })
  expect(drafted.create.mock.calls[0]![0]).not.toHaveProperty("introduction")
})

it("requests welcome for an explicitly empty new-chat continuation while retaining draft adoption", async () => {
  const f = fixture()
  const adopt = vi.fn(() => true)
  const ready = vi.fn(() => true)
  await f.controller.start({
    openNonce: "empty-selection",
    sourceRevision: "empty-draft",
    requestIntroduction: true,
    current: () => true,
    adopt,
    ready
  })
  expect(f.create.mock.calls[0]![0].introduction).toEqual({ language: "zh-CN" })
  expect(adopt).toHaveBeenCalledTimes(1)
  expect(ready).toHaveBeenCalledTimes(1)

  const drafted = fixture()
  await drafted.controller.start({
    openNonce: "work-selection",
    sourceRevision: "work-draft",
    requestIntroduction: false,
    current: () => true,
    adopt: () => true,
    ready: () => true
  })
  expect(drafted.create.mock.calls[0]![0]).not.toHaveProperty("introduction")

  const oldHost = fixture(false)
  await oldHost.controller.start({
    openNonce: "empty-selection",
    sourceRevision: "empty-draft",
    requestIntroduction: true,
    current: () => true,
    adopt: () => true,
    ready: () => true
  })
  expect(oldHost.create.mock.calls[0]![0]).not.toHaveProperty("introduction")
})

it("does not retrofit introduction into an old unknown nonce or silently downgrade an introduction pending against an old Host", async () => {
  const legacy = fixture()
  const input = { ...legacy.defaults(), nonce: "old-pending", expectedDataEpoch: "epoch" }
  legacy.pending.remember(input, "epoch")
  await legacy.controller.start({
    openNonce: "new-empty-selection",
    sourceRevision: "new-empty-draft",
    requestIntroduction: true,
    current: () => true,
    adopt: () => true,
    ready: () => true
  })
  expect(legacy.create).toHaveBeenCalledWith(input)
  expect(legacy.create.mock.calls[0]![0]).not.toHaveProperty("introduction")
  const unsupported = fixture(false)
  const requested = {
    ...unsupported.defaults(),
    nonce: "intro-pending",
    expectedDataEpoch: "epoch",
    introduction: { language: "zh-CN" }
  }
  unsupported.pending.remember(requested, "epoch")
  await unsupported.controller.start()
  expect(unsupported.create).not.toHaveBeenCalled()
  expect(unsupported.pending.read(undefined, "epoch")).toEqual(requested)
})

it("retains the exact introduction language on replay and rejects its accidental presence on profile updates", async () => {
  const f = fixture()
  const input = { ...f.defaults(), nonce: "pending", introduction: { language: "en-US" } }
  f.pending.remember(input, "epoch")
  await f.controller.start()
  expect(f.create).toHaveBeenCalledWith(input)
  expect(() => f.pending.remember({ ...input, id: "bot", revision: 1 }, "epoch")).toThrow()
})
