import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useBotSkillSave } from "@/lib/use-bot-skill-save"
import { BotSkillSaveStatus } from "./BotSkillSaveStatus"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import { BOT_USER_SKILLS_CAPABILITY } from "../../../../shared/bot-skill-library"

export function BotSkillCreateForm({
  botId,
  reload,
  onCreatedScope
}: {
  botId: string
  reload(): Promise<void>
  onCreatedScope?(scope: string): void
}) {
  const session = useBotSkillSave(botId, undefined, reload)
  const userSkills = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes(BOT_USER_SKILLS_CAPABILITY) ?? false
  )
  const [privateScope, setPrivateScope] = useState(
    session.pending ? session.pending.scope !== "user" : false
  )
  const shared = userSkills && !privateScope
  const [name, setName] = useState(session.pending?.name ?? "")
  const [instructions, setInstructions] = useState(session.pending?.instructions ?? "")
  return (
    <form
      className="space-y-3 border-t pt-4"
      onSubmit={(event) => {
        event.preventDefault()
        const scope = session.pending?.scope ?? (shared ? "user" : "bot")
        void session
          .save({
            name,
            instructions,
            enabled: true,
            ...(shared ? { scope: "user" as const } : {})
          })
          .then((saved) => {
            if (saved) {
              setName("")
              setInstructions("")
              onCreatedScope?.(scope)
            }
          })
      }}
    >
      <h3 className="text-sm font-medium">保存技能</h3>
      {userSkills && (
        <label className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          保存位置
          <select
            className="rounded-md border bg-background px-2 py-1 text-foreground"
            aria-label="技能保存位置"
            disabled={session.fieldsDisabled}
            value={shared ? "user" : "bot"}
            onChange={(event) => setPrivateScope(event.target.value === "bot")}
          >
            <option value="user">我的技能库 · 所有 Bot 可用</option>
            <option value="bot">仅此 Bot</option>
          </select>
        </label>
      )}
      <Input
        aria-label="名称"
        placeholder="名称"
        value={name}
        maxLength={100}
        disabled={session.fieldsDisabled}
        onChange={(event) => setName(event.target.value)}
      />
      <textarea
        className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
        aria-label="内容"
        rows={4}
        maxLength={64000}
        value={instructions}
        disabled={session.fieldsDisabled}
        onChange={(event) => setInstructions(event.target.value)}
        placeholder="工作步骤、要求和验收方式"
      />
      <BotSkillSaveStatus session={session} />
      <Button
        disabled={
          session.busy ||
          session.restored ||
          !session.supported ||
          session.blocked ||
          (!session.pending && !session.acknowledged && (!name.trim() || !instructions.trim()))
        }
      >
        {session.busy
          ? "保存中…"
          : session.acknowledged
            ? "同步保存结果"
            : session.pending
              ? "重试核对保存"
              : "保存"}
      </Button>
    </form>
  )
}
