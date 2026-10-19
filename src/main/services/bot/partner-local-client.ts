import type { TextDeliverySummary } from "../../../shared/bot/text-delivery"
import {
  parseDeliverySummary,
  parseDeliveryVersion,
  parseDeliveryReceipt,
  parseDeliveryDetail,
  parseDeliveryInput
} from "./text-delivery-validation"
import { request } from "node:http"
import Ajv from "ajv/dist/2020"
import addFormats from "ajv-formats"
import schemas from "../../../../contracts/bot/v1/schemas.json"
import states from "../../../../contracts/bot/v1/state-transitions.json"
import type {
  Bot,
  BotResult,
  CreateBotVersionRequest,
  CreateBotRequest,
  CreateGroupRequest,
  Group,
  Task,
  TaskMessageResult,
  UpdateGroupMembersRequest
} from "../../../shared/bot/contracts.generated"
import type {
  PartnerRequirementInput,
  PartnerRequirementResult,
  PartnerRequirementRun,
  RequirementOutcome
} from "./requirement-execution-types"
import { validatePartnerRun, samePartnerAttempt } from "./requirement-execution-types"
import { PartnerLocalFault, partnerId, partnerObject } from "./partner-local-boundary"
export { PartnerLocalFault, partnerId, partnerObject } from "./partner-local-boundary"
import type {
  GroupMemoryList,
  GroupMemoryWrite,
  GroupMemoryUpdate,
  GroupMemoryReceipt
} from "../../../shared/bot/group-memory"
import {
  memorySource,
  memoryText,
  memoryVersion,
  parseMemoryList,
  parseMemoryReceipt
} from "./group-memory-validation"
import type {
  ExpertMemoryList,
  ExpertMemoryReceipt,
  ExpertMemoryUpdate
} from "../../../shared/bot/expert-memory"
import { parseExpertInput, parseExpertReceipt } from "./expert-conversation-validation"
import type {
  ExpertConversationInput,
  ExpertTaskReceipt
} from "../../../shared/bot/expert-conversation"
import {
  parseExpertMemoryList,
  parseExpertMemoryReceipt,
  parseRunMemorySnapshot
} from "./expert-memory-validation"

export interface PartnerConnectionDescriptor {
  version: 1
  url: string
  spaceId: string
  nodeId: string
  ownerPrincipalId: string
  businessPrincipalId: string
  workspaceRef: string
  ownerToken: string
  businessToken: string
  nodeToken: string
}
export function partnerUrl(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    !/^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.test(value) ||
    Number(new URL(value).port) > 65535 ||
    !new URL(value).port
  )
    throw new PartnerLocalFault("INVALID_PAYLOAD")
  return value
}
export function parsePartnerDescriptor(value: unknown): PartnerConnectionDescriptor {
  const v = partnerObject(value, [
    "version",
    "url",
    "spaceId",
    "nodeId",
    "ownerPrincipalId",
    "businessPrincipalId",
    "workspaceRef",
    "ownerToken",
    "businessToken",
    "nodeToken"
  ])
  if (
    v.version !== 1 ||
    ![v.ownerToken, v.businessToken].every(
      (t) => typeof t === "string" && t.length === 64 && /^[a-f0-9]{64}$/.test(t)
    ) ||
    typeof v.nodeToken !== "string" ||
    v.nodeToken.length !== 69 ||
    !/^dcn1_[a-f0-9]{64}$/.test(v.nodeToken) ||
    v.ownerToken === v.businessToken ||
    v.ownerPrincipalId === v.businessPrincipalId
  )
    throw new PartnerLocalFault("INVALID_PAYLOAD")
  partnerUrl(v.url)
  for (const k of ["spaceId", "nodeId", "ownerPrincipalId", "businessPrincipalId", "workspaceRef"])
    partnerId(v[k])
  return Object.freeze({ ...v }) as unknown as PartnerConnectionDescriptor
}

const ajv = new Ajv({ strict: true, allErrors: false })
addFormats(ajv)
ajv.addFormat("binary", { type: "string", validate: () => true })
for (const keyword of [
  "x-state-transitions",
  "x-reconciliation",
  "x-mode-capabilities",
  "x-internal-lifecycles"
])
  ajv.addKeyword({ keyword, valid: true })
ajv.addSchema(states)
ajv.addSchema(schemas)
export function partnerSchema<T>(name: string, value: unknown): T {
  const check = ajv.getSchema(`${schemas.$id}#/$defs/${name}`)
  if (!check || !check(value)) throw new PartnerLocalFault("INVALID_PAYLOAD")
  return structuredClone(value) as T
}
const ERROR_CODES = new Set(Object.keys(schemas.$defs).length ? schemas.$defs.ErrorCode.enum : [])
type Json = Record<string, unknown>
export interface PartnerNodeAuthorization {
  spaceId: string
  groupId: string
  nodeId: string
  ownerPrincipalId: string
  workspaceRef: string
  version: number
  enabled: boolean
  expiresAt: string
}
export interface LocalRunView {
  run: Json
  result: PartnerRequirementResult | null
}

/** Node HTTP bypasses Chromium cookies/proxies. Destination is a literal
 * loopback address, no redirects or arbitrary renderer paths/headers. */
export class PartnerLocalClient {
  private readonly descriptor: PartnerConnectionDescriptor
  private readonly requests = new Set<import("node:http").ClientRequest>()
  private closed = false
  constructor(descriptor: PartnerConnectionDescriptor) {
    this.descriptor = parsePartnerDescriptor(descriptor)
  }
  close(): void {
    this.closed = true
    for (const req of this.requests) req.destroy(new PartnerLocalFault("DEPENDENCY_UNAVAILABLE"))
  }
  private call(
    path: string,
    role: "owner" | "business" | "node",
    method: "GET" | "POST" | "PUT",
    body?: unknown
  ): Promise<unknown> {
    if (this.closed || this.requests.size >= 8)
      return Promise.reject(new PartnerLocalFault("DEPENDENCY_UNAVAILABLE"))
    const d = this.descriptor,
      payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    if (payload && payload.length > 131072)
      return Promise.reject(new PartnerLocalFault("PAYLOAD_TOO_LARGE"))
    const token = role === "node" ? d.nodeToken : role === "owner" ? d.ownerToken : d.businessToken
    return new Promise((resolve, reject) => {
      let done = false
      const finish = (error?: PartnerLocalFault, value?: unknown) => {
        if (done) return
        done = true
        clearTimeout(timer)
        this.requests.delete(req)
        if (error) {
          req.destroy()
          reject(error)
        } else resolve(value)
      }
      const req = request(
        {
          hostname: "127.0.0.1",
          port: Number(new URL(d.url).port),
          method,
          path,
          agent: false,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(role !== "node" ? { "X-DevClaw-Space": d.spaceId } : {}),
            Accept: "application/json",
            ...(payload
              ? { "Content-Type": "application/json", "Content-Length": payload.length }
              : {})
          }
        },
        (response) => {
          if (
            !/^application\/json(?:;\s*charset=UTF-8)?$/i.test(
              String(response.headers["content-type"])
            ) ||
            response.headers["content-encoding"] ||
            response.headers.location ||
            response.headers["set-cookie"] ||
            Number(response.headers["content-length"] ?? 0) > 524288
          ) {
            finish(new PartnerLocalFault("DEPENDENCY_UNAVAILABLE"))
            return
          }
          let length = 0
          const chunks: Buffer[] = []
          response.on("data", (chunk: Buffer) => {
            length += chunk.length
            if (length > 524288) {
              response.destroy()
              finish(new PartnerLocalFault("PAYLOAD_TOO_LARGE"))
            } else chunks.push(chunk)
          })
          response.on("error", () => finish(new PartnerLocalFault("DEPENDENCY_UNAVAILABLE")))
          response.on("end", () => {
            try {
              const raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))
              // A local service must not echo any of the imported secrets, even encoded.
              for (const secret of [d.ownerToken, d.businessToken, d.nodeToken])
                if (
                  [secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64")].some(
                    (s) => raw.includes(s)
                  )
                )
                  throw new PartnerLocalFault("DEPENDENCY_UNAVAILABLE")
              const value = JSON.parse(raw)
              if (response.statusCode !== 200 && response.statusCode !== 201) {
                const code = value?.code ?? value?.error?.code
                throw new PartnerLocalFault(ERROR_CODES.has(code) ? code : "DEPENDENCY_UNAVAILABLE")
              }
              finish(undefined, value)
            } catch (error) {
              finish(
                error instanceof PartnerLocalFault
                  ? error
                  : new PartnerLocalFault("DEPENDENCY_UNAVAILABLE")
              )
            }
          })
        }
      )
      const timer = setTimeout(() => finish(new PartnerLocalFault("DEPENDENCY_UNAVAILABLE")), 5000)
      this.requests.add(req)
      req.on("error", () => finish(new PartnerLocalFault("DEPENDENCY_UNAVAILABLE")))
      req.end(payload)
    })
  }
  async verifyIdentity(): Promise<void> {
    const d = this.descriptor
    const node = partnerObject(await this.node("identity"), [
      "spaceId",
      "nodeId",
      "ownerPrincipalId"
    ])
    if (
      node.spaceId !== d.spaceId ||
      node.nodeId !== d.nodeId ||
      node.ownerPrincipalId !== d.ownerPrincipalId
    )
      throw new PartnerLocalFault("FORBIDDEN")
    for (const role of ["owner", "business"] as const) {
      const actor = partnerObject(await this.control(role, "identity"), ["spaceId", "principalId"])
      if (
        actor.spaceId !== d.spaceId ||
        actor.principalId !== (role === "owner" ? d.ownerPrincipalId : d.businessPrincipalId)
      )
        throw new PartnerLocalFault("FORBIDDEN")
    }
  }
  private node(operation: string, fields: Json = {}): Promise<unknown> {
    return this.call("/api/bot/local/v1/node", "node", "POST", { operation, ...fields })
  }
  private control(
    role: "owner" | "business",
    operation: string,
    fields: Json = {}
  ): Promise<unknown> {
    return this.call("/api/bot/local/v1/control", role, "POST", { operation, ...fields })
  }
  async observe(): Promise<void> {
    const v = partnerObject(await this.node("observe"), ["observed"])
    if (v.observed !== true) throw new PartnerLocalFault("INVALID_PAYLOAD")
  }
  async poll(): Promise<Array<{ id: string; status: string }>> {
    const v = partnerObject(await this.node("poll"), ["runs"])
    if (!Array.isArray(v.runs) || v.runs.length > 8) throw new PartnerLocalFault("INVALID_PAYLOAD")
    return v.runs.map((r) => {
      const d = this.descriptor
      if (
        !r ||
        !["queued", "waiting_node", "starting", "running"].includes(r.status) ||
        r.spaceId !== d.spaceId ||
        r.nodeId !== d.nodeId ||
        r.ownerPrincipalId !== d.ownerPrincipalId
      )
        throw new PartnerLocalFault("FORBIDDEN")
      return { id: partnerId(r.id), status: r.status }
    })
  }
  async claim(runId: string): Promise<PartnerRequirementRun> {
    return validatePartnerRun(
      partnerObject(await this.node("claim", { runId: partnerId(runId) }), ["run"])
        .run as PartnerRequirementRun
    )
  }
  async recover(runId: string): Promise<PartnerRequirementRun> {
    const value = partnerObject(await this.node("inspect", { runId: partnerId(runId) }), [
      "run",
      "result"
    ])
    const run = validatePartnerRun(value.run as PartnerRequirementRun)
    const d = this.descriptor
    if (
      run.id !== runId ||
      run.spaceId !== d.spaceId ||
      run.nodeId !== d.nodeId ||
      run.ownerPrincipalId !== d.ownerPrincipalId
    )
      throw new PartnerLocalFault("FORBIDDEN")
    return run
  }
  private attempt(run: PartnerRequirementRun): Json {
    const r = validatePartnerRun(run)
    return { runId: r.id, attemptId: r.attemptId, leaseId: r.leaseId, fence: r.fence }
  }
  async start(
    run: PartnerRequirementRun
  ): Promise<{ run: PartnerRequirementRun; input: PartnerRequirementInput }> {
    const v = partnerObject(await this.node("start", this.attempt(run)), ["run", "input"]),
      raw = partnerObject(v.input, [
        "bot",
        "botVersion",
        "group",
        "task",
        "messages",
        "memorySnapshot",
        ...(Object.hasOwn(v.input as object, "deliveryInput") ? ["deliveryInput"] : []),
        ...(Object.hasOwn(v.input as object, "conversationInput") ? ["conversationInput"] : [])
      ])
    if (!Array.isArray(raw.messages) || raw.messages.length > 50)
      throw new PartnerLocalFault("INVALID_PAYLOAD")
    return {
      run: validatePartnerRun(v.run as PartnerRequirementRun),
      input: {
        conversationInput: parseExpertInput(
          raw.conversationInput,
          (raw.task as Task).id,
          run.taskVersion
        ),
        bot: partnerSchema("Bot", raw.bot),
        botVersion: partnerSchema("BotVersion", raw.botVersion),
        group: partnerSchema("Group", raw.group),
        task: partnerSchema("Task", raw.task),
        messages: raw.messages.map((m) => partnerSchema<TaskMessageResult>("TaskMessageResult", m)),
        deliveryInput: parseDeliveryInput(
          raw.deliveryInput,
          this.descriptor.spaceId,
          (raw.task as Task).id,
          run.id,
          run.taskVersion
        ),
        memorySnapshot: parseRunMemorySnapshot(
          raw.memorySnapshot,
          this.descriptor.spaceId,
          partnerId((raw.group as Group).id),
          partnerId((raw.bot as Bot).id),
          (v.run as PartnerRequirementRun).memoryScope
        )
      }
    }
  }
  async renew(run: PartnerRequirementRun): Promise<PartnerRequirementRun> {
    return validatePartnerRun(
      partnerObject(await this.node("renew", this.attempt(run)), ["run"])
        .run as PartnerRequirementRun
    )
  }
  async settle(
    run: PartnerRequirementRun,
    outcome: RequirementOutcome,
    text: string
  ): Promise<PartnerRequirementResult> {
    return this.result(
      partnerObject(await this.node("settle", { ...this.attempt(run), outcome, text }), ["result"])
        .result
    )!
  }
  private result(value: unknown): PartnerRequirementResult | null {
    if (value === null) return null
    const r = partnerObject(value, ["runId", "attemptId", "outcome", "text", "settledAt"])
    partnerId(r.runId)
    partnerId(r.attemptId)
    if (
      !["succeeded", "failed"].includes(String(r.outcome)) ||
      typeof r.text !== "string" ||
      !r.text.trim() ||
      r.text.length > 16384 ||
      typeof r.settledAt !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(r.settledAt) ||
      !Number.isFinite(Date.parse(r.settledAt))
    )
      throw new PartnerLocalFault("INVALID_PAYLOAD")
    return { ...r } as unknown as PartnerRequirementResult
  }
  async inspect(runId: string): Promise<LocalRunView> {
    const v = partnerObject(
      await this.control("business", "inspect", { runId: partnerId(runId) }),
      ["run", "result"]
    )
    const run = v.run as Json
    if (
      !run ||
      run.id !== runId ||
      run.spaceId !== this.descriptor.spaceId ||
      typeof run.status !== "string" ||
      !Number.isSafeInteger(run.version) ||
      Number(run.version) < 1
    )
      throw new PartnerLocalFault("INVALID_PAYLOAD")
    return { run, result: this.result(v.result) }
  }
  async cancelPending(runId: string, expectedVersion: number): Promise<void> {
    await this.control("business", "cancelPending", { runId: partnerId(runId), expectedVersion })
  }
  async currentAuthorization(groupId: string): Promise<PartnerNodeAuthorization | null> {
    const value = partnerObject(
      await this.control("owner", "authorization", { groupId: partnerId(groupId) }),
      ["grant"]
    )
    if (value.grant === null) return null
    const grant = partnerObject(value.grant, [
      "id",
      "groupId",
      "nodeId",
      "ownerPrincipalId",
      "workspaceRef",
      "version",
      "enabled",
      "expiresAt",
      "createdAt",
      "updatedAt"
    ])
    for (const key of ["id", "groupId", "nodeId", "ownerPrincipalId", "workspaceRef"])
      partnerId(grant[key])
    if (
      grant.groupId !== groupId ||
      typeof grant.enabled !== "boolean" ||
      ![grant.expiresAt, grant.createdAt, grant.updatedAt].every(
        (v) =>
          typeof v === "string" &&
          /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v) &&
          Number.isFinite(Date.parse(v))
      )
    )
      throw new PartnerLocalFault("INVALID_PAYLOAD")
    return {
      spaceId: this.descriptor.spaceId,
      groupId,
      nodeId: String(grant.nodeId),
      ownerPrincipalId: String(grant.ownerPrincipalId),
      workspaceRef: String(grant.workspaceRef),
      version: this.grantVersion(grant),
      enabled: grant.enabled,
      expiresAt: String(grant.expiresAt)
    }
  }
  async authorizationVersion(groupId: string): Promise<number> {
    const v = partnerObject(
      await this.control("owner", "authorization", { groupId: partnerId(groupId) }),
      ["grant"]
    )
    return v.grant === null ? 0 : this.grantVersion(v.grant)
  }
  async authorize(groupId: string, expectedVersion: number): Promise<number> {
    const v = partnerObject(
      await this.control("owner", "authorize", {
        groupId: partnerId(groupId),
        nodeId: this.descriptor.nodeId,
        workspaceRef: this.descriptor.workspaceRef,
        expectedVersion,
        expiresAt: new Date(Date.now() + 86400000).toISOString()
      }),
      ["grant"]
    )
    return this.grantVersion(v.grant)
  }
  async revoke(groupId: string, expectedVersion: number): Promise<number> {
    const v = partnerObject(
      await this.control("owner", "revoke", { groupId: partnerId(groupId), expectedVersion }),
      ["grant"]
    )
    return this.grantVersion(v.grant)
  }
  private grantVersion(v: unknown): number {
    const n = (v as Json)?.version
    if (!Number.isSafeInteger(n) || Number(n) < 1) throw new PartnerLocalFault("INVALID_PAYLOAD")
    return Number(n)
  }
  async lookupTask(groupId: string, taskNumber: string): Promise<Task> {
    const v = partnerObject(
      await this.control("business", "lookupTaskNumber", {
        groupId: partnerId(groupId),
        taskNumber
      }),
      ["task"]
    )
    return partnerSchema("Task", v.task)
  }
  async deliverySummaries(taskIds: string[]): Promise<TextDeliverySummary[]> {
    if (!taskIds.length || taskIds.length > 40 || new Set(taskIds).size !== taskIds.length)
      throw new PartnerLocalFault("INVALID_PAYLOAD")
    const v = partnerObject(
      await this.control("business", "deliverySummaries", { taskIds: taskIds.map(partnerId) }),
      ["items"]
    )
    if (!Array.isArray(v.items) || v.items.length !== taskIds.length)
      throw new PartnerLocalFault("INVALID_PAYLOAD")
    const found = new Set<string>()
    return v.items.map((raw) => {
      const task = partnerId((raw as TextDeliverySummary).taskId)
      if (!taskIds.includes(task) || found.has(task)) throw new PartnerLocalFault("INVALID_PAYLOAD")
      found.add(task)
      return parseDeliverySummary(raw, this.descriptor.spaceId, task)
    })
  }
  async deliveryVersions(taskId: string, before = Number.MAX_SAFE_INTEGER) {
    const v = partnerObject(
      await this.control("business", "deliveryVersions", { taskId: partnerId(taskId), before }),
      ["items", "nextBefore"]
    )
    if (
      !Array.isArray(v.items) ||
      v.items.length > 40 ||
      (v.nextBefore !== null && (!Number.isSafeInteger(v.nextBefore) || Number(v.nextBefore) < 1))
    )
      throw new PartnerLocalFault("INVALID_PAYLOAD")
    const items = v.items.map((raw) =>
      parseDeliveryVersion(raw, this.descriptor.spaceId, taskId, false)
    )
    if (
      items.some((item, i) => item.number >= (i ? items[i - 1].number : before)) ||
      (v.nextBefore !== null && v.nextBefore !== items.at(-1)?.number)
    )
      throw new PartnerLocalFault("INVALID_PAYLOAD")
    return { items, nextBefore: v.nextBefore as number | null }
  }
  async deliveryVersion(taskId: string, versionId: string) {
    return parseDeliveryDetail(
      await this.control("business", "deliveryVersion", {
        taskId: partnerId(taskId),
        versionId: partnerId(versionId)
      }),
      this.descriptor.spaceId,
      taskId,
      versionId
    )
  }
  async publishTextDelivery(input: {
    commandId: string
    taskId: string
    runId: string
    expectedTaskVersion: number
    expectedReviewVersion: number
  }) {
    const receipt = parseDeliveryReceipt(
        await this.control("business", "publishTextDelivery", input),
        this.descriptor.spaceId,
        input.taskId
      ),
      { summary } = receipt
    if (
      receipt.decision !== null ||
      summary.head?.versionId !== receipt.versionId ||
      summary.head.status !== "pending" ||
      summary.taskStatus !== "awaiting_business" ||
      summary.taskVersion !== input.expectedTaskVersion + 1 ||
      summary.head.revision !== input.expectedReviewVersion + 1 ||
      summary.head.reviewerPrincipalId !== this.descriptor.businessPrincipalId
    )
      throw new PartnerLocalFault("INVALID_PAYLOAD")
    return receipt
  }
  async decideTextDelivery(input: {
    commandId: string
    taskId: string
    versionId: string
    expectedTaskVersion: number
    expectedReviewVersion: number
    decision: "approve" | "reject"
    comment: string | null
  }) {
    const receipt = parseDeliveryReceipt(
        await this.control("business", "decideTextDelivery", input),
        this.descriptor.spaceId,
        input.taskId
      ),
      { summary, decision } = receipt
    if (
      receipt.versionId !== input.versionId ||
      !decision ||
      decision.decision !== input.decision ||
      decision.comment !== input.comment ||
      decision.principalId !== this.descriptor.businessPrincipalId ||
      decision.taskVersion !== input.expectedTaskVersion + 1 ||
      summary.taskVersion !== input.expectedTaskVersion + 1 ||
      summary.head?.versionId !== input.versionId ||
      summary.head.revision !== input.expectedReviewVersion + 1 ||
      summary.head.reviewerPrincipalId !== this.descriptor.businessPrincipalId ||
      summary.head.status !== (input.decision === "approve" ? "completed" : "changes_requested") ||
      summary.taskStatus !== (input.decision === "approve" ? "completed" : "active") ||
      summary.head.feedbackMessageId !== decision.feedbackMessageId
    )
      throw new PartnerLocalFault("INVALID_PAYLOAD")
    return receipt
  }
  async enqueue(
    task: Task,
    botId: string,
    commandId: string,
    deadline: string
  ): Promise<{ runId: string; status: string; executionProfile?: string; contextDigest?: string }> {
    const raw = await this.control("business", "enqueue", {
      commandId: partnerId(commandId),
      taskId: task.id,
      botId: partnerId(botId),
      expectedTaskVersion: task.version,
      deadline
    })
    const v = partnerObject(raw, [
      "runId",
      "status",
      "taskVersion",
      "createdAt",
      ...(Object.hasOwn(raw as object, "executionProfile")
        ? ["executionProfile", "contextDigest"]
        : [])
    ])
    if (
      v.taskVersion !== task.version ||
      !["queued", "waiting_node"].includes(String(v.status)) ||
      (v.executionProfile !== undefined &&
        (!["expert_main_v1", "expert_task_v1"].includes(String(v.executionProfile)) ||
          typeof v.contextDigest !== "string" ||
          !/^sha256:[a-f0-9]{64}$/.test(v.contextDigest)))
    )
      throw new PartnerLocalFault("INVALID_PAYLOAD")
    return {
      runId: partnerId(v.runId),
      status: String(v.status),
      ...(v.executionProfile !== undefined
        ? { executionProfile: String(v.executionProfile), contextDigest: String(v.contextDigest) }
        : {})
    }
  }
  async expertServiceIdentity(): Promise<string> {
    const value = partnerObject(await this.control("business", "expertServiceIdentity"), [
      "instanceId",
      "spaceId",
      "principalId"
    ])
    if (
      value.spaceId !== this.descriptor.spaceId ||
      value.principalId !== this.descriptor.businessPrincipalId
    )
      throw new PartnerLocalFault("FORBIDDEN")
    return partnerId(value.instanceId)
  }
  private expertReceipt(raw: unknown, botId?: string): ExpertTaskReceipt {
    const value = parseExpertReceipt(raw, this.descriptor.spaceId, (raw) =>
      partnerSchema<Task>("Task", raw)
    )
    if (
      value.principalId !== this.descriptor.businessPrincipalId ||
      (botId !== undefined && value.botId !== botId)
    )
      throw new PartnerLocalFault("FORBIDDEN")
    return value
  }
  async ensureExpertConversation(input: {
    commandId: string
    groupId: string
    botId: string
    role: "main" | "task"
    taskId: string | null
    title: string
    goal: string
  }): Promise<ExpertTaskReceipt> {
    const value = this.expertReceipt(
      await this.control("business", "ensureExpertConversation", input),
      input.botId
    )
    if (
      value.task.groupId !== input.groupId ||
      value.role !== input.role ||
      (input.taskId !== null && value.task.id !== input.taskId) ||
      value.sourceRunId !== null ||
      value.messageId !== null
    )
      throw new PartnerLocalFault("INVALID_PAYLOAD")
    return value
  }
  async expertConversationSummaries(
    groupId: string,
    botId: string,
    taskIds: string[]
  ): Promise<
    Array<{
      taskId: string
      taskVersion: number
      status: "active" | "awaiting_business" | "completed"
      role: "main" | "task"
      busy: boolean
    }>
  > {
    if (!taskIds.length || taskIds.length > 40 || new Set(taskIds).size !== taskIds.length)
      throw new PartnerLocalFault("INVALID_PAYLOAD")
    const value = partnerObject(
      await this.control("business", "expertConversationSummaries", { groupId, botId, taskIds }),
      ["items"]
    )
    if (!Array.isArray(value.items) || value.items.length !== taskIds.length)
      throw new PartnerLocalFault("INVALID_PAYLOAD")
    const seen = new Set<string>()
    return value.items.map((raw) => {
      const item = partnerObject(raw, ["taskId", "taskVersion", "status", "role", "busy"]),
        id = partnerId(item.taskId)
      if (
        !taskIds.includes(id) ||
        seen.has(id) ||
        !Number.isSafeInteger(item.taskVersion) ||
        Number(item.taskVersion) < 1 ||
        !["active", "awaiting_business", "completed"].includes(String(item.status)) ||
        !["main", "task"].includes(String(item.role)) ||
        typeof item.busy !== "boolean"
      )
        throw new PartnerLocalFault("INVALID_PAYLOAD")
      seen.add(id)
      return item as unknown as {
        taskId: string
        taskVersion: number
        status: "active" | "awaiting_business" | "completed"
        role: "main" | "task"
        busy: boolean
      }
    })
  }
  async freezeExpertInput(input: {
    commandId: string
    taskId: string
    expectedTaskVersion: number
    sourceRequestId: string
    allowedTaskIds: string[]
  }): Promise<ExpertConversationInput> {
    const value = parseExpertInput(
      await this.control("business", "freezeExpertInput", input),
      input.taskId,
      input.expectedTaskVersion
    )
    if (
      !value ||
      value.sourceRequestId !== input.sourceRequestId ||
      value.targets.length !== input.allowedTaskIds.length ||
      value.targets.some((t) => !input.allowedTaskIds.includes(t.taskId))
    )
      throw new PartnerLocalFault("INVALID_PAYLOAD")
    return value
  }
  async coordinateExpertTask(commandId: string, sourceRunId: string): Promise<ExpertTaskReceipt> {
    const value = this.expertReceipt(
      await this.control("business", "coordinateExpertTask", { commandId, sourceRunId })
    )
    if (value.sourceRunId !== sourceRunId || value.role !== "task")
      throw new PartnerLocalFault("INVALID_PAYLOAD")
    return value
  }
  async expertTaskLifecycle(input: {
    commandId: string
    taskId: string
    expectedVersion: number
    action: "complete" | "reopen"
  }): Promise<ExpertTaskReceipt> {
    const value = this.expertReceipt(await this.control("business", "expertTaskLifecycle", input))
    if (
      value.task.id !== input.taskId ||
      value.task.version !== input.expectedVersion + 1 ||
      value.task.status !== (input.action === "complete" ? "completed" : "active") ||
      value.role !== "task" ||
      value.sourceRunId !== null ||
      value.messageId !== null
    )
      throw new PartnerLocalFault("INVALID_PAYLOAD")
    return value
  }
  async createBot(body: CreateBotRequest): Promise<BotResult> {
    return partnerSchema(
      "BotResult",
      await this.call("/api/bot/v1/bots", "owner", "POST", partnerSchema("CreateBotRequest", body))
    )
  }
  async createGroup(body: CreateGroupRequest): Promise<Group> {
    const v = partnerSchema<{ group: Group }>(
      "GroupResult",
      await this.call(
        "/api/bot/v1/groups",
        "owner",
        "POST",
        partnerSchema("CreateGroupRequest", body)
      )
    )
    return v.group
  }
  async getBot(botId: string): Promise<BotResult> {
    return partnerSchema(
      "BotResult",
      await this.call(`/api/bot/v1/bots/${partnerId(botId)}`, "owner", "GET")
    )
  }
  async createBotVersion(botId: string, body: CreateBotVersionRequest): Promise<BotResult> {
    return partnerSchema(
      "BotResult",
      await this.call(
        `/api/bot/v1/bots/${partnerId(botId)}/versions`,
        "owner",
        "POST",
        partnerSchema("CreateBotVersionRequest", body)
      )
    )
  }
  async updateGroupMembers(groupId: string, body: UpdateGroupMembersRequest): Promise<Group> {
    const v = partnerSchema<{ group: Group }>(
      "GroupResult",
      await this.call(
        `/api/bot/v1/groups/${partnerId(groupId)}/members`,
        "owner",
        "PUT",
        partnerSchema("UpdateGroupMembersRequest", body)
      )
    )
    return v.group
  }
  async listGroupMemories(groupId: string): Promise<GroupMemoryList> {
    return parseMemoryList(
      await this.control("owner", "listGroupMemories", { groupId: partnerId(groupId) }),
      this.descriptor.spaceId,
      groupId
    )
  }
  async listExpertMemories(botId: string): Promise<ExpertMemoryList> {
    return parseExpertMemoryList(
      await this.control("owner", "listExpertMemories", { botId: partnerId(botId) }),
      this.descriptor.spaceId,
      botId
    )
  }
  async createExpertMemory(
    botId: string,
    text: string,
    commandId: string
  ): Promise<ExpertMemoryReceipt> {
    return parseExpertMemoryReceipt(
      await this.control("owner", "createExpertMemory", {
        botId: partnerId(botId),
        text: memoryText(text),
        commandId: partnerId(commandId)
      }),
      this.descriptor.spaceId,
      botId
    )
  }
  async updateExpertMemory(
    botId: string,
    input: ExpertMemoryUpdate,
    commandId: string
  ): Promise<ExpertMemoryReceipt> {
    if (!["active", "disabled"].includes(input.status))
      throw new PartnerLocalFault("INVALID_PAYLOAD")
    return parseExpertMemoryReceipt(
      await this.control("owner", "updateExpertMemory", {
        botId: partnerId(botId),
        memoryId: partnerId(input.memoryId),
        expectedVersion: memoryVersion(input.expectedVersion),
        text: memoryText(input.text),
        status: input.status,
        commandId: partnerId(commandId)
      }),
      this.descriptor.spaceId,
      botId
    )
  }
  async disableExpertMemory(
    botId: string,
    memoryId: string,
    expectedVersion: number,
    commandId: string
  ): Promise<ExpertMemoryReceipt> {
    return parseExpertMemoryReceipt(
      await this.control("owner", "disableExpertMemory", {
        botId: partnerId(botId),
        memoryId: partnerId(memoryId),
        expectedVersion: memoryVersion(expectedVersion),
        commandId: partnerId(commandId)
      }),
      this.descriptor.spaceId,
      botId
    )
  }
  async expertMemoryAdoption(
    groupId: string,
    botId: string
  ): Promise<{ adopted: boolean; botName: string; canManage: boolean }> {
    const v = partnerObject(
      await this.control("owner", "expertMemoryAdoption", {
        groupId: partnerId(groupId),
        botId: partnerId(botId)
      }),
      ["adopted", "botName", "canManage"]
    )
    if (
      typeof v.adopted !== "boolean" ||
      typeof v.canManage !== "boolean" ||
      typeof v.botName !== "string" ||
      !v.botName.trim() ||
      v.botName.length > 512
    )
      throw new PartnerLocalFault("INVALID_PAYLOAD")
    return { adopted: v.adopted, botName: v.botName, canManage: v.canManage }
  }
  async activateExpertMemory(group: Group, botId: string, botVersionId: string): Promise<void> {
    const v = partnerObject(
      await this.control("owner", "activateExpertMemory", {
        groupId: partnerId(group.id),
        botId: partnerId(botId),
        botVersionId: partnerId(botVersionId),
        expectedGroupVersion: memoryVersion(group.version)
      }),
      ["adopted"]
    )
    if (v.adopted !== true) throw new PartnerLocalFault("INVALID_PAYLOAD")
  }
  async createGroupMemory(
    groupId: string,
    input: GroupMemoryWrite,
    commandId: string
  ): Promise<GroupMemoryReceipt> {
    return parseMemoryReceipt(
      await this.control("owner", "createGroupMemory", {
        groupId: partnerId(groupId),
        commandId: partnerId(commandId),
        text: memoryText(input.text),
        source: memorySource(input.source)
      }),
      this.descriptor.spaceId,
      groupId
    )
  }
  async updateGroupMemory(
    groupId: string,
    input: GroupMemoryUpdate,
    commandId: string
  ): Promise<GroupMemoryReceipt> {
    return parseMemoryReceipt(
      await this.control("owner", "updateGroupMemory", {
        groupId: partnerId(groupId),
        commandId: partnerId(commandId),
        memoryId: partnerId(input.memoryId),
        expectedVersion: memoryVersion(input.expectedVersion),
        text: memoryText(input.text),
        source: memorySource(input.source),
        status: input.status
      }),
      this.descriptor.spaceId,
      groupId
    )
  }
  async disableGroupMemory(
    groupId: string,
    memoryId: string,
    expectedVersion: number,
    commandId: string
  ): Promise<GroupMemoryReceipt> {
    return parseMemoryReceipt(
      await this.control("owner", "disableGroupMemory", {
        groupId: partnerId(groupId),
        memoryId: partnerId(memoryId),
        expectedVersion: memoryVersion(expectedVersion),
        commandId: partnerId(commandId)
      }),
      this.descriptor.spaceId,
      groupId
    )
  }
  async inspectMemorySnapshot(
    runId: string,
    groupId: string,
    botId?: string,
    scope: "group" | "bot" = "group"
  ): Promise<PartnerRequirementInput["memorySnapshot"]> {
    const v = partnerObject(
      await this.control("business", "inspectMemorySnapshot", { runId: partnerId(runId) }),
      ["memorySnapshot"]
    )
    return parseRunMemorySnapshot(
      v.memorySnapshot,
      this.descriptor.spaceId,
      groupId,
      botId ?? "unused",
      scope
    )
  }
  async memoryChanged(run: PartnerRequirementRun): Promise<boolean> {
    const v = partnerObject(await this.node("inspect", { runId: partnerId(run.id) }), [
      "run",
      "result"
    ])
    const r = validatePartnerRun(v.run as PartnerRequirementRun),
      result = this.result(v.result)
    if (!samePartnerAttempt(r, run)) throw new PartnerLocalFault("FORBIDDEN")
    return (
      r.status === "failed" &&
      result?.runId === run.id &&
      result.attemptId === run.attemptId &&
      result.outcome === "failed" &&
      result.text === "MEMORY_CHANGED"
    )
  }
  async getBusinessGroup(groupId: string): Promise<Group> {
    return partnerSchema<{ group: Group }>(
      "GroupResult",
      await this.call(`/api/bot/v1/groups/${partnerId(groupId)}`, "business", "GET")
    ).group
  }
  async getGroup(groupId: string): Promise<Group> {
    return partnerSchema<{ group: Group }>(
      "GroupResult",
      await this.call(`/api/bot/v1/groups/${partnerId(groupId)}`, "owner", "GET")
    ).group
  }
  async createTask(groupId: string, content: string, commandId: string): Promise<Task> {
    const v = await this.call(
      "/api/bot/v1/tasks",
      "business",
      "POST",
      partnerSchema("CreateTaskRequest", {
        commandId,
        groupId: partnerId(groupId),
        title: content.slice(0, 80),
        goal: content,
        inputArtifactVersions: []
      })
    )
    return partnerSchema<{ task: Task }>("TaskResult", v).task
  }
  async createMessage(task: Task, text: string, commandId: string): Promise<TaskMessageResult> {
    return partnerSchema(
      "TaskMessageResult",
      await this.call(
        `/api/bot/v1/tasks/${partnerId(task.id)}/messages`,
        "business",
        "POST",
        partnerSchema("CreateTaskMessageRequest", {
          commandId,
          expectedVersion: task.version,
          text,
          artifactVersions: []
        })
      )
    )
  }
}
