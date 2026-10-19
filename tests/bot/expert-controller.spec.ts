import assert from "node:assert/strict"
import test from "node:test"
import type {
  BotResult,
  CreateBotRequest,
  CreateGroupRequest
} from "../../src/shared/bot/contracts.generated"
import type { PartnerLocalConfig } from "../../src/main/services/bot/partner-local-config"
import { PartnerDevController } from "../../src/main/services/bot/partner-dev-controller"
import { PartnerLocalClient } from "../../src/main/services/bot/partner-local-client"
import { descriptor } from "./partner-local-fixture"
import { inputFixture } from "./requirement-execution-fixture"

class Client extends PartnerLocalClient {
  input = inputFixture()
  adopted = false
  loseActivation = false
  rejectGetBot = false
  canManage = true
  calls: Array<{ kind: string; command?: string }> = []
  constructor() {
    super(descriptor())
  }
  override async verifyIdentity() {}
  override async getBot() {
    if (this.rejectGetBot) throw Error("FORBIDDEN")
    return structuredClone({ bot: this.input.bot, botVersion: this.input.botVersion })
  }
  override async getGroup() {
    return structuredClone(this.input.group)
  }
  override async createBot(body: CreateBotRequest): Promise<BotResult> {
    assert.equal(body.config.memoryPolicy, "explicit_only")
    this.input.botVersion.config = body.config
    this.calls.push({ kind: "bot", command: body.commandId })
    return this.getBot()
  }
  override async createGroup(body: CreateGroupRequest) {
    this.calls.push({ kind: "group", command: body.commandId })
    return this.getGroup()
  }
  override async activateExpertMemory() {
    this.calls.push({ kind: "activate" })
    this.adopted = true
    if (this.loseActivation) {
      this.loseActivation = false
      throw Error("lost")
    }
  }
  override async expertMemoryAdoption() {
    return { adopted: this.adopted, botName: this.input.bot.name, canManage: this.canManage }
  }
  override async observe() {
    this.calls.push({ kind: "observe" })
  }
  grant: Awaited<ReturnType<PartnerLocalClient["currentAuthorization"]>> = null
  override async currentAuthorization() {
    return this.grant
  }
  override async authorizationVersion() {
    return 0
  }
  override async authorize() {
    this.calls.push({ kind: "authorize" })
    this.grant = {
      spaceId: "A",
      groupId: this.input.group.id,
      nodeId: "node",
      ownerPrincipalId: "owner",
      workspaceRef: "view",
      version: (this.grant?.version ?? 0) + 1,
      enabled: true,
      expiresAt: new Date(Date.now() + 86400000).toISOString()
    }
    return this.grant.version
  }
  override async poll() {
    return []
  }
}
async function fixture() {
  let stored: PartnerLocalConfig | null = null,
    executors = 0,
    directories = 0
  const client = new Client()
  const controller = new PartnerDevController({
    store: {
      async load() {
        return structuredClone(stored)
      },
      async save(value) {
        stored = structuredClone(value)
      }
    },
    clientFactory: () => client,
    expertData: async () => {
      directories++
      return { path: "/default/expert", runtimePath: "/default/expert/runtime", async sync() {} }
    },
    createExecutor: () => {
      executors++
      return {
        async execute() {
          throw Error("no task")
        },
        cancel() {
          return false
        }
      }
    }
  })
  await controller.importDescriptor(descriptor())
  await controller.connect()
  return { controller, client, stored: () => stored!, counts: () => ({ executors, directories }) }
}
test("create expert prepares default directory and memory, but never grants, enables or executes", async () => {
  const f = await fixture()
  try {
    const status = await f.controller.createExpert("Expert", "Methods")
    assert.equal(status.workspacePath, "/default/expert/runtime")
    assert.equal(status.expertDataPath, "/default/expert")
    assert.equal(status.expertMemoryAdopted, true)
    assert.equal(status.nodeEnabled, false)
    assert.deepEqual(
      f.client.calls.map((c) => c.kind),
      ["bot", "group", "activate"]
    )
    assert.equal(f.counts().executors, 0)
    const started = await f.controller.startExpert()
    assert.equal(started.nodeEnabled, true)
    assert.equal(f.counts().executors, 1)
    assert.deepEqual(
      f.client.calls.slice(3).map((c) => c.kind),
      ["observe", "authorize", "observe"]
    )
  } finally {
    await f.controller.shutdown()
  }
})
test("lost activation reply repeats original create commands and never generates a second expert", async () => {
  const f = await fixture()
  try {
    f.client.loseActivation = true
    await assert.rejects(f.controller.createExpert("Expert", "Methods"))
    const pending = structuredClone(f.stored().pending)
    await assert.rejects(f.controller.createExpert("Different", "Methods"), /INPUT_CHANGED/)
    assert.deepEqual(f.stored().pending, pending)
    await f.controller.createExpert("Expert", "Methods")
    for (const kind of ["bot", "group"]) {
      const calls = f.client.calls.filter((c) => c.kind === kind)
      assert.equal(calls.length, 2)
      assert.equal(calls[0].command, calls[1].command)
    }
    assert.equal(f.stored().pending, null)
    assert.equal((await f.controller.getStatus()).nodeEnabled, false)
  } finally {
    await f.controller.shutdown()
  }
})
test("owner-selected workspace survives expert setup; changing service identity does not carry expert metadata", async () => {
  const f = await fixture()
  try {
    await f.controller.setWorkspace("/owner/selected")
    await f.controller.createExpert("Expert", "Methods")
    assert.equal(f.stored().workspacePath, "/owner/selected")
    await f.controller.importDescriptor({ ...descriptor(), spaceId: "B" })
    const status = await f.controller.getStatus()
    assert.equal(status.botId, null)
    assert.equal(status.expertDataPath, null)
    assert.equal(status.expertMemoryAdopted, false)
  } finally {
    await f.controller.shutdown()
  }
})
test("Group admin without expert maintenance can reconnect without calling maintainer-only getBot", async () => {
  const f = await fixture()
  try {
    await f.controller.createExpert("Expert", "Methods")
    await f.controller.disconnect()
    f.client.rejectGetBot = true
    f.client.canManage = false
    const status = await f.controller.connect()
    assert.equal(status.connected, true)
    assert.equal(status.canManageExpertMemory, false)
    assert.equal(status.expertMemoryAdopted, true)
    assert.equal((await f.controller.startExpert()).nodeEnabled, true)
  } finally {
    await f.controller.shutdown()
  }
})

test("repeated explicit start reuses current matching live authorization; expired/revoked grant requires new explicit grant", async () => {
  const f = await fixture()
  try {
    await f.controller.createExpert("专家", "职责")
    await f.controller.startExpert()
    const version = f.client.grant!.version
    await f.controller.stopNode()
    await f.controller.startExpert()
    assert.equal(f.client.grant!.version, version)
    assert.equal(f.client.calls.filter((c) => c.kind === "authorize").length, 1)
    f.client.grant!.enabled = false
    await f.controller.stopNode()
    await f.controller.startExpert()
    assert.equal(f.client.grant!.version, version + 1)
  } finally {
    await f.controller.shutdown()
  }
})
