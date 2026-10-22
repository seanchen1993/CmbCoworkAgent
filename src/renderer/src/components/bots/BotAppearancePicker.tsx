import { botErrorMessage } from "@/lib/bot-error-message"
import { botAppearanceColor } from "@/lib/bot-chat-accent"
import { botAvatarRings } from "@/assets/bot-avatar-rings"
import { useRef, useState, type ComponentProps } from "react"
import { Loader2 } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  BOT_AVATAR_SHAPES,
  type BotAvatarShape,
  type BotClient,
  type BotDefinition
} from "../../../../shared/bots/contracts"
import { BotAvatar } from "./BotAvatar"
import { BotRuntimeAvatar } from "./BotRuntimeAvatar"
import { BOT_COLORS } from "../../../../shared/bots/appearance"
const SHAPE_LABELS: Record<BotAvatarShape, string> = {
  drop: "水滴",
  circle: "团块",
  squircle: "方形",
  pill: "药片",
  triangle: "楔形",
  hexagon: "六边形",
  cloud: "云朵",
  spark: "星芒",
  clover: "四叶草",
  heart: "爱心",
  flower: "花朵",
  house: "房子",
  star: "星形"
}
type Appearance = { color: string; shape?: BotAvatarShape }

/** Shared by creation and the profile popover; thumbnails never register animation clocks. */
export function BotAppearancePicker({
  value,
  disabled,
  onChange
}: {
  value: Appearance
  disabled?: boolean
  onChange(value: Appearance): void
}) {
  return (
    <fieldset disabled={disabled} className="bot-appearance-picker">
      <legend className="sr-only">Bot 外观</legend>
      <div className="bot-shape-picker" role="group" aria-label="头像形状">
        {BOT_AVATAR_SHAPES.map((shape) => (
          <button
            key={shape}
            type="button"
            title={SHAPE_LABELS[shape]}
            aria-label={`${SHAPE_LABELS[shape]}形状`}
            aria-pressed={(value.shape ?? "drop") === shape}
            onClick={() => onChange({ ...value, shape })}
          >
            <BotAvatar color={value.color} shape={shape} size={36} animated={false} />
            <span
              aria-hidden="true"
              className="bot-shape-ring"
              style={{ maskImage: `url("${botAvatarRings[shape]}")` }}
            />
          </button>
        ))}
      </div>
      <div className="bot-color-picker" role="group" aria-label="头像颜色">
        {BOT_COLORS.map(([color, label]) => (
          <button
            key={color}
            type="button"
            title={label}
            aria-label={`${label}头像`}
            aria-pressed={
              botAppearanceColor(value.color).toLowerCase() === botAppearanceColor(color)
            }
            className="bot-color"
            style={{
              backgroundColor:
                color === "#242424"
                  ? "var(--bot-avatar-monochrome, #242424)"
                  : botAppearanceColor(color)
            }}
            onClick={() => onChange({ ...value, color })}
          />
        ))}
      </div>
    </fieldset>
  )
}

export function BotAvatarEditor({
  bot,
  client,
  busy,
  settlement,
  waiting = false
}: {
  bot: BotDefinition
  client: BotClient
  busy: boolean
  settlement?: ComponentProps<typeof BotRuntimeAvatar>["settlement"]
  waiting?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(bot)
  const [error, setError] = useState<string | null>(null)
  const lock = useRef(false)
  // The response can arrive before the subscription snapshot; keep its new version.
  const current = saved.version > bot.version ? saved : bot
  const update = async (appearance: Appearance) => {
    if (lock.current || (appearance.color === current.color && appearance.shape === current.shape))
      return
    lock.current = true
    setSaving(true)
    setError(null)
    try {
      setSaved(await client.update({ ...current, ...appearance, expectedVersion: current.version }))
    } catch (cause) {
      setError(botErrorMessage(cause, "头像保存失败，请重试"))
    } finally {
      lock.current = false
      setSaving(false)
    }
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="bot-avatar-edit-trigger" aria-label="编辑 Bot 头像">
          <BotRuntimeAvatar
            threadId={bot.threadId}
            color={current.color}
            shape={current.shape}
            size={64}
            busy={busy}
            settlement={settlement}
            waiting={waiting}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        data-bot-popup
        className="bot-appearance-popover"
        sideOffset={12}
        aria-label="头像编辑器"
      >
        <div className="bot-appearance-heading">
          <span className="bot-appearance-tab">Bot</span>
          {saving && <Loader2 size={14} className="animate-spin" aria-label="正在保存头像" />}
          <button
            disabled={saving}
            aria-label="将角色重置为默认"
            onClick={() => void update({ color: "#ed2040", shape: "drop" })}
          >
            重置
          </button>
        </div>
        <BotAppearancePicker
          value={current}
          disabled={saving}
          onChange={(value) => {
            void update(value)
          }}
        />
        {error && (
          <p role="alert" className="px-4 pb-3 text-xs text-destructive">
            {error}
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}
