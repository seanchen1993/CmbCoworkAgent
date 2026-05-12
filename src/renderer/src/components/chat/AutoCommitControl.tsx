import React, { useCallback, useEffect, useRef, useState } from "react"
import { AlertTriangle, GitCommit, Loader2, Save, Settings2 } from "lucide-react"
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
import { cn } from "@/lib/utils"
import type {
  AgentAutoCommitMessageStrategy,
  AgentAutoCommitMode,
  AgentAutoCommitSettings
} from "@/types"

const DEFAULT_AUTO_COMMIT_SETTINGS: AgentAutoCommitSettings = {
  mode: "off",
  push: false,
  messageStrategy: "prompt"
}

const STRATEGIES: Array<{
  value: AgentAutoCommitMessageStrategy
  label: string
  description: string
}> = [
  {
    value: "prompt",
    label: "按任务内容生成",
    description: "根据你本轮交给 Agent 的任务生成摘要，适合需求描述清楚的日常修改。"
  },
  {
    value: "diff",
    label: "按改动内容生成",
    description: "根据本轮实际修改的文件生成摘要，适合一次改了多处代码的任务。"
  },
  {
    value: "template",
    label: "使用固定摘要",
    description: "使用你填写的摘要模板生成 fix: 后面的内容，适合团队有固定摘要写法的场景。"
  }
]

function normalizeSettings(settings: AgentAutoCommitSettings | null): AgentAutoCommitSettings {
  const merged = { ...DEFAULT_AUTO_COMMIT_SETTINGS, ...(settings ?? {}) }
  return { ...merged, push: merged.push === true }
}

type AutoCommitControlVariant = "compact" | "panel"

interface AutoCommitControlProps {
  variant?: AutoCommitControlVariant
}

export function AutoCommitControl({
  variant = "compact"
}: AutoCommitControlProps): React.JSX.Element {
  const [settings, setSettings] = useState<AgentAutoCommitSettings>(DEFAULT_AUTO_COMMIT_SETTINGS)
  const [draft, setDraft] = useState<AgentAutoCommitSettings>(DEFAULT_AUTO_COMMIT_SETTINGS)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    window.api.autoCommit
      .getSettings()
      .then((current) => {
        if (!mountedRef.current) return
        const normalized = normalizeSettings(current)
        setSettings(normalized)
        setDraft(normalized)
      })
      .catch((e) => {
        console.error("[AutoCommitControl] Failed to load settings:", e)
      })
      .finally(() => {
        if (mountedRef.current) setLoading(false)
      })
    return () => {
      mountedRef.current = false
    }
  }, [])

  const saveSettings = useCallback(async (next: AgentAutoCommitSettings): Promise<void> => {
    setPending(true)
    setError(null)
    try {
      const saved = await window.api.autoCommit.saveSettings({
        ...next,
        cardNumber: next.cardNumber?.trim() || undefined,
        template: next.template?.trim() || undefined
      })
      if (!mountedRef.current) return
      const normalized = normalizeSettings(saved)
      setSettings(normalized)
      setDraft(normalized)
      setDialogOpen(false)
    } catch (e) {
      if (mountedRef.current) {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (mountedRef.current) setPending(false)
    }
  }, [])

  const openDetails = useCallback(
    (mode: AgentAutoCommitMode = settings.mode) => {
      const next = normalizeSettings({ ...settings, mode })
      setDraft(next)
      setError(null)
      setDialogOpen(true)
    },
    [settings]
  )

  const handleModeChange = useCallback(
    (value: string) => {
      const mode = value as AgentAutoCommitMode
      if (mode === "off") {
        void saveSettings({ ...settings, mode: "off" })
        return
      }
      openDetails(mode)
    },
    [openDetails, saveSettings, settings]
  )

  const updateDraft = useCallback((updates: Partial<AgentAutoCommitSettings>) => {
    setError(null)
    setDraft((current) => ({ ...current, ...updates }))
  }, [])

  const handleSaveDraft = useCallback(() => {
    const cardNumber = draft.cardNumber?.trim()
    if (draft.mode !== "off" && !cardNumber) {
      setError("开启自动提交前需要填写卡片编号")
      return
    }
    void saveSettings({
      ...draft,
      cardNumber,
      template: draft.template?.trim() || undefined
    })
  }, [draft, saveSettings])

  const needsCard = draft.mode !== "off" && !draft.cardNumber?.trim()

  const settingsForm = (
    <div className="space-y-4">
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">提交方式</span>
        <Select
          value={draft.mode}
          onValueChange={(value) => updateDraft({ mode: value as AgentAutoCommitMode })}
          disabled={loading || pending}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="off">不自动提交</SelectItem>
            <SelectItem value="ask">询问提交：弹窗确认后再提交</SelectItem>
            <SelectItem value="always">自动提交：任务结束后直接提交</SelectItem>
          </SelectContent>
        </Select>
      </label>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.push}
          onChange={(e) => updateDraft({ push: e.target.checked })}
          disabled={draft.mode === "off" || loading || pending}
          className="mt-0.5 size-4 shrink-0 cursor-pointer rounded border-border disabled:cursor-not-allowed disabled:opacity-60"
        />
        <span>
          <span className="font-medium">提交后自动推送</span>
          <span className="ml-2 text-xs text-muted-foreground">
            勾选后会在 commit 成功后执行 git push；推送失败不会回滚 commit。
          </span>
        </span>
      </label>

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">卡片编号</span>
        <input
          value={draft.cardNumber ?? ""}
          onChange={(e) => updateDraft({ cardNumber: e.target.value })}
          placeholder="例如 Z990880"
          disabled={draft.mode === "off" || loading || pending}
          className={cn(
            "h-9 rounded-md border bg-background px-3 text-sm outline-none transition-colors focus:border-primary disabled:cursor-not-allowed disabled:opacity-60",
            needsCard ? "border-amber-500/70" : "border-border"
          )}
        />
      </label>

      <div className="space-y-2">
        <span className="text-sm font-medium">摘要来源</span>
        <div className="grid gap-2 sm:grid-cols-2">
          {STRATEGIES.map((strategy) => (
            <button
              key={strategy.value}
              type="button"
              onClick={() => updateDraft({ messageStrategy: strategy.value })}
              disabled={draft.mode === "off" || loading || pending}
              className={cn(
                "min-h-[92px] rounded-md border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                draft.messageStrategy === strategy.value
                  ? "border-primary bg-primary/5 text-primary"
                  : "border-border hover:bg-muted/40"
              )}
            >
              <span className="block text-sm font-medium">{strategy.label}</span>
              <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                {strategy.description}
              </span>
            </button>
          ))}
        </div>
      </div>

      {draft.messageStrategy === "template" && (
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium">摘要模板</span>
          <input
            value={draft.template ?? ""}
            onChange={(e) => updateDraft({ template: e.target.value })}
            placeholder="{summary}"
            disabled={draft.mode === "off" || loading || pending}
            className="h-9 rounded-md border border-border bg-background px-3 text-sm outline-none transition-colors focus:border-primary disabled:cursor-not-allowed disabled:opacity-60"
          />
          <span className="text-xs text-muted-foreground">
            可用变量：{"{summary}"}、{"{diffSummary}"}、{"{fileCount}"}、{"{files}"}、
            {"{threadShort}"}。这里只填写 fix: 后面的摘要。
          </span>
        </label>
      )}

      {needsCard && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <p>自动提交必须填写卡片编号；缺少时会跳过提交，不会编造编号。</p>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-600 dark:text-red-400">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <p>{error}</p>
        </div>
      )}
    </div>
  )

  if (variant === "panel") {
    return (
      <div className="rounded-md border border-border bg-card p-5 shadow-sm">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold">自动提交</h3>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              提交信息固定为：卡片编号 #comment fix:摘要 #CMBDevClaw。默认只执行 git
              commit；如需推送请勾选下方"提交后自动推送"。
            </p>
          </div>
          <GitCommit className="mt-1 size-5 shrink-0 text-muted-foreground" />
        </div>

        {settingsForm}

        <div className="mt-5 flex justify-end">
          <Button onClick={handleSaveDraft} disabled={pending || loading}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            保存
          </Button>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="flex items-center gap-1">
        <GitCommit className="size-3.5 text-muted-foreground" />
        <Select
          value={settings.mode}
          onValueChange={handleModeChange}
          disabled={loading || pending}
        >
          <SelectTrigger
            aria-label="自动提交"
            className={cn(
              "h-7 w-[136px] rounded-md border-border bg-transparent px-2 text-xs shadow-none",
              settings.mode !== "off" && "border-primary/40 text-primary"
            )}
          >
            <SelectValue placeholder="提交设置" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="off">不自动提交</SelectItem>
            <SelectItem value="ask">提交前确认</SelectItem>
            <SelectItem value="always">自动提交</SelectItem>
          </SelectContent>
        </Select>
        {settings.mode !== "off" && (
          <button
            type="button"
            title="配置自动提交"
            onClick={() => openDetails()}
            disabled={loading || pending}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Settings2 className="size-3.5" />
          </button>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>自动提交设置</DialogTitle>
            <DialogDescription>
              提交信息固定为：卡片编号 #comment fix:摘要 #CMBDevClaw。这里配置摘要来源与是否自动 push。
            </DialogDescription>
          </DialogHeader>

          {settingsForm}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={pending}>
              取消
            </Button>
            <Button onClick={handleSaveDraft} disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
