import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, writeFile, realpath, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { BOT_SCHEMA_VERSION } from "./schema"
import { createServer } from "node:http"
import { BotArtifacts } from "./artifacts"
import { botBrowserFileReceiver } from "./browser-files"
import { BotStore } from "./store"
import { BotHost } from "./host"
import { BotHostLock } from "./host-lock"
import { BotRpcServer } from "./rpc"
import { BotTransportClient } from "./transport-client"
import { LocalBotComputerProvider } from "./computer-provider"
import { BotWorkflowStore } from "./workflow-store"
import { BOT_BACKGROUND_TASK_SCRIPT, backgroundTaskInput } from "./background-task-input"
import { prepareBotWorkflow } from "./workflow-tool"
import { botWorkflowChildAllows } from "./workflow-child-policy"
import { writeBotModelSnapshot } from "./model-config"

const browserTest = it.runIf(process.env.CMB_BOT_BROWSER_TEST === "1")
const cleanup: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-browser-child-")))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const project = join(root, "project")
  await mkdir(project)
  const lock = BotHostLock.acquire(root)!
  cleanup.push(() => lock.release())
  const store = new BotStore(join(root, "bots.sqlite"))
  cleanup.push(() => store.close())
  const computer = new LocalBotComputerProvider(join(root, "browser"))
  computer.persistence = store
  cleanup.push(() => computer.close())
  const host = new BotHost(store, undefined, 1, computer)
  host.bindOwnership(lock)
  cleanup.push(() => host.stop())
  const token = randomBytes(32).toString("hex"),
    socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\cmb-browser-child-${randomBytes(12).toString("hex")}`
        : join(root, "rpc.sock")
  const server = new BotRpcServer(host, token)
  await server.listen(socketPath)
  cleanup.push(() => server.close())
  const client = new BotTransportClient({
    version: 1,
    pid: process.pid,
    hostId: host.id,
    socketPath,
    token
  })
  cleanup.push(() => client.closeAndWait())
  const { bot, conversationId } = await client.call("create", {
    nonce: "bot",
    name: "Browser parent",
    workspacePath: project
  })
  store.send({ nonce: "work", conversationId, text: "Collect independent evidence" })
  let parent = store.claim(host.id)!
  await mkdir(join(root, "host"))
  const modelFile = join(root, "host", "models.private")
  await writeBotModelSnapshot(modelFile, {
    version: 1,
    defaultRef: "test",
    models: [
      {
        id: "test",
        ref: "test",
        name: "test",
        model: "gpt-test",
        baseUrl: "http://127.0.0.1:9/v1",
        apiKey: "fixture"
      }
    ]
  })
  const admitRead = vi.fn(async () => undefined)
  const prepare = async (prompt: string, browserTask = true) =>
    prepareBotWorkflow(
      {
        request: { ...parent, store, bot, signal: new AbortController().signal, messages: [] },
        modelFile,
        admitRead
      },
      {
        script: BOT_BACKGROUND_TASK_SCRIPT,
        args: {
          prompt,
          label: prompt,
          agentType: "browserUse",
          ...(browserTask ? { taskType: "browser" } : {})
        },
        maxConcurrency: 1,
        browserTask
      }
    )
  const task = async (label: string) => {
    const definition = await prepare(label)
    const workflow = BotWorkflowStore.open(store, parent.lease, label, definition)
    const input = backgroundTaskInput(definition)!
    const reserved = store.workflowChildren.reserve(workflow, parent.lease, input)
    const child = store.workflowChildren.claim(workflow, parent.lease, input)
    expect(child.run.id).toBe(reserved.id)
    return { ...child, workflow, input, address: { conversationId, runId: child.run.id } }
  }
  return {
    root,
    store,
    host,
    computer,
    client,
    bot,
    conversationId,
    parent,
    prepare,
    task,
    admitRead,
    nextParent: () => {
      store.finish(parent.lease, "succeeded", "Original root finished")
      store.send({ nonce: randomBytes(16).toString("hex"), conversationId, text: "Next root task" })
      parent = store.claim(host.id)!
      return parent
    }
  }
}
it("upgrades an actual v52 database with a backup and preserves the parent browser login manifest and messages", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-browser-child-v52-")))
  const path = join(root, "bots.sqlite")
  let store = new BotStore(path)
  try {
    const { bot, conversationId } = store.createBot({ nonce: "existing", name: "Existing" })
    store.send({ nonce: "message", conversationId, text: "Original work" })
    const manifest = {
      urls: ["https://example.test/existing"],
      active: 0,
      humanHeld: true as const
    }
    store.saveBrowserSession(bot.id, manifest)
    const before = store.snapshot(),
      messages = store.messages(conversationId)
    store.close()
    const old = new DatabaseSync(path)
    try {
      old.exec("DROP TABLE bot_task_browser_sessions; UPDATE bot_schema SET version=52")
    } finally {
      old.close()
    }
    store = new BotStore(path)
    expect(store.snapshot()).toEqual(before)
    expect(store.messages(conversationId)).toEqual(messages)
    expect(store.loadBrowserSession(bot.id)).toEqual(manifest)
    expect(store.db.exec("SELECT version FROM bot_schema")[0].values[0][0]).toBe(BOT_SCHEMA_VERSION)
    expect(store.db.exec("SELECT COUNT(*) FROM bot_task_browser_sessions")[0].values[0][0]).toBe(0)
    const backups = (await readdir(join(root, "backups"))).filter((name) =>
      name.startsWith("bots-v52-")
    )
    expect(backups).toHaveLength(1)
    const backup = new DatabaseSync(join(root, "backups", backups[0]), { readOnly: true })
    try {
      expect(backup.prepare("SELECT version FROM bot_schema").get()?.version).toBe(52)
      expect(
        backup
          .prepare("SELECT name FROM sqlite_master WHERE name='bot_task_browser_sessions'")
          .get()
      ).toBeUndefined()
      expect(
        JSON.parse(
          backup.prepare("SELECT manifest FROM bot_browser_sessions WHERE bot_id=?").get(bot.id)
            ?.manifest as string
        )
      ).toEqual(manifest)
      expect(
        backup.prepare("SELECT text FROM bot_messages WHERE conversation_id=?").get(conversationId)
          ?.text
      ).toBe("Original work")
    } finally {
      backup.close()
    }
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
it("prepares a trusted browser child through the original reservation and claim without reading project files", async () => {
  const f = await fixture()
  const task = await f.task("Read browser evidence")
  expect(task.input.browserAccess).toBe("page")
  expect(botWorkflowChildAllows(task.input, "browser")).toBe(true)
  expect(botWorkflowChildAllows(task.input, "execute")).toBe(false)
  expect(botWorkflowChildAllows(task.input, "project_read")).toBe(false)
  expect(f.admitRead).not.toHaveBeenCalled()
  expect(f.store.getRun(task.run.id).parentRunId).toBe(f.parent.run.id)
})
it("cannot grant browser capability through a user role or mismatched frozen input", async () => {
  const f = await fixture()
  await mkdir(join(f.bot.workspacePath!, ".cmbcoworkagent", "agents"), { recursive: true })
  await writeFile(
    join(f.bot.workspacePath!, ".cmbcoworkagent", "agents", "browserUse.md"),
    "---\nname: browserUse\ndescription: Custom role\n---\nCUSTOM_BROWSER_NAME_HAS_NO_PAGE_AUTHORITY"
  )
  const ordinary = await f.prepare("Ordinary custom role", false)
  const ordinaryInput = backgroundTaskInput(ordinary)!
  expect(ordinaryInput.browserAccess).toBeUndefined()
  expect(botWorkflowChildAllows(ordinaryInput, "browser")).toBe(false)
  const definition = await f.prepare("Bound browser task")
  const workflow = BotWorkflowStore.open(f.store, f.parent.lease, "forged", definition)
  const input = backgroundTaskInput(definition)!
  expect(() =>
    f.store.workflowChildren.claim(workflow, f.parent.lease, {
      ...input,
      roleSystemPrompt: "Forged role"
    })
  ).toThrow(/可信/)
  const forged = {
    ...definition,
    agentProfiles: definition.agentProfiles.map((profile) => ({
      ...profile,
      source: "user" as const
    }))
  }
  const other = BotWorkflowStore.open(f.store, f.parent.lease, "user-role", forged)
  expect(() => f.store.workflowChildren.claim(other, f.parent.lease, input)).toThrow(/可信/)
  expect(botWorkflowChildAllows({ ...input, browserAccess: undefined }, "browser")).toBe(false)
})
browserTest(
  "routes authenticated parent and sibling frames to independent actual Chrome pages and rejects borrowed targets",
  async () => {
    const f = await fixture()
    const a = await f.task("Read website A"),
      b = await f.task("Read website B")
    const parent = await f.client.call("computerOpen", f.bot.id)
    const at = await f.client.call("computerOpen", a.address),
      bt = await f.client.call("computerOpen", b.address)
    expect(at.botId).toBe(f.bot.id)
    expect(at.taskRunId).toBe(a.run.id)
    expect(new Set([parent.viewId, at.viewId, bt.viewId]).size).toBe(3)
    const broker = await f.computer.get()
    const af = await f.client.call("computerFrame", a.address),
      bf = await f.client.call("computerFrame", b.address)
    expect(af.taskRunId).toBe(a.run.id)
    expect(bf.taskRunId).toBe(b.run.id)
    await f.client.call("computerTake", parent)
    await expect(
      f.client.call("computerTake", { ...at, viewId: parent.viewId })
    ).rejects.toMatchObject({ code: "stale_target" })
    await expect(
      f.client.call("computerTake", { ...at, taskRunId: b.run.id })
    ).rejects.toMatchObject({ code: "stale_target" })
    const taken = await f.client.call("computerTake", at)
    const frame = await f.client.call("computerFrame", a.address)
    expect(frame.controlOwner).toBe("self")
    await expect(
      f.client.call("computerInput", {
        target: parent,
        input: { kind: "key", frameSeq: frame.frameSeq, key: "Enter" }
      })
    ).rejects.toMatchObject({ code: "stale_target" })
    expect(broker.target(f.bot.id, b.run.id).control).toBe("bot")
    await f.client.call("computerRelease", taken)
    expect(broker.requiresObservation(f.bot.id, a.run.id)).toBe(true)
    expect(f.store.loadTaskBrowserSession(f.bot.id, a.run.id)?.urls).toEqual(["about:blank"])
    expect(f.store.runHistory({ ...a.address }).hasBrowser).toBe(true)
  },
  30000
)

async function website() {
  const server = createServer((request, response) => {
    if (request.url === "/login")
      response.setHeader("Set-Cookie", "child_login=shared; Path=/; SameSite=Lax")
    if (request.url === "/file") {
      response.setHeader("Content-Disposition", 'attachment; filename="child.txt"')
      response.end(request.headers.cookie ?? "no login")
      return
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8")
    response.end(
      `<html><head><title>Independent task page</title></head><body><input aria-label="Name"><button onclick="document.querySelector('#out').textContent=document.querySelector('input').value">Save</button><p id="out"></p><p>${request.headers.cookie ?? "no login"}</p><a href="/file" target="_blank">Download</a></body></html>`
    )
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  cleanup.push(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections()
        server.close(() => done())
      })
  )
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}
browserTest(
  "executes actual DOM refs and popup downloads independently while sharing login and preserving exact child artifacts",
  async () => {
    const f = await fixture(),
      url = await website(),
      a = await f.task("Web A"),
      b = await f.task("Web B")
    const broker = await f.computer.get()
    let parent = await broker.ensure(f.bot.id)
    parent = (
      await broker.act(parent, { op: "navigate", url: url + "/login" }, () =>
        f.store.assertDispatch(f.parent.lease)
      )
    ).target
    let at = await broker.ensure(f.bot.id, a.run.id),
      bt = await broker.ensure(f.bot.id, b.run.id)
    at = (await broker.act(at, { op: "navigate", url }, () => f.store.assertDispatch(a.lease!)))
      .target
    bt = (await broker.act(bt, { op: "navigate", url }, () => f.store.assertDispatch(b.lease!)))
      .target
    const observation = await broker.act(at, { op: "snapshot" }, () =>
      f.store.assertDispatch(a.lease!)
    )
    const lines = observation.data!.split("\n"),
      ref = (term: string) => lines.find((line) => line.includes(term))!.match(/ref=(e\d+)/)![1]
    expect(observation.data).toContain("child_login=shared")
    await broker.act(at, { op: "fill", ref: ref("Name"), value: "ONLY_CHILD_A" }, () =>
      f.store.assertDispatch(a.lease!)
    )
    await broker.act(at, { op: "click", ref: ref("Save"), element: "Save child A value" }, () =>
      f.store.assertDispatch(a.lease!)
    )
    expect(
      (await broker.act(at, { op: "snapshot" }, () => f.store.assertDispatch(a.lease!))).data
    ).toContain("ONLY_CHILD_A")
    expect(
      (await broker.act(bt, { op: "snapshot" }, () => f.store.assertDispatch(b.lease!))).data
    ).not.toContain("ONLY_CHILD_A")
    expect(
      (await broker.act(parent, { op: "snapshot" }, () => f.store.assertDispatch(f.parent.lease)))
        .data
    ).not.toContain("ONLY_CHILD_A")
    const files = new BotArtifacts(join(f.root, "objects"), f.store)
    cleanup.push(() => files.close())
    const published: import("../../shared/bot-types").BotArtifact[] = []
    const download = await broker.act(at, { op: "snapshot" }, () =>
      f.store.assertDispatch(a.lease!)
    )
    const exportRef = download
      .data!.split("\n")
      .find((line) => line.includes("Download"))!
      .match(/ref=(e\d+)/)![1]
    await broker.act(
      at,
      { op: "click", ref: exportRef, element: "Download child file" },
      () => f.store.assertDispatch(a.lease!),
      botBrowserFileReceiver({
        botId: f.bot.id,
        conversationId: f.conversationId,
        store: f.store,
        files,
        lease: a.lease!,
        results: published
      })
    )
    expect(published).toHaveLength(1)
    expect(published[0].runId).toBe(a.run.id)
    expect(published[0].conversationId).toBe(f.conversationId)
    expect(published[0].name).toBe("child.txt")
    expect(f.store.loadTaskBrowserSession(f.bot.id, b.run.id)?.urls).toEqual([url + "/"])
    expect((await broker.frame(f.bot.id, undefined, b.run.id)).tabs).toHaveLength(1)
  },
  30000
)
browserTest(
  "restores the same child session and human hold without restoring an old client or frame ticket",
  async () => {
    const f = await fixture(),
      a = await f.task("Wait for human")
    const original = await f.client.call("computerOpen", a.address)
    await f.client.call("computerTake", original)
    const old = await f.client.call("computerFrame", a.address)
    expect(f.store.loadTaskBrowserSession(f.bot.id, a.run.id)?.humanHeld).toBe(true)
    await f.computer.close()
    const restored = await f.client.call("computerFrame", a.address)
    expect(restored.taskRunId).toBe(a.run.id)
    expect(restored.control).toBe("human")
    expect(restored.controlOwner).toBe("other")
    expect(restored.generation).not.toBe(old.generation)
    await expect(
      f.client.call("computerInput", {
        target: old,
        input: { kind: "key", frameSeq: old.frameSeq, key: "Enter" }
      })
    ).rejects.toMatchObject({ code: "stale_target" })
    await f.client.call("computerTake", { ...restored, replaceHuman: true })
    const fresh = await f.client.call("computerFrame", a.address)
    await f.client.call("computerRelease", fresh)
    expect(f.store.getRun(a.run.id).id).toBe(a.run.id)
    expect(f.store.workflowChildren.metadata(a.run.id)?.key).toBe(a.input.durableCallKey)
  },
  30000
)
browserTest(
  "retains a terminal page read-only and never recreates it after provider release",
  async () => {
    const f = await fixture(),
      a = await f.task("Finish web")
    await f.client.call("computerOpen", a.address)
    const broker = await f.computer.get()
    f.store.workflowChildren.settle(a.lease!, "succeeded", {
      text: "DONE",
      structured: undefined,
      outputTokens: 1
    })
    broker.retireTask(f.bot.id, a.run.id)
    const terminal = await f.client.call("computerFrame", a.address)
    expect(terminal.taskRunId).toBe(a.run.id)
    await expect(f.client.call("computerTake", terminal)).rejects.toMatchObject({
      code: "workflow_browser_inactive"
    })
    await f.computer.close()
    await expect(f.client.call("computerFrame", a.address)).rejects.toMatchObject({
      code: "workflow_browser_released"
    })
    expect(f.computer.status().state).toBe("stopped")
    expect(f.store.getRun(a.run.id).result).toBe("DONE")
  },
  30000
)

browserTest(
  "fences child dispatch after parent cancellation while preserving an already started effect receipt",
  async () => {
    const f = await fixture(),
      a = await f.task("Cancellable web"),
      b = await f.task("Receipt sibling")
    const target = await f.client.call("computerOpen", a.address)
    const original = f.store.requestInteraction(b.lease!, {
      kind: "approval",
      prompt: "Approved original effect",
      action: { test: "accepted" }
    })
    f.store.answerInteraction({ id: original.id, revision: original.revision, answer: "approve" })
    f.store.beginEffect(b.lease!, {
      id: "accepted-original",
      action: { test: "accepted" },
      approvalId: original.id
    })
    f.store.cancel(f.parent.run.id)
    await expect(f.client.call("computerTake", target)).rejects.toMatchObject({
      code: "workflow_browser_inactive"
    })
    await expect(
      (await f.computer.get()).act(target, { op: "snapshot" }, () =>
        f.store.assertDispatch(a.lease!)
      )
    ).rejects.toMatchObject({ code: "workflow_browser_inactive" })
    f.store.settleEffect(b.lease!, "accepted-original", "succeeded", "ORIGINAL_RECEIPT")
    expect(f.store.effects(b.run.id)[0]).toMatchObject({
      status: "succeeded",
      result: "ORIGINAL_RECEIPT"
    })
    expect(f.store.workflowChildren.metadata(b.run.id)?.key).toBe(b.input.durableCallKey)
  },
  30000
)
browserTest(
  "preserves the live task browser when an effect becomes unknown rather than retiring it automatically",
  async () => {
    const f = await fixture(),
      a = await f.task("Unknown web effect")
    await f.client.call("computerOpen", a.address)
    const approval = f.store.requestInteraction(a.lease!, {
      kind: "approval",
      prompt: "Start original web effect",
      action: { test: "unknown" }
    })
    f.store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
    f.store.beginEffect(a.lease!, {
      id: "uncertain-original",
      action: { test: "unknown" },
      approvalId: approval.id
    })
    f.store.fenceOwner(f.host.id, "Supervisor interrupted")
    expect(f.store.getRun(a.run.id).status).toBe("needs_review")
    const broker = await f.computer.get()
    broker.retireTask(f.bot.id, a.run.id)
    expect(
      f.store.db.exec("SELECT expires_at FROM bot_task_browser_sessions WHERE run_id=?", [
        a.run.id
      ])[0].values[0][0]
    ).toBeNull()
    expect(broker.idleBlockedReason).toContain("核对")
    expect((await f.client.call("computerFrame", a.address)).taskRunId).toBe(a.run.id)
    expect(f.store.effects(a.run.id)[0].status).toBe("unknown")
  },
  30000
)

browserTest(
  "releases only the terminal child pages after the bounded viewing window and keeps parent pages alive",
  async () => {
    const f = await fixture(),
      a = await f.task("Bounded retained page")
    const parent = await f.client.call("computerOpen", f.bot.id)
    await f.client.call("computerOpen", a.address)
    const broker = await f.computer.get()
    f.store.workflowChildren.settle(a.lease!, "succeeded", {
      text: "FINAL_RECEIPT",
      structured: undefined,
      outputTokens: 1
    })
    vi.useFakeTimers({ toFake: ["setTimeout"] })
    try {
      broker.retireTask(f.bot.id, a.run.id)
      await vi.advanceTimersByTimeAsync(5 * 60_000)
    } finally {
      vi.useRealTimers()
    }
    await expect.poll(() => f.store.taskBrowsers.available(a.run.id), { timeout: 3000 }).toBe(false)
    await expect(f.client.call("computerFrame", a.address)).rejects.toMatchObject({
      code: "workflow_browser_released"
    })
    expect((await f.client.call("computerFrame", f.bot.id)).viewId).toBe(parent.viewId)
    expect(f.store.getRun(a.run.id).result).toBe("FINAL_RECEIPT")
    expect(
      f.store.db.exec("SELECT manifest FROM bot_task_browser_sessions WHERE run_id=?", [
        a.run.id
      ])[0].values[0][0]
    ).toBe('{"urls":[],"active":0}')
  },
  30000
)

browserTest(
  "retires an existing terminal manifest within its original remaining window rather than a fresh five minutes",
  async () => {
    const f = await fixture(),
      a = await f.task("Original expiry")
    const parent = await f.client.call("computerOpen", f.bot.id)
    await f.client.call("computerOpen", a.address)
    const broker = await f.computer.get()
    f.store.workflowChildren.settle(a.lease!, "succeeded", {
      text: "ORIGINAL_TERMINAL_RECEIPT",
      structured: undefined,
      outputTokens: 1
    })
    const expiry = f.store.retireTaskBrowserSession(f.bot.id, a.run.id)!
    let clock = expiry - 60_000
    const now = vi.spyOn(f.store, "now").mockImplementation(() => clock)
    vi.useFakeTimers({ toFake: ["setTimeout"] })
    try {
      expect(f.store.retireTaskBrowserSession(f.bot.id, a.run.id)).toBe(expiry)
      broker.retireTask(f.bot.id, a.run.id)
      expect(f.store.taskBrowsers.available(a.run.id)).toBe(true)
      clock = expiry
      await vi.advanceTimersByTimeAsync(60_000)
    } finally {
      vi.useRealTimers()
      now.mockRestore()
    }
    await expect.poll(() => f.store.taskBrowsers.available(a.run.id), { timeout: 3000 }).toBe(false)
    await expect(f.client.call("computerFrame", a.address)).rejects.toMatchObject({
      code: "workflow_browser_released"
    })
    expect((await f.client.call("computerFrame", f.bot.id)).viewId).toBe(parent.viewId)
    expect(f.store.getRun(a.run.id).result).toBe("ORIGINAL_TERMINAL_RECEIPT")
  },
  30000
)

browserTest(
  "persists terminal expiry before an already admitted page finishes its initial registration",
  async () => {
    const f = await fixture(),
      a = await f.task("Page registration versus completion")
    const parent = await f.client.call("computerOpen", f.bot.id),
      broker = await f.computer.get()
    const context = Reflect.get(broker, "context") as import("playwright-core").BrowserContext
    const newPage = context.newPage.bind(context)
    let release!: () => void, entered!: () => void
    const held = new Promise<void>((resolve) => (release = resolve)),
      ready = new Promise<void>((resolve) => (entered = resolve))
    const pageFactory = vi.spyOn(context, "newPage").mockImplementation(async () => {
      const page = await newPage()
      entered()
      await held
      return page
    })
    const opening = f.client.call("computerOpen", a.address)
    let expires: number | undefined
    try {
      await ready
      f.store.workflowChildren.settle(a.lease!, "succeeded", {
        text: "ORIGINAL_GAP_RECEIPT",
        structured: undefined,
        outputTokens: 1
      })
      broker.retireTask(f.bot.id, a.run.id)
      expires = f.store.db.exec("SELECT expires_at FROM bot_task_browser_sessions WHERE run_id=?", [
        a.run.id
      ])[0]?.values[0]?.[0] as number | undefined
      expect(expires).toBeTypeOf("number")
    } finally {
      release()
      pageFactory.mockRestore()
      await opening.catch(() => {})
    }
    const saved = f.store.db.exec(
      "SELECT expires_at FROM bot_task_browser_sessions WHERE run_id=?",
      [a.run.id]
    )[0].values[0][0]
    expect(saved).toBe(expires)
    expect((await f.client.call("computerFrame", a.address)).taskRunId).toBe(a.run.id)
    await expect(f.client.call("computerTake", await opening)).rejects.toMatchObject({
      code: "workflow_browser_inactive"
    })
    expect((await f.client.call("computerFrame", f.bot.id)).viewId).toBe(parent.viewId)
    expect(f.store.getRun(a.run.id).result).toBe("ORIGINAL_GAP_RECEIPT")
  },
  30000
)

it("compacts expired known task manifests in indexed bounded batches without losing active, human, unknown or late-input evidence", async () => {
  const f = await fixture(),
    known: { id: string; expiry: number; result: string }[] = []
  for (let index = 0; index < 40; index++) {
    if (index === 20) f.nextParent() // Preserve the original 32-workflow budget per root.
    const task = await f.task(`Expired ${index}`)
    f.store.saveTaskBrowserSession(f.bot.id, task.run.id, {
      urls: [`https://example.test/${"x".repeat(8000)}`],
      active: 0
    })
    f.store.workflowChildren.settle(task.lease!, "succeeded", {
      text: `ORIGINAL_${index}`,
      structured: undefined,
      outputTokens: 1
    })
    const expiry = f.store.retireTaskBrowserSession(f.bot.id, task.run.id)!
    known.push({ id: task.run.id, expiry, result: `ORIGINAL_${index}` })
  }
  const human = await f.task("Human evidence"),
    active = await f.task("Active evidence"),
    unknown = await f.task("Unknown evidence")
  const full = { urls: ["https://example.test/evidence"], active: 0 }
  f.store.saveTaskBrowserSession(f.bot.id, human.run.id, { ...full, humanHeld: true })
  f.store.workflowChildren.settle(human.lease!, "succeeded", {
    text: "HUMAN_RECEIPT",
    structured: undefined,
    outputTokens: 1
  })
  f.store.retireTaskBrowserSession(f.bot.id, human.run.id)
  f.store.saveTaskBrowserSession(f.bot.id, active.run.id, full)
  f.store.saveTaskBrowserSession(f.bot.id, unknown.run.id, full)
  const approval = f.store.requestInteraction(unknown.lease!, {
    kind: "approval",
    prompt: "Original uncertain work",
    action: { type: "test" }
  })
  f.store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
  f.store.beginEffect(unknown.lease!, {
    id: "original-unknown",
    approvalId: approval.id,
    action: { type: "test" }
  })
  const now = vi
    .spyOn(f.store, "now")
    .mockReturnValue(Math.max(...known.map((task) => task.expiry)) + 1000)
  const exec = vi.spyOn(f.store.db, "exec")
  try {
    const copyPath = join(f.root, "bootstrap-copy.sqlite")
    f.store.db.run("VACUUM INTO ?", [copyPath])
    const copy = new BotStore(copyPath, () => f.store.now())
    const copyHostDirectory = join(f.root, "copy-host")
    await mkdir(copyHostDirectory)
    const copyLock = BotHostLock.acquire(copyHostDirectory)!
    const maintenance = new BotHost(copy, undefined, 1, undefined, undefined, undefined, () =>
      copy.now()
    )
    maintenance.bindOwnership(copyLock)
    const timers = vi.spyOn(globalThis, "setInterval")
    try {
      expect(
        copy.db.exec(
          `SELECT COUNT(*) FROM bot_task_browser_sessions WHERE manifest='{"urls":[],"active":0}'`
        )[0].values[0][0]
      ).toBe(16)
      const compactCount = () =>
        Number(
          copy.db.exec(
            `SELECT COUNT(*) FROM bot_task_browser_sessions WHERE manifest='{"urls":[],"active":0}'`
          )[0].values[0][0]
        )
      maintenance.tick()
      expect(compactCount()).toBe(32)
      now.mockReturnValue(f.store.now() + 1000)
      maintenance.tick()
      expect(compactCount()).toBe(40)
      expect(timers).not.toHaveBeenCalled()
      expect(Reflect.get(maintenance, "timer")).toBeUndefined()
      expect(
        copy.db.exec("SELECT manifest FROM bot_task_browser_sessions WHERE run_id=?", [
          human.run.id
        ])[0].values[0][0]
      ).toContain('"humanHeld":true')
      expect(
        copy.db.exec("SELECT manifest FROM bot_task_browser_sessions WHERE run_id=?", [
          unknown.run.id
        ])[0].values[0][0]
      ).toContain("example.test/evidence")
    } finally {
      timers.mockRestore()
      await maintenance.stop()
      copyLock.release()
      copy.close()
    }
    const originalRun = f.store.getRun(active.run.id)
    const originalReceipts = f.store.db.exec("SELECT * FROM bot_receipts ORDER BY nonce")[0].values
    const run = f.store.db.run.bind(f.store.db)
    let updates = 0
    const fail = vi.spyOn(f.store.db, "run").mockImplementation((sql, bindings) => {
      if (sql.startsWith("UPDATE bot_task_browser_sessions SET manifest=?") && ++updates === 2)
        throw new Error("actual maintenance storage failure")
      return run(sql, bindings)
    })
    try {
      expect(() => f.store.taskBrowsers.compactExpired()).toThrow(
        "actual maintenance storage failure"
      )
    } finally {
      fail.mockRestore()
    }
    expect(f.store.getRun(active.run.id)).toEqual(originalRun)
    expect(f.store.db.exec("SELECT * FROM bot_receipts ORDER BY nonce")[0].values).toEqual(
      originalReceipts
    )
    expect(
      f.store.db.exec(
        `SELECT COUNT(*) FROM bot_task_browser_sessions WHERE manifest='{"urls":[],"active":0}'`
      )[0].values[0][0]
    ).toBe(0)
    expect(f.store.taskBrowsers.compactExpired()).toBe(16)
    expect(f.store.taskBrowsers.compactExpired()).toBe(16)
    expect(f.store.taskBrowsers.compactExpired()).toBe(8)
    const selections = exec.mock.calls.filter(([sql]) =>
      sql.startsWith("SELECT s.run_id,s.expires_at,s.manifest")
    )
    for (const selection of [
      selections[0],
      selections.find(([sql]) => sql.includes("s.run_id)>"))!
    ]) {
      const plan = f.store.db.exec("EXPLAIN QUERY PLAN " + selection[0], selection[1])[0].values
      console.info("BotTaskBrowserCompactPlan", {
        continuation: selection[0].includes("s.run_id)>"),
        plan
      })
      expect(plan.flat().join(" ")).toContain("bot_task_browser_expiry")
      if (selection[0].includes("s.run_id)>"))
        expect(plan.flat().join(" ")).toContain("(expires_at,run_id)>(?,?) AND expires_at<?")
    }
    for (const task of known) {
      const row = f.store.db.exec(
        "SELECT manifest,expires_at FROM bot_task_browser_sessions WHERE run_id=?",
        [task.id]
      )[0].values[0]
      expect(JSON.parse(String(row[0]))).toEqual({ urls: [], active: 0 })
      expect(row[1]).toBe(task.expiry)
      expect(f.store.getRun(task.id).result).toBe(task.result)
      f.store.saveTaskBrowserSession(f.bot.id, task.id, {
        urls: ["https://late.test/never-revive"],
        active: 0
      })
      expect(f.store.taskBrowsers.available(task.id)).toBe(false)
      expect(
        f.store.db.exec("SELECT manifest FROM bot_task_browser_sessions WHERE run_id=?", [
          task.id
        ])[0].values[0][0]
      ).toBe('{"urls":[],"active":0}')
    }
    const manifestFor = (id: string) =>
      f.store.db.exec("SELECT manifest FROM bot_task_browser_sessions WHERE run_id=?", [id])[0]
        .values[0][0]
    expect(manifestFor(human.run.id)).toContain('"humanHeld":true')
    expect(manifestFor(active.run.id)).toContain("example.test/evidence")
    expect(f.store.getRun(active.run.id).status).toBe("running")
    expect(manifestFor(unknown.run.id)).toContain("example.test/evidence")
    f.store.fenceOwner(f.host.id, "Actual uncertain receipt")
    expect(f.store.getRun(unknown.run.id).status).toBe("needs_review")
    expect(f.store.effects(unknown.run.id)[0].status).toBe("unknown")
    f.store.taskBrowsers.compactExpired()
    expect(manifestFor(unknown.run.id)).toContain("example.test/evidence")
  } finally {
    exec.mockRestore()
    now.mockRestore()
  }
})
it("rolls back the actual v52 upgrade if its version commit fails, preserving the original database and backup", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-browser-v52-rollback-"))),
    path = join(root, "bots.sqlite")
  let store = new BotStore(path)
  const { bot, conversationId } = store.createBot({ nonce: "original", name: "Original" })
  store.send({ nonce: "original-message", conversationId, text: "ORIGINAL_BEFORE_MIGRATION" })
  store.saveBrowserSession(bot.id, { urls: ["https://original.test"], active: 0, humanHeld: true })
  store.close()
  let old = new DatabaseSync(path)
  try {
    old.exec(
      "DROP TABLE bot_task_browser_sessions; UPDATE bot_schema SET version=52; CREATE TRIGGER migration_fixture_abort BEFORE UPDATE ON bot_schema BEGIN SELECT RAISE(ABORT,'V52_VERSION_COMMIT_FAILED'); END;"
    )
  } finally {
    old.close()
  }
  try {
    expect(() => new BotStore(path)).toThrow("V52_VERSION_COMMIT_FAILED")
    old = new DatabaseSync(path)
    try {
      expect(old.prepare("SELECT version FROM bot_schema").get()?.version).toBe(52)
      expect(
        old.prepare("SELECT name FROM sqlite_master WHERE name='bot_task_browser_sessions'").get()
      ).toBeUndefined()
      expect(
        old.prepare("SELECT name FROM sqlite_master WHERE name='bot_task_browser_expiry'").get()
      ).toBeUndefined()
      expect(
        old.prepare("SELECT text FROM bot_messages WHERE conversation_id=?").get(conversationId)
          ?.text
      ).toBe("ORIGINAL_BEFORE_MIGRATION")
      old.exec("DROP TRIGGER migration_fixture_abort")
    } finally {
      old.close()
    }
    const backups = (await readdir(join(root, "backups"))).filter((name) =>
      name.startsWith("bots-v52-")
    )
    expect(backups.length).toBeGreaterThan(0)
    const backup = new DatabaseSync(join(root, "backups", backups[0]), { readOnly: true })
    try {
      expect(backup.prepare("SELECT version FROM bot_schema").get()?.version).toBe(52)
    } finally {
      backup.close()
    }
    store = new BotStore(path)
    expect(store.loadBrowserSession(bot.id)).toEqual({
      urls: ["https://original.test"],
      active: 0,
      humanHeld: true
    })
    expect(store.db.exec("SELECT version FROM bot_schema")[0].values[0][0]).toBe(BOT_SCHEMA_VERSION)
    store.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

browserTest(
  "internal page reservation protocol reuses the same pending actual page at a full registration budget",
  async () => {
    // Budget slots here are internal protocol reservations, not 128 native pages
    // or a claim that a public UI flow reliably sends the same Page twice.
    const f = await fixture(),
      parent = await f.client.call("computerOpen", f.bot.id),
      broker = await f.computer.get()
    const context = Reflect.get(broker, "context") as import("playwright-core").BrowserContext
    const surfaces = Reflect.get(broker, "surfaces") as Map<
      string,
      {
        pages: Set<import("playwright-core").Page>
        registering: Map<import("playwright-core").Page, Promise<string>>
      }
    >
    const surface = surfaces.get(f.bot.id)!,
      page = await context.newPage()
    const register = Reflect.get(broker, "registerPage") as (
      surface: unknown,
      page: import("playwright-core").Page
    ) => Promise<string>
    const originalSession = context.newCDPSession.bind(context)
    let release!: () => void, entered!: () => void
    const held = new Promise<void>((resolve) => (release = resolve)),
      ready = new Promise<void>((resolve) => (entered = resolve))
    const sessions = vi.spyOn(context, "newCDPSession").mockImplementation(async (target) => {
      const session = await originalSession(target)
      entered()
      await held
      return session
    })
    const registration = Reflect.apply(register, broker, [surface, page])
    void registration.catch(() => {})
    let duplicate: Promise<string> | undefined
    try {
      await ready
      const seats = new Map(
        Array.from(
          { length: 126 },
          (_, index) =>
            [
              { close: async () => {} } as unknown as import("playwright-core").Page,
              Promise.resolve(`reserved-${index}`)
            ] as const
        )
      )
      surfaces.set("protocol-only-capacity-reservations", {
        ...surface,
        pages: new Set(),
        registering: seats
      })
      duplicate = Reflect.apply(register, broker, [surface, page])
      void duplicate.catch(() => {})
      expect(duplicate).toBe(registration)
      expect(page.isClosed()).toBe(false)
    } finally {
      surfaces.delete("protocol-only-capacity-reservations")
      release()
      sessions.mockRestore()
      await Promise.allSettled([registration, ...(duplicate ? [duplicate] : [])])
    }
    expect(page.isClosed()).toBe(false)
    expect((await f.client.call("computerFrame", f.bot.id)).viewId).toBe(parent.viewId)
  },
  30000
)
