import { expect, it, vi } from "vitest"
import { createFunctionSiteReadBridge } from "./function-site-read"
const firstNamespace = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const nextNamespace = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

it("issues monotonic IDs in one preload namespace and sends data-only cancellation", async () => {
  const invoke = vi.fn(async () => undefined)
  const sendSync = vi.fn().mockReturnValueOnce(firstNamespace).mockReturnValueOnce(nextNamespace)
  const bridge = createFunctionSiteReadBridge({ invoke, sendSync })
  expect(sendSync).not.toHaveBeenCalled()
  const first = bridge.nextSiteReadId()
  const second = bridge.nextSiteReadId()
  expect(first).toMatch(/^[a-f0-9-]{36}:1$/)
  expect(second).toBe(first.replace(/:1$/, ":2"))
  expect(sendSync).toHaveBeenCalledExactlyOnceWith("mods:function-site-read-scope")
  expect(createFunctionSiteReadBridge({ invoke, sendSync }).nextSiteReadId()).not.toBe(first)
  await bridge.cancelSiteRead(first)
  expect(invoke).toHaveBeenCalledExactlyOnceWith("mods:function-site-read-cancel", {
    readId: first
  })
})

it.each([null, undefined, "renderer-made-up-scope", 42])(
  "rejects unavailable native scope %s",
  (scope) => {
    const sendSync = vi.fn(() => scope),
      invoke = vi.fn(async () => undefined)
    const bridge = createFunctionSiteReadBridge({ invoke, sendSync })
    expect(() => bridge.nextSiteReadId()).toThrow("MODS_DISPLAY_READ_SCOPE_INVALID")
    expect(invoke).not.toHaveBeenCalled()
  }
)

it("preserves legacy read/render payloads without eagerly requesting a scope", async () => {
  const readResult = { state: "inactive" },
    renderResult = null
  const invoke = vi.fn().mockResolvedValueOnce(readResult).mockResolvedValueOnce(renderResult)
  const sendSync = vi.fn(() => firstNamespace)
  const bridge = createFunctionSiteReadBridge({ invoke, sendSync })
  await expect(
    bridge.siteRead(
      "thread",
      "AssistantMessage",
      { text: "protected" },
      "presentation",
      undefined,
      undefined,
      true
    )
  ).resolves.toBe(readResult)
  await expect(bridge.siteRender("thread", "owner", { text: "protected" })).resolves.toBe(
    renderResult
  )
  expect(invoke.mock.calls).toEqual([
    [
      "mods:function-site-read",
      {
        threadId: "thread",
        component: "AssistantMessage",
        props: { text: "protected" },
        presentationId: "presentation",
        messageId: undefined,
        expectedRequestId: undefined,
        ownerRequired: true,
        readId: undefined,
        protocol: "mods.display/v1"
      }
    ],
    [
      "mods:function-site-render",
      { threadId: "thread", owner: "owner", props: { text: "protected" }, readId: undefined }
    ]
  ])
  expect(sendSync).not.toHaveBeenCalled()
})

it("transports the actual native-issued read ID and cancellation without a signal object", async () => {
  const invoke = vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(async () => null)
  const sendSync = vi.fn(() => firstNamespace)
  const bridge = createFunctionSiteReadBridge({ invoke, sendSync })
  const readId = bridge.nextSiteReadId()
  await bridge.siteRead(
    "thread",
    "AssistantMessage",
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    readId
  )
  await bridge.siteRender("thread", "owner", {}, readId)
  await bridge.cancelSiteRead(readId)
  expect(invoke.mock.calls.map(([, input]) => input)).toEqual([
    {
      threadId: "thread",
      component: "AssistantMessage",
      props: {},
      presentationId: undefined,
      messageId: undefined,
      expectedRequestId: undefined,
      ownerRequired: undefined,
      readId,
      protocol: "mods.display/v1"
    },
    { threadId: "thread", owner: "owner", props: {}, readId },
    { readId }
  ])
})
