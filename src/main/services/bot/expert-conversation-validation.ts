import { createHash } from "node:crypto"
import type {
  ExpertConversationInput,
  ExpertCoordinationEnvelope,
  ExpertTaskReceipt
} from "../../../shared/bot/expert-conversation"
import { partnerId, partnerObject, PartnerLocalFault } from "./partner-local-boundary"

const reject = (): never => {
  throw new PartnerLocalFault("COORDINATION_INVALID_OUTPUT")
}
function content(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    [...value].length > maximum ||
    /[\u0000\uD800-\uDFFF]/u.test(value)
  )
    reject()
  return value as string
}
function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) reject()
  return Number(value)
}
/** JSON.parse alone silently accepts duplicate keys. Model output must be unambiguous. */
function strictJson(raw: string): unknown {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return reject()
  }
  const stack: Array<{ object: boolean; key: boolean; names: Set<string> }> = []
  for (const match of raw.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\],:]|[^\s{}\[\],:]+/g)) {
    const token = match[0],
      current = stack.at(-1)
    if (token === "{" || token === "[")
      stack.push({ object: token === "{", key: token === "{", names: new Set() })
    else if (token === "}" || token === "]") stack.pop()
    else if (token === "," && current?.object) current.key = true
    else if (token.startsWith('"') && current?.object && current.key) {
      const key = JSON.parse(token) as string
      if (current.names.has(key)) reject()
      current.names.add(key)
      current.key = false
    }
  }
  return value
}
export function expertContextDigest(value: Omit<ExpertConversationInput, "digest">): string {
  return "sha256:" + createHash("sha256").update(JSON.stringify(value)).digest("hex")
}
export function parseExpertInput(
  raw: unknown,
  taskId: string,
  taskVersion: number
): ExpertConversationInput | null {
  if (raw == null) return null
  const value = partnerObject(raw, [
    "profile",
    "taskId",
    "taskVersion",
    "sourceRequestId",
    "messages",
    "targets",
    "digest"
  ])
  if (
    !["expert_main_v1", "expert_task_v1"].includes(String(value.profile)) ||
    value.taskId !== taskId ||
    version(value.taskVersion) !== taskVersion
  )
    reject()
  partnerId(value.sourceRequestId)
  if (
    !Array.isArray(value.messages) ||
    !value.messages.length ||
    value.messages.length > 412 ||
    !Array.isArray(value.targets) ||
    value.targets.length > 40
  )
    reject()
  for (const raw of value.messages as unknown[]) {
    const entry = partnerObject(raw, ["role", "text", "sourceId", "taskVersion"])
    if (!["user", "assistant"].includes(String(entry.role))) reject()
    content(entry.text, 16384)
    partnerId(entry.sourceId)
    version(entry.taskVersion)
  }
  const targetIds = new Set<string>()
  for (const raw of value.targets as unknown[]) {
    const target = partnerObject(raw, ["taskId", "title", "status"]),
      id = partnerId(target.taskId)
    if (
      targetIds.has(id) ||
      !["active", "awaiting_business", "completed"].includes(String(target.status))
    )
      reject()
    targetIds.add(id)
    content(target.title, 160)
  }
  if (value.profile === "expert_task_v1" && targetIds.size) reject()
  const unsigned = { ...value }
  delete unsigned.digest
  if (
    Buffer.byteLength(JSON.stringify(unsigned), "utf8") > 60000 ||
    expertContextDigest(unsigned as unknown as Omit<ExpertConversationInput, "digest">) !==
      value.digest
  )
    reject()
  return structuredClone(value) as unknown as ExpertConversationInput
}
function coordinationEnvelope(
  raw: string,
  input: ExpertConversationInput
): ExpertCoordinationEnvelope {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 65536) reject()
  const value = partnerObject(strictJson(raw), ["reply", "intent"])
  content(value.reply, 12000)
  if (value.intent !== null) {
    const kind = (value.intent as { kind?: unknown })?.kind
    const intent = partnerObject(
      value.intent,
      kind === "create_task"
        ? ["kind", "sourceRequestId", "title", "contextSourceIds"]
        : ["kind", "sourceRequestId", "targetTaskRef"]
    )
    if (intent.sourceRequestId !== input.sourceRequestId) reject()
    if (kind === "create_task") {
      content(intent.title, 160)
      if (
        !Array.isArray(intent.contextSourceIds) ||
        intent.contextSourceIds.length > 12 ||
        new Set(intent.contextSourceIds).size !== intent.contextSourceIds.length
      )
        reject()
      const currentUser = input.messages.findLast((m) => m.role === "user")
      const possible = new Map(
        input.messages
          .filter((m) => m.sourceId !== currentUser?.sourceId)
          .map((m) => [m.sourceId, m])
      )
      const selected = (intent.contextSourceIds as unknown[]).map((id) => {
        partnerId(id)
        const entry = possible.get(partnerId(id))
        if (!entry) return reject()
        return entry
      })
      if (Buffer.byteLength(JSON.stringify(selected), "utf8") > 24576) reject()
    } else if (
      kind !== "append_task" ||
      !input.targets.some((t) => t.taskId === intent.targetTaskRef)
    )
      reject()
  }
  return value as unknown as ExpertCoordinationEnvelope
}
/** All model-shape failures share one safe, recoverable protocol outcome. */
export function parseCoordination(
  raw: string,
  input: ExpertConversationInput
): ExpertCoordinationEnvelope {
  try {
    return coordinationEnvelope(raw, input)
  } catch {
    throw new PartnerLocalFault("COORDINATION_INVALID_OUTPUT")
  }
}
export function parseExpertReceipt(
  raw: unknown,
  spaceId: string,
  task: (raw: unknown) => ExpertTaskReceipt["task"]
): ExpertTaskReceipt {
  const value = partnerObject(raw, [
    "task",
    "role",
    "botId",
    "principalId",
    "sourceRunId",
    "messageId"
  ])
  const stored = task(value.task)
  if (stored.spaceId !== spaceId || !["main", "task"].includes(String(value.role))) reject()
  partnerId(value.botId)
  partnerId(value.principalId)
  if (value.sourceRunId !== null) partnerId(value.sourceRunId)
  if (value.messageId !== null) partnerId(value.messageId)
  return { ...value, task: stored } as unknown as ExpertTaskReceipt
}

export const EXPERT_TASK_TEXT_PROMPT = `根据明确提供的任务目标、相关材料与本任务历史交流完成文本工作。直接回应当前请求；修改上一条答案时使用提供的assistant正文。无需需求说明、PRD、成果版本或审批模板，除非用户自己要求。只处理所给文本，不声称读取文件、操作浏览器、执行代码或调用工具。未知事实明确说明。`
export const EXPERT_MAIN_TEXT_PROMPT = `你是当前专家的主对话协调者，遵循专家自身的领域instructions。可以正常聊天、解释、澄清及协调独立任务。只使用本主对话、明确携入材料与targets摘要，不能声称查看其他任务正文。普通问答不能创建任务；只有用户明确交办独立工作时create_task，明确指向targets中某任务的补充时append_task，目标不明先澄清。
只输出一个JSON对象（无代码围栏），严格格式：{"reply":"自然语言回复","intent":null}；或intent为{"kind":"create_task","sourceRequestId":"本输入sourceRequestId","title":"简洁任务名","contextSourceIds":[]}；或{"kind":"append_task","sourceRequestId":"本输入sourceRequestId","targetTaskRef":"targets提供的taskId"}。每轮最多一个意图。create的contextSourceIds只选择当前messages中与新任务相关的既有sourceId，最多12，不选择末条当前用户消息（系统始终保留它为目标）；不需历史则[]，不要默认选全部。不得生成正文、actor、命令、模型或其他字段。意图只是待核验请求，不得在reply声称已交办/已转达/已完成，实际状态由应用回执展示。不能用意图完成或重新打开任务。`
