import { mcpFixture } from "./test-mcp-fixture"
import {
  createCompiledTrustedMacOwnedHostFixture,
  type TrustedMacFaultHostEntry
} from "../../../tests/support/compiled-mac-owned-host-fixture"
import { hasOwnedShellPhysicalClosure } from "./owned-shell-receipt-contract"
import { createTestLocalProjectAccess } from "./test-local-project-permission"
import type { BotRun } from "../../shared/bot-types"
import type { BotLocalToolAnswer } from "../../shared/bot-local-tool-permission"
import { testModelRequest, type TestModelRequest } from "./test-model-protocol"
import { botProxyFixture } from "./test-http-proxy"
import { createHash, randomUUID } from "node:crypto"
import { afterEach, expect, it } from "vitest"
import { spawn, execFile, type ChildProcess } from "node:child_process"
import { promisify } from "node:util"
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  mkdir,
  cp,
  stat,
  realpath,
  readdir
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { DatabaseSync } from "node:sqlite"
import legacyAllAbsent from "./fixtures/computer-legacy-all-absent.json"
import { dirname, join, resolve } from "node:path"
import { createServer } from "node:http"
import { once } from "node:events"
import { setTimeout as delay } from "node:timers/promises"
import { BotTransportClient, type BotHostDescriptor } from "./transport-client"
import { readBotModelSnapshot, writeBotModelSnapshot } from "./model-config"
import { DEFAULT_MOD_POLICY } from "../mods/policy-core"
import type { BotBackupRequest, BotBackupResult } from "../../shared/bot-backup"
import { build } from "esbuild"
import { avatarImage } from "./image-fixtures"
import { BotStore } from "./store"
import { inspectOwnedShellReceipts } from "./owned-shell-receipts"
import { inspectDesktopBotShellResources } from "./desktop-owned-shell-maintenance"
import { BotArtifacts } from "./artifacts"
import { botBrowserFileReceiver } from "./browser-files"
import { BOT_HOST_LOG_BYTES } from "./host-log"
import { createScheduledBotSnapshot, listBotBackups } from "./backups"
import { executeBotBrowserMaintenance, listBotBrowserCheckpoints } from "./browser-maintenance"
import {
  executeBotWorkspaceMaintenance,
  listBotWorkspaceCheckpoints
} from "./workspace-maintenance"

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop()
})
const processTest = it.skipIf(process.env.CMB_BOT_PROCESS_TEST !== "1")

processTest(
  "repairs a genuine legacy all-absent generation through compiled Host startup and SIGKILL restart",
  async () => {
    const f = await fixture(() => ({ content: "unused" }))
    const location = (path: string) => path.replace(/^host(?=\/|\.workspace|$)/, f.directory)
    expect(legacyAllAbsent.provenance.noSyntheticVersionOrEvents).toBe(true)
    expect(legacyAllAbsent.generation.provenance.noBotStoreOpened).toBe(true)
    // The original fixture owns this model server/file and both workspace siblings.
    // Do not overwrite its model config or seed a control DB before the real entry boots.
    expect(
      legacyAllAbsent.files.some((file) =>
        ["host/bots.sqlite", "host/models.private"].includes(file.path)
      )
    ).toBe(false)
    for (const directory of legacyAllAbsent.directories)
      await mkdir(location(directory), { recursive: true, mode: 0o700 })
    for (const file of legacyAllAbsent.files) {
      const bytes = Buffer.from(file.base64, "base64")
      expect(bytes.length).toBe(file.bytes)
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256)
      await writeFile(location(file.path), bytes, { flag: "wx", mode: 0o600 })
    }
    await expect(stat(join(f.directory, "models.private"))).resolves.toMatchObject({})
    await expect(stat(join(f.directory, "bots.sqlite"))).rejects.toMatchObject({ code: "ENOENT" })
    const sealed = legacyAllAbsent.files.filter(
      (file) => file.path.endsWith(".json") && !file.path.endsWith("/progress.private.json")
    )
    const assertSealed = async () => {
      for (const file of sealed)
        expect(
          createHash("sha256")
            .update(await readFile(location(file.path)))
            .digest("hex")
        ).toBe(file.sha256)
    }
    const restoreEvents = () => {
      // Read-only observation of the actual child-owned database, never a source
      // helper or in-process Store standing in for the compiled startup entry.
      const db = new DatabaseSync(join(f.directory, "bots.sqlite"), { readOnly: true })
      try {
        return db
          .prepare(
            "SELECT kind,entity_id,payload,created_at FROM bot_events WHERE kind IN ('workspace.restored','computer.restored') ORDER BY cursor"
          )
          .all()
      } finally {
        db.close()
      }
    }
    const first = f.launch(),
      client = await f.connect(first),
      initial = await client.call("snapshot"),
      epoch = initial.dataEpoch
    expect(epoch).toEqual(expect.any(String))
    expect(epoch).not.toBe("initial")
    expect(epoch).not.toBe(legacyAllAbsent.generation.restore.nonce)
    expect(initial.bots).toEqual([])
    expect(initial.runs).toEqual([])
    await expect(
      client.call("create", legacyAllAbsent.generation.beforeRequests.create)
    ).rejects.toMatchObject({ code: "data_epoch" })
    await expect(
      client.call("changeBackupSchedule", legacyAllAbsent.generation.beforeRequests.backup)
    ).rejects.toMatchObject({ code: "data_epoch" })
    expect((await client.call("snapshot")).bots).toEqual([])
    const settings = await client.call("backupSchedule")
    expect(settings.revision).toBe(0)
    const created = await client.call("create", {
      nonce: "compiled-current-legacy-generation",
      name: "Current compiled Host assignment",
      expectedDataEpoch: epoch
    })
    expect(created.bot.name).toBe("Current compiled Host assignment")
    const events = restoreEvents()
    expect(events).toEqual([
      {
        kind: "workspace.restored",
        entity_id: epoch,
        payload: expect.stringContaining("旧版电脑恢复"),
        created_at: expect.any(Number)
      }
    ])
    await assertSealed()
    expect(await listBotBackups(f.directory)).toEqual([])
    expect(f.requests).toEqual([])
    const killed = once(first, "exit")
    await f.stop(first, "SIGKILL")
    await expect(killed).resolves.toEqual([null, "SIGKILL"])
    await client.closeAndWait()
    const second = f.launch(),
      next = await f.connect(second),
      reopened = await next.call("snapshot")
    expect(reopened.dataEpoch).toBe(epoch)
    expect(reopened.bots).toEqual([created.bot])
    expect(reopened.runs).toEqual([])
    expect(await next.call("backupSchedule")).toEqual(settings)
    expect(restoreEvents()).toEqual(events)
    expect(await listBotBackups(f.directory)).toEqual([])
    await assertSealed()
    expect(f.requests).toEqual([])
    await f.stop(second)
    await next.closeAndWait()
  },
  30_000
)

processTest(
  "recovers interrupted download notices once through compiled Host startup",
  async () => {
    const f = await fixture(() => ({ content: "unused" }))
    const first = f.launch(),
      client = await f.connect(first)
    const { bot, conversationId } = await client.call("create", { nonce: "bot", name: "下载助手" })
    await f.stop(first, "SIGKILL")
    client.close()
    // Seed the durable boundary while no Host owns the database. The separate
    // publication tests kill real processes at these same transaction boundaries.
    const store = new BotStore(join(f.directory, "bots.sqlite"))
    const files = new BotArtifacts(join(f.directory, "objects"), store)
    let threadRootId: string
    const savedGuid = randomUUID()
    try {
      const root = store.send({ nonce: "root", conversationId, text: "Downloads in this branch" })
      store.cancel(root.runIds[0])
      threadRootId = root.messageId
      const receiver = botBrowserFileReceiver({
        store,
        files,
        botId: bot.id,
        conversationId,
        threadRootId
      })
      receiver.started?.(randomUUID())
      await receiver.complete(
        { guid: savedGuid, bytes: Buffer.from("SAVED_DOWNLOAD"), suggestedName: "report.txt" },
        () => {}
      )
      // Publication succeeded but the download's final cleanup did not run.
      receiver.started?.(savedGuid)
    } finally {
      await files.close()
      store.close()
    }
    const second = f.launch(),
      next = await f.connect(second)
    const messages = await next.call("messages", { conversationId, threadRootId })
    expect(messages.map((message) => message.text)).toEqual([
      "已下载：report.txt",
      "下载未完成：后台重启，下载已中断，请重新下载"
    ])
    expect(messages[0].attachments).toEqual([`browser-download:${savedGuid}`])
    expect(
      Buffer.from(
        (await next.call("download", `browser-download:${savedGuid}`)).base64,
        "base64"
      ).toString()
    ).toBe("SAVED_DOWNLOAD")
    expect(await next.call("messages", { conversationId })).toHaveLength(1)
    await f.stop(second, "SIGKILL")
    next.close()
    const third = f.launch(),
      last = await f.connect(third)
    expect(await last.call("messages", { conversationId, threadRootId })).toEqual(messages)
    expect((await last.call("snapshot")).runs).toEqual([])
    expect(f.requests).toEqual([])
    await f.stop(third)
  },
  30_000
)

processTest(
  "preserves output allowance and unknown model usage across compiled Host restart",
  async () => {
    const f = await fixture(() => ({ content: "BUDGET_COMPILED_COMPLETE" }))
    const first = f.launch(),
      client = await f.connect(first)
    const { bot, conversationId } = await client.call("create", { nonce: "bot", name: "额度助手" })
    const initial = await client.call("usageBudget", { botId: null })
    await client.call("changeUsageBudget", {
      botId: null,
      nonce: "user-limit",
      revision: 0,
      dataEpoch: initial.dataEpoch,
      outputLimit: 1000
    })
    const personal = await client.call("usageBudget", { botId: bot.id })
    await client.call("changeUsageBudget", {
      botId: bot.id,
      nonce: "bot-limit",
      revision: 0,
      dataEpoch: personal.dataEpoch,
      outputLimit: 400
    })
    const sent = await client.call("send", {
      nonce: "task",
      conversationId,
      text: "Use available allowance"
    })
    await until(
      async () =>
        (await client.call("runHistory", { conversationId, runId: sent.runIds[0] })).run.status ===
        "succeeded"
    )
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0].max_completion_tokens ?? f.requests[0].max_tokens).toBe(400)
    expect(f.logs.get(first)).toContain("[BotModelCall]")
    expect(f.logs.get(first)).toContain(sent.runIds[0])
    expect(await client.call("usageBudget", { botId: null })).toMatchObject({
      available: 600,
      usage: { unknownRequests: 1, reservedOutputTokens: 400 }
    })
    await f.stop(first, "SIGKILL")
    client.close()
    const second = f.launch(),
      next = await f.connect(second)
    expect(await next.call("usageBudget", { botId: bot.id })).toMatchObject({
      revision: 1,
      outputLimit: 400,
      available: 0
    })
    const blocked = await next.call("send", {
      nonce: "blocked",
      conversationId,
      text: "Stop before HTTP"
    })
    await until(
      async () =>
        (await next.call("runHistory", { conversationId, runId: blocked.runIds[0] })).run.status ===
        "failed"
    )
    expect(
      (await next.call("runHistory", { conversationId, runId: blocked.runIds[0] })).run.error
    ).toContain("模型输出额度已用尽")
    expect(f.requests).toHaveLength(1)
    const current = await next.call("usageBudget", { botId: bot.id })
    await next.call("changeUsageBudget", {
      botId: bot.id,
      nonce: "increase",
      revision: current.revision,
      dataEpoch: current.dataEpoch,
      outputLimit: 1000
    })
    const resumed = await next.call("send", {
      nonce: "resumed",
      conversationId,
      text: "Use remaining allowance"
    })
    await until(
      async () =>
        (await next.call("runHistory", { conversationId, runId: resumed.runIds[0] })).run.status ===
        "succeeded"
    )
    expect(f.requests).toHaveLength(2)
    expect(f.requests[1].max_completion_tokens ?? f.requests[1].max_tokens).toBe(600)
    expect(await next.call("usageBudget", { botId: null })).toMatchObject({
      available: 0,
      usage: { requests: 2, reservedOutputTokens: 1000 }
    })
    await f.stop(second)
  },
  30_000
)

processTest(
  "uses the configured proxy for a compiled Host model stream",
  async () => {
    const f = await fixture(() => ({ content: "PROXIED_MODEL_COMPLETE" }))
    const modelFile = join(f.directory, "models.private"),
      snapshot = await readBotModelSnapshot(modelFile),
      origin = new URL(snapshot.models[0].baseUrl)
    const proxy = await botProxyFixture(
      Number(origin.port),
      "Basic " + Buffer.from("proxy:fixture").toString("base64")
    )
    cleanup.push(() => proxy.close())
    origin.hostname = "bot-model.proxy-fixture.invalid"
    snapshot.models[0].baseUrl = origin.href
    await writeBotModelSnapshot(modelFile, snapshot)
    const child = f.launch(false, {
      HTTP_PROXY: `http://proxy:fixture@127.0.0.1:${proxy.port}`,
      http_proxy: undefined,
      HTTPS_PROXY: undefined,
      https_proxy: undefined,
      NO_PROXY: "",
      no_proxy: undefined,
      NODE_USE_ENV_PROXY: undefined
    })
    const client = await f.connect(child)
    const { conversationId } = await client.call("create", { nonce: "bot", name: "Proxy Bot" })
    const sent = await client.call("send", {
      nonce: "task",
      conversationId,
      text: "Use configured model"
    })
    await until(async () => {
      const run = (await client.call("runHistory", { conversationId, runId: sent.runIds[0] })).run
      if (["failed", "needs_review"].includes(run.status)) throw new Error(run.error ?? run.status)
      return run.status === "succeeded"
    }, 20_000)
    expect(f.requests).toHaveLength(1)
    expect(proxy.tunnels).toHaveLength(1)
    expect(proxy.tunnels[0].target).toBe(origin.host)
    expect(proxy.tunnels[0].headers.authorization).toBeUndefined()
    expect((await client.call("messages", { conversationId })).at(-1)?.text).toBe(
      "PROXIED_MODEL_COMPLETE"
    )
    expect(f.logs.get(child)).not.toContain("proxy:fixture")
  },
  30_000
)

processTest.each([false, true])(
  "retains the model binding across compiled Host SIGKILL and stops changed providers (changed=%s)",
  async (changed) => {
    const f = await fixture((_body, index) =>
      index === 1 ? null : { content: "MODEL_BINDING_COMPLETE" }
    )
    const first = f.launch(),
      client = await f.connect(first)
    const { conversationId } = await client.call("create", { nonce: "bot", name: "Model binding" })
    const sent = await client.call("send", {
      nonce: "task",
      conversationId,
      text: "Continue after restart"
    })
    await until(async () => f.requests.length === 1)
    await f.stop(first, "SIGKILL")
    client.close()
    if (changed) {
      const path = join(f.directory, "models.private"),
        snapshot = await readBotModelSnapshot(path)
      snapshot.models[0].apiKey = "new-provider-credential"
      snapshot.models[0].model = "new-provider-model"
      await writeBotModelSnapshot(path, snapshot)
    }
    const second = f.launch(),
      next = await f.connect(second)
    const runId = sent.runIds[0]
    await until(
      async () =>
        (await next.call("snapshot")).runs.some(
          (run) => run.id === runId && run.status === "needs_review"
        ),
      40_000
    )
    const interrupted = (await next.call("runHistory", { runId, conversationId })).run
    await next.call("recover", {
      id: runId,
      revision: interrupted.revision,
      decision: "resume",
      note: "Reviewed interrupted request",
      effects: []
    })
    await until(async () =>
      ["failed", "succeeded", "needs_review"].includes(
        (await next.call("runHistory", { runId, conversationId })).run.status
      )
    )
    const restored = (await next.call("runHistory", { runId, conversationId })).run
    if (changed) {
      expect(restored.status).toBe("failed")
      expect(restored.error).toContain("模型配置已变化")
      expect(f.requests).toHaveLength(1)
      const newTask = await next.call("send", {
        nonce: "new-task",
        conversationId,
        text: "Use the updated model for this new task"
      })
      await until(
        async () =>
          (await next.call("runHistory", { runId: newTask.runIds[0], conversationId })).run
            .status === "succeeded"
      )
      expect(f.requests).toHaveLength(2)
      expect(f.requests[1].model).toBe("new-provider-model")
    } else {
      expect(restored.status).toBe("succeeded")
      expect(restored.result).toBe("MODEL_BINDING_COMPLETE")
      expect(f.requests).toHaveLength(2)
    }
    expect(JSON.stringify(restored)).not.toContain("new-provider-credential")
  },
  60_000
)

processTest(
  "retains plugin pane state across turns and rejects stale callbacks after a compiled Host restart",
  async () => {
    const f = await fixture(() => ({ content: "MODEL_MUST_NOT_RUN" }))
    const workspace = `${f.directory}.workspace`,
      plugin = join(f.directory, "fixture-plugin")
    await mkdir(workspace)
    await cp(resolve("resources/mods/function-commands"), plugin, { recursive: true })
    const modelFile = join(f.directory, "models.private")
    await writeBotModelSnapshot(modelFile, {
      ...(await readBotModelSnapshot(modelFile)),
      mods: {
        enabled: true,
        policy: DEFAULT_MOD_POLICY,
        plugins: [{ id: "fixture", name: "Function commands", enabled: true, path: plugin }]
      },
      execution: { windowsSandbox: "none", resourceDirectory: resolve("resources") }
    })
    let child = f.launch(),
      client = await f.connect(child)
    const { bot, conversationId } = await client.call("create", {
      nonce: "owner",
      name: "Pane owner",
      workspacePath: workspace,
      connectorIds: ["bot-mod:fixture"]
    })
    const address = { botId: bot.id, conversationId }
    const settle = async (runId: string, approvals: boolean) => {
      await until(async () => {
        const snapshot = await client.call("snapshot")
        for (const item of snapshot.interactions.filter((i) => i.status === "pending")) {
          expect(approvals, "A pure pane counter must not request new approvals").toBe(true)
          await client.call("answer", { id: item.id, revision: item.revision, answer: "approve" })
        }
        const run = (await client.call("runHistory", { conversationId, runId })).run
        if (["failed", "needs_review", "cancelled"].includes(run.status))
          throw Error(JSON.stringify(run))
        return run.status === "succeeded"
      })
    }
    const opening = await client.call("send", {
      nonce: "open",
      conversationId,
      text: "/plugin claw-board"
    })
    await settle(opening.runIds[0], true)
    const view = await client.call("pluginPanes", address),
      pane = view.panes[0]
    type Element = import("../../shared/mods/v2/ui").FunctionUiElement
    const row = pane.tree.children!.find(
      (node) => typeof node !== "string" && node.type === "Box"
    ) as Element
    const button = row.children![0] as Element
    const action = {
      ...address,
      target: "pane" as const,
      sessionId: view.sessionId!,
      action: {
        pane: pane.key,
        generation: pane.generation,
        plugin: button.press!.plugin,
        handle: button.press!.handle,
        kind: "press" as const,
        intentId: randomUUID()
      }
    }
    const messages = await client.call("messages", { conversationId })
    const receipt = await client.call("pluginPaneAction", action)
    await settle(receipt.runIds[0], false)
    expect(await client.call("pluginPaneAction", action)).toEqual(receipt)
    const count = (value: typeof view) => (value.panes[0].tree.children![1] as Element).children
    expect(count(await client.call("pluginPanes", address))).toEqual(["点击次数：", "1"])
    expect(await client.call("messages", { conversationId })).toEqual(messages)
    await f.stop(child, "SIGKILL")
    client.close()
    child = f.launch()
    client = await f.connect(child)
    expect(await client.call("pluginPaneAction", action)).toEqual(receipt)
    expect((await client.call("pluginPanes", address)).panes).toEqual([])
    await expect(
      client.call("pluginPaneAction", {
        ...action,
        action: { ...action.action, intentId: randomUUID() }
      })
    ).rejects.toThrow("面板已更新")
    const reopened = await client.call("send", {
      nonce: "reopen",
      conversationId,
      text: "/plugin claw-board"
    })
    await settle(reopened.runIds[0], true)
    const next = await client.call("pluginPanes", address)
    expect(next.sessionId).not.toBe(view.sessionId)
    expect(count(next)).toEqual(["点击次数：", "1"])
    expect(f.requests).toEqual([])
  },
  45_000
)

processTest(
  "resumes Notification Hooks after SIGKILL without repeating the completed notification or bypassing the original approval",
  async () => {
    const f = await fixture((body) =>
      body.messages.at(-1)?.role === "tool"
        ? { content: "NOTIFICATION_RECOVERY_COMPLETE" }
        : {
            tool_calls: [
              {
                id: "original-command",
                type: "function",
                function: {
                  name: "execute",
                  arguments: JSON.stringify({ command: "node task.cjs", timeout_seconds: 30 })
                }
              }
            ]
          }
    )
    const workspace = `${f.directory}.workspace`,
      settings = join(workspace, "notification-settings")
    await mkdir(workspace)
    await mkdir(settings)
    await writeFile(
      join(settings, "hooks.json"),
      JSON.stringify(
        [0, 1].map((index) => ({
          id: `notification-${index}`,
          event: "Notification",
          matcher: "permission_prompt",
          enabled: true,
          command: `node notify.cjs ${index}`
        }))
      )
    )
    await writeFile(
      join(settings, "notify.cjs"),
      "process.stdin.resume();process.stdin.on('end',()=>{require('fs').appendFileSync(require('path').join(process.env.WORKSPACE_PATH,'notifications'),process.argv[2]);console.log('{}')})"
    )
    await writeFile(
      join(workspace, "task.cjs"),
      "require('fs').appendFileSync('task-effects','x');console.log('TASK_DONE')"
    )
    const modelFile = join(f.directory, "models.private")
    await writeBotModelSnapshot(modelFile, {
      ...(await readBotModelSnapshot(modelFile)),
      hookSources: { root: settings },
      execution: { windowsSandbox: "none", resourceDirectory: resolve("resources") }
    })
    const child = f.launch(),
      client = await f.connect(child)
    const { conversationId } = await client.call("create", {
      nonce: "create",
      name: "Notifier",
      workspacePath: workspace
    })
    const {
      runIds: [runId]
    } = await client.call("send", { nonce: "run", conversationId, text: "Run the check" })
    const projectSnapshot = await createRecoveryProjectSnapshot({
      workspace,
      conversationId,
      runId,
      commands: ["node task.cjs", "node notify.cjs 0", "node notify.cjs 1"]
    })
    const originalApprovals = (snapshot: Awaited<ReturnType<typeof projectSnapshot>>) =>
      snapshot.interactions.filter(
        (item) => item.runId === runId && item.status === "pending" && !item.localProjectAccess
      )
    await until(async () => {
      const snapshot = await projectSnapshot(client)
      const run = (await client.call("runHistory", { conversationId, runId })).run
      if (["failed", "needs_review", "succeeded"].includes(run.status))
        throw Error(JSON.stringify({ run, log: f.logs.get(child) }))
      return originalApprovals(snapshot).length === 2
    })
    const first = originalApprovals(await projectSnapshot(client)).find(
      (item) => JSON.parse(item.prompt).hook
    )!
    expect(JSON.parse(first.prompt).hook.command).toBe("node notify.cjs 0")
    await client.call("answer", { id: first.id, revision: first.revision, answer: "approve" })
    await until(async () => {
      const run = (await client.call("runHistory", { conversationId, runId })).run
      if (["failed", "needs_review", "succeeded"].includes(run.status))
        throw Error(JSON.stringify({ run, log: f.logs.get(child) }))
      return originalApprovals(await projectSnapshot(client)).some(
        (item) => JSON.parse(item.prompt).hook?.command === "node notify.cjs 1"
      )
    })
    const before = await client.call("effects", runId)
    expect(before).toMatchObject([{ status: "succeeded" }])
    expect(await readFile(join(workspace, "notifications"), "utf8")).toBe("0")
    await f.stop(child, "SIGKILL")
    client.close()
    const nextChild = f.launch(),
      next = await f.connect(nextChild)
    await until(
      async () =>
        (await next.call("runHistory", { conversationId, runId })).run.status === "needs_review",
      40_000
    )
    const interrupted = (await next.call("runHistory", { conversationId, runId })).run
    await next.call("recover", {
      id: runId,
      revision: interrupted.revision,
      decision: "resume",
      note: "Reviewed the single completed notification",
      effects: []
    })
    await until(async () => {
      const snapshot = await projectSnapshot(next)
      const run = (await next.call("runHistory", { conversationId, runId })).run
      if (["failed", "needs_review", "succeeded"].includes(run.status))
        throw Error(JSON.stringify(run))
      return originalApprovals(snapshot).length === 2
    })
    const pending = originalApprovals(await projectSnapshot(next))
    const remaining = pending.find((item) => JSON.parse(item.prompt).hook)!
    const primary = pending.find((item) => item.id !== remaining.id)!
    expect(JSON.parse(remaining.prompt).hook.command).toBe("node notify.cjs 1")
    await next.call("answer", { id: remaining.id, revision: remaining.revision, answer: "approve" })
    await until(async () => {
      await projectSnapshot(next)
      return (await next.call("effects", runId)).length === 2
    })
    expect((await next.call("runHistory", { conversationId, runId })).run.status).toBe(
      "waiting_input"
    )
    await expect(readFile(join(workspace, "task-effects"))).rejects.toMatchObject({
      code: "ENOENT"
    })
    await next.call("answer", { id: primary.id, revision: primary.revision, answer: "approve" })
    await until(async () => {
      await projectSnapshot(next)
      return ["succeeded", "failed", "needs_review"].includes(
        (await next.call("runHistory", { conversationId, runId })).run.status
      )
    })
    expect(
      (await next.call("runHistory", { conversationId, runId })).run,
      f.logs.get(nextChild)
    ).toMatchObject({ status: "succeeded", result: "NOTIFICATION_RECOVERY_COMPLETE" })
    expect(await readFile(join(workspace, "notifications"), "utf8")).toBe("01")
    expect(await readFile(join(workspace, "task-effects"), "utf8")).toBe("x")
    const after = await next.call("effects", runId)
    expect(after).toHaveLength(3)
    expect(after.find((effect) => effect.id === before[0].id)).toEqual(before[0])
  },
  75_000
)

processTest(
  "owns bounded private diagnostics across detached Host restarts",
  async () => {
    const f = await fixture(() => ({ content: "DETACHED_WORK_COMPLETED" }))
    const log = join(f.directory, "host.log")
    await writeFile(log, "x".repeat(BOT_HOST_LOG_BYTES))
    const child = f.launch(true),
      client = await f.connect(child)
    await until(async () => (await readFile(log, "utf8")).includes("[BotHost] Ready"))
    const initial = await readFile(log, "utf8")
    expect(initial).toContain("[BotHost] Starting")
    expect((await stat(log + ".1")).size).toBe(BOT_HOST_LOG_BYTES)
    if (process.platform !== "win32") expect((await stat(log)).mode & 0o777).toBe(0o600)

    // A second launch cannot rotate or write the active owner's diagnostic file.
    const competing = f.launch(true)
    expect(await once(competing, "close")).toEqual([0, null])
    expect(await readFile(log, "utf8")).toBe(initial)
    const { conversationId } = await client.call("create", { nonce: "detached", name: "Detached" })
    const {
      runIds: [runId]
    } = await client.call("send", {
      nonce: "detached-work",
      conversationId,
      text: "Complete a task without desktop output pipes"
    })
    await until(async () => {
      const { run } = await client.call("runHistory", { conversationId, runId })
      if (run.status === "failed") throw new Error(await readFile(log, "utf8"))
      return run.status === "succeeded"
    })
    await f.stop(child)
    client.close()
    const restarted = f.launch(true),
      next = await f.connect(restarted)
    expect(
      (await next.call("messages", { conversationId })).some(
        (m) => m.text === "DETACHED_WORK_COMPLETED"
      )
    ).toBe(true)
    const persisted = await readFile(log, "utf8")
    expect(persisted.match(/\[BotHost\] Starting/g)).toHaveLength(2)
    expect((await stat(log)).size).toBeLessThanOrEqual(BOT_HOST_LOG_BYTES)
  },
  30_000
)

processTest(
  "keeps a startup failure diagnostic with ignored stdio and releases ownership on exit",
  async () => {
    const f = await fixture(() => ({ content: "unused" }))
    await writeFile(join(f.directory, "bots.sqlite"), "corrupt database fixture")
    const failed = f.launch(true)
    expect(await once(failed, "close")).toEqual([1, null])
    const log = await readFile(join(f.directory, "host.log"), "utf8")
    expect(log).toContain("Startup failed")
    expect(log).toContain("not a database")
    await rm(join(f.directory, "bots.sqlite"))
    const next = await f.connect(f.launch(true))
    expect((await next.call("status")).hostId).toBeTruthy()
    expect(f.requests).toEqual([])
  },
  30_000
)

processTest.each(["pending", "completed", "in-flight"] as const)(
  "preserves an exact MCP resource read across compiled Host SIGKILL (%s)",
  async (phase) => {
    const f = await fixture((body, index) => {
      const call = (name: string, args: unknown) => ({
        content: null,
        tool_calls: [
          {
            id: `resource-${index}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) }
          }
        ]
      })
      if (index === 1)
        return call("list_connector_resources", { provider: "notes", kind: "resources" })
      if (index === 2) {
        const output = body.messages.filter((message) => message.role === "tool").at(-1)!
        return call("read_connector_resource", {
          provider: "notes",
          kind: "resources",
          id: JSON.parse(String(output.content)).items[0].id
        })
      }
      return { content: "RESOURCE_READ_PRESERVED" }
    })
    const provider = await mcpFixture(phase === "in-flight" ? "held" : "normal", undefined, {
      only: true
    })
    cleanup.unshift(provider.close)
    const workspace = `${f.directory}-workspaces`,
      settings = join(workspace, "resource-hooks")
    await mkdir(workspace)
    await mkdir(settings)
    await writeFile(join(settings, "plugins.json"), "[]")
    await writeFile(
      join(settings, "hooks.json"),
      JSON.stringify([
        {
          id: "resource-post",
          event: "PostToolUse",
          matcher: "read_connector_resource",
          command: "node post.cjs",
          enabled: true
        }
      ])
    )
    await writeFile(
      join(settings, "post.cjs"),
      `process.stdin.resume();process.stdin.on('end',()=>{require('fs').appendFileSync(require('path').join(process.env.WORKSPACE_PATH,'post-count'),'x');console.log('{}')})`
    )
    const modelFile = join(f.directory, "models.private")
    await writeBotModelSnapshot(modelFile, {
      ...(await readBotModelSnapshot(modelFile)),
      mcpSources: [provider.source],
      hookSources: { root: settings },
      execution: { windowsSandbox: "none", resourceDirectory: resolve("resources") }
    })
    const first = f.launch(),
      client = await f.connect(first)
    const { conversationId } = await client.call("create", {
      nonce: "bot",
      name: "Resources",
      workspacePath: workspace,
      connectorIds: ["notes"]
    })
    const {
      runIds: [runId]
    } = await client.call("send", {
      nonce: "task",
      conversationId,
      text: "Read the first listed resource"
    })
    await until(async () =>
      (await client.call("snapshot")).interactions.some((i) => i.status === "pending")
    )
    const initial = (await client.call("snapshot")).interactions.find(
      (i) => i.status === "pending"
    )!
    expect(JSON.parse(initial.prompt).connector.arguments).toEqual({
      uri: "notes://resource/first"
    })
    if (phase !== "pending") {
      await client.call("answer", { id: initial.id, revision: initial.revision, answer: "approve" })
      await until(async () => (await provider.calls()).length === 1)
      if (phase === "completed")
        await until(async () =>
          (await client.call("snapshot")).interactions.some(
            (i) => i.status === "pending" && JSON.parse(i.prompt).hook?.event === "PostToolUse"
          )
        )
    }
    await f.stop(first, "SIGKILL")
    const second = f.launch(),
      next = await f.connect(second)
    await until(
      async () =>
        (await next.call("snapshot")).runs.some(
          (r) => r.id === runId && r.status === "needs_review"
        ),
      40_000
    )
    const effects = await next.call("effects", runId)
    expect(await provider.calls()).toHaveLength(phase === "pending" ? 0 : 1)
    if (phase === "in-flight") {
      expect(effects).toMatchObject([{ status: "unknown" }])
      expect(f.requests).toHaveLength(2)
      return
    }
    const run = (await next.call("snapshot")).runs.find((r) => r.id === runId)!
    await next.call("recover", {
      id: runId,
      revision: run.revision,
      decision: "resume",
      note: "Confirmed saved resource progress",
      effects: []
    })
    const actions: Record<string, unknown>[] = []
    await until(async () => {
      const state = await next.call("snapshot")
      const active = (await next.call("runHistory", { conversationId, runId })).run
      if (active && ["failed", "needs_review"].includes(active.status))
        throw new Error(
          JSON.stringify({
            run: active,
            effects: await next.call("effects", runId),
            log: f.logs.get(second)
          })
        )
      const approval = state.interactions.find((i) => i.status === "pending" && i.runId === runId)
      if (approval) {
        actions.push(JSON.parse(approval.prompt))
        await next.call("answer", {
          id: approval.id,
          revision: approval.revision,
          answer: "approve"
        })
      }
      return active.status === "succeeded"
    }).catch(async (error) => {
      throw new Error(
        JSON.stringify({
          failure: String(error),
          state: await next.call("snapshot"),
          effects: await next.call("effects", runId),
          log: f.logs.get(second)
        })
      )
    })
    expect(actions.filter((action) => action.connector)).toHaveLength(phase === "pending" ? 1 : 0)
    expect(actions.filter((action) => action.hook)).toHaveLength(1)
    expect(await provider.calls()).toEqual([
      { method: "resources/read", uri: "notes://resource/first" }
    ])
    expect(await readFile(join(workspace, "post-count"), "utf8")).toBe("x")
    expect(f.requests).toHaveLength(3)
  },
  60_000
)

processTest(
  "resumes child lifecycle settlement after compiled Host SIGKILL without repeating child work",
  async () => {
    const f = await fixture((body) => {
      if (body.tools.some((t) => t.function.name === "workflow"))
        return body.messages.some((m) => m.role === "tool")
          ? { content: "PARENT_RECEIVED_VERIFIED_CHILD" }
          : {
              content: null,
              tool_calls: [
                {
                  id: "child-workflow",
                  type: "function",
                  function: {
                    name: "workflow",
                    arguments: JSON.stringify({
                      script:
                        'export const meta={name:"Review",description:"Review"}; return await agent("Review assigned evidence");',
                      maxConcurrency: 1
                    })
                  }
                }
              ]
            }
      return { content: "CHILD_COMPLETION_PRESERVED" }
    })
    const external = await mkdtemp(join(tmpdir(), "cmb-child-lifecycle-process-"))
    cleanup.unshift(() => rm(external, { recursive: true, force: true }))
    const workspace = join(external, "project"),
      settings = join(external, "settings")
    await mkdir(workspace)
    await mkdir(settings)
    await writeFile(join(settings, "plugins.json"), "[]")
    await writeFile(
      join(settings, "hooks.json"),
      JSON.stringify([
        { id: "start", event: "SubagentStart", command: "node start.cjs", enabled: true },
        { id: "first", event: "SubagentStop", command: "node first.cjs", enabled: true },
        { id: "last", event: "SubagentStop", command: "node last.cjs", enabled: true }
      ])
    )
    for (const name of ["start", "first", "last"])
      await writeFile(
        join(settings, `${name}.cjs`),
        `process.stdin.resume();process.stdin.on('end',()=>{require('fs').appendFileSync(require('path').join(process.env.WORKSPACE_PATH,'child-checks'),${JSON.stringify(name + "\n")});console.log('{}')})`
      )
    const modelFile = join(f.directory, "models.private")
    await writeBotModelSnapshot(modelFile, {
      ...(await readBotModelSnapshot(modelFile)),
      hookSources: { root: settings },
      execution: { windowsSandbox: "none", resourceDirectory: resolve("resources") }
    })
    const first = f.launch(),
      client = await f.connect(first)
    const { conversationId } = await client.call("create", {
      nonce: "bot",
      name: "Reviewer",
      workspacePath: workspace
    })
    const sent = await client.call("send", {
      nonce: "task",
      conversationId,
      text: "Review with a child task"
    })
    const projectSnapshot = await createRecoveryProjectSnapshot({
      workspace,
      conversationId,
      runId: sent.runIds[0],
      children: {
        limit: 1,
        access: () => ({ commands: ["node start.cjs", "node first.cjs", "node last.cjs"] })
      }
    })
    const pendingChildHook = (snapshot: Awaited<ReturnType<typeof projectSnapshot>>) =>
      snapshot.interactions.find(
        (item) =>
          item.status === "pending" &&
          !item.localProjectAccess &&
          snapshot.runs.some(
            (run) =>
              run.id === item.runId &&
              run.parentRunId === sent.runIds[0] &&
              run.conversationId === conversationId &&
              run.rootRunId === sent.runIds[0]
          )
      )
    let childId = ""
    for (const event of ["SubagentStart", "SubagentStop"]) {
      await until(async () => Boolean(pendingChildHook(await projectSnapshot(client))))
      const approval = pendingChildHook(await projectSnapshot(client))!
      expect(JSON.parse(approval.prompt).hook.event).toBe(event)
      expect(approval.runId).not.toBe(sent.runIds[0])
      childId ||= approval.runId
      expect(approval.runId).toBe(childId)
      await client.call("answer", {
        id: approval.id,
        revision: approval.revision,
        answer: "approve"
      })
    }
    await until(async () =>
      (await projectSnapshot(client)).interactions.some(
        (i) => i.runId === childId && i.status === "pending" && !i.localProjectAccess
      )
    )
    expect(await readFile(join(workspace, "child-checks"), "utf8")).toBe("start\nfirst\n")
    expect(f.requests).toHaveLength(2)
    await f.stop(first, "SIGKILL")
    const second = f.launch(),
      next = await f.connect(second)
    await until(
      async () =>
        (await projectSnapshot(next)).runs.some(
          (r) => r.id === sent.runIds[0] && r.status === "needs_review"
        ),
      40_000
    )
    for (const id of [childId, sent.runIds[0]]) {
      const run = (await projectSnapshot(next)).runs.find((r) => r.id === id)!
      expect(run.status).toBe("needs_review")
      await next.call("recover", {
        id,
        revision: run.revision,
        decision: "resume",
        note: "Verified completed child checks",
        effects: []
      })
    }
    await until(async () =>
      (await projectSnapshot(next)).interactions.some(
        (i) => i.runId === childId && i.status === "pending" && !i.localProjectAccess
      )
    )
    const last = (await projectSnapshot(next)).interactions.find(
      (i) => i.runId === childId && i.status === "pending" && !i.localProjectAccess
    )!
    expect(JSON.parse(last.prompt).hook.command).toBe("node last.cjs")
    await next.call("answer", { id: last.id, revision: last.revision, answer: "approve" })
    await until(async () => {
      await projectSnapshot(next)
      return (
        (await next.call("runHistory", { conversationId, runId: sent.runIds[0] })).run.status ===
        "succeeded"
      )
    })
    const history = await next.call("runHistory", { conversationId, runId: childId })
    expect(history.run.result).toContain("CHILD_COMPLETION_PRESERVED")
    expect(await readFile(join(workspace, "child-checks"), "utf8")).toBe("start\nfirst\nlast\n")
    expect(f.requests).toHaveLength(3)
    expect(await next.call("effects", childId)).toHaveLength(3)
  },
  60_000
)

processTest.each([
  { kind: "mcp", phase: "completed" },
  { kind: "mcp", phase: "in-flight" },
  { kind: "file", phase: "completed" },
  { kind: "shell", phase: "in-flight" }
] as const)(
  "retains an explicit plugin command across compiled Host SIGKILL ($kind, $phase)",
  async ({ kind, phase }) => {
    const f = await fixture(() => ({ content: "MUST_NOT_CALL_MODEL" }))
    const provider = await mcpFixture(phase === "in-flight" ? "held" : "normal")
    cleanup.unshift(provider.close)
    const external = await mkdtemp(join(tmpdir(), "cmb-plugin-command-process-"))
    cleanup.unshift(() => rm(external, { recursive: true, force: true }))
    const workspace = join(external, "project"),
      plugin = join(external, "plugin"),
      settings = join(external, "settings")
    await mkdir(workspace)
    await mkdir(settings)
    await writeFile(join(workspace, "app.ts"), "const value = 1\n")
    await writeFile(
      join(workspace, "worker.cjs"),
      "require('fs').appendFileSync('dispatch-count','x');setInterval(()=>{},1000)"
    )
    await cp(resolve("resources/mods/function-commands"), plugin, { recursive: true })
    await writeFile(
      join(plugin, "hooks/registered-tools.ts"),
      `export function register(on){
      on("session.start",{},async($,e,next)=>{await $.command.register({name:"note",description:"Save one note"});return next(e)});
      on("command.run",{command:"note"},async($)=>{
        ${
          kind === "mcp"
            ? `return {text:JSON.stringify(await $.mcp.call("Notes","append_note",{text:"ONE_COMMAND"}))};`
            : kind === "file"
              ? `await $.tool.call({tool:"read_file",file_path:"app.ts"});return {text:JSON.stringify(await $.tool.call({tool:"edit_file",file_path:"app.ts",old_string:"value = 1",new_string:"value = 2"}))};`
              : `return {text:JSON.stringify(await $.tool.call({tool:"execute",command:"node worker.cjs"}))};`
        }
      });
    }`
    )
    await writeFile(join(settings, "plugins.json"), "[]")
    await writeFile(
      join(settings, "hooks.json"),
      JSON.stringify([
        { id: "end", event: "SessionEnd", command: "node end.cjs", enabled: true },
        ...(kind === "mcp" || kind === "file"
          ? [
              {
                id: "post",
                event: "PostToolUse",
                matcher: kind === "mcp" ? "mcp__notes__append_note" : "edit_file",
                command: "node post.cjs",
                enabled: true
              }
            ]
          : [])
      ])
    )
    await writeFile(
      join(settings, "end.cjs"),
      `process.stdin.resume();process.stdin.on('end',()=>console.log('{}'))`
    )
    await writeFile(
      join(settings, "post.cjs"),
      `process.stdin.resume();process.stdin.on('end',()=>{require('fs').appendFileSync(require('path').join(process.env.WORKSPACE_PATH,'sdk-hook-count'),'x');console.log(JSON.stringify({additionalContext:'SDK_RESULT_REVIEWED'}))})`
    )
    const config = await readBotModelSnapshot(join(f.directory, "models.private"))
    await writeBotModelSnapshot(join(f.directory, "models.private"), {
      ...config,
      mcpSources: [provider.source],
      hookSources: { root: settings },
      execution: { windowsSandbox: "none", resourceDirectory: resolve("resources") },
      mods: {
        enabled: true,
        policy: DEFAULT_MOD_POLICY,
        plugins: [{ id: "fixture", name: "Commands", path: plugin, enabled: true }]
      }
    })
    const first = f.launch(),
      client = await f.connect(first)
    const { conversationId } = await client.call("create", {
      nonce: "bot",
      name: "Commands",
      workspacePath: workspace,
      connectorIds: ["bot-mod:fixture", provider.source.providerKey]
    })
    const sent = await client.call("send", { nonce: "send", conversationId, text: "/plugin note" })
    let commandApprovalId: string | undefined
    const dispatchCount = async () =>
      kind === "mcp"
        ? (await provider.calls()).length
        : kind === "shell"
          ? (await readFile(join(workspace, "dispatch-count"), "utf8").catch(() => "")).length
          : (await readFile(join(workspace, "app.ts"), "utf8")) === "const value = 2\n"
            ? 1
            : 0
    await until(async () => {
      const approval = (await client.call("snapshot")).interactions.find(
        (i) => i.status === "pending"
      )
      if (approval) {
        const action = JSON.parse(approval.prompt)
        if (action.hook?.event === "SessionEnd") return true
        if (action.pluginCommand) commandApprovalId = approval.id
        await client.call("answer", {
          id: approval.id,
          revision: approval.revision,
          answer: "approve"
        })
      }
      return phase === "in-flight" && (await dispatchCount()) === 1
    })
    expect(await dispatchCount()).toBe(1)
    expect(f.requests).toEqual([])
    await f.stop(first, "SIGKILL")
    const second = f.launch(),
      next = await f.connect(second)
    await until(
      async () =>
        (await next.call("snapshot")).runs.some(
          (r) => r.id === sent.runIds[0] && r.status === "needs_review"
        ),
      40_000
    )
    const run = (await next.call("snapshot")).runs.find((r) => r.id === sent.runIds[0])!
    const effects = await next.call("effects", run.id)
    expect(commandApprovalId).toBeTruthy()
    const commandHistory = await next.call("interactionDetail", {
      conversationId,
      runId: run.id,
      interactionId: commandApprovalId!
    })
    expect(commandHistory.interaction.answer).toBe("approve")
    expect(JSON.parse(commandHistory.interaction.prompt).pluginCommand.name).toBe("note")
    expect(commandHistory.effects).toMatchObject([{ id: `plugin-command:${run.id}` }])
    if (phase === "in-flight") {
      expect(effects.filter((e) => e.status === "unknown")).toHaveLength(2)
      await delay(400)
      expect(await dispatchCount()).toBe(1)
    } else {
      expect(effects.every((e) => e.status === "succeeded")).toBe(true)
      await next.call("recover", {
        id: run.id,
        revision: run.revision,
        decision: "resume",
        note: "Completed command verified",
        effects: []
      })
      await until(async () =>
        (await next.call("snapshot")).interactions.some(
          (i) => i.runId === run.id && i.status === "pending"
        )
      )
      const approval = (await next.call("snapshot")).interactions.find(
        (i) => i.runId === run.id && i.status === "pending"
      )!
      expect(JSON.parse(approval.prompt).hook.event).toBe("SessionEnd")
      await next.call("answer", { id: approval.id, revision: approval.revision, answer: "approve" })
      await until(
        async () =>
          (await next.call("runHistory", { conversationId, runId: run.id })).run.status ===
          "succeeded"
      )
      expect(
        (await next.call("runHistory", { conversationId, runId: run.id })).run.result
      ).toContain(kind === "mcp" ? "saved: ONE_COMMAND" : "patchArtifactId")
      if (kind === "mcp" || kind === "file") {
        const result = JSON.parse(
          (await next.call("runHistory", { conversationId, runId: run.id })).run.result!
        )
        if (kind === "mcp") {
          expect(result.isError).toBe(false)
          expect(JSON.stringify(result.content)).toContain("SDK_RESULT_REVIEWED")
        } else {
          expect(result.isError).toBeUndefined()
          expect(result.result.patchArtifactId).toEqual(expect.any(String))
          expect(result.result.hookFeedback).toContain("SDK_RESULT_REVIEWED")
        }
        expect(await readFile(join(workspace, "sdk-hook-count"), "utf8")).toBe("x")
      }
      expect(await dispatchCount()).toBe(1)
      expect(f.requests).toEqual([])
    }
  },
  60_000
)

processTest(
  "reconciles a published scheduled snapshot in the compiled Host without a desktop and retains configuration receipts after SIGKILL",
  async () => {
    const f = await fixture(() => ({ content: "unused" }))
    const seed = new BotStore(join(f.directory, "bots.sqlite"), () => 1)
    const request = {
      nonce: randomUUID(),
      dataEpoch: "initial",
      revision: 0,
      enabled: true,
      intervalHours: 24
    }
    seed.backupSchedule.change(request)
    seed.close()
    const due = new BotStore(join(f.directory, "bots.sqlite"))
    const pending = due.backupSchedule.claim()!
    expect(pending).toBeTruthy()
    const sealed = await createScheduledBotSnapshot(f.directory, pending)
    due.close()
    const first = f.launch(),
      client = await f.connect(first)
    await until(async () => (await client.call("backupSchedule")).lastBackup?.id === sealed.id)
    expect((await client.call("status")).capabilities).toContain("scheduled-backups")
    await until(async () => (await client.call("status")).storage?.complete === true)
    expect((await client.call("status")).storage!.volumes[0].totalBytes).toBeGreaterThan(0)
    const state = await client.call("backupSchedule")
    expect(state.pendingId).toBeNull()
    expect(state.error).toBeNull()
    const change = {
      nonce: randomUUID(),
      dataEpoch: state.dataEpoch,
      revision: state.revision,
      enabled: false,
      intervalHours: 12
    }
    const receipt = await client.call("changeBackupSchedule", change)
    await f.stop(first, "SIGKILL")
    const second = f.launch(),
      resumed = await f.connect(second)
    expect(await resumed.call("changeBackupSchedule", change)).toEqual(receipt)
    expect(await resumed.call("backupSchedule")).toMatchObject({
      enabled: false,
      intervalHours: 12,
      revision: 2,
      pendingId: null,
      lastBackup: sealed
    })
    expect(await listBotBackups(f.directory)).toHaveLength(1)
    expect(f.requests).toHaveLength(0)
  },
  30_000
)

processTest.each(["user", "routine", "peer"] as const)(
  "retains independent review evidence after compiled Host SIGKILL without replaying an uncertain connector (%s)",
  async (source) => {
    const provider = await mcpFixture("held")
    cleanup.push(provider.close)
    let peerRecipient = ""
    const f = await fixture((body) => {
      if (String(body.messages[0]?.content).includes("independently review ONE")) {
        const context = JSON.parse(String(body.messages[1].content)),
          task = context.task
        if (source === "peer" && context.proposedAction.connector)
          expect(task.peer?.handoffs[0]).toMatchObject({
            toBotId: peerRecipient,
            assignment: "PEER_ASSIGNMENT: append ONE to Notes"
          })
        expect(task.messages[0].text).toBe("Append ONE to Notes")
        if (source === "routine")
          expect(task.routine).toMatchObject({
            origin: "human",
            trigger: "event",
            eventData: "RUN_ONCE"
          })
        return {
          content: JSON.stringify({ decision: "allow", reason: "用户明确要求向此连接器保存 ONE" })
        }
      }
      if (body.messages.at(-1)?.role === "tool") return { content: "Saved" }
      if (source === "peer" && !JSON.stringify(body.messages).includes("PEER_ASSIGNMENT:"))
        return {
          tool_calls: [
            {
              id: "assign-note",
              type: "function",
              function: {
                name: "message_bot",
                arguments: JSON.stringify({
                  bot_id: peerRecipient,
                  message: "PEER_ASSIGNMENT: append ONE to Notes"
                })
              }
            }
          ]
        }
      return {
        content: "",
        tool_calls: [
          {
            id: "reviewed-note",
            type: "function",
            function: {
              name: "call_connector_tool",
              arguments: JSON.stringify({
                id: "connector:notes:append_note",
                arguments_json: JSON.stringify({ text: "ONE" })
              })
            }
          }
        ]
      }
    })
    const modelPath = join(f.directory, "models.private")
    await writeBotModelSnapshot(modelPath, {
      ...(await readBotModelSnapshot(modelPath)),
      mcpSources: [provider.source]
    })
    const first = f.launch(),
      client = await f.connect(first)
    const { bot, conversationId } = await client.call("create", {
      nonce: "bot",
      name: "Reviewer",
      connectorIds: [provider.source.providerKey]
    })
    const change = {
      ...(await client.call("autoReviewSettings", bot.id)),
      isEnabled: true,
      nonce: "enable"
    }
    const settings = await client.call("changeAutoReview", change)
    let executionConversation = conversationId
    if (source === "peer") {
      const peer = await client.call("create", {
        nonce: "peer",
        name: "Worker",
        connectorIds: [provider.source.providerKey]
      })
      peerRecipient = peer.bot.id
      executionConversation = peer.conversationId
      await client.call("changeAutoReview", {
        ...(await client.call("autoReviewSettings", peerRecipient)),
        isEnabled: true,
        nonce: "enable-peer"
      })
    }
    if (source === "routine")
      await client.call("saveRoutine", {
        botId: bot.id,
        name: "Notes",
        prompt: "Append ONE to Notes",
        timezone: "UTC",
        enabled: true,
        schedule: { kind: "event", topic: "notes.changed" }
      })
    const sent =
      source === "routine"
        ? await client.call("emitEvent", {
            nonce: "task",
            topic: "notes.changed",
            payload: "RUN_ONCE"
          })
        : await client.call("send", {
            nonce: "task",
            conversationId,
            text: "Append ONE to Notes"
          })
    await until(async () => (await provider.calls()).length === 1)
    const executionRunId =
      source === "peer"
        ? (await client.call("snapshot")).runs.find(
            (run) => run.source === "peer" && run.parentRunId === sent.runIds[0]
          )!.id
        : sent.runIds[0]
    if (source === "peer")
      await until(
        async () =>
          (await client.call("runHistory", { conversationId, runId: sent.runIds[0] })).run
            .status === "succeeded"
      )
    const history = await client.call("runHistory", {
      conversationId: executionConversation,
      runId: executionRunId
    })
    const approvalId = history.items.find((item) => item.label === "独立审核已批准")?.interactionId
    expect(approvalId).toBeTruthy()
    await f.stop(first, "SIGKILL")
    const resumed = await f.connect(f.launch())
    expect(await resumed.call("autoReviewSettings", bot.id)).toEqual(settings)
    expect(await resumed.call("changeAutoReview", change)).toEqual(settings)
    await until(
      async () =>
        (
          await resumed.call("runHistory", {
            conversationId: executionConversation,
            runId: executionRunId
          })
        ).run.status === "needs_review",
      40_000
    )
    const detail = await resumed.call("interactionDetail", {
      conversationId: executionConversation,
      runId: executionRunId,
      interactionId: approvalId!
    })
    expect(detail.interaction.autoReview).toMatchObject({
      decision: "allow",
      reason: "用户明确要求向此连接器保存 ONE"
    })
    expect(detail.effects).toMatchObject([{ status: "unknown" }])
    await delay(400)
    expect(await provider.calls()).toHaveLength(1)
    expect(f.requests).toHaveLength(source === "peer" ? 5 : 2)
  },
  75_000
)

processTest(
  "retains exact command rules through compiled Host SIGKILL and rechecks ask-first before dispatch",
  async () => {
    const f = await fixture((body) =>
      body.messages.at(-1)?.role === "tool"
        ? { content: "COMMAND_DONE" }
        : {
            content: "",
            tool_calls: [
              {
                id: "command",
                type: "function",
                function: {
                  name: "execute",
                  arguments: JSON.stringify({ command: "npm test", timeout_seconds: 30 })
                }
              }
            ]
          }
    )
    const workspace = `${f.directory}-workspaces`
    await mkdir(workspace)
    await writeFile(
      join(workspace, "package.json"),
      JSON.stringify({ private: true, scripts: { test: "node test.cjs" } })
    )
    await writeFile(
      join(workspace, "test.cjs"),
      "require('fs').appendFileSync('count','x');console.log('COMMAND_OK')"
    )
    const modelPath = join(f.directory, "models.private")
    await writeBotModelSnapshot(modelPath, {
      ...(await readBotModelSnapshot(modelPath)),
      execution: { windowsSandbox: "none", resourceDirectory: resolve("resources") }
    })
    const first = f.launch(),
      client = await f.connect(first)
    const { bot, conversationId } = await client.call("create", {
      nonce: "bot",
      name: "Tester",
      workspacePath: workspace
    })
    const sent = await client.call("send", { nonce: "first", conversationId, text: "Run tests" })
    await until(async () => (await client.call("snapshot")).interactions.length > 0)
    const request = (await client.call("snapshot")).interactions[0]
    expect(request.review?.canRemember).toBe(true)
    await client.call("answer", {
      id: request.id,
      revision: request.revision,
      answer: "approve",
      remember: true
    })
    await until(
      async () =>
        (await client.call("runHistory", { conversationId, runId: sent.runIds[0] })).run.status ===
        "succeeded"
    )
    await f.stop(first, "SIGKILL")
    const second = f.launch(),
      resumed = await f.connect(second)
    expect((await resumed.call("approvalRules", bot.id)).rules).toHaveLength(1)
    const next = await resumed.call("send", {
      nonce: "second",
      conversationId,
      text: "Run tests again"
    })
    await until(
      async () =>
        (await resumed.call("runHistory", { conversationId, runId: next.runIds[0] })).run.status ===
        "succeeded"
    )
    expect(await readFile(join(workspace, "count"), "utf8")).toBe("xx")
    const rules = await resumed.call("approvalRules", bot.id)
    const change = {
      botId: bot.id,
      ruleId: rules.rules[0].id,
      revision: rules.revision,
      dataEpoch: rules.dataEpoch,
      nonce: "ask-first",
      behavior: "ask" as const
    }
    const receipt = await resumed.call("changeApprovalRule", change)
    await f.stop(second, "SIGKILL")
    const final = await f.connect(f.launch())
    expect(await final.call("changeApprovalRule", change)).toEqual(receipt)
    const third = await final.call("send", {
      nonce: "third",
      conversationId,
      text: "Run tests again"
    })
    await until(async () => (await final.call("snapshot")).interactions.length > 0)
    const manual = (await final.call("snapshot")).interactions[0]
    expect(manual.review?.canRemember).toBe(false)
    await final.call("answer", { id: manual.id, revision: manual.revision, answer: "reject" })
    await until(
      async () =>
        (await final.call("runHistory", { conversationId, runId: third.runIds[0] })).run.status ===
        "succeeded"
    )
    expect(await readFile(join(workspace, "count"), "utf8")).toBe("xx")
  },
  60_000
)

processTest.each(["success", "failure"])(
  "resumes compiled SessionEnd settlement after SIGKILL without repeating the model (%s)",
  async (outcome) => {
    const f = await fixture(() =>
      outcome === "failure"
        ? { fixtureHttpStatus: 401 }
        : { content: "SESSION_COMPLETION_PRESERVED" }
    )
    const external = await mkdtemp(join(tmpdir(), "cmb-session-process-"))
    cleanup.unshift(() => rm(external, { recursive: true, force: true }))
    const workspace = join(external, "project"),
      settings = join(external, "settings")
    await mkdir(workspace)
    await mkdir(settings)
    await writeFile(join(settings, "plugins.json"), "[]")
    await writeFile(
      join(settings, "hooks.json"),
      JSON.stringify([
        { id: "start", event: "SessionStart", command: "node start.cjs", enabled: true },
        { id: "end-first", event: "SessionEnd", command: "node first.cjs", enabled: true },
        { id: "end-last", event: "SessionEnd", command: "node last.cjs", enabled: true }
      ])
    )
    for (const name of ["start", "first", "last"])
      await writeFile(
        join(settings, `${name}.cjs`),
        `process.stdin.resume();process.stdin.on('end',()=>{require('fs').appendFileSync(require('path').join(process.env.WORKSPACE_PATH,'sessions'),${JSON.stringify(name + "\n")});console.log('{}')})`
      )
    const modelFile = join(f.directory, "models.private")
    await writeBotModelSnapshot(modelFile, {
      ...(await readBotModelSnapshot(modelFile)),
      hookSources: { root: settings },
      execution: { windowsSandbox: "none", resourceDirectory: resolve("resources") }
    })
    const first = f.launch(),
      client = await f.connect(first)
    const { conversationId } = await client.call("create", {
      nonce: "bot",
      name: "Reviewer",
      workspacePath: workspace
    })
    const sent = await client.call("send", {
      nonce: "task",
      conversationId,
      text: "Finish the review"
    })
    const approved = new Set<string>()
    for (const event of ["SessionStart", "SessionEnd"]) {
      await until(async () =>
        (await client.call("snapshot")).interactions.some((item) => !approved.has(item.id))
      )
      const approval = (await client.call("snapshot")).interactions.find(
        (item) => !approved.has(item.id)
      )!
      expect(JSON.parse(approval.prompt).hook.event).toBe(event)
      approved.add(approval.id)
      await client.call("answer", {
        id: approval.id,
        revision: approval.revision,
        answer: "approve"
      })
    }
    await until(async () =>
      (await client.call("snapshot")).interactions.some((item) => !approved.has(item.id))
    )
    expect(await readFile(join(workspace, "sessions"), "utf8")).toBe("start\nfirst\n")
    expect(f.requests).toHaveLength(1)
    await f.stop(first, "SIGKILL")
    const second = f.launch(),
      next = await f.connect(second)
    await until(
      async () =>
        (await next.call("snapshot")).runs.some(
          (run) => run.id === sent.runIds[0] && run.status === "needs_review"
        ),
      40_000
    )
    const run = (await next.call("snapshot")).runs.find((run) => run.id === sent.runIds[0])!
    await next.call("recover", {
      id: run.id,
      revision: run.revision,
      decision: "resume",
      note: "Verified completed checks",
      effects: []
    })
    await until(async () =>
      (await next.call("snapshot")).interactions.some((item) => item.runId === run.id)
    )
    const last = (await next.call("snapshot")).interactions.find((item) => item.runId === run.id)!
    expect(JSON.parse(last.prompt).hook.command).toBe("node last.cjs")
    await next.call("answer", { id: last.id, revision: last.revision, answer: "approve" })
    await until(async () =>
      ["succeeded", "failed"].includes(
        (await next.call("runHistory", { conversationId, runId: run.id })).run.status
      )
    )
    expect(
      (await next.call("runHistory", { conversationId, runId: run.id })).run.status,
      f.logs.get(second)
    ).toBe(outcome === "failure" ? "failed" : "succeeded")
    expect(f.requests).toHaveLength(1)
    expect(await readFile(join(workspace, "sessions"), "utf8")).toBe("start\nfirst\nlast\n")
    expect(await next.call("effects", run.id)).toHaveLength(3)
    if (outcome === "success")
      expect((await next.call("messages", { conversationId })).at(-1)?.text).toBe(
        "SESSION_COMPLETION_PRESERVED"
      )
  },
  60_000
)

processTest.each([false, true])(
  "restores compiled configured Hooks without duplicate checks and rejects a changed configuration=%s",
  async (changed) => {
    const f = await fixture((_body, index) =>
      index === 1 ? null : { content: "CONFIGURED_HOOKS_RESUMED" }
    )
    const external = await mkdtemp(join(tmpdir(), "cmb-configured-process-"))
    cleanup.unshift(() => rm(external, { recursive: true, force: true }))
    const settings = join(external, "settings"),
      workspace = join(external, "project")
    await mkdir(settings)
    await mkdir(join(workspace, ".cmbdevclaw/hooks"), { recursive: true })
    const hook = { event: "UserPromptSubmit", enabled: true, command: "node check.cjs" }
    await writeFile(join(settings, "hooks.json"), JSON.stringify([{ id: "global", ...hook }]))
    await writeFile(join(settings, "plugins.json"), "[]")
    await writeFile(join(workspace, ".cmbdevclaw/hooks/input.json"), JSON.stringify(hook))
    for (const root of [settings, workspace])
      await writeFile(
        join(root, "check.cjs"),
        `
      process.stdin.resume();process.stdin.on('end',()=>{
        require('fs').appendFileSync(require('path').join(process.env.WORKSPACE_PATH,'checks'),'x');
        console.log(JSON.stringify({additionalContext:'CONFIGURED_INPUT_CHECKED'}));
      });
    `
      )
    const modelFile = join(f.directory, "models.private")
    await writeBotModelSnapshot(modelFile, {
      ...(await readBotModelSnapshot(modelFile)),
      hookSources: { root: settings },
      execution: { windowsSandbox: "none", resourceDirectory: resolve("resources") }
    })
    const first = f.launch(),
      client = await f.connect(first)
    const { conversationId } = await client.call("create", {
      nonce: "bot",
      name: "Reviewer",
      workspacePath: workspace
    })
    const sent = await client.call("send", {
      nonce: "task",
      conversationId,
      text: "Check the project"
    })
    const approved = new Set<string>()
    for (let index = 0; index < 2; index++) {
      await until(async () =>
        (await client.call("snapshot")).interactions.some(
          (item) => item.kind === "approval" && !approved.has(item.id)
        )
      )
      const approval = (await client.call("snapshot")).interactions.find(
        (item) => item.kind === "approval" && !approved.has(item.id)
      )!
      expect(JSON.parse(approval.prompt).hook.event).toBe("UserPromptSubmit")
      expect(f.requests).toHaveLength(0)
      approved.add(approval.id)
      await client.call("answer", {
        id: approval.id,
        revision: approval.revision,
        answer: "approve"
      })
    }
    await until(async () => f.requests.length === 1)
    expect(await readFile(join(workspace, "checks"), "utf8")).toBe("xx")
    const effects = await client.call("effects", sent.runIds[0])
    expect(effects).toHaveLength(2)
    await f.stop(first, "SIGKILL")
    if (changed) await writeFile(join(settings, "hooks.json"), "[]")
    const second = f.launch(),
      next = await f.connect(second)
    await until(
      async () =>
        (await next.call("snapshot")).runs.some(
          (run) => run.id === sent.runIds[0] && run.status === "needs_review"
        ),
      40_000
    )
    const interrupted = (await next.call("snapshot")).runs.find((run) => run.id === sent.runIds[0])!
    await next.call("recover", {
      id: interrupted.id,
      revision: interrupted.revision,
      decision: "resume",
      note: "Verified completed checks",
      effects: []
    })
    await until(async () =>
      ["succeeded", "failed"].includes(
        (await next.call("runHistory", { conversationId, runId: sent.runIds[0] })).run.status
      )
    )
    expect(
      (await next.call("runHistory", { conversationId, runId: sent.runIds[0] })).run.status,
      f.logs.get(second)
    ).toBe(changed ? "failed" : "succeeded")
    expect(await readFile(join(workspace, "checks"), "utf8")).toBe("xx")
    expect(await next.call("effects", sent.runIds[0])).toEqual(effects)
    expect(f.requests).toHaveLength(changed ? 1 : 2)
    if (!changed) expect(JSON.stringify(f.requests[1])).toContain("CONFIGURED_INPUT_CHECKED")
  },
  60_000
)

processTest(
  "persists an avatar through the compiled media worker and Host restart without reapplying an old save",
  async () => {
    const f = await fixture(() => ({ content: "Unused" }))
    const first = f.launch()
    const client = await f.connect(first)
    const { bot } = await client.call("create", { nonce: "picture-bot", name: "Owner" })
    const input = {
      botId: bot.id,
      revision: 1,
      nonce: "picture-save",
      pngBase64: await avatarImage()
    }
    const saved = await client.call("changeAvatar", input)
    const address = { botId: bot.id, hash: saved.hash! }
    const png = await client.call("avatar", address)
    expect(png).toBeTruthy()
    await f.stop(first, "SIGKILL")
    const second = f.launch()
    const next = await f.connect(second)
    expect(await next.call("avatar", address)).toBe(png)
    const cleared = await next.call("changeAvatar", {
      ...input,
      nonce: "clear-picture",
      revision: 2,
      pngBase64: null
    })
    expect(cleared).toMatchObject({ revision: 3, hash: null })
    expect(await next.call("changeAvatar", input)).toEqual(saved)
    expect((await next.call("snapshot")).bots[0]).toMatchObject({ revision: 3, avatarHash: null })
    expect(await next.call("avatar", address)).toBeNull()
    expect(f.requests).toHaveLength(0)
  },
  30_000
)

processTest(
  "accepts loopback webhooks without a UI and preserves its port, key and original run after restart",
  async () => {
    const f = await fixture(() => ({ content: "Webhook evidence checked" }))
    const first = f.launch()
    const client = await f.connect(first)
    const { bot, conversationId } = await client.call("create", {
      nonce: "webhook-bot",
      name: "Events"
    })
    const routine = await client.call("saveRoutine", {
      botId: bot.id,
      name: "Incoming build",
      prompt: "Check the incoming build evidence",
      timezone: "UTC",
      enabled: true,
      schedule: { kind: "event", topic: "build.finished" }
    })
    const address = { botId: bot.id, routineId: routine.id }
    const { key } = await client.call("changeWebhook", {
      ...address,
      nonce: "key",
      revision: 0,
      operation: "rotate"
    })
    const view = await client.call("webhook", address)
    expect(view.url).toMatch(/^http:\/\/127\.0\.0\.1:/)
    client.close()
    const send = (event: string) =>
      fetch(view.url!, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Idempotency-Key": event,
          "Content-Type": "application/json"
        },
        body: '{"build":42,"evidence":"local webhook fixture"}'
      })
    const response = await send("event-42")
    expect(response.status).toBe(200)
    const receipt = await response.json()
    await until(async () => f.requests.length > 0)
    const reconnected = await f.connect(first)
    await until(
      async () =>
        (await reconnected.call("runHistory", { conversationId, runId: receipt.runIds[0] })).run
          .status === "succeeded"
    )
    expect(JSON.stringify(f.requests)).toContain("local webhook fixture")
    expect(JSON.stringify(f.requests)).not.toContain(key)
    expect(
      (await reconnected.call("messages", { conversationId })).filter(
        (message) => message.sender === "bot"
      )
    ).toHaveLength(1)
    await f.stop(first, "SIGKILL")
    const second = f.launch()
    const next = await f.connect(second)
    expect((await next.call("webhook", address)).url).toBe(view.url)
    expect(await (await send("event-42")).json()).toEqual(receipt)
    expect(
      (await next.call("runHistory", { conversationId, runId: receipt.runIds[0] })).run.status
    ).toBe("succeeded")
    expect(f.requests).toHaveLength(1)
    const another = await (await send("event-43")).json()
    await until(
      async () =>
        (await next.call("runHistory", { conversationId, runId: another.runIds[0] })).run.status ===
        "succeeded"
    )
    expect(f.requests).toHaveLength(2)
    expect([...f.logs.values()].join("\n")).not.toContain(key)
  },
  60_000
)

processTest(
  "synchronizes installed skills in the compiled Host and rechecks revocation after SIGKILL",
  async () => {
    let skillId = ""
    const f = await fixture((_body, index) =>
      index === 1
        ? {
            content: null,
            tool_calls: [
              {
                id: "compiled-resource",
                type: "function",
                function: {
                  name: "read_skill_file",
                  arguments: JSON.stringify({ id: skillId, path: "evidence.md" })
                }
              }
            ]
          }
        : { content: "Reviewed installed workflow" }
    )
    const source = {
      builtinSkillsDir: join(f.directory, "builtin"),
      customSkillsDir: join(f.directory, "custom"),
      pluginsStorePath: join(f.directory, "plugins.json"),
      disabledSkillsPath: join(f.directory, "disabled.json"),
      disabledSkillsRevision: 0,
      globalRevision: 0
    }
    await mkdir(source.builtinSkillsDir)
    await mkdir(join(source.customSkillsDir, "review"), { recursive: true })
    await writeFile(
      join(source.customSkillsDir, "review", "SKILL.md"),
      "---\nname: review\n---\nCOMPILED_INSTALLED_WORKFLOW"
    )
    await writeFile(source.pluginsStorePath, "[]")
    await writeFile(
      join(source.customSkillsDir, "review", "evidence.md"),
      "COMPILED_SKILL_RESOURCE_EVIDENCE"
    )
    await writeFile(source.disabledSkillsPath, "[]")
    const modelFile = join(f.directory, "models.private")
    await writeBotModelSnapshot(modelFile, {
      ...(await readBotModelSnapshot(modelFile)),
      skillSources: source
    })
    const child = f.launch(),
      client = await f.connect(child)
    const { bot, conversationId } = await client.call("create", { nonce: "bot", name: "Review" })
    const catalog = await client.call("installedSkills", bot.id)
    expect(catalog.ready).toBe(true)
    expect(catalog.skills).toHaveLength(1)
    expect(catalog.skills[0]).not.toHaveProperty("instructions")
    const skill = catalog.skills[0],
      selection = { botId: bot.id, id: skill.id, version: skill.version }
    skillId = skill.id
    await expect(
      client.call("inspectInstalledSkill", { ...selection, path: "/private/file" } as never)
    ).rejects.toThrow()
    const sent = await client.call("send", {
      nonce: "run",
      conversationId,
      text: "Follow this workflow",
      skills: [selection]
    })
    await until(async () =>
      ["succeeded", "failed", "needs_review"].includes(
        (await client.call("runHistory", { conversationId, runId: sent.runIds[0] })).run.status
      )
    ).catch(async (error) => {
      throw new Error(
        `${error}\n${JSON.stringify(await client.call("snapshot"))}\n${f.logs.get(child)}`
      )
    })
    const completed = (await client.call("runHistory", { conversationId, runId: sent.runIds[0] }))
      .run
    expect(completed.status, f.logs.get(child)).toBe("succeeded")
    expect(JSON.stringify(f.requests)).toContain("COMPILED_INSTALLED_WORKFLOW")
    expect(JSON.stringify(f.requests)).toContain("COMPILED_SKILL_RESOURCE_EVIDENCE")
    await f.stop(child, "SIGKILL")
    client.close()
    await writeFile(source.disabledSkillsPath, '["review"]')
    const restarted = f.launch(),
      next = await f.connect(restarted)
    expect((await next.call("installedSkills", bot.id)).skills).toEqual([])
    await expect(
      next.call("send", { nonce: "stale", conversationId, text: "Use old", skills: [selection] })
    ).rejects.toThrow("停用")
    expect((await next.call("messages", { conversationId }))[0].skillReferences).toEqual([
      { ...selection, name: "review" }
    ])
  },
  30_000
)

async function backupProcess(directory: string, input: BotBackupRequest): Promise<BotBackupResult> {
  const child = spawn(
    process.env.CMB_BOT_NODE ?? process.execPath,
    [resolve("out/main/bot-backup.js"), "--data-dir", directory],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "pipe", "pipe"]
    }
  )
  const chunks: Buffer[] = []
  child.stdout.on("data", (value) => chunks.push(value))
  child.stderr.resume()
  const exited = once(child, "close")
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000)
  child.stdin.end(JSON.stringify(input))
  try {
    const [code] = await exited
    const value = JSON.parse(Buffer.concat(chunks).toString()) as {
      ok: boolean
      result: BotBackupResult
      error?: string
    }
    if (code !== 0 || !value.ok) throw new Error(value.error || "Backup process failed")
    return value.result
  } finally {
    clearTimeout(timer)
  }
}

processTest(
  "backs up and restores through the compiled maintenance process and starts a fenced Host with the original files",
  async () => {
    const f = await fixture(() => {
      throw new Error("Backup must not request a model")
    })
    let child = f.launch(),
      client = await f.connect(child)
    const original = await client.call("create", { nonce: "original", name: "Original" })
    const skill = await client.call("saveSkill", {
      botId: original.bot.id,
      name: "Shared workflow",
      instructions: "Inspect backup evidence",
      enabled: true
    })
    const publication = {
      nonce: "publish-original",
      botId: original.bot.id,
      skillId: skill.id,
      version: skill.version,
      libraryRevision: 0
    }
    const sharedSkill = await client.call("publishSkill", publication)
    const memoryAddress = {
      botId: original.bot.id,
      botRevision: original.bot.revision,
      scope: "user" as const
    }
    await client.call("saveSharedMemory", {
      ...memoryAddress,
      nonce: "shared-original",
      text: "Shared memory survives restore"
    })
    const removedMemory = await client.call("saveMemory", {
      botId: original.bot.id,
      text: "Deleted after snapshot"
    })
    const removedBot = await client.call("create", {
      nonce: "deleted-bot",
      name: "Must stay deleted"
    })
    const file = await client.call("upload", {
      nonce: "file",
      conversationId: original.conversationId,
      name: "report.txt",
      mime: "text/plain",
      base64: Buffer.from("backup evidence").toString("base64")
    })
    await expect(
      backupProcess(f.directory, { action: "create", nonce: randomUUID() })
    ).rejects.toThrow("仍在运行")
    expect((await client.restartIfIdle((await client.call("status")).hostId)).accepted).toBe(true)
    client.close()
    await until(async () => child.exitCode !== null)
    const backup = (await backupProcess(f.directory, { action: "create", nonce: randomUUID() }))
      .backup!
    child = f.launch()
    client = await f.connect(child)
    await client.call("create", { nonce: "later", name: "Later" })
    await client.call("deleteMemory", {
      botId: original.bot.id,
      id: removedMemory.id,
      revision: removedMemory.revision
    })
    await client.call("delete", { id: removedBot.bot.id, revision: removedBot.bot.revision })
    await f.stop(child)
    client.close()
    const nonce = randomUUID(),
      request = {
        action: "restore" as const,
        nonce,
        backup: { id: backup.id, sha256: backup.sha256 }
      }
    const result = await backupProcess(f.directory, request)
    expect(result.safetyBackup).toBeDefined()
    expect(await backupProcess(f.directory, request)).toEqual(result)
    child = f.launch()
    client = await f.connect(child)
    expect((await client.call("snapshot")).bots.map((bot) => bot.name)).toEqual(["Original"])
    expect((await client.call("snapshot")).dataEpoch).toBe(nonce)
    expect(await client.call("skillLibrary")).toEqual([sharedSkill])
    expect(await client.call("publishSkill", publication)).toEqual(sharedSkill)
    expect((await client.call("sharedMemories", memoryAddress))[0].text).toBe(
      "Shared memory survives restore"
    )
    expect(Buffer.from((await client.call("download", file.id)).base64, "base64").toString()).toBe(
      "backup evidence"
    )
    expect(await client.call("memories", original.bot.id)).toEqual([])
    expect(f.requests).toEqual([])
  },
  40_000
)

processTest(
  "completes a SIGKILL-interrupted restore before the compiled Host dispatches any saved work",
  async () => {
    const f = await fixture(() => {
      throw new Error("Restored work must not run")
    })
    let child = f.launch(),
      client = await f.connect(child)
    const original = await client.call("create", { nonce: "original", name: "Original" })
    const forgotten = await client.call("saveMemory", {
      botId: original.bot.id,
      text: "Stay forgotten after crash"
    })
    const artifact = await client.call("upload", {
      nonce: "restore-file",
      conversationId: original.conversationId,
      name: "evidence.txt",
      mime: "text/plain",
      base64: Buffer.from("durable evidence").toString("base64")
    })
    await f.stop(child)
    client.close()
    const { BotStore } = await import("./store")
    let store = new BotStore(join(f.directory, "bots.sqlite"))
    const queued = store.send({
      nonce: "before-backup",
      conversationId: original.conversationId,
      text: "Must not automatically replay"
    }).runIds[0]
    store.close()
    const backup = (await backupProcess(f.directory, { action: "create", nonce: randomUUID() }))
      .backup!
    store = new BotStore(join(f.directory, "bots.sqlite"))
    store.createBot({ nonce: "later", name: "Later" })
    store.deleteMemory(original.bot.id, forgotten.id, forgotten.revision)
    store.close()
    const request = {
      action: "restore" as const,
      nonce: randomUUID(),
      backup: { id: backup.id, sha256: backup.sha256 }
    }
    const helper = join(f.directory, "kill-restore.cjs")
    await build({
      stdin: {
        contents: `import {executeBotBackup} from ${JSON.stringify(resolve("src/main/bots/backups.ts"))};
    void executeBotBackup(process.argv[2], JSON.parse(process.argv[3]), name => {if(name==='next:objects') process.kill(process.pid,'SIGKILL')}).catch(error => {console.error(error);process.exitCode=1});`,
        resolveDir: process.cwd(),
        loader: "ts"
      },
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: helper,
      logLevel: "silent"
    })
    const killed = spawn(
      process.env.CMB_BOT_NODE ?? process.execPath,
      [helper, f.directory, JSON.stringify(request)],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "ignore", "pipe"] }
    )
    let errors = ""
    killed.stderr.on("data", (data) => {
      errors += data
    })
    const timer = setTimeout(() => killed.kill("SIGKILL"), 15_000)
    try {
      expect(await once(killed, "close"), errors).toEqual([null, "SIGKILL"])
    } finally {
      clearTimeout(timer)
    }
    expect(JSON.parse(await readFile(join(f.directory, "restore.json"), "utf8")).nonce).toBe(
      request.nonce
    )
    child = f.launch()
    client = await f.connect(child)
    expect((await client.call("snapshot")).bots.map((bot) => bot.name)).toEqual(["Original"])
    expect((await client.call("snapshot")).dataEpoch).toBe(request.nonce)
    expect(
      (await client.call("runHistory", { conversationId: original.conversationId, runId: queued }))
        .run.status
    ).toBe("cancelled")
    expect(
      Buffer.from((await client.call("download", artifact.id)).base64, "base64").toString()
    ).toBe("durable evidence")
    expect(await client.call("memories", original.bot.id)).toEqual([])
    expect(f.requests).toEqual([])
  },
  40_000
)
processTest.each(["old", "next"])(
  "finishes browser replacement interrupted by SIGKILL at %s before the compiled Host opens",
  async (step) => {
    const f = await fixture(() => ({ content: "unused" }))
    const first = f.launch(),
      client = await f.connect(first)
    const created = await client.call("create", { nonce: "browser-owner", name: "Browser owner" })
    await f.stop(first)
    client.close()
    const path = join(f.directory, "browser-profile/Default/Preferences")
    await mkdir(join(f.directory, "browser-profile/Default"), { recursive: true })
    await writeFile(path, "checkpoint-state")
    const saved = (
      await executeBotBrowserMaintenance(f.directory, { action: "create", nonce: randomUUID() })
    ).checkpoint!
    await writeFile(path, "later-state")
    const request = {
      action: "restore",
      nonce: randomUUID(),
      checkpoint: { id: saved.id, sha256: saved.sha256 }
    }
    const helper = join(f.directory, "kill-browser-maintenance.cjs")
    await build({
      stdin: {
        contents: `import {executeBotBrowserMaintenance} from ${JSON.stringify(resolve("src/main/bots/browser-maintenance.ts"))};
        void executeBotBrowserMaintenance(process.argv[2],JSON.parse(process.argv[3]),step=>{if(step===process.argv[4])process.kill(process.pid,'SIGKILL')}).catch(error=>{console.error(error);process.exitCode=1});`,
        loader: "ts",
        resolveDir: process.cwd()
      },
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: helper,
      logLevel: "silent"
    })
    const killed = spawn(
      process.env.CMB_BOT_NODE ?? process.execPath,
      [helper, f.directory, JSON.stringify(request), step],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "ignore", "pipe"]
      }
    )
    let diagnostics = ""
    killed.stderr.on("data", (bytes) => {
      diagnostics += String(bytes)
    })
    const deadline = setTimeout(() => killed.kill("SIGKILL"), 15_000)
    try {
      expect(await once(killed, "close"), diagnostics).toEqual([null, "SIGKILL"])
    } finally {
      clearTimeout(deadline)
    }
    const next = await f.connect(f.launch())
    expect((await next.call("snapshot")).bots.map((bot) => bot.id)).toEqual([created.bot.id])
    expect(await readFile(path, "utf8")).toBe("checkpoint-state")
    expect(
      (await listBotBrowserCheckpoints(f.directory)).map((item) => item.reason).sort()
    ).toEqual(["before-restore", "manual"])
    await expect(
      readFile(join(f.directory, "browser-maintenance/pending.json"))
    ).rejects.toMatchObject({ code: "ENOENT" })
    expect(f.requests).toEqual([])
  },
  40_000
)

/** Drive only exact local admission for this temporary root and verified direct children.
 * Original action approvals are intentionally left pending for the test body. */
async function createRecoveryProjectSnapshot(input: {
  workspace: string
  conversationId: string
  runId: string
  commands?: readonly string[]
  children?: {
    limit: number
    access(run: BotRun): { commands?: readonly string[]; writePaths?: readonly string[] }
  }
}) {
  const parent = await createTestLocalProjectAccess({
    workspace: input.workspace,
    runId: input.runId,
    readProject: true,
    commands: input.commands
  })
  const children = new Map<string, Awaited<ReturnType<typeof createTestLocalProjectAccess>>>()
  let rootIdentity: BotRun | undefined
  return async (connection: BotTransportClient) => {
    const port = {
      snapshot: () => connection.call("snapshot"),
      resolve: (answer: BotLocalToolAnswer) => connection.call("resolveLocalToolPermission", answer)
    }
    let snapshot = await port.snapshot()
    // Terminal runs leave the workspace snapshot. Reuse only a root identity
    // already checked while live, after verifying its scoped durable history.
    const current = snapshot.runs.find((run) => run.id === input.runId)
    if (current) rootIdentity = current
    else {
      const history = await connection.call("runHistory", {
        conversationId: input.conversationId,
        runId: input.runId
      })
      if (
        !rootIdentity ||
        history.run.id !== rootIdentity.id ||
        history.run.botId !== rootIdentity.botId ||
        !["succeeded", "failed", "cancelled"].includes(history.run.status)
      )
        throw new Error(`Recovery root identity is unavailable: ${JSON.stringify(history.run)}`)
    }
    const root = rootIdentity!
    expect(root.conversationId).toBe(input.conversationId)
    expect(root.parentRunId).toBeNull()
    expect(root.rootRunId).toBe(input.runId)
    snapshot = await parent.snapshot(port)
    if (input.children) {
      const owned = snapshot.runs.filter((run) => run.parentRunId === input.runId)
      expect(owned.length).toBeLessThanOrEqual(input.children.limit)
      for (const run of owned) {
        expect(run.conversationId).toBe(input.conversationId)
        expect(run.botId).toBe(root.botId)
        expect(run.rootRunId).toBe(root.rootRunId)
        let access = children.get(run.id)
        if (!access) {
          access = await createTestLocalProjectAccess({
            workspace: input.workspace,
            runId: run.id,
            readProject: true,
            ...input.children.access(run)
          })
          children.set(run.id, access)
        }
        snapshot = await access.snapshot(port)
      }
    }
    return snapshot
  }
}

async function until(check: () => Promise<boolean>, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Host process did not reach the expected state")
    await delay(200)
  }
}
async function fixture(
  respond: (body: TestModelRequest, index: number) => Record<string, unknown> | null,
  nestedHostDirectory = false,
  options: { trustedMacOwnedShell?: true } = {}
) {
  let trustedFaultHost: TrustedMacFaultHostEntry | undefined
  const root = await mkdtemp(join(tmpdir(), "cmb-bot-process-"))
  const directory = nestedHostDirectory ? join(root, "bot-host") : root
  if (nestedHostDirectory) await mkdir(directory)
  const requests: TestModelRequest[] = []
  const children: ChildProcess[] = []
  const clients: BotTransportClient[] = []
  const logs = new Map<ChildProcess, string>()
  const shouldPreserveScene = async () => {
    if (process.env.CMB_BOT_PROCESS_TEST_PRESERVE_SCENE === "1") return true
    if (!trustedFaultHost) return false
    try {
      return (await inspectOwnedShellReceipts(join(directory, "shell-resources"))).some(
        (receipt) => !hasOwnedShellPhysicalClosure(receipt)
      )
    } catch {
      // Failed inspection cannot grant deletion of the actual weak scene.
      return true
    }
  }
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    const body = testModelRequest.parse(JSON.parse(Buffer.concat(chunks).toString()))
    requests.push(body)
    const result = respond(body, requests.length)
    // A held response provides a reproducible process-kill point after committed tools.
    if (result === null) return
    if (typeof result.fixtureHttpStatus === "number") {
      response.writeHead(result.fixtureHttpStatus, { "Content-Type": "application/json" })
      response.end(
        JSON.stringify({
          error: { message: "COMPILED_MODEL_REJECTED", type: "authentication_error" }
        })
      )
      return
    }
    await delay(300)
    const message = { role: "assistant", ...result }
    const calls = (result.tool_calls as Record<string, unknown>[] | undefined)?.map(
      (call, index) => ({ index, ...call })
    )
    if (body.stream) {
      response.setHeader("Content-Type", "text/event-stream")
      response.end(
        `data: ${JSON.stringify({ id: `chatcmpl-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta: { ...message, ...(calls ? { tool_calls: calls } : {}) }, finish_reason: calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`
      )
    } else {
      response.setHeader("Content-Type", "application/json")
      response.end(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: 1,
          model: "gpt-test",
          choices: [{ index: 0, message, finish_reason: calls ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 }
        })
      )
    }
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const stop = async (child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, "exit")
    const deadline = setTimeout(() => child.kill("SIGKILL"), 7000)
    child.kill(signal)
    try {
      await exited
    } finally {
      clearTimeout(deadline)
    }
  }
  cleanup.push(async () => {
    clients.forEach((client) => client.close())
    await Promise.all(children.map((child) => stop(child)))
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    if (await shouldPreserveScene()) {
      // Keep receipts, database and trusted compiled code together. A stopped
      // fixture ticker does not prove every possible descendant closed.
      console.info("[BotTest] Preserved Host process fixture", root, {
        trustedFaultHost: trustedFaultHost?.directory,
        manifest: trustedFaultHost?.manifest
      })
      return
    }
    await trustedFaultHost?.close()
    await rm(root, { recursive: true, force: true })
    await rm(`${directory}-workspaces`, { recursive: true, force: true })
    await rm(`${directory}.workspace`, { recursive: true, force: true })
  })
  if (options.trustedMacOwnedShell) {
    trustedFaultHost = await createCompiledTrustedMacOwnedHostFixture()
    console.info("[BotTest] Explicit trusted Mac fault Host", {
      entry: trustedFaultHost.entry,
      manifest: trustedFaultHost.manifest
    })
  }
  const compiledHostEntry =
    trustedFaultHost?.entry ??
    resolve(process.env.CMB_BOT_COMPILED_HOST_ENTRY ?? "out/main/bot-host.js")
  const port = (server.address() as { port: number }).port
  await writeBotModelSnapshot(join(directory, "models.private"), {
    version: 1,
    defaultRef: "mock",
    models: [
      {
        id: "mock",
        ref: "mock",
        name: "Mock",
        model: "gpt-test",
        apiKey: "test-only",
        baseUrl: `http://127.0.0.1:${port}/v1`
      }
    ]
  })
  const launch = (ignoreStdio = false, environment: NodeJS.ProcessEnv = {}) => {
    trustedFaultHost?.assertCurrent()
    const child = spawn(
      process.env.CMB_BOT_NODE ?? process.execPath,
      [compiledHostEntry, "--data-dir", directory],
      {
        env: {
          ...process.env,
          ...environment,
          ELECTRON_RUN_AS_NODE: "1",
          CMB_COWORK_AGENT_HOME: join(directory, "fixture-settings")
        },
        stdio: ignoreStdio ? "ignore" : ["ignore", "pipe", "pipe"]
      }
    )
    children.push(child)
    const capture = (chunk: Buffer) =>
      logs.set(child, ((logs.get(child) ?? "") + chunk).slice(-20_000))
    child.stdout?.on("data", capture)
    child.stderr?.on("data", capture)
    return child
  }
  const connect = async (child: ChildProcess) => {
    let client: BotTransportClient | undefined
    await until(async () => {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Host exited: ${logs.get(child)}`)
      try {
        const descriptor = JSON.parse(
          await readFile(join(directory, "host.json"), "utf8")
        ) as BotHostDescriptor
        if (descriptor.hostId === "starting" || descriptor.pid !== child.pid) return false
        const candidate = new BotTransportClient(descriptor)
        clients.push(candidate)
        try {
          await candidate.call("status")
          client = candidate
          return true
        } catch {
          candidate.close()
        }
      } catch {
        /* The descriptor can be absent during atomic publication. */
      }
      return false
    })
    return client!
  }
  return { directory, requests, launch, connect, stop, logs, shouldPreserveScene }
}

it.skipIf(process.env.CMB_BOT_PROCESS_TEST !== "1" || process.platform === "win32")(
  "hands off a pending approval across graceful Host shutdown and resumes the exact graph after fresh approval",
  async () => {
    const f = await fixture((_body, index) => {
      if (index === 1)
        return {
          content: null,
          tool_calls: [
            {
              id: "graceful-remember",
              type: "function",
              function: {
                name: "remember",
                arguments: JSON.stringify({ text: "Graceful handoff retains the committed fact" })
              }
            }
          ]
        }
      if (index === 2 || index >= 5)
        return {
          content: null,
          tool_calls: [
            {
              id: index === 2 ? "graceful-create" : "explicit-cancel-create",
              type: "function",
              function: {
                name: "create_bot",
                arguments: JSON.stringify({
                  name: index === 2 ? "Gracefully created helper" : "Must never be created",
                  description: "Controlled lifecycle fixture"
                })
              }
            }
          ]
        }
      return { content: index === 3 ? "GRACEFUL_RESUMED" : "QUEUED_AFTER_HANDOFF" }
    })
    const child = f.launch(),
      first = await f.connect(child),
      { bot, conversationId } = await first.call("create", { nonce: "owner", name: "Owner" }),
      sent = await first.call("send", {
        nonce: "waiting",
        conversationId,
        text: "Remember then create"
      }),
      runId = sent.runIds[0]
    await until(async () =>
      (await first.call("snapshot")).interactions.some((item) => item.runId === runId)
    )
    const before = await first.call("snapshot"),
      waiting = before.runs.find((run) => run.id === runId)!,
      approval = before.interactions.find((item) => item.runId === runId)!,
      checkpointHash = (checkpoint: string | null) =>
        createHash("sha256")
          .update(checkpoint ?? "")
          .digest("hex")
    expect(waiting.status).toBe("waiting_input")
    expect(waiting.checkpoint).not.toBeNull()
    expect(JSON.parse(approval.prompt).botProfile.operation).toBe("create")
    expect(await first.call("memories", bot.id)).toHaveLength(1)
    const queued = await first.call("send", { nonce: "queued", conversationId, text: "Next work" })
    expect(
      (await first.call("snapshot")).runs.find((run) => run.id === queued.runIds[0])?.status
    ).toBe("queued")
    await f.stop(child, "SIGTERM")
    expect(child.exitCode).toBe(0)
    expect(child.signalCode).toBeNull()
    await first.closeAndWait()
    // Observe the stopped compiled Host's real SQLite state before startup
    // recovery can alter it. No test mutation or seeded checkpoint stands in.
    const db = new DatabaseSync(join(f.directory, "bots.sqlite"), { readOnly: true })
    try {
      const durable = db
        .prepare("SELECT status,fence,lease_owner,lease_until,checkpoint FROM bot_runs WHERE id=?")
        .get(runId)!
      expect(durable.status).toBe("needs_review")
      expect(durable.fence).toBe(waiting.fence + 1)
      expect(durable.lease_owner).toBeNull()
      expect(durable.lease_until).toBeNull()
      expect(checkpointHash(durable.checkpoint as string)).toBe(checkpointHash(waiting.checkpoint))
      expect(
        db.prepare("SELECT status FROM bot_interactions WHERE id=?").get(approval.id)?.status
      ).toBe("expired")
      expect(
        db.prepare("SELECT status FROM bot_runs WHERE id=?").get(queued.runIds[0])?.status
      ).toBe("queued")
      expect(
        db
          .prepare(
            "SELECT count(*) AS total FROM bot_events WHERE entity_id=? AND kind='run.cancel_requested'"
          )
          .get(runId)?.total
      ).toBe(0)
    } finally {
      db.close()
    }
    const restarted = f.launch(),
      next = await f.connect(restarted),
      recovered = (await next.call("snapshot")).runs.find((run) => run.id === runId)!
    expect(recovered.status).toBe("needs_review")
    expect(checkpointHash(recovered.checkpoint)).toBe(checkpointHash(waiting.checkpoint))
    expect(recovered.messageId).toBe(sent.messageId)
    expect(await next.call("effects", runId)).toEqual([])
    await expect(
      next.call("answer", { id: approval.id, revision: approval.revision, answer: "approve" })
    ).rejects.toMatchObject({ code: "stale_interaction" })
    await next.call("recover", {
      id: runId,
      revision: recovered.revision,
      decision: "resume",
      note: "No external effect was dispatched; issue a fresh approval",
      effects: []
    })
    await until(async () =>
      (await next.call("snapshot")).interactions.some((item) => item.runId === runId)
    )
    const fresh = (await next.call("snapshot")).interactions.find((item) => item.runId === runId)!
    expect(fresh.id).not.toBe(approval.id)
    expect(fresh.prompt).toBe(approval.prompt)
    expect(f.requests).toHaveLength(2)
    await next.call("answer", { id: fresh.id, revision: fresh.revision, answer: "approve" })
    await until(
      async () =>
        (await next.call("runHistory", { conversationId, runId: queued.runIds[0] })).run.status ===
        "succeeded"
    )
    expect((await next.call("runHistory", { conversationId, runId })).run.status).toBe("succeeded")
    expect(
      (await next.call("messages", { conversationId })).filter((item) => item.sender === "bot")
    ).toEqual([
      expect.objectContaining({ runId, text: "GRACEFUL_RESUMED" }),
      expect.objectContaining({ runId: queued.runIds[0], text: "QUEUED_AFTER_HANDOFF" })
    ])
    expect(await next.call("memories", bot.id)).toHaveLength(1)
    expect(
      (await next.call("snapshot")).bots.filter((item) => item.name === "Gracefully created helper")
    ).toHaveLength(1)
    expect((await next.call("effects", runId)).map((effect) => effect.status)).toEqual([
      "succeeded"
    ])
    expect(f.requests).toHaveLength(4)
    // The user's explicit Stop keeps the ordinary cancellation semantics.
    const cancelled = await next.call("send", {
      nonce: "cancel",
      conversationId,
      text: "Cancel this creation"
    })
    await until(async () =>
      (await next.call("snapshot")).interactions.some((item) => item.runId === cancelled.runIds[0])
    )
    await next.call("cancel", cancelled.runIds[0])
    await until(
      async () =>
        (await next.call("runHistory", { conversationId, runId: cancelled.runIds[0] })).run
          .status === "cancelled"
    )
    expect(
      (await next.call("snapshot")).bots.some((item) => item.name === "Must never be created")
    ).toBe(false)
    await f.stop(restarted, "SIGTERM")
    expect(restarted.exitCode).toBe(0)
    await next.closeAndWait()
    const last = await f.connect(f.launch())
    expect(
      (await last.call("runHistory", { conversationId, runId: cancelled.runIds[0] })).run.status
    ).toBe("cancelled")
  },
  90_000
)

processTest(
  "recovers an approved Bot creation after SIGKILL without duplicating it and preserves pinned order",
  async () => {
    const f = await fixture((_body, index) =>
      index === 1
        ? {
            content: null,
            tool_calls: [
              {
                id: "create-before-crash",
                type: "function",
                function: {
                  name: "create_bot",
                  arguments: JSON.stringify({ name: "持久协作助手", description: "协助代码审查" })
                }
              }
            ]
          }
        : index === 2
          ? null
          : { content: "创建结果已恢复" }
    )
    const child = f.launch(),
      first = await f.connect(child)
    const { bot, conversationId } = await first.call("create", { nonce: "owner", name: "负责人" })
    const sent = await first.call("send", {
      nonce: "work",
      conversationId,
      text: "创建一个代码审查助手"
    })
    await until(async () => (await first.call("snapshot")).interactions.length === 1)
    const approval = (await first.call("snapshot")).interactions[0]
    expect(JSON.parse(approval.prompt).botProfile.operation).toBe("create")
    await first.call("answer", { id: approval.id, revision: approval.revision, answer: "approve" })
    await until(
      async () => f.requests.length === 2 && (await first.call("snapshot")).bots.length === 2
    )
    const created = (await first.call("snapshot")).bots.find((item) => item.id !== bot.id)!
    await first.call("update", { id: bot.id, revision: bot.revision, pinned: true })
    await first.call("update", { id: created.id, revision: created.revision, pinned: true })
    const order = (await first.call("snapshot")).pinnedOrder!
    const movement = {
      nonce: "order",
      revision: order.revision,
      movedId: created.id,
      targetId: bot.id,
      position: "before" as const
    }
    const sorted = await first.call("reorderPinned", movement)
    const effects = await first.call("effects", sent.runIds[0])
    expect(effects).toEqual([expect.objectContaining({ status: "succeeded" })])
    const detailRequest = { runId: sent.runIds[0], conversationId, effectId: effects[0].id }
    const detail = await first.call("effectDetail", detailRequest)
    expect(detail.approval?.id).toBe(approval.id)
    expect(detail.approval?.prompt).toBe(approval.prompt)
    await f.stop(child, "SIGKILL")
    first.close()
    const next = await f.connect(f.launch())
    await until(
      async () =>
        (await next.call("snapshot")).runs.some(
          (run) => run.id === sent.runIds[0] && run.status === "needs_review"
        ),
      40_000
    )
    const snapshot = await next.call("snapshot")
    expect(snapshot.bots).toHaveLength(2)
    expect(snapshot.pinnedOrder).toEqual(sorted)
    expect(await next.call("reorderPinned", movement)).toEqual(sorted)
    expect(await next.call("effects", sent.runIds[0])).toEqual(effects)
    expect(await next.call("effectDetail", detailRequest)).toEqual(detail)
    const timeline = await next.call("runHistory", { runId: sent.runIds[0], conversationId })
    expect(timeline.items.some((item) => item.label === "执行中断，等待人工核对")).toBe(true)
    const interrupted = snapshot.runs.find((run) => run.id === sent.runIds[0])!
    await next.call("recover", {
      id: interrupted.id,
      revision: interrupted.revision,
      decision: "resume",
      note: "已核对创建结果",
      effects: []
    })
    await until(
      async () =>
        (await next.call("messages", { conversationId })).at(-1)?.text === "创建结果已恢复"
    )
    expect((await next.call("snapshot")).bots).toHaveLength(2)
    expect(await next.call("effects", sent.runIds[0])).toEqual(effects)
    expect(f.requests).toHaveLength(3)
  },
  65_000
)

it.skipIf(process.env.CMB_BOT_PROCESS_TEST !== "1" || process.env.CMB_BOT_BROWSER_TEST !== "1")(
  "keeps manual browser control suspended across compiled Host restart and requires explicit reclaim",
  async () => {
    const f = await fixture(() => ({ content: "unused" }))
    const child = f.launch(),
      client = await f.connect(child)
    expect((await client.call("status")).computer?.state).toBe("stopped")
    const { bot } = await client.call("create", { nonce: "computer-owner", name: "Computer owner" })
    const first = await client.call("computerFrame", bot.id)
    const computerStatus = (await client.call("status")).computer
    expect(computerStatus).toMatchObject({
      state: "ready",
      browser: process.platform === "win32" ? "msedge" : "chrome"
    })
    expect(computerStatus?.version).toMatch(/^\d+\.\d+/)
    await client.call("computerTake", first)
    expect((await client.call("computerOpen", bot.id)).controlOwner).toBe("self")
    await f.stop(child)
    const next = await f.connect(f.launch())
    const restored = await next.call("computerFrame", bot.id)
    expect((await next.call("status")).computer?.attemptId).not.toBe(computerStatus?.attemptId)
    expect(restored).toMatchObject({
      control: "human",
      controlOwner: "other",
      controlOwnerConnected: false
    })
    expect(restored.generation).not.toBe(first.generation)
    await expect(next.call("computerRelease", restored)).rejects.toThrow("另一客户端")
    await next.call("computerTake", { ...restored, replaceHuman: true })
    await next.call("computerRelease", await next.call("computerFrame", bot.id))
    expect((await next.call("computerOpen", bot.id)).control).toBe("bot")
  },
  30_000
)

processTest(
  "persists branch execution, read position and idempotent sends across independent Host restart",
  async () => {
    const f = await fixture((body) => ({
      content: JSON.stringify(body.messages).includes("BRANCH_PROCESS_REQUEST")
        ? "BRANCH_PROCESS_RESULT"
        : "MAIN_PROCESS_RESULT"
    }))
    const child = f.launch(),
      client = await f.connect(child)
    expect((await client.call("status")).capabilities).toContain("message-threads")
    const { conversationId } = await client.call("create", {
      nonce: "branch-bot",
      name: "Branch test"
    })
    const root = await client.call("send", { nonce: "root", conversationId, text: "MAIN_ROOT" })
    await until(
      async () => !(await client.call("snapshot")).runs.some((run) => run.id === root.runIds[0])
    )
    const input = {
      nonce: "branch",
      conversationId,
      threadRootId: root.messageId,
      text: "BRANCH_PROCESS_REQUEST"
    }
    const sent = await client.call("send", input)
    await until(
      async () => !(await client.call("snapshot")).runs.some((run) => run.id === sent.runIds[0])
    )
    const branch = await client.call("thread", { conversationId, rootId: root.messageId })
    expect(branch.count).toBe(2)
    expect(branch.readState.unreadCount).toBe(1)
    expect(
      (await client.call("messages", { conversationId })).map((message) => message.text)
    ).not.toContain("BRANCH_PROCESS_RESULT")
    const read = await client.call("setReadState", {
      conversationId,
      threadRootId: root.messageId,
      revision: branch.readState.revision,
      throughSequence: branch.readState.latestSequence,
      unread: false
    })
    await f.stop(child)
    const next = await f.connect(f.launch())
    expect(await next.call("send", input)).toEqual(sent)
    expect(
      (await next.call("thread", { conversationId, rootId: root.messageId })).readState
    ).toEqual(read)
    const page = await next.call("messages", { conversationId, threadRootId: root.messageId })
    expect(page.map((message) => message.text)).toEqual([
      "BRANCH_PROCESS_REQUEST",
      "BRANCH_PROCESS_RESULT"
    ])
    expect((await next.call("message", { conversationId, id: page[1].id })).threadRootId).toBe(
      root.messageId
    )
  },
  30_000
)

it.skipIf(
  process.env.CMB_BOT_PROCESS_TEST !== "1" ||
    (process.platform === "darwin" && process.env.CMB_BOT_KEYCHAIN_TEST !== "1")
)(
  "serves credential metadata over authenticated RPC without disclosing values and honors persistence capability",
  async () => {
    const f = await fixture(() => ({ content: "unused" }))
    const child = f.launch(),
      client = await f.connect(child)
    const { bot, conversationId } = await client.call("create", {
      nonce: "credential-process",
      name: "凭据"
    })
    const secret = "PROCESS_PRIVATE_CREDENTIAL_287406"
    const record = await client.call("saveSecret", {
      botId: bot.id,
      name: "平台",
      description: "登录测试",
      origin: "https://dev.example.com",
      value: secret
    })
    expect(JSON.stringify(record)).not.toContain(secret)
    const catalog = await client.call("secrets", bot.id)
    expect(catalog.items).toEqual([record])
    expect(catalog.persistent).toBe(process.platform === "win32")
    await expect(
      client.call("saveSecret", {
        botId: bot.id,
        name: "invalid",
        description: "",
        origin: "http://example.com",
        value: "rejected"
      })
    ).rejects.toThrow("HTTPS")
    expect((await client.call("status")).capabilities).toContain("message-reactions")
    expect((await client.call("status")).capabilities).toContain("skill-references")
    const skill = await client.call("saveSkill", {
      botId: bot.id,
      name: "检查流程",
      instructions: "检查记录",
      enabled: true
    })
    const selection = { botId: bot.id, id: skill.id, version: skill.version }
    expect(
      (await client.call("skillCandidates", { conversationId })).map((item) => item.id)
    ).toEqual([skill.id])
    const message = await client.call("send", {
      nonce: "reaction-process",
      conversationId,
      text: "记录测试",
      skills: [selection]
    })
    await until(
      async () => !(await client.call("snapshot")).runs.some((run) => run.id === message.runIds[0])
    )
    const reaction = await client.call("react", {
      conversationId,
      messageId: message.messageId,
      revision: 0,
      emoji: "👍",
      active: true
    })
    await f.stop(child)
    expect(f.logs.get(child)).not.toContain(secret)
    const restarted = f.launch(),
      next = await f.connect(restarted)
    expect((await next.call("secrets", bot.id)).items).toEqual(catalog.persistent ? [record] : [])
    expect(
      await next.call("reactions", { conversationId, messageIds: [message.messageId] })
    ).toEqual([reaction])
    expect((await next.call("messages", { conversationId }))[0].skillReferences).toEqual([
      { ...selection, name: "检查流程" }
    ])
    if (catalog.persistent)
      expect(
        (await readFile(join(f.directory, "secrets.private"))).includes(Buffer.from(secret))
      ).toBe(false)
    await next.call("delete", { id: bot.id, revision: bot.revision })
    await expect(next.call("secrets", bot.id)).rejects.toThrow("已删除")
    expect(f.logs.get(restarted) ?? "").not.toContain(secret)
  },
  30_000
)

processTest(
  "resumes an acknowledged file chunk after Host SIGKILL without publishing an incomplete artifact",
  async () => {
    const f = await fixture(() => ({ content: "unused" }))
    const child = f.launch(),
      first = await f.connect(child)
    const { conversationId } = await first.call("create", { nonce: "file-bot", name: "文件" })
    const bytes = Buffer.alloc(700_000, 73),
      split = 512 * 1024
    const input = {
      nonce: "file-upload",
      conversationId,
      name: "durable.txt",
      mime: "text/plain",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex")
    }
    await first.call("beginUpload", input)
    await first.call("uploadChunk", {
      id: input.nonce,
      offset: 0,
      base64: bytes.subarray(0, split).toString("base64")
    })
    await f.stop(child, "SIGKILL")
    const resumed = await f.connect(f.launch())
    expect(await resumed.call("artifacts", conversationId)).toEqual([])
    expect((await resumed.call("beginUpload", input)).offset).toBe(split)
    await resumed.call("uploadChunk", {
      id: input.nonce,
      offset: split,
      base64: bytes.subarray(split).toString("base64")
    })
    const artifact = await resumed.call("finishUpload", input.nonce)
    expect(artifact.sha256).toBe(input.sha256)
    expect((await resumed.call("fileChunk", { id: artifact.id, offset: split })).base64).toBe(
      bytes.subarray(split).toString("base64")
    )
    expect(
      await resumed.call("filePreview", {
        id: artifact.id,
        conversationId,
        requestId: "restored-preview",
        offset: bytes.length - 10
      })
    ).toMatchObject({ kind: "text", page: { text: "I".repeat(10), hasMore: false } })
  },
  20_000
)

processTest(
  "keeps the compiled Host alive after desktop connections close and reopens durable history",
  async () => {
    const f = await fixture(() => ({ content: "后台已完成" }))
    const child = f.launch(),
      first = await f.connect(child)
    const { bot, conversationId } = await first.call("create", {
      nonce: "create",
      name: "独立后台"
    })
    await first.call("send", { nonce: "send", conversationId, text: "继续工作" })
    first.close()
    await delay(1000)
    expect(child.exitCode).toBeNull()
    const second = await f.connect(child)
    await until(
      async () => (await second.call("messages", { conversationId })).at(-1)?.text === "后台已完成"
    )
    const original = (await second.call("messages", { conversationId }))[0]
    expect((await second.call("status")).capabilities).toContain("message-replies")
    expect((await second.call("status")).capabilities).toContain("message-recipients")
    const reply = await second.call("send", {
      nonce: "compiled-reply",
      conversationId,
      text: "请解释这项结果",
      replyTo: original.id,
      recipients: [bot.id]
    })
    await until(async () =>
      (await second.call("messages", { conversationId })).some(
        (message) => message.sender === "bot" && message.runId === reply.runIds[0]
      )
    )
    const quoted = await second.call("message", { conversationId, id: reply.messageId })
    expect(quoted.replyPreview).toMatchObject({ id: original.id, text: original.text })
    expect(quoted.recipientReferences).toEqual([{ botId: bot.id, name: "独立后台" }])
    let messages = await second.call("messages", { conversationId })
    expect((await second.call("status")).capabilities).toContain("routine-management")
    const routine = await second.call("saveRoutine", {
      botId: bot.id,
      name: "后台例程",
      prompt: "检查项目",
      enabled: false,
      timezone: "Asia/Shanghai",
      schedule: { kind: "interval", everyMs: 60_000, anchor: Date.now() }
    })
    const deletion = {
      nonce: "compiled-routine-delete",
      botId: bot.id,
      id: routine.id,
      revision: routine.revision
    }
    const testRun = await second.call("runRoutine", { id: routine.id, nonce: "compiled-history" })
    const historyInput = { botId: bot.id, routineId: routine.id }
    await until(
      async () =>
        (await second.call("routineHistory", historyInput)).items[0]?.status === "succeeded"
    )
    const history = await second.call("routineHistory", historyInput)
    expect(history.items).toMatchObject([
      { id: testRun.id, status: "succeeded", trigger: "manual", summary: "后台已完成" }
    ])
    messages = await second.call("messages", { conversationId })
    const deleted = await second.call("deleteRoutine", deletion)
    expect(deleted).toEqual({ id: routine.id, cancelledRunIds: [], activeRunIds: [] })
    second.close()
    await f.stop(child)
    const restarted = await f.connect(f.launch())
    expect(await restarted.call("deleteRoutine", deletion)).toEqual(deleted)
    expect(await restarted.call("routines", bot.id)).toEqual([])
    expect(await restarted.call("routineHistory", historyInput)).toEqual(history)
    expect(
      (await restarted.call("messages", { conversationId })).map((message) => message.id)
    ).toEqual(messages.map((message) => message.id))
    expect(await restarted.call("message", { conversationId, id: reply.messageId })).toEqual(quoted)
    expect(
      await restarted.call("search", { query: "请解释这项结果", kind: "message", conversationId })
    ).toMatchObject({ matches: [{ id: reply.messageId, conversationId }], cursor: null })
  },
  30_000
)

processTest(
  "arbitrates concurrent compiled Hosts and recovers a truncated startup descriptor",
  async () => {
    const f = await fixture(() => ({ content: "ok" }))
    await writeFile(join(f.directory, "host.json"), '{"pid":')
    const first = f.launch(),
      client = await f.connect(first)
    const before = await client.call("status")
    const other = [f.launch(), f.launch()]
    await Promise.all(
      other.map(async (child) => {
        const [code] = await once(child, "exit", { signal: AbortSignal.timeout(10_000) })
        expect(code, f.logs.get(child)).toBe(0)
      })
    )
    expect((await client.call("status")).hostId).toBe(before.hostId)
    expect(JSON.parse(await readFile(join(f.directory, "host.json"), "utf8")).pid).toBe(first.pid)
  },
  25_000
)

it.skipIf(process.env.CMB_BOT_PROCESS_TEST !== "1" || process.platform === "win32")(
  "uses an owned bounded endpoint for long multibyte TMPDIR and reclaims its exact socket after compiled Host SIGKILL",
  async () => {
    const f = await fixture(() => ({ content: "unused" }))
    const temporaryDirectory = join(f.directory, "临".repeat(45))
    await mkdir(temporaryDirectory, { mode: 0o700 })
    const environment = {
      TMPDIR: temporaryDirectory,
      TMP: temporaryDirectory,
      TEMP: temporaryDirectory
    }
    const original = f.launch(false, environment),
      first = await f.connect(original)
    const descriptor = JSON.parse(
      await readFile(join(f.directory, "host.json"), "utf8")
    ) as BotHostDescriptor
    const maximum = process.platform === "linux" ? 107 : 103
    expect(Buffer.byteLength(descriptor.socketPath)).toBeLessThanOrEqual(maximum)
    expect(descriptor.socketPath.startsWith(temporaryDirectory)).toBe(false)
    expect((await stat(dirname(descriptor.socketPath))).mode & 0o777).toBe(0o700)
    expect((await stat(descriptor.socketPath)).mode & 0o777).toBe(0o600)
    expect((await first.call("snapshot")).runs).toEqual([])
    const killed = once(original, "exit")
    await f.stop(original, "SIGKILL")
    expect(await killed).toEqual([null, "SIGKILL"])
    first.close()
    // SIGKILL bypassed normal server.close and left the actual socket on disk.
    expect((await stat(descriptor.socketPath)).isSocket()).toBe(true)
    const replacement = f.launch(false, environment),
      second = await f.connect(replacement)
    const next = JSON.parse(
      await readFile(join(f.directory, "host.json"), "utf8")
    ) as BotHostDescriptor
    expect(next.socketPath).toBe(descriptor.socketPath)
    expect(next.token).not.toBe(descriptor.token)
    expect((await second.call("snapshot")).runs).toEqual([])
    expect(f.requests).toEqual([])
    await f.stop(replacement)
    second.close()
    await expect(stat(next.socketPath)).rejects.toMatchObject({
      code: "ENOENT"
    })
    // One small marked namespace is intentionally reused, not a new random
    // directory per crash. It is not a claim of zero residual temp files.
    expect(await readdir(dirname(next.socketPath))).toEqual(["owner.private.json"])
  },
  40_000
)

processTest(
  "resumes a persisted graph after SIGKILL and review without repeating a committed tool",
  async () => {
    const f = await fixture((_body, index) =>
      index === 1
        ? {
            content: null,
            tool_calls: [
              {
                id: "remember-before-crash",
                type: "function",
                function: {
                  name: "remember",
                  arguments: JSON.stringify({ text: "恢复测试：固定事实" })
                }
              }
            ]
          }
        : index === 2
          ? null
          : { content: "检查点恢复完成" }
    )
    const child = f.launch(),
      first = await f.connect(child)
    const { bot, conversationId } = await first.call("create", {
      nonce: "create",
      name: "恢复验证"
    })
    expect(bot.workspacePath).toBe((await first.call("status")).sharedWorkspace)
    const sent = await first.call("send", {
      nonce: "send",
      conversationId,
      text: "先保存事实，再继续"
    })
    await until(
      async () => f.requests.length === 2 && (await first.call("memories", bot.id)).length === 1
    )
    const checkpointSnapshot = await first.call("snapshot")
    expect(checkpointSnapshot.runs[0].checkpoint).not.toBeNull()
    expect(checkpointSnapshot.interactions.filter((i) => i.localProjectAccess)).toEqual([])
    await f.stop(child, "SIGKILL")
    first.close()
    const persisted = new BotStore(join(f.directory, "bots.sqlite"))
    try {
      // Verify the killed Host actually wrote dependent message deltas. A
      // full-snapshot-only fixture would not exercise the new recovery path.
      expect(
        Number(
          persisted.db.exec(
            "SELECT COUNT(*) FROM bot_graph_message_heads h JOIN bot_graph_message_snapshots s ON s.thread_id=h.thread_id AND s.ns=h.ns AND s.id=h.snapshot_id WHERE s.parent_id IS NOT NULL"
          )[0].values[0][0]
        )
      ).toBeGreaterThan(0)
    } finally {
      persisted.close()
    }
    const second = await f.connect(f.launch())
    await until(
      async () =>
        (await second.call("snapshot")).runs.some(
          (run) => run.id === sent.runIds[0] && run.status === "needs_review"
        ),
      40_000
    )
    const interrupted = (await second.call("snapshot")).runs.find(
      (run) => run.id === sent.runIds[0]
    )!
    expect(await second.call("effects", interrupted.id)).toEqual([])
    await second.call("recover", {
      id: interrupted.id,
      revision: interrupted.revision,
      decision: "resume",
      note: "测试服务确认没有外部操作",
      effects: []
    })
    await until(
      async () =>
        (await second.call("messages", { conversationId })).at(-1)?.text === "检查点恢复完成"
    )
    expect(
      (await second.call("snapshot")).interactions.filter((i) => i.localProjectAccess)
    ).toEqual([])
    expect(await second.call("memories", bot.id)).toHaveLength(1)
    const outputs = (await second.call("messages", { conversationId })).filter(
      (message) => message.sender === "bot"
    )
    expect(outputs).toHaveLength(1)
    expect(outputs[0].runId).toBe(interrupted.id)
    expect(f.requests).toHaveLength(3)
    expect(
      f.requests[2].messages.some(
        (message) => message.role === "tool" && message.tool_call_id === "remember-before-crash"
      )
    ).toBe(true)
  },
  75_000
)

processTest.each([
  { isolated: false, background: false },
  { isolated: true, background: false },
  { isolated: false, background: true },
  { isolated: true, background: true }
])(
  "recovers parallel workflow children after Host SIGKILL without repeating a completed edit (isolated=$isolated, background=$background)",
  async ({ isolated, background }) => {
    const originalScript =
      'export const meta={name:"Recovery",description:"Parallel recovery"}; return await parallel([() => agent("TASK_WRITE", {label:"Write result"}), () => agent("TASK_WAIT", {label:"Read result"})]);'
    const script = isolated
      ? originalScript.replaceAll("{label:", '{isolation:"worktree",label:')
      : originalScript
    let resumed = false
    const toolCall = (name: string, args: unknown, id: string) => ({
      content: null,
      tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }]
    })
    const f = await fixture((body) => {
      const hasResult = body.messages.some((message) => message.role === "tool")
      if (background && body.tools.some((item) => item.function.name === "dispatch_task")) {
        if (!body.messages.some((message) => message.tool_call_id === "dispatch-write"))
          return toolCall(
            "dispatch_task",
            {
              prompt: "TASK_WRITE",
              label: "Write result",
              ...(isolated ? { isolation: "worktree" } : {})
            },
            "dispatch-write"
          )
        if (!body.messages.some((message) => message.tool_call_id === "dispatch-wait"))
          return toolCall(
            "dispatch_task",
            {
              prompt: "TASK_WAIT",
              label: "Read result",
              ...(isolated ? { isolation: "worktree" } : {})
            },
            "dispatch-wait"
          )
        const receipts = body.messages.filter(
          (message) =>
            message.role === "user" &&
            String(message.content).includes("[Background workflow result")
        )
        return { content: receipts.length === 2 ? "WORKFLOW_RECOVERED" : "WAITING_BACKGROUND" }
      }
      if (body.tools.some((item) => item.function.name === "workflow"))
        return hasResult
          ? { content: "WORKFLOW_RECOVERED" }
          : toolCall("workflow", { script, maxConcurrency: 2, tokenBudget: 100_000 }, "parallel")
      const writes = body.messages.some(
        (message) => message.role === "user" && message.content === "TASK_WRITE"
      )
      if (writes)
        return hasResult
          ? { content: "WRITE_COMPLETED" }
          : toolCall(
              "project_edit",
              {
                path: "completed.txt",
                expected_sha256: null,
                content: "written exactly once"
              },
              "single-edit"
            )
      if (!hasResult) return toolCall("project_read", { path: "input.txt" }, "read-before-crash")
      return resumed ? { content: "READ_RESUMED" } : null
    })
    const workspace = await mkdtemp(join(tmpdir(), "cmb-workflow-recovery-"))
    cleanup.push(() => rm(workspace, { recursive: true, force: true }))
    await writeFile(join(workspace, "input.txt"), "read evidence")
    if (isolated) {
      const exec = promisify(execFile)
      for (const args of [
        ["init", "-b", "main"],
        ["add", "input.txt"],
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-m",
          "initial"
        ]
      ])
        await exec("git", ["-C", workspace, ...args])
    }
    const original = f.launch(),
      first = await f.connect(original)
    const { conversationId } = await first.call("create", {
      nonce: "workflow-bot",
      name: "并行恢复验证",
      workspacePath: workspace
    })
    const sent = await first.call("send", {
      nonce: "workflow-task",
      conversationId,
      text: "Run both tasks"
    })
    const runId = sent.runIds[0]
    const projectSnapshot = await createRecoveryProjectSnapshot({
      workspace,
      conversationId,
      runId,
      children: {
        limit: 2,
        access: (run) => {
          expect(["Write result", "Read result"]).toContain(run.workflowTask?.label)
          return run.workflowTask?.label === "Write result" ? { writePaths: ["completed.txt"] } : {}
        }
      }
    })
    const pendingWrite = (snapshot: Awaited<ReturnType<typeof projectSnapshot>>) =>
      snapshot.interactions.find(
        (item) =>
          item.kind === "approval" &&
          item.status === "pending" &&
          !item.localProjectAccess &&
          snapshot.runs.some(
            (run) =>
              run.id === item.runId &&
              run.parentRunId === runId &&
              run.conversationId === conversationId &&
              run.rootRunId === runId &&
              run.workflowTask?.label === "Write result"
          )
      )
    await until(async () => Boolean(pendingWrite(await projectSnapshot(first))))
    const approval = pendingWrite(await projectSnapshot(first))!
    expect(JSON.parse(approval.prompt).project.path).toBe("completed.txt")
    await first.call("answer", { id: approval.id, revision: approval.revision, answer: "approve" })
    await until(async () => {
      await projectSnapshot(first)
      const history = await first.call("runHistory", { conversationId, runId })
      return (
        history.children?.some((item) => item.status === "succeeded") === true &&
        f.requests.length >= 5 &&
        (!background ||
          f.requests.some(
            (body) =>
              body.tools.some((item) => item.function.name === "dispatch_task") &&
              body.messages.some((message) =>
                String(message.content).includes("[Background workflow result")
              )
          ))
      )
    })
    // The model fixture delays replies by 300 ms. Seeing an HTTP request does
    // not mean the graph committed its response. Kill at the durable wait
    // boundary, not an arbitrary delay during an in-flight parent request.
    if (background)
      await until(
        async () =>
          (await projectSnapshot(first)).runs.find((item) => item.id === runId)?.activity
            ?.description === "等待 1 项后台任务完成"
      )
    const before = await first.call("runHistory", { conversationId, runId })
    expect(before.children).toHaveLength(2)
    const complete = before.children!.find((item) => item.status === "succeeded")!
    const active = before.children!.find((item) => item.status === "running")!
    const originalWorktree = isolated
      ? (await first.call("worktreeDetail", { conversationId, runId: active.id })).worktree
      : null
    const checkpoint = (await projectSnapshot(first)).runs.find(
      (item) => item.id === active.id
    )!.checkpoint
    expect(checkpoint).not.toBeNull()
    expect(await first.call("effects", complete.id)).toMatchObject([{ status: "succeeded" }])
    const activeRun = (await projectSnapshot(first)).runs.find((item) => item.id === active.id)!
    await first.call("workflowControl", {
      conversationId,
      runId: active.id,
      nonce: "pending-child-instruction",
      revision: activeRun.revision,
      operation: "message",
      text: "RECOVERY_STEER_PRESERVED: report the read evidence."
    })
    const requestsBefore = f.requests.length
    await f.stop(original, "SIGKILL")
    first.close()
    resumed = true
    const replacement = f.launch(),
      second = await f.connect(replacement)
    await until(
      async () =>
        (await projectSnapshot(second)).runs.some(
          (item) => item.id === runId && item.status === "needs_review"
        ),
      40_000
    )
    for (const id of [active.id, runId]) {
      const run = (await projectSnapshot(second)).runs.find((item) => item.id === id)!
      expect(run.status).toBe("needs_review")
      if (id === active.id) expect(run.checkpoint).toBe(checkpoint)
      await second.call("recover", {
        id,
        revision: run.revision,
        decision: "resume",
        note: "已核对，无待确认外部操作",
        effects: []
      })
    }
    await until(async () => {
      await projectSnapshot(second)
      return (await second.call("runHistory", { conversationId, runId })).run.status === "succeeded"
    }).catch(async (error) => {
      throw new Error(
        `${error}\n${JSON.stringify(await projectSnapshot(second))}\n${f.logs.get(replacement)}`
      )
    })
    const after = await second.call("runHistory", { conversationId, runId })
    expect(after.children!.map((item) => item.id).sort()).toEqual(
      before.children!.map((item) => item.id).sort()
    )
    expect(after.children!.every((item) => item.status === "succeeded")).toBe(true)
    const finishedWorkspace = isolated
      ? (await second.call("worktreeDetail", { conversationId, runId: complete.id })).worktree
          .directory
      : workspace
    expect(await readFile(join(finishedWorkspace, "completed.txt"), "utf8")).toBe(
      "written exactly once"
    )
    if (isolated) {
      expect(
        (await second.call("worktreeDetail", { conversationId, runId: active.id })).worktree.id
      ).toBe(originalWorktree!.id)
      await expect(readFile(join(workspace, "completed.txt"))).rejects.toThrow()
    }
    expect(await second.call("effects", complete.id)).toHaveLength(1)
    expect(
      f.requests.slice(requestsBefore),
      JSON.stringify(
        f.requests.slice(requestsBefore).map((request) => ({
          parent: request.tools.some((item) => item.function.name === "dispatch_task"),
          messages: request.messages.slice(-4)
        }))
      )
    ).toHaveLength(2)
    expect(JSON.stringify(f.requests[requestsBefore].messages)).toContain(
      "RECOVERY_STEER_PRESERVED"
    )
    expect(after.modelBudget!.requests).toBe(before.modelBudget!.requests + 2)
    expect(
      f.requests[requestsBefore].messages.some(
        (message) => message.role === "tool" && message.tool_call_id === "read-before-crash"
      )
    ).toBe(true)
    const replies = (await second.call("messages", { conversationId })).filter(
      (message) => message.sender === "bot"
    )
    expect(replies).toHaveLength(1)
    expect(replies[0].text).toBe("WORKFLOW_RECOVERED")
  },
  75_000
)

processTest.each(["foreground", "background", "service"] as const)(
  "kills an executing shell after Host SIGKILL and retains its uncertain effect without replay (mode=%s)",
  async (mode) => {
    const background = mode !== "foreground"
    const f = await fixture(
      (body) =>
        body.messages.some((message) => message.role === "tool")
          ? { content: "Waiting for command result" }
          : {
              content: null,
              tool_calls: [
                {
                  id: "shell-before-crash",
                  type: "function",
                  function: {
                    name: "execute",
                    arguments: JSON.stringify({
                      command: "node running.cjs",
                      timeout_seconds: 60,
                      ...(background ? { run_in_background: true } : {}),
                      ...(mode === "service" ? { keep_alive: true } : {})
                    })
                  }
                }
              ]
            },
      false,
      process.platform === "darwin" ? { trustedMacOwnedShell: true } : {}
    )
    const workspace = await mkdtemp(join(tmpdir(), "cmb-bot-shell-crash-"))
    cleanup.push(async () => {
      if (!(await f.shouldPreserveScene())) await rm(workspace, { recursive: true, force: true })
    })
    await mkdir(workspace, { recursive: true })
    await writeFile(
      join(workspace, "running.cjs"),
      "const fs=require('fs'); fs.appendFileSync('starts','x'); console.log('BEFORE_HOST_CRASH'); setInterval(()=>fs.appendFileSync('ticks','x'),50)"
    )
    const snapshot = await readBotModelSnapshot(join(f.directory, "models.private"))
    snapshot.execution = { windowsSandbox: "none", resourceDirectory: resolve("resources") }
    await writeBotModelSnapshot(join(f.directory, "models.private"), snapshot)
    const original = f.launch(),
      first = await f.connect(original)
    const { conversationId } = await first.call("create", {
      nonce: "create",
      name: "命令恢复",
      workspacePath: workspace
    })
    const sent = await first.call("send", { nonce: "send", conversationId, text: "运行验证" })
    const local = await createTestLocalProjectAccess({
      workspace,
      runId: sent.runIds[0],
      readProject: true,
      commands: ["node running.cjs"]
    })
    const projectSnapshot = () =>
      local.snapshot({
        snapshot: () => first.call("snapshot"),
        resolve: (input) => first.call("resolveLocalToolPermission", input)
      })
    await until(async () =>
      (await projectSnapshot()).interactions.some(
        (i) => i.runId === sent.runIds[0] && i.status === "pending" && !i.localProjectAccess
      )
    )
    const approval = (await projectSnapshot()).interactions.find(
      (i) => i.runId === sent.runIds[0] && i.status === "pending" && !i.localProjectAccess
    )!
    expect(JSON.parse(approval.prompt).shell.command).toBe("node running.cjs")
    await first.call("answer", { id: approval.id, revision: approval.revision, answer: "approve" })
    await until(
      async () => (await readFile(join(workspace, "ticks")).catch(() => Buffer.alloc(0))).length > 0
    )
    let jobId: string | undefined
    if (background) {
      const history = await first.call("runHistory", { conversationId, runId: sent.runIds[0] })
      jobId = history.shellJobs![0].id
      await until(async () =>
        (
          await first.call("shellJob", { conversationId, runId: sent.runIds[0], jobId: jobId! })
        ).output.includes("BEFORE_HOST_CRASH")
      )
    }
    if (mode === "service") {
      await until(
        async () =>
          (await first.call("runHistory", { conversationId, runId: sent.runIds[0] })).run.status ===
          "succeeded"
      )
      expect(
        (await first.call("shellJob", { conversationId, runId: sent.runIds[0], jobId: jobId! }))
          .keepAlive
      ).toBe(true)
    }
    const resourceRoot = join(await realpath(f.directory), "shell-resources")
    const runningResources = await inspectOwnedShellReceipts(resourceRoot)
    expect(runningResources).toHaveLength(1)
    expect(runningResources[0]).toMatchObject({
      runId: sent.runIds[0],
      runAuthorized: true
    })
    const activeReview = await inspectDesktopBotShellResources(f.directory)
    expect(activeReview.mode).toBe("active-owner")
    expect(activeReview.review.entries).toMatchObject([
      { nonce: runningResources[0].nonce, runId: sent.runIds[0], runAuthorized: true }
    ])
    const modelCallsBeforeCrash = f.requests.length
    await f.stop(original, "SIGKILL")
    first.close()
    await delay(1500)
    const ticks = await readFile(join(workspace, "ticks"), "utf8")
    await delay(350)
    expect(await readFile(join(workspace, "ticks"), "utf8")).toBe(ticks)
    await until(async () => {
      try {
        const proof = JSON.parse(
          await readFile(join(resourceRoot, "operation-0", "closure.json"), "utf8")
        )
        return proof.scope === "controlled-inherited-group"
      } catch {
        return false
      }
    })
    const offlineReview = await inspectDesktopBotShellResources(f.directory)
    expect(offlineReview.mode).toBe("exclusive")
    expect(offlineReview.review).toMatchObject({
      state: "requires_review",
      reason: "physical-closure-unproven",
      entries: [{ nonce: runningResources[0].nonce, status: "effect-unproven" }]
    })
    // This fixture's inherited ticker stopped, but a group-empty witness cannot
    // prove all possible descendants stopped. Keep the real resource receipt
    // and refuse Store/recovery startup instead of discarding weak evidence.
    const retained = await inspectOwnedShellReceipts(resourceRoot)
    expect(retained).toHaveLength(1)
    expect(retained[0].phase).not.toBe("resource-closed")
    const restarting = f.launch(),
      closed = once(restarting, "exit")
    const [code] = await closed
    expect(code).not.toBe(0)
    expect(f.logs.get(restarting)).toContain("有命令尚未确认停止")
    expect(await inspectOwnedShellReceipts(resourceRoot)).toEqual(retained)
    expect(await readFile(join(workspace, "starts"), "utf8")).toBe("x")
    expect(f.requests).toHaveLength(modelCallsBeforeCrash)
  },
  75_000
)

processTest(
  "blocks a busy Host update and retains the actual lifetime lock across the desktop handoff",
  async () => {
    const f = await fixture(() => null, true)
    const original = f.launch(),
      client = await f.connect(original)
    const created = await client.call("create", { nonce: "bot", name: "安装保护验收" })
    const work = await client.call("send", {
      nonce: "work",
      conversationId: created.conversationId,
      text: "Keep working"
    })
    await until(async () => f.requests.length === 1)
    const helper = join(dirname(f.directory), "update-guard.cjs")
    await build({
      stdin: {
        contents: `import {withDesktopBotUpdate} from ${JSON.stringify(resolve("src/main/bots/desktop-client.ts"))};
          void withDesktopBotUpdate(async () => {console.log('INSTALL_STARTED')})
          .then(() => {console.log('INSTALL_HELD');setInterval(()=>{},1000)})
          .catch(error => {console.log('INSTALL_REFUSED '+error.message)});`,
        resolveDir: process.cwd(),
        loader: "ts"
      },
      plugins: [
        {
          name: "unused-desktop-models",
          setup(bundler) {
            bundler.onResolve({ filter: /^\.\/desktop-model-sync$/ }, () => ({
              path: "models",
              namespace: "fixture"
            }))
            bundler.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
              contents:
                "export function syncDesktopBotModels(){throw Error('Unexpected model publication during update')}"
            }))
          }
        }
      ],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: helper,
      logLevel: "silent"
    })
    const launchGuard = () => {
      const child = spawn(process.env.CMB_BOT_NODE ?? process.execPath, [helper], {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          CMB_COWORK_AGENT_HOME: dirname(f.directory)
        },
        stdio: ["ignore", "pipe", "pipe"]
      })
      const output = { text: "" }
      child.stdout.on("data", (data) => {
        output.text += data
      })
      child.stderr.on("data", (data) => {
        output.text += data
      })
      cleanup.push(() => f.stop(child))
      return { child, output }
    }
    const refused = launchGuard()
    await until(async () => refused.child.exitCode !== null)
    expect(refused.output.text).toContain("INSTALL_REFUSED 仍有任务执行")
    expect(refused.output.text).not.toContain("INSTALL_STARTED")
    expect(original.exitCode).toBeNull()
    await client.call("cancel", work.runIds[0])
    await until(
      async () =>
        (
          await client.call("runHistory", {
            conversationId: created.conversationId,
            runId: work.runIds[0]
          })
        ).run.status === "cancelled"
    )
    const guard = launchGuard()
    await until(async () => guard.output.text.includes("INSTALL_HELD"))
    expect(original.exitCode).toBe(0)
    const contender = f.launch()
    await until(async () => contender.exitCode !== null)
    expect(contender.exitCode, f.logs.get(contender)).toBe(0)
    await expect(readFile(join(f.directory, "host.json"))).rejects.toMatchObject({ code: "ENOENT" })
    await f.stop(guard.child)
    const replacement = await f.connect(f.launch())
    expect((await replacement.call("snapshot")).bots.map((bot) => bot.id)).toContain(created.bot.id)
    expect(
      (
        await replacement.call("runHistory", {
          conversationId: created.conversationId,
          runId: work.runIds[0]
        })
      ).run.status
    ).toBe("cancelled")
  },
  45_000
)

processTest(
  "acknowledges an idle upgrade, exits the actual Host and reconnects without losing history",
  async () => {
    const f = await fixture(() => ({ content: "ok" }))
    const child = f.launch(),
      client = await f.connect(child)
    const created = await client.call("create", { nonce: "bot", name: "升级验收" })
    const status = await client.call("status")
    expect(status.buildId).toMatch(/^[a-f0-9]{24}$/)
    const exited = once(child, "exit")
    expect(await client.restartIfIdle(status.hostId)).toEqual({ accepted: true, reason: null })
    await exited
    expect(child.exitCode).toBe(0)
    const replacement = await f.connect(f.launch())
    expect((await replacement.call("status")).hostId).not.toBe(status.hostId)
    expect((await replacement.call("snapshot")).bots.map((bot) => bot.id)).toContain(created.bot.id)
  },
  30_000
)

processTest(
  "executes an approved installed plugin in the compiled Host with no connected desktop",
  async () => {
    const f = await fixture((body) =>
      body.messages.some((message) => message.role === "tool")
        ? { content: "后台插件已读取项目文件" }
        : {
            tool_calls: [
              {
                id: "brief",
                type: "function",
                function: { name: "mcp__function-commands__project_brief", arguments: "{}" }
              }
            ]
          }
    )
    const workspace = await mkdtemp(join(tmpdir(), "cmb-bot-plugin-process-"))
    cleanup.push(() => rm(workspace, { recursive: true, force: true }))
    await writeFile(join(workspace, "plugin-process-proof.txt"), "real project")
    const path = join(f.directory, "models.private")
    const config = await readBotModelSnapshot(path)
    await writeBotModelSnapshot(path, {
      ...config,
      mods: {
        enabled: true,
        policy: DEFAULT_MOD_POLICY,
        plugins: [
          {
            id: "fixture",
            name: "Function Commands",
            path: resolve("resources/mods/function-commands"),
            enabled: true
          }
        ]
      }
    })
    const child = f.launch(),
      first = await f.connect(child)
    const { conversationId } = await first.call("create", {
      nonce: "create",
      name: "后台插件",
      workspacePath: workspace,
      connectorIds: ["bot-mod:fixture"]
    })
    const { runIds } = await first.call("send", {
      nonce: "send",
      conversationId,
      text: "查看项目文件"
    })
    await until(async () =>
      (await first.call("snapshot")).interactions.some((item) => item.status === "pending")
    )
    const approval = (await first.call("snapshot")).interactions.find(
      (item) => item.status === "pending"
    )!
    await first.call("answer", { id: approval.id, revision: approval.revision, answer: "approve" })
    first.close()
    await until(async () => f.requests.length >= 2)
    const second = await f.connect(child)
    await until(async () =>
      (await second.call("messages", { conversationId })).some(
        (message) => message.runId === runIds[0] && message.sender === "bot"
      )
    )
    expect((await second.call("messages", { conversationId })).at(-1)).toMatchObject({
      runId: runIds[0],
      sender: "bot",
      text: "后台插件已读取项目文件",
      pluginNotice: { text: expect.stringMatching(/^本轮完成/), failed: false }
    })
    const completed = (await second.call("messages", { conversationId })).at(-1)!
    expect(child.exitCode).toBeNull()
    await f.stop(child)
    const restarted = await f.connect(f.launch())
    expect(await restarted.call("message", { conversationId, id: completed.id })).toEqual(completed)
    expect(JSON.stringify(f.requests.at(-1)?.messages)).toContain("plugin-process-proof.txt")
  },
  30_000
)

processTest(
  "preserves accepted current-task instructions and their checkpoint across SIGKILL without replaying work",
  async () => {
    const instruction = "请记录项目语言为中文，再继续任务"
    const f = await fixture((body, index) => {
      const steered = body.messages.some((message) => message.content === instruction)
      if (!steered)
        return {
          tool_calls: [
            {
              id: "waiting",
              type: "function",
              function: { name: "ask_user", arguments: JSON.stringify({ prompt: "如何继续？" }) }
            }
          ]
        }
      if (
        !body.messages.some(
          (message) => message.role === "tool" && String(message.content).includes("项目语言为中文")
        )
      )
        return {
          tool_calls: [
            {
              id: "remember-once",
              type: "function",
              function: { name: "remember", arguments: JSON.stringify({ text: "项目语言为中文" }) }
            }
          ]
        }
      if (index === 3) return null
      return { content: "已按补充要求完成，记忆仅保存一次。" }
    })
    const child = f.launch(),
      first = await f.connect(child)
    const { bot, conversationId } = await first.call("create", {
      nonce: "create",
      name: "补充要求恢复"
    })
    const sent = await first.call("send", { nonce: "first", conversationId, text: "处理项目任务" })
    await until(async () => (await first.call("snapshot")).interactions.length === 1)
    const extra = await first.call("send", {
      nonce: "steer",
      conversationId,
      text: instruction,
      steerRunId: sent.runIds[0]
    })
    await until(async () => f.requests.length === 3)
    expect(
      (await first.call("message", { conversationId, id: extra.messageId })).steering?.state
    ).toBe("accepted")
    await f.stop(child, "SIGKILL")
    const restarted = await f.connect(f.launch())
    await until(async () =>
      (await restarted.call("snapshot")).runs.some(
        (run) => run.id === sent.runIds[0] && run.status === "needs_review"
      )
    )
    const interrupted = (await restarted.call("snapshot")).runs.find(
      (run) => run.id === sent.runIds[0]
    )!
    await restarted.call("recover", {
      id: interrupted.id,
      revision: interrupted.revision,
      decision: "resume",
      note: "已核对，无外部操作",
      effects: []
    })
    await until(async () =>
      (await restarted.call("messages", { conversationId })).some(
        (message) => message.text === "已按补充要求完成，记忆仅保存一次。"
      )
    )
    expect(
      f.requests.at(-1)!.messages.filter((message) => message.content === instruction)
    ).toHaveLength(1)
    expect(
      (await restarted.call("memories", bot.id)).filter(
        (memory) => memory.text === "项目语言为中文"
      )
    ).toHaveLength(1)
  },
  45000
)

processTest(
  "keeps file tombstones across Host restart and reclaims interrupted cleanup without deleting another Bot's shared content",
  async () => {
    const f = await fixture(() => ({ content: "No task should be needed" }))
    const child = f.launch()
    const client = await f.connect(child)
    const a = await client.call("create", { nonce: "files-a", name: "A" })
    const b = await client.call("create", { nonce: "files-b", name: "B" })
    const upload = {
      name: "shared.txt",
      mime: "text/plain",
      base64: Buffer.from("SHARED_CONTENT").toString("base64")
    }
    const first = await client.call("upload", {
      ...upload,
      nonce: "shared-a",
      conversationId: a.conversationId
    })
    const second = await client.call("upload", {
      ...upload,
      nonce: "shared-b",
      conversationId: b.conversationId
    })
    const deletion = {
      nonce: "delete-a",
      id: first.id,
      conversationId: a.conversationId,
      sha256: first.sha256
    }
    const deleted = await client.call("deleteFile", deletion)
    const abandoned = await client.call("upload", {
      ...upload,
      nonce: "orphan",
      conversationId: a.conversationId,
      base64: Buffer.from("INTERRUPTED_CLEANUP").toString("base64")
    })
    client.close()
    await f.stop(child, "SIGKILL")
    // Reproduce the durable boundary after deletion commits, before unlink.
    // Only the disposable stopped Host fixture is opened here.
    const { BotStore } = await import("./store")
    const offline = new BotStore(join(f.directory, "bots.sqlite"))
    try {
      offline.deleteArtifact({
        nonce: "interrupted-delete",
        id: abandoned.id,
        conversationId: a.conversationId,
        sha256: abandoned.sha256
      })
    } finally {
      offline.close()
    }
    expect((await readFile(join(f.directory, "objects", abandoned.sha256))).toString()).toBe(
      "INTERRUPTED_CLEANUP"
    )
    const restarted = await f.connect(f.launch())
    expect(await restarted.call("deleteFile", deletion)).toEqual(deleted)
    await expect(restarted.call("download", first.id)).rejects.toThrow("已删除")
    expect(
      Buffer.from((await restarted.call("download", second.id)).base64, "base64").toString()
    ).toBe("SHARED_CONTENT")
    await expect(readFile(join(f.directory, "objects", abandoned.sha256))).rejects.toMatchObject({
      code: "ENOENT"
    })
    await expect(
      restarted.call("upload", { ...upload, nonce: first.id, conversationId: a.conversationId })
    ).rejects.toThrow("已删除")
    expect(f.requests).toHaveLength(0)
  },
  30_000
)

processTest(
  "resumes durable memory synthesis after SIGKILL using the compiled Host without replaying the user task",
  async () => {
    const f = await fixture((body) => {
      const system = String(body.messages[0].content)
      if (system.includes("MEMORY_SYNTHESIS_VERIFICATION_V1"))
        return { content: JSON.stringify({ approved: true }) }
      if (system.includes("MEMORY_SYNTHESIS_V1")) {
        const request = JSON.parse(String(body.messages[1].content))
        return {
          content: JSON.stringify({
            changes: [
              {
                action: "create",
                content: "项目发布评审固定在每周三。",
                kind: "profile",
                sourceEvidenceIds: [request.newEvidence[0].id]
              }
            ]
          })
        }
      }
      return { content: "已按项目每周三发布评审的安排完成检查。" }
    })
    const first = f.launch(),
      client = await f.connect(first)
    const { bot, conversationId } = await client.call("create", {
      nonce: "memory-bot",
      name: "持久记忆助手"
    })
    const sent = await client.call("send", {
      nonce: "memory-task",
      conversationId,
      text: "我们项目每周三发布评审，请据此整理本周检查项。"
    })
    await until(async () => (await client.call("memoryPolicy", bot.id)).pending === 1)
    expect(f.requests).toHaveLength(1)
    client.close()
    await f.stop(first, "SIGKILL")
    const next = f.launch(),
      reopened = await f.connect(next)
    await until(async () => (await reopened.call("memories", bot.id)).length === 1, 30_000)
    expect((await reopened.call("memories", bot.id))[0]).toMatchObject({
      origin: "synthesized",
      sourceMessageId: sent.messageId,
      evidence: [{ runId: sent.runIds[0] }]
    })
    expect(f.requests).toHaveLength(3)
    expect(f.requests.slice(1).every((request) => request.tools.length === 0)).toBe(true)
    const memoryPolicy = await reopened.call("memoryPolicy", bot.id)
    expect(memoryPolicy.lastOutcome).toBe("committed")
    // This SSE fixture deliberately omits provider usage: retain unknown counters.
    expect(memoryPolicy.usage).toMatchObject({ requests: 2, unknownRequests: 2 })
    const taskUsage = (await reopened.call("runHistory", { conversationId, runId: sent.runIds[0] }))
      .modelUsage
    expect(taskUsage?.requests).toBe(1)
    expect(taskUsage?.models.every((model) => model.purpose === "task")).toBe(true)
    await f.stop(next)
    const final = f.launch(),
      confirmed = await f.connect(final)
    expect((await confirmed.call("memoryPolicy", bot.id)).usage).toEqual(memoryPolicy.usage)
    expect(f.requests).toHaveLength(3)
    await f.stop(final)
  },
  45_000
)

processTest.each(["PreSkillUse", "UserPromptSubmit", "StopFailure"] as const)(
  "restores compiled skill %s after SIGKILL without executing its approved Hook twice",
  async (event) => {
    const f = await fixture((_body, index) =>
      event === "StopFailure"
        ? { fixtureHttpStatus: 401 }
        : index === 1
          ? null
          : { content: "COMPILED_SKILL_RESUMED" }
    )
    const external = await mkdtemp(join(tmpdir(), "cmb-hook-process-source-"))
    cleanup.unshift(() => rm(external, { recursive: true, force: true }))
    const workspace = join(external, "workspace")
    const source = {
      builtinSkillsDir: join(external, "builtin"),
      customSkillsDir: join(external, "custom"),
      pluginsStorePath: join(external, "plugins.json"),
      disabledSkillsPath: join(external, "disabled.json"),
      disabledSkillsRevision: 0,
      globalRevision: 0
    }
    await mkdir(workspace)
    await mkdir(source.builtinSkillsDir)
    await mkdir(join(source.customSkillsDir, "review"), { recursive: true })
    await writeFile(source.pluginsStorePath, "[]")
    await writeFile(source.disabledSkillsPath, "[]")
    await writeFile(
      join(source.customSkillsDir, "review/SKILL.md"),
      "---\nname: review\n---\nFollow the reviewed process."
    )
    await writeFile(
      join(source.customSkillsDir, "review/hooks.json"),
      JSON.stringify([
        {
          id: "activation",
          event,
          matcher: event === "PreSkillUse" ? "review" : "*",
          enabled: true,
          command: "node activate.cjs"
        },
        ...(event === "StopFailure"
          ? [{ id: "final-check", event, enabled: true, command: "node -e \"console.log('{}')\"" }]
          : [])
      ])
    )
    await writeFile(
      join(source.customSkillsDir, "review/activate.cjs"),
      `
    process.stdin.resume();process.stdin.on('end',()=>{
      require('fs').appendFileSync(require('path').join(process.env.WORKSPACE_PATH,'activations'),'x');
      console.log(JSON.stringify({additionalContext:'COMPILED_ACTIVATION_GUIDANCE'}));
    });
  `
    )
    const modelFile = join(f.directory, "models.private")
    await writeBotModelSnapshot(modelFile, {
      ...(await readBotModelSnapshot(modelFile)),
      skillSources: source,
      execution: { windowsSandbox: "none", resourceDirectory: resolve("resources") }
    })
    const child = f.launch(),
      client = await f.connect(child)
    const { bot, conversationId } = await client.call("create", {
      nonce: "bot",
      name: "Reviewer",
      workspacePath: workspace
    })
    const catalog = await client.call("installedSkills", bot.id),
      skill = catalog.skills[0]
    const sent = await client.call("send", {
      nonce: "task",
      conversationId,
      text: "Use the selected skill",
      skills: [{ botId: bot.id, id: skill.id, version: skill.version }]
    })
    await until(async () =>
      (await client.call("snapshot")).interactions.some((item) => item.kind === "approval")
    )
    const approval = (await client.call("snapshot")).interactions.find(
      (item) => item.kind === "approval"
    )!
    expect(JSON.parse(approval.prompt).hook.event).toBe(event)
    expect(f.requests).toHaveLength(event === "StopFailure" ? 1 : 0)
    await client.call("answer", { id: approval.id, revision: approval.revision, answer: "approve" })
    await until(async () =>
      event === "StopFailure"
        ? (await client.call("snapshot")).interactions.some(
            (item) => item.kind === "approval" && item.id !== approval.id
          )
        : f.requests.length === 1
    )
    expect(await readFile(join(workspace, "activations"), "utf8")).toBe("x")
    if (event !== "StopFailure")
      expect(JSON.stringify(f.requests[0])).toContain("COMPILED_ACTIVATION_GUIDANCE")
    const effects = await client.call("effects", sent.runIds[0])
    expect(effects).toMatchObject([{ status: "succeeded" }])
    await f.stop(child, "SIGKILL")
    client.close()
    const nextChild = f.launch(),
      next = await f.connect(nextChild)
    await until(
      async () =>
        (await next.call("snapshot")).runs.some(
          (run) => run.id === sent.runIds[0] && run.status === "needs_review"
        ),
      40_000
    )
    const interrupted = (await next.call("snapshot")).runs.find((run) => run.id === sent.runIds[0])!
    await next.call("recover", {
      id: interrupted.id,
      revision: interrupted.revision,
      decision: "resume",
      note: "Confirmed the completed activation",
      effects: []
    })
    if (event === "StopFailure") {
      await until(async () =>
        (await next.call("snapshot")).interactions.some((item) => item.kind === "approval")
      )
      const remaining = (await next.call("snapshot")).interactions.find(
        (item) => item.kind === "approval"
      )!
      expect(JSON.parse(remaining.prompt).hook.command).toBe("node -e \"console.log('{}')\"")
      await next.call("answer", {
        id: remaining.id,
        revision: remaining.revision,
        answer: "approve"
      })
    }
    await until(async () =>
      ["succeeded", "failed"].includes(
        (await next.call("runHistory", { conversationId, runId: sent.runIds[0] })).run.status
      )
    )
    expect(
      (await next.call("runHistory", { conversationId, runId: sent.runIds[0] })).run,
      f.logs.get(nextChild)
    ).toMatchObject(
      event === "StopFailure"
        ? { status: "failed", error: expect.stringContaining("COMPILED_MODEL_REJECTED") }
        : { status: "succeeded" }
    )
    if (event === "StopFailure") {
      expect(await readFile(join(workspace, "activations"), "utf8")).toBe("x")
      const after = await next.call("effects", sent.runIds[0])
      expect(after).toHaveLength(2)
      expect(after.find((item) => item.id === effects[0].id)).toEqual(effects[0])
      expect(f.requests).toHaveLength(1)
      return
    }
    expect((await next.call("messages", { conversationId })).at(-1)?.text).toBe(
      "COMPILED_SKILL_RESUMED"
    )
    expect(await readFile(join(workspace, "activations"), "utf8")).toBe("x")
    expect(await next.call("effects", sent.runIds[0])).toEqual(effects)
    expect(f.requests).toHaveLength(2)
    expect(JSON.stringify(f.requests[1])).toContain("COMPILED_ACTIVATION_GUIDANCE")
  },
  65_000
)

processTest(
  "resumes compiled project Setup after SIGKILL without repeating completed initialization",
  async () => {
    const f = await fixture(() => ({ content: "SETUP_RECOVERY_DONE" }))
    const external = await mkdtemp(join(tmpdir(), "cmb-setup-process-"))
    cleanup.unshift(() => rm(external, { recursive: true, force: true }))
    const workspace = join(external, "project"),
      settings = join(external, "settings")
    await mkdir(workspace)
    await mkdir(settings)
    await writeFile(join(settings, "plugins.json"), "[]")
    await writeFile(
      join(settings, "hooks.json"),
      JSON.stringify(
        ["first", "last"].map((id) => ({
          id,
          event: "Setup",
          matcher: "init",
          command: `node ${id}.cjs`,
          enabled: true
        }))
      )
    )
    for (const name of ["first", "last"])
      await writeFile(
        join(settings, `${name}.cjs`),
        `process.stdin.resume();process.stdin.on('end',()=>{require('fs').appendFileSync(require('path').join(process.env.WORKSPACE_PATH,'setup.log'),${JSON.stringify(name + "\n")});console.log('{}')})`
      )
    const modelFile = join(f.directory, "models.private")
    await writeBotModelSnapshot(modelFile, {
      ...(await readBotModelSnapshot(modelFile)),
      hookSources: { root: settings },
      execution: { windowsSandbox: "none", resourceDirectory: resolve("resources") }
    })
    const first = f.launch(),
      client = await f.connect(first)
    const { conversationId } = await client.call("create", {
      nonce: "bot",
      name: "Engineer",
      workspacePath: workspace
    })
    const [runId] = (
      await client.call("send", { nonce: "task", conversationId, text: "Inspect the project" })
    ).runIds
    const local = await createTestLocalProjectAccess({
      workspace,
      runId,
      readProject: true,
      commands: ["node first.cjs", "node last.cjs"]
    })
    const projectSnapshot = (connection: BotTransportClient) =>
      local.snapshot({
        snapshot: () => connection.call("snapshot"),
        resolve: (input) => connection.call("resolveLocalToolPermission", input)
      })
    const pendingHook = (items: Awaited<ReturnType<typeof projectSnapshot>>["interactions"]) =>
      items.find((i) => i.runId === runId && i.status === "pending" && !i.localProjectAccess)
    await until(async () => Boolean(pendingHook((await projectSnapshot(client)).interactions)))
    const approval = pendingHook((await projectSnapshot(client)).interactions)!
    expect(JSON.parse(approval.prompt).hook.event).toBe("Setup")
    await client.call("answer", { id: approval.id, revision: approval.revision, answer: "approve" })
    await until(async () =>
      (await projectSnapshot(client)).interactions.some(
        (i) =>
          i.runId === runId &&
          i.status === "pending" &&
          !i.localProjectAccess &&
          i.id !== approval.id
      )
    )
    const lastBeforeCrash = pendingHook((await projectSnapshot(client)).interactions)!
    expect(JSON.parse(lastBeforeCrash.prompt).hook.command).toBe("node last.cjs")
    expect(await client.call("effects", runId)).toMatchObject([{ status: "succeeded" }])
    expect((await client.call("runHistory", { conversationId, runId })).run.status).toBe(
      "waiting_input"
    )
    expect(await readFile(join(workspace, "setup.log"), "utf8")).toBe("first\n")
    expect(f.requests).toEqual([])
    // First Setup has a committed result. Last Setup still requires its original
    // action approval; it has not executed at this crash point.
    await f.stop(first, "SIGKILL")
    const next = await f.connect(f.launch())
    await until(
      async () =>
        (await next.call("runHistory", { conversationId, runId })).run.status === "needs_review",
      40000
    )
    const interrupted = (await next.call("runHistory", { conversationId, runId })).run
    await next.call("recover", {
      id: runId,
      revision: interrupted.revision,
      decision: "resume",
      note: "First initialization step verified",
      effects: []
    })
    await until(async () => Boolean(pendingHook((await projectSnapshot(next)).interactions)))
    const remaining = pendingHook((await projectSnapshot(next)).interactions)!
    expect(JSON.parse(remaining.prompt).hook.command).toBe("node last.cjs")
    await next.call("answer", { id: remaining.id, revision: remaining.revision, answer: "approve" })
    await until(async () => {
      await projectSnapshot(next)
      return (await next.call("runHistory", { conversationId, runId })).run.status === "succeeded"
    })
    expect(await readFile(join(workspace, "setup.log"), "utf8")).toBe("first\nlast\n")
    expect(f.requests).toHaveLength(1)
    const peer = await next.call("create", {
      nonce: "second-bot",
      name: "Second engineer",
      workspacePath: workspace
    })
    const [secondRun] = (
      await next.call("send", {
        nonce: "second-task",
        conversationId: peer.conversationId,
        text: "Use the initialized project"
      })
    ).runIds
    const peerLocal = await createTestLocalProjectAccess({
      workspace,
      runId: secondRun,
      readProject: true,
      commands: []
    })
    await until(async () => {
      await peerLocal.snapshot({
        snapshot: () => next.call("snapshot"),
        resolve: (input) => next.call("resolveLocalToolPermission", input)
      })
      return (
        (await next.call("runHistory", { conversationId: peer.conversationId, runId: secondRun }))
          .run.status === "succeeded"
      )
    })
    expect(await readFile(join(workspace, "setup.log"), "utf8")).toBe("first\nlast\n")
    expect(f.requests).toHaveLength(2)
  },
  65000
)

processTest(
  "preserves the managed shared workspace across actual Host restarts and reads it from another Bot",
  async () => {
    const f = await fixture((body) => {
      const prompt = body.messages[0]?.content
      if (typeof prompt === "string" && prompt.startsWith("Return exactly this marker"))
        return { content: prompt.match(/[a-f0-9-]{36}/)?.[0] ?? "invalid marker" }
      return body.messages.some((message) => message.role === "tool")
        ? { content: "SHARED_PROCESS_VERIFIED" }
        : {
            tool_calls: [
              {
                id: "shared-read",
                type: "function",
                function: {
                  name: "project_read",
                  arguments: JSON.stringify({ path: "notes.md" })
                }
              }
            ]
          }
    })
    const first = f.launch(),
      client = await f.connect(first)
    const status = await client.call("status")
    expect(status.capabilities).toContain("shared-workspace")
    expect(status.capabilities).toContain("model-checks")
    expect(
      await client.call("checkModel", { nonce: randomUUID(), modelRef: null, kind: "text" })
    ).toMatchObject({ status: "passed", model: "gpt-test" })
    const workspace = status.sharedWorkspace!
    const a = await client.call("create", { nonce: "shared-a", name: "Writer" })
    expect(a.bot.workspacePath).toBe(workspace)
    await writeFile(join(workspace, "notes.md"), "SHARED_PROCESS_FILE")
    client.close()
    await f.stop(first)
    const restarted = await f.connect(f.launch())
    expect((await restarted.call("status")).sharedWorkspace).toBe(workspace)
    const b = await restarted.call("create", { nonce: "shared-b", name: "Reader" })
    expect(b.bot.workspacePath).toBe(workspace)
    const { runIds } = await restarted.call("send", {
      nonce: "shared-read",
      conversationId: b.conversationId,
      text: "Read notes.md"
    })
    await until(async () =>
      (await restarted.call("messages", { conversationId: b.conversationId })).some(
        (message) => message.runId === runIds[0] && message.sender === "bot"
      )
    )
    expect(
      (await restarted.call("messages", { conversationId: b.conversationId })).at(-1)?.text
    ).toBe("SHARED_PROCESS_VERIFIED")
    expect(JSON.stringify(f.requests.at(-1)?.messages)).toContain("SHARED_PROCESS_FILE")
    expect(await readFile(join(workspace, "notes.md"), "utf8")).toBe("SHARED_PROCESS_FILE")
  },
  30_000
)

processTest.each(["old", "identity"])(
  "finishes shared workspace replacement interrupted by SIGKILL at %s before the compiled Host opens",
  async (step) => {
    const f = await fixture((body) =>
      body.messages.some((message) => message.role === "tool")
        ? { content: "RESTORED_WORKSPACE_READ" }
        : {
            tool_calls: [
              {
                id: "read-restored",
                type: "function",
                function: { name: "project_read", arguments: JSON.stringify({ path: "notes.md" }) }
              }
            ]
          }
    )
    const first = f.launch(),
      client = await f.connect(first)
    const created = await client.call("create", {
      nonce: "workspace-owner",
      name: "Workspace owner"
    })
    const workspace = (await client.call("status")).sharedWorkspace!
    await f.stop(first)
    client.close()
    const path = join(workspace, "notes.md")
    await writeFile(path, "CHECKPOINT_WORK_FILES")
    const saved = (
      await executeBotWorkspaceMaintenance(f.directory, { action: "create", nonce: randomUUID() })
    ).checkpoint!
    await writeFile(path, "later-work-files")
    const request = {
      action: "restore",
      nonce: randomUUID(),
      checkpoint: { id: saved.id, sha256: saved.sha256 }
    }
    const helper = join(f.directory, "kill-workspace-maintenance.cjs")
    await build({
      stdin: {
        contents: `import {executeBotWorkspaceMaintenance} from ${JSON.stringify(resolve("src/main/bots/workspace-maintenance.ts"))};
        void executeBotWorkspaceMaintenance(process.argv[2],JSON.parse(process.argv[3]),step=>{if(step===process.argv[4])process.kill(process.pid,'SIGKILL')}).catch(error=>{console.error(error);process.exitCode=1});`,
        loader: "ts",
        resolveDir: process.cwd()
      },
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: helper,
      logLevel: "silent"
    })
    const killed = spawn(
      process.env.CMB_BOT_NODE ?? process.execPath,
      [helper, f.directory, JSON.stringify(request), step],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "ignore", "pipe"]
      }
    )
    let diagnostics = ""
    killed.stderr.on("data", (bytes) => {
      diagnostics += String(bytes)
    })
    const deadline = setTimeout(() => killed.kill("SIGKILL"), 15_000)
    try {
      expect(await once(killed, "close"), diagnostics).toEqual([null, "SIGKILL"])
    } finally {
      clearTimeout(deadline)
    }
    const nextProcess = f.launch(),
      next = await f.connect(nextProcess)
    expect((await next.call("snapshot")).bots.map((bot) => bot.id)).toEqual([created.bot.id])
    expect((await next.call("status")).sharedWorkspace).toBe(workspace)
    expect(await readFile(path, "utf8")).toBe("CHECKPOINT_WORK_FILES")
    expect(
      await readFile(join(workspace, "..", `recovery-${request.nonce}/old/notes.md`), "utf8")
    ).toBe("later-work-files")
    expect(
      (await listBotWorkspaceCheckpoints(f.directory)).map((item) => item.reason).sort()
    ).toEqual(["before-restore", "manual"])
    await expect(
      readFile(join(f.directory, "workspace-maintenance/pending.json"))
    ).rejects.toMatchObject({ code: "ENOENT" })
    await next.call("send", {
      nonce: "read-restored",
      conversationId: created.conversationId,
      text: "Read notes.md"
    })
    await until(async () =>
      (await next.call("messages", { conversationId: created.conversationId })).some(
        (message) => message.text === "RESTORED_WORKSPACE_READ"
      )
    )
    expect(JSON.stringify(f.requests.at(-1)?.messages)).toContain("CHECKPOINT_WORK_FILES")
    await f.stop(nextProcess)
    next.close()
    // The actual desktop worker entry also reconciles the completed request,
    // without replacing work done after recovery.
    await writeFile(path, "newer-user-edit")
    const worker = spawn(
      process.env.CMB_BOT_NODE ?? process.execPath,
      [resolve("out/main/bot-workspace-maintenance.js"), "--data-dir", f.directory],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["pipe", "pipe", "pipe"]
      }
    )
    let output = ""
    worker.stdout.on("data", (chunk) => {
      output += String(chunk)
    })
    worker.stderr.resume()
    worker.stdin.end(JSON.stringify(request))
    expect(await once(worker, "close")).toEqual([0, null])
    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      result: { action: "restore", recoveryCopy: request.nonce }
    })
    expect(await readFile(path, "utf8")).toBe("newer-user-edit")
  },
  40_000
)

it
  .skipIf(process.env.CMB_BOT_PROCESS_TEST !== "1" || process.platform !== "darwin")
  .each(["interrupted", "known-result"] as const)(
  "retains escaped Mac daemon evidence and blocks recovery despite group closure (mode=%s)",
  async (mode) => {
    const faultScene: { shouldPreserve?: () => Promise<boolean> } = {}
    const workspace = await mkdtemp(join(tmpdir(), "cmb-bot-daemon-"))
    cleanup.push(async () => {
      await writeFile(join(workspace, "escaped-stop"), "stop").catch(() => {})
      await delay(100)
      const before = await readFile(join(workspace, "escaped-ticks")).catch(() => Buffer.alloc(0))
      await delay(100)
      expect(await readFile(join(workspace, "escaped-ticks")).catch(() => Buffer.alloc(0))).toEqual(
        before
      )
      if (!(await faultScene.shouldPreserve?.()))
        await rm(workspace, { recursive: true, force: true })
    })
    const program = join(workspace, "escape-probe"),
      source = `${program}.c`
    const code =
      "const fs=require('node:fs');fs.writeFileSync('escaped-identity',String(process.pid));setInterval(()=>{if(fs.existsSync('escaped-stop'))process.exit(0);fs.appendFileSync('escaped-ticks','x')},30);setTimeout(()=>process.exit(0),60000)"
    await writeFile(
      source,
      `#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
extern char **environ;
int main(int argc,char **argv){
 if(argc!=3)return 2;
 // The shipped executable is Electron; this fixed probe explicitly runs its Node mode.
 setenv("ELECTRON_RUN_AS_NODE","1",1);
 posix_spawnattr_t a;if(posix_spawnattr_init(&a))return 3;
 posix_spawnattr_setflags(&a,POSIX_SPAWN_SETPGROUP);posix_spawnattr_setpgroup(&a,0);
 char *args[]={argv[1],"-e",${JSON.stringify(code)},NULL};pid_t child;
 int result=posix_spawn(&child,argv[1],NULL,&a,args,environ);posix_spawnattr_destroy(&a);
 if(result)return result;
 printf("escaped-group=%d original-group=%d\\n",getpgid(child),getpgrp());fflush(stdout);
 sleep(atoi(argv[2]));return 0;
}`
    )
    await promisify(execFile)("/usr/bin/clang", ["-O1", source, "-o", program], { timeout: 10_000 })
    const node = process.env.CMB_BOT_NODE ?? process.execPath
    const command = `./escape-probe '${node.replaceAll("'", "'\\''")}' ${mode === "known-result" ? 0 : 60}`
    const f = await fixture(
      (body) =>
        body.messages.some((message) => message.role === "tool")
          ? { content: "KNOWN_COMMAND_RESULT" }
          : {
              content: null,
              tool_calls: [
                {
                  id: "escape-probe",
                  type: "function",
                  function: {
                    name: "execute",
                    arguments: JSON.stringify({
                      command,
                      timeout_seconds: 60
                    })
                  }
                }
              ]
            },
      false,
      { trustedMacOwnedShell: true }
    )
    faultScene.shouldPreserve = f.shouldPreserveScene
    const snapshot = await readBotModelSnapshot(join(f.directory, "models.private"))
    snapshot.execution = { windowsSandbox: "none", resourceDirectory: resolve("resources") }
    await writeBotModelSnapshot(join(f.directory, "models.private"), snapshot)
    const original = f.launch(),
      client = await f.connect(original)
    const { conversationId } = await client.call("create", {
      nonce: "create",
      name: "命令闭合核验",
      workspacePath: workspace
    })
    const sent = await client.call("send", { nonce: "send", conversationId, text: "运行隔离验证" })
    const local = await createTestLocalProjectAccess({
      workspace,
      runId: sent.runIds[0],
      readProject: true,
      commands: [command]
    })
    const projectSnapshot = () =>
      local.snapshot({
        snapshot: () => client.call("snapshot"),
        resolve: (input) => client.call("resolveLocalToolPermission", input)
      })
    await until(async () =>
      (await projectSnapshot()).interactions.some(
        (i) => i.runId === sent.runIds[0] && i.status === "pending" && !i.localProjectAccess
      )
    )
    const approval = (await projectSnapshot()).interactions.find(
      (i) => i.runId === sent.runIds[0] && i.status === "pending" && !i.localProjectAccess
    )!
    expect(JSON.parse(approval.prompt).shell.command).toBe(command)
    await client.call("answer", { id: approval.id, revision: approval.revision, answer: "approve" })
    await until(
      async () =>
        (await readFile(join(workspace, "escaped-ticks")).catch(() => Buffer.alloc(0))).length > 0
    )
    if (mode === "known-result") {
      await until(
        async () =>
          (await client.call("runHistory", { conversationId, runId: sent.runIds[0] })).run
            .status === "succeeded"
      )
      expect(
        (await client.call("runHistory", { conversationId, runId: sent.runIds[0] })).run.result
      ).toBe("KNOWN_COMMAND_RESULT")
    }
    const modelCalls = f.requests.length,
      resourceRoot = join(await realpath(f.directory), "shell-resources")
    await f.stop(original, "SIGKILL")
    client.close()
    await until(async () => {
      try {
        return (
          JSON.parse(await readFile(join(resourceRoot, "operation-0", "closure.json"), "utf8"))
            .scope === "controlled-inherited-group"
        )
      } catch {
        return false
      }
    })
    const before = await readFile(join(workspace, "escaped-ticks"))
    await delay(150)
    expect((await readFile(join(workspace, "escaped-ticks"))).length).toBeGreaterThan(before.length)
    const retained = await inspectOwnedShellReceipts(resourceRoot)
    expect(retained).toHaveLength(1)
    expect(retained[0]).toMatchObject({
      runAuthorized: true,
      containment: "controlled-inherited-group"
    })
    expect(retained[0].phase).not.toBe("resource-closed")
    expect((await inspectDesktopBotShellResources(f.directory)).review).toMatchObject({
      state: "requires_review",
      reason: "physical-closure-unproven"
    })
    const restarting = f.launch(),
      closed = once(restarting, "exit"),
      [codeResult] = await closed
    expect(codeResult).not.toBe(0)
    expect(f.logs.get(restarting)).toContain("有命令尚未确认停止")
    expect(await inspectOwnedShellReceipts(resourceRoot)).toEqual(retained)
    expect(f.requests).toHaveLength(modelCalls)
  },
  40_000
)
