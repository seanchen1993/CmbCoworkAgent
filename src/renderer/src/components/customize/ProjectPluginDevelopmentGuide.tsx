import { useEffect, useRef, useState } from "react"
import { CircleHelp } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog"
import { refreshMarketSkillShortcut, useMarketSkillShortcut } from "@/lib/market-skill-shortcut"
import { useAppStore } from "@/lib/store"
import { PROJECT_PLUGIN_SKILL_SHORTCUT_LABEL } from "../../../../shared/market-skill-shortcut"

type Status = "checking" | "missing" | "available" | "disabled"

export function ProjectPluginDevelopmentGuide({
  entry,
  disabled
}: {
  entry: "plugins" | "project" | "market"
  disabled?: boolean
}): React.JSX.Element | null {
  const { accountRevision, binding } = useMarketSkillShortcut()
  const request = useRef(0)
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<Status>("checking")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const target = binding?.target

  useEffect(() => {
    setOpen(false)
    setBusy(false)
    return () => {
      request.current += 1
    }
  }, [accountRevision, binding?.revision])

  if (!binding || !target) return null
  const selection = { itemId: target.itemId, revision: binding.revision }

  async function check(install: boolean): Promise<void> {
    const sequence = ++request.current
    setBusy(true)
    setError("")
    try {
      const api = window.api.marketSkillShortcut
      const result = await (install ? api.install(selection) : api.resolve(selection))
      if (
        install &&
        result.ok &&
        result.value.kind === "available" &&
        useAppStore.getState().accountRevision === accountRevision
      ) {
        useAppStore.getState().bumpPluginVersion()
      }
      if (
        sequence !== request.current ||
        useAppStore.getState().accountRevision !== accountRevision
      )
        return
      if (!result.ok) {
        setError(result.error)
        if (result.code === "changed") void refreshMarketSkillShortcut(accountRevision, true)
      } else if (result.value.kind === "failed") {
        setError(result.value.error)
      } else {
        setStatus(result.value.kind)
      }
    } catch {
      if (sequence === request.current) setError("暂时无法使用此技能，请重试")
    } finally {
      if (sequence === request.current) setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (nextOpen) {
          setStatus("checking")
          void check(false)
        } else {
          request.current += 1
          setBusy(false)
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant={entry === "project" ? "link" : "outline"}
          className={entry === "project" ? "h-auto justify-start p-0 text-xs" : undefined}
          disabled={disabled}
        >
          {entry === "market" ? "开始开发" : PROJECT_PLUGIN_SKILL_SHORTCUT_LABEL}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{PROJECT_PLUGIN_SKILL_SHORTCUT_LABEL}</DialogTitle>
          <DialogDescription>{target.description || target.name}</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {status === "disabled"
            ? "此技能已停用，可在技能设置中启用。"
            : status === "available"
              ? "在普通会话的技能列表中选择「" + target.skillName + "」，即可开始开发。"
              : "安装后，可以从普通会话的技能列表中选择此技能。"}
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {(busy || status === "missing" || (status === "checking" && error)) && (
          <DialogFooter>
            <Button type="button" disabled={busy} onClick={() => void check(status === "missing")}>
              {busy ? "正在处理…" : status === "missing" ? "安装技能" : "重试"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function ProjectPluginManagementLink(): React.JSX.Element | null {
  const { binding } = useMarketSkillShortcut()
  if (!binding?.target) return null

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="mr-2 size-7 shrink-0 text-muted-foreground"
      title={PROJECT_PLUGIN_SKILL_SHORTCUT_LABEL}
      aria-label={PROJECT_PLUGIN_SKILL_SHORTCUT_LABEL}
      onClick={() => useAppStore.getState().setShowCustomizeView(true, "plugins")}
    >
      <CircleHelp className="size-4" aria-hidden />
    </Button>
  )
}
