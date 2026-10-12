import { BotDomainError } from "../../shared/bot-types"
import type { BotRpcMethod } from "../../shared/bot-api"
import * as v from "./validation"

/** Scoped public mutations and exchange reads carry these fields. Internal lease writes bypass RPC. */
const fields = Object.freeze({
  answerIntroductionQuestion: "dataEpoch",
  changeLocalToolPermission: "dataEpoch",
  resolveLocalToolPermission: "dataEpoch",
  create: "expectedDataEpoch",
  clone: "expectedDataEpoch",
  update: "expectedDataEpoch",
  delete: "expectedDataEpoch",
  deleteFile: "expectedDataEpoch",
  teachStart: "expectedDataEpoch",
  teachRetry: "expectedDataEpoch",
  createGroup: "expectedDataEpoch",
  updateGroup: "expectedDataEpoch",
  saveRoutine: "expectedDataEpoch",
  runRoutine: "expectedDataEpoch",
  saveSkill: "expectedDataEpoch",
  setSkillEnabled: "expectedDataEpoch",
  skillMaintenance: "expectedDataEpoch",
  configureSkillMaintenance: "expectedDataEpoch",
  changeSkillMaintenance: "expectedDataEpoch",
  runSkillMaintenance: "expectedDataEpoch",
  routineDispatchHistory: "expectedDataEpoch",
  trialSkill: "expectedDataEpoch",
  reviewSkillTrial: "expectedDataEpoch",
  peerExchange: "expectedDataEpoch",
  checkSkillDependencies: "expectedDataEpoch",
  changeAvatar: "expectedDataEpoch",
  changeWebhook: "expectedDataEpoch",
  workflowControl: "expectedDataEpoch",
  changeUsageBudget: "dataEpoch",
  changeNotifications: "dataEpoch",
  changePrimaryBot: "dataEpoch",
  ensurePrimaryBot: "dataEpoch",
  changePrimaryCheckIn: "dataEpoch",
  changeBackupSchedule: "dataEpoch",
  changeAutoReview: "dataEpoch",
  changeApprovalRule: "dataEpoch",
  retryMemory: "dataEpoch",
  setMemoryPolicy: "expectedDataEpoch",
  saveMemory: "expectedDataEpoch",
  deleteMemory: "expectedDataEpoch",
  saveSharedMemory: "expectedDataEpoch",
  deleteSharedMemory: "expectedDataEpoch",
  recover: "dataEpoch",
  stopShellJob: "dataEpoch"
} as const satisfies Partial<Record<BotRpcMethod, "expectedDataEpoch" | "dataEpoch">>)

/** A historical Store receipt is readable evidence, not a success ACK for a replacement workspace.
 * Check authority at public admission and immediately before returning a successful result.
 * Capture the submitted scope unchanged; never backfill it from the current Host. */
export async function guardBotRpcMutationEpoch<T>(
  method: string,
  input: unknown,
  epoch: () => string,
  execute: () => Promise<T>
): Promise<T> {
  const scopedAnswer =
    method === "answer" &&
    input !== null &&
    typeof input === "object" &&
    Object.hasOwn(input, "expectedDataEpoch")
  if (!Object.hasOwn(fields, method) && !scopedAnswer) return execute()
  const key = scopedAnswer ? "expectedDataEpoch" : fields[method as keyof typeof fields],
    request = v.record(input),
    expected = request[key] === undefined ? "initial" : v.text(request[key], "工作区版本", 160)
  const check = () => {
    if (epoch() !== expected)
      throw new BotDomainError("data_epoch", "工作区数据已恢复，请重新打开并核对原操作")
  }
  check()
  const result = await execute()
  check()
  return result
}
