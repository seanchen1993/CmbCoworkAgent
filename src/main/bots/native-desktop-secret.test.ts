import { afterEach, describe, expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { PassThrough } from "node:stream"
import { NativeDesktopBroker } from "./native-desktop-broker"
import {
  NativeDesktopFrameDecoder,
  type NativeDesktopProcessLease
} from "./native-desktop-transport"
import {
  BOT_NATIVE_DESKTOP_PROTOCOL,
  nativeDesktopRequest,
  nativeDesktopScope,
  nativeDesktopSecretReviewed,
  botNativeDesktopAction,
  type NativeDesktopRequest
} from "../../shared/bot-native-desktop"

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})
function frame(value: unknown) {
  const data = Buffer.from(JSON.stringify(value)),
    header = Buffer.alloc(4)
  header.writeUInt32BE(data.length)
  return Buffer.concat([header, data])
}
async function fixture() {
  const botId = randomUUID(),
    hostId = randomUUID(),
    dataEpoch = randomUUID()
  const identity = {
    nonce: randomUUID(),
    jobName: "",
    bootId: randomUUID(),
    sessionId: 1,
    workerPid: 321,
    desktop: "CodexSandboxDesktop-contract",
    hostId,
    dataEpoch
  }
  identity.jobName = `Local\\CMBDevClaw-Bot-${identity.nonce}`
  const window = {
    hwnd: "122",
    pid: 42,
    startTicks: "638953445671234567",
    sessionId: 1,
    desktop: identity.desktop
  }
  const element = {
    id: randomUUID(),
    name: "密码",
    controlType: "Edit",
    value: null,
    password: true,
    enabled: true,
    offscreen: false,
    depth: 0,
    valueTruncated: false,
    supportedActions: []
  }
  const stdin = new PassThrough(),
    stdout = new PassThrough()
  const requests: NativeDesktopRequest[] = []
  let password = true,
    changedName = false,
    mode: "ok" | "unknown" | "rejected" = "ok"
  let closed = false,
    current = true,
    sensitive = true
  let delayedReview: { entered(): void; send?: () => void } | undefined
  let delayedSubmission: { entered(): void; send?: () => void } | undefined
  const lease: NativeDesktopProcessLease = {
    policy: { readRoots: [], writeRoots: [] },
    identity,
    stdin,
    stdout,
    exited: new Promise(() => {}),
    assertCurrent() {
      if (!current) throw new Error("controlled stale lease")
    },
    async verifyMember() {
      /* Fixed fixture identities; actual Windows membership is outside this test. */
    },
    stop() {
      closed = true
    },
    async awaitKernelClosure() {
      /* Controlled transport closure; this fixture does not prove a Windows Job is empty. */
    }
  }
  const decoder = new NativeDesktopFrameDecoder((raw) => {
    const request = nativeDesktopRequest.parse(raw)
    requests.push(request)
    let result: unknown = {}
    let scope = request.scope,
      status = "ok",
      code: string | null = null
    if (request.operation === "windows")
      result = { windows: [{ window, title: "登录" }], truncated: false }
    if (request.operation === "observe")
      result = { window, title: "登录", elements: [element], truncated: false }
    if (request.operation === "secret_review")
      result = {
        window,
        title: "登录",
        element: {
          id: element.id,
          name: changedName ? "changed" : element.name,
          controlType: element.controlType,
          password,
          enabled: true,
          offscreen: false
        }
      }
    if (request.operation === "set_secret") {
      result = { applied: true }
      status = mode
      code = mode === "ok" ? null : "password_control_changed"
    }
    if (request.operation === "frame")
      result = {
        window,
        title: "登录",
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
    if (request.operation === "has_sensitive_input")
      result = { window, passwordDetected: sensitive, complete: !sensitive }
    if (request.operation === "revoke" || request.operation === "grant")
      scope = nativeDesktopScope.parse({
        ...scope,
        controlEpoch: request.params.nextControlEpoch,
        control: request.params.nextControl
      })
    if (request.operation === "invalidate")
      scope = nativeDesktopScope.parse({ ...scope, generation: request.params.nextGeneration })
    const reply = {
      type: "result",
      protocol: BOT_NATIVE_DESKTOP_PROTOCOL,
      version: 1,
      id: request.id,
      sequence: request.sequence,
      nonce: request.nonce,
      scope,
      status,
      result,
      code
    }
    if (request.operation === "secret_review" && delayedReview) {
      delayedReview.send = () => stdout.write(frame(reply))
      delayedReview.entered()
    } else if (request.operation === "set_secret" && delayedSubmission) {
      delayedSubmission.send = () => stdout.write(frame(reply))
      delayedSubmission.entered()
    } else stdout.write(frame(reply))
  }, 64 * 1024)
  stdin.on("data", (chunk) => decoder.feed(chunk))
  const broker = new NativeDesktopBroker({
    hostId,
    dataEpoch: () => dataEpoch,
    assertOperational() {
      /* This fixture keeps the Host configuration stable. */
    },
    assertSupervision() {
      /* This fixture keeps supervision active. */
    },
    assertOwner() {
      /* The fixture owns its single fixed Bot target. */
    },
    loadHumanHeld: () => false,
    saveHumanHeld() {
      /* Held-control persistence is not involved in these transport checks. */
    },
    async launch() {
      queueMicrotask(() =>
        stdout.write(
          frame({
            type: "ready",
            protocol: BOT_NATIVE_DESKTOP_PROTOCOL,
            version: 1,
            nonce: identity.nonce,
            worker: {
              pid: identity.workerPid,
              startTicks: "1234",
              sessionId: identity.sessionId,
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
  cleanup.push(() => broker.close())
  const client = new AbortController(),
    other = new AbortController()
  let target = await broker.ensure(botId)
  target = await broker.takeControl(target, client.signal)
  const windows = await broker.windows(target, () => {}, client.signal)
  target = await broker.selectWindow(target, windows[0].viewId, () => {}, client.signal)
  await broker.observe(target, () => {}, client.signal)
  return {
    broker,
    client,
    other,
    target,
    element,
    requests,
    setPassword(next: boolean) {
      password = next
    },
    changeName() {
      changedName = true
    },
    setSensitivity(next: boolean) {
      sensitive = next
    },
    setOutcome(next: typeof mode) {
      mode = next
    },
    closed: () => closed,
    deferSecretReview() {
      let entered!: () => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      const pending = { entered, send: undefined as (() => void) | undefined }
      delayedReview = pending
      return {
        started,
        release() {
          delayedReview = undefined
          pending.send!()
        }
      }
    },
    deferSecretSubmission() {
      let entered!: () => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      const pending = { entered, send: undefined as (() => void) | undefined }
      delayedSubmission = pending
      return {
        started,
        releaseAfterLeaseLoss() {
          current = false
          delayedSubmission = undefined
          pending.send!()
        }
      }
    }
  }
}

describe("native human password destinations (controlled ports; not Windows acceptance)", () => {
  it("returns metadata only and writes the exact untrimmed value through one single-use lane", async () => {
    const f = await fixture(),
      destination = await f.broker.prepareHumanSecret(f.target, f.element.id, f.client.signal)
    const value = ` ${randomUUID()} `
    expect(Object.keys(destination).sort()).toEqual(["field", "token", "windowTitle"])
    await f.broker.fillHumanSecret(f.target, destination.token, value, f.client.signal)
    const effect = f.requests.filter((request) => request.operation === "set_secret")
    expect(effect.length).toBe(1)
    expect(effect[0].params.value === value).toBe(true)
    expect(JSON.stringify(effect[0].params.expectedElement).includes(value)).toBe(false)
    expect(f.requests.some((request) => request.operation === "review")).toBe(false)
    expect(f.broker.requiresObservation(f.target.botId)).toBe(true)
    await expect(
      f.broker.fillHumanSecret(f.target, destination.token, value, f.client.signal)
    ).rejects.toThrow()
    expect(f.requests.filter((request) => request.operation === "set_secret").length).toBe(1)
  })
  it.each(["other-client", "abort", "new-observation", "generation", "control-epoch", "expired"])(
    "rejects a destination after %s without sending its value",
    async (change) => {
      const f = await fixture(),
        destination = await f.broker.prepareHumanSecret(f.target, f.element.id, f.client.signal)
      let client = f.client.signal,
        target = f.target
      if (change === "other-client") client = f.other.signal
      if (change === "abort") f.client.abort()
      if (change === "new-observation") await f.broker.observe(target, () => {}, client)
      if (change === "generation") {
        f.broker.invalidateObservations()
        target = f.broker.target(target.botId)
      }
      if (change === "control-epoch") {
        await f.broker.releaseControl(target, client)
        target = f.broker.target(target.botId)
      }
      if (change === "expired")
        vi.spyOn(performance, "now").mockReturnValue(performance.now() + 61_000)
      await expect(
        f.broker.fillHumanSecret(target, destination.token, "transient-input", client)
      ).rejects.toThrow()
      expect(f.requests.some((request) => request.operation === "set_secret")).toBe(false)
    }
  )
  it.each(["unprotected", "changed-name"])(
    "rechecks password metadata after passive %s change",
    async (change) => {
      const f = await fixture(),
        destination = await f.broker.prepareHumanSecret(f.target, f.element.id, f.client.signal)
      if (change === "unprotected") f.setPassword(false)
      else f.changeName()
      await expect(
        f.broker.fillHumanSecret(f.target, destination.token, "transient-input", f.client.signal)
      ).rejects.toMatchObject({ code: "native_secret_failed" })
      expect(
        f.requests.some(
          (request) => request.operation === "set_secret" || request.operation === "review"
        )
      ).toBe(false)
    }
  )
  it("fences an unknown submitted input and never resends it", async () => {
    const f = await fixture(),
      destination = await f.broker.prepareHumanSecret(f.target, f.element.id, f.client.signal)
    f.setOutcome("unknown")
    await expect(
      f.broker.fillHumanSecret(f.target, destination.token, "transient-input", f.client.signal)
    ).rejects.toMatchObject({ code: "native_secret_unconfirmed" })
    expect(f.closed()).toBe(true)
    await expect(
      f.broker.fillHumanSecret(f.target, destination.token, "transient-input", f.client.signal)
    ).rejects.toThrow()
    expect(f.requests.filter((request) => request.operation === "set_secret").length).toBe(1)
  })
  it("allows only the authenticated human pointer through protected windows and still rejects keyboard/text", async () => {
    const f = await fixture(),
      before = vi.fn<NonNullable<NativeDesktopBroker["humanObserver"]>>(async () => {})
    f.broker.humanObserver = before
    let shown = await f.broker.frame(f.target.botId, f.client.signal)
    const pointer = botNativeDesktopAction.parse({
      op: "message_pointer",
      x: 5,
      y: 5,
      kind: "click"
    })
    await expect(
      f.broker.humanInput(f.target, { frameSeq: shown.frameSeq, action: pointer }, f.other.signal)
    ).rejects.toThrow()
    await f.broker.humanInput(
      f.target,
      { frameSeq: shown.frameSeq, action: pointer },
      f.client.signal
    )
    expect(f.requests.filter((request) => request.operation === "message_pointer").length).toBe(1)
    expect(before.mock.calls.some((call) => call[3] === "before")).toBe(true)
    shown = await f.broker.frame(f.target.botId, f.client.signal)
    await expect(
      f.broker.humanInput(
        f.target,
        { frameSeq: shown.frameSeq, action: { op: "message_keyboard", text: "ordinary text" } },
        f.client.signal
      )
    ).rejects.toMatchObject({ code: "native_secret_required" })
    expect(f.requests.some((request) => request.operation === "message_keyboard")).toBe(false)
  })
  it("rejects protected values in generic semantic input and secret metadata responses", async () => {
    const f = await fixture(),
      shown = await f.broker.frame(f.target.botId, f.client.signal)
    await expect(
      f.broker.humanInput(
        f.target,
        {
          frameSeq: shown.frameSeq,
          action: { op: "set_value", elementId: f.element.id, value: "ordinary input" }
        },
        f.client.signal
      )
    ).rejects.toThrow()
    expect(f.requests.some((request) => request.operation === "set_value")).toBe(false)
    expect(
      nativeDesktopSecretReviewed.safeParse({
        window: {},
        title: "",
        element: { value: "forbidden" }
      }).success
    ).toBe(false)
  })
})

it("does not return an owner's cached confidential frame to the model Host or another viewer", async () => {
  const f = await fixture()
  const ownerFrame = await f.broker.frame(f.target.botId, f.client.signal)
  expect(Boolean(ownerFrame.image)).toBe(true)
  const frameCount = f.requests.filter((request) => request.operation === "frame").length
  await expect(f.broker.frame(f.target.botId)).rejects.toMatchObject({
    code: "native_secret_required"
  })
  await expect(f.broker.frame(f.target.botId, f.other.signal)).rejects.toMatchObject({
    code: "native_secret_required"
  })
  expect(f.requests.filter((request) => request.operation === "frame").length).toBe(frameCount)
})

it("invalidates an already consumed queued ticket when a newer secret destination supersedes it", async () => {
  const f = await fixture(),
    old = await f.broker.prepareHumanSecret(f.target, f.element.id, f.client.signal)
  const gate = f.deferSecretReview()
  const newer = f.broker.prepareHumanSecret(f.target, f.element.id, f.client.signal)
  await gate.started
  const submitted = f.broker.fillHumanSecret(f.target, old.token, "transient", f.client.signal)
  gate.release()
  await newer
  await expect(submitted).rejects.toMatchObject({ code: "native_secret_stale" })
  expect(f.requests.some((request) => request.operation === "set_secret")).toBe(false)
})

it("does not classify a post-submission lease loss as a confirmed unfilled password", async () => {
  const f = await fixture(),
    destination = await f.broker.prepareHumanSecret(f.target, f.element.id, f.client.signal)
  const gate = f.deferSecretSubmission()
  const submitted = f.broker.fillHumanSecret(
    f.target,
    destination.token,
    "transient",
    f.client.signal
  )
  const rejection = expect(submitted).rejects.toMatchObject({ code: "native_secret_unconfirmed" })
  await gate.started
  gate.releaseAfterLeaseLoss()
  await rejection
  expect(f.requests.filter((request) => request.operation === "set_secret").length).toBe(1)
})

it("requests a fresh read-only frame after provider retirement instead of forwarding the holder's cached image", async () => {
  const f = await fixture()
  const held = await f.broker.frame(f.target.botId, f.client.signal)
  f.setSensitivity(false)
  const viewed = await f.broker.frame(f.target.botId, f.other.signal)
  expect(viewed.frameSeq).not.toBe(held.frameSeq)
  const captures = f.requests.filter((request) => request.operation === "frame")
  expect(captures.length).toBe(2)
  expect(captures[1].params.issueInputTicket).toBe(false)
})
