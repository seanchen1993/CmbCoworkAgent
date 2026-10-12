import { afterEach, expect, it, vi } from "vitest"
import {
  acknowledgePendingAvatar,
  readPendingAvatar,
  rememberPendingAvatar
} from "./bot-avatar-pending"
import {
  acknowledgePendingWebhook,
  readPendingWebhook,
  rememberPendingWebhook
} from "./bot-webhook-pending"
import {
  acknowledgePendingWorkflowControl,
  readPendingWorkflowControl,
  rememberPendingWorkflowControl
} from "./bot-workflow-pending"

const avatar = { botId: "owner", nonce: "original", revision: 2, pngBase64: "AAAA" }
const webhook = {
  botId: "owner",
  routineId: "routine",
  nonce: "original",
  revision: 2,
  operation: "rotate" as const
}
const workflow = {
  conversationId: "conversation",
  runId: "child",
  threadRootId: "branch",
  nonce: "original",
  revision: 2,
  operation: "message" as const,
  text: "核对原证据"
}
const cases = [
  {
    name: "avatar",
    key: "bot-avatar-pending:owner",
    input: avatar,
    changed: { ...avatar, pngBase64: "BBBB" },
    remember: (input: unknown, epoch: string) =>
      rememberPendingAvatar(input as typeof avatar, epoch),
    read: (epoch: string) => readPendingAvatar("owner", epoch),
    acknowledge: (input: unknown, epoch: string) =>
      acknowledgePendingAvatar(input as typeof avatar, epoch)
  },
  {
    name: "webhook",
    key: "bot-webhook-pending:owner:routine",
    input: webhook,
    changed: { ...webhook, revision: 3 },
    remember: (input: unknown, epoch: string) =>
      rememberPendingWebhook(input as typeof webhook, epoch),
    read: (epoch: string) => readPendingWebhook(webhook, epoch),
    acknowledge: (input: unknown, epoch: string) =>
      acknowledgePendingWebhook(input as typeof webhook, epoch)
  },
  {
    name: "workflow",
    key: 'bot-workflow-pending:["conversation","child","branch"]',
    input: workflow,
    changed: { ...workflow, text: "后来修改的证据" },
    remember: (input: unknown, epoch: string) =>
      rememberPendingWorkflowControl(input as typeof workflow, epoch),
    read: (epoch: string) => readPendingWorkflowControl(workflow, epoch),
    acknowledge: (input: unknown, epoch: string) =>
      acknowledgePendingWorkflowControl(input as typeof workflow, epoch)
  }
]
afterEach(() => vi.unstubAllGlobals())
function fixture() {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, raw: string) => {
      values.set(key, raw)
    },
    removeItem: (key: string) => {
      values.delete(key)
    }
  }
  vi.stubGlobal("localStorage", storage)
  return { values, storage }
}
for (const item of cases) {
  it(`${item.name}: explicit submitted generation must match its outer durable record`, () => {
    const { values } = fixture()
    expect(() => item.remember({ ...item.input, expectedDataEpoch: "other" }, "epoch")).toThrow()
    expect(values.size).toBe(0)
    const input = { ...item.input, expectedDataEpoch: "epoch" }
    item.remember(input, "epoch")
    expect(item.read("epoch")).toEqual(input)
    expect(item.acknowledge(input, "epoch")).toBe(true)
  })
  it(`${item.name}: retains exact unknown and retired requests instead of replacing them`, () => {
    const { values } = fixture()
    item.remember(item.input, "old")
    const raw = values.get(item.key)
    item.remember(item.input, "old")
    expect(() => item.remember(item.changed, "old")).toThrow()
    expect(item.read("new")).toBeNull()
    expect(() => item.remember(item.changed, "new")).toThrow()
    expect(values.get(item.key)).toBe(raw)
  })
  it(`${item.name}: the same nonce with another payload cannot clear newer work`, () => {
    const { values } = fixture()
    item.remember(item.input, "epoch")
    values.set(item.key, JSON.stringify({ dataEpoch: "epoch", input: item.changed }))
    expect(item.acknowledge(item.input, "epoch")).toBe(false)
    expect(item.read("epoch")).toEqual(item.changed)
    expect(item.acknowledge(item.changed, "epoch")).toBe(true)
    expect(values.size).toBe(0)
  })
  it(`${item.name}: preserves corrupt and inaccessible records`, () => {
    const { values, storage } = fixture()
    values.set(item.key, "original damaged record")
    expect(() => item.remember(item.input, "epoch")).toThrow()
    expect(values.get(item.key)).toBe("original damaged record")
    vi.stubGlobal("localStorage", {
      ...storage,
      getItem: () => {
        throw new Error("denied")
      }
    })
    expect(() => item.remember(item.input, "epoch")).toThrow()
    expect(values.get(item.key)).toBe("original damaged record")
  })
  it(`${item.name}: failed cleanup remains pending and cannot authorize a fresh operation`, () => {
    const { values, storage } = fixture()
    item.remember(item.input, "epoch")
    vi.stubGlobal("localStorage", {
      ...storage,
      removeItem: () => {
        throw new Error("denied")
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
