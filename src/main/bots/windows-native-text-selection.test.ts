import { afterEach, expect, it } from "vitest"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { copyFile, lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import { BotStore } from "./store"
import { BotHost } from "./host"
import { BotHostLock } from "./host-lock"
import { BotSharedWorkspace } from "./shared-workspace"
import { BotRpcServer } from "./rpc"
import { BotTransportClient } from "./transport-client"
import { CmbBotRuntime } from "./agent-runtime"
import { LocalBotComputerProvider } from "./computer-provider"
import { writeBotModelSnapshot } from "./model-config"
import { testModelRequest } from "./test-model-protocol"
import { NativeDesktopBroker } from "./native-desktop-broker"
import { NativeDesktopControlStore } from "./native-desktop-control-store"
import { createWindowsNativeDesktopFactory } from "./windows-native-desktop-factory"
import { readBotOwnedShellArtifact } from "./host-shell-factory"
import { loadWindowsNativeTestConfiguration } from "./windows-native-test-configuration"
import { inspectNativeDesktopMaintenance } from "./native-desktop-maintenance"
import { nativeDesktopObservation, nativeDesktopWindow } from "../../shared/bot-native-desktop"
import type { NativeDesktopProcessLease } from "./native-desktop-transport"

const enabled =
  process.platform === "win32" &&
  process.arch === "x64" &&
  process.env.CMB_BOT_NATIVE_WINDOWS_SELECTION_TEST === "1"
const closes: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of closes.splice(0).reverse()) {
    try {
      await close()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length) throw new AggregateError(errors, "Actual native selection cleanup failed")
})
const proofSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().positive(),
    state: z
      .object({
        pid: z.number().int().positive(),
        hwnd: z.string().regex(/^-?[1-9]\d*$/),
        text: z.string().max(4096),
        selectionStart: z.number().int().nonnegative(),
        selectionLength: z.number().int().nonnegative()
      })
      .strict()
  })
  .strict()
async function proof(path: string) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192)
    throw new Error("Invalid fixture proof")
  return proofSchema.parse(JSON.parse(await readFile(path, "utf8")))
}
async function waitFor<T>(read: () => Promise<T | undefined>, maximum = 15_000): Promise<T> {
  const deadline = Date.now() + maximum
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await delay(25)
  }
  throw new Error("Actual Windows selection condition did not become true")
}
function lastTool(body: z.infer<typeof testModelRequest>): unknown {
  const message = body.messages.filter((item) => item.role === "tool").at(-1)
  const raw =
    typeof message?.content === "string"
      ? message.content
      : Array.isArray(message?.content)
        ? message.content.find((part) => part.type === "text")?.text
        : undefined
  if (!raw) throw new Error("Expected actual previous native tool output")
  return JSON.parse(raw)
}

it.skipIf(!enabled)(
  "Windows actual private worker selects verified text through authenticated approval and survives retained UIA/WGC lifecycle reuse",
  async () => {
    const { directory, windowsNative } = await loadWindowsNativeTestConfiguration(process.env)
    const lock = BotHostLock.acquire(directory)
    if (!lock) throw new Error("Actual isolated fixture Host lock unavailable")
    closes.push(() => lock.release())
    const shared = await BotSharedWorkspace.open(directory)
    const id = randomUUID(),
      workspace = shared.path,
      proofRoot = join(workspace, `selection-${id}`)
    await mkdir(proofRoot)
    // Intentionally retained as diagnostic evidence. Unknown closure must never
    // erase an application's files or physical native resource records.
    const fixtureSource = process.env.CMB_BOT_NATIVE_WINDOWS_SELECTION_FIXTURE,
      fixtureHash = process.env.CMB_BOT_NATIVE_WINDOWS_SELECTION_FIXTURE_SHA256
    if (
      !fixtureSource ||
      !isAbsolute(fixtureSource) ||
      !fixtureHash ||
      !/^[a-f0-9]{64}$/.test(fixtureHash)
    )
      throw new Error("Explicit pinned compiled WinForms fixture required")
    if ((await realpath(fixtureSource)) !== fixtureSource)
      throw new Error("Fixture executable is not canonical")
    const sourceStat = await lstat(fixtureSource)
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size > 256 * 1024 * 1024)
      throw new Error("Fixture executable is not physical and bounded")
    const executable = join(proofRoot, "CMBDevClaw.NativeSelectionFixture.exe")
    await copyFile(fixtureSource, executable)
    const actualHash = createHash("sha256")
      .update(await readFile(executable))
      .digest("hex")
    if (actualHash !== fixtureHash) throw new Error("Fixture executable pin differs")
    const modelFile = join(directory, `selection-model-${id}.private`)
    const dbPath = join(directory, `selection-${id}.sqlite`)
    const store = new BotStore(dbPath, undefined, undefined, shared.path)
    closes.push(() => store.close())
    const created = store.createBot({
      nonce: id,
      name: "Windows selection acceptance",
      workspacePath: workspace
    })
    const events: { phase: string; at: number }[] = [],
      approvals: string[] = []
    const lifecycle: {
      identity: NativeDesktopProcessLease["identity"]
      verifiedPids: number[]
      kernelClosed: boolean
    }[] = []
    const mark = (phase: string) => events.push({ phase, at: Date.now() })
    const windowsSchema = z
      .array(
        z
          .object({ viewId: z.string().uuid(), title: z.string(), window: nativeDesktopWindow })
          .strict()
      )
      .max(128)
    let stage = 0,
      modelCalls = 0,
      selectedWindow: z.infer<typeof nativeDesktopWindow> | undefined
    let initialObservation: z.infer<typeof nativeDesktopObservation> | undefined
    const server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = []
        let bytes = 0
        for await (const chunk of req) {
          bytes += chunk.length
          if (bytes > 8 * 1024 * 1024) throw new Error("Controlled model request exceeds bound")
          chunks.push(chunk)
        }
        const body = testModelRequest.parse(JSON.parse(Buffer.concat(chunks).toString()))
        if (++modelCalls > 16) throw new Error("Controlled model turn budget exceeded")
        mark(`model-${modelCalls}`)
        let op = "",
          args: unknown = {},
          final = false
        if (stage === 0) {
          op = "launch"
          args = { executable, cwd: workspace, arguments: ["--proof-root", proofRoot] }
          stage = 1
        } else if (stage === 1) {
          op = "windows"
          stage = 2
        } else if (stage === 2) {
          const windows = windowsSchema.parse(lastTool(body))
          const window = windows.find(
            (item) => item.title === "CMBDevClaw Native Selection Acceptance"
          )
          if (!window) {
            await delay(100)
            op = "windows"
          } else {
            selectedWindow = window.window
            op = "select_window"
            args = { viewId: window.viewId }
            stage = 3
          }
        } else if (stage === 3) {
          op = "observe"
          stage = 4
        } else if (stage === 4) {
          const observed = nativeDesktopObservation.parse(lastTool(body))
          initialObservation = observed
          const editor = observed.elements.find((item) => item.name === "cmb-selection-text")
          // RichTextBox support is tested here, never assumed. Unsupported
          // Value/TextPattern/selection is a hard failure, not skip-as-success.
          if (
            !editor ||
            editor.password ||
            editor.valueTruncated ||
            !editor.value ||
            !editor.supportedActions.includes("set_value") ||
            !editor.supportedActions.includes("select_all_text")
          )
            throw new Error(
              `Real ValuePattern/TextPattern selection capability absent: ${JSON.stringify(observed)}`
            )
          op = "invoke"
          args = { elementId: editor.id, action: "select_all_text" }
          stage = 5
        } else if (stage === 5) {
          const delivered = z
            .object({
              deliveryReceipt: z
                .object({
                  submitted: z.literal(true),
                  transport: z.literal("uia-text-range"),
                  effectVerified: z.literal(false)
                })
                .passthrough()
            })
            .passthrough()
            .parse(lastTool(body))
          expect(delivered.deliveryReceipt.submitted).toBe(true)
          const parts = body.messages.filter((item) => item.role === "tool").at(-1)?.content
          expect(
            Array.isArray(parts) &&
              parts.some(
                (part) =>
                  part.type === "image_url" &&
                  /^data:image\/(png|jpeg);base64,/.test(part.image_url?.url ?? "")
              )
          ).toBe(true)
          mark("post-effect-wgc-observation")
          final = true
          stage = 6
        } else throw new Error("Unexpected extra model continuation")
        res.setHeader("Content-Type", "text/event-stream")
        const delta = (value: unknown, reason: string | null = null) =>
          res.write(
            `data: ${JSON.stringify({
              id: `selection-${modelCalls}`,
              object: "chat.completion.chunk",
              created: 1,
              model: "gpt-test",
              choices: [{ index: 0, delta: value, finish_reason: reason }]
            })}\n\n`
          )
        delta(
          final
            ? { role: "assistant", content: "NATIVE_SELECTION_OBSERVED" }
            : {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `selection-call-${modelCalls}`,
                    type: "function",
                    function: {
                      name: "native_computer",
                      arguments: JSON.stringify({ op, arguments_json: JSON.stringify(args) })
                    }
                  }
                ]
              }
        )
        delta({}, final ? "stop" : "tool_calls")
        res.end("data: [DONE]\n\n")
      } catch (error) {
        res.statusCode = 500
        res.end(error instanceof Error ? error.message : "Fixture failed")
      }
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    closes.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        })
    )
    const { port } = server.address() as { port: number }
    await writeBotModelSnapshot(modelFile, {
      version: 1,
      defaultRef: "fixture",
      models: [
        {
          ref: "fixture",
          id: "fixture",
          name: "fixture",
          model: "gpt-test",
          apiKey: "fixture-only",
          baseUrl: `http://127.0.0.1:${port}/v1`
        }
      ]
    })
    const browser = new LocalBotComputerProvider(join(directory, `selection-browser-${id}`))
    closes.push(() => browser.shutdown())
    const runtime = new CmbBotRuntime(modelFile, browser, { sharedWorkspace: shared })
    const host = new BotHost(store, runtime, 2, browser)
    host.bindOwnership(lock)
    const lifetime = new AbortController()
    const controls = new NativeDesktopControlStore(store)
    const assertOperational = () => {
      lifetime.signal.throwIfAborted()
      lock.assertCurrent()
      host.assertComputerSupervision()
    }
    const factory = await createWindowsNativeDesktopFactory(
      {
        directory,
        bootstrap: await readBotOwnedShellArtifact(resolve("out/main/bot-native-desktop-owner.js")),
        getBot: (botId) => store.getBot(botId),
        sharedWorkspace: shared,
        hostId: () => host.id,
        dataEpoch: () => store.dataEpoch(),
        protectedRoots: () => [directory],
        signal: lifetime.signal,
        assertOperational,
        assertCurrentSync: () => {
          lock.assertCurrent()
          host.assertOwnership()
        },
        assertOwnership: async (signal) => {
          signal.throwIfAborted()
          await lock.checkCurrent()
          host.assertOwnership()
        }
      },
      windowsNative
    )
    const broker = new NativeDesktopBroker({
      hostId: host.id,
      dataEpoch: () => store.dataEpoch(),
      assertOperational,
      assertSupervision: () => host.assertComputerSupervision(),
      assertOwner: (botId, taskRunId) => {
        store.getBot(botId)
        if (taskRunId) throw new Error("Fixture grants no child desktop")
      },
      assertBotInput: (botId) => {
        if (browser.controlHeld(botId))
          throw new Error("Browser human takeover blocks native input")
      },
      loadHumanHeld: (botId, taskRunId) => controls.held(botId, taskRunId),
      saveHumanHeld: (botId, taskRunId, held) => controls.save(botId, taskRunId, held),
      launch: async (scope) => {
        const lease = await factory(scope)
        const item = { identity: lease.identity, verifiedPids: [] as number[], kernelClosed: false }
        lifecycle.push(item)
        return {
          ...lease,
          verifyMember: async (pid) => {
            await lease.verifyMember(pid)
            item.verifiedPids.push(pid)
          },
          awaitKernelClosure: async () => {
            await lease.awaitKernelClosure()
            item.kernelClosed = true
          }
        }
      }
    })
    host.nativeComputer = broker
    runtime.bindNativeComputer(broker)
    closes.push(async () => {
      await host.stop()
      lifetime.abort(new Error("Fixture settled"))
    })
    const token = randomBytes(32).toString("hex"),
      socketPath = `\\\\.\\pipe\\selection-${token.slice(0, 16)}`
    const rpc = new BotRpcServer(host, token)
    await rpc.listen(socketPath)
    closes.push(() => rpc.close())
    const client = new BotTransportClient({
      version: 1,
      pid: process.pid,
      hostId: host.id,
      socketPath,
      token
    })
    closes.push(() => client.close())
    const sent = await client.call("send", {
      nonce: `task-${id}`,
      conversationId: created.conversationId,
      text: "Use the approved fixture app to select its complete non-secret text once."
    })
    const runId = sent.runIds[0]
    host.start()
    // Only the exact pinned fixture launch and one select_all_text action are
    // approved through ordinary authenticated answer CAS; no remembered rule.
    const deadline = Date.now() + 45_000
    while (
      Date.now() < deadline &&
      !["succeeded", "failed", "cancelled", "needs_review"].includes(store.getRun(runId).status)
    ) {
      const rows =
        store.db.exec("SELECT id FROM bot_interactions WHERE run_id=? AND status='pending'", [
          runId
        ])[0]?.values ?? []
      for (const row of rows) {
        const interaction = store.getInteraction(String(row[0]))
        expect(interaction.kind).toBe("approval")
        const action = JSON.parse(interaction.prompt).nativeDesktop
        if (action.launch)
          expect(action.launch).toEqual({
            executable,
            cwd: workspace,
            arguments: ["--proof-root", proofRoot]
          })
        else expect(action.action).toMatchObject({ op: "invoke", action: "select_all_text" })
        expect(approvals.length).toBeLessThan(2)
        approvals.push(interaction.id)
        mark("approved")
        const answer = { id: interaction.id, revision: interaction.revision, answer: "approve" }
        const acknowledged = await client.call("answer", answer)
        expect(await client.call("answer", answer)).toEqual(acknowledged)
      }
      await delay(25)
    }
    expect(store.getRun(runId)).toMatchObject({
      status: "succeeded",
      result: "NATIVE_SELECTION_OBSERVED",
      error: null
    })
    expect(approvals).toHaveLength(2)
    const effects = store.effects(runId)
    expect(effects).toHaveLength(2)
    expect(effects.every((effect) => effect.status === "succeeded")).toBe(true)
    const selected = await waitFor(async () => {
      const value = await proof(join(proofRoot, "selection-proof.json"))
      return value.state.selectionStart === 0 &&
        value.state.selectionLength === value.state.text.length
        ? value
        : undefined
    })
    expect(selected.state.text).toBe(
      initialObservation!.elements.find((item) => item.name === "cmb-selection-text")!.value
    )
    expect(selected.state.pid).toBe(selectedWindow!.pid)
    expect(selected.state.hwnd).toBe(selectedWindow!.hwnd)
    expect(lifecycle).toHaveLength(1)
    expect(lifecycle[0].identity.desktop).not.toBe("Default")
    expect(lifecycle[0].verifiedPids).toContain(selected.state.pid)
    // Real native retained provider/range clear+reacquire, not an RSS/ACK release
    // counter. Read-only review cannot grant an effect or bypass an approval.
    for (let cycle = 0; cycle < 12; cycle++) {
      const target = broker.target(created.bot.id)
      const observed = await broker.observe(target, assertOperational)
      const editor = observed.elements.find((item) => item.name === "cmb-selection-text")!
      expect(editor.supportedActions).toContain("select_all_text")
      const action = {
        op: "invoke" as const,
        elementId: editor.id,
        action: "select_all_text" as const
      }
      const review = await broker.prepareReview(target, action, assertOperational)
      try {
        await broker.assertReview(target, action, review, assertOperational)
      } finally {
        broker.discardReview(review)
      }
      await broker.observe(target, assertOperational)
      await expect(broker.prepareReview(target, action, assertOperational)).rejects.toThrow()
    }
    const frame = await broker.frame(created.bot.id)
    expect(frame.window).toEqual(selectedWindow)
    expect(frame.width * frame.height).toBeGreaterThan(100)
    const image = Buffer.from(frame.image.slice(frame.image.indexOf(",") + 1), "base64")
    expect(image.length).toBeGreaterThan(1000)
    expect(
      frame.image.startsWith("data:image/jpeg;")
        ? image.subarray(0, 2).equals(Buffer.from([255, 216]))
        : image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ).toBe(true)
    // Production WGC encodes a complete source-window JPEG (quality 82),
    // preserving its aspect ratio and limiting the preview to 1280 x 960.
    // Decode the actual bytes: a correctly sized black image is not evidence.
    expect(frame.width).toBeLessThanOrEqual(1280)
    expect(frame.height).toBeLessThanOrEqual(960)
    const { createCanvas, loadImage } = await import("@napi-rs/canvas")
    const decoded = await loadImage(image)
    expect(decoded.width).toBe(frame.width)
    expect(decoded.height).toBe(frame.height)
    const sourceWidth = frame.sourceWidth ?? 0,
      sourceHeight = frame.sourceHeight ?? 0
    expect(sourceWidth).toBeGreaterThanOrEqual(frame.width)
    expect(sourceHeight).toBeGreaterThanOrEqual(frame.height)
    const canvas = createCanvas(frame.width, frame.height),
      context = canvas.getContext("2d")
    context.drawImage(decoded, 0, 0)
    // Fixture: 640 x 420 client, editor docked at its top 72 pixels, all
    // remaining client background RGB(220,32,48). The central 45–55% width
    // and 60–75% height avoid that editor and normal DPI-scaled non-client
    // borders. Map source-window positions into the exact decoded preview;
    // 25 interior samples must all match, with tolerance for JPEG encoding.
    for (let row = 0; row < 5; row++) {
      for (let column = 0; column < 5; column++) {
        const sourceX = Math.floor(sourceWidth * (0.45 + column * 0.025)),
          sourceY = Math.floor(sourceHeight * (0.6 + row * 0.0375)),
          x = Math.floor((sourceX * frame.width) / sourceWidth),
          y = Math.floor((sourceY * frame.height) / sourceHeight)
        const pixels = context.getImageData(x, y, 1, 1).data
        for (const [channel, expected] of [220, 32, 48].entries())
          expect(Math.abs(pixels[channel] - expected)).toBeLessThanOrEqual(18)
        expect(pixels[3]).toBe(255)
      }
    }
    mark("fixture-red-wgc-frame")
    expect(frame.capabilities.keyboardInput).toBe(false)
    await host.stop()
    expect(lifecycle.every((item) => item.kernelClosed)).toBe(true)
    expect((await inspectNativeDesktopMaintenance(directory))?.entries ?? []).toEqual([])
    mark("kernel-closed")
    await writeFile(
      join(proofRoot, "acceptance-evidence.json"),
      JSON.stringify(
        {
          version: 1,
          platform: process.platform,
          architecture: process.arch,
          runId,
          packageManifestSha256: windowsNative.manifestSha256,
          fixtureSha256: actualHash,
          selected,
          approvals,
          effects,
          lifecycle,
          events,
          modelCalls,
          controlledSse: true,
          windowsKernelExecuted: true,
          exactComReleaseCountMeasured: false,
          externalModelUsed: false
        },
        null,
        2
      ),
      { flag: "wx" }
    )
    await unlink(modelFile)
  },
  60_000
)
