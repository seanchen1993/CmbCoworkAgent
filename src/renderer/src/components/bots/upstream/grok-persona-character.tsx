import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties
} from "react"
import type { OnboardingCharacterVisualProps } from "./grok-persona-types"
import type { OnboardingCharacterState } from "./grok-persona-types"

import {
  VIEWBOX,
  CENTER,
  COLORS,
  resolvePersonaColor,
  personaRestContour
} from "./grok-persona-geometry"

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  )
}

const MOTION: Record<
  OnboardingCharacterState,
  { amplitude: number; period: number; tilt: number; eye: number }
> = {
  sleeping: { amplitude: 0, period: 6000, tilt: 0, eye: 0.12 },
  waking: { amplitude: 2, period: 800, tilt: 0, eye: 0.35 },
  idle: { amplitude: 1.5, period: 9000, tilt: 0, eye: 1 },
  listening: { amplitude: 1.8, period: 2800, tilt: -2, eye: 1 },
  thinking: { amplitude: 1, period: 2000, tilt: 3, eye: 0.75 },
  searching: { amplitude: 2, period: 1000, tilt: -4, eye: 0.9 },
  working: { amplitude: 2, period: 1800, tilt: -3, eye: 1 },
  loading: { amplitude: 2, period: 6000, tilt: 3, eye: 0.9 },
  excited: { amplitude: 5, period: 1100, tilt: 0, eye: 1.08 },
  surprised: { amplitude: 3, period: 2500, tilt: 0, eye: 1.18 },
  suspicious: { amplitude: 1, period: 2600, tilt: 7, eye: 0.75 },
  angry: { amplitude: 1, period: 2200, tilt: -7, eye: 0.65 },
  drowsy: { amplitude: 0.5, period: 4000, tilt: 0, eye: 0.25 },
  happy: { amplitude: 3, period: 2500, tilt: 0, eye: 1.08 },
  curious: { amplitude: 2, period: 1800, tilt: 6, eye: 1 },
  confused: { amplitude: 1, period: 2200, tilt: -5, eye: 0.8 },
  bored: { amplitude: 0.4, period: 3500, tilt: -8, eye: 0.45 },
  proud: { amplitude: 2, period: 3500, tilt: 4, eye: 1 },
  shy: { amplitude: 1, period: 3000, tilt: -8, eye: 0.55 },
  sad: { amplitude: 1, period: 4000, tilt: -4, eye: 0.6 },
  laughing: { amplitude: 4, period: 1200, tilt: 0, eye: 0.8 },
  scared: { amplitude: 3, period: 900, tilt: 0, eye: 1.1 },
  playful: { amplitude: 4, period: 1500, tilt: 8, eye: 1.05 },
  celebrate: { amplitude: 7, period: 1400, tilt: 0, eye: 1.12 },
  orbit: { amplitude: 2, period: 4000, tilt: 12, eye: 1 },
  radar: { amplitude: 2, period: 4000, tilt: -12, eye: 1 },
  progress: { amplitude: 2, period: 4000, tilt: 0, eye: 1 },
  spawning: { amplitude: 5, period: 1200, tilt: 0, eye: 1 },
  humming: { amplitude: 1.5, period: 5000, tilt: 0, eye: 0.9 },
  dictating: { amplitude: 2, period: 4000, tilt: 0, eye: 1 },
  writing: { amplitude: 2, period: 4000, tilt: -4, eye: 1 },
  sending: { amplitude: 2, period: 4000, tilt: 0, eye: 1 },
  receiving: { amplitude: 2, period: 4000, tilt: 0, eye: 1 },
  uploading: { amplitude: 2, period: 4000, tilt: 0, eye: 1 },
  notifying: { amplitude: 3, period: 1500, tilt: 0, eye: 1.1 },
  alerting: { amplitude: 2, period: 2000, tilt: 0, eye: 1.1 },
  dragging: { amplitude: 3, period: 1600, tilt: 5, eye: 1 },
  bouncing: { amplitude: 7, period: 3000, tilt: 0, eye: 1 },
  "powering-down": { amplitude: 0, period: 6000, tilt: 0, eye: 0.12 }
}

export interface OnboardingCharacterHandle {
  spin(): void
  bounce(): void
  burst(): void
}

export const OnboardingCharacter = forwardRef<
  OnboardingCharacterHandle,
  OnboardingCharacterVisualProps
>(function OnboardingCharacter(
  {
    color,
    shape,
    sizePx,
    state,
    isFollowingPointer = false,
    paused = false,
    surfaceTheme,
    pointerShown = false,
    className,
    sourceId,
    emphasis = false,
    spinSignal = 0,
    followTarget = null
  },
  ref
) {
  const id = useId().replace(/:/g, "")
  const faceRef = useRef<SVGGElement>(null)
  const eyesRef = useRef<SVGGElement>(null)
  const [motionAllowed, setMotionAllowed] = useState(false)
  const [reduceMotion, setReduceMotion] = useState(reducedMotion)
  const gazeRef = useRef({ x: 0, y: 0 })
  const actionRef = useRef<"spin" | "bounce" | "burst" | null>(null)
  const resolvedColor = resolvePersonaColor(sourceId ?? "persona", color)
  const colors = COLORS[resolvedColor] ?? COLORS.black
  const contour = personaRestContour(shape)
  const motion = MOTION[state] ?? MOTION.idle
  const eyeTransform = `translate(0 ${contour.eyeY * (1 - motion.eye)}) scale(1 ${motion.eye})`
  // Local adaptation: long rosters must not animate offscreen or hidden avatars.
  useEffect(() => {
    const svg = faceRef.current?.ownerSVGElement
    if (!svg) return
    const media = window.matchMedia("(prefers-reduced-motion: reduce)")
    let visible = false
    const update = () => {
      setReduceMotion(media.matches)
      setMotionAllowed(visible && !document.hidden && !media.matches)
    }
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting
      update()
    })
    observer.observe(svg)
    document.addEventListener("visibilitychange", update)
    media.addEventListener("change", update)
    update()
    return () => {
      observer.disconnect()
      document.removeEventListener("visibilitychange", update)
      media.removeEventListener("change", update)
    }
  }, [])
  useImperativeHandle(
    ref,
    () => ({
      spin: () => {
        actionRef.current = "spin"
      },
      bounce: () => {
        actionRef.current = "bounce"
      },
      burst: () => {
        actionRef.current = "burst"
      }
    }),
    []
  )

  useEffect(() => {
    if (!motionAllowed || paused || (!isFollowingPointer && followTarget == null)) return
    const handlePointerMove = (event: PointerEvent) => {
      const node = faceRef.current?.ownerSVGElement
      const rect = node?.getBoundingClientRect()
      if (rect == null || rect.width === 0 || rect.height === 0) return
      gazeRef.current = {
        x: Math.max(
          -1,
          Math.min(1, (event.clientX - (rect.left + rect.width / 2)) / (rect.width / 2))
        ),
        y: Math.max(
          -1,
          Math.min(1, (event.clientY - (rect.top + rect.height / 2)) / (rect.height / 2))
        )
      }
    }
    const clearPointer = () => {
      gazeRef.current = { x: 0, y: 0 }
    }
    window.addEventListener("pointermove", handlePointerMove, { passive: true })
    document.documentElement.addEventListener("pointerleave", clearPointer)
    if (followTarget != null) {
      const node = faceRef.current?.ownerSVGElement
      const rect = node?.getBoundingClientRect()
      if (rect != null && rect.width > 0 && rect.height > 0)
        gazeRef.current = {
          x: Math.max(
            -1,
            Math.min(1, (followTarget.x - (rect.left + rect.width / 2)) / (rect.width / 2))
          ),
          y: Math.max(
            -1,
            Math.min(1, (followTarget.y - (rect.top + rect.height / 2)) / (rect.height / 2))
          )
        }
    }
    return () => {
      window.removeEventListener("pointermove", handlePointerMove)
      document.documentElement.removeEventListener("pointerleave", clearPointer)
      clearPointer()
    }
  }, [followTarget, isFollowingPointer, motionAllowed, paused])

  useEffect(() => {
    const face = faceRef.current,
      eyes = eyesRef.current
    if (spinSignal > 0) actionRef.current = "spin"
    if (face == null || eyes == null) return
    face.setAttribute("transform", "translate(0 0)")
    eyes.setAttribute("transform", eyeTransform)
    if (!motionAllowed || paused) return
    let frame = 0
    let actionStarted: number | null = null
    const started = performance.now()
    const tick = (time: number) => {
      const elapsed = time - started
      let action = actionRef.current
      if (action && actionStarted == null) actionStarted = time
      const actionElapsed = actionStarted == null ? 0 : time - actionStarted
      if (action && actionElapsed >= (action === "spin" ? 1000 : 700)) {
        actionRef.current = null
        actionStarted = null
        action = null
      }
      const phase = (elapsed / motion.period) * Math.PI * 2
      const bounce =
        action === "bounce" || action === "burst"
          ? Math.sin((actionElapsed / 700) * Math.PI) * 8
          : 0
      const spin = action === "spin" ? (actionElapsed / 1000) * 360 : 0
      const bob = Math.sin(phase) * motion.amplitude
      const gaze = gazeRef.current
      face.setAttribute(
        "transform",
        `translate(0 ${-bob - bounce}) rotate(${motion.tilt + spin} ${CENTER} ${CENTER})`
      )
      eyes.setAttribute(
        "transform",
        `translate(${gaze.x * 4} ${gaze.y * 3 + contour.eyeY * (1 - motion.eye)}) scale(1 ${motion.eye})`
      )
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [contour.eyeY, eyeTransform, motion, motionAllowed, paused, spinSignal])

  const ink = surfaceTheme ? colors[surfaceTheme] : `light-dark(${colors.light}, ${colors.dark})`
  const rootStyle: CSSProperties = {
    display: "block",
    height: sizePx,
    overflow: "visible",
    userSelect: "none",
    WebkitUserSelect: "none",
    width: sizePx
  }
  return (
    <svg
      aria-hidden="true"
      className={className}
      data-emphasis={emphasis || undefined}
      data-grok-state={state}
      data-paused={paused || !motionAllowed || undefined}
      data-pointer-shown={pointerShown || undefined}
      data-reduced-motion={reduceMotion ? "true" : "false"}
      data-source-id={sourceId || undefined}
      height={sizePx}
      style={rootStyle}
      viewBox={VIEWBOX}
      width={sizePx}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <mask
          id={`${id}-eyes`}
          maskUnits="userSpaceOnUse"
          x="-15"
          y="-15"
          width="259"
          height="259"
          style={{ maskType: "luminance" }}
        >
          <rect x="-15" y="-15" width="259" height="259" fill="white" />
          <g ref={eyesRef} fill="black" transform={eyeTransform}>
            <path d={contour.eyes} />
          </g>
        </mask>
      </defs>
      <g ref={faceRef} transform="translate(0 0)">
        <path d={contour.body} fill={ink} mask={`url(#${id}-eyes)`} />
      </g>
    </svg>
  )
})

export function DefaultOnboardingCharacterRenderer(props: OnboardingCharacterVisualProps) {
  return <OnboardingCharacter {...props} />
}
