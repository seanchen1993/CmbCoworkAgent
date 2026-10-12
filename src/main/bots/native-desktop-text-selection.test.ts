import { createHash, randomUUID } from "node:crypto"
import { PassThrough } from "node:stream"
import { afterEach, expect, it, vi } from "vitest"
import {
  BOT_NATIVE_DESKTOP_PROTOCOL,
  botNativeDesktopSemanticAction,
  nativeDesktopRequest,
  nativeDesktopScope,
  type NativeDesktopRequest
} from "../../shared/bot-native-desktop"
import { NativeDesktopBroker } from "./native-desktop-broker"
import {
  NativeDesktopFrameDecoder,
  type NativeDesktopProcessLease
} from "./native-desktop-transport"
import { botNativeDesktopTool } from "./native-desktop-tool"
import type { BotRuntimeRequest } from "./host"
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const dispose of cleanups.splice(0).reverse()) await dispose()
  vi.restoreAllMocks()
})
const framed = (value: unknown) => {
  const data = Buffer.from(JSON.stringify(value)),
    head = Buffer.alloc(4)
  head.writeUInt32BE(data.length)
  return Buffer.concat([head, data])
}
async function fixture() {
  const botId = randomUUID(),
    hostId = randomUUID(),
    dataEpoch = randomUUID(),
    nonce = randomUUID()
  const identity = {
    nonce,
    jobName: `Local\\CMBDevClaw-Bot-${nonce}`,
    bootId: randomUUID(),
    sessionId: 1,
    workerPid: 321,
    desktop: "CodexSandboxDesktop-selection",
    hostId,
    dataEpoch
  }
  const window = {
    hwnd: "122",
    pid: 42,
    startTicks: "638953445671234567",
    sessionId: 1,
    desktop: identity.desktop
  }
  const element = {
    id: randomUUID(),
    name: "备注",
    controlType: "Edit",
    value: "hello 中文",
    password: false,
    enabled: true,
    offscreen: false,
    depth: 0,
    valueTruncated: false,
    supportedActions: ["set_value", "select_all_text", "select"]
  }
  const selection = {
    token: randomUUID(),
    textSha256: createHash("sha256").update(Buffer.from(element.value, "utf16le")).digest("hex"),
    utf16Length: element.value.length
  }
  const stdin = new PassThrough(),
    stdout = new PassThrough(),
    requests: NativeDesktopRequest[] = []
  let selectionReply: unknown = selection,
    invokeMode = "ok",
    reviewCode: string | null = null
  const lease: NativeDesktopProcessLease = {
    identity,
    policy: { readRoots: [], writeRoots: [] },
    stdin,
    stdout,
    exited: new Promise(() => {}),
    assertCurrent() {
      /* This controlled transport fixture has no Windows kernel or credential input. */
    },
    async verifyMember() {
      /* This controlled transport fixture has no Windows kernel or credential input. */
    },
    stop() {
      /* This controlled transport fixture has no Windows kernel or credential input. */
    },
    async awaitKernelClosure() {
      /* This controlled transport fixture has no Windows kernel or credential input. */
    }
  }
  const decoder = new NativeDesktopFrameDecoder((raw) => {
    const r = nativeDesktopRequest.parse(raw)
    requests.push(r)
    let result: unknown = {},
      scope = r.scope,
      status = "ok",
      code: string | null = null
    if (r.operation === "windows")
      result = { windows: [{ window, title: "Editor" }], truncated: false }
    if (r.operation === "observe")
      result = {
        window,
        title: "Editor",
        elements: [{ ...element, value: element.password ? null : element.value }],
        truncated: false
      }
    if (r.operation === "review") {
      result = {
        window,
        title: "Editor",
        element,
        ...(r.params.action === "select_all_text" && selectionReply !== undefined
          ? { textSelection: selectionReply }
          : {})
      }
      if (reviewCode) {
        status = "rejected"
        code = reviewCode
      }
    }
    if (r.operation === "invoke") {
      result = {
        submitted: true,
        applied: true,
        transport: "uia-text-range",
        effectVerified: false
      }
      status = invokeMode
      code = invokeMode === "unknown" ? "native_operation_failed" : null
    }
    if (r.operation === "frame")
      result = {
        window,
        title: "Editor",
        width: 100,
        height: 100,
        sourceWidth: 100,
        sourceHeight: 100,
        image: "data:image/jpeg;base64,AA==",
        captureId: randomUUID(),
        frameVersion: "1",
        inputTicketIssued: true,
        messageGeometryReady: true
      }
    if (r.operation === "revoke" || r.operation === "grant")
      scope = nativeDesktopScope.parse({
        ...scope,
        controlEpoch: r.params.nextControlEpoch,
        control: r.params.nextControl
      })
    if (r.operation === "invalidate")
      scope = nativeDesktopScope.parse({ ...scope, generation: r.params.nextGeneration })
    stdout.write(
      framed({
        type: "result",
        protocol: BOT_NATIVE_DESKTOP_PROTOCOL,
        version: 1,
        id: r.id,
        sequence: r.sequence,
        nonce: r.nonce,
        scope,
        status,
        result,
        code
      })
    )
  }, 64 * 1024)
  stdin.on("data", (chunk) => decoder.feed(chunk))
  const broker = new NativeDesktopBroker({
    hostId,
    dataEpoch: () => dataEpoch,
    assertOperational() {
      /* This controlled transport fixture has no Windows kernel or credential input. */
    },
    assertSupervision() {
      /* This controlled transport fixture has no Windows kernel or credential input. */
    },
    assertOwner() {
      /* This controlled transport fixture has no Windows kernel or credential input. */
    },
    loadHumanHeld: () => false,
    saveHumanHeld() {
      /* This controlled transport fixture has no Windows kernel or credential input. */
    },
    async launch() {
      queueMicrotask(() =>
        stdout.write(
          framed({
            type: "ready",
            protocol: BOT_NATIVE_DESKTOP_PROTOCOL,
            version: 1,
            nonce,
            worker: {
              pid: identity.workerPid,
              startTicks: "1234",
              sessionId: 1,
              desktop: identity.desktop
            },
            capabilities: {
              capture: true,
              semanticInput: true,
              pointerInput: false,
              keyboardInput: false,
              messagePointer: true,
              messageKeyboard: true,
              independentDesktopVerified: false
            }
          })
        )
      )
      return lease
    }
  })
  cleanups.push(() => broker.close())
  let target = await broker.ensure(botId)
  const windows = await broker.windows(target, () => {})
  target = await broker.selectWindow(target, windows[0].viewId, () => {})
  await broker.observe(target, () => {})
  const action = {
    op: "invoke" as const,
    elementId: element.id,
    action: "select_all_text" as const
  }
  return {
    broker,
    target,
    action,
    element,
    selection,
    requests,
    omitRange() {
      selectionReply = undefined
    },
    corruptDigest() {
      selectionReply = { ...selection, textSha256: "a".repeat(64) }
    },
    changeRange() {
      selectionReply = { ...selection, token: randomUUID() }
    },
    rejectReview() {
      reviewCode = "text_selection_review_changed"
    },
    unknown() {
      invokeMode = "unknown"
    }
  }
}
it("keeps SelectionItem select distinct from explicit text selection", () => {
  const id = randomUUID()
  expect(
    botNativeDesktopSemanticAction.parse({ op: "invoke", elementId: id, action: "select" })
  ).toMatchObject({ action: "select" })
  expect(
    botNativeDesktopSemanticAction.parse({ op: "invoke", elementId: id, action: "select_all_text" })
  ).toMatchObject({ action: "select_all_text" })
  expect(() =>
    botNativeDesktopSemanticAction.parse({ op: "invoke", elementId: id, action: "Ctrl+A" })
  ).toThrow()
})
it("binds complete text/range evidence to original semantic approval and dispatch", async () => {
  const f = await fixture(),
    review = await f.broker.prepareReview(f.target, f.action, () => {})
  await f.broker.assertReview(f.target, f.action, review, () => {})
  const result = await f.broker.act(f.target, f.action, () => {}, undefined, review)
  expect(result).toMatchObject({
    submitted: true,
    transport: "uia-text-range",
    effectVerified: false
  })
  expect(
    f.requests
      .filter((r) => r.operation === "review")
      .every((r) => r.params.action === "select_all_text")
  ).toBe(true)
  const invoke = f.requests.find((r) => r.operation === "invoke")!
  expect(invoke.params.expectedTextSelection).toEqual(f.selection)
  expect(invoke.params.expectedElement).toMatchObject({ value: f.element.value, password: false })
  expect(invoke.params).not.toHaveProperty("captureId")
  expect(f.broker.requiresObservation(f.target.botId)).toBe(true)
})
it.each(["omitRange", "corruptDigest"] as const)(
  "rejects unavailable or inconsistent complete text proof (%s)",
  async (kind) => {
    const f = await fixture()
    f[kind]()
    await expect(f.broker.prepareReview(f.target, f.action, () => {})).rejects.toThrow()
    expect(f.requests.some((r) => r.operation === "invoke")).toBe(false)
  }
)
it("range drift after approval refuses the original effect without replay", async () => {
  const f = await fixture(),
    review = await f.broker.prepareReview(f.target, f.action, () => {})
  f.changeRange()
  await expect(f.broker.assertReview(f.target, f.action, review, () => {})).rejects.toMatchObject({
    code: "native_review_changed"
  })
  expect(f.requests.some((r) => r.operation === "invoke")).toBe(false)
})
it("worker range/content rejection before dispatch requires a new review", async () => {
  const f = await fixture(),
    review = await f.broker.prepareReview(f.target, f.action, () => {})
  f.rejectReview()
  await expect(f.broker.assertReview(f.target, f.action, review, () => {})).rejects.toMatchObject({
    code: "native_review_changed"
  })
})
it("retains ordinary SelectionItem select's original payload", async () => {
  const f = await fixture(),
    action = { ...f.action, action: "select" as const }
  const review = await f.broker.prepareReview(f.target, action, () => {})
  await f.broker.act(f.target, action, () => {}, undefined, review)
  const invoke = f.requests.find((r) => r.operation === "invoke")!
  expect(invoke.params.action).toBe("select")
  expect(invoke.params).not.toHaveProperty("expectedTextSelection")
  expect(f.requests.find((r) => r.operation === "review")!.params).not.toHaveProperty("action")
})
it("retires review after unknown submission and requires observation instead of replay", async () => {
  const f = await fixture(),
    review = await f.broker.prepareReview(f.target, f.action, () => {})
  f.unknown()
  await expect(f.broker.act(f.target, f.action, () => {}, undefined, review)).rejects.toThrow()
  await expect(f.broker.act(f.target, f.action, () => {}, undefined, review)).rejects.toThrow()
  expect(f.requests.filter((r) => r.operation === "invoke")).toHaveLength(1)
  expect(f.broker.requiresObservation(f.target.botId)).toBe(true)
})
it("human control remains bound to original frame/client and forwards complete range evidence", async () => {
  const f = await fixture(),
    client = new AbortController().signal
  const target = await f.broker.takeControl(f.target, client)
  await f.broker.observe(target, () => {}, client)
  const frame = await f.broker.frame(target.botId, client)
  await f.broker.humanInput(target, { frameSeq: frame.frameSeq, action: f.action }, client)
  expect(f.requests.find((r) => r.operation === "invoke")!.params.expectedTextSelection).toEqual(
    f.selection
  )
})
it("new text selection returns a fresh image while screenshot failure never resubmits", async () => {
  const f = await fixture(),
    frame = vi.spyOn(f.broker, "frame").mockRejectedValue(new Error("capture unavailable"))
  const request = {
    bot: { id: f.target.botId },
    run: { id: randomUUID() },
    store: { effectResult: () => undefined },
    lease: {},
    signal: new AbortController().signal
  } as unknown as BotRuntimeRequest
  const approve = vi.fn(
    async (
      _id: string,
      _review: unknown,
      operation: () => Promise<string>,
      before?: () => Promise<void | string>
    ) => {
      const stop = await before?.()
      return stop ?? operation()
    }
  )
  const built = botNativeDesktopTool({
    request,
    computer: f.broker,
    check() {
      /* This controlled transport fixture has no Windows kernel or credential input. */
    },
    approve
  })
  const result = await built.invoke({
    type: "tool_call",
    id: "select-text",
    name: "native_computer",
    args: {
      op: "invoke",
      arguments_json: JSON.stringify({ elementId: f.element.id, action: "select_all_text" })
    }
  })
  expect(result.content).toEqual(expect.stringContaining('"screenshot_unavailable"'))
  expect(approve).toHaveBeenCalledOnce()
  expect(frame).toHaveBeenCalledOnce()
  expect(f.requests.filter((r) => r.operation === "invoke")).toHaveLength(1)
})

it("returns the fresh screenshot directly after the settled text-selection effect", async () => {
  const f = await fixture()
  const request = {
    bot: { id: f.target.botId },
    run: { id: randomUUID() },
    store: { effectResult: () => undefined },
    lease: {},
    signal: new AbortController().signal
  } as unknown as BotRuntimeRequest
  const approve = vi.fn(
    async (
      _id: string,
      _review: unknown,
      operation: () => Promise<string>,
      before?: () => Promise<void | string>
    ) => {
      const stop = await before?.()
      return stop ?? operation()
    }
  )
  const built = botNativeDesktopTool({
    request,
    computer: f.broker,
    check() {
      /* Stable controlled run scope. */
    },
    approve
  })
  const result = await built.invoke({
    type: "tool_call",
    id: "select-image",
    name: "native_computer",
    args: {
      op: "invoke",
      arguments_json: JSON.stringify({ elementId: f.element.id, action: "select_all_text" })
    }
  })
  expect(result.content).toMatchObject([{ type: "text" }, { type: "image_url" }])
  const text = (result.content as { text: string }[])[0].text
  expect(text).toContain('"transport":"uia-text-range"')
  expect(text).not.toContain("data:image")
  expect(f.requests.filter((r) => r.operation === "invoke")).toHaveLength(1)
})

it("rejects a protected control before TextPattern review even if a capability was advertised", async () => {
  const f = await fixture()
  f.element.password = true
  await f.broker.observe(f.target, () => {})
  const before = f.requests.length
  await expect(f.broker.prepareReview(f.target, f.action, () => {})).rejects.toMatchObject({
    code: "native_secret_required"
  })
  expect(
    f.requests.slice(before).some((r) => r.operation === "review" || r.operation === "invoke")
  ).toBe(false)
})

it("does not send selected-provider Ctrl+A intent from an old human epoch after handback", async () => {
  const f = await fixture(),
    client = new AbortController().signal
  const held = await f.broker.takeControl(f.target, client)
  await f.broker.observe(held, () => {}, client)
  const frame = await f.broker.frame(held.botId, client)
  await f.broker.releaseControl(held, client)
  const before = f.requests.length
  await expect(
    f.broker.humanInput(held, { frameSeq: frame.frameSeq, action: f.action }, client)
  ).rejects.toThrow()
  expect(
    f.requests
      .slice(before)
      .some((request) => request.operation === "review" || request.operation === "invoke")
  ).toBe(false)
})

it("does not submit selected-provider Ctrl+A after the original human client disconnects", async () => {
  const f = await fixture(),
    controller = new AbortController()
  const held = await f.broker.takeControl(f.target, controller.signal)
  await f.broker.observe(held, () => {}, controller.signal)
  const frame = await f.broker.frame(held.botId, controller.signal)
  const before = f.requests.length
  controller.abort(new Error("original human client disconnected"))
  await expect(
    f.broker.humanInput(held, { frameSeq: frame.frameSeq, action: f.action }, controller.signal)
  ).rejects.toThrow("original human client disconnected")
  expect(
    f.requests
      .slice(before)
      .some((request) => request.operation === "review" || request.operation === "invoke")
  ).toBe(false)
})
