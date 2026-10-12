import { reportBotError } from "@/lib/bot-error-toast"
import { useBotViewVisibility } from "@/lib/use-bot-view-visibility"
import { botSteeringTarget } from "@/lib/bot-steering"
import { useRef, useState, type RefObject } from "react"
import { ArrowUp, AtSign, Loader2, RotateCcw, Sparkles, TerminalSquare, Upload } from "lucide-react"
import { parseBotPluginCommand } from "../../../../shared/bot-plugin-command"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import { BotAttachmentPicker } from "./BotFiles"
import { BotComposerActions } from "./BotComposerActions"
import { useBotSkillSuggestions } from "@/lib/use-bot-skill-suggestions"
import { BotComposerReply } from "./BotReply"
import { useBotEntitySuggestions } from "@/lib/use-bot-entity-suggestions"
import { botEntityLabels } from "../../../../shared/bot-entity-references"
import { BotEntityIcon } from "./BotEntityReferences"
import { BotPromptEditor, type BotPromptControls, type BotPromptSelection } from "./BotPromptEditor"
import { BotAvatar } from "./BotAvatar"
import { botViewAddress } from "@/lib/bot-thread-view"
import { useBotComposerFiles, type BotAttachmentPickerHandle } from "@/lib/use-bot-composer-files"

export function BotComposer({
  conversationId,
  recipients,
  working,
  onTeach,
  onEditorReady,
  onAttachmentReady,
  handoffNotice,
  controls
}: {
  conversationId: string
  controls?: RefObject<BotPromptControls | null>
  recipients: string[]
  working: boolean
  onTeach?(botId: string): void
  onEditorReady?(): void
  onAttachmentReady?(picker: BotAttachmentPickerHandle): void
  handoffNotice?: { message: string; back(): void }
}) {
  const draft = useBotWorkspaceStore((state) => state.drafts[conversationId])
  const pending = useBotWorkspaceStore((state) => state.pending[conversationId])
  const sending = useBotWorkspaceStore((state) => Boolean(state.sending[conversationId]))
  const uploading = useBotWorkspaceStore((state) => Boolean(state.uploading[conversationId]))
  const attachmentPicker = useRef<BotAttachmentPickerHandle>(null)
  const visible = useBotViewVisibility()
  const fileInput = useBotComposerFiles(sending || uploading, attachmentPicker, true, visible)
  const internalInput = useRef<BotPromptControls>(null)
  const input = controls ?? internalInput
  const [newTask, setNewTask] = useState(false)
  const [selection, setSelection] = useState<BotPromptSelection>({
    text: "",
    caret: 0,
    start: 1
  })
  const [focused, setFocused] = useState(false)
  const skillPickerSequence = useRef(0)
  const [skillPicker, setSkillPicker] = useState<{
    id: number
    scope: string
    revision: string | undefined
    position: number
    selection: string
    query: string
  } | null>(null)
  const snapshot = useBotWorkspaceStore((state) => state.snapshot)
  const hostId = useBotWorkspaceStore((state) => state.host?.hostId)
  const steeringSupport = useBotWorkspaceStore((state) =>
    state.host?.capabilities?.includes("current-task-instructions")
  )
  const steeringTarget = steeringSupport ? botSteeringTarget(snapshot, conversationId) : undefined
  const address = botViewAddress(conversationId)
  const conversation = snapshot?.conversations.find((item) => item.id === address.conversationId)
  const mentionSupport = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("message-recipients") ?? false
  )
  const entitySupport = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("entity-references") ?? false
  )
  const members = (snapshot?.bots ?? []).filter(
    (bot) => conversation?.members.includes(bot.id) && bot.deletedAt === null
  )
  const missingRecipient = recipients.some((id) => !members.some((bot) => bot.id === id))
  const teachAvailable = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("teach-scope-v2") ?? false
  )
  const skillSupport = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("skill-references") ?? false
  )
  const prompt = draft?.prompt ?? ""
  const pluginCommand = parseBotPluginCommand(prompt)
  const commandSupport = useBotWorkspaceStore((state) =>
    state.host?.capabilities?.includes("plugin-commands")
  )
  const commandAvailable =
    conversation?.kind !== "group" &&
    members.some((bot) => bot.connectorIds?.some((id) => id.startsWith("bot-mod:")))
  const replySupport = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("message-replies") ?? false
  )
  const threadSupport = useBotWorkspaceStore((state) =>
    state.host?.capabilities?.includes("message-threads")
  )
  const disabled =
    sending ||
    uploading ||
    (Boolean(pluginCommand) && !commandSupport && !pending) ||
    (Boolean(address.threadRootId) && !threadSupport) ||
    (!pending && missingRecipient) ||
    ((!!draft?.replyToId || !!pending?.replyTo) && !replySupport) ||
    ((!!draft?.references?.length || !!pending?.references?.length) && !entitySupport) ||
    ((!!draft?.skills?.length || !!pending?.skills?.length) && !skillSupport) ||
    (!pending &&
      !prompt.trim() &&
      !draft?.attachments.length &&
      !draft?.skills?.length &&
      !draft?.references?.length)
  const skillContext = JSON.stringify([
    conversationId,
    snapshot?.dataEpoch,
    hostId,
    [...recipients].sort()
  ])
  const activeSkillPicker =
    skillPicker?.scope === skillContext &&
    skillPicker.revision === draft?.revision &&
    skillPicker.selection === JSON.stringify(selection) &&
    !sending &&
    !pending
      ? skillPicker
      : null
  const closeSkillPicker = () => {
    setSkillPicker(null)
    if (useBotWorkspaceStore.getState().selected === conversationId) input.current?.focus()
  }
  const skillsPicker = useBotSkillSuggestions({
    conversationId,
    recipients,
    prompt: selection.text,
    caret: selection.caret,
    dataEpoch: snapshot?.dataEpoch,
    hostId,
    activation: activeSkillPicker,
    enabled: Boolean(activeSkillPicker) && skillSupport,
    dismiss: closeSkillPicker,
    choose: (reference, from, to) => {
      const state = useBotWorkspaceStore.getState()
      const current = state.drafts[conversationId]
      if (
        !activeSkillPicker ||
        state.selected !== conversationId ||
        state.snapshot?.dataEpoch !== snapshot?.dataEpoch ||
        state.host?.hostId !== hostId ||
        current?.revision !== activeSkillPicker.revision ||
        activeSkillPicker.selection !== JSON.stringify(selection)
      )
        return
      const skills = current?.skills ?? []
      if (skills.length >= 6 && !skills.some((skill) => skill.id === reference.id)) {
        toast.error("每条消息最多选择 6 个技能")
        return
      }
      input.current?.insertReference({ ...reference, kind: "skill" }, from, to)
      closeSkillPicker()
    }
  })
  const mentionsPicker = useBotEntitySuggestions({
    conversationId,
    dataEpoch: snapshot?.dataEpoch,
    prompt: selection.text,
    caret: selection.caret,
    entitySupport,
    group: conversation?.kind === "group",
    members,
    enabled:
      focused &&
      (entitySupport || (mentionSupport && conversation?.kind === "group")) &&
      !sending &&
      !pending,
    choose(reference, from, to) {
      const state = useBotWorkspaceStore.getState()
      if (!reference) {
        input.current?.insertReference(
          { kind: "everyone", id: "everyone", name: "全体 Bot" },
          from,
          to
        )
      } else if (
        reference.kind === "bot" &&
        conversation?.kind === "group" &&
        members.some((bot) => bot.id === reference.id)
      ) {
        input.current?.insertReference(
          { kind: "recipient", id: reference.id, name: reference.name },
          from,
          to
        )
      } else {
        const selected = state.drafts[conversationId]?.references ?? []
        if (
          selected.length >= 12 &&
          !selected.some((item) => item.kind === reference.kind && item.id === reference.id)
        ) {
          toast.error("每条消息最多引用 12 个对象")
          return
        }
        input.current?.insertReference(reference, from, to)
      }
    }
  })
  const picker = skillsPicker.open ? skillsPicker : mentionsPicker
  const showingMentions = picker === mentionsPicker
  const pickerLabel = showingMentions ? (entitySupport ? "引用对象" : "选择 Bot") : "选择技能"

  const send = () => {
    if (disabled) return
    void useBotWorkspaceStore
      .getState()
      .send(conversationId, recipients, newTask || Boolean(pluginCommand))
      .catch((error) => {
        reportBotError(error, "消息发送失败")
      })
  }

  return (
    <div className="bot-composer-dock">
      {handoffNotice && (
        <p className="bot-send-notice" role="status">
          {handoffNotice.message}
          <button type="button" className="ml-2 underline" onClick={handoffNotice.back}>
            返回新聊天
          </button>
        </p>
      )}
      {picker.open && (
        <div className="bot-skill-suggestions">
          <div className="px-3 py-2 text-xs font-medium text-muted-foreground">{pickerLabel}</div>
          {!showingMentions && activeSkillPicker && (
            <div className="px-3 pb-2">
              <Input
                autoFocus
                aria-label="搜索技能"
                aria-controls={picker.listId}
                aria-activedescendant={
                  picker.entries.length ? `${picker.listId}-${picker.activeIndex}` : undefined
                }
                placeholder="搜索技能或 Bot 名称"
                maxLength={200}
                value={activeSkillPicker.query}
                onChange={(event) => {
                  const query = event.target.value
                  setSkillPicker((current) => (current ? { ...current, query } : null))
                }}
                onKeyDown={(event) => picker.onKeyDown(event)}
                onBlur={(event) => {
                  if (
                    !event.currentTarget
                      .closest(".bot-skill-suggestions")
                      ?.contains(event.relatedTarget)
                  )
                    setSkillPicker(null)
                }}
              />
            </div>
          )}
          {showingMentions && entitySupport && (
            <div
              className="flex gap-1 overflow-x-auto px-2 pb-2"
              role="group"
              aria-label="引用类型"
            >
              {(["all", "bot", "group", "routine", "connector"] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={mentionsPicker.category === kind}
                  className={`rounded-full px-2.5 py-1 text-xs transition-colors ${mentionsPicker.category === kind ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60"}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => mentionsPicker.setCategory(kind)}
                >
                  {kind === "all" ? "全部" : botEntityLabels[kind]}
                </button>
              ))}
            </div>
          )}
          <div id={picker.listId} role="listbox" aria-label={pickerLabel}>
            {picker.entries.map((entry, index) => (
              <button
                key={`${entry.category}:${entry.id}`}
                id={`${picker.listId}-${index}`}
                role="option"
                aria-selected={index === picker.activeIndex}
                type="button"
                className="bot-skill-option"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => picker.choose(index)}
              >
                {showingMentions ? (
                  entry.category === "all" ? (
                    <AtSign size={15} className="shrink-0 text-muted-foreground" />
                  ) : entry.category === "bot" ? (
                    <BotAvatar agentId={entry.id.slice(4)} size="xs" isStatic />
                  ) : (
                    <BotEntityIcon kind={entry.category as "group" | "routine" | "connector"} />
                  )
                ) : (
                  <Sparkles size={15} className="shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                <span className="max-w-[45%] truncate text-xs text-muted-foreground">
                  {entry.subtitle}
                </span>
              </button>
            ))}
            {!picker.entries.length && (
              <p className="px-3 pb-3 text-sm text-muted-foreground" role="status">
                {showingMentions
                  ? mentionsPicker.loading
                    ? "正在加载…"
                    : (mentionsPicker.error ?? "没有匹配的对象")
                  : skillsPicker.loading
                    ? "正在加载技能…"
                    : (skillsPicker.error ?? "没有可用的匹配技能")}
              </p>
            )}
          </div>
        </div>
      )}
      {pending && !sending && (
        <p className="bot-send-notice" role="status">
          上条消息尚未确认送达，点击重试。新输入的内容会保留。
        </p>
      )}
      {draft?.replyToId && (
        <BotComposerReply
          conversationId={conversationId}
          targetId={draft.replyToId}
          disabled={sending}
        />
      )}
      <form
        className="bot-composer"
        data-multiline={prompt.includes("\n") || undefined}
        data-commands={(commandSupport && commandAvailable) || undefined}
        data-dragging={fileInput.dragging || undefined}
        onDragEnter={fileInput.onDragEnter}
        onDragOver={fileInput.onDragOver}
        onDragLeave={fileInput.onDragLeave}
        onDrop={fileInput.onDrop}
        onSubmit={(event) => {
          event.preventDefault()
          send()
        }}
      >
        {fileInput.dragging && (
          <div className="bot-file-drop-overlay" role="status">
            <Upload size={18} />
            <span>松开以添加附件</span>
          </div>
        )}
        <BotComposerActions
          disabled={sending}
          uploading={uploading}
          group={conversation?.kind === "group"}
          members={members}
          teachAvailable={teachAvailable}
          attach={() => attachmentPicker.current?.openPicker()}
          teach={onTeach}
          selectSkills={
            skillSupport
              ? () => {
                  const state = useBotWorkspaceStore.getState()
                  if (state.selected !== conversationId) return
                  if (!state.drafts[conversationId]) state.draft(conversationId, "")
                  setSkillPicker({
                    id: ++skillPickerSequence.current,
                    scope: skillContext,
                    revision: useBotWorkspaceStore.getState().drafts[conversationId]?.revision,
                    position: selection.caret,
                    selection: JSON.stringify(selection),
                    query: ""
                  })
                }
              : undefined
          }
        />
        <BotAttachmentPicker
          ref={attachmentPicker}
          conversationId={conversationId}
          disabled={sending}
          trigger={false}
          ready={onAttachmentReady}
        />
        {commandSupport && commandAvailable && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="bot-command-button shrink-0 rounded-full text-muted-foreground"
            aria-label="查看插件命令"
            title="查看插件命令"
            disabled={sending || uploading || Boolean(pending) || Boolean(prompt.trim())}
            onClick={() => {
              useBotWorkspaceStore.getState().draft(conversationId, "/plugins")
              input.current?.focus()
            }}
          >
            <TerminalSquare size={17} />
          </Button>
        )}
        <BotPromptEditor
          key={`${conversationId}:${snapshot?.dataEpoch ?? "initial"}`}
          conversationId={conversationId}
          draft={draft ?? { prompt: "", attachments: [] }}
          controls={input}
          placeholder={
            draft?.replyToId
              ? "回复…"
              : working
                ? steeringTarget
                  ? "补充要求，或交办下一项工作…"
                  : "交办下一项工作…"
                : address.threadRootId
                  ? "在分支中交办工作…"
                  : "交办工作…"
          }
          expanded={picker.open}
          listId={picker.open ? picker.listId : undefined}
          activeOption={
            picker.open && picker.entries.length
              ? `${picker.listId}-${picker.activeIndex}`
              : undefined
          }
          onPaste={fileInput.onPaste}
          onSelection={setSelection}
          onFocus={setFocused}
          onReady={onEditorReady}
          onKeyDown={(event) => {
            if (picker.onKeyDown(event)) return true
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.isComposing &&
              event.keyCode !== 229
            ) {
              event.preventDefault()
              send()
              return true
            }
            return false
          }}
        />
        <Button
          type="submit"
          size="icon"
          className="bot-send-button"
          disabled={disabled}
          aria-label={pending && !sending ? "重试发送" : "发送"}
        >
          {sending ? (
            <Loader2 size={18} className="animate-spin" />
          ) : pending ? (
            <RotateCcw size={17} />
          ) : (
            <ArrowUp size={20} />
          )}
        </Button>
      </form>
      {steeringTarget && !pending && !pluginCommand && (
        <div className="flex items-center justify-between gap-3 px-2 pt-2 text-xs text-muted-foreground">
          <span role="status">
            {newTask ? "当前任务完成后再处理" : "补充当前任务，正在执行的操作完成后采纳"}
          </span>
          <button
            type="button"
            className="shrink-0 rounded px-2 py-1 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
            aria-pressed={newTask}
            onClick={() => setNewTask(!newTask)}
          >
            {newTask ? "改为补充当前任务" : "作为新任务排队"}
          </button>
        </div>
      )}
      <p className="bot-composer-hint">
        {pluginCommand && !pending
          ? !commandSupport
            ? "后台升级完成后可使用插件命令"
            : pluginCommand.kind === "list"
              ? "Enter 查看此 Bot 的插件命令"
              : "Enter 执行插件命令 · 当前任务完成后处理"
          : missingRecipient && !pending
            ? "所选 Bot 已不在群聊中，请重新选择接收者"
            : !replySupport && draft?.replyToId
              ? "后台升级完成后可回复消息"
              : !skillSupport && draft?.skills?.length
                ? "后台升级完成后可发送所选技能"
                : uploading
                  ? "附件上传中…"
                  : mentionSupport && conversation?.kind === "group"
                    ? "输入 @ 选择 Bot · Enter 发送"
                    : "Enter 发送 · Shift+Enter 换行"}
      </p>
    </div>
  )
}
