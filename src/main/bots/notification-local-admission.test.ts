import { afterEach, expect, it } from "vitest"
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createServer } from "node:http"
import { setTimeout as delay } from "node:timers/promises"
import { BotStore } from "./store"
import { BotArtifacts } from "./artifacts"
import { BotHost } from "./host"
import { BotHostLock } from "./host-lock"
import { createBotLocalToolAuthority } from "./local-tool-authority"
import { BotLocalToolGate } from "./local-tool-gate"
import { CmbBotRuntime } from "./agent-runtime"
import { LocalBotComputerProvider } from "./computer-provider"
import { writeBotModelSnapshot } from "./model-config"
import { createTrustedBotShellTestRunner } from "./shell-owned-test-fixture"
import { createTestLocalProjectAccess } from "./test-local-project-permission"
import type { BotRuntimeRequest } from "./host"
import type { BotLocalToolCard } from "../../shared/bot-local-tool-permission"

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10_000
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Notification admission did not settle")
    await delay(10)
  }
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-notification-local-")))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, "project"),
    hostDirectory = join(root, "host")
  await mkdir(workspace)
  await mkdir(hostDirectory)
  const lock = BotHostLock.acquire(hostDirectory)!
  cleanup.push(() => lock.release())
  const store = new BotStore(join(hostDirectory, "bots.sqlite"))
  cleanup.push(() => store.close())
  store.localTools.bind(createBotLocalToolAuthority(hostDirectory, lock))
  const owner = store.createBot({
    nonce: "bot",
    name: "Notifier",
    workspacePath: workspace
  })
  const {
    runIds: [runId]
  } = store.send({
    nonce: "task",
    conversationId: owner.conversationId,
    text: "check"
  })
  const claimed = store.claim("fixture")!
  const controller = new AbortController()
  const request: BotRuntimeRequest = {
    ...claimed,
    store,
    bot: owner.bot,
    messages: [],
    signal: controller.signal,
    assertOwnership: () => lock.assertCurrent()
  }
  const gate = BotLocalToolGate.open(request)!
  const action = { original: "check" }
  const primary = store.requestInteraction(claimed.lease, {
    kind: "approval",
    prompt: "check",
    action
  })
  const access = await createTestLocalProjectAccess({
    workspace,
    runId,
    readProject: true,
    commands: ["node notify.cjs"]
  })
  const snapshot = () =>
    access.snapshot({
      snapshot: async () => store.snapshot(),
      resolve: async (answer) => store.localTools.resolve(answer)
    })
  return { root, workspace, store, gate, primary, action, request, snapshot }
}

it("binds project read and command admission to a registered notification without consuming its action approval", async () => {
  const f = await fixture()
  await f.store.hookNotifications.run(
    f.request.lease,
    { key: "check", interactionId: f.primary.id, action: f.action },
    async (invocation) => {
      const id = "hook:notification",
        action = {
          hook: {
            event: "Notification",
            invocation,
            command: "node notify.cjs"
          }
        }
      f.store.hookNotifications.registerAction(f.request.lease, id, action)
      let admission: Awaited<ReturnType<BotLocalToolGate["mutation"]>>,
        settled = false,
        failure: unknown
      const waiting = f.gate.mutation(id, action).then(
        (value) => {
          admission = value
          settled = true
        },
        (error: unknown) => {
          failure = error
          settled = true
        }
      )
      await until(async () => {
        await f.snapshot()
        return settled
      })
      await waiting
      if (failure) throw failure
      const approvals = f.store.db.exec(
        "SELECT notification_stage FROM bot_interactions WHERE run_id=? AND notification_stage IS NOT NULL",
        [f.request.run.id]
      )[0].values
      expect(approvals).toHaveLength(2)
      expect(new Set(approvals.map((row) => row[0])).size).toBe(1)
      expect(f.store.getInteraction(f.primary.id).status).toBe("pending")
      expect(f.store.effects(f.request.run.id)).toEqual([])
      const hook = f.store.requestInteraction(f.request.lease, {
        kind: "approval",
        prompt: "notify",
        action
      })
      expect(() => admission!.bindEffect(f.primary.id)).toThrow(/审批/)
      f.store.answerInteraction({
        id: hook.id,
        revision: hook.revision,
        answer: "approve"
      })
      admission!.bindEffect(hook.id)
      f.store.beginEffect(f.request.lease, { id, action, approvalId: hook.id })
      f.store.settleEffect(f.request.lease, id, "succeeded", "notified")
    }
  )
  expect(f.store.getInteraction(f.primary.id).status).toBe("pending")
  expect(f.store.getRun(f.request.run.id).status).toBe("waiting_input")
})

it("rejects different commands, projects, ordinary approvals and effects using a local card", async () => {
  const f = await fixture()
  await f.store.hookNotifications.run(
    f.request.lease,
    { key: "check", interactionId: f.primary.id, action: f.action },
    async (invocation) => {
      const id = "hook:notification",
        action = {
          hook: {
            event: "Notification",
            invocation,
            command: "node notify.cjs"
          }
        }
      f.store.hookNotifications.registerAction(f.request.lease, id, action)
      await expect(f.gate.mutation("ordinary", action)).rejects.toThrow(/已绑定/)
      const policy = f.store.localTools.read()
      const card: BotLocalToolCard = {
        version: 1,
        target: policy.target,
        dataEpoch: policy.dataEpoch,
        policyRevision: policy.revision,
        action: {
          kind: "run-command",
          workspace: f.workspace,
          target: "node notify.cjs",
          description: "notify",
          fingerprint: "a".repeat(64)
        }
      }
      expect(() =>
        f.store.hookNotifications.registerLocalApproval(f.request.lease, "outside", card)
      ).toThrow(/其他/)
      await f.store.hookNotifications.withLocalAdmission(
        f.request.lease,
        id,
        action,
        f.workspace,
        async () => {
          expect(() =>
            f.store.hookNotifications.registerLocalApproval(f.request.lease, "wrong-command", {
              ...card,
              action: { ...card.action, target: "node other.cjs" }
            })
          ).toThrow(/其他/)
          expect(() =>
            f.store.hookNotifications.registerLocalApproval(f.request.lease, "wrong-project", {
              ...card,
              action: { ...card.action, workspace: join(f.root, "other") }
            })
          ).toThrow(/其他/)
          f.store.hookNotifications.registerLocalApproval(f.request.lease, "exact", card)
          expect(() =>
            f.store.requestInteraction(f.request.lease, {
              kind: "approval",
              prompt: "ordinary",
              action: f.action
            })
          ).toThrow(/只能申请/)
          const local = f.store.requestInteraction(f.request.lease, {
            kind: "approval",
            prompt: "local",
            action: { localProjectAccess: card }
          })
          f.store.answerInteraction({
            id: local.id,
            revision: local.revision,
            answer: "approve"
          })
          expect(() =>
            f.store.beginEffect(f.request.lease, {
              id,
              action,
              approvalId: local.id
            })
          ).toThrow(/未经有效批准|不能用于其他/)
        }
      )
    }
  )
  expect(f.store.effects(f.request.run.id)).toEqual([])
})

it("revokes the exact local-admission context before inherited asynchronous callbacks run", async () => {
  const f = await fixture()
  let release!: () => void, late!: Promise<void>
  const ready = new Promise<void>((done) => {
    release = done
  })
  await f.store.hookNotifications.run(
    f.request.lease,
    { key: "check", interactionId: f.primary.id, action: f.action },
    async (invocation) => {
      const id = "hook:notification",
        action = {
          hook: {
            event: "Notification",
            invocation,
            command: "node notify.cjs"
          }
        }
      f.store.hookNotifications.registerAction(f.request.lease, id, action)
      await f.store.hookNotifications.withLocalAdmission(
        f.request.lease,
        id,
        action,
        f.workspace,
        async () => {
          const policy = f.store.localTools.read()
          const card: BotLocalToolCard = {
            version: 1,
            target: policy.target,
            dataEpoch: policy.dataEpoch,
            policyRevision: policy.revision,
            action: {
              kind: "run-command",
              workspace: f.workspace,
              target: "node notify.cjs",
              description: "notify",
              fingerprint: "a".repeat(64)
            }
          }
          late = ready.then(() =>
            f.store.hookNotifications.registerLocalApproval(f.request.lease, "late", card)
          )
        }
      )
      const rejected = expect(late).rejects.toThrow(/其他/)
      release()
      await rejected
    }
  )
})

it.each(["primary-first", "notification-first"] as const)(
  "preserves both approvals in a real ask-mode Runtime graph (%s)",
  async (order) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-notification-graph-local-")))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const hostDirectory = join(root, "host"),
      workspace = join(root, "project"),
      settings = join(workspace, "settings")
    await mkdir(hostDirectory)
    await mkdir(settings, { recursive: true })
    await writeFile(
      join(settings, "hooks.json"),
      JSON.stringify([
        {
          id: "notify",
          enabled: true,
          event: "Notification",
          matcher: "permission_prompt",
          command: "node notify.cjs"
        }
      ])
    )
    await writeFile(
      join(settings, "notify.cjs"),
      "process.stdin.resume();process.stdin.on('end',()=>{require('fs').appendFileSync(require('path').join(process.env.WORKSPACE_PATH,'notifications'),'n');console.log('{}')})"
    )
    await writeFile(
      join(workspace, "task.cjs"),
      "require('fs').appendFileSync('task-effects','x');console.log('done')"
    )
    const requests: unknown[] = []
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        messages: { role: string }[]
      }
      requests.push(body)
      const done = body.messages.at(-1)?.role === "tool"
      res.setHeader("Content-Type", "text/event-stream")
      res.end(
        `data: ${JSON.stringify({ id: `response-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta: done ? { role: "assistant", content: "CHECK_COMPLETE" } : { role: "assistant", tool_calls: [{ index: 0, id: "task-command", type: "function", function: { name: "execute", arguments: JSON.stringify({ command: "node task.cjs", timeout_seconds: 30 }) } }] }, finish_reason: done ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`
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
    const modelFile = join(hostDirectory, "models.private")
    await writeBotModelSnapshot(modelFile, {
      version: 1,
      defaultRef: "test",
      models: [
        {
          ref: "test",
          id: "test",
          name: "Test",
          model: "gpt-test",
          apiKey: "test-only",
          baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
        }
      ],
      hookSources: { root: settings },
      execution: {
        windowsSandbox: "none",
        resourceDirectory: resolve("resources")
      }
    })
    const lock = BotHostLock.acquire(hostDirectory)!
    cleanup.push(() => lock.release())
    const store = new BotStore(join(hostDirectory, "bots.sqlite"))
    cleanup.push(() => store.close())
    store.localTools.bind(createBotLocalToolAuthority(hostDirectory, lock))
    expect(store.localTools.read().effective).toBe("ask")
    const { bot, conversationId } = store.createBot({
      nonce: "bot",
      name: "Notifier",
      workspacePath: workspace
    })
    const {
      runIds: [runId]
    } = store.send({ nonce: "task", conversationId, text: "check" })
    const access = await createTestLocalProjectAccess({
      workspace,
      runId,
      readProject: true,
      commands: ["node task.cjs", "node notify.cjs"]
    })
    const computer = new LocalBotComputerProvider(join(root, "browser"))
    cleanup.push(() => computer.shutdown())
    const files = new BotArtifacts(join(root, "objects"), store)
    cleanup.push(() => files.close())
    const runtime = new CmbBotRuntime(modelFile, computer, {
      files,
      shell: await createTrustedBotShellTestRunner(cleanup)
    })
    const host = new BotHost(store, runtime)
    cleanup.push(() => host.stop())
    host.start()
    const snapshot = () =>
      access.snapshot({
        snapshot: async () => store.snapshot(),
        resolve: async (answer) => store.localTools.resolve(answer)
      })
    await until(async () => {
      await snapshot()
      const run = store.getRun(runId)
      if (["failed", "needs_review", "succeeded"].includes(run.status))
        throw new Error(JSON.stringify({ run, requests }))
      return (
        store
          .snapshot()
          .interactions.filter((item) => item.status === "pending" && !item.localProjectAccess)
          .length === 2
      )
    })
    const approvals = store.snapshot().interactions.filter((item) => !item.localProjectAccess)
    const notification = approvals.find(
      (item) => JSON.parse(item.prompt).hook?.event === "Notification"
    )!
    const primary = approvals.find((item) => item.id !== notification.id)!
    expect(store.effects(runId)).toEqual([])
    const first = order === "primary-first" ? primary : notification,
      last = order === "primary-first" ? notification : primary
    store.answerInteraction({
      id: first.id,
      revision: first.revision,
      answer: "approve"
    })
    if (order === "notification-first")
      await until(() => store.effects(runId).some((item) => item.status === "succeeded"))
    expect(store.getInteraction(last.id).status).toBe("pending")
    await expect(readFile(join(workspace, "task-effects"))).rejects.toMatchObject({
      code: "ENOENT"
    })
    store.answerInteraction({
      id: last.id,
      revision: last.revision,
      answer: "approve"
    })
    await until(() => ["succeeded", "failed", "needs_review"].includes(store.getRun(runId).status))
    expect(store.getRun(runId)).toMatchObject({
      status: "succeeded",
      result: "CHECK_COMPLETE"
    })
    expect(await readFile(join(workspace, "task-effects"), "utf8")).toBe("x")
    expect(await readFile(join(workspace, "notifications"), "utf8")).toBe("n")
    expect(store.effects(runId)).toHaveLength(2)
    expect(requests).toHaveLength(2)
    expect(store.localTools.read().effective).toBe("ask")
    expect(store.getBot(bot.id).id).toBe(bot.id)
  },
  20_000
)
