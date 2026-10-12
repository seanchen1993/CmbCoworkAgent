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
  type NativeDesktopRequest
} from "../../shared/bot-native-desktop"

/** Real broker/transport, controlled Windows process port. No Windows Job,
 * kernel capture or application compatibility is established by this fixture. */
export async function computerTaskNativeFixture(botId: string) {
  const hostId = randomUUID(),
    dataEpoch = randomUUID(),
    nonce = randomUUID()
  const identity = {
    nonce,
    jobName: `Local\\CMBDevClaw-Bot-${nonce}`,
    bootId: randomUUID(),
    sessionId: 1,
    workerPid: 321,
    desktop: "CodexSandboxDesktop-computer-task",
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
    name: "Task note",
    controlType: "Edit",
    value: "",
    password: false,
    enabled: true,
    offscreen: false,
    depth: 0,
    valueTruncated: false,
    supportedActions: ["set_value"]
  }
  const stdin = new PassThrough(),
    stdout = new PassThrough()
  const requests: NativeDesktopRequest[] = []
  let launches = 0,
    stopped = false,
    held = false
  const pack = (value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value)),
      header = Buffer.alloc(4)
    header.writeUInt32BE(bytes.length)
    return Buffer.concat([header, bytes])
  }
  const lease: NativeDesktopProcessLease = {
    policy: { readRoots: [], writeRoots: [] },
    identity,
    stdin,
    stdout,
    exited: new Promise(() => {}),
    assertCurrent() {
      if (stopped) throw new Error("Controlled worker closed")
    },
    async verifyMember() {
      /* Fixed controlled identities, not an actual Windows admission. */
    },
    stop() {
      stopped = true
    },
    async awaitKernelClosure() {
      /* Controlled closure, not a kernel Job emptiness proof. */
    }
  }
  const decoder = new NativeDesktopFrameDecoder((raw) => {
    const request = nativeDesktopRequest.parse(raw)
    requests.push(request)
    let result: unknown = {},
      scope = request.scope
    if (request.operation === "windows")
      result = { windows: [{ window, title: "Task editor" }], truncated: false }
    if (request.operation === "observe")
      result = { window, title: "Task editor", elements: [{ ...element }], truncated: false }
    if (request.operation === "review")
      result = { window, title: "Task editor", element: { ...element } }
    if (request.operation === "set_value") {
      element.value = String(request.params.value)
      result = { applied: true }
    }
    if (request.operation === "frame")
      result = {
        window,
        title: "Task editor",
        width: 100,
        height: 100,
        sourceWidth: 100,
        sourceHeight: 100,
        image:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9kAAAAASUVORK5CYII=",
        captureId: randomUUID(),
        frameVersion: String(request.sequence),
        inputTicketIssued: true,
        messageGeometryReady: true
      }
    if (request.operation === "has_sensitive_input")
      result = { window, passwordDetected: false, complete: true }
    if (request.operation === "revoke" || request.operation === "grant")
      scope = nativeDesktopScope.parse({
        ...scope,
        controlEpoch: request.params.nextControlEpoch,
        control: request.params.nextControl
      })
    if (request.operation === "invalidate")
      scope = nativeDesktopScope.parse({ ...scope, generation: request.params.nextGeneration })
    stdout.write(
      pack({
        type: "result",
        protocol: BOT_NATIVE_DESKTOP_PROTOCOL,
        version: 1,
        id: request.id,
        sequence: request.sequence,
        nonce,
        scope,
        status: "ok",
        result,
        code: null
      })
    )
  }, 64 * 1024)
  stdin.on("data", (chunk) => decoder.feed(chunk))
  const broker = new NativeDesktopBroker({
    hostId,
    dataEpoch: () => dataEpoch,
    assertOperational() {
      /* Stable controlled Host */
    },
    assertSupervision() {
      /* Active controlled supervision */
    },
    assertOwner() {
      /* Fixed fixture Bot */
    },
    loadHumanHeld: () => held,
    saveHumanHeld(_bot, _task, next) {
      held = next
    },
    async launch() {
      launches++
      queueMicrotask(() =>
        stdout.write(
          pack({
            type: "ready",
            protocol: BOT_NATIVE_DESKTOP_PROTOCOL,
            version: 1,
            nonce,
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
  const target = await broker.ensure(botId),
    windows = await broker.windows(target, () => {})
  await broker.selectWindow(target, windows[0].viewId, () => {})
  return {
    broker,
    requests,
    element,
    window,
    launches: () => launches,
    stopped: () => stopped,
    held: () => held
  }
}
