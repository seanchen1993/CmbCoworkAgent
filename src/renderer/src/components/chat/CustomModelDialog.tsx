import { useState, useEffect } from "react"
import { Eye, EyeOff, Loader2, Plus, Trash2, Zap } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

interface CustomModelDialogProps {
  open: boolean
  selectedModelId?: string
  onModelSaved?: (modelId: string) => void
  onOpenChange: (open: boolean) => void
}

interface CustomConfig {
  id?: string
  name: string
  baseUrl: string
  model: string
  apiKey: string
  maxTokensInput: string
  interleavedThinking: boolean
  tier: "premium" | "economy"
}

interface TokenLimits {
  defaultMaxTokens: number
  minMaxTokens: number
  maxMaxTokens: number
}

interface CustomModelItem {
  id: string
  name: string
  baseUrl: string
  model: string
  hasApiKey: boolean
  maxTokens: number
  interleavedThinking?: boolean
  tier?: "premium" | "economy"
}

const FALLBACK_LIMITS: TokenLimits = {
  defaultMaxTokens: 128_000,
  minMaxTokens: 32_000,
  maxMaxTokens: 128_000
}

function defaultInterleavedThinkingForModel(model: string): boolean {
  return /minimax/i.test(model)
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

export function CustomModelDialog({
  open,
  selectedModelId,
  onModelSaved,
  onOpenChange
}: CustomModelDialogProps): React.JSX.Element {
  const [config, setConfig] = useState<CustomConfig>({
    id: undefined,
    name: "",
    baseUrl: "",
    model: "",
    apiKey: "",
    maxTokensInput: String(FALLBACK_LIMITS.defaultMaxTokens),
    interleavedThinking: false,
    tier: "premium"
  })
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

  useEffect(() => {
    let cancelled = false

    if (open) {
      setShowKey(false)
      setFormError(null)
      setTestResult(null)

      const normalizedSelectedId = selectedModelId?.startsWith("custom:")
        ? selectedModelId.slice("custom:".length)
        : selectedModelId
      void Promise.all([
        window.api.models.getTokenLimits(),
        window.api.models.getCustomConfigs(),
        window.api.models.getCustomConfig(normalizedSelectedId)
      ]).then(
        ([limits, all, existing]) => {
          if (cancelled) return
          setTokenLimits(limits)
          setAllConfigs(all)

          const resolvedExisting =
            existing ||
            (normalizedSelectedId
              ? all.find(
                  (item) => item.id === normalizedSelectedId || item.model === normalizedSelectedId
                ) || null
              : null)

          if (resolvedExisting) {
            setConfig({
              id: resolvedExisting.id,
              name: resolvedExisting.name,
              baseUrl: resolvedExisting.baseUrl,
              model: resolvedExisting.model,
              apiKey: "",
              maxTokensInput: String(resolvedExisting.maxTokens ?? limits.defaultMaxTokens),
              interleavedThinking:
                resolvedExisting.interleavedThinking ??
                defaultInterleavedThinkingForModel(resolvedExisting.model),
              tier: resolvedExisting.tier ?? "premium"
            })
            setHasExisting(true)
            setHasExistingKey(resolvedExisting.hasApiKey)
          } else {
            setConfig({
              id: undefined,
              name: "",
              baseUrl: "",
              model: "",
              apiKey: "",
              maxTokensInput: String(limits.defaultMaxTokens),
              interleavedThinking: false,
              tier: "premium"
            })
            setHasExisting(false)
            setHasExistingKey(false)
          }
        }
      ).catch((error) => {
        console.error("[CustomModelDialog] Failed to load model settings:", error)
      })
    }

    return () => {
      cancelled = true
    }
  }, [open, selectedModelId])

  const selectedConfigId = config.id

  async function selectConfigToEdit(id: string): Promise<void> {
    setFormError(null)
    setTestResult(null)
    const picked = await window.api.models.getCustomConfig(id)
    if (!picked) return
    setConfig({
      id: picked.id,
      name: picked.name,
      baseUrl: picked.baseUrl,
      model: picked.model,
      apiKey: "",
      maxTokensInput: String(picked.maxTokens ?? tokenLimits.defaultMaxTokens),
      interleavedThinking:
        picked.interleavedThinking ?? defaultInterleavedThinkingForModel(picked.model),
      tier: picked.tier ?? "premium"
    })
    setHasExisting(true)
    setHasExistingKey(picked.hasApiKey)
    setShowKey(false)
  }

  const maxTokensError = getMaxTokensError(config.maxTokensInput, tokenLimits)
  const canToggleKeyVisibility = config.apiKey.trim().length > 0
  const duplicateNameError =
    config.name.trim() &&
    allConfigs.some((item) => item.name === config.name.trim() && item.id !== config.id)
      ? "显示名称不能重复，请使用不同的显示名称"
      : null

  const canSave =
    config.name.trim() &&
    config.baseUrl.trim() &&
    config.model.trim() &&
    (hasExistingKey || config.apiKey.trim()) &&
    !maxTokensError &&
    !duplicateNameError

  const canTest =
    config.baseUrl.trim() && config.model.trim() && (hasExistingKey || config.apiKey.trim())

  async function handleTest(): Promise<void> {
    if (!canTest || testing || saving || deleting) return
    setTesting(true)
    setTestResult(null)
    setFormError(null)
    try {
      const result = await window.api.models.testConnection({
        id: config.id,
        baseUrl: config.baseUrl.trim(),
        model: config.model.trim(),
        apiKey: config.apiKey.trim() || undefined
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

      const result = await window.api.models.upsertCustomConfig({
        id: config.id,
        name: config.name.trim(),
        baseUrl: config.baseUrl.trim(),
        model: config.model.trim(),
        apiKey: config.apiKey.trim() || undefined,
        maxTokens: parsedMaxTokens,
        interleavedThinking: config.interleavedThinking,
        tier: config.tier
      })
      const refreshed = await window.api.models.getCustomConfigs()
      setAllConfigs(refreshed)
      const updated = refreshed.find((item) => item.id === result.id)
      if (updated) {
        setConfig((prev) => ({
          ...prev,
          id: updated.id,
          name: updated.name,
          baseUrl: updated.baseUrl,
          model: updated.model,
          apiKey: ""
        }))
        setHasExisting(true)
        setHasExistingKey(updated.hasApiKey)
      }
      onModelSaved?.(`custom:${result.id}`)
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
    if (!config.id) return
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
      const refreshed = await window.api.models.getCustomConfigs()
      setAllConfigs(refreshed)
      if (refreshed.length > 0) {
        const fallback = refreshed[0]
        setConfig({
          id: fallback.id,
          name: fallback.name,
          baseUrl: fallback.baseUrl,
          model: fallback.model,
          apiKey: "",
          maxTokensInput: String(fallback.maxTokens ?? tokenLimits.defaultMaxTokens),
          interleavedThinking:
            fallback.interleavedThinking ?? defaultInterleavedThinkingForModel(fallback.model),
          tier: fallback.tier ?? "premium"
        })
        setHasExisting(true)
        setHasExistingKey(fallback.hasApiKey)
        onModelSaved?.(`custom:${fallback.id}`)
      } else {
        setConfig({
          id: undefined,
          name: "",
          baseUrl: "",
          model: "",
          apiKey: "",
          maxTokensInput: String(tokenLimits.defaultMaxTokens),
          interleavedThinking: false,
          tier: "premium"
        })
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[760px]">
        <DialogHeader>
          <DialogTitle>编辑模型配置</DialogTitle>
          <DialogDescription>配置兼容 OpenAI 接口格式的模型服务。</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-[220px_1fr] gap-4 py-2">
          <div className="rounded-md border border-border p-2">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-xs font-medium text-muted-foreground">模型列表</div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setConfig({
                    id: undefined,
                    name: "",
                    baseUrl: "",
                    model: "",
                    apiKey: "",
                    maxTokensInput: String(tokenLimits.defaultMaxTokens),
                    interleavedThinking: false,
                    tier: "premium"
                  })
                  setHasExisting(false)
                  setHasExistingKey(false)
                  setFormError(null)
                  setTestResult(null)
                  setShowKey(false)
                }}
              >
                <Plus className="size-4" />
                新增
              </Button>
            </div>
            <div className="max-h-[360px] space-y-1 overflow-y-auto">
              {allConfigs.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    void selectConfigToEdit(item.id)
                  }}
                  className={`w-full rounded-sm border px-2 py-2 text-left text-xs transition-colors ${
                    item.id === selectedConfigId
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-transparent text-muted-foreground hover:bg-muted"
                  }`}
                >
                  <div className="truncate font-medium">{item.name}</div>
                </button>
              ))}
              {allConfigs.length === 0 && (
                <div className="px-2 py-6 text-center text-xs text-muted-foreground">暂无模型配置</div>
              )}
            </div>
          </div>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">显示名称</label>
              <Input
                value={config.name}
                onChange={(e) => setConfig((c) => ({ ...c, name: e.target.value }))}
                placeholder="例如：DeepSeek Chat（生产）"
                autoFocus
              />
              {duplicateNameError && <p className="text-xs text-destructive">{duplicateNameError}</p>}
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">接口地址（Base URL）</label>
              <Input
                value={config.baseUrl}
                onChange={(e) => { setConfig((c) => ({ ...c, baseUrl: e.target.value })); setTestResult(null) }}
                placeholder="https://api.example.com/v1"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">模型名称（Model）</label>
              <Input
                value={config.model}
                onChange={(e) => {
                  const nextModel = e.target.value
                  setConfig((c) => {
                    const currentDefault = defaultInterleavedThinkingForModel(c.model)
                    const nextDefault = defaultInterleavedThinkingForModel(nextModel)
                    return {
                      ...c,
                      model: nextModel,
                      interleavedThinking:
                        c.interleavedThinking === currentDefault ? nextDefault : c.interleavedThinking
                    }
                  })
                  setTestResult(null)
                }}
                placeholder="gpt-4o, deepseek-chat, ..."
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                最大 Token（上下文窗口）
              </label>
              <Input
                type="number"
                value={config.maxTokensInput}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    maxTokensInput: e.target.value
                  }))
                }
                placeholder={String(tokenLimits.defaultMaxTokens)}
                min={tokenLimits.minMaxTokens}
                max={tokenLimits.maxMaxTokens}
              />
              {maxTokensError && <p className="text-xs text-destructive">{maxTokensError}</p>}
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">交错思考</label>
              <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                <div className="space-y-1">
                  <div className="text-sm text-foreground">
                    {config.interleavedThinking ? "已开启" : "已关闭"}
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={config.interleavedThinking}
                  onClick={() =>
                    setConfig((c) => ({ ...c, interleavedThinking: !c.interleavedThinking }))
                  }
                  className={cn(
                    "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors",
                    config.interleavedThinking ? "bg-primary" : "bg-muted-foreground/30"
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

            <div className="space-y-1.5">
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
              <p className="text-xs text-muted-foreground">
                开启智能路由后，系统会根据任务复杂度自动选择对应档位的模型
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">API 密钥</label>
              <div className="relative">
                <Input
                  type={showKey ? "text" : "password"}
                  value={config.apiKey}
                  onChange={(e) => { setConfig((c) => ({ ...c, apiKey: e.target.value })); setTestResult(null) }}
                  placeholder={hasExisting ? "••••••••••••••••" : "sk-..."}
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => {
                    if (canToggleKeyVisibility) setShowKey(!showKey)
                  }}
                  disabled={!canToggleKeyVisibility}
                  title={canToggleKeyVisibility ? "显示或隐藏密钥" : "请输入密钥后再切换显示"}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
              <div className="flex items-center gap-2">
                <p className="text-xs text-muted-foreground">
                  密钥仅作用于当前模型（按模型 ID 独立保存）。
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="ml-auto shrink-0 h-6 px-2 text-xs border-blue-500/50 text-blue-600 hover:bg-blue-500/10 hover:text-blue-700"
                  onClick={handleTest}
                  disabled={!canTest || testing || saving || deleting}
                >
                  {testing ? <Loader2 className="size-3 animate-spin" /> : <Zap className="size-3" />}
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

            <div className="flex justify-between">
              {hasExisting ? (
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={handleDelete}
                  disabled={deleting || saving || testing}
                >
                  {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
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
