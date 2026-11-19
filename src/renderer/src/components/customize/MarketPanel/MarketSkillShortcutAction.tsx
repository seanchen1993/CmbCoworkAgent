import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { useMarketSkillShortcut } from "@/lib/market-skill-shortcut"
import {
  parseMarketSkillShortcutConfig,
  type ConversationShortcutsConfig
} from "../../../../../shared/market-skill-shortcut"

export function MarketSkillShortcutAction({
  itemId,
  marketName,
  canCopy
}: {
  itemId: string
  marketName: string
  canCopy: boolean
}): React.JSX.Element | null {
  const { binding } = useMarketSkillShortcut()
  const config = parseMarketSkillShortcutConfig({ itemId, marketName })
  if (!config) return null

  const target = binding?.target
  const isPublished = target?.itemId === config.itemId && target.marketName === config.marketName
  if (!canCopy && !isPublished) return null

  async function copyConfig(): Promise<void> {
    const conversationShortcuts: ConversationShortcutsConfig = { projectPluginCreation: config }
    try {
      await navigator.clipboard.writeText(JSON.stringify({ conversationShortcuts }, null, 2))
      toast.success("已复制导航配置，请合并到发布清单")
    } catch {
      toast.error("复制导航配置失败，请重试")
    }
  }

  return (
    <>
      {isPublished && <span className="text-xs text-muted-foreground">当前会话导航</span>}
      {canCopy && (
        <Button type="button" variant="outline" size="sm" onClick={() => void copyConfig()}>
          复制导航配置
        </Button>
      )}
    </>
  )
}
