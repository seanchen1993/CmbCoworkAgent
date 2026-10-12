import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Page } from "playwright"
import type { BotBrowserTarget } from "../../shared/bot-computer"
import { BotStore } from "./store"
import { BotTeachStore } from "./teach-store"
import { BotTeachService } from "./teach-service"
import { BotTeachVideo } from "./teach-video"
import type { BotTeachSource, BotTeachView } from "./teach-source"
import { nativeTeachInputDetails } from "./teach-native-source"
import { parseBotTeachStart } from "./teach-start-scope"

const close: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  for (const fn of close.splice(0).reverse()) await fn()
  vi.restoreAllMocks()
})

it("keeps historical browser receipts stable and binds native backend into the original nonce", () => {
  const store = new BotStore(":memory:")
  close.push(() => store.close())
  const { bot, conversationId } = store.createBot({ nonce: "bot", name: "Teach scope" })
  const input = {
    botId: bot.id,
    conversationId,
    nonce: "start",
    target: {
      botId: bot.id,
      generation: "generation",
      controlEpoch: 1,
      control: "bot" as const,
      viewId: "view"
    }
  }
  const browser = parseBotTeachStart(input)
  expect(Object.keys(browser.target)).toEqual([
    "botId",
    "generation",
    "controlEpoch",
    "control",
    "viewId"
  ])
  expect(browser.expectedDataEpoch).toBe("initial")
  const native = { ...input, target: { ...input.target, backend: "windows-native" as const } }
  const repository = new BotTeachStore(store)
  const created = repository.create(native)
  expect(repository.startRequest(created.id)?.target.backend).toBe("windows-native")
  expect(repository.create(native).id).toBe(created.id)
  expect(() => repository.create(input)).toThrow(
    expect.objectContaining({ code: "nonce_conflict" })
  )
  expect(() =>
    parseBotTeachStart({ ...input, target: { ...input.target, backend: "untrusted" } } as never)
  ).toThrow()
})

it("never writes typed credentials or semantic values into native event details", () => {
  for (const action of [
    { op: "set_value", elementId: "field", value: "test-password-must-not-persist" },
    { op: "message_keyboard", text: "test-api-token-must-not-persist" },
    { op: "message_keyboard", key: "test-secret-not-a-real-key" }
  ]) {
    const details = nativeTeachInputDetails({ frameSeq: 1, action } as never)
    expect(details.inputContentOmitted).toBe(true)
    const serialized = JSON.stringify(details)
    expect(serialized).not.toMatch(/test-password|test-api-token|test-secret/)
    expect(details).not.toHaveProperty("value")
    expect(details).not.toHaveProperty("text")
    expect(details).not.toHaveProperty("key")
  }
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cmb-native-teach-contract-"))
  close.push(() => rm(directory, { recursive: true, force: true }))
  const store = new BotStore(":memory:")
  close.push(() => store.close())
  const { bot, conversationId } = store.createBot({ nonce: "bot", name: "Native Teach" })
  const target: BotBrowserTarget = {
    botId: bot.id,
    generation: "generation",
    controlEpoch: 1,
    control: "human",
    viewId: "native-view"
  }
  let callbacks: Parameters<BotTeachSource["attach"]>[1] | undefined
  let gates: boolean[] = []
  const frames: Buffer[] = []
  const view: BotTeachView = {
    hasSensitiveInput: async () => gates.shift() ?? false,
    capture: async () => ({
      image: Buffer.from("contract-only-native-image"),
      title: "Window",
      url: "native-window:native-view"
    })
  }
  const source: BotTeachSource = {
    backend: "windows-native",
    target: () => ({ ...target }),
    assertHumanClient: (_id, client) => client.throwIfAborted(),
    humanClientConnected: () => true,
    takeControl: async () => {},
    encoderPage: async () => ({}) as Page,
    observe: async (_id, operation) => operation(view),
    attach: (_id, subscribed) => {
      callbacks = subscribed
      return () => {
        callbacks = undefined
      }
    }
  }
  vi.spyOn(BotTeachVideo, "start").mockImplementation(async (_page, destination) => {
    await writeFile(destination, "contract-only-video-not-windows-evidence")
    return {
      frame: async (image: Buffer) => {
        frames.push(image)
      },
      pause: async () => {},
      finish: async () => (await readFile(destination)).length,
      dispose: async () => {}
    } as unknown as BotTeachVideo
  })
  const teach = new BotTeachService(directory, store, {
    get: async () => {
      throw new Error("native must not create a browser surface")
    }
  } as never)
  teach.bindNativeSource(async () => source)
  close.push(() => teach.close())
  const input = {
    botId: bot.id,
    conversationId,
    nonce: "recording",
    target: { ...target, backend: "windows-native" as const }
  }
  return {
    teach,
    store,
    source,
    frames,
    input,
    view,
    callbacks: () => callbacks!,
    gates: (next: boolean[]) => {
      gates = next
    }
  }
}

it("uses the existing durable save/queue/learning lifecycle for native evidence", async () => {
  const f = await fixture(),
    session = await f.teach.start(f.input)
  expect(session.phase).toBe("recording")
  await f
    .callbacks()
    .input(
      f.input.botId,
      f.view,
      { kind: "invoke", details: async () => ({ operation: "invoke" }) },
      "before"
    )
  await f
    .callbacks()
    .input(
      f.input.botId,
      f.view,
      { kind: "invoke", details: async () => ({ operation: "invoke" }) },
      "after"
    )
  const saved = await f.teach.stop({ id: session.id, save: true })
  expect(saved.phase).toBe("learning")
  expect(saved.video?.size).toBeGreaterThan(0)
  expect(saved.frameCount).toBe(1)
  expect(
    f.teach.repository.events(session.id).filter((event) => event.kind === "invoke")
  ).toHaveLength(1)
  expect(f.store.getRun(saved.learningRunId!).source).toBe("teach-learning")
  expect(f.teach.repository.startRequest(session.id)?.target.backend).toBe("windows-native")
})

it("records queued native input as submitted without claiming an application effect", async () => {
  const f = await fixture(),
    session = await f.teach.start(f.input)
  const input: import("./teach-source").BotTeachInput = {
    kind: "message_keyboard",
    afterOutcome: "submitted",
    details: async () =>
      nativeTeachInputDetails({
        frameSeq: 1,
        action: { op: "message_keyboard", text: "not-durable-input" }
      })
  }
  await f.callbacks().input(f.input.botId, f.view, input, "before")
  await f.callbacks().input(f.input.botId, f.view, input, "after")
  const event = f.teach.repository
    .events(session.id)
    .find((item) => item.kind === "message_keyboard")
  expect(event?.details).toMatchObject({ outcome: "submitted", inputContentOmitted: true })
  expect(JSON.stringify(event)).not.toContain("not-durable-input")
  await f.teach.stop({ id: session.id, save: false })
})

it("discards a frame that becomes sensitive after acquisition and does not retain pending input", async () => {
  const f = await fixture(),
    session = await f.teach.start(f.input)
  f.gates([false, false, true]) // observer gate, before capture, after acquisition
  await f.callbacks().input(
    f.input.botId,
    f.view,
    {
      kind: "set_value",
      details: async () => {
        throw new Error("must not inspect paused input")
      }
    },
    "before"
  )
  expect(f.teach.status(f.input.botId)?.phase).toBe("paused")
  expect(f.frames).toHaveLength(0)
  expect(f.teach.repository.frames(session.id)).toHaveLength(0)
  expect(f.teach.repository.events(session.id).every((event) => event.kind !== "set_value")).toBe(
    true
  )
  expect((await f.teach.stop({ id: session.id, save: false })).phase).toBe("discarded")
})

it("holds Native Teach paused across secure input and a concurrent resume, without auto-resuming", async () => {
  const f = await fixture(),
    owner = new AbortController(),
    other = new AbortController()
  f.source.assertHumanClient = (_id, client) => {
    client.throwIfAborted()
    if (client !== owner.signal) throw new Error("Different control client")
  }
  const session = await f.teach.start(f.input, owner.signal)
  await expect(f.teach.pauseForNativeSecret(f.input.botId, other.signal)).rejects.toThrow()
  expect(f.teach.status(f.input.botId)?.phase).toBe("recording")
  const entering = f.teach.pauseForNativeSecret(f.input.botId, owner.signal)
  const resuming = f.teach.pause({ id: session.id, paused: false }, owner.signal)
  const release = await entering
  await expect(resuming).rejects.toThrow("安全输入")
  expect(f.teach.status(f.input.botId)?.phase).toBe("paused")
  release()
  release()
  expect(f.teach.status(f.input.botId)?.phase).toBe("paused")
  await f.teach.pause({ id: session.id, paused: false }, owner.signal)
  expect(f.teach.status(f.input.botId)?.phase).toBe("recording")
})

it("releases a secure-input guard exactly once on disconnect while leaving Native capture paused", async () => {
  const f = await fixture(),
    owner = new AbortController()
  const session = await f.teach.start(f.input, owner.signal)
  const release = await f.teach.pauseForNativeSecret(f.input.botId, owner.signal)
  owner.abort()
  release()
  release()
  expect(f.teach.status(f.input.botId)?.phase).toBe("paused")
  await f.teach.pause({ id: session.id, paused: false })
  expect(f.teach.status(f.input.botId)?.phase).toBe("recording")
})
