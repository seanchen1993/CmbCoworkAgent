import { createHash, randomUUID } from "node:crypto"
import { isAbsolute, normalize } from "node:path"
import type {
  PartnerDevMessageReply,
  PartnerDevRunView,
  PartnerDevStatus
} from "../../../shared/bot/partner-dev"
import { parseGroupTaskIntent } from "./group-task-intent"
import {
  PartnerLocalClient,
  PartnerLocalFault,
  parsePartnerDescriptor,
  partnerId,
  type PartnerConnectionDescriptor
} from "./partner-local-client"
import {
  parsePartnerLocalConfig,
  parseMemoryEnablePlan,
  type PartnerLocalConfig,
  type PartnerMemoryEnablePlan
} from "./partner-local-config"
import { PartnerLocalWorker, type PartnerWorkerExecutor } from "./partner-local-worker"
import type {
  GroupMemoryList,
  GroupMemoryWrite,
  GroupMemoryUpdate
} from "../../../shared/bot/group-memory"
import { memorySource, memoryText, memoryVersion } from "./group-memory-validation"
import { partnerObject } from "./partner-local-boundary"

export interface PartnerConfigPersistence {
  load(): Promise<PartnerLocalConfig | null>
  save(config: PartnerLocalConfig): Promise<void>
}
export class PartnerDevController {
  private config: PartnerLocalConfig | null = null
  private loaded = false
  private queue: Promise<unknown> = Promise.resolve()
  private client?: PartnerLocalClient
  private worker?: PartnerLocalWorker
  private error: string | null = null
  constructor(
    private readonly deps: {
      store: PartnerConfigPersistence
      createExecutor: (
        config: PartnerLocalConfig,
        client: PartnerLocalClient
      ) => PartnerWorkerExecutor
      clientFactory?: (d: PartnerConnectionDescriptor) => PartnerLocalClient
    }
  ) {}
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const action = this.queue.then(
      async () => {
        await this.load()
        try {
          return await fn()
        } catch (error) {
          this.error = error instanceof PartnerLocalFault ? error.code : "DEPENDENCY_UNAVAILABLE"
          throw new PartnerLocalFault(this.error)
        }
      },
      async () => {
        await this.load()
        return fn()
      }
    )
    this.queue = action.catch(() => undefined)
    return action
  }
  private async load(): Promise<void> {
    if (!this.loaded) {
      const config = await this.deps.store.load()
      this.config = config ? parsePartnerLocalConfig(config) : null
      this.loaded = true
    }
  }
  private requireConfig(): PartnerLocalConfig {
    if (!this.config) throw new PartnerLocalFault("NOT_CONFIGURED")
    return this.config
  }
  private requireClient(): PartnerLocalClient {
    if (!this.client) throw new PartnerLocalFault("NODE_OFFLINE")
    return this.client
  }
  private team(): { config: PartnerLocalConfig; groupId: string; botId: string } {
    const config = this.requireConfig()
    if (!config.groupId || !config.botId) throw new PartnerLocalFault("NOT_CONFIGURED")
    return { config, groupId: config.groupId, botId: config.botId }
  }
  private async persist(): Promise<void> {
    await this.deps.store.save(structuredClone(this.requireConfig()))
  }
  private view(): PartnerDevStatus {
    const c = this.config,
      d = c?.descriptor
    return {
      configured: !!c,
      connected:
        !!this.client && !["DEPENDENCY_UNAVAILABLE", "UNAUTHENTICATED"].includes(this.error ?? ""),
      nodeEnabled: this.worker?.isEnabled() ?? false,
      model: "simulated",
      url: d?.url ?? null,
      spaceId: d?.spaceId ?? null,
      nodeId: d?.nodeId ?? null,
      ownerPrincipalId: d?.ownerPrincipalId ?? null,
      businessPrincipalId: d?.businessPrincipalId ?? null,
      workspacePath: c?.workspacePath ?? null,
      groupId: c?.groupId ?? null,
      botId: c?.botId ?? null,
      lastError: this.error,
      activeRunId: this.worker?.activeRunId() ?? null,
      lastRunId: c?.lastRunId ?? null,
      lastTaskNumber: c?.lastTaskNumber ?? null
    }
  }
  getStatus(): Promise<PartnerDevStatus> {
    return this.exclusive(async () => this.view())
  }
  hasActiveRun(): boolean {
    return !!this.worker?.activeRunId()
  }
  async shutdown(): Promise<void> {
    await this.disconnect()
  }
  private async close(): Promise<void> {
    await this.worker?.stop()
    this.worker = undefined
    this.client?.close()
    this.client = undefined
  }
  importDescriptor(value: unknown): Promise<PartnerDevStatus> {
    return this.exclusive(async () => {
      const descriptor = parsePartnerDescriptor(value)
      await this.close()
      const old = this.config,
        same =
          old &&
          ["spaceId", "nodeId", "ownerPrincipalId", "businessPrincipalId", "workspaceRef"].every(
            (k) => old.descriptor[k] === descriptor[k]
          )
      this.config = same
        ? { ...old, descriptor }
        : {
            descriptor,
            workspacePath: null,
            groupId: null,
            botId: null,
            botVersionId: null,
            pending: null,
            lastRunId: null,
            lastTaskNumber: null
          }
      await this.persist()
      this.error = null
      return this.view()
    })
  }
  setWorkspace(path: string): Promise<PartnerDevStatus> {
    return this.exclusive(async () => {
      if (
        typeof path !== "string" ||
        path.length > 4096 ||
        path.includes("\0") ||
        !isAbsolute(path) ||
        normalize(path) !== path
      )
        throw new PartnerLocalFault("INVALID_PAYLOAD")
      await this.worker?.stop()
      this.worker = undefined
      this.requireConfig().workspacePath = path
      await this.persist()
      this.error = null
      return this.view()
    })
  }
  connect(): Promise<PartnerDevStatus> {
    return this.exclusive(async () => {
      await this.close()
      const candidate = (this.deps.clientFactory ?? ((d) => new PartnerLocalClient(d)))(
        this.requireConfig().descriptor
      )
      try {
        await candidate.verifyIdentity()
        this.client = candidate
        this.error = null
        return this.view()
      } catch (error) {
        candidate.close()
        throw error
      }
    })
  }
  disconnect(): Promise<PartnerDevStatus> {
    return this.exclusive(async () => {
      await this.close()
      this.error = null
      return this.view()
    })
  }
  enableNode(): Promise<PartnerDevStatus> {
    return this.exclusive(async () => {
      const c = this.requireConfig(),
        client = this.requireClient()
      if (!c.workspacePath) throw new PartnerLocalFault("NOT_CONFIGURED")
      await this.worker?.stop()
      const worker = new PartnerLocalWorker({
        client,
        executor: this.deps.createExecutor(structuredClone(c), client),
        onChange: (v) => {
          if (this.worker === worker && v.error) this.error = v.error
        }
      })
      this.worker = worker
      await worker.start()
      this.error = null
      return this.view()
    })
  }
  stopNode(): Promise<PartnerDevStatus> {
    return this.exclusive(async () => {
      await this.worker?.stop()
      this.error = null
      return this.view()
    })
  }
  /** Persist one human mutation receipt before sending it. Lost responses only
   * retry the exact same input/command/deadline; no blind fresh command replay. */
  private async mutation<T>(
    kind: string,
    input: unknown,
    action: (command: string, deadline: string) => Promise<T>,
    apply?: (value: T) => void,
    plan?: PartnerMemoryEnablePlan
  ): Promise<T> {
    const c = this.requireConfig(),
      fingerprint =
        "sha256:" +
        createHash("sha256")
          .update(JSON.stringify([kind, input]))
          .digest("hex")
    if (c.pending && (c.pending.kind !== kind || c.pending.fingerprint !== fingerprint))
      throw new PartnerLocalFault("INPUT_CHANGED")
    if (!c.pending)
      c.pending = {
        kind,
        fingerprint,
        commandId: randomUUID(),
        deadline: new Date(Date.now() + 600000).toISOString(),
        ...(plan ? { plan: structuredClone(plan) } : {})
      }
    await this.persist() // Retry also requires a durable receipt before any write.
    const value = await action(c.pending.commandId, c.pending.deadline)
    apply?.(value)
    c.pending = null
    await this.persist()
    this.error = null
    return value
  }
  createTeam(name: string, instructions: string, useMemory = false): Promise<PartnerDevStatus> {
    return this.exclusive(async () => {
      if (
        typeof name !== "string" ||
        !name.trim() ||
        name.length > 256 ||
        typeof instructions !== "string" ||
        !instructions.trim() ||
        instructions.length > 16384 ||
        typeof useMemory !== "boolean"
      )
        throw new PartnerLocalFault("INVALID_PAYLOAD")
      const c = this.requireConfig(),
        client = this.requireClient()
      if (c.groupId) throw new PartnerLocalFault("INPUT_CHANGED")
      await this.mutation(
        "createTeam",
        // Keep the original disabled-policy fingerprint for pending A7 commands.
        useMemory ? { name, instructions, useMemory } : { name, instructions },
        async (command) => {
          const { bot, botVersion } = await client.createBot({
            commandId: command + ":bot",
            name,
            maintainerIds: [c.descriptor.ownerPrincipalId],
            config: {
              description: name,
              instructions,
              persona: "严谨、简洁，明确未知与待确认事项",
              knowledgeRefs: [],
              repositoryRefs: [],
              skillAllowlist: [],
              capabilityCeiling: ["requirements.analyze"],
              memoryPolicy: useMemory ? "explicit_only" : "disabled"
            }
          })
          const group = await client.createGroup({
            commandId: command + ":group",
            name: (name + "协作团队").slice(0, 256),
            bots: [{ botId: bot.id, botVersionId: botVersion.id, role: "specialist" }],
            members: [
              { principalId: c.descriptor.ownerPrincipalId, role: "admin" },
              { principalId: c.descriptor.businessPrincipalId, role: "business_owner" }
            ],
            limits: { maxRuns: 2, maxHandoffs: 1, maxTokens: 10000 }
          })
          return { bot, botVersion, group }
        },
        (v) => {
          c.groupId = v.group.id
          c.botId = v.bot.id
          c.botVersionId = v.botVersion.id
        }
      )
      return this.view()
    })
  }
  bindTeam(groupId: string): Promise<PartnerDevStatus> {
    return this.exclusive(async () => {
      const c = this.requireConfig()
      if (c.pending) throw new PartnerLocalFault("INPUT_CHANGED")
      const group = await this.requireClient().getGroup(partnerId(groupId))
      if (
        group.spaceId !== c.descriptor.spaceId ||
        group.bots.length !== 1 ||
        !group.members.some(
          (m) => m.principalId === c.descriptor.ownerPrincipalId && m.role === "admin"
        ) ||
        !group.members.some((m) => m.principalId === c.descriptor.businessPrincipalId)
      )
        throw new PartnerLocalFault("FORBIDDEN")
      c.groupId = group.id
      c.botId = group.bots[0].botId
      c.botVersionId = group.bots[0].botVersionId
      c.lastRunId = null
      c.lastTaskNumber = null
      await this.persist()
      return this.view()
    })
  }
  authorizeTeam(): Promise<PartnerDevStatus> {
    return this.exclusive(async () => {
      const { groupId, config } = this.team()
      if (!config.workspacePath) throw new PartnerLocalFault("NOT_CONFIGURED")
      const client = this.requireClient()
      // Explicit owner authorization also registers the authenticated local
      // node's fixed profile once. This does not enable polling or execution.
      await client.observe()
      const version = await client.authorizationVersion(groupId)
      await client.authorize(groupId, version)
      this.error = null
      return this.view()
    })
  }
  revokeTeam(): Promise<PartnerDevStatus> {
    return this.exclusive(async () => {
      const { groupId } = this.team(),
        client = this.requireClient(),
        version = await client.authorizationVersion(groupId)
      await client.revoke(groupId, version)
      await this.worker?.stop()
      this.error = null
      return this.view()
    })
  }
  listMemories(): Promise<GroupMemoryList> {
    return this.exclusive(() => this.requireClient().listGroupMemories(this.team().groupId))
  }
  createMemory(input: GroupMemoryWrite): Promise<GroupMemoryList> {
    return this.exclusive(async () => {
      const v = partnerObject(input, ["text", "source"])
      const { groupId } = this.team(),
        client = this.requireClient()
      const body = { text: memoryText(v.text), source: memorySource(v.source) }
      return this.mutation("createMemory", { groupId, ...body }, async (command) => {
        await client.createGroupMemory(groupId, body, command)
        // A failed refresh keeps the original command, avoiding duplicate publication.
        return client.listGroupMemories(groupId)
      })
    })
  }
  updateMemory(input: GroupMemoryUpdate): Promise<GroupMemoryList> {
    return this.exclusive(async () => {
      const v = partnerObject(input, ["memoryId", "expectedVersion", "text", "source", "status"])
      if (v.status !== "active" && v.status !== "disabled")
        throw new PartnerLocalFault("INVALID_PAYLOAD")
      const { groupId } = this.team(),
        client = this.requireClient()
      const body: GroupMemoryUpdate = {
        memoryId: partnerId(v.memoryId),
        expectedVersion: memoryVersion(v.expectedVersion),
        text: memoryText(v.text),
        source: memorySource(v.source),
        status: v.status
      }
      return this.mutation("updateMemory", { groupId, ...body }, async (command) => {
        await client.updateGroupMemory(groupId, body, command)
        return client.listGroupMemories(groupId)
      })
    })
  }
  disableMemory(memoryId: string, expectedVersion: number): Promise<GroupMemoryList> {
    return this.exclusive(async () => {
      const { groupId } = this.team(),
        client = this.requireClient()
      const body = {
        groupId,
        memoryId: partnerId(memoryId),
        expectedVersion: memoryVersion(expectedVersion)
      }
      return this.mutation("disableMemory", body, async (command) => {
        await client.disableGroupMemory(groupId, body.memoryId, body.expectedVersion, command)
        return client.listGroupMemories(groupId)
      })
    })
  }
  enableTeamMemory(): Promise<PartnerDevStatus> {
    return this.exclusive(async () => {
      const { groupId, botId, config: c } = this.team(),
        client = this.requireClient()
      let plan: PartnerMemoryEnablePlan
      if (c.pending) {
        if (c.pending.kind !== "enableMemory") throw new PartnerLocalFault("INPUT_CHANGED")
        plan = parseMemoryEnablePlan(c.pending.plan)
      } else {
        const group = await client.getGroup(groupId),
          { bot, botVersion } = await client.getBot(botId)
        if (
          group.bots.length !== 1 ||
          group.bots[0].botId !== botId ||
          group.bots[0].botVersionId !== c.botVersionId ||
          botVersion.id !== c.botVersionId
        )
          throw new PartnerLocalFault("INPUT_CHANGED")
        if (botVersion.config.memoryPolicy === "explicit_only") {
          this.error = null
          return this.view()
        }
        plan = parseMemoryEnablePlan({
          botId,
          groupId,
          botVersion: bot.version,
          groupVersion: group.version,
          config: { ...botVersion.config, memoryPolicy: "explicit_only" },
          bots: group.bots,
          members: group.members
        })
      }
      await this.worker?.stop()
      await this.mutation(
        "enableMemory",
        plan,
        async (command) => {
          const version = await client.createBotVersion(botId, {
            commandId: command + ":version",
            expectedVersion: plan.botVersion,
            config: plan.config
          })
          await client.updateGroupMembers(groupId, {
            commandId: command + ":adopt",
            expectedVersion: plan.groupVersion,
            bots: plan.bots.map((b) => ({ ...b, botVersionId: version.botVersion.id })),
            members: plan.members
          })
          const current = await client.getGroup(groupId)
          if (current.bots.length !== 1 || current.bots[0].botVersionId !== version.botVersion.id)
            throw new PartnerLocalFault("INPUT_CHANGED")
          return version.botVersion.id
        },
        (id) => {
          c.botVersionId = id
        },
        plan
      )
      return this.view()
    })
  }
  sendMessage(mentioned: boolean, text: string): Promise<PartnerDevMessageReply> {
    return this.exclusive(async () => {
      if (typeof mentioned !== "boolean" || typeof text !== "string")
        throw new PartnerLocalFault("INVALID_PAYLOAD")
      const intent = parseGroupTaskIntent({ mentioned, text })
      if (intent.kind === "ignore")
        return { kind: "ignored", notice: "没有结构化 @，伙伴未读取或保存这条群消息。" }
      if (intent.kind === "clarify")
        return {
          kind: "clarify",
          notice: "请使用：新任务：需求内容；或 TASK-编号：澄清内容。仅支持有界文本。"
        }
      const { groupId } = this.team(),
        client = this.requireClient()
      if (intent.kind === "create_task") {
        const task = await this.mutation(
          "createTask",
          { groupId, content: intent.content },
          (command) => client.createTask(groupId, intent.content, command),
          (task) => {
            this.requireConfig().lastTaskNumber = task.taskNumber
          }
        )
        return {
          kind: "task",
          notice: "任务已创建。可按任务编号补充澄清，然后点击“分析需求”。",
          taskId: task.id,
          taskNumber: task.taskNumber,
          taskVersion: task.version
        }
      }
      // Keep the original expectedVersion across a lost response, not a re-read's
      // newly incremented version. The mutation fingerprint excludes that snapshot.
      const task = await client.lookupTask(groupId, intent.taskNumber)
      const pending = this.requireConfig().pending
      const baseVersion = pending?.kind.startsWith("message:")
        ? Number(pending.kind.slice(8))
        : task.version
      const result = await this.mutation(
        "message:" + baseVersion,
        { groupId, taskNumber: intent.taskNumber, content: intent.content },
        (command) =>
          client.createMessage({ ...task, version: baseVersion }, intent.content, command),
        () => {
          this.requireConfig().lastTaskNumber = task.taskNumber
        }
      )
      return {
        kind: "task",
        notice: "澄清已保存；分析只使用本任务材料，不包含整群消息。",
        taskId: task.id,
        taskNumber: task.taskNumber,
        taskVersion: result.taskVersion
      }
    })
  }
  analyzeTask(taskNumber: string): Promise<PartnerDevMessageReply> {
    return this.exclusive(async () => {
      if (typeof taskNumber !== "string") throw new PartnerLocalFault("INVALID_PAYLOAD")
      const intent = parseGroupTaskIntent({ mentioned: true, text: taskNumber + " 分析" })
      if (intent.kind !== "continue_task") throw new PartnerLocalFault("INVALID_PAYLOAD")
      const { groupId, botId } = this.team(),
        client = this.requireClient(),
        task = await client.lookupTask(groupId, intent.taskNumber)
      const result = await this.mutation(
        "enqueue",
        { taskId: task.id, botId, version: task.version },
        (command, deadline) => client.enqueue(task, botId, command, deadline),
        (v) => {
          const c = this.requireConfig()
          c.lastRunId = v.runId
          c.lastTaskNumber = task.taskNumber
        }
      )
      return {
        kind: "task",
        notice: this.worker?.isEnabled()
          ? "已交给指定负责人节点，等待模拟结果。"
          : "任务已排队，等待负责人在 App 启用本地节点。",
        taskId: task.id,
        taskNumber: task.taskNumber,
        taskVersion: task.version,
        runId: result.runId,
        runStatus: result.status
      }
    })
  }
  private async runView(runId: string): Promise<PartnerDevRunView> {
    const value = await this.requireClient().inspect(partnerId(runId))
    if (value.result?.runId !== runId && value.result !== null)
      throw new PartnerLocalFault("INVALID_PAYLOAD")
    const { groupId } = this.team()
    if (value.run.groupId !== groupId) throw new PartnerLocalFault("FORBIDDEN")
    let memorySnapshot: PartnerDevRunView["memorySnapshot"]
    if (!["queued", "waiting_node", "starting", "cancelled"].includes(String(value.run.status))) {
      try {
        memorySnapshot = await this.requireClient().inspectMemorySnapshot(runId, groupId)
      } catch (error) {
        if (!(error instanceof PartnerLocalFault) || error.code !== "NOT_FOUND") throw error
        // Pre-start and pre-V6 history must not be mislabeled as memory disabled.
      }
    }
    return {
      runId,
      status: String(value.run.status),
      version: Number(value.run.version),
      memorySnapshot,
      result: value.result
        ? {
            outcome: value.result.outcome,
            text: value.result.text,
            settledAt: value.result.settledAt
          }
        : null
    }
  }
  inspectRun(runId: string): Promise<PartnerDevRunView> {
    return this.exclusive(() => this.runView(runId))
  }
  cancelPending(runId: string, version: number): Promise<PartnerDevRunView> {
    return this.exclusive(async () => {
      if (!Number.isSafeInteger(version) || version < 1)
        throw new PartnerLocalFault("INVALID_PAYLOAD")
      await this.requireClient().cancelPending(partnerId(runId), version)
      return this.runView(runId)
    })
  }
}
