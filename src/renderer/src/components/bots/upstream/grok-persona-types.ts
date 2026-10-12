export type OnboardingCharacterState =
  | "sleeping"
  | "waking"
  | "idle"
  | "listening"
  | "thinking"
  | "searching"
  | "working"
  | "excited"
  | "surprised"
  | "suspicious"
  | "angry"
  | "drowsy"
  | "happy"
  | "curious"
  | "confused"
  | "bored"
  | "proud"
  | "shy"
  | "sad"
  | "laughing"
  | "scared"
  | "playful"
  | "celebrate"
  | "orbit"
  | "radar"
  | "progress"
  | "spawning"
  | "humming"
  | "loading"
  | "dictating"
  | "writing"
  | "sending"
  | "receiving"
  | "uploading"
  | "notifying"
  | "alerting"
  | "dragging"
  | "bouncing"
  | "powering-down"

export interface OnboardingCharacterVisualProps {
  color: string
  shape: string
  sizePx: number
  state: OnboardingCharacterState
  isFollowingPointer?: boolean
  paused?: boolean
  surfaceTheme?: "light"
  pointerShown?: boolean
  className?: string
  sourceId?: string
  emphasis?: boolean
  spinSignal?: number
  followTarget?: { x: number; y: number } | null
}
