import { useState, useEffect } from "react"
import { Eye, EyeOff, Info, Loader2, Lock, Plus, RotateCcw, Trash2, Zap } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

interface CustomModelDialogProps {
  open: boolean
  selectedModelId?: string
  onModelSaved?: (modelId: string) => void
  onOpenChange: (open: boolean) => void
}

type ThinkingEffort = "high" | "max"

interface CustomConfig {
  id?: string
  source: "builtin" | "custom"
  origin?: "remote" | "fallback"
  name: string
  baseUrl: string
  model: string
  apiKey: string
  maxTokensInput: string
  maxOutputTokensInput: string
  temperatureInput: string
  topPInput: string
  topKInput: string
  interleavedThinking: boolean
  enableThinking: boolean
  enableThinkingEffort: boolean
  thinkingEffort: ThinkingEffort
  tier: "premium" | "economy"
}

interface TokenLimits {
  defaultMaxTokens: number
  minMaxTokens: number
  maxMaxTokens: number
  defaultMaxOutputTokens: number
  minMaxOutputTokens: number
  maxMaxOutputTokens: number
  defaultTemperature: number
  maxTemperature: number
  defaultTopP: number
  maxTopP: number
  defaultTopK: number
  minTopK: number
  maxTopK: number
}

interface CustomModelItem {
  id: string
  source: "builtin" | "custom"
  origin?: "remote" | "fallback"
  name: string
  baseUrl: string
  model: string
  hasApiKey: boolean
  maxTokens: number
  maxOutputTokens: number
  temperature: number
  topP: number
  topK: number
  interleavedThinking?: boolean
  enableThinking?: boolean
  enableThinkingEffort?: boolean
  thinkingEffort?: ThinkingEffort
  tier?: "premium" | "economy"
}

const FALLBACK_LIMITS: TokenLimits = {
  defaultMaxTokens: 128_000,
  minMaxTokens: 32_000,
  maxMaxTokens: 1_000_000,
  defaultMaxOutputTokens: 8_192,
  minMaxOutputTokens: 1,
  maxMaxOutputTokens: 100_000,
  defaultTemperature: 0.1,
  maxTemperature: 2,
  defaultTopP: 0.95,
  maxTopP: 1,
  defaultTopK: 40,
  minTopK: 0,
  maxTopK: 1_000
}

const DEFAULT_THINKING_EFFORT: ThinkingEffort = "high"
const THINKING_EFFORT_OPTIONS: Array<{ value: ThinkingEffort; label: string }> = [
  { value: "high", label: "High" },
  { value: "max", label: "Max" }
]

function ParameterLabel({
  children,
  explanation
}: {
  children: string
  explanation: string
}): React.JSX.Element {
  return (
    <label className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
      <span>{children}</span>
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="inline-flex size-3.5 cursor-default items-center justify-center rounded-full text-muted-foreground/45 transition-colors hover:text-muted-foreground"
              aria-label={`${children} 参数说明`}
            >
              <Info className="size-3.5" />
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6} className="max-w-64 text-xs leading-relaxed">
            {explanation}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </label>
  )
}

function defaultInterleavedThinkingForModel(model: string): boolean {
  return /minimax/i.test(model)
}

function defaultSamplingForModel(
  model: string,
  limits: TokenLimits
): Pick<CustomConfig, "temperatureInput" | "topPInput" | "topKInput"> {
  const isMinimaxModel = /minimax/i.test(model)
  return {
    temperatureInput: String(isMinimaxModel ? 1.0 : limits.defaultTemperature),
    topPInput: String(limits.defaultTopP),
    topKInput: String(limits.defaultTopK)
  }
}

function emptyConfig(limits: TokenLimits): CustomConfig {
  return {
    id: undefined,
    source: "custom",
    name: "",
    baseUrl: "",
    model: "",
    apiKey: "",
    maxTokensInput: String(limits.defaultMaxTokens),
    maxOutputTokensInput: String(limits.defaultMaxOutputTokens),
    temperatureInput: String(limits.defaultTemperature),
    topPInput: String(limits.defaultTopP),
    topKInput: String(limits.defaultTopK),
    interleavedThinking: false,
    enableThinking: false,
    enableThinkingEffort: false,
    thinkingEffort: DEFAULT_THINKING_EFFORT,
    tier: "premium"
  }
}

function configFromItem(item: CustomModelItem, limits: TokenLimits): CustomConfig {
  return {
    id: item.id,
    source: item.source,
    origin: item.origin,
    name: item.name,
    baseUrl: item.baseUrl,
    model: item.model,
    apiKey: "",
    maxTokensInput: String(item.maxTokens ?? limits.defaultMaxTokens),
    maxOutputTokensInput: String(item.maxOutputTokens ?? limits.defaultMaxOutputTokens),
    temperatureInput: String(item.temperature ?? limits.defaultTemperature),
    topPInput: String(item.topP ?? limits.defaultTopP),
    topKInput: String(item.topK ?? limits.defaultTopK),
    interleavedThinking: item.interleavedThinking ?? defaultInterleavedThinkingForModel(item.model),
    enableThinking: item.enableThinking === true,
    enableThinkingEffort: item.enableThinkingEffort === true,
    thinkingEffort: item.thinkingEffort ?? DEFAULT_THINKING_EFFORT,
    tier: item.tier ?? "premium"
  }
}

async function loadModelItems(): Promise<CustomModelItem[]> {
  const [builtin, custom] = await Promise.all([
    window.api.models.getBuiltinConfigs(),
    window.api.models.getCustomConfigs()
  ])
  return [
    ...builtin.map((item) => ({ ...item, source: "builtin" as const })),
    ...custom.map((item) => ({ ...item, source: "custom" as const }))
  ]
}

function parseMaxTokens(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (!/^\d+$/.test(trimmed)) return null

  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed)) return null
  return parsed
}

function getMaxTokensError(value: string, limits: TokenLimits): string | null {
  const parsed = parseMaxTokens(value)
  if (parsed === null) return "请输入上下文窗口大小"
  if (parsed < limits.minMaxTokens || parsed > limits.maxMaxTokens) {
    return `上下文窗口大小必须在 ${limits.minMaxTokens.toLocaleString()} 到 ${limits.maxMaxTokens.toLocaleString()} 之间`
  }
  return null
}

function parseMaxOutputTokens(value: string): number | null {
  return parseMaxTokens(value)
}

function getMaxOutputTokensError(value: string, limits: TokenLimits): string | null {
  const parsed = parseMaxOutputTokens(value)
  if (parsed === null) return "请输入最大 Tokens"
  if (parsed < limits.minMaxOutputTokens || parsed > limits.maxMaxOutputTokens) {
    return `最大 Tokens 必须在 ${limits.minMaxOutputTokens.toLocaleString()} 到 ${limits.maxMaxOutputTokens.toLocaleString()} 之间`
  }
  return null
}

function parseTemperature(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) return null
  return parsed
}

function getTemperatureError(value: string, limits: TokenLimits): string | null {
  const parsed = parseTemperature(value)
  if (parsed === null) return "请输入 Temperature"
  if (parsed <= 0 || parsed > limits.maxTemperature) {
    return `Temperature 必须在 (0, ${limits.maxTemperature}] 之间`
  }
  return null
}

function parseTopP(value: string): number | null {
  return parseTemperature(value)
}

function getTopPError(value: string, limits: TokenLimits): string | null {
  const parsed = parseTopP(value)
  if (parsed === null) return "请输入 top_p"
  if (parsed <= 0 || parsed > limits.maxTopP) {
    return `top_p 必须在 (0, ${limits.maxTopP}] 之间`
  }
  return null
}

function parseTopK(value: string): number | null {
  return parseMaxTokens(value)
}

function getTopKError(value: string, limits: TokenLimits): string | null {
  const parsed = parseTopK(value)
  if (parsed === null) return "请输入 top_k"
  if (parsed < limits.minTopK || parsed > limits.maxTopK) {
    return `top_k 必须在 ${limits.minTopK.toLocaleString()} 到 ${limits.maxTopK.toLocaleString()} 之间`
  }
  return null
}

export function CustomModelDialog({
  open,
  selectedModelId,
  onModelSaved,
  onOpenChange
}: CustomModelDialogProps): React.JSX.Element {
  const [config, setConfig] = useState<CustomConfig>(() => emptyConfig(FALLBACK_LIMITS))
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{
    success: boolean
    error?: string
    latencyMs?: number
  } | null>(null)
  const [hasExisting, setHasExisting] = useState(false)
  const [hasExistingKey, setHasExistingKey] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [tokenLimits, setTokenLimits] = useState<TokenLimits>(FALLBACK_LIMITS)
  const [allConfigs, setAllConfigs] = useState<CustomModelItem[]>([])
  const [defaultModelId, setDefaultModelId] = useState("")
  const [defaultModelDraftId, setDefaultModelDraftId] = useState("")

  useEffect(() => {
    let cancelled = false

    if (open) {
      setShowKey(false)
      setFormError(null)
      setTestResult(null)

      const selectedSource = selectedModelId?.startsWith("builtin:")
        ? "builtin"
        : selectedModelId?.startsWith("custom:")
          ? "custom"
          : undefined
      const normalizedSelectedId = selectedModelId?.replace(/^(?:custom|builtin):/, "")
      void Promise.all([
        window.api.models.getTokenLimits(),
        loadModelItems(),
        window.api.models.getDefault()
      ])
        .then(([limits, all, savedDefaultModelId]) => {
          if (cancelled) return
          setTokenLimits(limits)
          setAllConfigs(all)
          setDefaultModelId(savedDefaultModelId || "")
          setDefaultModelDraftId(savedDefaultModelId || "")

          const resolvedExisting = normalizedSelectedId
            ? all.find(
                (item) =>
                  (!selectedSource || item.source === selectedSource) &&
                  (item.id === normalizedSelectedId || item.model === normalizedSelectedId)
              ) || null
            : all[0] || null

          if (resolvedExisting) {
            setConfig(configFromItem(resolvedExisting, limits))
            setHasExisting(true)
            setHasExistingKey(resolvedExisting.hasApiKey)
          } else {
            setConfig(emptyConfig(limits))
            setHasExisting(false)
            setHasExistingKey(false)
          }
        })
        .catch((error) => {
          console.error("[CustomModelDialog] Failed to load model settings:", error)
        })
    }

    return () => {
      cancelled = true
    }
  }, [open, selectedModelId])

  const selectedConfigKey = config.id ? `${config.source}:${config.id}` : ""

  async function selectConfigToEdit(id: string, source: "builtin" | "custom"): Promise<void> {
    setFormError(null)
    setTestResult(null)
    const picked = allConfigs.find((item) => item.id === id && item.source === source)
    if (!picked) return
    setConfig(configFromItem(picked, tokenLimits))
    setHasExisting(true)
    setHasExistingKey(picked.hasApiKey)
    setShowKey(false)
    setDefaultModelDraftId(defaultModelId)
  }

  const currentModelStorageId = config.id ? `${config.source}:${config.id}` : ""
  const isDefaultModel =
    currentModelStorageId !== "" && currentModelStorageId === defaultModelDraftId
  const isPersistedDefaultModel =
    currentModelStorageId !== "" && currentModelStorageId === defaultModelId

  const maxTokensError = getMaxTokensError(config.maxTokensInput, tokenLimits)
  const maxOutputTokensError = getMaxOutputTokensError(config.maxOutputTokensInput, tokenLimits)
  const temperatureError = getTemperatureError(config.temperatureInput, tokenLimits)
  const topPError = getTopPError(config.topPInput, tokenLimits)
  const topKError = getTopKError(config.topKInput, tokenLimits)
  const canToggleKeyVisibility = config.apiKey.trim().length > 0
  const duplicateNameError =
    config.name.trim() &&
    allConfigs.some(
      (item) =>
        item.source === config.source && item.name === config.name.trim() && item.id !== config.id
    )
      ? "显示名称不能重复，请使用不同的显示名称"
      : null

  const canSave =
    config.name.trim() &&
    config.baseUrl.trim() &&
    config.model.trim() &&
    (hasExistingKey || config.apiKey.trim()) &&
    !maxTokensError &&
    !maxOutputTokensError &&
    !temperatureError &&
    !topPError &&
    !topKError &&
    !duplicateNameError

  const canTest =
    config.baseUrl.trim() &&
    config.model.trim() &&
    (hasExistingKey || config.apiKey.trim()) &&
    !maxOutputTokensError &&
    !temperatureError &&
    !topPError &&
    !topKError

  async function handleTest(): Promise<void> {
    if (!canTest || testing || saving || deleting) return
    setTesting(true)
    setTestResult(null)
    setFormError(null)
    try {
      const parsedMaxOutputTokens = parseMaxOutputTokens(config.maxOutputTokensInput)
      if (parsedMaxOutputTokens === null) {
        setFormError("请输入有效的最大 Tokens")
        return
      }
      const parsedTemperature = parseTemperature(config.temperatureInput)
      if (parsedTemperature === null) {
        setFormError("请输入有效的 Temperature")
        return
      }
      const parsedTopP = parseTopP(config.topPInput)
      if (parsedTopP === null) {
        setFormError("请输入有效的 top_p")
        return
      }
      const parsedTopK = parseTopK(config.topKInput)
      if (parsedTopK === null) {
        setFormError("请输入有效的 top_k")
        return
      }
      const result = await window.api.models.testConnection({
        id: config.id
          ? config.source === "builtin"
            ? `builtin:${config.id}`
            : config.id
          : undefined,
        baseUrl: config.source === "builtin" ? undefined : config.baseUrl.trim(),
        model: config.source === "builtin" ? undefined : config.model.trim(),
        apiKey: config.source === "builtin" ? undefined : config.apiKey.trim() || undefined,
        maxOutputTokens: parsedMaxOutputTokens,
        temperature: parsedTemperature,
        topP: parsedTopP,
        topK: parsedTopK,
        enableThinking: config.enableThinking,
        enableThinkingEffort: config.enableThinking && config.enableThinkingEffort,
        thinkingEffort: config.thinkingEffort
      })
      setTestResult(result)
    } catch (e) {
      setTestResult({
        success: false,
        error: e instanceof Error ? e.message : "测试失败"
      })
    } finally {
      setTesting(false)
    }
  }

  async function handleSave(): Promise<void> {
    if (!canSave) {
      if (maxTokensError) setFormError(maxTokensError)
      else if (maxOutputTokensError) setFormError(maxOutputTokensError)
      else if (temperatureError) setFormError(temperatureError)
      else if (topPError) setFormError(topPError)
      else if (topKError) setFormError(topKError)
      else if (duplicateNameError) setFormError(duplicateNameError)
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      const parsedMaxTokens = parseMaxTokens(config.maxTokensInput)
      if (parsedMaxTokens === null) {
        setFormError("请输入有效的上下文窗口大小")
        return
      }
      const parsedMaxOutputTokens = parseMaxOutputTokens(config.maxOutputTokensInput)
      if (parsedMaxOutputTokens === null) {
        setFormError("请输入有效的最大 Tokens")
        return
      }
      const parsedTemperature = parseTemperature(config.temperatureInput)
      if (parsedTemperature === null) {
        setFormError("请输入有效的 Temperature")
        return
      }
      const parsedTopP = parseTopP(config.topPInput)
      if (parsedTopP === null) {
        setFormError("请输入有效的 top_p")
        return
      }
      const parsedTopK = parseTopK(config.topKInput)
      if (parsedTopK === null) {
        setFormError("请输入有效的 top_k")
        return
      }

      let savedId: string
      if (config.source === "builtin") {
        if (!config.id) throw new Error("内置模型 ID 不能为空")
        await window.api.models.updateBuiltinConfig(config.id, {
          name: config.name.trim(),
          maxTokens: parsedMaxTokens,
          maxOutputTokens: parsedMaxOutputTokens,
          temperature: parsedTemperature,
          topP: parsedTopP,
          topK: parsedTopK,
          enableThinking: config.enableThinking,
          enableThinkingEffort: config.enableThinking && config.enableThinkingEffort,
          thinkingEffort: config.thinkingEffort,
          interleavedThinking: config.interleavedThinking,
          tier: config.tier
        })
        savedId = config.id
      } else {
        const result = await window.api.models.upsertCustomConfig({
          id: config.id,
          name: config.name.trim(),
          baseUrl: config.baseUrl.trim(),
          model: config.model.trim(),
          apiKey: config.apiKey.trim() || undefined,
          maxTokens: parsedMaxTokens,
          maxOutputTokens: parsedMaxOutputTokens,
          temperature: parsedTemperature,
          topP: parsedTopP,
          topK: parsedTopK,
          enableThinking: config.enableThinking,
          enableThinkingEffort: config.enableThinking && config.enableThinkingEffort,
          thinkingEffort: config.thinkingEffort,
          interleavedThinking: config.interleavedThinking,
          tier: config.tier
        })
        savedId = result.id
      }
      const savedModelId = `${config.source}:${savedId}`
      const nextDefaultModelId =
        allConfigs.length === 0
          ? savedModelId
          : defaultModelDraftId === currentModelStorageId
            ? savedModelId
            : defaultModelDraftId
      await window.api.models.setDefault(nextDefaultModelId)
      setDefaultModelId(nextDefaultModelId)
      setDefaultModelDraftId(nextDefaultModelId)
      const refreshed = await loadModelItems()
      setAllConfigs(refreshed)
      const updated = refreshed.find((item) => item.id === savedId && item.source === config.source)
      if (updated) {
        setConfig(configFromItem(updated, tokenLimits))
        setHasExisting(true)
        setHasExistingKey(updated.hasApiKey)
      }
      onModelSaved?.(savedModelId)
      setFormError(null)
      onOpenChange(false)
    } catch (e) {
      console.error("[CustomModelDialog] Failed to save:", e)
      setFormError(e instanceof Error ? e.message : "保存失败，请稍后重试")
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(): Promise<void> {
    if (!config.id || config.source !== "custom") return
    setDeleting(true)
    try {
      const tasks = await window.api.scheduledTasks.list()
      const modelKey = `custom:${config.id}`
      const usingTasks = tasks.filter((t) => t.modelId === modelKey)
      if (usingTasks.length > 0) {
        const names = usingTasks.map((t) => `「${t.name}」`).join("、")
        setFormError(`无法删除：定时任务 ${names} 正在使用此模型`)
        setDeleting(false)
        return
      }
      await window.api.models.deleteCustomConfig(config.id)
      const refreshed = await loadModelItems()
      setAllConfigs(refreshed)
      if (refreshed.length > 0) {
        const fallback = refreshed[0]
        const fallbackModelId = `${fallback.source}:${fallback.id}`
        if (isPersistedDefaultModel) {
          await window.api.models.setDefault(fallbackModelId)
          setDefaultModelId(fallbackModelId)
          setDefaultModelDraftId(fallbackModelId)
        }
        setConfig(configFromItem(fallback, tokenLimits))
        setHasExisting(true)
        setHasExistingKey(fallback.hasApiKey)
        onModelSaved?.(fallbackModelId)
      } else {
        if (isPersistedDefaultModel) {
          await window.api.models.setDefault("")
          setDefaultModelId("")
          setDefaultModelDraftId("")
        }
        setConfig(emptyConfig(tokenLimits))
        setHasExisting(false)
        setHasExistingKey(false)
      }
      setFormError(null)
    } catch (e) {
      console.error("[CustomModelDialog] Failed to delete:", e)
    } finally {
      setDeleting(false)
    }
  }

  async function handleResetBuiltin(): Promise<void> {
    if (!config.id || config.source !== "builtin") return
    setDeleting(true)
    setFormError(null)
    try {
      await window.api.models.resetBuiltinConfig(config.id)
      const refreshed = await loadModelItems()
      setAllConfigs(refreshed)
      const updated = refreshed.find((item) => item.source === "builtin" && item.id === config.id)
      if (updated) {
        setConfig(configFromItem(updated, tokenLimits))
        setHasExistingKey(updated.hasApiKey)
      }
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "恢复系统默认失败")
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[760px] max-h-[85vh] flex flex-col gap-3 p-4">
        <DialogHeader className="space-y-1">
          <DialogTitle>
            {config.source === "builtin" ? "编辑内置模型参数" : "编辑模型配置"}
          </DialogTitle>
          <DialogDescription>
            {config.source === "builtin"
              ? "连接信息由系统管理；你可以调整上下文、采样、思考和路由参数。"
              : "配置兼容 OpenAI 接口格式的模型服务。"}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 grid grid-cols-[220px_1fr] gap-4">
          <div className="rounded-md border border-border p-2">
            <div className="mb-1.5 flex items-center justify-between">
              <div className="text-xs font-medium text-muted-foreground">模型列表</div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2"
                onClick={() => {
                  setConfig(emptyConfig(tokenLimits))
                  setHasExisting(false)
                  setHasExistingKey(false)
                  setDefaultModelDraftId(defaultModelId)
                  setFormError(null)
                  setTestResult(null)
                  setShowKey(false)
                }}
              >
                <Plus className="size-4" />
                新增
              </Button>
            </div>
            <div className="max-h-[330px] space-y-1 overflow-y-auto">
              {(["builtin", "custom"] as const).map((source) => {
                const items = allConfigs.filter((item) => item.source === source)
                if (source === "custom" && items.length === 0) return null
                return (
                  <div key={source} className="space-y-1">
                    <div className="flex items-center gap-1 px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                      {source === "builtin" && <Lock className="size-3" />}
                      {source === "builtin" ? "系统内置" : "自定义模型"}
                    </div>
                    {items.map((item) => (
                      <button
                        key={`${item.source}:${item.id}`}
                        type="button"
                        onClick={() => {
                          void selectConfigToEdit(item.id, item.source)
                        }}
                        className={`w-full rounded-sm border px-2 py-1.5 text-left text-xs transition-colors ${
                          `${item.source}:${item.id}` === selectedConfigKey
                            ? "border-primary bg-primary/10 text-foreground"
                            : "border-transparent text-muted-foreground hover:bg-muted"
                        }`}
                      >
                        <div className="flex items-center gap-1.5">
                          <span className="min-w-0 flex-1 truncate font-medium">{item.name}</span>
                          {item.source === "builtin" && (
                            <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9px]">
                              {item.origin === "remote" ? "后台" : "兜底"}
                            </span>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                )
              })}
              {allConfigs.length === 0 && (
                <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                  暂无模型配置
                </div>
              )}
            </div>
          </div>

          <div className="min-h-0 flex flex-col">
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-y-contain pr-1">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">显示名称</label>
                <Input
                  className="h-8"
                  value={config.name}
                  onChange={(e) => setConfig((c) => ({ ...c, name: e.target.value }))}
                  placeholder="例如：DeepSeek Chat（生产）"
                  autoFocus
                />
                {duplicateNameError && (
                  <p className="text-xs text-destructive">{duplicateNameError}</p>
                )}
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">
                  接口地址（Base URL）
                </label>
                <Input
                  className="h-8"
                  value={config.baseUrl}
                  disabled={config.source === "builtin"}
                  onChange={(e) => {
                    setConfig((c) => ({ ...c, baseUrl: e.target.value }))
                    setTestResult(null)
                  }}
                  placeholder="https://api.example.com/v1"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">
                  模型名称（Model）
                </label>
                <Input
                  className="h-8"
                  value={config.model}
                  disabled={config.source === "builtin"}
                  onChange={(e) => {
                    const nextModel = e.target.value
                    setConfig((c) => {
                      const currentInterleavedDefault = defaultInterleavedThinkingForModel(c.model)
                      const nextInterleavedDefault = defaultInterleavedThinkingForModel(nextModel)
                      const currentEnableThinkingDefault = defaultInterleavedThinkingForModel(
                        c.model
                      )
                      const nextEnableThinkingDefault =
                        defaultInterleavedThinkingForModel(nextModel)
                      const currentSamplingDefault = defaultSamplingForModel(c.model, tokenLimits)
                      const nextSamplingDefault = defaultSamplingForModel(nextModel, tokenLimits)
                      const shouldUseNextSamplingDefault =
                        !c.id &&
                        c.temperatureInput === currentSamplingDefault.temperatureInput &&
                        c.topPInput === currentSamplingDefault.topPInput &&
                        c.topKInput === currentSamplingDefault.topKInput

                      return {
                        ...c,
                        model: nextModel,
                        ...(shouldUseNextSamplingDefault ? nextSamplingDefault : {}),
                        interleavedThinking:
                          c.interleavedThinking === currentInterleavedDefault
                            ? nextInterleavedDefault
                            : c.interleavedThinking,
                        enableThinking:
                          c.enableThinking === currentEnableThinkingDefault
                            ? nextEnableThinkingDefault
                            : c.enableThinking
                      }
                    })
                    setTestResult(null)
                  }}
                  placeholder="gpt-4o, deepseek-chat, ..."
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">
                  最大 Token（上下文窗口）
                </label>
                <Input
                  className="h-8"
                  type="number"
                  value={config.maxTokensInput}
                  onChange={(e) => {
                    setConfig((c) => ({
                      ...c,
                      maxTokensInput: e.target.value
                    }))
                    setTestResult(null)
                  }}
                  placeholder={String(tokenLimits.defaultMaxTokens)}
                  min={tokenLimits.minMaxTokens}
                  max={tokenLimits.maxMaxTokens}
                />
                {maxTokensError && <p className="text-xs text-destructive">{maxTokensError}</p>}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <ParameterLabel explanation="限制单次回复最多生成的 Token 数。数值越大越能输出长答案；超过模型或服务限制时请求可能失败。">
                    max_tokens（最大 Tokens）
                  </ParameterLabel>
                  <Input
                    className="h-8"
                    type="number"
                    value={config.maxOutputTokensInput}
                    onChange={(e) => {
                      setConfig((c) => ({
                        ...c,
                        maxOutputTokensInput: e.target.value
                      }))
                      setTestResult(null)
                    }}
                    placeholder={String(tokenLimits.defaultMaxOutputTokens)}
                    min={tokenLimits.minMaxOutputTokens}
                    max={tokenLimits.maxMaxOutputTokens}
                  />
                  {maxOutputTokensError && (
                    <p className="text-xs text-destructive">{maxOutputTokensError}</p>
                  )}
                </div>

                <div className="space-y-1">
                  <ParameterLabel explanation="控制回答的随机性。数值越低越稳定、可复现，适合代码和事实类任务；数值越高越发散，适合创意写作。">
                    Temperature
                  </ParameterLabel>
                  <Input
                    className="h-8"
                    type="number"
                    value={config.temperatureInput}
                    onChange={(e) => {
                      setConfig((c) => ({
                        ...c,
                        temperatureInput: e.target.value
                      }))
                      setTestResult(null)
                    }}
                    placeholder={String(tokenLimits.defaultTemperature)}
                    min={0}
                    max={tokenLimits.maxTemperature}
                    step="any"
                  />
                  {temperatureError && (
                    <p className="text-xs text-destructive">{temperatureError}</p>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <ParameterLabel explanation="按累计概率筛选候选词。数值越低越保守，越高越开放；通常和 Temperature 二选一微调即可。">
                    top_p
                  </ParameterLabel>
                  <Input
                    className="h-8"
                    type="number"
                    value={config.topPInput}
                    onChange={(e) => {
                      setConfig((c) => ({
                        ...c,
                        topPInput: e.target.value
                      }))
                      setTestResult(null)
                    }}
                    placeholder={String(tokenLimits.defaultTopP)}
                    min={0}
                    max={tokenLimits.maxTopP}
                    step="any"
                  />
                  {topPError && <p className="text-xs text-destructive">{topPError}</p>}
                </div>

                <div className="space-y-1">
                  <ParameterLabel explanation="每一步只从概率最高的 K 个候选词中采样。数值越小越稳定，越大越多样。">
                    top_k
                  </ParameterLabel>
                  <Input
                    className="h-8"
                    type="number"
                    value={config.topKInput}
                    onChange={(e) => {
                      setConfig((c) => ({
                        ...c,
                        topKInput: e.target.value
                      }))
                      setTestResult(null)
                    }}
                    placeholder={String(tokenLimits.defaultTopK)}
                    min={tokenLimits.minTopK}
                    max={tokenLimits.maxTopK}
                  />
                  {topKError && <p className="text-xs text-destructive">{topKError}</p>}
                </div>
              </div>

              <div className="space-y-1">
                <ParameterLabel explanation="开启后，支持的模型会在回答前进行更充分的推理，并可在对话中展示思考内容。是否生效取决于模型能力，例如 deepseek-flash 支持思考开关和思考强度。">
                  思考模式
                </ParameterLabel>
                <div className="flex items-center justify-between rounded-md border border-border px-3 py-1.5">
                  <div>
                    <div className="text-sm text-foreground">
                      {config.enableThinking ? "已开启" : "已关闭"}
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={config.enableThinking}
                    onClick={() =>
                      setConfig((c) => ({
                        ...c,
                        enableThinking: !c.enableThinking,
                        ...(c.enableThinking
                          ? { interleavedThinking: false, enableThinkingEffort: false }
                          : {})
                      }))
                    }
                    className={cn(
                      "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors",
                      config.enableThinking ? "bg-primary" : "bg-muted-foreground/30"
                    )}
                  >
                    <span
                      className={cn(
                        "pointer-events-none inline-block size-4 rounded-full bg-white shadow-sm transition-transform",
                        config.enableThinking ? "translate-x-4" : "translate-x-0"
                      )}
                    />
                  </button>
                </div>
              </div>

              <div className="space-y-1">
                <ParameterLabel explanation="部分模型或服务支持额外指定思考强度；不支持时关闭即可，只保留思考模式。开启后可选择 High 或 Max。">
                  思考强度
                </ParameterLabel>
                <div className="flex items-center justify-between rounded-md border border-border px-3 py-1.5">
                  <div>
                    <div className="text-sm text-foreground">
                      {config.enableThinking && config.enableThinkingEffort ? "已开启" : "已关闭"}
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={config.enableThinking && config.enableThinkingEffort}
                    disabled={!config.enableThinking}
                    onClick={() => {
                      setConfig((c) => ({ ...c, enableThinkingEffort: !c.enableThinkingEffort }))
                      setTestResult(null)
                    }}
                    className={cn(
                      "relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors",
                      !config.enableThinking
                        ? "cursor-not-allowed bg-muted-foreground/20"
                        : config.enableThinkingEffort
                          ? "cursor-pointer bg-primary"
                          : "cursor-pointer bg-muted-foreground/30"
                    )}
                  >
                    <span
                      className={cn(
                        "pointer-events-none inline-block size-4 rounded-full bg-white shadow-sm transition-transform",
                        config.enableThinking && config.enableThinkingEffort
                          ? "translate-x-4"
                          : "translate-x-0"
                      )}
                    />
                  </button>
                </div>
                <div className="flex gap-2">
                  {THINKING_EFFORT_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      disabled={!config.enableThinking || !config.enableThinkingEffort}
                      onClick={() => {
                        setConfig((c) => ({ ...c, thinkingEffort: option.value }))
                        setTestResult(null)
                      }}
                      className={cn(
                        "flex-1 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45",
                        config.enableThinking &&
                          config.enableThinkingEffort &&
                          config.thinkingEffort === option.value
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border text-muted-foreground hover:bg-muted disabled:hover:bg-transparent"
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">交错思考</label>
                <div className="flex items-center justify-between rounded-md border border-border px-3 py-1.5">
                  <div>
                    <div className="text-sm text-foreground">
                      {config.interleavedThinking ? "已开启" : "已关闭"}
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={config.interleavedThinking}
                    disabled={!config.enableThinking}
                    onClick={() =>
                      setConfig((c) => ({ ...c, interleavedThinking: !c.interleavedThinking }))
                    }
                    className={cn(
                      "relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors",
                      !config.enableThinking
                        ? "cursor-not-allowed bg-muted-foreground/20"
                        : config.interleavedThinking
                          ? "cursor-pointer bg-primary"
                          : "cursor-pointer bg-muted-foreground/30"
                    )}
                  >
                    <span
                      className={cn(
                        "pointer-events-none inline-block size-4 rounded-full bg-white shadow-sm transition-transform",
                        config.interleavedThinking ? "translate-x-4" : "translate-x-0"
                      )}
                    />
                  </button>
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">智能路由档位</label>
                <div className="flex gap-2">
                  {(["premium", "economy"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setConfig((c) => ({ ...c, tier: t }))}
                      className={`flex-1 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                        config.tier === t
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border text-muted-foreground hover:bg-muted"
                      }`}
                    >
                      {t === "premium" ? "⚡ 强力 — 复杂任务" : "🌿 经济 — 简单任务"}
                    </button>
                  ))}
                </div>
                <p className="text-xs leading-tight text-muted-foreground">
                  开启智能路由后，系统会根据任务复杂度自动选择对应档位的模型
                </p>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">默认使用</label>
                <div className="flex items-center justify-between rounded-md border border-border px-3 py-1.5">
                  <div>
                    <div className="text-sm text-foreground">
                      {isDefaultModel ? "已设为默认" : "未设为默认"}
                    </div>
                    <p className="text-xs leading-tight text-muted-foreground">
                      新开的会话会优先选择这个模型
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={isDefaultModel}
                    disabled={!config.id}
                    onClick={() => {
                      if (!config.id) return
                      setDefaultModelDraftId(isDefaultModel ? "" : `${config.source}:${config.id}`)
                    }}
                    className={cn(
                      "relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors",
                      !config.id
                        ? "cursor-not-allowed bg-muted-foreground/20"
                        : isDefaultModel
                          ? "cursor-pointer bg-primary"
                          : "cursor-pointer bg-muted-foreground/30"
                    )}
                  >
                    <span
                      className={cn(
                        "pointer-events-none inline-block size-4 rounded-full bg-white shadow-sm transition-transform",
                        isDefaultModel ? "translate-x-4" : "translate-x-0"
                      )}
                    />
                  </button>
                </div>
                {!config.id && (
                  <p className="text-xs leading-tight text-muted-foreground">
                    先保存模型配置，才能把它设为默认。
                  </p>
                )}
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">API 密钥</label>
                <div className="relative">
                  <Input
                    className="h-8 pr-10"
                    type={showKey ? "text" : "password"}
                    value={config.apiKey}
                    disabled={config.source === "builtin"}
                    onChange={(e) => {
                      setConfig((c) => ({ ...c, apiKey: e.target.value }))
                      setTestResult(null)
                    }}
                    placeholder={
                      config.source === "builtin"
                        ? "系统已配置（不可修改）"
                        : hasExisting
                          ? "••••••••••••••••"
                          : "sk-..."
                    }
                  />
                  <button
                    type="button"
                    onClick={() => {
                      if (canToggleKeyVisibility) setShowKey(!showKey)
                    }}
                    disabled={config.source === "builtin" || !canToggleKeyVisibility}
                    title={canToggleKeyVisibility ? "显示或隐藏密钥" : "请输入密钥后再切换显示"}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <p className="text-xs leading-tight text-muted-foreground">
                    {config.source === "builtin"
                      ? "内置模型密钥由后台配置或本地主进程兜底，页面不会读取或修改实际值。"
                      : "密钥仅作用于当前模型（按模型 ID 独立保存）。"}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="ml-auto shrink-0 h-6 px-2 text-xs border-blue-500/50 text-blue-600 hover:bg-blue-500/10 hover:text-blue-700"
                    onClick={handleTest}
                    disabled={!canTest || testing || saving || deleting}
                  >
                    {testing ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Zap className="size-3" />
                    )}
                    测试连接
                  </Button>
                </div>
                {testResult && (
                  <div
                    className={`rounded-md border px-3 py-2 text-xs ${
                      testResult.success
                        ? "border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-400"
                        : "border-destructive/40 bg-destructive/10 text-destructive"
                    }`}
                  >
                    {testResult.success
                      ? `连接成功${testResult.latencyMs != null ? `（延迟 ${testResult.latencyMs} ms）` : ""}`
                      : `连接失败：${testResult.error || "未知错误"}`}
                  </div>
                )}
              </div>

              {formError && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {formError}
                </div>
              )}
            </div>

            <div className="flex justify-between pt-3">
              {hasExisting && config.source === "builtin" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleResetBuiltin}
                  disabled={deleting || saving || testing}
                >
                  {deleting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <RotateCcw className="size-4" />
                  )}
                  恢复系统默认
                </Button>
              ) : hasExisting ? (
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={handleDelete}
                  disabled={deleting || saving || testing}
                >
                  {deleting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                  删除
                </Button>
              ) : (
                <div />
              )}
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                  取消
                </Button>
                <Button type="button" onClick={handleSave} disabled={!canSave || saving || testing}>
                  {saving ? <Loader2 className="size-4 animate-spin" /> : "保存"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
