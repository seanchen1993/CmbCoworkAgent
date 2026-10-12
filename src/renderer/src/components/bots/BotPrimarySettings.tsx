import { useEffect, useRef, useState } from "react"
import { Check, ChevronLeft, LoaderCircle, Plus, RefreshCw, Star } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useAppStore } from "@/lib/store"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import { useBotSettingsSave } from "@/lib/use-bot-settings-save"
import { reportBotError } from "@/lib/bot-error-toast"
import {
  changeBotPrimarySettings,
  pendingBotPrimarySettings,
  readBotPrimarySettings,
  verifiesBotPrimarySettings,
  type BotPrimarySettingsInput,
  type BotPrimarySettingsView
} from "@/lib/bot-primary-pending"
import { BotDialogContent } from "./BotDialog"
import { BotAvatar } from "./BotAvatar"
import { BotCreationReview } from "./BotCreationReview"
import { BotPrimaryGuide } from "./BotPrimaryGuide"
import { BotPendingSaveRecovery } from "./BotPendingSaveRecovery"

interface PrimaryDraft {
  key: string
  selected: string | null
  creating: boolean
  name: string
  modelRef: string
  autoReviewEnabled: boolean
  goal: string
  targets: string[]
  interval: string
  enabled: boolean
}

export function BotPrimarySettings({
  close,
  initialMode = "guide"
}: {
  close(): void
  initialMode?: "guide" | "create" | "choose"
}) {
  const session = useBotSettingsSave<BotPrimarySettingsInput, BotPrimarySettingsView>({
    botId: null,
    pending: pendingBotPrimarySettings,
    read: readBotPrimarySettings,
    change: changeBotPrimarySettings,
    verifies: verifiesBotPrimarySettings,
    rejectedCodes: ["primary_tombstoned", "bot_limit", "primary_scope", "primary_peer_scope"]
  })
  const bots = useBotWorkspaceStore((state) => state.snapshot?.bots ?? [])
  const supported = useBotWorkspaceStore(
    (state) =>
      state.host?.capabilities?.includes("primary-bot-v1") &&
      state.host.capabilities.includes("mutation-data-epoch-v2")
  )
  const workspaceEpoch = useBotWorkspaceStore((state) =>
    state.error ? null : (state.snapshot?.dataEpoch ?? null)
  )
  const workspacePrimary = useBotWorkspaceStore((state) => state.snapshot?.primaryBot)
  const introductionSupported = useBotWorkspaceStore((state) =>
    state.host?.capabilities?.includes("bot-introduction-v1")
  )
  const createReviewSupported = useBotWorkspaceStore((state) =>
    state.host?.capabilities?.includes("bot-create-review-v1")
  )
  const models = useAppStore((state) => state.models)
  const main = session.value?.primary
  const currentBot = bots.find((bot) => bot.id === main?.botId)
  const [draft, setDraft] = useState<PrimaryDraft | null>(null)
  const [step, setStep] = useState(initialMode)
  const key = `${session.epoch}:${main?.revision ?? "unknown"}:${main?.checkInRevision ?? "unknown"}`
  const config = main?.checkIn?.botId === main?.botId ? main?.checkIn : null
  const defaults: PrimaryDraft = {
    key,
    selected: main?.botId ?? null,
    creating: step === "create" && main?.botId === null,
    name: "主 Bot",
    modelRef: "default",
    autoReviewEnabled: true,
    goal: config?.prompt ?? "",
    targets: config?.targetBotIds ?? [],
    interval: String(config?.everyMs ?? 1_800_000),
    enabled: config?.enabled ?? false
  }
  const {
    selected,
    creating,
    name,
    modelRef,
    autoReviewEnabled,
    goal,
    targets,
    interval,
    enabled
  } = draft?.key === key ? draft : defaults
  const updateDraft = <K extends keyof PrimaryDraft>(field: K, value: PrimaryDraft[K]) => {
    setDraft((previous) => ({ ...(previous?.key === key ? previous : defaults), [field]: value }))
  }
  const setSelected = (value: string | null) => updateDraft("selected", value)
  const setCreating = (value: boolean) => updateDraft("creating", value)
  const setName = (value: string) => updateDraft("name", value)
  const setModelRef = (value: string) => updateDraft("modelRef", value)
  const setGoal = (value: string) => updateDraft("goal", value)
  const setTargets = (value: string[]) => updateDraft("targets", value)
  const setInterval = (value: string) => updateDraft("interval", value)
  const setEnabled = (value: boolean) => updateDraft("enabled", value)
  const { load } = session
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    if (supported) void load(() => alive.current)
    return () => {
      alive.current = false
    }
  }, [load, supported])
  const disabled = session.fieldsDisabled || !supported
  const guide =
    supported &&
    !session.restored &&
    workspaceEpoch !== null &&
    workspaceEpoch === session.epoch &&
    main?.dataEpoch === session.epoch &&
    workspacePrimary?.dataEpoch === session.epoch &&
    workspacePrimary.revision === main.revision &&
    workspacePrimary.botId === main.botId &&
    main.botId === null &&
    step === "guide"
  const enter = (mode: "guide" | "create" | "choose") => {
    if (disabled) return
    setDraft(null)
    setStep(mode)
    session.clearSaved()
    session.clearError()
  }
  const identity = () => ({
    botId: null,
    revision: main!.revision,
    dataEpoch: session.epoch,
    nonce: crypto.randomUUID()
  })
  const save = async (action?: BotPrimarySettingsInput["action"]) => {
    const saved = await session.save(action ? () => ({ ...identity(), action }) : undefined)
    if (
      !saved ||
      !alive.current ||
      useBotWorkspaceStore.getState().snapshot?.dataEpoch !== session.epoch
    )
      return
    await useBotWorkspaceStore.getState().refresh({ preserveSelection: true }).catch(reportBotError)
    if (!alive.current) return
    if (action?.kind === "change" || action?.kind === "ensure") {
      const state = useBotWorkspaceStore.getState()
      const id = state.snapshot?.primaryBot?.botId
      const conversation = state.snapshot?.conversations.find(
        (item) => item.kind === "direct" && item.members[0] === id
      )
      if (id && conversation) state.select(conversation.id)
    }
  }
  const pending = session.pending
  const pendingAction = pending?.action
  const pendingModelRef = pendingAction?.kind === "ensure" ? pendingAction.profile.modelRef : null
  const pendingDescription =
    pendingAction?.kind === "change"
      ? pendingAction.targetBotId
        ? `设为主 Bot：${bots.find((bot) => bot.id === pendingAction.targetBotId)?.name ?? "已选择的 Bot"}`
        : "清除主 Bot"
      : pending?.action.kind === "ensure"
        ? `创建主 Bot：${pending.action.profile.name}`
        : "保存主动跟进设置"
  const validTargets =
    targets.length > 0 &&
    targets.length <= 20 &&
    targets.every((id) =>
      bots.some((bot) => bot.id === id && bot.id !== main?.botId && bot.deletedAt === null)
    )
  const canSaveCheckIn = Boolean(
    main?.botId && goal.trim() && (validTargets || (!enabled && main.checkIn?.botId === main.botId))
  )
  const changesRole = creating || selected !== main?.botId
  const edit = () => {
    session.clearSaved()
    session.clearError()
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !session.busy) close()
      }}
    >
      <BotDialogContent className="flex max-h-[calc(100dvh-48px)] flex-col sm:max-w-lg">
        <DialogHeader className={guide ? "sr-only" : "shrink-0 text-left"}>
          <DialogTitle className="flex items-center gap-2">
            <Star size={19} className="text-amber-500" />主 Bot
          </DialogTitle>
          <DialogDescription>
            指定一个 Bot 统筹工作，与其他 Bot 协作，向你汇报进展。
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-1 min-h-0 space-y-5 overflow-y-auto overscroll-contain px-1">
          {!supported ? (
            <p role="alert" className="text-sm text-muted-foreground">
              请更新并重启 Bot 后台后使用主 Bot。
            </p>
          ) : !main ? (
            <div
              role="status"
              className="flex items-center gap-2 py-4 text-sm text-muted-foreground"
            >
              <LoaderCircle size={16} className="animate-spin" />
              正在读取主 Bot 设置…
            </div>
          ) : guide ? (
            <BotPrimaryGuide
              botCount={bots.filter((bot) => bot.deletedAt === null).length}
              disabled={disabled}
              create={() => enter("create")}
              choose={() => enter("choose")}
            />
          ) : (
            <>
              {main.botId === null && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => enter("guide")}
                >
                  <ChevronLeft size={14} />
                  返回主 Bot 引导
                </Button>
              )}
              {currentBot && (
                <div className="flex items-center gap-3 rounded-2xl bg-muted/50 p-3">
                  <BotAvatar agentId={currentBot.id} size="md" isStatic />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{currentBot.name}</p>
                    <p className="text-xs text-muted-foreground">当前主 Bot</p>
                  </div>
                  <Star size={16} className="fill-amber-500 text-amber-500" />
                </div>
              )}
              <section className="space-y-3" aria-label="选择主 Bot">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium">
                    {main.botId ? "更换主 Bot" : "选择主 Bot"}
                  </h3>
                  {!main.botId && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={disabled}
                      onClick={() => {
                        setCreating(!creating)
                        edit()
                      }}
                    >
                      <Plus size={14} />
                      {creating ? "选择现有 Bot" : "创建主 Bot"}
                    </Button>
                  )}
                </div>
                {creating ? (
                  <div className="space-y-3">
                    <label className="block space-y-1.5 text-xs text-muted-foreground">
                      名称
                      <Input
                        aria-label="主 Bot 名称"
                        value={name}
                        maxLength={100}
                        disabled={disabled}
                        onChange={(e) => {
                          setName(e.target.value)
                          edit()
                        }}
                      />
                    </label>
                    <label className="block space-y-1.5 text-xs text-muted-foreground">
                      模型
                      <Select value={modelRef} onValueChange={setModelRef} disabled={disabled}>
                        <SelectTrigger aria-label="主 Bot 模型">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="default">使用当前默认模型</SelectItem>
                          {models.map((model) => (
                            <SelectItem key={model.id} value={model.id}>
                              {model.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </label>
                    {createReviewSupported && (
                      <BotCreationReview
                        enabled={autoReviewEnabled}
                        disabled={disabled}
                        onChange={(next) => {
                          updateDraft("autoReviewEnabled", next)
                          edit()
                        }}
                      />
                    )}
                  </div>
                ) : (
                  <Select
                    value={selected ?? "none"}
                    disabled={disabled}
                    onValueChange={(id) => {
                      setSelected(id === "none" ? null : id)
                      edit()
                    }}
                  >
                    <SelectTrigger aria-label="选择主 Bot">
                      <SelectValue placeholder="选择一个 Bot" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">不设置主 Bot</SelectItem>
                      {bots
                        .filter((bot) => bot.deletedAt === null)
                        .map((bot) => (
                          <SelectItem key={bot.id} value={bot.id}>
                            {bot.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                )}
                {changesRole && main.botId && (
                  <p className="text-xs leading-5 text-muted-foreground">
                    更换后，原主 Bot 的主动跟进会停止。你单独交办给它的任务继续保留。
                  </p>
                )}
                {changesRole && (
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      disabled={disabled || (creating && !name.trim())}
                      onClick={() =>
                        void save(
                          creating
                            ? {
                                kind: "ensure",
                                ...(introductionSupported
                                  ? { introduction: { language: "zh-CN" } }
                                  : {}),
                                profile: {
                                  name,
                                  ...(createReviewSupported ? { autoReviewEnabled } : {}),
                                  instructions: "",
                                  modelRef: modelRef === "default" ? null : modelRef,
                                  workspacePath: null
                                }
                              }
                            : { kind: "change", targetBotId: selected }
                        )
                      }
                    >
                      {creating
                        ? "创建并设为主 Bot"
                        : selected
                          ? main.botId
                            ? "确认更换"
                            : "设为主 Bot"
                          : "确认清除"}
                    </Button>
                  </div>
                )}
              </section>
              {main.botId && (
                <section className="space-y-4 border-t pt-4" aria-label="主 Bot 主动跟进">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-medium">主动跟进</h3>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        按你的目标跟进所选 Bot 的工作。有新进展时再运行。
                      </p>
                    </div>
                    <Switch
                      aria-label="启用主动跟进"
                      checked={enabled}
                      disabled={disabled || changesRole}
                      onCheckedChange={(value) => {
                        setEnabled(value)
                        edit()
                      }}
                    />
                  </div>
                  <label className="block space-y-1.5 text-xs text-muted-foreground">
                    跟进目标
                    <textarea
                      aria-label="主动跟进目标"
                      className="min-h-24 w-full resize-y rounded-xl border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
                      placeholder="例如：跟进需求分析和验证工作，提醒我需要决策的事项。"
                      value={goal}
                      maxLength={8000}
                      disabled={disabled || changesRole}
                      onChange={(e) => {
                        setGoal(e.target.value)
                        edit()
                      }}
                    />
                  </label>
                  <fieldset disabled={disabled || changesRole} className="space-y-2">
                    <legend className="mb-2 text-xs text-muted-foreground">
                      参与 Bot · 最多 20 个
                    </legend>
                    <div className="max-h-40 space-y-1 overflow-y-auto rounded-xl border p-1">
                      {bots
                        .filter((bot) => bot.id !== main.botId && bot.deletedAt === null)
                        .map((bot) => (
                          <label
                            key={bot.id}
                            className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-muted/60"
                          >
                            <input
                              type="checkbox"
                              checked={targets.includes(bot.id)}
                              disabled={!targets.includes(bot.id) && targets.length >= 20}
                              onChange={(e) => {
                                setTargets(
                                  e.target.checked
                                    ? [...targets, bot.id]
                                    : targets.filter((id) => id !== bot.id)
                                )
                                edit()
                              }}
                            />
                            <BotAvatar agentId={bot.id} size="xs" isStatic />
                            <span className="truncate text-sm">{bot.name}</span>
                          </label>
                        ))}
                      {bots.filter((bot) => bot.id !== main.botId && bot.deletedAt === null)
                        .length === 0 && (
                        <p className="p-3 text-xs text-muted-foreground">
                          创建其他 Bot 后，可以指定跟进范围。
                        </p>
                      )}
                    </div>
                  </fieldset>
                  <label className="block space-y-1.5 text-xs text-muted-foreground">
                    检查频率
                    <Select
                      value={interval}
                      disabled={disabled || changesRole}
                      onValueChange={(value) => {
                        setInterval(value)
                        edit()
                      }}
                    >
                      <SelectTrigger aria-label="主动跟进频率">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {[
                          60_000,
                          300_000,
                          900_000,
                          1_800_000,
                          3_600_000,
                          21_600_000,
                          86_400_000,
                          Number(interval)
                        ]
                          .filter((value, index, values) => values.indexOf(value) === index)
                          .sort((a, b) => a - b)
                          .map((value) => (
                            <SelectItem key={value} value={String(value)}>
                              每 {value / 60_000} 分钟
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </label>
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      disabled={disabled || changesRole || !canSaveCheckIn}
                      onClick={() =>
                        void save({
                          kind: "checkIn",
                          settings: {
                            revision: main.checkInRevision,
                            botId: main.botId!,
                            enabled,
                            prompt: goal,
                            targetBotIds: targets,
                            everyMs: Number(interval),
                            timezone:
                              main.checkIn?.timezone ??
                              Intl.DateTimeFormat().resolvedOptions().timeZone
                          }
                        })
                      }
                    >
                      保存跟进设置
                    </Button>
                  </div>
                </section>
              )}
            </>
          )}
          <BotPendingSaveRecovery
            record={session.record}
            dataEpoch={session.epoch}
            operationLabel="主 Bot 设置"
            discard={session.discard}
            onRepaired={session.refreshRecord}
          />
          {pending && (
            <section className="space-y-2 rounded-xl bg-muted/50 p-3 text-xs">
              <p>待确认：{pendingDescription}</p>
              {pending.action.kind === "checkIn" && (
                <div className="space-y-1.5 text-muted-foreground">
                  <p>
                    {pending.action.settings.enabled ? "启用" : "停用"} · 每{" "}
                    {pending.action.settings.everyMs / 60_000} 分钟
                  </p>
                  <p className="whitespace-pre-wrap break-words">
                    {pending.action.settings.prompt}
                  </p>
                  <p>
                    参与 Bot：
                    {pending.action.settings.targetBotIds
                      .map((id) => bots.find((bot) => bot.id === id)?.name ?? "已删除的 Bot")
                      .join("、")}
                  </p>
                </div>
              )}
              {pending.action.kind === "ensure" && (
                <p className="text-muted-foreground">
                  模型：
                  {pendingModelRef
                    ? (models.find((model) => model.id === pendingModelRef)?.name ??
                      "原先选择的模型")
                    : "使用当前默认模型"}
                </p>
              )}
              <p className="text-muted-foreground">重试会核对同一次操作。</p>
              <Button
                size="sm"
                variant="outline"
                disabled={session.saveDisabled}
                onClick={() => void save()}
              >
                核对并重试
              </Button>
            </section>
          )}
          {session.error && (
            <p role="alert" className="text-sm text-destructive">
              {session.error}
            </p>
          )}
          {session.saved && (
            <p
              role="status"
              className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400"
            >
              <Check size={14} />
              已保存
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center justify-between border-t pt-3">
          <Button
            variant="ghost"
            size="sm"
            disabled={session.busy || !supported || Boolean(pending)}
            onClick={() => {
              setDraft(null)
              void load()
            }}
          >
            <RefreshCw size={14} />
            刷新
          </Button>
          <Button variant="outline" size="sm" disabled={session.busy} onClick={close}>
            {session.busy ? <LoaderCircle size={14} className="animate-spin" /> : "完成"}
          </Button>
        </div>
      </BotDialogContent>
    </Dialog>
  )
}
