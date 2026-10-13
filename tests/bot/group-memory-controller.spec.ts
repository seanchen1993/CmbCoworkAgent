import assert from "node:assert/strict"
import test from "node:test"
import type {
  BotResult,
  CreateBotRequest,
  CreateBotVersionRequest,
  CreateGroupRequest,
  Group,
  UpdateGroupMembersRequest
} from "../../src/shared/bot/contracts.generated"
import type {
  GroupMemoryList,
  GroupMemoryWrite,
  GroupMemoryUpdate,
  GroupMemoryReceipt
} from "../../src/shared/bot/group-memory"
import { PartnerDevController } from "../../src/main/services/bot/partner-dev-controller"
import { PartnerLocalClient } from "../../src/main/services/bot/partner-local-client"
import {
  parsePartnerLocalConfig,
  type PartnerLocalConfig
} from "../../src/main/services/bot/partner-local-config"
import { inputFixture } from "./requirement-execution-fixture"
import { descriptor } from "./partner-local-fixture"
import { memoryFixture } from "./group-memory-fixture"

class Client extends PartnerLocalClient {
  input = inputFixture()
  calls: Array<{ operation: string; command: string; input: unknown }> = []
  memories: GroupMemoryList["memories"] = []
  revision = 0
  loseVersion = false
  loseAdopt = false
  loseList = false
  createdPolicy = ""
  receipts = new Map<string, unknown>()
  versions = new Map([[this.input.botVersion.id, structuredClone(this.input.botVersion)]])
  constructor() {
    super(descriptor())
  }
  override async verifyIdentity() {}
  override async createBot(body: CreateBotRequest): Promise<BotResult> {
    this.createdPolicy = body.config.memoryPolicy
    this.input.botVersion.config = structuredClone(body.config)
    this.versions.set(this.input.botVersion.id, structuredClone(this.input.botVersion))
    return structuredClone({ bot: this.input.bot, botVersion: this.input.botVersion })
  }
  override async createGroup(_body: CreateGroupRequest): Promise<Group> {
    return structuredClone(this.input.group)
  }
  override async getGroup() {
    return structuredClone(this.input.group)
  }
  override async getBot() {
    return structuredClone({ bot: this.input.bot, botVersion: this.input.botVersion })
  }
  override async createBotVersion(_id: string, body: CreateBotVersionRequest): Promise<BotResult> {
    this.calls.push({ operation: "version", command: body.commandId, input: structuredClone(body) })
    let value = this.receipts.get(body.commandId) as BotResult | undefined
    if (!value) {
      assert.equal(body.expectedVersion, this.input.bot.version)
      this.input.bot.version++
      this.input.botVersion = {
        ...this.input.botVersion,
        id: "expert-v2",
        number: 2,
        config: structuredClone(body.config)
      }
      this.input.bot.currentBotVersionId = "expert-v2"
      value = structuredClone({ bot: this.input.bot, botVersion: this.input.botVersion })
      this.receipts.set(body.commandId, value)
      this.versions.set("expert-v2", structuredClone(this.input.botVersion))
    }
    if (this.loseVersion) {
      this.loseVersion = false
      throw Error("response lost")
    }
    return structuredClone(value)
  }
  override async updateGroupMembers(_id: string, body: UpdateGroupMembersRequest): Promise<Group> {
    this.calls.push({ operation: "adopt", command: body.commandId, input: structuredClone(body) })
    let value = this.receipts.get(body.commandId) as Group | undefined
    if (!value) {
      assert.equal(body.expectedVersion, this.input.group.version)
      this.input.group = {
        ...this.input.group,
        version: this.input.group.version + 1,
        bots: structuredClone(body.bots),
        members: structuredClone(body.members)
      }
      value = structuredClone(this.input.group)
      this.receipts.set(body.commandId, value)
    }
    if (this.loseAdopt) {
      this.loseAdopt = false
      throw Error("response lost")
    }
    return structuredClone(value)
  }
  override async listGroupMemories(): Promise<GroupMemoryList> {
    if (this.loseList) {
      this.loseList = false
      throw Error("refresh lost")
    }
    return structuredClone({
      revision: this.revision,
      memories: this.memories,
      canManage: true,
      botPolicies: this.input.group.bots
        .map((b) => ({
          ...b,
          memoryPolicy: this.versions.get(b.botVersionId)!.config.memoryPolicy
        }))
        .map(({ botId, botVersionId, memoryPolicy }) => ({ botId, botVersionId, memoryPolicy }))
    })
  }
  override async createGroupMemory(
    _g: string,
    input: GroupMemoryWrite,
    command: string
  ): Promise<GroupMemoryReceipt> {
    this.calls.push({ operation: "memory", command, input: structuredClone(input) })
    let receipt = this.receipts.get(command) as GroupMemoryReceipt | undefined
    if (!receipt) {
      const memory = memoryFixture({ text: input.text, source: input.source })
      this.memories.push(memory)
      receipt = { revision: ++this.revision, memory }
      this.receipts.set(command, structuredClone(receipt))
    }
    return structuredClone(receipt)
  }
  override async updateGroupMemory(
    _g: string,
    input: GroupMemoryUpdate,
    command: string
  ): Promise<GroupMemoryReceipt> {
    this.calls.push({ operation: "update", command, input: structuredClone(input) })
    const old = this.memories.find((m) => m.id === input.memoryId)!
    assert.equal(input.expectedVersion, old.version)
    Object.assign(old, {
      text: input.text,
      source: input.source,
      status: input.status,
      version: old.version + 1
    })
    return structuredClone({ revision: ++this.revision, memory: old })
  }
  override async disableGroupMemory(g: string, id: string, version: number, command: string) {
    const m = this.memories.find((m) => m.id === id)!
    return this.updateGroupMemory(
      g,
      {
        memoryId: id,
        expectedVersion: version,
        text: m.text,
        source: m.source,
        status: "disabled"
      },
      command
    )
  }
}
async function setup(useMemory = false) {
  let saved: PartnerLocalConfig | null = null
  const client = new Client(),
    deps = {
      store: {
        async load() {
          return structuredClone(saved)
        },
        async save(c: PartnerLocalConfig) {
          parsePartnerLocalConfig(c)
          saved = structuredClone(c)
        }
      },
      clientFactory: () => client,
      createExecutor: () => {
        throw Error("no model permitted")
      }
    }
  const controller = new PartnerDevController(deps)
  await controller.importDescriptor(descriptor())
  await controller.connect()
  await controller.createTeam("专家", "稳定方法论", useMemory)
  return { controller, client, deps, saved: () => saved }
}
test("new teams opt into explicit memory only by human choice; old default stays disabled", async () => {
  for (const enabled of [false, true]) {
    const f = await setup(enabled)
    try {
      assert.equal(f.client.createdPolicy, enabled ? "explicit_only" : "disabled")
      assert.equal((await f.controller.getStatus()).nodeEnabled, false)
    } finally {
      await f.controller.disconnect()
    }
  }
})
for (const lost of ["loseVersion", "loseAdopt"] as const)
  test(`enable memory persists full original plan and replays ${lost} across App reopen`, async () => {
    const f = await setup()
    try {
      f.client[lost] = true
      await assert.rejects(f.controller.enableTeamMemory(), /DEPENDENCY_UNAVAILABLE/)
      assert.equal(f.saved()?.pending?.kind, "enableMemory")
      assert.equal(f.saved()?.pending?.plan?.botVersion, 1)
      assert.equal(f.saved()?.pending?.plan?.groupVersion, 1)
      const next = new PartnerDevController(f.deps)
      await next.connect()
      await next.enableTeamMemory()
      const calls = f.client.calls.filter(
        (c) => c.operation === (lost === "loseVersion" ? "version" : "adopt")
      )
      assert.equal(calls.length, 2)
      assert.deepEqual(calls[0], calls[1])
      assert.equal(f.client.input.bot.version, 2)
      assert.equal(f.client.input.group.version, 2)
      assert.equal(f.saved()?.botVersionId, "expert-v2")
      assert.equal(f.saved()?.pending, null)
      assert.equal((await next.listMemories()).botPolicies[0].memoryPolicy, "explicit_only")
      await next.disconnect()
    } finally {
      await f.controller.disconnect()
    }
  })
test("memory publication survives refresh failure without a duplicate write or revision", async () => {
  const f = await setup(true)
  try {
    const body = { text: "共同约定T+1", source: { kind: "manual" as const } }
    f.client.loseList = true
    await assert.rejects(f.controller.createMemory(body), /DEPENDENCY_UNAVAILABLE/)
    assert.ok(f.saved()?.pending)
    const next = new PartnerDevController(f.deps)
    await next.connect()
    await assert.rejects(next.createMemory({ ...body, text: "不同内容" }), /INPUT_CHANGED/)
    await next.createMemory(body)
    const calls = f.client.calls.filter((c) => c.operation === "memory")
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[0], calls[1])
    assert.equal(f.client.revision, 1)
    assert.equal(f.client.memories.length, 1)
    assert.equal(f.saved()?.pending, null)
    await next.disconnect()
  } finally {
    await f.controller.disconnect()
  }
})
test("editing and disabling use explicit entry versions; arbitrary fields fail before a write", async () => {
  const f = await setup(true)
  try {
    const value = await f.controller.createMemory({ text: "约定", source: { kind: "manual" } })
    const m = value.memories[0]
    await f.controller.updateMemory({
      memoryId: m.id,
      expectedVersion: m.version,
      text: "已核实约定",
      source: m.source,
      status: "active"
    })
    await f.controller.disableMemory(m.id, 2)
    assert.equal(f.client.memories[0].status, "disabled")
    assert.equal(f.client.memories[0].version, 3)
    const before = f.client.calls.length
    await assert.rejects(
      f.controller.createMemory({
        text: "bad",
        source: { kind: "manual" },
        spaceId: "B"
      } as GroupMemoryWrite),
      /INVALID_PAYLOAD/
    )
    await assert.rejects(
      f.controller.createMemory({
        text: "bad",
        source: { kind: "manual", url: "https://example.com" } as GroupMemoryWrite["source"]
      }),
      /INVALID_PAYLOAD/
    )
    assert.equal(f.client.calls.length, before)
  } finally {
    await f.controller.disconnect()
  }
})
test("enabling memory does not silently adopt a newer global expert configuration", async () => {
  const f = await setup()
  try {
    f.client.input.botVersion.id = "unadopted-v2"
    await assert.rejects(f.controller.enableTeamMemory(), /INPUT_CHANGED/)
    assert.equal(f.client.calls.length, 0)
    assert.equal(f.saved()?.pending, null)
  } finally {
    await f.controller.disconnect()
  }
})
