import { readFileSync } from "node:fs"
import { EventEmitter } from "node:events"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { afterEach, expect, it, vi } from "vitest"
import { ModError } from "../mods/errors"
import { modCallContext } from "../mods/context"
import { ModRuntimeAuthorities, type ModRuntimeAuthority } from "../mods/runtime-instance"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../agent/thread-run-lease"
import {
  currentFunctionExecution, functionExecutionScope, withFunctionExecution, withFunctionWriteLease
} from "../mods/v2/execution-context"
import {
  functionCallAgent, functionCallAuthority, functionCallTurn, withFunctionTransportExecution
} from "../mods/v2/host-call"
import { captureFunctionUiResolveExecution } from "../mods/v2/ui-resolve-execution"
import {
  captureFunctionMarkdownDisplay, captureFunctionMarkdownFrame, withFunctionMarkdownDisplay
} from "../mods/v2/markdown-display-scope"
import {
  captureThreadIncarnation, matchesThreadIncarnation, type ThreadIncarnationRow
} from "../services/thread-incarnation"
import { encodeModJson, parseModJson } from "../../shared/mods/validation"

const channels = ["mods:function-panes", "mods:function-site-mount",
  "mods:function-site-mount-outcome", "mods:function-site-render"] as const
const allChannels = [...channels, "mods:commands", "mods:enqueue"] as const
const registries: ModRuntimeAuthorities[] = []
afterEach(() => {
  for (const registry of registries.splice(0)) registry.close()
  releaseLocalThreadRunLease("display-thread", "mods", "display-test")
})

interface DisplayEvent {
  sender: object
  senderFrame: { url: string }
}
interface DisplayInput {
  threadId: string
  component: string
  owner: string
  messageId: string
  expectedRequestId: string
  props: { text: string }
}
type Handler = (event: DisplayEvent, input: unknown) => Promise<unknown>
type Display = (event: DisplayEvent, threadId: string,
  run: (workspace: string) => Promise<unknown>) => Promise<unknown>

/** Native lifecycle events exercise the real frame helper even when the frame object is reused. */
class DisplayContents extends EventEmitter {
  private destroyed = false

  constructor(readonly mainFrame: { url: string }) {
    super()
  }

  isDestroyed(): boolean { return this.destroyed }

  destroy(): void {
    this.destroyed = true
    this.emit("destroyed")
  }
}

function fixture() {
  const source = ts.createSourceFile("mods.ts",
    readFileSync(resolve("src/main/ipc/mods.ts"), "utf8"), ts.ScriptTarget.Latest, true)
  const helperNames = new Set(["trusted", "scope", "threadScope", "readThreadWorkspacePath", "withDisplayExecution",
    "writableScope", "writableThreadScope"])
  const helpers: ts.FunctionDeclaration[] = []
  const handlerNodes: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && helperNames.has(node.name.text))
      helpers.push(node)
    if (ts.isCallExpression(node) && node.expression.getText(source) === "ipcMain.handle") {
      const channel = node.arguments[0]
      if (channel && ts.isStringLiteral(channel) &&
        allChannels.some(name => name === channel.text)) handlerNodes.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  expect(helpers).toHaveLength(7)
  expect(handlerNodes).toHaveLength(6)
  const handlers = new Map<string, Handler>()
  let row: ThreadIncarnationRow | undefined = {
    created_at: 1,
    metadata: JSON.stringify({ workspacePath: "/display-project", cmb_thread_incarnation: "R1" })
  }
  const threadId = "display-thread"
  const nativeDirectory = "C:/native/main"
  const senderFrame = { url: pathToFileURL(join(nativeDirectory, "../renderer/index.html")).href }
  const sender = new DisplayContents(senderFrame)
  const event = { sender, senderFrame }
  const owner = { webContents: sender }
  let userFacts: { runtimeAuthority?: ModRuntimeAuthority; turnId?: string; agentId?: string } = {}
  const functionUserScope = vi.fn(() => userFacts)
  const operation = vi.fn(async () => {
    expect(currentFunctionExecution()).toMatchObject({
      userInitiated: false, leased: false, immediate: true
    })
    const displayScope = captureFunctionMarkdownDisplay()
    expect(displayScope).toBeDefined()
    displayScope!.assertCurrent()
    return captureFunctionUiResolveExecution("/display-project", threadId)
  })
  const descriptor = { apiVersion: "cmb.mods/v2", command: "actual-command",
    digest: "actual-digest", grantEpoch: 1, workspaceEpoch: 1,
    modId: "function:actual", immediate: false }
  const nativeCommands = vi.fn(async () => {
    await operation()
    return [descriptor]
  })
  const legacyCommands = vi.fn(async () => [{ command: "legacy-command" }])
  const runCommand = vi.fn(async () => {
    expect(currentFunctionExecution()).toMatchObject({ userInitiated: true,
      leased: true, immediate: false })
    return { text: "actual command ran" }
  })
  let queued: ((signal: AbortSignal) => Promise<unknown>) | undefined
  const enqueue = vi.fn((_workspace: string, _thread: string, _command: string,
    run: (signal: AbortSignal) => Promise<unknown>) => {
    queued = run
    return { job: "actual-job" }
  })
  const functions = {
    panes: operation, siteMount: operation, siteMountOutcome: operation, siteRender: operation,
    commands: nativeCommands, runCommand
  }
  const code = ts.transpileModule([
    ...helpers.map(node => node.getText(source)),
    ...handlerNodes.map(node => node.getText(source)),
    "withDisplayExecution"
  ].join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  const display: Display = runInNewContext(code, {
    ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
    process: { env: {} }, URL, __dirname: nativeDirectory, join, pathToFileURL,
    window: () => owner, getThreadCore: (id: string) => id === threadId ? row : undefined,
    manager: { workspaceKey: (workspace: string) => workspace, functionUserScope,
      commands: legacyCommands, isEnabled: () => true }, functions, queue: { enqueue },
    ModError, functionExecutionScope, functionCallAgent, functionCallAuthority, functionCallTurn,
    withFunctionTransportExecution, withFunctionExecution,
    captureFunctionMarkdownFrame, withFunctionMarkdownDisplay,
    captureThreadIncarnation, matchesThreadIncarnation,
    encodeModJson, parseModJson
  })
  const input: DisplayInput = { threadId, component: "AskUserQuestion", owner: "actual-owner",
    messageId: "actual-message", expectedRequestId: "actual-request-R1", props: { text: "safe" } }
  return { display, event, input, handlers, operation, functionUserScope, descriptor,
    nativeCommands, legacyCommands, enqueue, runCommand,
    runQueued: () => { if (!queued) throw new Error("no actual queued callback")
      return queued(new AbortController().signal) },
    setRow: (value: ThreadIncarnationRow | undefined) => { row = value },
    setUserFacts: (value: typeof userFacts) => { userFacts = value },
    facts: { workspace: "/display-project", threadId, agentId: "actual-child",
      turnId: "actual-turn", userInitiated: true, leased: false, immediate: false } }
}

it.each(channels)("enters a cold read-only native identity through actual %s", async channel => {
  const f = fixture()
  const value = await f.handlers.get(channel)!(f.event,
    channel === "mods:function-panes" ? f.input.threadId : f.input)
  expect(value).toMatchObject({ workspace: f.facts.workspace, threadId: f.facts.threadId,
    agentId: "main", turnId: undefined, runtimeAuthority: undefined })
  expect(f.operation).toHaveBeenCalledTimes(1)
  expect(f.operation.mock.calls[0]).toEqual(channel === "mods:function-panes"
    ? [f.facts.workspace, f.facts.threadId] : channel === "mods:function-site-mount"
      ? [f.facts.workspace, f.facts.threadId, f.input.component, f.input.messageId]
      : channel === "mods:function-site-mount-outcome"
        ? [f.facts.workspace, f.facts.threadId, f.input.component, f.input.messageId,
            f.input.expectedRequestId]
        : [f.facts.workspace, f.facts.threadId, f.input.owner, f.input.props])
  expect(currentFunctionExecution()).toBeUndefined()
})

it("keeps legacy command discovery and enters only the native catalog through display transport",
  async () => {
    const f = fixture()
    expect(await f.handlers.get("mods:commands")!(f.event, f.facts.threadId))
      .toEqual([{ command: "legacy-command" }, f.descriptor])
    expect(f.legacyCommands).toHaveBeenCalledWith(f.facts.workspace, f.facts.threadId)
    expect(f.nativeCommands).toHaveBeenCalledWith(f.facts.workspace, f.facts.threadId)
    expect(f.operation).toHaveBeenCalledTimes(1)
    expect(currentFunctionExecution()).toBeUndefined()
  })

it("looks up a native descriptor read-only and retains the original actual command authorization",
  async () => {
    const f = fixture()
    const value = await f.handlers.get("mods:enqueue")!(f.event, {
      threadId: f.facts.threadId, descriptor: f.descriptor, args: { text: "actual arguments" }
    })
    expect(value).toBe("actual-job")
    expect(f.operation).toHaveBeenCalledTimes(1)
    expect(f.runCommand).not.toHaveBeenCalled()
    expect(f.enqueue).toHaveBeenCalledWith(f.facts.workspace, f.facts.threadId,
      f.descriptor.command, expect.any(Function), { immediate: false, inlineResult: true })
    expect(claimLocalThreadRunLease({ threadId: f.facts.threadId,
      owner: "mods", runId: "display-test" }).acquired).toBe(true)
    expect(await f.runQueued()).toEqual({ text: "actual command ran" })
    expect(f.runCommand).toHaveBeenCalledWith(f.facts.workspace, f.facts.threadId,
      f.descriptor, "actual arguments", expect.any(AbortSignal))
    expect(f.legacyCommands).not.toHaveBeenCalled()
    expect(currentFunctionExecution()).toBeUndefined()
  })

it("retains a current bound main runtime without minting an authority", async () => {
  const f = fixture()
  const registry = new ModRuntimeAuthorities()
  registries.push(registry)
  const runtime = registry.create({ ...f.facts, agentId: "main" })
  f.setUserFacts({ runtimeAuthority: runtime.authority, agentId: "main", turnId: f.facts.turnId })
  await f.display(f.event, f.facts.threadId, async () => {
    expect(currentFunctionExecution()).toMatchObject({ runtimeAuthority: runtime.authority,
      agentId: "main", turnId: f.facts.turnId, userInitiated: false, leased: false, immediate: true })
  })
  expect(f.functionUserScope).toHaveBeenCalledTimes(1)
})

it("preserves an actual hot child and clears its human write lease", async () => {
  const f = fixture()
  const registry = new ModRuntimeAuthorities()
  registries.push(registry)
  const runtime = registry.create(f.facts)
  expect(claimLocalThreadRunLease({ threadId: f.facts.threadId,
    owner: "mods", runId: "display-test" }).acquired).toBe(true)
  await withFunctionExecution({ ...f.facts, runtimeAuthority: runtime.authority, leased: true },
    () => withFunctionWriteLease(f.facts.workspace, f.facts.threadId, () =>
      f.display(f.event, f.facts.threadId, async () => {
        expect(currentFunctionExecution()).toMatchObject({ agentId: f.facts.agentId,
          turnId: f.facts.turnId, runtimeAuthority: runtime.authority,
          userInitiated: false, leased: false, immediate: true })
        await expect(withFunctionWriteLease(f.facts.workspace, f.facts.threadId, async () => {}))
          .rejects.toMatchObject({ code: "MODS_WRITE_REQUIRES_USER_ACTION" })
      })))
  expect(f.functionUserScope).not.toHaveBeenCalled()
})

it("rejects an expired actual entry instead of rebinding it to a cold UI owner", async () => {
  const f = fixture()
  const wake = Promise.withResolvers<void>()
  let late!: Promise<void>
  const effects = vi.fn(async () => {})
  await withFunctionExecution(f.facts, async () => {
    late = wake.promise.then(async () => {
      await expect(f.display(f.event, f.facts.threadId, effects))
        .rejects.toMatchObject({ code: "MODS_CALL_SCOPE_EXPIRED" })
    })
  })
  wake.resolve()
  await late
  expect(effects).not.toHaveBeenCalled()
  expect(f.functionUserScope).not.toHaveBeenCalled()
})

it("rejects an inherited different workspace before executing a native display", async () => {
  const f = fixture()
  await withFunctionExecution({ ...f.facts, workspace: "/different" }, async () => {
    await expect(f.display(f.event, f.facts.threadId, f.operation))
      .rejects.toMatchObject({ code: "MODS_CALL_SCOPE_CHANGED" })
  })
  expect(f.operation).not.toHaveBeenCalled()
  expect(f.functionUserScope).not.toHaveBeenCalled()
})

it("preserves a real ModCallContext and rejects its expired receipt without fallback", async () => {
  const f = fixture()
  const identity = { ...f.facts, callId: "actual-call", grantEpoch: 1,
    origin: "model" as const }
  let active = true
  const context = { identity, toolId: "actual-tool", routeClaimed: false,
    protectedOutput: false, readOnly: true,
    assertLive: () => { if (!active) throw new ModError("MODS_CALL_SCOPE_EXPIRED") } }
  await modCallContext.run(context, () => f.display(f.event, f.facts.threadId, async () => {
    expect(currentFunctionExecution()).toMatchObject({ agentId: f.facts.agentId,
      turnId: f.facts.turnId, userInitiated: false, leased: false })
    expect(modCallContext.getStore()).toBeUndefined()
  }))
  active = false
  await modCallContext.run(context, async () => {
    await expect(f.display(f.event, f.facts.threadId, f.operation))
      .rejects.toMatchObject({ code: "MODS_CALL_SCOPE_EXPIRED" })
  })
  expect(f.operation).not.toHaveBeenCalled()
  expect(f.functionUserScope).not.toHaveBeenCalled()
})

it("rejects a retired bound runtime rather than creating replacement authority", async () => {
  const f = fixture()
  const registry = new ModRuntimeAuthorities()
  registries.push(registry)
  const runtime = registry.create({ ...f.facts, agentId: "main" })
  f.setUserFacts({ runtimeAuthority: runtime.authority, agentId: "main", turnId: f.facts.turnId })
  runtime.release()
  await expect(f.display(f.event, f.facts.threadId, f.operation))
    .rejects.toMatchObject({ code: "MODS_RUNTIME_INSTANCE_EXPIRED" })
  expect(f.operation).not.toHaveBeenCalled()
})

it.each(["different-sender", "different-frame"])("rejects %s before execution", async kind => {
  const f = fixture()
  const event = kind === "different-sender"
    ? { ...f.event, sender: {} } : { ...f.event, senderFrame: { ...f.event.senderFrame } }
  await expect(f.display(event, f.facts.threadId, f.operation))
    .rejects.toMatchObject({ code: "MODS_IPC_SENDER" })
  expect(f.operation).not.toHaveBeenCalled()
})

it.each(["recreated", "workspace-changed", "deleted"])(
  "rejects a %s real thread before returning display publication", async change => {
    const f = fixture()
    const wake = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const result = f.display(f.event, f.facts.threadId, async () => {
      entered.resolve()
      await wake.promise
      return "must not publish"
    })
    await entered.promise
    f.setRow(change === "deleted" ? undefined : {
      created_at: 1, metadata: JSON.stringify({
        workspacePath: change === "workspace-changed" ? "/different" : f.facts.workspace,
        cmb_thread_incarnation: change === "recreated" ? "R2" : "R1"
      })
    })
    wake.resolve()
    await expect(result).rejects.toMatchObject({
      code: change === "deleted" ? "MODS_THREAD_MISSING" : "MODS_CALL_SCOPE_CHANGED"
    })
  }
)

it.each(["main-navigation", "render-process-gone", "destroyed"] as const)(
  "rejects %s during the actual display await even when the native frame object is unchanged",
  async change => {
    const f = fixture()
    const wake = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    const frame = f.event.sender.mainFrame
    let originalScope: ReturnType<typeof captureFunctionMarkdownDisplay>
    const result = f.display(f.event, f.facts.threadId, async () => {
      originalScope = captureFunctionMarkdownDisplay()
      expect(originalScope).toBeDefined()
      originalScope!.assertCurrent()
      entered.resolve()
      await wake.promise
      return "must not publish an old native drawing"
    })
    const rejected = expect(result).rejects.toMatchObject({ code: "MODS_UI_MARKDOWN_STALE" })
    await entered.promise
    if (change === "main-navigation")
      f.event.sender.emit("did-start-navigation", { isMainFrame: true })
    if (change === "render-process-gone") f.event.sender.emit("render-process-gone")
    if (change === "destroyed") f.event.sender.destroy()
    expect(f.event.sender.mainFrame).toBe(frame)
    expect(() => originalScope!.assertCurrent()).toThrow("MODS_UI_MARKDOWN_STALE")
    wake.resolve()
    await rejected
    expect(currentFunctionExecution()).toBeUndefined()
  }
)

it("retains the real native display epoch through a subframe navigation", async () => {
  const f = fixture()
  const wake = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  let originalScope: ReturnType<typeof captureFunctionMarkdownDisplay>
  const result = f.display(f.event, f.facts.threadId, async () => {
    originalScope = captureFunctionMarkdownDisplay()
    expect(originalScope).toBeDefined()
    entered.resolve()
    await wake.promise
    return "actual native publication"
  })
  await entered.promise
  f.event.sender.emit("did-start-navigation", { isMainFrame: false })
  originalScope!.assertCurrent()
  wake.resolve()
  expect(await result).toBe("actual native publication")
  expect(currentFunctionExecution()).toBeUndefined()
})
