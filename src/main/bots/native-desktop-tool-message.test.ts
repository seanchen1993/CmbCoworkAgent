import { expect, it, vi } from "vitest"
import { BotDomainError } from "../../shared/bot-types"
import type { BotNativeDesktopFrame } from "../../shared/bot-native-desktop"
import type { BotRuntimeRequest } from "./host"
import type { NativeDesktopBroker } from "./native-desktop-broker"
import { botNativeDesktopTool } from "./native-desktop-tool"

const uuid = "12345678-1234-4123-8123-123456789012"
function fixture(prior?: { status: "succeeded" | "unknown"; result?: string }) {
  const target = {
    backend: "windows-native" as const,
    botId: uuid,
    generation: uuid,
    viewId: uuid,
    controlEpoch: 0,
    control: "bot" as const
  }
  const frame: BotNativeDesktopFrame = {
    ...target,
    frameSeq: 3,
    width: 800,
    height: 600,
    sourceWidth: 1600,
    sourceHeight: 1200,
    title: "Editor",
    captureId: uuid,
    frameVersion: "4",
    inputTicketIssued: true,
    messageGeometryReady: true,
    image: "data:image/jpeg;base64,FRAME_BYTES",
    window: { hwnd: "123", pid: 12, startTicks: "1234", sessionId: 1, desktop: "CMB-bot" },
    capabilities: {
      capture: true,
      semanticInput: true,
      messagePointer: true,
      messageKeyboard: true,
      pointerInput: false,
      keyboardInput: false,
      independentDesktopVerified: false
    }
  }
  const review = {
    context: {
      backend: "windows-native",
      transport: "window-messages",
      effectVerified: false,
      captureId: uuid,
      description: "输入非敏感备注"
    }
  }
  const computer = {
    ensure: vi.fn(async () => target),
    target: vi.fn(() => target),
    frame: vi.fn(async () => frame),
    prepareMessageReview: vi.fn<(target: unknown, submitted: unknown) => Promise<typeof review>>(
      async () => review
    ),
    assertMessageReview: vi.fn(async () => {}),
    actMessage: vi.fn(async () => ({
      delivery: { accepted: true, processed: false, effectVerified: false },
      nextObservation: "screenshot_required"
    })),
    discardMessageReview: vi.fn()
  }
  const approve = vi.fn(
    async (
      _id: string,
      _action: unknown,
      operation: () => Promise<string>,
      before?: () => Promise<void | string>
    ) => {
      const stopped = await before?.()
      return stopped !== undefined ? stopped : operation()
    }
  )
  const request = {
    bot: { id: uuid },
    run: { id: uuid },
    store: { effectResult: vi.fn(() => prior) },
    lease: {},
    signal: new AbortController().signal
  } as unknown as BotRuntimeRequest
  const built = botNativeDesktopTool({
    request,
    computer: computer as unknown as NativeDesktopBroker,
    approve,
    check: () => {}
  })
  return { computer, approve, frame, review, built, request }
}
const args = {
  frameSeq: 3,
  captureId: uuid,
  frameVersion: "4",
  description: "输入非敏感备注",
  text: "Hello"
}
const call = (op: string, raw = args) => ({
  type: "tool_call" as const,
  id: "native-call",
  name: "native_computer",
  args: { op, arguments_json: JSON.stringify(raw) }
})
it("delivers frame tickets and preview pixels through existing multimodal output", async () => {
  const f = fixture()
  const result = await f.built.invoke(call("screenshot"))
  expect(result.content).toMatchObject([
    { type: "text" },
    { type: "image_url", image_url: { url: f.frame.image } }
  ])
  const text = (result.content as { text: string }[])[0].text
  expect(JSON.parse(text)).toMatchObject({
    frameSeq: 3,
    captureId: uuid,
    frameVersion: "4",
    coordinateSpace: "preview",
    width: 800,
    sourceWidth: 1600
  })
  expect(text).not.toContain("FRAME_BYTES")
  expect(f.approve).not.toHaveBeenCalled()
})
it("routes window messages through the same exact one-action approval and effect ID", async () => {
  const f = fixture()
  const result = await f.built.invoke(call("message_keyboard"))
  expect(f.approve).toHaveBeenCalledTimes(1)
  expect(f.approve.mock.calls[0].slice(0, 2)).toEqual([
    `native-computer:${uuid}:native-call`,
    { nativeDesktop: f.review.context }
  ])
  expect(f.computer.prepareMessageReview.mock.calls[0][1]).toMatchObject({
    frameSeq: 3,
    captureId: uuid,
    frameVersion: "4",
    action: { op: "message_keyboard", text: "Hello" }
  })
  expect(f.computer.assertMessageReview).toHaveBeenCalledOnce()
  expect(f.computer.actMessage).toHaveBeenCalledOnce()
  expect((result.content as { text: string }[])[0].text).toContain('"effectVerified":false')
  expect(f.computer.frame).toHaveBeenCalledOnce()
  expect(result.content).toMatchObject([{ type: "text" }, { type: "image_url" }])
  expect(f.computer.discardMessageReview).toHaveBeenCalledOnce()
})
it.each(["message_pointer", "message_keyboard"])(
  "reads a prior unknown receipt before resolving an old frame (%s)",
  async (op) => {
    const f = fixture({ status: "unknown" })
    await expect(f.built.invoke(call(op))).rejects.toThrow("不能自动重复")
    expect(f.computer.ensure).not.toHaveBeenCalled()
    expect(f.approve).not.toHaveBeenCalled()
  }
)
it("returns the existing succeeded delivery receipt without replaying keyboard input", async () => {
  const f = fixture({ status: "succeeded", result: '{"effectVerified":false}' })
  const result = await f.built.invoke(call("message_keyboard"))
  expect(result.content).toBe('{"effectVerified":false}')
  expect(f.computer.ensure).not.toHaveBeenCalled()
})
it("does not dispatch when the physical target changes while its approval is pending", async () => {
  const f = fixture()
  f.computer.assertMessageReview.mockRejectedValue(
    new BotDomainError("native_review_changed", "changed")
  )
  const result = await f.built.invoke(call("message_keyboard"))
  expect(result.content).toContain("本次操作未执行")
  expect(f.computer.actMessage).not.toHaveBeenCalled()
  expect(f.computer.discardMessageReview).toHaveBeenCalledOnce()
})

it("keeps a settled delivery when follow-up screenshot fails and never resubmits it", async () => {
  const f = fixture()
  f.computer.frame.mockRejectedValue(new Error("capture failed"))
  const result = await f.built.invoke(call("message_keyboard"))
  expect(JSON.parse(result.content as string)).toMatchObject({
    deliveryReceipt: { delivery: { effectVerified: false } },
    nextObservation: "screenshot_required",
    observationError: "screenshot_unavailable"
  })
  expect(f.computer.actMessage).toHaveBeenCalledOnce()
  expect(f.approve).toHaveBeenCalledOnce()
})
