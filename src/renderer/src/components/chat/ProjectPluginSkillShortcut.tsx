import { useEffect, useRef, useState } from "react"
import { Loader2, Puzzle } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { refreshMarketSkillShortcut, useMarketSkillShortcut } from "@/lib/market-skill-shortcut"
import { useAppStore } from "@/lib/store"
import type { SkillMetadata } from "@/types"
import {
  PROJECT_PLUGIN_SKILL_SHORTCUT_LABEL,
  type MarketSkillShortcutSelection,
  type MarketSkillShortcutTarget
} from "../../../../shared/market-skill-shortcut"

interface Props {
  threadId: string
  disabled: boolean
  requiresReplacement: (skill: SkillMetadata) => boolean
  selectSkill: (skill: SkillMetadata) => void
  openSkillSettings: () => void
}

interface Intent {
  accountRevision: number
  target: MarketSkillShortcutTarget
  selection: MarketSkillShortcutSelection
}

type DialogState = Intent &
  ({ kind: "install"; error?: string } | { kind: "disabled" } | { kind: "replace" })

export function ProjectPluginSkillShortcut(props: Props): React.JSX.Element | null {
  const { accountRevision, binding } = useMarketSkillShortcut()
  const latestProps = useRef(props)
  latestProps.current = props
  const request = useRef(0)
  const controlRef = useRef<HTMLButtonElement>(null)
  const focusComposer = useRef(false)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    request.current += 1
    setBusy(false)
    setDialog(null)
    return () => {
      request.current += 1
    }
  }, [accountRevision, props.threadId])

  const visibleDialog = dialog && dialog.accountRevision === accountRevision ? dialog : null
  const target = binding?.target
  if (!target && !visibleDialog) return null

  function canApply(intent: Intent): boolean {
    const state = useAppStore.getState()
    return (
      state.accountRevision === intent.accountRevision &&
      state.currentThreadId === props.threadId &&
      state.mainView === "thread" &&
      !state.showCustomizeView &&
      !latestProps.current.disabled
    )
  }

  function select(skill: SkillMetadata): void {
    focusComposer.current = true
    setDialog(null)
    latestProps.current.selectSkill(skill)
  }

  async function run(intent: Intent, install: boolean, replace = false): Promise<void> {
    const sequence = ++request.current
    setBusy(true)
    try {
      const api = window.api.marketSkillShortcut
      const result = await (install ? api.install(intent.selection) : api.resolve(intent.selection))
      if (request.current !== sequence || !canApply(intent)) return
      if (!result.ok) {
        if (result.code === "changed" || result.code === "forbidden") {
          setDialog(null)
          void refreshMarketSkillShortcut(intent.accountRevision, true)
        } else if (install) {
          setDialog({ ...intent, kind: "install", error: result.error })
          return
        }
        toast.error(result.error)
        return
      }

      const skill = result.value
      if (skill.kind === "available") {
        if (!replace && latestProps.current.requiresReplacement(skill.skill)) {
          setDialog({ ...intent, kind: "replace" })
        } else {
          select(skill.skill)
        }
      } else if (skill.kind === "disabled") {
        setDialog({ ...intent, kind: "disabled" })
      } else {
        setDialog({
          ...intent,
          kind: "install",
          ...(skill.kind === "failed" ? { error: skill.error } : {})
        })
      }
    } catch {
      if (request.current !== sequence || !canApply(intent)) return
      const error = "暂时无法使用此技能，请稍后重试"
      if (install) setDialog({ ...intent, kind: "install", error })
      else toast.error(error)
    } finally {
      if (request.current === sequence) setBusy(false)
    }
  }

  function close(): void {
    request.current += 1
    setBusy(false)
    setDialog(null)
  }

  return (
    <>
      {target && binding && (
        <div className="mb-2 flex justify-start">
          <Button
            ref={controlRef}
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            disabled={props.disabled || busy}
            onClick={() => {
              focusComposer.current = false
              void run(
                {
                  accountRevision,
                  target,
                  selection: { itemId: target.itemId, revision: binding.revision }
                },
                false
              )
            }}
          >
            {busy && !visibleDialog ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <Puzzle className="size-3.5" aria-hidden />
            )}
            {PROJECT_PLUGIN_SKILL_SHORTCUT_LABEL}
          </Button>
        </div>
      )}
      <Dialog
        open={Boolean(visibleDialog)}
        onOpenChange={(open) => {
          if (!open) close()
        }}
      >
        {visibleDialog && (
          <DialogContent
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              if (!focusComposer.current) controlRef.current?.focus()
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {visibleDialog.kind === "replace"
                  ? "替换当前草稿的技能"
                  : visibleDialog.target.name}
              </DialogTitle>
              <DialogDescription>
                {visibleDialog.kind === "install"
                  ? visibleDialog.target.description || "安装后可以在此会话中使用。"
                  : visibleDialog.kind === "disabled"
                    ? "此技能已停用，可在技能设置中启用。"
                    : `将草稿当前选择替换为「${visibleDialog.target.name}」。`}
              </DialogDescription>
            </DialogHeader>
            {visibleDialog.kind === "install" && visibleDialog.error && (
              <p role="alert" className="text-sm text-destructive">
                {visibleDialog.error}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={close}>
                {busy && visibleDialog.kind === "install" ? "关闭" : "取消"}
              </Button>
              {visibleDialog.kind === "install" && (
                <Button
                  type="button"
                  disabled={busy || props.disabled}
                  onClick={() => {
                    if (canApply(visibleDialog)) void run(visibleDialog, true)
                  }}
                >
                  {busy ? "正在安装…" : "安装并使用"}
                </Button>
              )}
              {visibleDialog.kind === "disabled" && (
                <Button
                  type="button"
                  onClick={() => {
                    close()
                    props.openSkillSettings()
                  }}
                >
                  前往启用
                </Button>
              )}
              {visibleDialog.kind === "replace" && (
                <Button
                  type="button"
                  disabled={busy || props.disabled}
                  onClick={() => {
                    if (canApply(visibleDialog)) void run(visibleDialog, false, true)
                  }}
                >
                  {busy ? "正在检查…" : "替换"}
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </>
  )
}
