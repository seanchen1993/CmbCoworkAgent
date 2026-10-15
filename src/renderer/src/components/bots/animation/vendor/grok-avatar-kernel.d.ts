/** Typed boundary for the isolated, unmodified renderer kernel. */
export type MotionState =
  | "idle"
  | "thinking"
  | "streaming"
  | "searching"
  | "reading"
  | "working"
  | "coding"
  | "running"
  | "waiting"
  | "blocked"
  | "finished"
  | "failed"
  | "sending"
  | "writing"
export type SvgTree = {
  tag: string
  attrs: Record<string, string | number>
  children: SvgTree[]
}
export interface AvatarMotion {
  readonly isSettled: boolean
  readonly loopCount: number
  readonly face: string
  readonly isPlaying: boolean
  advance(seconds: number): void
  frame(): unknown
  rest(): void
  setBody(body: string, options?: { isInstant?: boolean }): void
  setGaze(point: readonly [number, number] | null): void
  setGazeAlways(value: boolean): void
}
export interface StateDriver {
  readonly state: MotionState
  readonly clip: string | null
  setState(state: MotionState): void
  setCompact(value: boolean): void
  setEmphasis(value: boolean): void
  setResting(value: boolean): void
  advance(seconds: number): void
}
export function createMotion(options: { body: string }): AvatarMotion
export function createStateDriver(
  motion: AvatarMotion,
  state: MotionState,
  options?: { seed?: number; isCompact?: boolean; isResting?: boolean }
): StateDriver
export function avatarPaint(body: string, eyes: string): unknown
export function renderFrame(
  frame: unknown,
  paint: unknown,
  resolution: number,
  id: string,
  options: { displaySize: number; extent: number | string }
): SvgTree
export function updateSvg(parent: Element, tree: SvgTree): void
