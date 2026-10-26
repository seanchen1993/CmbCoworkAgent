import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock("../../app-attention-events", () => ({ emitAppAttention: () => {} }))
import {
  requestUserInput,
  getPendingUserInputForThread,
  submitUserInputResponse,
  cancelUserInputsForThread
} from "../../services/user-input"
import { FunctionModsManager } from "./manager"
import { FunctionGuestRuntime } from "./guest-runtime"
import { compileFunctionPlugin } from "./loader"
import { ModControlStore } from "../control-store"
import type { ModJson } from "../../../shared/mods/types"
import {
  currentRuntimePluginSource,
  issueRuntimePluginSourceToken,
  withRuntimePluginSource
} from "../../plugins/runtime-source-scope"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture(plainParent = false, warmup = true) {
  const root = mkdtempSync(join(tmpdir(), "mods-host-handoff-")),
    workspace = join(root, "workspace")
  mkdirSync(workspace)
  const make = (name: string, source: string) => {
    const path = join(root, name)
    mkdirSync(join(path, "mods"), { recursive: true })
    writeFileSync(
      join(path, "plugin.json"),
      JSON.stringify({ name, version: "1.0.0", mods: "mods/manifest.json" })
    )
    writeFileSync(
      join(path, "mods/manifest.json"),
      JSON.stringify({ apiVersion: "cmb.mods/v2", id: name, entry: "main.ts" })
    )
    writeFileSync(join(path, "mods/main.ts"), source)
    return { id: name + "-uuid", name, path, enabled: true }
  }
  const provider = make(
    "provider",
    `export function register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"provider",description:"Original provider"});return next(e)});
    on("command.run",{command:"provider"},async($)=>{await $.tool.call({tool:"read_file",file_path:"knowledge.txt"});return{text:"original-context"}})
  }`
  )
  const parent = make(
    "parent",
    `export function register(on){
    on("prompt.compose",async()=>({sections:[]}));
    on("session.start",async($,e,next)=>{await $.command.register({name:"parent",description:"Exact parent"});return next(e)})
  }`
  )
  if (plainParent) {
    rmSync(join(parent.path, "mods"), { recursive: true })
    writeFileSync(join(parent.path, "plugin.json"),
      JSON.stringify({ name: parent.name, version: "1.0.0" }))
    mkdirSync(join(parent.path, "hooks"))
    writeFileSync(join(parent.path, "hooks/hooks.json"), JSON.stringify({ hooks: {
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "python check.py" }] }]
    } }))
    writeFileSync(join(parent.path, "hooks/check.py"), "print('{}')\n")
  }
  const retained = join(root, "retained")
  cpSync(parent.path, retained, { recursive: true })
  const store = new ModControlStore(join(root, "control.sqlite"))
  let onTool = async () => {},
    onLoad = async () => {},
    onPublish: (value: ModJson) => Promise<void> = async () => {},
    onDrain = async () => {},
    drains = 0,
    active = true
  const guests: FunctionGuestRuntime[] = []
  const changed = vi.fn()
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => [provider, parent],
      enabled: () => true,
      protects: () => true,
      captureSiteGuard: () => () => {},
      captureDisplayScope: (_, threadId) => ({ database: store, workspace, threadId,
        incarnation: { token: "incarnation", legacyCreatedAt: 1 }, assertCurrent: () => {} }),
      pendingQuestion: (threadId) => getPendingUserInputForThread(threadId),
      changed,
      publish: async (_, value) => { await onPublish(value); return value },
      clawApplicable: () => false,
      callTool: async () => {
        await onTool()
        return { text: "actual-read", result: { text: "actual-read" } }
      }
    },
    () => {
      const local: FunctionGuestRuntime[] = []
      return {
        async load(code, options) {
          await onLoad()
          const guest = await FunctionGuestRuntime.create(code, options)
          guests.push(guest)
          local.push(guest)
          return guest
        },
        stop() {
          for (const guest of local) void guest.dispose()
        },
        async stopAndDrain() {
          await onDrain()
          drains++
          await Promise.all(local.map((guest) => guest.dispose()))
        }
      }
    }
  )
  cleanup.push(
    () => rmSync(root, { recursive: true, force: true }),
    () => store.close(),
    async () => {
      cancelUserInputsForThread("stage", "test cleanup")
      onDrain = async () => {}
      manager.close()
      await Promise.all(guests.map((guest) => guest.dispose()))
    }
  )
  const compiledProvider = await compileFunctionPlugin(provider.path)
  store.grant(workspace, `function:${compiledProvider.name}`, compiledProvider.digest, true)
  const plugin = { ...parent, path: retained }
  const input = {
    workspace,
    plugin,
    scope: { projectId: "project", packageDigest: "a".repeat(64) }
  }
  const facts = await manager.prepareRuntimeSourceFacts(input)
  if (facts) await manager.approveRuntimeSource({ ...input, digest: facts.digest }, () => {})
  const token = issueRuntimePluginSourceToken(
    {
      mode: "host",
      capabilitySources: [],
      preserveParentContext: true,
      threadId: "stage",
      incarnationKey: "incarnation",
      projectId: "project",
      operationId: "operation",
      workspace,
      packageDigest: "a".repeat(64),
      stageId: "draft",
      plugin: {
        ...plugin,
        version: "1.0.0",
        description: "",
        author: "",
        skillCount: 1,
        mcpServerCount: 0,
        hookCount: 0,
        createdAt: "2026-10-18",
        updatedAt: "2026-10-18"
      }
    },
    () => {
      if (!active) throw Error("PROJECT_REVOKED")
    },
    () => {
      if (!active) throw Error("PROJECT_REVOKED")
    }
  )
  const before = warmup ? await manager.commands(workspace, "stage") : []
  if (warmup) expect(before.map((command) => command.command)).toEqual(["provider"])
  return {
    manager,
    workspace,
    store,
    token,
    input,
    facts,
    provider,
    before,
    guests,
    changed,
    onPublish: (run: (value: ModJson) => Promise<void>) => { onPublish = run },
    onLoad: (run: () => Promise<void>) => { onLoad = run },
    drains: () => drains,
    onTool: (run: () => Promise<void>) => {
      onTool = run
    },
    onDrain: (run: () => Promise<void>) => {
      onDrain = run
    },
    revoke: () => {
      active = false
    }
  }
}

it("keeps the ordinary owner usable until every retained capability has exact project consent", async () => {
  const f = await fixture(true)
  const binding = withRuntimePluginSource(f.token, () => currentRuntimePluginSource()!)
  const plugin = { ...binding.plugin, ...f.provider }
  const token = issueRuntimePluginSourceToken({
    ...binding,
    capabilitySources: [{
      plugin,
      packageDigest: "b".repeat(64),
      capability: { id: "context", title: "Context", kind: "skill", usage: "project",
        entry: "skills/context/SKILL.md", dependsOn: [] }
    }]
  })
  const prior = [...f.guests], drains = f.drains()
  await expect(withRuntimePluginSource(token, () =>
    f.manager.runtimeReady(f.workspace, "stage"))).rejects.toThrow("PROJECT_MODS_APPROVAL_REQUIRED")
  expect(f.drains()).toBe(drains)
  expect(prior.every(guest => !guest.stats.disposed)).toBe(true)
  expect((await f.manager.commands(f.workspace, "stage")).map(row => row.command))
    .toEqual(["provider"])
  const input = { workspace: f.workspace, plugin, scope: f.input.scope }
  const facts = await f.manager.prepareRuntimeSourceFacts(input)
  await f.manager.approveRuntimeSource({ ...input, digest: facts!.digest }, () => {})
  expect((await withRuntimePluginSource(token, () =>
    f.manager.commands(f.workspace, "stage"))).map(row => row.command)).toEqual(["provider"])
  expect(prior.every(guest => guest.stats.disposed)).toBe(true)
})

it("retires the actual provider VM before loading exact-consent parent Mods for the same Host thread", async () => {
  const f = await fixture(),
    prior = [...f.guests]
  const providerGrant = f.store.getGrant(f.workspace, "function:provider")
  expect(
    await f.manager.runCommand(f.workspace, "stage", f.before[0], "", new AbortController().signal)
  ).toEqual({ text: "original-context" })
  const result = await withRuntimePluginSource(f.token, () =>
    f.manager.classicEvent(
      f.workspace,
      "stage",
      "prompt.compose",
      {
        model: "fixture",
        promptModel: "fixture",
        surfaces: ["desktop"],
        tools: [],
        traits: [],
        outputStyle: null
      },
      new AbortController().signal,
      async () => ({ sections: [{ id: "native", scope: "session", text: "must-remove" }] })
    )
  )
  expect(result).toEqual({ sections: [] })
  expect(prior.every((guest) => guest.stats.disposed)).toBe(true)
  expect(f.drains()).toBeGreaterThan(0)
  expect(
    (await withRuntimePluginSource(f.token, () => f.manager.commands(f.workspace, "stage"))).map(
      (row) => row.command
    )
  ).toEqual(["parent"])
  expect(f.store.getGrant(f.workspace, "function:parent")).toBeNull()
  expect(f.store.getGrant(f.workspace, "function:provider")).toEqual(providerGrant)
  expect(
    f.store.getProjectFunctionGrant(f.workspace, "project", "a".repeat(64), "parent")?.digest
  ).toBe(f.facts!.digest)
  // Original native UI callbacks retain the new exact owner's lexical guard without ambient ALS.
  expect((await f.manager.commands(f.workspace, "stage")).map((row) => row.command)).toEqual([
    "parent"
  ])
  await expect(
    f.manager.runCommand(f.workspace, "stage", f.before[0], "", new AbortController().signal)
  ).rejects.toThrow()
  const binding = withRuntimePluginSource(f.token, () => currentRuntimePluginSource()!)
  const other = issueRuntimePluginSourceToken({ ...binding, operationId: "other-operation" })
  await expect(
    withRuntimePluginSource(other, () => f.manager.commands(f.workspace, "stage"))
  ).rejects.toThrow("MODS_RUNTIME_SOURCE_CHANGED")
})

it.each([false, true])(
  "retires an exact Host Guest using its project grant without a workspace grant (revoked=%s)",
  async revoked => {
    const f = await fixture()
    expect((await withRuntimePluginSource(f.token, () =>
      f.manager.commands(f.workspace, "stage"))).map(row => row.command)).toEqual(["parent"])
    expect(f.store.getGrant(f.workspace, "function:parent")).toBeNull()
    const projectGrant = f.store.getProjectFunctionGrant(
      f.workspace, "project", "a".repeat(64), "parent")!
    expect(projectGrant).toMatchObject({ enabled: true, digest: f.facts!.digest })
    const liveGuests = f.guests.filter(guest => !guest.stats.disposed)
    expect(liveGuests).toHaveLength(1)
    const drains = f.drains()
    // Operation-tail retirement has no ambient source scope. The captured grant must
    // retain its original project identity rather than fall back to workspace consent.
    const captured = f.manager.captureIdleThreadRetirement(f.workspace, "stage")
    expect(captured.resident).toBe(true)
    if (revoked) {
      f.store.grantProjectFunction(
        f.workspace, "project", "a".repeat(64), "parent", f.facts!.digest, false)
      expect(() => captured.retire()).toThrow("MODS_GRANT_REVOKED")
      expect(f.drains()).toBe(drains)
      expect(liveGuests.every(guest => !guest.stats.disposed)).toBe(true)
    } else {
      await captured.retire()
      expect(f.drains()).toBe(drains + 1)
      expect(liveGuests.every(guest => guest.stats.disposed)).toBe(true)
      expect(f.manager.runtimeSessions()).toMatchObject({ resident: 0, reserved: 0 })
      expect(f.store.getProjectFunctionGrant(
        f.workspace, "project", "a".repeat(64), "parent")).toEqual(projectGrant)
    }
    expect(f.store.getGrant(f.workspace, "function:parent")).toBeNull()
  }
)

it("retains a traditional-Hook-only Host owner through real live input and ordinary UI callbacks", async () => {
  const f = await fixture(true)
  expect(f.facts).toBeUndefined()
  const signal = new AbortController().signal
  const run = async <T>(work: () => Promise<T>) => withRuntimePluginSource(f.token, work)
  // No Function modules means no Function graph nodes, even though the Host has an identity.
  expect(await run(() => f.manager.runtimeReady(f.workspace, "stage", signal))).toBe(false)
  await run(() => f.manager.turnStart(f.workspace, "stage", { turnId: "live", text: "draft" }, signal))
  const generation = f.manager.runtimeSessions(f.workspace).sessions[0].generation
  const guests = f.guests.length
  const pending = requestUserInput({ threadId: "stage", abortSignal: signal,
    allowDeferredRenderer: true, questions: [{ id: "ui", header: "UI", question: "UI scope?",
      options: [{ label: "Backend only", description: "No UI" },
        { label: "Include UI", description: "Include frontend" }] }] })
  void pending.catch(() => {})
  const request = getPendingUserInputForThread("stage")!
  // These calls are outside the Host ALS, just like the native renderer while the tool waits.
  expect(await f.manager.commands(f.workspace, "stage")).toEqual([])
  const owner = await f.manager.siteMount(f.workspace, "stage", "AskUserQuestion", undefined,
    request.requestId)
  expect(owner).toBeTruthy()
  expect(await f.manager.siteRender(f.workspace, "stage", owner!, {
    tool: "request_user_input", questions: JSON.parse(JSON.stringify(request.questions)) as ModJson
  })).toBeTruthy()
  expect(submitUserInputResponse({ requestId: request.requestId, answers: { ui: {
    type: "option", questionId: "ui", optionIndex: 0, label: "Backend only", description: "No UI"
  } } })).toBe(true)
  expect((await pending).answers.ui).toMatchObject({ optionIndex: 0 })
  await f.manager.siteUnmount(f.workspace, "stage", owner!)
  const stream = await run(() => f.manager.turnStep(f.workspace, "stage",
    { turnId: "live", index: 1, messageCount: 3, model: "native" },
    async function* () { yield { kind: "text", text: "continued" }; return { answer: "continued" } }, signal))
  for await (const chunk of stream) expect(chunk).toEqual({ kind: "text", text: "continued" })
  expect(await stream.result).toEqual({ answer: "continued" })
  await run(() => f.manager.turnComplete(f.workspace, "stage", {
    turnId: "live", answer: "continued", durationMs: 1, isAborted: false, reason: "answer"
  }, signal))
  expect(f.manager.runtimeSessions(f.workspace).sessions[0].generation).toBe(generation)
  expect(f.guests).toHaveLength(guests)
  expect(await run(() => f.manager.runtimeReady(f.workspace, "stage", signal))).toBe(false)
  const binding = withRuntimePluginSource(f.token, () => currentRuntimePluginSource()!)
  const resumed = issueRuntimePluginSourceToken(binding)
  await expect(withRuntimePluginSource(resumed, () => f.manager.turnStart(f.workspace, "stage",
    { turnId: "resume", text: "saved answer" }, new AbortController().signal)))
    .rejects.toThrow("MODS_RUNTIME_SOURCE_CHANGED")
  f.manager.settleEmptyHostSource(f.token)
  f.revoke()
  await expect(run(() => f.manager.commands(f.workspace, "stage"))).rejects.toThrow("PROJECT_REVOKED")
  const history = await f.manager.siteMount(f.workspace, "stage", "AssistantMessage")
  expect(history).toBeTruthy()
  expect(await f.manager.siteRender(f.workspace, "stage", history!, {
    text: "continued", isFirstOfReply: true
  })).toBeTruthy()
  await f.manager.siteUnmount(f.workspace, "stage", history!)
  expect(await f.manager.siteRead(f.workspace, "stage", "AssistantMessage", {
    text: "continued", isFirstOfReply: true
  }, "history:assistant")).toMatchObject({ state: "projected" })
  expect(f.guests).toHaveLength(guests)
  await withRuntimePluginSource(resumed, () => f.manager.turnStart(f.workspace, "stage",
    { turnId: "resume", text: "saved answer" }, new AbortController().signal))
  expect(f.manager.runtimeSessions(f.workspace).sessions[0].generation).not.toBe(generation)
  expect(await f.manager.commands(f.workspace, "stage")).toEqual([])
})

it.each([true, false])("pins the Host turn owner before queued UI can rebuild (empty=%s)", async (empty) => {
  const f = await fixture(empty)
  const began = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  f.onDrain(async () => { began.resolve(); await release.promise })
  const starting = withRuntimePluginSource(f.token, () => f.manager.turnStart(f.workspace, "stage",
    { turnId: "handoff", text: "start" }, new AbortController().signal))
  await began.promise
  const drawingDiscovery = f.manager.commands(f.workspace, "stage")
  release.resolve()
  await starting
  expect((await drawingDiscovery).map(row => row.command)).toEqual(empty ? [] : ["parent"])
  const binding = withRuntimePluginSource(f.token, () => currentRuntimePluginSource()!)
  const foreign = issueRuntimePluginSourceToken({ ...binding, operationId: "another-operation" })
  await expect(withRuntimePluginSource(foreign, () => f.manager.commands(f.workspace, "stage")))
    .rejects.toThrow("MODS_RUNTIME_SOURCE_CHANGED")
  if (!empty) {
    f.manager.settleEmptyHostSource(f.token)
    await expect(withRuntimePluginSource(foreign, () => f.manager.commands(f.workspace, "stage")))
      .rejects.toThrow("MODS_RUNTIME_SOURCE_CHANGED")
  }
})

it.each(["ui-first", "host-first"] as const)(
  "serializes first runtimeReady and real UI construction (%s) through live continuation",
  async (order) => {
    const f = await fixture(true, false)
    const signal = new AbortController().signal
    const run = async <T>(work: () => Promise<T>) => withRuntimePluginSource(f.token, work)
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const drawing = () => f.manager.siteRead(f.workspace, "stage", "AssistantMessage",
      { text: "Preparing", isFirstOfReply: true }, "first:message")
    let drawn: ReturnType<typeof drawing>
    let prepared: Promise<boolean>
    let navigation: Promise<unknown> = Promise.resolve()
    if (order === "ui-first") {
      f.onLoad(async () => { entered.resolve(); await release.promise })
      drawn = drawing()
      await entered.promise
      navigation = Promise.all([
        f.manager.panes(f.workspace, "stage"), f.manager.logs(f.workspace, "stage"),
        f.manager.feedback(f.workspace, "stage"), f.manager.feedbackPresentation(f.workspace, "stage"),
        f.manager.commands(f.workspace, "stage"), f.manager.registeredTools(f.workspace, "stage")
      ])
      // This independent actual discovery completes while those reads await the held load.
      await f.manager.effectiveStatus(f.workspace, "stage")
      let ready = false
      prepared = run(() => f.manager.runtimeReady(f.workspace, "stage", signal))
        .then(value => { ready = true; return value })
      expect(ready).toBe(false)
      release.resolve()
    } else {
      prepared = run(() => f.manager.runtimeReady(f.workspace, "stage", signal))
      drawn = drawing()
    }
    await drawn
    await navigation
    expect(await prepared).toBe(false)
    const generation = f.manager.runtimeSessions(f.workspace).sessions[0].generation
    expect(f.changed).toHaveBeenCalledWith("stage", `source-replaced:${generation}`)
    const guestCount = f.guests.length
    if (order === "host-first") expect(guestCount).toBe(0)
    await run(() => f.manager.turnStart(f.workspace, "stage", { turnId: "first", text: "draft" }, signal))
    const pending = requestUserInput({ threadId: "stage", abortSignal: signal,
      allowDeferredRenderer: true, questions: [{ id: "ui", header: "UI", question: "UI scope?",
        options: [{ label: "Backend", description: "No UI" }, { label: "UI", description: "Frontend" }] }] })
    void pending.catch(() => {})
    const request = getPendingUserInputForThread("stage")!
    const owner = await f.manager.siteMount(f.workspace, "stage", "AskUserQuestion", undefined, request.requestId)
    expect(owner).toBeTruthy()
    await f.manager.siteRender(f.workspace, "stage", owner!, JSON.parse(JSON.stringify({
      tool: "request_user_input", questions: request.questions
    })) as Record<string, ModJson>)
    expect(submitUserInputResponse({ requestId: request.requestId, answers: { ui: {
      type: "option", questionId: "ui", optionIndex: 0, label: "Backend", description: "No UI"
    } } })).toBe(true)
    await pending
    await f.manager.siteUnmount(f.workspace, "stage", owner!)
    const stream = await run(() => f.manager.turnStep(f.workspace, "stage",
      { turnId: "first", index: 1, messageCount: 3, model: "native" },
      async function* () { yield { kind: "text", text: "continued" }; return { answer: "continued" } }, signal))
    for await (const chunk of stream) expect(chunk).toEqual({ kind: "text", text: "continued" })
    expect(await stream.result).toEqual({ answer: "continued" })
    await run(() => f.manager.turnComplete(f.workspace, "stage", {
      turnId: "first", answer: "continued", durationMs: 1, isAborted: false, reason: "answer"
    }, signal))
    const binding = withRuntimePluginSource(f.token, () => currentRuntimePluginSource()!)
    f.manager.settleEmptyHostSource(f.token)
    f.revoke()
    expect(await drawing()).toMatchObject({ state: "projected" })
    const resumed = issueRuntimePluginSourceToken(binding)
    expect(await withRuntimePluginSource(resumed, () => f.manager.runtimeReady(f.workspace, "stage")))
      .toBe(false)
    expect(f.manager.runtimeSessions(f.workspace).sessions[0].generation).not.toBe(generation)
    expect(f.guests).toHaveLength(guestCount)
  }
)

it("waits for every already-admitted UI read, including a non-constructor, before Host preparation", async () => {
  const f = await fixture(true, false)
  const loading = Promise.withResolvers<void>(), load = Promise.withResolvers<void>()
  const publishing = Promise.withResolvers<void>(), publish = Promise.withResolvers<void>()
  f.onLoad(async () => { loading.resolve(); await load.promise })
  f.onPublish(async value => {
    if (JSON.stringify(value).includes("Second drawing")) {
      publishing.resolve()
      await publish.promise
    }
  })
  const draw = (text: string) => f.manager.siteRead(f.workspace, "stage", "AssistantMessage",
    { text, isFirstOfReply: true }, text)
  const first = draw("First drawing")
  await loading.promise
  const second = draw("Second drawing")
  void second.catch(() => {})
  load.resolve()
  await publishing.promise
  await first
  let finished = false
  const preparing = withRuntimePluginSource(f.token, () => f.manager.runtimeReady(f.workspace, "stage"))
    .then(result => { finished = true; return result })
  expect(finished).toBe(false)
  publish.resolve()
  await second
  expect(await preparing).toBe(false)
  expect(await f.manager.commands(f.workspace, "stage")).toEqual([])
})

it("never replaces an actually running provider call or borrows its active grant", async () => {
  const f = await fixture(),
    started = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  f.onTool(async () => {
    started.resolve()
    await release.promise
  })
  const running = f.manager.runCommand(
    f.workspace,
    "stage",
    f.before[0],
    "",
    new AbortController().signal
  )
  await started.promise
  try {
    await expect(
      withRuntimePluginSource(f.token, () => f.manager.commands(f.workspace, "stage"))
    ).rejects.toThrow("MODS_RUNTIME_SOURCE_BUSY")
    expect((await f.manager.commands(f.workspace, "stage")).map((row) => row.command)).toEqual([
      "provider"
    ])
  } finally {
    release.resolve()
    await running
  }
  expect(
    (await withRuntimePluginSource(f.token, () => f.manager.commands(f.workspace, "stage"))).map(
      (row) => row.command
    )
  ).toEqual(["parent"])
})

it("retains the old slot and refuses reconstruction when physical retirement fails", async () => {
  const f = await fixture()
  f.onDrain(async () => {
    throw Error("PHYSICAL_DRAIN_FAILED")
  })
  await expect(
    withRuntimePluginSource(f.token, () => f.manager.commands(f.workspace, "stage"))
  ).rejects.toThrow("PHYSICAL_DRAIN_FAILED")
  await expect(
    withRuntimePluginSource(f.token, () => f.manager.commands(f.workspace, "stage"))
  ).rejects.toThrow("MODS_RUNTIME_SOURCE_CLEANUP_UNCONFIRMED")
  expect(f.manager.runtimeSessions(f.workspace).resident).toBe(1)
})

it("requires the original exact project grant before retiring an ordinary provider", async () => {
  const f = await fixture()
  f.store.grantProjectFunction(
    f.workspace,
    "project",
    "a".repeat(64),
    f.facts!.name,
    f.facts!.digest,
    false
  )
  await expect(
    withRuntimePluginSource(f.token, () => f.manager.commands(f.workspace, "stage"))
  ).rejects.toThrow("PROJECT_MODS_APPROVAL_REQUIRED")
  expect(f.drains()).toBe(0)
  expect((await f.manager.commands(f.workspace, "stage")).map((row) => row.command)).toEqual([
    "provider"
  ])
  expect(f.store.getGrant(f.workspace, "function:parent")).toBeNull()
})

it.each(["authority", "source"] as const)(
  "rejects %s changes during physical drain without constructing a replacement",
  async (mode) => {
    const f = await fixture(),
      started = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    f.onDrain(async () => {
      started.resolve()
      await release.promise
    })
    const replacing = withRuntimePluginSource(f.token, () =>
      f.manager.commands(f.workspace, "stage")
    )
    const rejected = expect(replacing).rejects.toThrow(
      mode === "authority" ? "PROJECT_REVOKED" : "MODS_CONFIG_SOURCE_CHANGED"
    )
    await started.promise
    expect(f.manager.runtimeSessions().resident).toBe(1)
    const count = f.guests.length
    if (mode === "authority") f.revoke()
    else writeFileSync(join(f.input.plugin.path, "mods/main.ts"), "export function register(){}")
    release.resolve()
    await rejected
    expect(f.guests.length).toBe(count)
    expect(f.manager.runtimeSessions().resident).toBe(1)
  }
)

it("serializes the physical handoff and refuses an ABA token while preserving the original new VM", async () => {
  const f = await fixture(),
    started = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  f.onDrain(async () => {
    started.resolve()
    await release.promise
  })
  const replacing = withRuntimePluginSource(f.token, () => f.manager.commands(f.workspace, "stage"))
  await started.promise
  const binding = withRuntimePluginSource(f.token, () => currentRuntimePluginSource()!)
  const other = issueRuntimePluginSourceToken({ ...binding })
  const racing = withRuntimePluginSource(other, () => f.manager.commands(f.workspace, "stage"))
  const refusal = expect(racing).rejects.toThrow("MODS_RUNTIME_SOURCE_CHANGED")
  release.resolve()
  expect((await replacing).map((row) => row.command)).toEqual(["parent"])
  await refusal
  expect(
    (await withRuntimePluginSource(f.token, () => f.manager.commands(f.workspace, "stage"))).map(
      (row) => row.command
    )
  ).toEqual(["parent"])
  expect(f.manager.runtimeSessions().resident).toBe(1)
  expect(f.manager.runtimeSessions().limit).toBe(6)
})

it("keeps separate legitimate executions and refuses a token's foreign workspace", async () => {
  const f = await fixture()
  await withRuntimePluginSource(f.token, () => f.manager.commands(f.workspace, "stage"))
  const binding = withRuntimePluginSource(f.token, () => currentRuntimePluginSource()!)
  const next = issueRuntimePluginSourceToken({
    ...binding,
    threadId: "stage-next",
    operationId: "next"
  })
  expect(
    (await withRuntimePluginSource(next, () => f.manager.commands(f.workspace, "stage-next"))).map(
      (row) => row.command
    )
  ).toEqual(["parent"])
  await expect(
    withRuntimePluginSource(f.token, () => f.manager.commands(f.input.plugin.path, "foreign"))
  ).rejects.toThrow("MODS_RUNTIME_SOURCE_CHANGED")
  expect(f.manager.runtimeSessions().resident).toBe(2)
})
