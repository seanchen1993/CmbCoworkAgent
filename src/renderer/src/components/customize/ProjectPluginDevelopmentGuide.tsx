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
import { useThreadContext } from "@/lib/thread-context"
import type { SkillMetadata } from "@/types"
import { PROJECT_PLUGIN_SKILL_SHORTCUT_LABEL } from "../../../../shared/market-skill-shortcut"

type Status = "checking" | "missing" | "available" | "disabled"

export function ProjectPluginDevelopmentGuide({
  entry,
  disabled,
  startInWorkspace
}: {
  entry: "plugins" | "project" | "market" | "workspace"
  disabled?: boolean
  startInWorkspace?: (skill: SkillMetadata, isCurrent: () => boolean) => Promise<boolean>
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
    const origin = useAppStore.getState()
    const isCurrent = () => {
      const state = useAppStore.getState()
      return (
        sequence === request.current &&
        state.accountRevision === accountRevision &&
        (!startInWorkspace ||
          (state.currentThreadId === origin.currentThreadId &&
            state.mainView === origin.mainView &&
            state.showCustomizeView === origin.showCustomizeView))
      )
    }
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
      if (!isCurrent()) return
      if (!result.ok) {
        setError(result.error)
        setOpen(true)
        if (result.code === "changed") void refreshMarketSkillShortcut(accountRevision, true)
      } else if (result.value.kind === "failed") {
        setError(result.value.error)
        setOpen(true)
      } else if (result.value.kind === "available" && startInWorkspace) {
        setStatus("available")
        const opened = await startInWorkspace(result.value.skill, isCurrent)
        if (opened && sequence === request.current) setOpen(false)
      } else {
        setStatus(result.value.kind)
        setOpen(true)
      }
    } catch {
      if (isCurrent()) {
        setError("暂时无法使用此技能，请重试")
        setOpen(true)
      }
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
      {entry === "workspace" ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="mr-2 size-7 shrink-0 text-muted-foreground"
          title={PROJECT_PLUGIN_SKILL_SHORTCUT_LABEL}
          aria-label={PROJECT_PLUGIN_SKILL_SHORTCUT_LABEL}
          disabled={busy}
          onClick={() => {
            setStatus("checking")
            void check(false)
          }}
        >
          <CircleHelp className="size-4" aria-hidden />
        </Button>
      ) : (
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
      )}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{PROJECT_PLUGIN_SKILL_SHORTCUT_LABEL}</DialogTitle>
          <DialogDescription>{target.description || target.name}</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {status === "disabled"
            ? "此技能已停用，可在技能设置中启用。"
            : status === "available"
              ? startInWorkspace
                ? "选择工作目录后，打开已选中该技能的新会话。"
                : "在普通会话的技能列表中选择「" + target.skillName + "」，即可开始开发。"
              : startInWorkspace
                ? "安装后将在最近使用的工作目录打开新会话，并选中此技能。"
                : "安装后，可以从普通会话的技能列表中选择此技能。"}
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {(busy ||
          status === "missing" ||
          (status === "checking" && error) ||
          (status === "available" && startInWorkspace)) && (
          <DialogFooter>
            <Button type="button" disabled={busy} onClick={() => void check(status === "missing")}>
              {busy
                ? "正在处理…"
                : status === "missing"
                  ? startInWorkspace
                    ? "安装并开始"
                    : "安装技能"
                  : status === "available"
                    ? "开始开发"
                    : "重试"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function ProjectPluginWorkspaceShortcut(): React.JSX.Element {
  const { getThreadActions } = useThreadContext()

  return (
    <ProjectPluginDevelopmentGuide
      entry="workspace"
      startInWorkspace={async (skill, isCurrent) => {
        let workspacePath = await window.api.workspace.get()
        if (!isCurrent()) return false
        if (!workspacePath) {
          const selected = await window.api.file.selectDirectory({ title: "选择插件开发工作区" })
          if (!isCurrent() || selected.canceled || !selected.filePaths[0]) return false
          workspacePath = selected.filePaths[0]
        }

        const accountRevision = useAppStore.getState().accountRevision
        const thread = await window.api.threads.create({
          workspacePath,
          title: PROJECT_PLUGIN_SKILL_SHORTCUT_LABEL
        })
        const state = useAppStore.getState()
        if (state.accountRevision !== accountRevision) return false
        state.addThreadSummary(thread)
        getThreadActions(thread.thread_id).setDraftSkill(skill)
        if (!isCurrent()) return false
        await state.selectThread(thread.thread_id)
        return true
      }}
    />
  )
}
