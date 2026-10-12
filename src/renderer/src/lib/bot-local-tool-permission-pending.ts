import { z } from "zod"
import {
  botLocalToolAnswer,
  botLocalToolPolicyChange
} from "../../../shared/bot-local-tool-permission"
import { createFlatSettingsPending } from "./bot-flat-settings-pending"

// The existing protected lifecycle needs an owner identity. These settings are
// physical-device scoped, so null is deliberate and never crosses the API wire.
export const localToolPolicySave = botLocalToolPolicyChange.extend({ botId: z.null() }).strict()
export type LocalToolPolicySave = z.infer<typeof localToolPolicySave>
export const localToolAnswerSave = botLocalToolAnswer.extend({ botId: z.null() }).strict()
export type LocalToolAnswerSave = z.infer<typeof localToolAnswerSave>
export const pendingLocalToolPolicy = createFlatSettingsPending({
  input: localToolPolicySave,
  key: () => "cmb:bot-local-tool-policy:pending",
  maxCharacters: 4096,
  storageMessage: "本机许可记录超过大小限制"
})
export function localToolAnswerPending(id: string) {
  const pending = createFlatSettingsPending({
    input: localToolAnswerSave.refine((input) => input.id === id),
    key: () => `cmb:bot-local-tool-answer:${id}`,
    maxCharacters: 4096,
    storageMessage: "本机许可回答记录超过大小限制"
  })
  return {
    ...pending,
    remember(input: LocalToolAnswerSave) {
      if (
        pending.inspect(null, input.dataEpoch).kind === "empty" &&
        pendingLocalToolAnswers().length >= 64
      )
        throw new Error("待核对许可回答已达上限，请先核对现有回答。")
      pending.remember(input)
    }
  }
}

/** Bounded lightweight identities, reusing the existing routine/skill recovery pattern.
 * No second index and no permission is retried just by opening this inventory. */
export function pendingLocalToolAnswers(): string[] {
  if (localStorage.length > 4096) throw new Error("本机操作记录过多，请检查应用存储后重新打开。")
  const prefix = "cmb:bot-local-tool-answer:",
    ids: string[] = []
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index)
    if (!key?.startsWith(prefix)) continue
    const id = key.slice(prefix.length)
    if (!id || id.length > 160 || !/^[\w:.-]+$/.test(id))
      throw new Error("本机许可回答索引无法读取，请保留原记录后核对。")
    ids.push(id)
    if (ids.length > 64) throw new Error("待核对许可回答过多，请先处理现有记录。")
  }
  return ids
}

/** Changing the physical target is authority retirement even when DB epoch is unchanged.
 * Reuse exact-byte protected archive; never discard a pending request for the current target. */
export function localToolRecoveryRecord<T extends { targetId: string; dataEpoch: string }>(
  record: import("./bot-protected-save-pending").ProtectedSaveRecord<T>,
  currentTargetId?: string
): import("./bot-protected-save-pending").ProtectedSaveRecord<T> {
  return record.kind === "valid" && currentTargetId && record.input.targetId !== currentTargetId
    ? { ...record, kind: "obsolete", dataEpoch: record.input.dataEpoch }
    : record
}
export function discardRetiredLocalToolRecord<T extends { targetId: string; dataEpoch: string }>(
  pending: {
    inspect(
      owner: null,
      epoch: string
    ): import("./bot-protected-save-pending").ProtectedSaveRecord<T>
    discard(owner: null, epoch: string, raw: string): boolean
  },
  epoch: string,
  currentTargetId: string | undefined,
  raw: string
): boolean {
  const record = pending.inspect(null, epoch)
  // This comparison-only sentinel is deliberately outside the <=160-character epoch
  // schema, so no stored valid request can equal it; no fabricated epoch is written.
  const retiredEpoch =
    record.kind === "valid" && currentTargetId && record.input.targetId !== currentTargetId
      ? `retired-local-target:${"x".repeat(161)}`
      : epoch
  return pending.discard(null, retiredEpoch, raw)
}
