import { useLayoutEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { BotDialogContent as DialogContent } from "./BotDialog"
import { BotAvatar } from "./BotAvatar"
import { cn } from "@/lib/utils"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import type { BotConversation, CoworkBot } from "../../../../shared/bot-types"
import { useBotGroupSave } from "@/lib/use-bot-group-save"
import { BotGroupSaveStatus } from "./BotGroupSaveStatus"
import { BOT_SINGLE_BOT_ROOM_CAPABILITY } from "../../../../shared/bot-groups"

export function BotGroupEditor({
  bots,
  group,
  close,
  created
}: {
  bots: CoworkBot[]
  group?: BotConversation
  close(): void
  created(id: string): void
}) {
  const dataEpoch = useBotWorkspaceStore((state) => state.snapshot?.dataEpoch ?? "initial")
  const [editingEpoch] = useState(dataEpoch)
  const supportsUpdate = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("group-update-receipts") ?? false
  )
  const supportsSingleMember = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("group-member-controls") ?? false
  )
  const supportsSingleRoom = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes(BOT_SINGLE_BOT_ROOM_CAPABILITY) ?? false
  )
  const latest = useBotWorkspaceStore((state) =>
    state.snapshot?.conversations.find((item) => item.id === group?.id)
  )
  const mounted = useRef(true)
  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const session = useBotGroupSave(group?.id, async (saved) => {
    await useBotWorkspaceStore.getState().refresh()
    if (mounted.current && useBotWorkspaceStore.getState().snapshot?.dataEpoch === editingEpoch) {
      created(saved.id)
      close()
    }
  })
  const pending = session.pending
  const [base, setBase] = useState(group)
  const minimumMembers = supportsSingleRoom || (base && supportsSingleMember) ? 1 : 2
  const [name, setName] = useState(pending?.name ?? group?.name ?? "协作群聊"),
    [description, setDescription] = useState(pending?.description ?? group?.description ?? ""),
    [members, setMembers] = useState<string[]>(pending?.members ?? group?.members ?? [])
  const busy = session.busy,
    uncertain = session.pending
  const restored = session.restored
  const stale = Boolean(base && latest?.revision !== base.revision)
  const unsupported = Boolean(group && !supportsUpdate)
  const missingMembers = members.filter((id) => !bots.some((bot) => bot.id === id))
  const fieldsDisabled = session.fieldsDisabled
  const cannotSave =
    session.saveDisabled ||
    (!uncertain &&
      !session.acknowledged &&
      (stale ||
        members.length < minimumMembers ||
        members.length > 6 ||
        !name.trim() ||
        missingMembers.length > 0))
  const reload = () => {
    if (!latest) return
    setBase(latest)
    setName(latest.name)
    setDescription(latest.description ?? "")
    setMembers(latest.members)
    session.clearError()
  }
  const save = async () => {
    if (cannotSave) return
    const fields = { name: name.trim(), description, members }
    await session.save(base ? { ...fields, id: base.id, revision: base.revision } : fields)
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !session.isSaving()) close()
      }}
    >
      <DialogContent className="bot-editor-dialog gap-0 p-0">
        <DialogHeader className="shrink-0 px-6 py-5 pr-12">
          <DialogTitle>{group ? "群聊设置" : "创建协作群聊"}</DialogTitle>
          <DialogDescription>
            {group
              ? "更新资料或成员后，当前讨论将停止；发送消息开始新一轮。"
              : `选择 ${minimumMembers}～6 个 Bot，建立独立会话。`}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <div className="min-h-0 space-y-5 overflow-y-auto overscroll-contain px-6 pb-6">
            {unsupported && (
              <p role="alert" className="text-sm text-destructive">
                请先在设置中重启后台，再保存群聊修改。
              </p>
            )}
            {restored && (
              <p role="alert" className="text-sm text-destructive">
                工作区数据已恢复，请关闭后重新打开群聊设置。
              </p>
            )}
            {stale && !uncertain && (
              <div role="status" className="space-y-2 rounded-xl border bg-muted/40 p-3 text-sm">
                <p>
                  {latest
                    ? "群聊已更新，当前草稿已保留。载入最新版本后再修改。"
                    : "群聊已不可用，无法保存当前修改。"}
                </p>
                {latest && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={fieldsDisabled}
                    onClick={reload}
                  >
                    载入最新版本，替换草稿
                  </Button>
                )}
              </div>
            )}
            <BotGroupSaveStatus session={session} />
            {missingMembers.length > 0 && !uncertain && (
              <div role="alert" className="space-y-2 text-sm">
                <p className="text-destructive">部分成员已不可用，请移除后重新选择。</p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={fieldsDisabled}
                  onClick={() =>
                    setMembers((current) =>
                      current.filter((id) => bots.some((bot) => bot.id === id))
                    )
                  }
                >
                  移除不可用成员
                </Button>
              </div>
            )}
            <label className="block space-y-2 text-xs font-medium">
              <span>群聊名称</span>
              <Input
                aria-label="群聊名称"
                disabled={fieldsDisabled}
                maxLength={100}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="block space-y-2 text-xs font-medium">
              <span>协作目标</span>
              <textarea
                aria-label="群聊描述"
                className="min-h-20 w-full resize-y rounded-xl border bg-background px-3 py-2 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                placeholder="这个群聊负责什么工作"
                maxLength={2000}
                value={description}
                disabled={fieldsDisabled}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            <fieldset className="space-y-2" disabled={fieldsDisabled}>
              <legend className="mb-2 text-xs font-medium">
                参与协作的 Bot · 已选 {members.length}/6
              </legend>
              {bots.map((bot) => (
                <label
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition-colors hover:bg-muted/40",
                    members.includes(bot.id) && "bg-muted/40"
                  )}
                  key={bot.id}
                >
                  <input
                    type="checkbox"
                    className="size-4 shrink-0 accent-[var(--foreground)]"
                    checked={members.includes(bot.id)}
                    disabled={!members.includes(bot.id) && members.length >= 6}
                    onChange={(event) =>
                      setMembers((current) =>
                        event.target.checked
                          ? [...current, bot.id]
                          : current.filter((id) => id !== bot.id)
                      )
                    }
                  />
                  <BotAvatar agentId={bot.id} size="sm" isStatic />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{bot.name}</span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {bot.instructions || "尚未指定职责"}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
          </div>
          <div className="flex shrink-0 justify-end gap-2 border-t px-6 py-4">
            <Button type="button" variant="ghost" disabled={busy} onClick={close}>
              {uncertain ? "稍后核对" : "取消"}
            </Button>
            <Button type="submit" disabled={cannotSave}>
              {busy
                ? "保存中…"
                : session.acknowledged
                  ? "核对已完成操作记录"
                  : uncertain
                    ? "重试核对保存"
                    : group
                      ? "保存群聊"
                      : "创建群聊"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
