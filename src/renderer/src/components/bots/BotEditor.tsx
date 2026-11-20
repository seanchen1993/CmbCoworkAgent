import { useId, useRef, useState } from "react"
import { ChevronRight, Loader2 } from "lucide-react"
import { useAppStore } from "@/lib/store"
import { botErrorMessage } from "@/lib/bot-error-message"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { CustomModelDialog } from "@/components/chat/CustomModelDialog"
import type { BotClient, BotDefinition, CreateBotInput } from "../../../../shared/bots/contracts"
import { createBotAppearance } from "../../../../shared/bots/appearance"
import { BotAvatar } from "./BotAvatar"
import { BotAppearancePicker } from "./BotAppearancePicker"
import { BotSkillSelect } from "./BotSkillSelect"

export function BotEditor({
  bot,
  client,
  createBot,
  onClose,
  onSaved,
  returnFocusTo,
  nameOnly = false,
  initialName = ""
}: {
  bot: BotDefinition | null
  client: BotClient
  createBot?(input: CreateBotInput): Promise<BotDefinition>
  onClose(): void
  onSaved(bot: BotDefinition): void
  returnFocusTo?: HTMLElement | null
  nameOnly?: boolean
  initialName?: string
}) {
  const models = useAppStore((state) => state.models)
  const trigger = useRef(returnFocusTo ?? document.activeElement)
  const [input, setInput] = useState<CreateBotInput>(
    () =>
      bot ?? {
        name: initialName,
        instructions: "",
        ...createBotAppearance(),
        modelRef: null
      }
  )
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const creating = !bot && !nameOnly
  const settingsId = useId()
  const [saving, setSaving] = useState(false)
  const lock = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (lock.current) return
    lock.current = true
    setSaving(true)
    setError(null)
    try {
      const saved = bot
        ? await client.update({
            ...input,
            id: bot.id,
            expectedVersion: bot.version,
            archived: bot.archived
          })
        : await (createBot ? createBot(input) : client.create(input))
      onSaved(saved)
    } catch (cause) {
      setError(botErrorMessage(cause))
    } finally {
      lock.current = false
      setSaving(false)
    }
  }
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open && !saving) onClose()
        }}
      >
        <DialogContent
          className={`bot-editor flex max-h-[calc(100dvh-3rem)] flex-col sm:max-w-[440px]${creating ? " bot-create-dialog" : ""}`}
          onCloseAutoFocus={(event) => {
            if (!(trigger.current instanceof HTMLElement) || !trigger.current.isConnected) return
            event.preventDefault()
            trigger.current.focus({ preventScroll: true })
          }}
        >
          <DialogHeader className={creating ? "bot-create-heading" : undefined}>
            <DialogTitle>{nameOnly ? "重命名 Bot" : bot ? "编辑 Bot" : "创建新 Bot"}</DialogTitle>
            <DialogDescription className={creating ? "sr-only" : undefined}>
              {nameOnly ? "修改名称不会改变对话和工作资料。" : "为 Bot 起个名字，告诉它负责什么。"}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={submit}
            className={
              creating ? "bot-create-form" : "min-h-0 space-y-5 overflow-y-auto overscroll-contain"
            }
          >
            <div className={creating ? "bot-create-body" : "space-y-5"}>
              {!nameOnly && (
                <div
                  className={
                    creating ? "bot-create-avatar" : "flex flex-col items-center gap-4 py-2"
                  }
                >
                  <BotAvatar
                    color={input.color}
                    shape={input.shape}
                    size={creating ? 96 : 90}
                    idleAnimation={creating}
                  />
                  {!creating && (
                    <BotAppearancePicker
                      value={input}
                      disabled={saving}
                      onChange={(appearance) => setInput((value) => ({ ...value, ...appearance }))}
                    />
                  )}
                </div>
              )}
              <label className={creating ? "bot-field bot-create-name" : "bot-field"}>
                <span className={creating ? "sr-only" : undefined}>Bot 名称</span>
                <input
                  required
                  maxLength={80}
                  autoFocus
                  disabled={saving}
                  value={input.name}
                  onChange={(event) =>
                    setInput((value) => ({ ...value, name: event.target.value }))
                  }
                  placeholder={creating ? "给你的 Bot 起个名字" : "例如：研发搭档"}
                />
              </label>
              {creating && (
                <>
                  <BotAppearancePicker
                    value={input}
                    disabled={saving}
                    onChange={(appearance) => setInput((value) => ({ ...value, ...appearance }))}
                  />
                  <button
                    type="button"
                    className="bot-create-advanced"
                    aria-expanded={advanced}
                    aria-controls={settingsId}
                    disabled={saving}
                    onClick={() => setAdvanced((value) => !value)}
                  >
                    <ChevronRight size={14} aria-hidden="true" />
                    更多设置
                  </button>
                </>
              )}
              {!nameOnly && (!creating || advanced) && (
                <div id={creating ? settingsId : undefined} className="space-y-5">
                  <label className="bot-field">
                    职责
                    <textarea
                      rows={3}
                      maxLength={8000}
                      disabled={saving}
                      value={input.instructions}
                      onChange={(event) =>
                        setInput((value) => ({ ...value, instructions: event.target.value }))
                      }
                      placeholder="描述它擅长什么、如何与你合作…"
                    />
                  </label>
                  <label className="bot-field">
                    模型
                    <Select
                      value={input.modelRef ?? "default"}
                      disabled={saving}
                      onValueChange={(modelRef) =>
                        setInput((value) => ({
                          ...value,
                          modelRef: modelRef === "default" ? null : modelRef
                        }))
                      }
                    >
                      <SelectTrigger aria-label="模型" className="h-11 rounded-xl shadow-none">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent data-bot-popup className="bot-workspace-select rounded-xl">
                        <SelectItem value="default">使用默认模型</SelectItem>
                        {models.map((model) => (
                          <SelectItem key={model.id} value={model.id}>
                            {model.name}
                          </SelectItem>
                        ))}
                        {input.modelRef && !models.some((model) => model.id === input.modelRef) && (
                          <SelectItem value={input.modelRef}>当前模型（未连接）</SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  </label>
                  <BotSkillSelect
                    hostId={client.hostId}
                    value={input.allowedSkillNames}
                    disabled={saving}
                    onChange={(allowedSkillNames) =>
                      setInput((value) => ({ ...value, allowedSkillNames }))
                    }
                  />
                  <button
                    type="button"
                    className="text-xs text-muted-foreground underline underline-offset-4"
                    disabled={saving}
                    onClick={() => setModelSettingsOpen(true)}
                  >
                    管理模型与 API 配置
                  </button>
                </div>
              )}
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
            </div>
            <DialogFooter className={creating ? "bot-create-footer" : undefined}>
              <Button type="button" variant="ghost" disabled={saving} onClick={onClose}>
                取消
              </Button>
              <Button
                type="submit"
                className="rounded-full bg-foreground px-5 text-background hover:bg-foreground/90"
                disabled={saving || !input.name.trim()}
              >
                {saving && <Loader2 className="mr-2 size-4 animate-spin" />}
                {saving && creating ? "创建中…" : bot ? "保存" : "创建"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <CustomModelDialog
        open={modelSettingsOpen}
        selectedModelId={input.modelRef ?? undefined}
        onModelSaved={(modelRef) => setInput((current) => ({ ...current, modelRef }))}
        onOpenChange={(open) => {
          setModelSettingsOpen(open)
          if (!open) void useAppStore.getState().loadModels(true)
        }}
      />
    </>
  )
}
