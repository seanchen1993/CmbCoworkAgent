import { useState, useEffect, useRef, useCallback, memo, useMemo, useSyncExternalStore } from "react"
import { useShallow } from "zustand/react/shallow"
import { ChevronDown, Check, Key, Zap, Info } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { ToggleThumb } from "@/components/ui/toggle-thumb"
import { useAppStore } from "@/lib/store"
import {
  useThreadActions,
  useThreadStateSelector,
  type ThreadState
} from "@/lib/thread-context"
import { cn } from "@/lib/utils"
import {
  resolveHydratedThreadModel,
  type ModelRoutingMode
} from "../../../../shared/thread-model-selection"
import { CustomModelDialog } from "./CustomModelDialog"
import { openClawSidebar } from "@/lib/claw-sidebar"
import { resolveModelDisplay } from "@/lib/model-display"
import {
  invalidateModelCatalogCache,
  readModelCatalogCache,
  subscribeModelCatalog,
  updateCachedRoutingMode
} from "@/lib/model-catalog-cache"

function CustomIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
    </svg>
  )
}

interface ModelSwitcherProps {
  threadId: string
  composerMode?: "chat" | "flow"
  clawDefaultModel?: string
  bindingRevision?: number
  modsEnabled?: boolean
  readOnly?: boolean
}

interface WindowToken {
  scope: string
  epoch: number
}

interface ModelDialogSession {
  token: WindowToken
  modelId?: string
  onModelSaved?: (modelId: string) => void
}

const selectCurrentModel = (state: ThreadState): string => state.currentModel
const selectRoutingResult = (state: ThreadState): ThreadState["routingResult"] =>
  state.routingResult

export const ModelSwitcher = memo(ModelSwitcherImpl)

function ModelSwitcherImpl({
  threadId,
  composerMode = "chat",
  clawDefaultModel,
  bindingRevision,
  modsEnabled = false,
  readOnly = false
}: ModelSwitcherProps): React.JSX.Element {
  const scope = JSON.stringify([
    threadId, composerMode, bindingRevision, clawDefaultModel, modsEnabled, readOnly
  ])
  const incarnation = useRef({ scope, generation: 0 })
  if (incarnation.current.scope !== scope)
    incarnation.current = { scope, generation: incarnation.current.generation + 1 }
  const scopeKey = `${scope}:${incarnation.current.generation}`
  const currentScope = useRef(scopeKey)
  currentScope.current = scopeKey
  const alive = useRef(true)
  const windowEpoch = useRef(0)
  const readSequence = useRef(0)
  const routingSequence = useRef(0)
  const popoverToken = useRef<WindowToken | null>(null)
  const dialogToken = useRef<WindowToken | null>(null)
  const renderedWindowEpoch = windowEpoch.current
  const [popoverSession, setPopoverSession] = useState<WindowToken | null>(null)
  const [dialogSession, setDialogSession] = useState<ModelDialogSession | null>(null)
  const [catalogRead, setCatalogRead] = useState({ scope: scopeKey, pending: false, error: "" })
  const [routingFailure, setRoutingFailure] = useState<{
    scope: string
    mode: ModelRoutingMode
  } | null>(null)
  const { models, threads, loadModels } = useAppStore(
    useShallow((state) => ({
      models: state.models,
      threads: state.threads,
      loadModels: state.loadModels
    }))
  )
  const modelCatalog = useSyncExternalStore(
    subscribeModelCatalog,
    readModelCatalogCache,
    readModelCatalogCache
  )
  const routingMode: ModelRoutingMode = modelCatalog?.routingMode ?? "pinned"
  const routingModeLoaded = modelCatalog !== null
  const defaultModelId = modelCatalog?.defaultModelId ?? ""
  const currentModel = useThreadStateSelector(threadId, selectCurrentModel) ?? ""
  const routingResult = useThreadStateSelector(threadId, selectRoutingResult)
  const threadActions = useThreadActions(threadId)
  const restoreCurrentModel = threadActions?.restoreCurrentModel
  const setCurrentModel = threadActions?.setCurrentModel
  const pendingBaseSelection = useRef<{ threadId: string; modelId: string } | null>(null)
  const selectBaseModel = useCallback((modelId: string) => {
    if (!setCurrentModel) return
    pendingBaseSelection.current = { threadId, modelId }
    setCurrentModel(modelId)
  }, [setCurrentModel, threadId])

  const nameModels = modelCatalog?.models ?? models
  const clawDisplay = resolveModelDisplay(clawDefaultModel, nameModels, modelCatalog !== null)
  const manualClawRepair = clawDisplay.state === "ambiguous" || clawDisplay.state === "unconfirmed"
  const showsClaw = modsEnabled && !!clawDefaultModel
  const showsFlow = modsEnabled && composerMode === "flow"
  const contextualDisplay = showsClaw || showsFlow
  const readState = catalogRead.scope === scopeKey ? catalogRead : { pending: false, error: "" }
  const failedRouting = routingFailure?.scope === scopeKey ? routingFailure : null

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      readSequence.current++
      popoverToken.current = null
      dialogToken.current = null
    }
  }, [])

  const readNames = useCallback(async (force = false): Promise<void> => {
    if (!alive.current || currentScope.current !== scopeKey) return
    const sequence = ++readSequence.current
    const live = () => alive.current && currentScope.current === scopeKey &&
      readSequence.current === sequence
    setCatalogRead((old) => ({
      scope: scopeKey,
      pending: true,
      error: old.scope === scopeKey ? old.error : ""
    }))
    try {
      await loadModels(force)
      if (live()) setCatalogRead({ scope: scopeKey, pending: false, error: "" })
    } catch {
      if (live()) setCatalogRead({
        scope: scopeKey, pending: false, error: "上次名称读取失败，可重试"
      })
    } finally {
      if (live()) setCatalogRead((old) => ({ ...old, pending: false }))
    }
  }, [loadModels, scopeKey])

  useEffect(() => {
    setPopoverSession((old) => old?.scope === scopeKey ? old : null)
    setDialogSession((old) => old?.token.scope === scopeKey ? old : null)
    void readNames()
  }, [scopeKey, readNames])

  // Smart routing requires both a premium-tier and an economy-tier model to be configured
  const hasEconomyModel = models.some((m) => m.tier === "economy")
  const hasPremiumModel = models.some((m) => !m.tier || m.tier === "premium")
  // canEnableRouting: both tiers must be present (models without tier default to premium)
  const canEnableRouting = hasEconomyModel && hasPremiumModel

  // Resolve display name for the auto-routed model
  const routedModelName = routingResult
    ? resolveModelDisplay(routingResult.resolvedModelId, nameModels, modelCatalog !== null).name
    : null
  const routedTierLabel = routingResult?.resolvedTier === "economy" ? "经济" : routingResult?.resolvedTier === "premium" ? "强力" : null

  const threadSummary = useMemo(
    () => threads.find((thread) => thread.thread_id === threadId) ?? null,
    [threadId, threads]
  )
  const hydratedModel = useMemo(
    () =>
      routingModeLoaded
        ? resolveHydratedThreadModel(threadSummary?.metadata, routingMode)
        : { modelId: null },
    [routingMode, routingModeLoaded, threadSummary]
  )
  const effectiveCurrentModel = currentModel || hydratedModel.modelId || ""
  const persistedManualModel = typeof threadSummary?.metadata?.model === "string"
    ? threadSummary.metadata.model.trim()
    : ""
  if (pendingBaseSelection.current && (
    pendingBaseSelection.current.threadId !== threadId ||
    pendingBaseSelection.current.modelId === persistedManualModel
  )) pendingBaseSelection.current = null
  const manualModel = pendingBaseSelection.current?.modelId || persistedManualModel
  const baseReference = contextualDisplay ? manualModel || currentModel : currentModel
  const baseDisplay = resolveModelDisplay(baseReference, nameModels, modelCatalog !== null)
  const clawTransition = useRef({ threadId, applied: showsClaw, pending: false })
  const hydratedSource = useRef<string | null>(null)

  useEffect(() => {
    const transition = clawTransition.current
    if (transition.threadId !== threadId) {
      clawTransition.current = { threadId, applied: showsClaw, pending: false }
      return
    }
    if (transition.applied && !showsClaw) transition.pending = true
    transition.applied = showsClaw
    if (showsClaw) transition.pending = false
    if (!transition.pending || !routingModeLoaded) return
    if (routingMode === "pinned" && !restoreCurrentModel) return
    transition.pending = false
    // A routing_result also changes the temporary model in pinned mode. Removing
    // a Claw must restore manual intent without persisting a new user selection.
    if (routingMode === "pinned" && manualModel)
      restoreCurrentModel?.(manualModel)
  }, [currentModel, manualModel, restoreCurrentModel, routingMode, routingModeLoaded,
    showsClaw, threadId])

  useEffect(() => {
    if (!routingModeLoaded || !restoreCurrentModel) return
    const source = JSON.stringify([threadId, routingMode, hydratedModel.modelId])
    if (hydratedSource.current === source) return
    // Consume metadata before restoring it. Local fallback/manual selection can
    // precede its async metadata write; replaying the old source would undo that
    // selection and oscillate with the missing-model fallback below.
    hydratedSource.current = source
    // A just-selected base model can precede its metadata acknowledgement.
    // Consuming the old source must not undo that intent when names first load.
    if (pendingBaseSelection.current?.threadId === threadId) return
    if (hydratedModel.modelId && hydratedModel.modelId !== currentModel) {
      // Hydration only restores the model used by the current view. Persisting here
      // would turn a read-only session open into an updated_at change.
      restoreCurrentModel?.(hydratedModel.modelId)
    }
  }, [
    currentModel,
    hydratedModel.modelId,
    restoreCurrentModel,
    routingMode,
    routingModeLoaded,
    threadId
  ])

  useEffect(() => {
    if (!routingModeLoaded || models.length === 0) return

    const hasValidSelection =
      effectiveCurrentModel && models.some((m) => m.id === effectiveCurrentModel)
    if (!hasValidSelection && effectiveCurrentModel.startsWith("custom:")) {
      const legacyModelName = effectiveCurrentModel.slice("custom:".length)
      const migrated = models.find((m) => m.model === legacyModelName)
      if (migrated) {
        selectBaseModel(migrated.id)
        return
      }
    }

    if (!hasValidSelection) {
      const preferred =
        models.find((model) => model.id === defaultModelId && model.available) ??
        models.find((model) => model.available)
      if (preferred) selectBaseModel(preferred.id)
    }
  }, [defaultModelId, effectiveCurrentModel, models, routingModeLoaded, selectBaseModel])

  function liveWindow(token: WindowToken | null, current: WindowToken | null): boolean {
    return !!token && !!current && alive.current && token.scope === currentScope.current &&
      token.scope === current.scope && token.epoch === current.epoch
  }

  function changePopover(isOpen: boolean): void {
    if (!alive.current || currentScope.current !== scopeKey) return
    if (isOpen) {
      if (windowEpoch.current !== renderedWindowEpoch) return
      if (liveWindow(popoverSession, popoverToken.current)) return
      const token = { scope: scopeKey, epoch: ++windowEpoch.current }
      popoverToken.current = token
      setPopoverSession(token)
    } else if (liveWindow(popoverSession, popoverToken.current)) {
      popoverToken.current = null
      setPopoverSession(null)
    }
  }

  function handleModelSelect(modelId: string): void {
    if (!liveWindow(popoverSession, popoverToken.current)) return
    selectBaseModel(modelId)
    changePopover(false)
  }

  function openModelDialog(purpose: "base" | "claw"): void {
    if (!liveWindow(popoverSession, popoverToken.current)) return
    if (purpose === "claw" && manualClawRepair) {
      openClawSidebar("configuration")
      return
    }
    const token = { scope: scopeKey, epoch: ++windowEpoch.current }
    const modelId = purpose === "claw"
      ? clawDisplay.matchedModelId ?? clawDefaultModel
      : baseDisplay.matchedModelId ?? (baseReference || undefined)
    popoverToken.current = null
    setPopoverSession(null)
    dialogToken.current = token
    setDialogSession({
      token,
      modelId,
      ...(purpose === "base" && setCurrentModel ? { onModelSaved: selectBaseModel } : {})
    })
  }

  async function changeRoutingMode(next: ModelRoutingMode): Promise<void> {
    if (!liveWindow(popoverSession, popoverToken.current) ||
      !canEnableRouting || !routingModeLoaded) return
    const sequence = ++routingSequence.current
    const live = () => alive.current && currentScope.current === scopeKey &&
      routingSequence.current === sequence
    setRoutingFailure(null)
    const modeTicket = threadActions?.beginRoutingModeChange?.()
    updateCachedRoutingMode(next)
    try {
      await window.api.routing.setMode(next)
      if (modeTicket) threadActions?.finishRoutingModeChange?.(modeTicket, next)
    } catch {
      if (modeTicket) threadActions?.finishRoutingModeChange?.(modeTicket)
      if (live()) setRoutingFailure({ scope: scopeKey, mode: next })
    }
  }

  return (
    <>
      {contextualDisplay && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 max-w-64 gap-1.5 px-2 text-xs text-muted-foreground"
          title={showsFlow
            ? "步骤可以各用不同模型，查看右侧流程设置。"
            : "组合默认使用这个模型；修改后需要保存并确认应用。"}
          onClick={() => {
            if (alive.current && currentScope.current === scopeKey)
              openClawSidebar(showsFlow ? "run" : "configuration")
          }}
        >
          <CustomIcon className="size-3.5 shrink-0" />
          <span className="truncate">
            {showsFlow ? "模型按步骤设置" : `当前组合模型：${clawDisplay.name}`}
          </span>
          {!showsFlow && clawDisplay.note && (
            <span className="shrink-0 text-[10px]">{clawDisplay.note}</span>
          )}
        </Button>
      )}
      <Popover
        open={liveWindow(popoverSession, popoverToken.current)}
        onOpenChange={changePopover}
      >
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 px-2 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          >
            {contextualDisplay ? (
              <span>原聊天模型与智能路由</span>
            ) : routingMode === "auto" ? (
              <>
                <Zap className="size-3.5 text-amber-500" />
                <span className="text-amber-600 dark:text-amber-400">智能路由</span>
                {routedModelName && routedTierLabel && (
                  <span className="text-muted-foreground">
                    → {routedModelName}（{routedTierLabel}）
                  </span>
                )}
              </>
            ) : currentModel ? (
              <>
                <CustomIcon className="size-3.5" />
                <span>{baseDisplay.name}</span>
                {baseDisplay.note && <span className="text-[10px]">{baseDisplay.note}</span>}
              </>
            ) : (
              <span>选择模型</span>
            )}
            <ChevronDown className="size-3" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-[280px] p-2 bg-background border-border"
          align="start"
          sideOffset={8}
        >
          {contextualDisplay && (
            <div className="mb-1 border-b px-2 pb-2 text-[11px] leading-5 text-muted-foreground">
              <p>这里调整原聊天模型和全局智能路由，不会修改组合或流程步骤。</p>
              <p>原聊天模型：{baseDisplay.name}</p>
              {routingMode === "auto" && routedModelName && (
                <p>普通聊天的路由候选：{routedModelName}</p>
              )}
            </div>
          )}
          {readState.error && (
            <div role="status" className="mb-2 px-2 text-[11px] text-amber-700 dark:text-amber-400">
              <p>{readState.error}</p>
              <button
                type="button"
                className="mt-1 underline underline-offset-2 disabled:opacity-50"
                disabled={readState.pending}
                onClick={() => {
                  if (liveWindow(popoverSession, popoverToken.current)) void readNames(true)
                }}
              >
                重试读取名称
              </button>
            </div>
          )}
          {modelCatalog === null && !readState.error && (
            <p className="px-2 pb-2 text-[11px] text-muted-foreground">名称尚未取得</p>
          )}
          {failedRouting && (
            <div role="status" className="mb-2 px-2 text-[11px] text-amber-700 dark:text-amber-400">
              <p>智能路由设置失败，请重试</p>
              <button
                type="button"
                className="mt-1 underline underline-offset-2"
                onClick={() => void changeRoutingMode(failedRouting.mode)}
              >
                重试设置智能路由
              </button>
            </div>
          )}
          {/* Auto routing toggle */}
          <div className="flex items-center justify-between px-2 py-1.5 mb-1 border-b border-border">
            <div className="flex items-center gap-1.5">
              <Zap
                className={cn(
                  "size-3.5",
                  canEnableRouting ? "text-amber-500" : "text-muted-foreground/40"
                )}
              />
              <span
                className={cn(
                  "text-xs font-medium",
                  !canEnableRouting && "text-muted-foreground/60"
                )}
              >
                智能路由
              </span>
              <div className="group relative shrink-0">
                <Info className="size-3.5 text-muted-foreground/40 hover:text-muted-foreground/70 cursor-default transition-colors" />
                <div className="pointer-events-none absolute bottom-full left-0 mb-2 w-64 rounded-md border border-border bg-popover px-3 py-2 text-[11px] leading-5 text-muted-foreground shadow-md opacity-0 group-hover:opacity-100 transition-opacity z-50">
                  {canEnableRouting
                    ? "开启后根据任务复杂度自动选择模型：强力档处理复杂任务（代码、分析），经济档处理简单任务（问答、翻译）"
                    : "需要同时配置强力和经济两个档位的模型，才能开启智能路由。"}
                </div>
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-label="智能路由"
              aria-checked={routingMode === "auto"}
              disabled={!canEnableRouting || !routingModeLoaded}
              onClick={() => {
                const next: ModelRoutingMode = routingMode === "auto" ? "pinned" : "auto"
                void changeRoutingMode(next)
              }}
              className={cn(
                "relative inline-flex h-4 w-7 flex-shrink-0 rounded-full border-2 border-transparent transition-colors",
                !canEnableRouting
                  ? "cursor-not-allowed bg-muted-foreground/20"
                  : routingMode === "auto"
                    ? "cursor-pointer bg-amber-500"
                    : "cursor-pointer bg-muted-foreground/30"
              )}
            >
              <ToggleThumb
                className={cn(
                  "inline-block h-3 w-3 transform shadow",
                  routingMode === "auto" ? "translate-x-3" : "translate-x-0"
                )}
              />
            </button>
          </div>

          {models.length > 0 ? (
            <div className="space-y-0.5">
              {models.map((model) => (
                <button
                  key={model.id}
                  onClick={() => {
                    if (model.available) handleModelSelect(model.id)
                  }}
                  disabled={!model.available}
                  title={model.available ? undefined : "请先在模型配置中填写 API 密钥"}
                  className={cn(
                    "w-full flex items-center gap-1.5 px-2 py-1.5 rounded-sm text-xs transition-colors text-left font-mono disabled:cursor-not-allowed disabled:opacity-50",
                    baseReference === model.id
                      ? "bg-muted text-foreground"
                      : model.available
                        ? "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                        : "text-muted-foreground"
                  )}
                >
                  <CustomIcon className="size-3.5 shrink-0" />
                  <span className="flex-1 truncate">
                    {model.name}
                    {!model.available ? "（未配置密钥）" : ""}
                  </span>
                  <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">
                    {model.source === "builtin" ? "内置" : "自定义"}
                  </span>
                  {baseReference === model.id && (
                    <Check className="size-3.5 shrink-0 text-foreground" />
                  )}
                </button>
              ))}

              <button
                type="button"
                onClick={() => openModelDialog("base")}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-sm text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors mt-1 border-t border-border pt-2"
              >
                <Key className="size-3.5" />
                <span>{contextualDisplay ? "编辑原聊天模型配置" : "编辑模型配置"}</span>
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-6 px-4 text-center">
              <Key className="size-6 text-muted-foreground mb-2" />
              <p className="text-xs text-muted-foreground mb-3">
                {modelCatalog === null ? "名称尚未取得" : "已取得列表中没有模型"}
              </p>
              <Button
                size="sm"
                onClick={() => openModelDialog("base")}
              >
                去配置模型
              </Button>
            </div>
          )}
          {showsClaw && (
            <div className="mt-2 border-t px-2 pt-2 text-xs">
              <p className="text-muted-foreground">组合默认：{clawDisplay.name}</p>
              {clawDisplay.note && <p className="mt-1 text-[11px]">{clawDisplay.note}</p>}
              {manualClawRepair && (
                <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                  {clawDisplay.state === "ambiguous"
                    ? "此引用对应多个条目。"
                    : "名称尚未确认，不能自动定位配置条目。"}
                  请通过这里的模型配置入口手动核对，
                  或在“助手组合”选择明确的模型，再保存并确认应用。
                  下方入口只打开配置工作台，不会替你选择条目。
                </p>
              )}
              <button
                type="button"
                className="mt-2 flex items-center gap-2 rounded-sm py-1 text-muted-foreground hover:text-foreground"
                onClick={() => openModelDialog("claw")}
              >
                <Key className="size-3.5" />
                编辑组合模型配置
              </button>
              <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                请先核对模型配置条目。保存配置不会应用组合；新建模型后，
                需在“助手组合”重新选择并确认应用。
              </p>
            </div>
          )}
        </PopoverContent>
      </Popover>

      {dialogSession && liveWindow(dialogSession.token, dialogToken.current) && (
        <CustomModelDialog
          key={`${dialogSession.token.scope}:${dialogSession.token.epoch}`}
          open
          selectedModelId={dialogSession.modelId}
          onModelSaved={(modelId) => {
            if (liveWindow(dialogSession.token, dialogToken.current))
              dialogSession.onModelSaved?.(modelId)
          }}
          onOpenChange={(isOpen) => {
            if (!liveWindow(dialogSession.token, dialogToken.current) || isOpen) return
            dialogToken.current = null
            setDialogSession(null)
            invalidateModelCatalogCache()
            void readNames(true)
          }}
        />
      )}
    </>
  )
}
