import type { BotAvatarShape } from "../../../../../shared/bots/contracts"
import type { BotAvatarMood } from "@/lib/bot-avatar-mood"
import type { MotionState } from "./vendor/grok-avatar-kernel"

// Stable persisted CMB names map to Grok's actual geometry, not approximated paths.
const bodies: Record<BotAvatarShape, string> = {
  circle: "sphere",
  cloud: "cloud",
  squircle: "square",
  spark: "sparkle",
  clover: "clover",
  heart: "heartChubby",
  flower: "starFlower",
  drop: "teardrop",
  pill: "tablet",
  triangle: "wedge",
  house: "house",
  star: "star6",
  hexagon: "hex"
}
const states: Record<BotAvatarMood, MotionState> = {
  idle: "idle",
  think: "thinking",
  work: "working",
  read: "reading",
  write: "writing",
  run: "running",
  search: "searching",
  send: "sending",
  orbit: "waiting",
  stream: "streaming",
  blocked: "blocked"
}
export const grokAvatarBody = (shape: BotAvatarShape) => bodies[shape]
export const grokAvatarState = (mood: BotAvatarMood) => states[mood]

export function avatarSeed(id: string): number {
  let seed = 2166136261
  for (let index = 0; index < id.length; index++)
    seed = Math.imul(seed ^ id.charCodeAt(index), 16777619)
  return seed >>> 0
}

/** Grok's attachMarkHoverGaze uses .5; the global pointer-follow default is 2. */
export function grokAvatarGaze(
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  point: { x: number; y: number }
): readonly [number, number] {
  const radius = Math.max(rect.width, 1) * 0.5
  const clamp = (value: number) => Math.max(-1, Math.min(1, value))
  return [
    clamp((point.x - rect.left - rect.width / 2) / radius),
    clamp(-(point.y - rect.top - rect.height / 2) / radius)
  ]
}
