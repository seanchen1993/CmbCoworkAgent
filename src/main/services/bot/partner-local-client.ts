import { request } from "node:http"
import Ajv from "ajv/dist/2020"
import addFormats from "ajv-formats"
import schemas from "../../../../contracts/bot/v1/schemas.json"
import states from "../../../../contracts/bot/v1/state-transitions.json"
import type {
  BotResult,
  CreateBotRequest,
  CreateGroupRequest,
  Group,
  Task,
  TaskMessageResult
} from "../../../shared/bot/contracts.generated"
import type {
  PartnerRequirementInput,
  PartnerRequirementResult,
  PartnerRequirementRun,
  RequirementOutcome
} from "./requirement-execution-types"
import { validatePartnerRun } from "./requirement-execution-types"

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
export class PartnerLocalFault extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}
export function partnerId(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value) || /[\r\n]/.test(value))
    throw new PartnerLocalFault("INVALID_PAYLOAD")
  return value
}
export function partnerObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(value, k))
  )
    throw new PartnerLocalFault("INVALID_PAYLOAD")
  return value as Record<string, unknown>
}
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
for (const keyword of ["x-state-transitions", "x-reconciliation", "x-mode-capabilities"])
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
    method: "GET" | "POST",
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
  private attempt(run: PartnerRequirementRun): Json {
    const r = validatePartnerRun(run)
    return { runId: r.id, attemptId: r.attemptId, leaseId: r.leaseId, fence: r.fence }
  }
  async start(
    run: PartnerRequirementRun
  ): Promise<{ run: PartnerRequirementRun; input: PartnerRequirementInput }> {
    const v = partnerObject(await this.node("start", this.attempt(run)), ["run", "input"]),
      raw = partnerObject(v.input, ["bot", "botVersion", "group", "task", "messages"])
    if (!Array.isArray(raw.messages) || raw.messages.length > 50)
      throw new PartnerLocalFault("INVALID_PAYLOAD")
    return {
      run: validatePartnerRun(v.run as PartnerRequirementRun),
      input: {
        bot: partnerSchema("Bot", raw.bot),
        botVersion: partnerSchema("BotVersion", raw.botVersion),
        group: partnerSchema("Group", raw.group),
        task: partnerSchema("Task", raw.task),
        messages: raw.messages.map((m) => partnerSchema<TaskMessageResult>("TaskMessageResult", m))
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
  async enqueue(
    task: Task,
    botId: string,
    commandId: string,
    deadline: string
  ): Promise<{ runId: string; status: string }> {
    const v = partnerObject(
      await this.control("business", "enqueue", {
        commandId: partnerId(commandId),
        taskId: task.id,
        botId: partnerId(botId),
        expectedTaskVersion: task.version,
        deadline
      }),
      ["runId", "status", "taskVersion", "createdAt"]
    )
    return { runId: partnerId(v.runId), status: String(v.status) }
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
