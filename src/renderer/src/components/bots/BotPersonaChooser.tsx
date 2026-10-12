import { useState } from "react"
import { Check, ChevronDown, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  AVATAR_COLORS,
  AVATAR_SHAPES,
  type BotAvatarColor,
  type BotAvatarShape
} from "../../../../shared/bot-persona"
import { BotAvatar } from "./BotAvatar"
import { resolvePersonaColor, resolvePersonaShape } from "./upstream/grok-persona-geometry"

const shapeNames: Record<BotAvatarShape, string> = {
  blob: "圆团",
  pebble: "鹅卵石",
  squircle: "圆方",
  tablet: "方块",
  wedge: "三角",
  hex: "六边形",
  cloud: "云朵",
  teardrop: "水滴"
}
const colorNames: Record<BotAvatarColor, string> = {
  black: "黑色",
  brown: "棕色",
  red: "红色",
  orange: "橙色",
  yellow: "黄色",
  green: "绿色",
  cyan: "青色",
  blue: "蓝色",
  violet: "紫色",
  magenta: "粉色",
  gray: "灰色"
}

/** Grok CharacterChooser structure, using Cmb controls and staged profile persistence. */
export function BotPersonaChooser({
  agentId,
  shape,
  color,
  disabled,
  onChange
}: {
  agentId: string
  shape: BotAvatarShape | null
  color: BotAvatarColor | null
  disabled: boolean
  onChange(value: { shape: BotAvatarShape | null; color: BotAvatarColor | null }): void
}) {
  const [expanded, setExpanded] = useState(false)
  const resolvedShape = resolvePersonaShape(agentId, shape)
  const resolvedColor = resolvePersonaColor(agentId, color)
  return (
    <div className="bot-persona-editor">
      <button
        className="bot-persona-preview"
        type="button"
        disabled={disabled}
        aria-label="自定义 Bot 头像"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <BotAvatar
          agentId={agentId}
          dataUrl={null}
          shape={shape}
          color={color}
          size="xl"
          state="idle"
        />
        <span>
          自定义头像 <ChevronDown size={12} />
        </span>
      </button>
      {expanded && (
        <div className="bot-persona-options">
          <div className="bot-persona-shapes" role="group" aria-label="头像形状">
            {AVATAR_SHAPES.map((candidate) => (
              <button
                key={candidate}
                type="button"
                disabled={disabled}
                aria-label={`${shapeNames[candidate]}形状`}
                aria-pressed={resolvedShape === candidate}
                onClick={() => onChange({ shape: candidate, color })}
              >
                <BotAvatar
                  agentId={agentId}
                  dataUrl={null}
                  color={resolvedColor}
                  shape={candidate}
                  size="lg"
                  isStatic
                />
              </button>
            ))}
          </div>
          <div className="bot-persona-colors" role="group" aria-label="头像颜色">
            {AVATAR_COLORS.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                disabled={disabled}
                aria-label={`${colorNames[candidate.id]}头像`}
                aria-pressed={resolvedColor === candidate.id}
                style={{ backgroundColor: candidate.value }}
                onClick={() => onChange({ shape, color: candidate.id })}
              >
                {resolvedColor === candidate.id && <Check size={13} color="white" />}
              </button>
            ))}
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => onChange({ shape: null, color: null })}
          >
            <RotateCcw size={12} />
            恢复默认
          </Button>
        </div>
      )}
    </div>
  )
}
