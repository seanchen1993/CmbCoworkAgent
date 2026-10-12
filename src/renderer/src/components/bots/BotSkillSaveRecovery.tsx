import { useMemo } from "react"
import { pendingSkillSaveIds } from "@/lib/bot-skill-save-pending"
import { useBotSkillSave } from "@/lib/use-bot-skill-save"
import { BotSkillSaveStatus } from "./BotSkillSaveStatus"

function LostSkillSave({
  botId,
  id,
  reload
}: {
  botId: string
  id: string
  reload(): Promise<void>
}) {
  const session = useBotSkillSave(botId, id, reload)
  if (session.record.kind === "empty" && !session.acknowledged) return null
  return (
    <section aria-label="已移除技能的待确认保存" className="rounded-xl border border-border/70 p-3">
      <p className="text-xs font-medium">技能已不在当前列表中，请核对原保存结果</p>
      <BotSkillSaveStatus session={session} retry />
    </section>
  )
}

/** Refreshes only when the visible skill identities change, without a second poller or body cache. */
export function BotSkillSaveRecovery({
  botId,
  activeSkillIds,
  reload
}: {
  botId: string
  activeSkillIds: string[]
  reload(): Promise<void>
}) {
  const identity = activeSkillIds.join("\0")
  const inventory = useMemo(() => {
    const active = new Set(identity ? identity.split("\0") : [])
    try {
      return { ids: pendingSkillSaveIds(botId).filter((id) => !active.has(id)), error: null }
    } catch {
      return { ids: [], error: "无法读取待确认技能保存，请检查应用存储后重新打开。" }
    }
  }, [botId, identity])
  return (
    <>
      {inventory.error && (
        <p role="alert" className="text-xs text-destructive">
          {inventory.error}
        </p>
      )}
      {inventory.ids.map((id) => (
        <LostSkillSave key={id} botId={botId} id={id} reload={reload} />
      ))}
    </>
  )
}
