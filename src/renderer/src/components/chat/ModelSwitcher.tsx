import {
  useState,
  useEffect,
  memo,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode
} from "react"
import { toast } from "sonner"
import { useShallow } from "zustand/react/shallow"
import { ChevronDown, ChevronRight, Check, Key, Zap, Info } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { ToggleThumb } from "@/components/ui/toggle-thumb"
import { useAppStore } from "@/lib/store"
import { useThreadActions, useThreadStateSelector, type ThreadState } from "@/lib/thread-context"
import { cn } from "@/lib/utils"
import {
  resolveHydratedThreadModel,
  resolveBotWorkViewModel,
  type ModelRoutingMode
} from "../../../../shared/thread-model-selection"
import { botWorkModelRoutingMode, isBotCreatedWorkMetadata, resolveLegacyBotWorkModelRef } from "../../../../shared/bots/model-policy"
import { CustomModelDialog } from "./CustomModelDialog"
import { IDLE_MODEL_OUTSIDE_HOURS_MESSAGE } from "../../../../shared/idle-model-service-window"
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
  variant?: "composer" | "menu"
  onSelect?(): void
  /** Keep model hydration and the configuration dialog mounted outside a collapsible menu. */
  children?(picker: ReactNode): ReactNode
}

const selectCurrentModel = (state: ThreadState): string => state.currentModel
const selectRoutingResult = (state: ThreadState): ThreadState["routingResult"] =>
  state.routingResult

export const ModelSwitcher = memo(ModelSwitcherImpl)

function ModelSwitcherImpl({
  threadId,
  variant = "composer",
  onSelect,
  children
}: ModelSwitcherProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [customDialogOpen, setCustomDialogOpen] = useState(false)
  const [dialogModelId, setDialogModelId] = useState<string | undefined>(undefined)
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
  const globalRoutingMode: ModelRoutingMode = modelCatalog?.routingMode ?? "pinned"
  const routingModeLoaded = modelCatalog !== null
  const defaultModelId = modelCatalog?.defaultModelId ?? ""
  const currentModel = useThreadStateSelector(threadId, selectCurrentModel) ?? ""
  const routingResult = useThreadStateSelector(threadId, selectRoutingResult)
  const threadActions = useThreadActions(threadId)
  const restoreCurrentModel = threadActions?.restoreCurrentModel
  const setCurrentModel = threadActions?.setCurrentModel

  useEffect(() => {
    void loadModels()
  }, [loadModels])

  // Smart routing requires both a premium-tier and an economy-tier model to be configured
  const hasEconomyModel = models.some((m) => m.tier === "economy")
  const hasPremiumModel = models.some((m) => !m.tier || m.tier === "premium")
  // canEnableRouting: both tiers must be present (models without tier default to premium)
  const canEnableRouting = hasEconomyModel && hasPremiumModel

  const threadSummary = useMemo(
    () => threads.find((thread) => thread.thread_id === threadId) ?? null,
    [threadId, threads]
  )
  const localBotRouting = isBotCreatedWorkMetadata(threadSummary?.metadata)
  const routingMode = botWorkModelRoutingMode(threadSummary?.metadata) ?? globalRoutingMode
  const routingToggleOn = localBotRouting
    ? threadSummary?.metadata?.botWorkModelRoutingMode === "default" ||
      (threadSummary?.metadata?.botWorkModelRoutingMode == null && globalRoutingMode === "auto")
    : routingMode === "auto"
  const canToggleRouting = localBotRouting || canEnableRouting
  const [savingModel, setSavingModel] = useState(false)
  const visibleThread = useRef(threadId)
  visibleThread.current = threadId
  const availableDefaultModelId =
    models.find((model) => model.id === defaultModelId && model.available)?.id ??
    models.find((model) => model.available)?.id ?? ""
  const hydratedModel = useMemo(
    () =>
      routingModeLoaded
        ? resolveHydratedThreadModel(threadSummary?.metadata, routingMode, availableDefaultModelId)
        : { modelId: null, routingResult: null },
    [routingMode, routingModeLoaded, threadSummary, availableDefaultModelId]
  )
  // A Bot work can hydrate while global mode is pinned and no catalog is loaded.
  // Keep its actual last route visible even if that hydration had no model to select.
  const displayedRoutingResult = routingResult ?? (localBotRouting ? hydratedModel.routingResult : null)
  const routedModelName = displayedRoutingResult
    ? (models.find((m) => m.id === displayedRoutingResult.resolvedModelId)?.name ??
      displayedRoutingResult.resolvedModelId.replace(/^(?:custom|builtin):/, ""))
    : null
  const routedTierLabel = displayedRoutingResult?.resolvedTier === "economy" ? "经济" : displayedRoutingResult?.resolvedTier === "premium" ? "强力" : null
  const botViewModel = localBotRouting
    ? resolveBotWorkViewModel(routingMode, displayedRoutingResult?.resolvedModelId || "", threadSummary?.metadata, models, availableDefaultModelId)
    : ""
  const legacyBotRef = threadSummary?.metadata?.botWorkModelRoutingMode == null &&
    botViewModel.startsWith("custom:") && !models.some(model => model.id === botViewModel)
    ? botViewModel : null
  const [legacyBotSelection, setLegacyBotSelection] = useState<{
    ref: string; resolved: string; catalog: typeof modelCatalog
  } | null>(null)
  useEffect(() => {
    if (!routingModeLoaded || !legacyBotRef) return
    let current = true
    // This existing read-only API preserves registry order when providers share
    // an API model name. Do not migrate metadata or silently choose the default.
    void window.api.models.getCustomConfigs().then(configs => {
      if (current) setLegacyBotSelection({ ref: legacyBotRef,
        resolved: resolveLegacyBotWorkModelRef(legacyBotRef, configs), catalog: modelCatalog })
    }).catch(() => {})
    return () => { current = false }
  }, [legacyBotRef, modelCatalog, routingModeLoaded])
  const effectiveCurrentModel = localBotRouting
    ? legacyBotSelection?.ref === botViewModel && legacyBotSelection.catalog === modelCatalog
      ? legacyBotSelection.resolved : botViewModel
    : currentModel || hydratedModel.modelId || ""
  const selectedModel = models.find((m) => m.id === effectiveCurrentModel)

  const restoredSelectionRef = useRef<{
    threadId: string
    routingMode: ModelRoutingMode
    modelId: string | null
  } | null>(null)


  useEffect(() => {
    if (!localBotRouting) return
    const nextModel = effectiveCurrentModel
    if (nextModel && nextModel !== currentModel) {
      // Hydration only restores the model used by the current view. Persisting here
      // would turn a read-only session open into an updated_at change.
      restoreCurrentModel?.(nextModel)
    }
  }, [currentModel, hydratedModel.modelId, restoreCurrentModel, localBotRouting, effectiveCurrentModel])

  useEffect(() => {
    if (localBotRouting) return
    if (!routingModeLoaded || !restoreCurrentModel || !setCurrentModel) return

    const previous = restoredSelectionRef.current
    const selectionChanged =
      previous?.threadId !== threadId ||
      previous.routingMode !== routingMode ||
      previous.modelId !== hydratedModel.modelId
    restoredSelectionRef.current = { threadId, routingMode, modelId: hydratedModel.modelId }

    // Restore each persisted selection once. A fallback or manual choice updates
    // local state before its metadata IPC completes; restoring the stale ID on
    // every local change would fight that choice and can trigger React #185.
    const candidate = selectionChanged
      ? hydratedModel.modelId || currentModel
      : currentModel || hydratedModel.modelId || ""
    let resolvedModel = candidate

    const hasValidSelection = candidate && models.some((model) => model.id === candidate)
    if (!hasValidSelection && models.length > 0) {
      const migrated = candidate.startsWith("custom:")
        ? models.find((model) => model.model === candidate.slice("custom:".length))
        : undefined
      resolvedModel =
        migrated?.id ??
        models.find((model) => model.id === defaultModelId && model.available)?.id ??
        models.find((model) => model.available)?.id ??
        candidate
    }

    if (resolvedModel !== candidate) {
      setCurrentModel(resolvedModel)
    } else if (resolvedModel && resolvedModel !== currentModel) {
      // Restoring an existing selection must not refresh the thread's updated_at.
      restoreCurrentModel(resolvedModel)
    }
  }, [
    currentModel,
    defaultModelId,
    hydratedModel.modelId,
    models,
    restoreCurrentModel,
    routingMode,
    routingModeLoaded,
    setCurrentModel,
    threadId
    , localBotRouting
  ])

  async function saveBotModelChoice(mode: "default" | "pinned", modelId?: string): Promise<void> {
    if (savingModel) return
    setSavingModel(true)
    try {
      // Reuse the existing metadata mutation/identity fence. Never change global routing here.
      await useAppStore.getState().patchThreadMetadata(threadId, {
        set: { botWorkModelRoutingMode: mode, ...(modelId ? { model: modelId } : {}) }
      })
      if (visibleThread.current === threadId && modelId) restoreCurrentModel?.(modelId)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "模型设置未保存，请重试。")
    } finally {
      setSavingModel(false)
    }
  }

  function handleModelSelect(modelId: string): void {
    if (localBotRouting) void saveBotModelChoice("pinned", modelId)
    else setCurrentModel?.(modelId)
    setOpen(false)
    onSelect?.()
  }

  const menu = variant === "menu"
  const modelLabel = routingMode === "auto" ? "智能路由" : (selectedModel?.name ?? "选择模型")
  const picker = (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={
            menu
              ? "h-auto w-full justify-start gap-2 rounded-md px-2 py-2 text-sm font-normal hover:bg-muted"
              : "h-8 gap-1.5 px-2 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          }
          aria-label={menu ? `切换模型：${modelLabel}` : undefined}
        >
          {menu ? (
            <>
              <CustomIcon className="size-3.5 shrink-0" />
              <span className="shrink-0">切换模型</span>
              <span
                className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground"
                title={modelLabel}
              >
                {modelLabel}
              </span>
              <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
            </>
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
          ) : selectedModel ? (
            <>
              <CustomIcon className="size-3.5" />
              <span>{selectedModel.name}</span>
            </>
          ) : (
            <span>选择模型</span>
          )}
          {!menu && <ChevronDown className="size-3" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className={cn(
          "w-[280px] max-w-[calc(100vw-32px)] p-2 bg-background border-border",
          menu && "rounded-xl"
        )}
        align="start"
        side={menu ? "left" : "bottom"}
        sideOffset={8}
      >
        {/* Auto routing toggle */}
          <div className="flex items-center justify-between px-2 py-1.5 mb-1 border-b border-border">
            <div className="flex items-center gap-1.5">
              <Zap
                className={cn(
                  "size-3.5",
                  canToggleRouting ? "text-amber-500" : "text-muted-foreground/40"
                )}
              />
              <span
                className={cn(
                  "text-xs font-medium",
                  !canToggleRouting && "text-muted-foreground/60"
                )}
              >
                {localBotRouting ? "跟随全局模型策略" : "智能路由（全局）"}
              </span>
              <div className="group relative shrink-0">
                <Info className="size-3.5 text-muted-foreground/40 hover:text-muted-foreground/70 cursor-default transition-colors" />
                <div className="pointer-events-none absolute bottom-full left-0 mb-2 w-64 rounded-md border border-border bg-popover px-3 py-2 text-[11px] leading-5 text-muted-foreground shadow-md opacity-0 group-hover:opacity-100 transition-opacity z-50">
                  {localBotRouting
                    ? "开启时沿用全局路由策略；关闭时固定此任务的模型。不会修改全局设置。"
                    : canEnableRouting
                    ? "开启后根据任务复杂度自动选择模型：强力档处理复杂任务（代码、分析），经济档处理简单任务（问答、翻译）"
                    : "需要同时配置强力和经济两个档位的模型，才能开启智能路由。"}
                </div>
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={routingToggleOn}
              aria-label={localBotRouting ? "跟随全局模型策略" : "智能路由（全局）"}
              disabled={!canToggleRouting || !routingModeLoaded || savingModel ||
                (localBotRouting && routingToggleOn && !selectedModel?.available)}
              onClick={() => {
                if (!canToggleRouting || !routingModeLoaded) return
                if (localBotRouting) {
                  const next = routingToggleOn ? "pinned" : "default"
                  void saveBotModelChoice(next, next === "pinned" ? effectiveCurrentModel : undefined)
                  return
                }
                const next: ModelRoutingMode = routingMode === "auto" ? "pinned" : "auto"
                updateCachedRoutingMode(next)
                void window.api.routing.setMode(next)
              }}
              className={cn(
                "relative inline-flex h-4 w-7 flex-shrink-0 rounded-full border-2 border-transparent transition-colors",
                !canToggleRouting
                  ? "cursor-not-allowed bg-muted-foreground/20"
                  : routingToggleOn
                    ? "cursor-pointer bg-amber-500"
                    : "cursor-pointer bg-muted-foreground/30"
              )}
            >
              <ToggleThumb
                className={cn(
                  "inline-block h-3 w-3 transform shadow",
                  routingToggleOn ? "translate-x-3" : "translate-x-0"
                )}
              />
            </button>
          </div>

          {models.length > 0 ? (
          <div className={cn("space-y-0.5", menu && "max-h-[60vh] overflow-y-auto")}>
            {models.map((model) => (
              <button
                key={model.id}
                onClick={() => {
                  if (model.selectable ?? model.available) handleModelSelect(model.id)
                }}
                disabled={!(model.selectable ?? model.available)}
                title={
                  model.unavailableReason ??
                  (model.available ? model.notice : "请先在模型配置中填写 API 密钥")
                }
                className={cn(
                  "w-full flex items-center gap-1.5 px-2 py-1.5 rounded-sm text-xs transition-colors text-left font-mono disabled:cursor-not-allowed disabled:opacity-50",
                  currentModel === model.id
                    ? "bg-muted text-foreground"
                    : (model.selectable ?? model.available)
                      ? "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                      : "text-muted-foreground"
                )}
              >
                <CustomIcon className="size-3.5 shrink-0" />
                <span className="flex-1 truncate">
                  {model.name}
                  {!model.available
                    ? model.unavailableReason === IDLE_MODEL_OUTSIDE_HOURS_MESSAGE
                      ? "（非服务时段）"
                      : model.unavailableReason
                        ? "（用户信息不完整）"
                        : "（未配置密钥）"
                    : ""}
                </span>
                <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">
                  {model.source === "builtin" ? "内置" : "自定义"}
                </span>
                {currentModel === model.id && (
                  <Check className="size-3.5 shrink-0 text-foreground" />
                )}
              </button>
            ))}
            {selectedModel?.notice && (
              <p className="px-2 py-1.5 text-[11px] leading-5 text-muted-foreground">
                {selectedModel.notice}
              </p>
            )}

            <button
              onClick={() => {
                setOpen(false)
                setDialogModelId(currentModel || undefined)
                setCustomDialogOpen(true)
              }}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-sm text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors mt-1 border-t border-border pt-2"
            >
              <Key className="size-3.5" />
              <span>编辑模型配置</span>
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-6 px-4 text-center">
            <Key className="size-6 text-muted-foreground mb-2" />
            <p className="text-xs text-muted-foreground mb-3">尚未配置模型</p>
            <Button
              size="sm"
              onClick={() => {
                setOpen(false)
                setDialogModelId(undefined)
                setCustomDialogOpen(true)
              }}
            >
              去配置模型
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )

  return (
    <>
      {children ? children(picker) : picker}
      <CustomModelDialog
        open={customDialogOpen}
        selectedModelId={dialogModelId}
        onModelSaved={(modelId) => {
          // Managing provider configuration is not selecting this work's model.
          if (!localBotRouting) setCurrentModel?.(modelId)
        }}
        onOpenChange={(isOpen) => {
          setCustomDialogOpen(isOpen)
          if (!isOpen) {
            setDialogModelId(undefined)
            invalidateModelCatalogCache()
            void loadModels(true)
          }
        }}
      />
    </>
  )
}
