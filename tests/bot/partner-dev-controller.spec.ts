import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import type {
  BotResult,
  CreateBotRequest,
  CreateGroupRequest,
  Group,
  Task
} from "../../src/shared/bot/contracts.generated"
import { PartnerDevController } from "../../src/main/services/bot/partner-dev-controller"
import {
  PartnerLocalClient,
  PartnerLocalFault
} from "../../src/main/services/bot/partner-local-client"
import type { PartnerLocalConfig } from "../../src/main/services/bot/partner-local-config"
import { descriptor } from "./partner-local-fixture"
import { inputFixture } from "./requirement-execution-fixture"

class Client extends PartnerLocalClient {
  readonly input = inputFixture()
  readonly writes: Array<{ kind: string; command: string; version?: number; deadline?: string }> =
    []
  loseMessage = false
  loseEnqueue = false
  private readonly receipts = new Map<string, unknown>()
  constructor() {
    super(descriptor())
  }
  override async verifyIdentity() {}
  override async observe() {}
  override async createBot(body: CreateBotRequest): Promise<BotResult> {
    this.writes.push({ kind: "bot", command: body.commandId })
    return { bot: this.input.bot, botVersion: this.input.botVersion }
  }
  override async createGroup(body: CreateGroupRequest): Promise<Group> {
    this.writes.push({ kind: "group", command: body.commandId })
    return this.input.group
  }
  override async getGroup() {
    return this.input.group
  }
  override async createTask(_group: string, _content: string, command: string): Promise<Task> {
    this.writes.push({ kind: "task", command })
    return structuredClone(this.input.task)
  }
  override async lookupTask() {
    return structuredClone(this.input.task)
  }
  override async createMessage(task: Task, text: string, command: string) {
    this.writes.push({ kind: "message", command, version: task.version })
    let result = this.receipts.get(command) as
      | Awaited<ReturnType<PartnerLocalClient["createMessage"]>>
      | undefined
    if (!result) {
      assert.equal(task.version, this.input.task.version)
      this.input.task.version++
      result = {
        message: {
          id: "message",
          spaceId: "A",
          taskId: task.id,
          authorPrincipalId: "business",
          text,
          artifactVersions: [],
          createdAt: new Date().toISOString()
        },
        taskVersion: this.input.task.version
      }
      this.receipts.set(command, result)
    }
    if (this.loseMessage) {
      this.loseMessage = false
      throw Error("lost receipt")
    }
    return result
  }
  override async enqueue(task: Task, _bot: string, command: string, deadline: string) {
    this.writes.push({ kind: "enqueue", command, version: task.version, deadline })
    if (this.loseEnqueue) {
      this.loseEnqueue = false
      throw Error("lost receipt")
    }
    return { runId: "run", status: "waiting_node" }
  }
  override async authorizationVersion() {
    return 7
  }
  override async authorize(_group: string, version: number) {
    assert.equal(version, 7)
    return 8
  }
}
async function setup() {
  let stored: PartnerLocalConfig | null = null,
    executors = 0
  const client = new Client(),
    store = {
      async load() {
        return structuredClone(stored)
      },
      async save(c: PartnerLocalConfig) {
        stored = structuredClone(c)
      }
    },
    deps = {
      store,
      clientFactory: () => client,
      createExecutor: () => {
        executors++
        throw Error("unexpected execution")
      }
    },
    controller = new PartnerDevController(deps)
  await controller.importDescriptor(descriptor())
  await controller.setWorkspace("/explicit-owner-workspace")
  await controller.connect()
  await controller.createTeam("领域专家", "固定领域指令")
  return { controller, client, store, deps, stored: () => stored, executors: () => executors }
}
test("a pending disabled A7 team creation reuses its old fingerprint and commands after upgrade", async () => {
  const f = await setup()
  await f.controller.disconnect()
  const input = { name: "领域专家", instructions: "固定领域指令" }
  const config = f.stored()!
  config.groupId = config.botId = config.botVersionId = null
  config.pending = {
    kind: "createTeam",
    fingerprint:
      "sha256:" +
      createHash("sha256")
        .update(JSON.stringify(["createTeam", input]))
        .digest("hex"),
    commandId: "old-a7-team",
    deadline: new Date(Date.now() + 60000).toISOString()
  }
  await f.store.save(config)
  const reopened = new PartnerDevController(f.deps)
  try {
    await reopened.connect()
    await assert.rejects(reopened.createTeam(input.name, input.instructions, true), /INPUT_CHANGED/)
    await reopened.createTeam(input.name, input.instructions, false)
    assert.deepEqual(f.client.writes.slice(-2), [
      { kind: "bot", command: "old-a7-team:bot" },
      { kind: "group", command: "old-a7-team:group" }
    ])
    assert.equal(f.stored()?.pending, null)
  } finally {
    await reopened.disconnect()
  }
})
test("explicit owner configuration is redacted and reload never connects or borrows a Thread", async () => {
  const f = await setup()
  try {
    const status = await f.controller.getStatus()
    assert.equal(status.model, "simulated")
    assert.equal(status.groupId, "group")
    assert.equal(status.nodeEnabled, false)
    for (const secret of [
      descriptor().ownerToken,
      descriptor().businessToken,
      descriptor().nodeToken
    ])
      assert.ok(!JSON.stringify(status).includes(secret))
    const next = new PartnerDevController(f.deps),
      restored = await next.getStatus()
    assert.equal(restored.connected, false)
    assert.equal(restored.nodeEnabled, false)
    assert.equal(restored.workspacePath, "/explicit-owner-workspace")
    assert.equal(f.executors(), 0)
    assert.equal(f.client.writes.length, 2)
    await f.controller.authorizeTeam()
  } finally {
    await f.controller.disconnect()
  }
})
test("only structured mention with explicit new task/TASK writes, and analysis is a separate deliberate step", async () => {
  const f = await setup()
  try {
    const before = f.client.writes.length
    assert.equal((await f.controller.sendMessage(false, "新任务：ignore")).kind, "ignored")
    assert.equal((await f.controller.sendMessage(true, "普通群消息")).kind, "clarify")
    assert.equal(f.client.writes.length, before)
    const task = await f.controller.sendMessage(true, "新任务：查询交易")
    assert.equal(task.taskNumber, "TASK-1")
    assert.ok(!f.client.writes.some((w) => w.kind === "enqueue"))
    const message = await f.controller.sendMessage(true, "TASK-1：仅查本人权限")
    assert.equal(message.taskVersion, 2)
    const analysis = await f.controller.analyzeTask("TASK-1")
    assert.equal(analysis.runStatus, "waiting_node")
    assert.ok(analysis.notice.includes("等待负责人"))
    const restored = new PartnerDevController(f.deps)
    assert.equal((await restored.getStatus()).lastRunId, "run")
    assert.equal((await restored.getStatus()).lastTaskNumber, "TASK-1")
  } finally {
    await f.controller.disconnect()
  }
})
test("lost message receipt preserves original expected version and original command across controller reopen", async () => {
  const f = await setup()
  try {
    f.client.loseMessage = true
    await assert.rejects(
      f.controller.sendMessage(true, "TASK-1：范围补充"),
      /DEPENDENCY_UNAVAILABLE/
    )
    assert.ok(f.stored()?.pending)
    const next = new PartnerDevController(f.deps)
    await next.connect()
    await assert.rejects(next.sendMessage(true, "TASK-1：不同内容"), /INPUT_CHANGED/)
    await next.sendMessage(true, "TASK-1：范围补充")
    const writes = f.client.writes.filter((w) => w.kind === "message")
    assert.equal(writes.length, 2)
    assert.deepEqual(writes[0], writes[1])
    assert.equal(f.client.input.task.version, 2)
    assert.equal(f.stored()?.pending, null)
    await next.disconnect()
  } finally {
    await f.controller.disconnect()
  }
})
test("lost enqueue receipt preserves exact command/deadline and does not create another Run", async () => {
  const f = await setup()
  try {
    f.client.loseEnqueue = true
    await assert.rejects(f.controller.analyzeTask("TASK-1"))
    await f.controller.analyzeTask("TASK-1")
    const writes = f.client.writes.filter((w) => w.kind === "enqueue")
    assert.equal(writes.length, 2)
    assert.deepEqual(writes[0], writes[1])
    assert.equal(f.stored()?.lastRunId, "run")
  } finally {
    await f.controller.disconnect()
  }
})
test("storage failure prevents any new external write", async () => {
  const f = await setup()
  try {
    const count = f.client.writes.length
    f.store.save = async () => {
      throw Error("disk")
    }
    await assert.rejects(f.controller.sendMessage(true, "新任务：不得写入"))
    assert.equal(f.client.writes.length, count)
    await assert.rejects(f.controller.sendMessage(true, "新任务：不得写入"))
    assert.equal(f.client.writes.length, count)
  } finally {
    await f.controller.disconnect()
  }
})

test("local defaults connect once on page load without enabling a node or granting a team", async () => {
  let saved: PartnerLocalConfig | null = null,
    saves = 0,
    identities = 0,
    reads = 0,
    executors = 0
  const client = new Client()
  client.verifyIdentity = async () => {
    identities++
  }
  const controller = new PartnerDevController({
    store: {
      async load() {
        return saved
      },
      async save(c) {
        saves++
        saved = structuredClone(c)
      }
    },
    defaultDescriptor: async () => {
      reads++
      return descriptor()
    },
    clientFactory: () => client,
    createExecutor: () => {
      executors++
      throw Error("must not run")
    }
  })
  try {
    const [status, duplicate] = await Promise.all([controller.getStatus(), controller.getStatus()])
    assert.equal(status.connectionMode, "local-default")
    assert.equal(status.connected, true)
    assert.equal(status.configured, true)
    assert.equal(status.nodeEnabled, false)
    assert.equal(status.workspacePath, null)
    assert.equal(status.groupId, null)
    assert.deepEqual(status, duplicate)
    assert.deepEqual([saves, identities, reads, executors, client.writes.length], [1, 1, 1, 0, 0])
    for (const token of [
      descriptor().ownerToken,
      descriptor().businessToken,
      descriptor().nodeToken
    ])
      assert(!JSON.stringify(status).includes(token))
    await controller.shutdown()
    assert.equal((await controller.getStatus()).connected, false)
    assert.equal(identities, 1) // Shutdown/disconnect is not silently undone.
  } finally {
    await controller.shutdown()
  }
})
test("default connection replaces a changed local port but retains workspace, team and receipts", async () => {
  const f = await setup()
  await f.controller.disconnect()
  const before = structuredClone(f.stored()!)
  const controller = new PartnerDevController({
    ...f.deps,
    defaultDescriptor: async () => descriptor(32124)
  })
  try {
    const status = await controller.getStatus()
    assert.equal(status.connected, true)
    assert.equal(status.url, "http://127.0.0.1:32124")
    assert.equal(status.nodeEnabled, false)
    assert.deepEqual(f.stored(), { ...before, descriptor: descriptor(32124) })
    assert.equal(f.executors(), 0)
    assert.equal(f.client.writes.length, 2)
  } finally {
    await controller.shutdown()
  }
})
test("failed default authentication retries status without repeated saves or automatic work", async () => {
  let saved: PartnerLocalConfig | null = null,
    attempts = 0,
    saves = 0
  const client = new Client()
  client.verifyIdentity = async () => {
    if (++attempts === 1) throw new PartnerLocalFault("UNAUTHENTICATED")
  }
  const controller = new PartnerDevController({
    store: {
      async load() {
        return saved
      },
      async save(c) {
        saves++
        saved = structuredClone(c)
      }
    },
    defaultDescriptor: async () => descriptor(),
    clientFactory: () => client,
    createExecutor: () => {
      throw Error("must not run")
    }
  })
  try {
    const failed = await controller.getStatus()
    assert.equal(failed.connectionMode, "local-default")
    assert.equal(failed.connected, false)
    assert.equal(failed.lastError, "UNAUTHENTICATED")
    const ready = await controller.getStatus()
    assert.equal(ready.connected, true)
    assert.equal(ready.nodeEnabled, false)
    assert.equal(ready.lastError, null)
    assert.deepEqual([saves, attempts, client.writes.length], [1, 2, 0])
  } finally {
    await controller.shutdown()
  }
})
test("invalid or unreadable defaults never fall back to a cached identity or a remote address", async () => {
  for (const load of [
    async () => ({ ...descriptor(), url: "https://remote.example" }),
    async () => {
      throw new PartnerLocalFault("STORAGE_FAILURE")
    }
  ]) {
    let clients = 0,
      saves = 0
    const controller = new PartnerDevController({
      store: {
        async load() {
          return null
        },
        async save() {
          saves++
        }
      },
      defaultDescriptor: load,
      clientFactory: () => {
        clients++
        return new Client()
      },
      createExecutor: () => {
        throw Error("must not run")
      }
    })
    const status = await controller.getStatus()
    assert.equal(status.connected, false)
    assert.equal(status.nodeEnabled, false)
    assert.equal(status.connectionMode, "local-default")
    assert(["INVALID_PAYLOAD", "STORAGE_FAILURE"].includes(status.lastError!))
    assert.deepEqual([clients, saves], [0, 0])
  }
})
