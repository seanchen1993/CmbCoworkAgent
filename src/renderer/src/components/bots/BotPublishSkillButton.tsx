import { botApi } from "@/lib/bot-api"
import { useRef, useState } from "react"
import { Share2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { BotLibrarySkill } from "../../../../shared/bot-skill-library"
import type { BotSkill } from "../../../../shared/bot-types"

export function BotPublishSkillButton({
  skill,
  published,
  reload
}: {
  skill: BotSkill
  published?: BotLibrarySkill
  reload(): Promise<void>
}) {
  const [review, setReview] = useState<{ skill: BotSkill; revision: number; nonce: string } | null>(
    null
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const locked = useRef(false)
  const publish = async () => {
    if (!review || locked.current) return
    locked.current = true
    setBusy(true)
    setError(null)
    try {
      await botApi.publishSkill({
        nonce: review.nonce,
        botId: review.skill.botId,
        skillId: review.skill.id,
        version: review.skill.version,
        libraryRevision: review.revision
      })
      setReview(null)
      await reload()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "共享失败，请重试")
    } finally {
      locked.current = false
      setBusy(false)
    }
  }
  return (
    <div className="mt-3 border-t border-border/60 pt-3">
      <Button
        size="sm"
        variant="ghost"
        disabled={!skill.enabled || busy}
        onClick={() => {
          setError(null)
          setReview({
            skill: { ...skill },
            revision: published?.revision ?? 0,
            nonce: crypto.randomUUID()
          })
        }}
      >
        <Share2 size={13} />
        {published?.enabled ? "更新共享版本" : "共享到我的技能库"}
      </Button>
      {published?.enabled && (
        <p className="mt-1 text-xs text-muted-foreground">
          已共享源版本 {published.sourceVersion}；后续修订需确认后更新。
        </p>
      )}
      {review && (
        <div
          className="mt-3 space-y-3 rounded-lg border bg-muted/30 p-3"
          role="group"
          aria-label="确认共享技能"
        >
          <p className="text-sm font-medium">
            共享「{review.skill.name}」版本 {review.skill.version}
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            以下步骤将供你的所有 Bot
            使用。请确认其中没有专用账号、敏感数据或仅限当前项目的内容。对话、录屏和试跑记录保持私有；使用技能仍需原有操作授权。
          </p>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background p-3 font-sans text-xs leading-relaxed">
            {review.skill.instructions}
          </pre>
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void publish()}>
              确认共享
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setReview(null)}>
              取消
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
