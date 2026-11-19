import { useEffect, useRef, useState } from "react"
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
import {
  applyMarketSkillShortcutBinding,
  refreshMarketSkillShortcut,
  useMarketSkillShortcut
} from "@/lib/market-skill-shortcut"
import { useAppStore } from "@/lib/store"
import { isMarketSkillShortcutKey } from "../../../../../shared/market-skill-shortcut"

export function MarketSkillShortcutAction({
  itemId,
  label
}: {
  itemId: string
  label: string
}): React.JSX.Element | null {
  const { accountRevision, binding } = useMarketSkillShortcut()
  const mounted = useRef(false)
  const [confirmation, setConfirmation] = useState<{
    revision: string
    remove: boolean
    description: string
  } | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  if (!binding?.canManage || !isMarketSkillShortcutKey(itemId)) return null
  const remove = binding.assignedItemId === itemId
  const currentTargetName = binding.target?.name
  const action = remove ? "撤下会话导航" : "设为会话导航"

  function confirmAction(): void {
    if (!binding) return
    const description = remove
      ? `撤下「${label}」后，普通会话将隐藏这个入口。`
      : binding.assignedItemId
        ? `将${currentTargetName ? `「${currentTargetName}」` : "当前目标"}替换为「${label}」。`
        : `在普通会话中添加指向「${label}」的入口。`
    setConfirmation({ revision: binding.revision, remove, description })
  }

  async function save(): Promise<void> {
    if (!confirmation || saving) return
    setSaving(true)
    try {
      const result = await window.api.marketSkillShortcut.set({
        itemId: confirmation.remove ? null : itemId,
        revision: confirmation.revision
      })
      if (useAppStore.getState().accountRevision !== accountRevision) return
      if (result.ok) {
        applyMarketSkillShortcutBinding(accountRevision, result.value)
        toast.success(confirmation.remove ? "已撤下会话导航" : "已设置会话导航")
        if (mounted.current) setConfirmation(null)
      } else {
        if (result.code === "changed" || result.code === "forbidden") {
          if (mounted.current) setConfirmation(null)
          void refreshMarketSkillShortcut(accountRevision, true)
        }
        toast.error(result.error)
      }
    } catch {
      if (useAppStore.getState().accountRevision === accountRevision) {
        toast.error("暂时无法更新会话导航，请稍后重试")
      }
    } finally {
      if (mounted.current) setSaving(false)
    }
  }

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={confirmAction}>
        {action}
      </Button>
      <Dialog
        open={Boolean(confirmation)}
        onOpenChange={(open) => {
          if (!open && !saving) setConfirmation(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirmation?.remove ? "撤下会话导航" : "设为会话导航"}</DialogTitle>
            <DialogDescription>{confirmation?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => setConfirmation(null)}
            >
              取消
            </Button>
            <Button type="button" disabled={saving} onClick={() => void save()}>
              {saving ? "正在保存…" : "确认"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
