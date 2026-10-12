import { botApi } from "@/lib/bot-api"
import { useLayoutEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem
} from "@/components/ui/select"
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { BotDialogContent as DialogContent } from "./BotDialog"
import { BotPendingSaveRecovery } from "./BotPendingSaveRecovery"
import { BotCreationReview } from "./BotCreationReview"
import { BotPersonaChooser } from "./BotPersonaChooser"
import { BotModelChecks } from "./BotModelChecks"
import { BotConnectorPicker } from "./BotConnectorPicker"
import { BotHarnessBindingPicker } from "./BotHarnessBindingPicker"
import { resolvePersonaColor, resolvePersonaShape } from "./upstream/grok-persona-geometry"
import type { BotAvatarColor, BotAvatarShape } from "../../../../shared/bot-persona"
import { BotDomainError, type CoworkBot } from "../../../../shared/bot-types"
import { useAppStore } from "@/lib/store"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import {
  acknowledgePendingBot,
  readPendingBot,
  rememberPendingBot,
  inspectPendingBot,
  type PendingBotSave
} from "@/lib/bot-editor-pending"

const definitiveErrors = new Set([
  "invalid_input",
  "revision_conflict",
  "not_found",
  "nonce_conflict",
  "bot_busy",
  "bot_limit"
])
const inputClass =
  "w-full rounded-lg border border-input bg-background px-3 py-2 text-sm leading-relaxed outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"

export function BotEditor({
  bot,
  close,
  created
}: {
  bot?: CoworkBot
  close(): void
  created(id: string): void
}) {
  const dataEpoch = useBotWorkspaceStore((state) => state.snapshot?.dataEpoch ?? "initial")
  const [editingEpoch] = useState(dataEpoch)
  const [authorityRetired, setAuthorityRetired] = useState(false)
  const [pending] = useState(() => readPendingBot(bot?.id, editingEpoch))
  const [blocked, setBlocked] = useState(() => {
    const record = inspectPendingBot(bot?.id, editingEpoch)
    return record.kind === "valid" || record.kind === "empty" ? null : record
  })
  const [acknowledged, setAcknowledged] = useState<{
    input: PendingBotSave
    conversationId?: string
    rejected?: string
  } | null>(null)
  const [navigationOrigin] = useState(() => ({
    selected: useBotWorkspaceStore.getState().selected,
    lease: useBotWorkspaceStore.getState().viewportLease
  }))
  const alive = useRef(true)
  useLayoutEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const [base, setBase] = useState(bot)
  const seed = pending ?? bot
  const [name, setName] = useState(seed?.name ?? "新 Bot")
  const [title, setTitle] = useState(seed?.title ?? "")
  const [autoReviewEnabled, setAutoReviewEnabled] = useState(pending?.autoReviewEnabled ?? !pending)
  const [instructions, setInstructions] = useState(seed?.instructions ?? "")
  const [modelRef, setModelRef] = useState(seed?.modelRef ?? "")
  const sharedWorkspace = useBotWorkspaceStore((state) => state.host?.sharedWorkspace)
  const [workspace, setWorkspace] = useState(
    seed?.workspacePath === sharedWorkspace ? "" : (seed?.workspacePath ?? "")
  )
  const [connectorIds, setConnectorIds] = useState(seed?.connectorIds ?? [])
  const [harnessBinding, setHarnessBinding] = useState(seed?.harnessBinding ?? null)
  const [harnessValid, setHarnessValid] = useState(true)
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState<PendingBotSave | null>(pending)
  const [failure, setFailure] = useState<string | null>(null)
  const models = useAppStore((state) => state.models)
  const modelChecks = useBotWorkspaceStore((state) =>
    state.host?.capabilities?.includes("model-checks")
  )
  const supportsUpdate = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("bot-update-receipts") ?? false
  )
  const supportsTitle = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("bot-profile-title") ?? false
  )
  const supportsMutationEpoch = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("mutation-data-epoch-v2") ?? false
  )
  const supportsIntroduction = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("bot-introduction-v1") ?? false
  )
  const supportsCreateReview = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("bot-create-review-v1") ?? false
  )
  const supportsScopedCreate = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("scoped-bot-create") ?? false
  )
  const supportsHarness = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("harness-context") ?? false
  )
  const latest = useBotWorkspaceStore((state) =>
    state.snapshot?.bots.find((item) => item.id === bot?.id)
  )
  const botLimit = useBotWorkspaceStore((state) => state.host?.limits?.bots)
  const botCount = useBotWorkspaceStore((state) => state.snapshot?.bots.length ?? 0)
  const atLimit = !bot && botLimit !== undefined && botCount >= botLimit
  const [personaSeed] = useState(() => pending?.nonce ?? crypto.randomUUID())
  const [persona, setPersona] = useState<{
    shape: BotAvatarShape | null
    color: BotAvatarColor | null
  }>(() => ({
    shape: seed ? (seed.avatarShape ?? null) : (resolvePersonaShape(personaSeed) as BotAvatarShape),
    color: seed ? (seed.avatarColor ?? null) : (resolvePersonaColor(personaSeed) as BotAvatarColor)
  }))
  const inFlight = useRef(false)
  const restored = authorityRetired || editingEpoch !== dataEpoch
  const stale = Boolean(base && latest?.revision !== base.revision)
  const unsupportedHarness = Boolean(
    harnessBinding &&
    !supportsHarness &&
    (!base || JSON.stringify(harnessBinding) !== JSON.stringify(base.harnessBinding ?? null))
  )
  const unsupported = Boolean(
    !supportsMutationEpoch ||
    (!bot && !supportsScopedCreate) ||
    (bot && !supportsUpdate) ||
    unsupportedHarness
  )
  const fieldsDisabled =
    busy ||
    restored ||
    unsupported ||
    Boolean(uncertain) ||
    Boolean(acknowledged) ||
    Boolean(blocked)
  const cannotSave =
    busy ||
    restored ||
    unsupported ||
    Boolean(blocked) ||
    (!uncertain && !acknowledged && (stale || atLimit || !name.trim() || !harnessValid))
  const reload = () => {
    if (!latest) return
    setBase(latest)
    setName(latest.name)
    setTitle(latest.title ?? "")
    setInstructions(latest.instructions)
    setModelRef(latest.modelRef ?? "")
    setWorkspace(latest.workspacePath === sharedWorkspace ? "" : (latest.workspacePath ?? ""))
    setConnectorIds(latest.connectorIds ?? [])
    setHarnessBinding(latest.harnessBinding ?? null)
    setPersona({
      shape: latest.avatarShape ?? null,
      color: latest.avatarColor ?? null
    })
    setFailure(null)
  }
  const currentEpoch = () => useBotWorkspaceStore.getState().snapshot?.dataEpoch === editingEpoch
  const live = () => alive.current && currentEpoch()
  const finish = async (saved: {
    input: PendingBotSave
    conversationId?: string
    rejected?: string
  }) => {
    // Preserve the original request when this receipt belongs to a replaced database.
    if (!currentEpoch()) return
    if (!acknowledgePendingBot(saved.input, editingEpoch)) {
      if (live())
        setFailure(
          saved.rejected
            ? "后台已拒绝保存，本机操作记录尚未清除。重试只核对已完成记录。"
            : "Bot 已保存，本机操作记录尚未清除。重试只核对已完成记录。"
        )
      return
    }
    if (!live()) return
    if (saved.rejected) {
      if (live()) {
        setAcknowledged(null)
        setUncertain(null)
        setFailure(saved.rejected)
      }
      void useBotWorkspaceStore
        .getState()
        .refresh()
        .catch(() => {})
      return
    }
    try {
      await useBotWorkspaceStore.getState().refresh()
    } catch {
      if (live()) setFailure("Bot 已保存，列表同步失败。重试只重新读取列表。")
      return
    }
    if (!live()) return
    const current = useBotWorkspaceStore.getState()
    if (
      saved.conversationId &&
      current.selected === navigationOrigin.selected &&
      current.viewportLease?.generation === navigationOrigin.lease?.generation
    )
      created(saved.conversationId)
    close()
  }
  const save = async () => {
    if (inFlight.current || cannotSave || !live()) return
    inFlight.current = true
    setBusy(true)
    setFailure(null)
    try {
      if (acknowledged) {
        await finish(acknowledged)
        return
      }
      const values = {
        nonce: crypto.randomUUID(),
        name: name.trim(),
        ...(supportsTitle ? { title: title.trim() } : {}),
        expectedDataEpoch: editingEpoch,
        instructions,
        modelRef: modelRef || null,
        workspacePath: workspace.trim() || null,
        connectorIds,
        harnessBinding,
        avatarShape: bot
          ? persona.shape
          : (resolvePersonaShape(personaSeed, persona.shape) as BotAvatarShape),
        avatarColor: bot
          ? persona.color
          : (resolvePersonaColor(personaSeed, persona.color) as BotAvatarColor)
      }
      const input: PendingBotSave =
        uncertain ??
        (base
          ? { ...values, id: base.id, revision: base.revision }
          : {
              ...values,
              ...(supportsCreateReview ? { autoReviewEnabled } : {}),
              ...(supportsIntroduction ? { introduction: { language: "zh-CN" } } : {})
            })
      if (input.autoReviewEnabled !== undefined && !supportsCreateReview) {
        if (live()) setFailure("这次创建包含操作审核设置，请连接支持此功能的后台后核对原请求。")
        return
      }
      if (input.introduction && !supportsIntroduction) {
        if (live()) setFailure("这次创建包含首次介绍，请连接支持此功能的后台后核对原请求。")
        return
      }
      try {
        rememberPendingBot(input, editingEpoch)
      } catch (error) {
        if (live()) setFailure(error instanceof Error ? error.message : "无法保留保存记录")
        return
      }
      try {
        let conversationId: string | undefined
        if (!live()) return
        if (input.id !== undefined) await botApi.update(input)
        else conversationId = (await botApi.create(input)).conversationId
        const saved = { input, conversationId }
        if (live()) {
          setAcknowledged(saved)
          setUncertain(null)
        }
        await finish(saved)
      } catch (error) {
        const code = error instanceof BotDomainError ? error.code : undefined
        if (code === "data_epoch" || code === "workspace_replaced") {
          if (live()) {
            setAuthorityRetired(true)
            setUncertain(input)
            setFailure("工作区数据已恢复，原保存记录已保留。请关闭后重新打开，核对或归档原记录。")
          }
          return
        }
        const mayHaveSaved = !definitiveErrors.has(code ?? "")
        const cleared =
          !mayHaveSaved && currentEpoch() && acknowledgePendingBot(input, editingEpoch)
        if (!live()) return
        if (!mayHaveSaved && !cleared) {
          const rejectedSave = {
            input,
            rejected: error instanceof Error ? error.message : "Bot 保存失败"
          }
          setAcknowledged(rejectedSave)
          setUncertain(null)
          await finish(rejectedSave)
          return
        }
        setUncertain(cleared ? null : input)
        setFailure(
          mayHaveSaved
            ? "尚未收到保存结果。重试会核对同一次保存。"
            : error instanceof Error
              ? error.message
              : "Bot 保存失败"
        )
        if (cleared)
          void useBotWorkspaceStore
            .getState()
            .refresh()
            .catch(() => {})
      }
    } finally {
      inFlight.current = false
      if (alive.current) setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !inFlight.current) close()
      }}
    >
      <DialogContent className="bot-editor-dialog">
        <DialogHeader>
          <DialogTitle>{bot ? "Bot 设置" : "创建 Bot"}</DialogTitle>
          <DialogDescription>指定职责后，可以持续向这个 Bot 交办工作。</DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <div className="bot-editor-fields min-h-0 space-y-5 overflow-y-auto px-1 pb-1">
            {blocked && (
              <BotPendingSaveRecovery
                record={blocked}
                id={bot?.id}
                dataEpoch={editingEpoch}
                onRepaired={() => setBlocked(null)}
              />
            )}
            {unsupported && (
              <p role="alert" className="text-sm text-destructive">
                {unsupportedHarness
                  ? "当前后台不支持新增或修改项目绑定；原绑定保持不变时可以保存其他 Bot 设置。"
                  : "请先在设置中重启后台，再保存 Bot 修改。"}
              </p>
            )}
            {restored && (
              <p role="alert" className="text-sm text-destructive">
                工作区数据已恢复，请关闭后重新打开 Bot 设置。
              </p>
            )}
            {stale && !uncertain && (
              <div role="status" className="space-y-2 rounded-xl border bg-muted/40 p-3 text-sm">
                <p>
                  {latest
                    ? "Bot 已更新，当前草稿已保留。载入最新版本后再修改。"
                    : "Bot 已不可用，无法保存当前修改。"}
                </p>
                {latest && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={reload}
                  >
                    载入最新版本，替换草稿
                  </Button>
                )}
              </div>
            )}
            {failure && (
              <p role="alert" className="text-sm text-destructive">
                {failure}
              </p>
            )}
            {uncertain && !failure && (
              <p role="status" className="text-sm text-muted-foreground">
                有一次保存尚未确认，请重试核对。关闭窗口不会撤销已提交的修改。
              </p>
            )}
            <BotPersonaChooser
              agentId={bot?.id ?? personaSeed}
              shape={persona.shape}
              color={persona.color}
              disabled={fieldsDisabled}
              onChange={setPersona}
            />
            {bot?.avatarHash && (
              <p className="text-center text-xs text-muted-foreground">
                当前使用图片头像；在 Bot 菜单中移除图片后，将显示这里设置的形象。
              </p>
            )}
            <label className="block space-y-1.5 text-sm">
              <span>名称</span>
              <Input
                autoFocus
                disabled={fieldsDisabled}
                className="rounded-lg shadow-none"
                maxLength={100}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            {supportsTitle && (
              <label className="block space-y-1.5 text-sm">
                <span>
                  标签 <span className="text-xs text-muted-foreground">可选</span>
                </span>
                <Input
                  maxLength={200}
                  value={title}
                  disabled={fieldsDisabled}
                  className="rounded-lg shadow-none"
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="例如：项目评审助手"
                />
              </label>
            )}
            <label className="block space-y-1.5 text-sm">
              <span>描述与职责</span>
              <textarea
                className={inputClass}
                rows={4}
                maxLength={32_000}
                disabled={fieldsDisabled}
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                placeholder="例如：协助维护项目文档，检查变更并整理评审材料。"
              />
            </label>
            <div className="space-y-1.5 text-sm">
              <span id="bot-editor-model-label">模型</span>
              <Select
                value={modelRef ? `model:${modelRef}` : "default"}
                disabled={fieldsDisabled}
                onValueChange={(value) => setModelRef(value === "default" ? "" : value.slice(6))}
              >
                <SelectTrigger
                  aria-labelledby="bot-editor-model-label"
                  className="rounded-lg shadow-none"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">使用 CMBDevClaw 默认模型</SelectItem>
                  {modelRef && !models.some((model) => model.id === modelRef) && (
                    <SelectItem value={`model:${modelRef}`} disabled>
                      当前模型不可用 · {modelRef}
                    </SelectItem>
                  )}
                  {models.map((model) => (
                    <SelectItem key={model.id} value={`model:${model.id}`}>
                      {model.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {modelChecks && <BotModelChecks key={modelRef} modelRef={modelRef || null} />}
            {!bot && supportsCreateReview && (
              <BotCreationReview
                enabled={autoReviewEnabled}
                onChange={setAutoReviewEnabled}
                disabled={fieldsDisabled}
              />
            )}
            <label className="block space-y-1.5 text-sm">
              <span>
                项目工作目录 <span className="text-xs text-muted-foreground">可选</span>
              </span>
              <Input
                value={workspace}
                maxLength={4096}
                disabled={fieldsDisabled}
                className="rounded-lg shadow-none"
                onChange={(event) => setWorkspace(event.target.value)}
                placeholder={sharedWorkspace ? "使用 Bot 共享工作目录" : "可稍后指定"}
                aria-describedby={sharedWorkspace ? "bot-workspace-description" : undefined}
              />
            </label>
            {sharedWorkspace && (
              <div
                id="bot-workspace-description"
                className="-mt-3 text-xs leading-relaxed text-muted-foreground"
              >
                <p>留空使用共享工作目录，多个 Bot 可共同处理其中的文件。</p>
                {!workspace && (
                  <details className="mt-1.5">
                    <summary className="w-fit cursor-pointer rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring">
                      查看共享目录位置
                    </summary>
                    <p className="mt-2 rounded-lg bg-muted/40 p-2.5 break-all font-mono text-[11px] select-text">
                      {sharedWorkspace}
                    </p>
                  </details>
                )}
              </div>
            )}
            {!supportsHarness && harnessBinding && (
              <div
                role="status"
                className="space-y-1 rounded-xl border p-3 text-xs text-muted-foreground"
              >
                <p>原项目绑定已保留，当前后台不会执行项目命令检查。</p>
                <p className="break-words">
                  {harnessBinding.projectId}
                  {harnessBinding.featureSlug ? ` · ${harnessBinding.featureSlug}` : ""}
                </p>
              </div>
            )}
            {supportsHarness && (
              <BotHarnessBindingPicker
                value={harnessBinding}
                onChange={setHarnessBinding}
                onWorkspace={setWorkspace}
                onValidity={setHarnessValid}
                disabled={fieldsDisabled}
              />
            )}
            <BotConnectorPicker
              selected={connectorIds}
              onChange={setConnectorIds}
              disabled={fieldsDisabled}
            />
          </div>
          <div className="flex shrink-0 justify-end gap-2 border-t border-border/60 pt-4">
            {!bot && botLimit !== undefined && (
              <p
                className="mr-auto self-center text-xs text-muted-foreground"
                role={atLimit ? "status" : undefined}
              >
                {atLimit ? "已达创建上限" : "已创建"} {botCount} / {botLimit} 个 Bot
              </p>
            )}
            <Button type="button" variant="ghost" onClick={close} disabled={busy}>
              {uncertain ? "稍后核对" : "取消"}
            </Button>
            <Button disabled={cannotSave}>
              {busy
                ? "保存中…"
                : acknowledged
                  ? "核对已完成操作记录"
                  : uncertain
                    ? "重试核对保存"
                    : "保存"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
