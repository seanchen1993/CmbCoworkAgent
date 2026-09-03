import { useState, useEffect, memo, useMemo, useSyncExternalStore } from "react"
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
}

const selectCurrentModel = (state: ThreadState): string => state.currentModel
const selectRoutingResult = (state: ThreadState): ThreadState["routingResult"] =>
  state.routingResult

export const ModelSwitcher = memo(ModelSwitcherImpl)

function ModelSwitcherImpl({ threadId }: ModelSwitcherProps): React.JSX.Element {
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
  const routingMode: ModelRoutingMode = modelCatalog?.routingMode ?? "pinned"
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

  const selectedModel = models.find((m) => m.id === currentModel)

  // Smart routing requires both a premium-tier and an economy-tier model to be configured
  const hasEconomyModel = models.some((m) => m.tier === "economy")
  const hasPremiumModel = models.some((m) => !m.tier || m.tier === "premium")
  // canEnableRouting: both tiers must be present (models without tier default to premium)
  const canEnableRouting = hasEconomyModel && hasPremiumModel

  // Resolve display name for the auto-routed model
  const routedModelName = routingResult
    ? (models.find((m) => m.id === routingResult.resolvedModelId)?.name ??
      routingResult.resolvedModelId.replace(/^(?:custom|builtin):/, ""))
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

  useEffect(() => {
    if (hydratedModel.modelId && hydratedModel.modelId !== currentModel) {
      // Hydration only restores the model used by the current view. Persisting here
      // would turn a read-only session open into an updated_at change.
      restoreCurrentModel?.(hydratedModel.modelId)
    }
  }, [currentModel, hydratedModel.modelId, restoreCurrentModel])

  useEffect(() => {
    if (!routingModeLoaded || models.length === 0) return

    const hasValidSelection =
      effectiveCurrentModel && models.some((m) => m.id === effectiveCurrentModel)
    if (!hasValidSelection && effectiveCurrentModel.startsWith("custom:")) {
      const legacyModelName = effectiveCurrentModel.slice("custom:".length)
      const migrated = models.find((m) => m.model === legacyModelName)
      if (migrated) {
        setCurrentModel?.(migrated.id)
        return
      }
    }

    if (!hasValidSelection) {
      const preferred =
        models.find((model) => model.id === defaultModelId && model.available) ??
        models.find((model) => model.available)
      if (preferred) setCurrentModel?.(preferred.id)
    }
  }, [defaultModelId, effectiveCurrentModel, models, routingModeLoaded, setCurrentModel])

  function handleModelSelect(modelId: string): void {
    setCurrentModel?.(modelId)
    setOpen(false)
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 px-2 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          >
            {routingMode === "auto" ? (
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
            <ChevronDown className="size-3" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-[280px] p-2 bg-background border-border"
          align="start"
          sideOffset={8}
        >
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
              disabled={!canEnableRouting || !routingModeLoaded}
              onClick={() => {
                if (!canEnableRouting || !routingModeLoaded) return
                const next: ModelRoutingMode = routingMode === "auto" ? "pinned" : "auto"
                updateCachedRoutingMode(next)
                void window.api.routing.setMode(next)
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
                    currentModel === model.id
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
                  {currentModel === model.id && (
                    <Check className="size-3.5 shrink-0 text-foreground" />
                  )}
                </button>
              ))}

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

      <CustomModelDialog
        open={customDialogOpen}
        selectedModelId={dialogModelId}
        onModelSaved={(modelId) => {
          setCurrentModel?.(modelId)
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
