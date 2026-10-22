import { memo, useEffect, useId, useRef } from "react"
import { createBudgetedLoop, type BudgetedLoop } from "./animation/budgeted-loop"
import {
  createMotion,
  createStateDriver,
  renderFrame,
  updateSvg,
  avatarPaint,
  type AvatarMotion,
  type StateDriver
} from "./animation/vendor/grok-avatar-kernel"
import {
  avatarSeed,
  grokAvatarBody,
  grokAvatarGaze,
  grokAvatarState
} from "./animation/grok-avatar-adapter"
import type { BotAvatarShape, BotTask } from "../../../../shared/bots/contracts"
import type { BotAvatarMood } from "@/lib/bot-avatar-mood"
import { botAppearanceColor } from "@/lib/bot-chat-accent"
import { cn } from "@/lib/utils"

// Grok renders the character inside an oversized SVG so its optical fill is 92%.
const EXTENT = (40 * 0.92) / 0.6
const OFFSET = (40 - EXTENT) / 2
interface AvatarTarget {
  id: string
  motion: AvatarMotion
  driver: StateDriver
  host: SVGGElement
  mood: BotAvatarMood
  color: string
  shape: BotAvatarShape
  size: number
  animated: boolean
  idleAnimation: boolean
  visible: boolean
  emphasized: boolean
  dirty: boolean
  resting: boolean
  ending: boolean
  receipt?: string
  lastTime?: number
}
const targets = new Map<SVGSVGElement, AvatarTarget>()
let loop: BudgetedLoop | undefined
let observer: IntersectionObserver | undefined
let reduced: MediaQueryList | undefined
let pointer: { x: number; y: number; element: EventTarget | null } | undefined
let pointerDirty = false

function invalidatePointer(): void {
  pointerDirty = true
  loop?.wake()
}
function onPointerMove(event: PointerEvent): void {
  if (event.pointerType === "touch" || reduced?.matches) return
  pointer = { x: event.clientX, y: event.clientY, element: event.target }
  invalidatePointer()
}
function clearPointer(): void {
  pointer = undefined
  invalidatePointer()
}
function onPointerOut(event: PointerEvent): void {
  if (!event.relatedTarget) clearPointer()
}
function paint(now: number): void {
  // Batch layout reads before DOM writes; one listener/clock for the workspace.
  if (pointerDirty) {
    for (const [node, target] of targets) {
      if (!target.visible) continue
      const owner = node.closest("button") ?? node
      const emphasized = Boolean(
        target.animated &&
        !reduced?.matches &&
        pointer?.element instanceof Node &&
        owner.contains(pointer.element)
      )
      if (emphasized || target.emphasized !== emphasized) {
        target.driver.setEmphasis(emphasized)
        target.motion.setGaze(
          emphasized && pointer ? grokAvatarGaze(node.getBoundingClientRect(), pointer) : null
        )
        target.dirty = true
      }
      target.emphasized = emphasized
    }
    pointerDirty = false
  }
  for (const target of targets.values()) {
    if (!target.visible) continue
    const instant = !target.animated || Boolean(reduced?.matches)
    const resting =
      instant ||
      (target.mood === "idle" && !target.idleAnimation && !target.emphasized && !target.ending)
    if (target.resting !== resting) {
      target.resting = resting
      target.driver.setResting(resting)
      target.dirty = true
    }
    if (!target.dirty && resting && target.motion.isSettled) continue
    const delta =
      target.lastTime === undefined
        ? 0
        : Math.max(0, Math.min(0.05, (now - target.lastTime) / 1000))
    target.lastTime = now
    if (instant) {
      // Settle once for reduced motion; no ticking/blinking or leftover hover.
      for (let step = 0; step < 60; step++) target.motion.advance(0.1)
    } else {
      target.driver.advance(delta)
      target.motion.advance(delta)
      if (target.ending && target.driver.state === "idle") {
        target.ending = false
        target.dirty = true
      }
    }
    const monochrome = target.color.toLowerCase() === "#242424"
    updateSvg(
      target.host,
      renderFrame(
        target.motion.frame(),
        avatarPaint(
          monochrome ? "var(--bot-avatar-monochrome, #242424)" : botAppearanceColor(target.color),
          monochrome ? "var(--bot-avatar-monochrome-eyes, #eeeeee)" : "#111111"
        ),
        EXTENT,
        target.id,
        // Geometry uses a logical canvas; activity marks use the actual optical size.
        { displaySize: target.size, extent: EXTENT }
      )
    )
    target.dirty = false
  }
}
function wake(): void {
  pointerDirty = true
  for (const target of targets.values()) target.dirty = true
  loop?.wake()
}
function observe(node: SVGSVGElement, host: SVGGElement, target: AvatarTarget): () => void {
  if (!loop) {
    reduced = matchMedia("(prefers-reduced-motion: reduce)")
    reduced.addEventListener("change", wake)
    window.addEventListener("pointermove", onPointerMove, { passive: true })
    window.addEventListener("pointerout", onPointerOut, { passive: true })
    window.addEventListener("blur", clearPointer)
    window.addEventListener("resize", invalidatePointer)
    document.addEventListener("scroll", invalidatePointer, { capture: true, passive: true })
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const value = targets.get(entry.target as SVGSVGElement)
        if (!value) continue
        value.visible = entry.isIntersecting
        value.lastTime = undefined
        value.dirty = true
      }
      invalidatePointer()
    })
    loop = createBudgetedLoop(paint, {
      fps: 60,
      idleWhen: () => {
        for (const value of targets.values()) {
          if (!value.visible) continue
          if (value.dirty) return false
          if (!value.animated || reduced?.matches) continue
          if (!value.resting || !value.motion.isSettled) return false
        }
        return true
      }
    })
  }
  targets.set(node, target)
  observer!.observe(node)
  return () => {
    observer?.unobserve(node)
    targets.delete(node)
    host.replaceChildren()
    if (targets.size) return
    loop?.dispose()
    loop = undefined
    observer?.disconnect()
    observer = undefined
    reduced?.removeEventListener("change", wake)
    reduced = undefined
    window.removeEventListener("pointermove", onPointerMove)
    window.removeEventListener("pointerout", onPointerOut)
    window.removeEventListener("blur", clearPointer)
    window.removeEventListener("resize", invalidatePointer)
    document.removeEventListener("scroll", invalidatePointer, true)
    pointer = undefined
    pointerDirty = false
  }
}

export const BotAvatar = memo(function BotAvatar({
  color,
  shape = "drop",
  size = 42,
  busy = false,
  mood,
  settlement,
  animated = true,
  idleAnimation = false,
  className
}: {
  color: string
  shape?: BotAvatarShape
  size?: number
  busy?: boolean
  mood?: BotAvatarMood
  settlement?: Pick<BotTask, "id" | "state">
  animated?: boolean
  idleAnimation?: boolean
  className?: string
}) {
  const ref = useRef<SVGSVGElement>(null)
  const host = useRef<SVGGElement>(null)
  const id = `bot-face-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`
  useEffect(() => {
    if (!ref.current || !host.current) return
    const motion = createMotion({ body: grokAvatarBody(shape) })
    motion.setGazeAlways(true)
    const driver = createStateDriver(motion, "idle", {
      seed: avatarSeed(id),
      isCompact: size < 48,
      isResting: !idleAnimation
    })
    return observe(ref.current, host.current, {
      id,
      motion,
      driver,
      host: host.current,
      mood: "idle",
      color,
      shape,
      size,
      animated,
      idleAnimation,
      visible: false,
      emphasized: false,
      dirty: true,
      resting: !idleAnimation,
      ending: false
    })
    // The registered target survives profile and activity updates; changes below settle in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])
  useEffect(() => {
    const target = ref.current && targets.get(ref.current)
    if (!target) return
    const next = mood ?? (busy ? "work" : "idle")
    if (target.shape !== shape)
      target.motion.setBody(grokAvatarBody(shape), { isInstant: !animated || reduced?.matches })
    target.shape = shape
    target.color = color
    target.size = size
    target.animated = animated
    target.idleAnimation = idleAnimation
    const receipt = settlement && `${settlement.id}:${settlement.state}`
    if (target.mood !== next) {
      const terminal =
        next === "idle" && receipt !== target.receipt
          ? settlement?.state === "completed"
            ? "finished"
            : settlement?.state === "failed" || settlement?.state === "outcome_unknown"
              ? "failed"
              : null
          : null
      target.ending = Boolean(terminal)
      target.driver.setState(terminal ?? grokAvatarState(next))
      target.mood = next
    }
    target.receipt = receipt
    target.driver.setCompact(size < 48)
    target.dirty = true
    wake()
  }, [busy, mood, animated, idleAnimation, shape, color, size, settlement?.id, settlement?.state])
  return (
    <svg
      ref={ref}
      width={size}
      height={size}
      viewBox="0 0 40 40"
      aria-hidden="true"
      className={cn("bot-avatar", className)}
      data-mood={mood ?? (busy ? "work" : "idle")}
    >
      <g ref={host} transform={`translate(${OFFSET} ${OFFSET})`} />
    </svg>
  )
})
