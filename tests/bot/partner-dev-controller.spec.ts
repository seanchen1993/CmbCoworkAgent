import assert from "node:assert/strict"
import test from "node:test"
import type {
  BotResult,
  CreateBotRequest,
  CreateGroupRequest,
  Group,
  Task
} from "../../src/shared/bot/contracts.generated"
import { PartnerDevController } from "../../src/main/services/bot/partner-dev-controller"
import { PartnerLocalClient } from "../../src/main/services/bot/partner-local-client"
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
