import { botApi } from "@/lib/bot-api"
import { useRef, useState } from "react"
import { Library } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { BotLibrarySkill } from "../../../../shared/bot-skill-library"
import type { BotSkillSummary } from "../../../../shared/bot-types"
import type { BotSkillTrial } from "../../../../shared/bot-teach"
import { BotSkillCard } from "./BotSkillCard"
import { BotSkillEnablement, BotSkillEnablementRecovery } from "./BotSkillEnablement"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import { BOT_USER_SKILLS_CAPABILITY } from "../../../../shared/bot-skill-library"
export function BotSkillLibraryPanel({
  items,
  botId,
  focusId,
  available,
  trials,
  reload
}: {
  items: BotLibrarySkill[]
  botId: string
  focusId?: string
  available: BotSkillSummary[]
  trials: BotSkillTrial[]
  reload(): Promise<void>
}) {
  const userSkills = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes(BOT_USER_SKILLS_CAPABILITY) ?? false
  )
  const dataEpoch = useBotWorkspaceStore((state) => state.snapshot?.dataEpoch ?? "initial")
  const [withdraw, setWithdraw] = useState<{
    item: BotLibrarySkill
    nonce: string
    epoch: string
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const locked = useRef(false)
  const remove = async () => {
    if (!withdraw || locked.current || withdraw.epoch !== dataEpoch) return
    locked.current = true
    setBusy(true)
    setError(null)
    try {
      await botApi.withdrawSkill({
        nonce: withdraw.nonce,
        id: withdraw.item.id,
        revision: withdraw.item.revision,
        ...(userSkills ? { expectedDataEpoch: withdraw.epoch } : {})
      })
      setWithdraw(null)
      await reload()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "撤回失败，请重试")
    } finally {
      locked.current = false
      setBusy(false)
    }
  }
  const enabled = items.filter((item) => item.enabled)
  const availableById = new Map(available.map((skill) => [skill.id, skill]))
  return (
    <section className="space-y-3">
      <p className="text-xs leading-relaxed text-muted-foreground">
        {userSkills
          ? "技能由本机个人工作区中的 Bot 共用，可分别启停。修改会更新同一技能；录制、聊天和试跑记录仍各自保留。原有共享副本继续独立保存。"
          : "点击输入框旁的「＋」选择共享技能。共享版本独立保存，原 Bot 的修订和删除不会改写它。"}
      </p>
      {userSkills && (
        <BotSkillEnablementRecovery
          botId={botId}
          activeIds={enabled.map((item) => item.id)}
          reload={reload}
        />
      )}
      {!enabled.length && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-8 text-center text-muted-foreground">
          <Library size={24} strokeWidth={1.5} />
          <p className="text-sm">暂无共享技能</p>
          <p className="text-xs">
            {userSkills
              ? "保存工作步骤，或示范一次任务，之后可供其他 Bot 使用。"
              : "从「此 Bot」查看流程后共享，其他 Bot 即可使用。"}
          </p>
        </div>
      )}
      {enabled.map((item) => (
        <BotSkillCard
          key={item.id}
          revealSteps={item.id === focusId}
          skill={{
            id: item.id,
            botId,
            name: item.name,
            instructions: item.instructions,
            version: item.revision,
            enabled: availableById.get(item.id)?.enabled ?? item.enabled,
            enablementRevision: availableById.get(item.id)?.enablementRevision,
            userEditable: userSkills && item.kind === "authored",
            scope: "user",
            createdAt: item.updatedAt,
            verified: available.some(
              (skill) => skill.id === item.id && skill.version === item.revision && skill.verified
            )
          }}
          trials={trials.filter((trial) => trial.skillId === item.id)}
          reload={reload}
          footer={
            <div className="mt-3 flex flex-wrap items-start gap-1 border-t pt-2">
              {userSkills && (
                <BotSkillEnablement
                  skill={{
                    id: item.id,
                    botId,
                    name: item.name,
                    instructions: item.instructions,
                    version: item.revision,
                    createdAt: item.updatedAt,
                    scope: "user",
                    enabled: availableById.get(item.id)?.enabled ?? item.enabled,
                    verified: false,
                    enablementRevision: availableById.get(item.id)?.enablementRevision
                  }}
                  reload={reload}
                />
              )}
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto text-muted-foreground hover:text-destructive"
                disabled={busy}
                onClick={() => {
                  setError(null)
                  setWithdraw({ item: { ...item }, nonce: crypto.randomUUID(), epoch: dataEpoch })
                }}
              >
                {item.kind === "authored" ? "删除我的技能" : "撤回共享"}
              </Button>
              {withdraw?.item.id === item.id && (
                <div
                  className="mt-3 w-full space-y-2 rounded-lg border p-3"
                  role="group"
                  aria-label="确认撤回共享"
                >
                  <p className="text-xs leading-relaxed">
                    撤回后所有 Bot
                    均无法再次读取该技能，正在使用它的任务会在下一次执行校验时停止。已完成的操作和历史记录保留。
                  </p>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busy || withdraw.epoch !== dataEpoch}
                      onClick={() => void remove()}
                    >
                      确认撤回
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setWithdraw(null)}
                    >
                      取消
                    </Button>
                  </div>
                </div>
              )}
            </div>
          }
        />
      ))}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
