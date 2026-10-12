import type {
  Bot,
  BotVersion,
  Group,
  Task,
  TaskMessageResult
} from "../../../shared/bot/contracts.generated"

/** Internal adapter DTO, not the frozen public RunSpec or a client authorization. */
export interface PartnerRequirementRun {
  id: string
  spaceId: string
  taskId: string
  stageId: string
  groupId: string
  botId: string
  botVersionId: string
  nodeId: string
  ownerPrincipalId: string
  workspaceRef: string
  attemptId: string
  leaseId: string
  fence: number
  taskVersion: number
  groupVersion: number
  status: string
  leaseExpiresAt: string
  deadline: string
}
export interface PartnerRequirementInput {
  bot: Bot
  botVersion: BotVersion
  group: Group
  task: Task
  /** Bounded explicit Task messages, not ambient group/Thread history. */
  messages: TaskMessageResult[]
}
export type RequirementOutcome = "succeeded" | "failed"
export interface PartnerRequirementResult {
  runId: string
  attemptId: string
  outcome: RequirementOutcome
  text: string
  settledAt: string
}
/** A trusted node transport supplies these. Never build one from IM/body IDs. */
export interface PartnerRequirementControl {
  start(run: PartnerRequirementRun): Promise<{
    run: PartnerRequirementRun
    input: PartnerRequirementInput
  }>
  renew(run: PartnerRequirementRun): Promise<PartnerRequirementRun>
  settle(
    run: PartnerRequirementRun,
    outcome: RequirementOutcome,
    text: string
  ): Promise<PartnerRequirementResult>
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const ID_KEYS = [
  "id",
  "spaceId",
  "taskId",
  "stageId",
  "groupId",
  "botId",
  "botVersionId",
  "nodeId",
  "ownerPrincipalId",
  "workspaceRef",
  "attemptId",
  "leaseId"
] as const
const STATUSES = ["starting", "running", "succeeded", "failed", "outcome_unknown"]
export function validatePartnerRun(run: PartnerRequirementRun): PartnerRequirementRun {
  if (
    !run ||
    ID_KEYS.some((key) => typeof run[key] !== "string" || !ID.test(run[key])) ||
    run.fence !== 1 ||
    ![run.taskVersion, run.groupVersion].every((v) => Number.isSafeInteger(v) && v > 0) ||
    !STATUSES.includes(run.status) ||
    ![run.leaseExpiresAt, run.deadline].every(
      (v) =>
        typeof v === "string" &&
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v) &&
        Number.isFinite(Date.parse(v))
    ) ||
    Date.parse(run.leaseExpiresAt) > Date.parse(run.deadline)
  )
    throw new Error("PARTNER_RUN_INPUT_INVALID")
  return Object.freeze(
    Object.fromEntries(
      [
        ...ID_KEYS,
        "fence",
        "taskVersion",
        "groupVersion",
        "status",
        "leaseExpiresAt",
        "deadline"
      ].map((k) => [k, run[k]])
    )
  ) as unknown as PartnerRequirementRun
}
export function samePartnerAttempt(a: PartnerRequirementRun, b: PartnerRequirementRun): boolean {
  return [...ID_KEYS, "fence", "taskVersion", "groupVersion"].every((k) => a[k] === b[k])
}
