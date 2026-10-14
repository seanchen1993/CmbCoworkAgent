import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import type { ModObject } from "../../shared/mods/types"
import { ModGuestRuntime, type ModHostCall } from "./guest-runtime"
import { ModsManager } from "./manager"
import { FunctionModsManager } from "./v2/manager"
import { dispatchFunctionStream, type FunctionStreamOptions } from "./v2/stream-dispatcher"
import { withFunctionAgentExecution } from "./v2/host-call"

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {} },
  dialog: {}
}))
vi.mock("./runtime-client", () => ({
  ModRuntimeClient: class {
    version = 0
    guests = new Map<string, ModGuestRuntime>()
    async load(id: string, code: string) {
      const guest = await ModGuestRuntime.create(code)
      this.guests.set(id, guest)
      return guest.registrations
    }
    invoke(id: string, handler: string, input: ModObject, host: ModHostCall) {
      return this.guests.get(id)!.invoke(handler, input, host)
    }
    stop() {
      for (const guest of this.guests.values()) guest.dispose()
      this.guests.clear()
      this.version++
    }
  }
}))
const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})
const secret = "sk-fixture-secret-123456789"
function fixture(enabled = false, policy = true) {
  const root = mkdtempSync(join(tmpdir(), "mods-policy-model-"))
  const plugins = vi.fn(() => [])
  const manager = new ModsManager(
    join(root, "control.sqlite"),
    plugins,
    async () => true,
    () => {}
  )
  manager.configure(root, enabled, policy)
  const workspace = manager.workspaceKey(root)
  const instance = manager.createRuntimeAuthority({ workspace, threadId: "thread", turnId: "turn" })
  const binding = {
    workspace,
    threadId: "thread",
    turnId: "turn",
    runtimeAuthority: instance.authority
  }
  cleanup.push(() => {
    manager.close()
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("mods-policy-model-")
    )
      throw Error("Unexpected cleanup target")
    rmSync(root, { recursive: true, force: true })
  })
  cleanup.push(manager.bindThread(binding))
  const lifecycle = vi.fn(
    async (
      _w: string,
      _t: string,
      input: ModObject,
      core: FunctionStreamOptions["core"],
      signal: AbortSignal
    ) => dispatchFunctionStream([], input, { core, signal })
  )
  manager.attachFunctions({
    invalidate: vi.fn(),
    closeThread: vi.fn(),
    close: vi.fn(),
    turnStep: lifecycle
  })
  const run = <T>(fn: () => Promise<T>) =>
    withFunctionAgentExecution(
      { ...binding, agentId: "main", leased: true, immediate: false, userInitiated: false },
      fn
    )
  return {
    root,
    manager,
    workspace,
    binding,
    authority: instance.authority,
    plugins,
    lifecycle,
    run
  }
}

it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true]
])(
  "native model gate keeps enabled=%s policy=%s separate from plugin permission",
  async (enabled, policy) => {
    const f = fixture(enabled, policy)
    const core: FunctionStreamOptions["core"] = async function* () {
      yield { text: "ordinary" }
      return { text: "complete" }
    }
    const opening = f.manager.functionModelStream(
      f.authority,
      {},
      core,
      new AbortController().signal
    )
    if (!enabled && !policy) {
      await expect(opening).rejects.toThrow("MODS_MODEL_OPERATION_UNSUPPORTED")
      return
    }
    const stream = await opening
    expect(await stream.next()).toEqual({ done: false, value: { text: "ordinary" } })
    expect(await stream.next()).toEqual({ done: true, value: { text: "complete" } })
    await expect(stream.result).resolves.toEqual({ text: "complete" })
    expect(f.lifecycle).toHaveBeenCalledTimes(enabled ? 1 : 0)
    expect(f.plugins).not.toHaveBeenCalled()
  }
)

it("policy-only input, streamed chunks and terminal values use the real isolated policy", async () => {
  const f = fixture()
  const stream = await f.manager.functionModelStream(
    f.authority,
    { text: secret },
    async function* (input) {
      expect(input.text).toBe("[REDACTED]")
      yield { text: secret }
      return { answer: secret }
    },
    new AbortController().signal
  )
  expect((await stream.next()).value).toEqual({ text: "[REDACTED]" })
  expect((await stream.next()).value).toEqual({ answer: "[REDACTED]" })
  await expect(stream.result).resolves.toEqual({ answer: "[REDACTED]" })
  expect(f.lifecycle).not.toHaveBeenCalled()
  expect(f.plugins).not.toHaveBeenCalled()
})

it("policy-only context protects both file provenance and actual text without restoring removed files", async () => {
  const f = fixture()
  await f.run(async () => {
    const result = await f.manager.promptComposition(
      f.workspace,
      "thread",
      "prompt.context",
      {
        blocks: [{ name: "claudeMd", text: secret }],
        instructionFiles: [{ path: join(f.root, "AGENTS.md"), kind: "project", content: secret }]
      },
      new AbortController().signal,
      async (input) => {
        expect(JSON.stringify(input)).not.toContain(secret)
        return { blocks: [{ name: "claudeMd", text: secret }] }
      }
    )
    expect(result.instructionFiles).toBeUndefined()
    expect(result.blocks).toEqual([{ name: "claudeMd", text: "[REDACTED]" }])
    expect(
      await f.manager.presentationEvent(
        f.workspace,
        "thread",
        "skill.prompt",
        { text: secret },
        new AbortController().signal
      )
    ).toEqual({ text: "[REDACTED]" })
  })
  expect(f.lifecycle).not.toHaveBeenCalled()
  expect(f.plugins).not.toHaveBeenCalled()
})

it.each(["rebind", "toggle", "cancel"])(
  "policy publication rejects an original owner %s",
  async (mode) => {
    const f = fixture()
    const signal = new AbortController()
    const original = f.manager.publish.bind(f.manager)
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    vi.spyOn(f.manager, "publish").mockImplementation(async (...args) => {
      entered.resolve()
      await release.promise
      return original(...args)
    })
    const opening = f.manager.functionModelStream(
      f.authority,
      {},
      async function* () {
        yield { text: "must not reach provider" }
        return {}
      },
      signal.signal
    )
    const rejection = expect(opening).rejects.toThrow()
    await entered.promise
    if (mode === "rebind") cleanup.push(f.manager.bindThread({ ...f.binding }))
    if (mode === "toggle") {
      f.manager.configure(f.root, false, false)
      f.manager.configure(f.root, false, true)
    }
    if (mode === "cancel") signal.abort()
    release.resolve()
    await rejection
  }
)

it("a real native task obtains only its own protected model authority with Mods disabled", async () => {
  const f = fixture()
  await f.manager.withSharedAgent(
    f.authority,
    "native-task",
    new AbortController().signal,
    { blockedToolNames: new Set(), readOnly: true },
    async () => {
      const child = f.manager.functionSharedModelAuthority(f.authority, "general-purpose")
      expect(child).not.toBe(f.authority)
      expect(child.agentId).toBe("native-task")
      expect(() => f.manager.functionSharedModelAuthority(f.authority, "other-role")).toThrow(
        "MODS_TASK_OWNER_REQUIRED"
      )
      const stream = await f.manager.functionModelStream(
        child,
        {},
        async function* () {
          yield { text: secret }
          return {}
        },
        new AbortController().signal
      )
      expect((await stream.next()).value).toEqual({ text: "[REDACTED]" })
      await stream.next()
      await stream.result
    },
    undefined,
    { description: "native task", type: "general-purpose" }
  )
  expect(f.lifecycle).not.toHaveBeenCalled()
})

it("enabled with no installed components still protects all model publications without loading a guest", async () => {
  const f = fixture(true, true)
  const load = vi.fn()
  const functions = new FunctionModsManager(
    f.manager.store,
    {
      plugins: f.plugins,
      enabled: () => true,
      changed: () => {},
      publish: (workspace, value, signal) => f.manager.publish(workspace, value, undefined, signal)
    },
    () => ({ load, stop: () => {} })
  )
  cleanup.push(() => functions.close())
  const stream = await functions.turnStep(
    f.workspace,
    "thread",
    { text: secret },
    async function* (input) {
      expect(input.text).toBe("[REDACTED]")
      yield { text: secret }
      return { answer: secret }
    },
    new AbortController().signal
  )
  expect((await stream.next()).value).toEqual({ text: "[REDACTED]" })
  expect((await stream.next()).value).toEqual({ answer: "[REDACTED]" })
  await stream.result
  expect(load).not.toHaveBeenCalled()
})

it.each(["prompt", "presentation", "empty stream"])(
  "%s publication rejects a same-authority native binding replacement",
  async (path) => {
    const f = fixture(path === "empty stream", true)
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    const original = f.manager.publish.bind(f.manager)
    vi.spyOn(f.manager, "publish").mockImplementation(async (...args) => {
      entered.resolve()
      await release.promise
      return original(...args)
    })
    let providerCalls = 0
    if (path === "empty stream") {
      const functions = new FunctionModsManager(
        f.manager.store,
        {
          plugins: f.plugins,
          enabled: () => true,
          changed: () => {},
          publish: (workspace, value, signal) =>
            f.manager.publish(workspace, value, undefined, signal)
        },
        () => ({ load: vi.fn(), stop: () => {} })
      )
      cleanup.push(() => functions.close())
      f.manager.attachFunctions({
        invalidate: vi.fn(),
        closeThread: vi.fn(),
        close: vi.fn(),
        turnStep: functions.turnStep.bind(functions)
      })
    }
    const pending = f.run(async () => {
      const signal = new AbortController().signal
      if (path === "prompt")
        return f.manager.promptComposition(
          f.workspace,
          "thread",
          "prompt.section",
          { name: "native", text: secret },
          signal,
          async () => {
            providerCalls++
            return { text: "unsafe" }
          }
        )
      if (path === "presentation")
        return f.manager.presentationEvent(
          f.workspace,
          "thread",
          "skill.prompt",
          { text: secret },
          signal
        )
      const stream = await f.manager.functionModelStream(
        f.authority,
        {},
        async function* () {
          providerCalls++
          yield { text: "unsafe" }
          return {}
        },
        signal
      )
      return stream.next()
    })
    const rejected = expect(pending).rejects.toThrow("MODS_CALL_SCOPE_CHANGED")
    await entered.promise
    cleanup.push(f.manager.bindThread({ ...f.binding }))
    release.resolve()
    await rejected
    expect(providerCalls).toBe(0)
  }
)

it.each([false, true])(
  "protected attachment validates input/result with Mods enabled=%s",
  async (enabled) => {
    const f = fixture(enabled, true)
    await f.run(async () => {
      const core = vi.fn(async (input: ModObject) => ({ text: input.text }))
      const input = { type: "native", text: secret, origin: { kind: "engine" } }
      expect(
        await f.manager.promptComposition(
          f.workspace,
          "thread",
          "prompt.attachment",
          input,
          new AbortController().signal,
          core
        )
      ).toEqual({ text: "[REDACTED]" })
      expect(core).toHaveBeenCalledOnce()
      await expect(
        f.manager.promptComposition(
          f.workspace,
          "thread",
          "prompt.attachment",
          { ...input, origin: { kind: "forged" } },
          new AbortController().signal,
          core
        )
      ).rejects.toThrow("MODS_PROMPT_ATTACHMENT_INPUT")
      expect(core).toHaveBeenCalledOnce()
      await expect(
        f.manager.promptComposition(
          f.workspace,
          "thread",
          "prompt.attachment",
          input,
          new AbortController().signal,
          async () => ({ text: "ok", extra: "invalid" })
        )
      ).rejects.toThrow("MODS_PROMPT_ATTACHMENT_RESULT")
    })
  }
)
