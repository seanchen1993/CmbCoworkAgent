import { memo, useEffect, useId, useRef, useState, type JSX } from "react"
import {
  AlertTriangle,
  Check,
  ChevronDown,
  CircleHelp,
  Route,
  Sparkles,
  Users,
  Workflow,
  Zap
} from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { toast } from "sonner"

export type ChatAgentMode = "normal" | "multi" | "coordinator" | "workflow"

interface AgentModeSwitcherProps {
  mode: ChatAgentMode
  locked?: boolean
  lockedReason?: string
  showWorkflow?: boolean
  disabledModes?: Partial<Record<ChatAgentMode, boolean>>
  disabledModeReasons?: Partial<Record<ChatAgentMode, string>>
  onChange: (mode: ChatAgentMode) => void
}

const MODES: Array<{
  value: ChatAgentMode
  label: string
  shortLabel: string
  description: string
  detail: string
  badge: string
}> = [
  {
    value: "normal",
    label: "Solo Agent",
    shortLabel: "Solo",
    description: "单智能体独立完成任务，不启用子代理。",
    detail: "适合治理类任务、小改动、低风险和上下文集中的任务。",
    badge: "独立"
  },
  {
    value: "multi",
    label: "Multi Agent",
    shortLabel: "Multi",
    description: "主智能体直接执行，并按需调用专业子代理协同。",
    detail: "适合以主任务为中心的并行分析、局部实现和专家辅助。",
    badge: "分工"
  },
  {
    value: "coordinator",
    label: "Agent Team",
    shortLabel: "Team",
    description: "协调器负责拆解调度，多个独立智能体异步推进。",
    detail: "适合跨模块长任务、持续并行开发和分阶段汇总交付。",
    badge: "编排"
  },
  {
    value: "workflow",
    label: "Ultra Workflow",
    shortLabel: "Workflow",
    description: "模型编写编排脚本，批量并行子代理执行与交叉验证。",
    detail: "适合全库审计、批量迁移、大规模调研等可分解的大任务。",
    badge: "动态工作流"
  }
]

const MODE_ICONS: Record<ChatAgentMode, typeof Zap> = {
  normal: Zap,
  multi: Users,
  coordinator: Workflow,
  workflow: Sparkles
}

interface ModeTheme {
  trigger: string
  triggerIcon: string
  sliderFill: string
  activeIcon: string
  badge: string
  selectedInfo: string
}

const NEUTRAL_THEME: ModeTheme = {
  trigger:
    "border-border bg-background/80 text-muted-foreground hover:bg-muted hover:text-foreground",
  triggerIcon: "bg-muted text-muted-foreground",
  sliderFill: "bg-muted-foreground/30",
  activeIcon: "bg-muted text-muted-foreground",
  badge: "border-border bg-background text-muted-foreground",
  selectedInfo: "border-border bg-muted/60"
}

const MODE_THEMES: Record<ChatAgentMode, ModeTheme> = {
  normal: NEUTRAL_THEME,
  multi: NEUTRAL_THEME,
  coordinator: NEUTRAL_THEME,
  workflow: {
    trigger:
      "border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300",
    triggerIcon: "bg-violet-500 text-white",
    sliderFill: "bg-violet-500",
    activeIcon: "bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300",
    badge:
      "border-violet-200 bg-violet-100 text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/15 dark:text-violet-300",
    selectedInfo:
      "border-violet-200 bg-violet-50/80 dark:border-violet-500/30 dark:bg-violet-500/10"
  }
}

const WORKFLOW_MOSAIC_COLUMNS = 85
const WORKFLOW_MOSAIC_ROWS = 7
const WORKFLOW_MOSAIC_CELLS = Array.from(
  { length: WORKFLOW_MOSAIC_COLUMNS * WORKFLOW_MOSAIC_ROWS },
  (_, index) => {
    const column = index % WORKFLOW_MOSAIC_COLUMNS
    const baseDelay = ((WORKFLOW_MOSAIC_COLUMNS - 1 - column) / (WORKFLOW_MOSAIC_COLUMNS - 1)) * 3.4
    const jitter = (((index * 29) % 19) - 9) * 0.04
    return {
      delay: Math.max(0, baseDelay + jitter),
      duration: 0.92 + ((index * 17) % 7) * 0.09
    }
  }
)

const WORKFLOW_MOSAIC_ANIMATION_MS = 5600
const WORKFLOW_MOSAIC_SETTLE_START_MS = WORKFLOW_MOSAIC_ANIMATION_MS * 0.92
const WORKFLOW_MOSAIC_PURPLE = { r: 139, g: 92, b: 246 }
const WORKFLOW_MOSAIC_OPACITY_FRAMES = [
  [
    [0, 0],
    [0.16, 0],
    [0.24, 0.38],
    [0.33, 0.06],
    [0.47, 0.78],
    [0.58, 0.18],
    [0.74, 0.94],
    [0.86, 0.42],
    [1, 1]
  ],
  [
    [0, 0],
    [0.22, 0],
    [0.3, 0.72],
    [0.42, 0.12],
    [0.56, 0.48],
    [0.68, 0.08],
    [0.82, 0.88],
    [1, 1]
  ],
  [
    [0, 0],
    [0.1, 0],
    [0.19, 0.26],
    [0.28, 0],
    [0.45, 0.86],
    [0.61, 0.2],
    [0.77, 0.76],
    [0.9, 0.36],
    [1, 1]
  ]
] as const
const WORKFLOW_MOSAIC_GLITTER_FRAMES = [
  { at: 0, color: WORKFLOW_MOSAIC_PURPLE, blur: 0 },
  { at: 0.24, color: WORKFLOW_MOSAIC_PURPLE, blur: 0 },
  { at: 0.36, color: { r: 255, g: 247, b: 214 }, blur: 4 },
  { at: 0.49, color: { r: 245, g: 243, b: 255 }, blur: 5 },
  { at: 0.62, color: { r: 234, g: 220, b: 255 }, blur: 4 },
  { at: 0.78, color: WORKFLOW_MOSAIC_PURPLE, blur: 0 },
  { at: 1, color: WORKFLOW_MOSAIC_PURPLE, blur: 0 }
] as const

function sampleTimeline(progress: number, frames: readonly (readonly [number, number])[]): number {
  const clamped = Math.max(0, Math.min(1, progress))
  for (let index = 1; index < frames.length; index += 1) {
    const previous = frames[index - 1]
    const next = frames[index]
    if (clamped <= next[0]) {
      const span = next[0] - previous[0]
      const local = span === 0 ? 1 : (clamped - previous[0]) / span
      return previous[1] + (next[1] - previous[1]) * local
    }
  }
  return frames.at(-1)?.[1] ?? 1
}

function sampleGlitter(progress: number): {
  color: { r: number; g: number; b: number }
  blur: number
} {
  const clamped = Math.max(0, Math.min(1, progress))
  for (let index = 1; index < WORKFLOW_MOSAIC_GLITTER_FRAMES.length; index += 1) {
    const previous = WORKFLOW_MOSAIC_GLITTER_FRAMES[index - 1]
    const next = WORKFLOW_MOSAIC_GLITTER_FRAMES[index]
    if (clamped <= next.at) {
      const span = next.at - previous.at
      const local = span === 0 ? 1 : (clamped - previous.at) / span
      return {
        color: {
          r: previous.color.r + (next.color.r - previous.color.r) * local,
          g: previous.color.g + (next.color.g - previous.color.g) * local,
          b: previous.color.b + (next.color.b - previous.color.b) * local
        },
        blur: previous.blur + (next.blur - previous.blur) * local
      }
    }
  }
  return { color: WORKFLOW_MOSAIC_PURPLE, blur: 0 }
}

function WorkflowMosaicCanvas(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext("2d")
    if (!context) return

    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)")
    let animationFrame = 0
    let animationStartedAt = performance.now()
    let lastElapsedMs = 0
    let width = 0
    let height = 0

    const resizeCanvas = (): void => {
      const rect = canvas.getBoundingClientRect()
      const scale = window.devicePixelRatio || 1
      width = rect.width
      height = rect.height
      canvas.width = Math.max(1, Math.round(width * scale))
      canvas.height = Math.max(1, Math.round(height * scale))
      context.setTransform(scale, 0, 0, scale, 0, 0)
    }

    const drawFrame = (elapsedMs: number): void => {
      context.clearRect(0, 0, width, height)
      if (width <= 0 || height <= 0) return

      if (motionQuery.matches || elapsedMs >= WORKFLOW_MOSAIC_ANIMATION_MS) {
        context.globalAlpha = 1
        context.shadowBlur = 0
        context.fillStyle = `rgb(${WORKFLOW_MOSAIC_PURPLE.r} ${WORKFLOW_MOSAIC_PURPLE.g} ${WORKFLOW_MOSAIC_PURPLE.b})`
        context.fillRect(0, 0, width, height)
        return
      }

      const settleProgress = Math.max(
        0,
        Math.min(
          1,
          (elapsedMs - WORKFLOW_MOSAIC_SETTLE_START_MS) /
            (WORKFLOW_MOSAIC_ANIMATION_MS - WORKFLOW_MOSAIC_SETTLE_START_MS)
        )
      )
      const easedSettle = 1 - (1 - settleProgress) * (1 - settleProgress)
      const gap = 1 - easedSettle
      const verticalPadding = 0.5 * (1 - easedSettle)
      const cellWidth = (width - gap * (WORKFLOW_MOSAIC_COLUMNS - 1)) / WORKFLOW_MOSAIC_COLUMNS
      const cellHeight =
        (height - verticalPadding * 2 - gap * (WORKFLOW_MOSAIC_ROWS - 1)) / WORKFLOW_MOSAIC_ROWS
      const elapsedSeconds = elapsedMs / 1000

      WORKFLOW_MOSAIC_CELLS.forEach((cell, index) => {
        const progress = (elapsedSeconds - cell.delay) / cell.duration
        if (progress < 0) return
        const row = Math.floor(index / WORKFLOW_MOSAIC_COLUMNS)
        const column = index % WORKFLOW_MOSAIC_COLUMNS
        const opacityFrames = WORKFLOW_MOSAIC_OPACITY_FRAMES[index % 3]
        const opacity = sampleTimeline(progress, opacityFrames)
        const glitter = index % 13 === 0 ? sampleGlitter(progress) : null
        const color = glitter?.color ?? WORKFLOW_MOSAIC_PURPLE
        const blur = glitter?.blur ?? 0

        context.globalAlpha = opacity
        context.fillStyle = `rgb(${Math.round(color.r)} ${Math.round(color.g)} ${Math.round(color.b)})`
        context.shadowBlur = blur
        context.shadowColor =
          blur > 0
            ? `rgba(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)}, 0.9)`
            : "transparent"
        context.fillRect(
          column * (cellWidth + gap),
          verticalPadding + row * (cellHeight + gap),
          cellWidth,
          cellHeight
        )
      })

      context.globalAlpha = 1
      context.shadowBlur = 0
      context.shadowColor = "transparent"
    }

    const render = (now: number): void => {
      lastElapsedMs = now - animationStartedAt
      drawFrame(lastElapsedMs)
      if (lastElapsedMs < WORKFLOW_MOSAIC_ANIMATION_MS && !motionQuery.matches) {
        animationFrame = window.requestAnimationFrame(render)
      }
    }

    const restartAnimation = (): void => {
      window.cancelAnimationFrame(animationFrame)
      animationStartedAt = performance.now()
      lastElapsedMs = 0
      if (motionQuery.matches) {
        drawFrame(WORKFLOW_MOSAIC_ANIMATION_MS)
      } else {
        animationFrame = window.requestAnimationFrame(render)
      }
    }

    resizeCanvas()
    const resizeObserver = new ResizeObserver(() => {
      resizeCanvas()
      drawFrame(motionQuery.matches ? WORKFLOW_MOSAIC_ANIMATION_MS : lastElapsedMs)
    })
    resizeObserver.observe(canvas)
    motionQuery.addEventListener("change", restartAnimation)
    restartAnimation()

    return () => {
      window.cancelAnimationFrame(animationFrame)
      resizeObserver.disconnect()
      motionQuery.removeEventListener("change", restartAnimation)
    }
  }, [])

  return <canvas ref={canvasRef} aria-hidden="true" className="workflow-slider-effect" />
}

export const AgentModeSwitcher = memo(AgentModeSwitcherImpl)

function AgentModeSwitcherImpl({
  mode,
  locked,
  lockedReason,
  showWorkflow = true,
  disabledModes,
  disabledModeReasons,
  onChange
}: AgentModeSwitcherProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const [thumbHovered, setThumbHovered] = useState(false)
  const [hoveredStopIndex, setHoveredStopIndex] = useState<number | null>(null)
  const [pressedStopIndex, setPressedStopIndex] = useState<number | null>(null)
  const lockedReasonId = useId()
  const disabledModesReasonId = useId()
  const visibleModes = showWorkflow
    ? MODES
    : MODES.filter((item) => item.value !== "workflow")
  const activeMode = visibleModes.find((item) => item.value === mode) ?? visibleModes[0]
  const activeTheme = MODE_THEMES[activeMode.value]
  const ActiveIcon = MODE_ICONS[activeMode.value]
  const activeIndex = Math.max(
    0,
    visibleModes.findIndex((item) => item.value === activeMode.value)
  )
  const sliderStopPositions =
    visibleModes.length === 3
      ? ["0.9375rem", "50%", "calc(100% - 0.9375rem)"]
      : [
          "0.9375rem",
          "calc(33.3333% + 0.3125rem)",
          "calc(66.6667% - 0.3125rem)",
          "calc(100% - 0.9375rem)"
        ]
  const sliderThumbPositions = sliderStopPositions
  const sliderFillProgressByMode =
    visibleModes.length === 3
      ? ["0%", "calc(50% + 0.375rem)", "100%"]
      : [
          "0%",
          "calc(33.3333% + 0.6875rem)",
          "calc(66.6667% + 0.0625rem)",
          "100%"
        ]
  const sliderThumbPosition = sliderThumbPositions[activeIndex]
  const sliderFillProgress = sliderFillProgressByMode[activeIndex]
  const selectableModeIndexes = visibleModes.flatMap((item, index) =>
    disabledModes?.[item.value] ? [] : [index]
  )
  const disabledModesDescription = visibleModes
    .filter((item) => disabledModes?.[item.value])
    .map(
      (item) =>
        `${item.shortLabel}：${disabledModeReasons?.[item.value] ?? "当前环境不可用"}`
    )
    .join("；")

  const handleSliderChange = (index: number): void => {
    const nextMode = visibleModes[index]?.value
    if (!nextMode) return
    if (disabledModes?.[nextMode]) {
      toast.message(
        disabledModeReasons?.[nextMode] ??
          `${visibleModes[index]?.shortLabel ?? "该模式"} 当前不可用`
      )
      return
    }
    onChange(nextMode)
  }

  const modeButton = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={
        locked
          ? `执行模式：${activeMode.shortLabel}。已锁定，可打开查看原因。`
          : `执行模式：${activeMode.shortLabel}。选择执行模式。`
      }
      aria-describedby={lockedReason ? lockedReasonId : undefined}
      className={cn(
        "h-8 gap-1.5 rounded-full border px-2.5 text-xs shadow-sm transition-all",
        mode === "normal" ? NEUTRAL_THEME.trigger : activeTheme.trigger
      )}
    >
      <span
        className={cn(
          "grid size-5 place-items-center rounded-full",
          mode === "normal" ? NEUTRAL_THEME.triggerIcon : activeTheme.triggerIcon
        )}
      >
        <ActiveIcon className="size-3.5" />
      </span>
      <span className="font-medium">{activeMode.shortLabel}</span>
      <ChevronDown className="size-3 opacity-70" />
      {lockedReason && (
        <span id={lockedReasonId} className="sr-only">
          {lockedReason}
        </span>
      )}
    </Button>
  )

  const popoverContent = (
    <PopoverContent
      className="relative w-[380px] max-w-[calc(100vw-2rem)] border-border bg-background p-0 shadow-xl"
      align="start"
      sideOffset={8}
    >
      {infoOpen && (
        <div className="absolute bottom-[calc(100%+0.75rem)] -left-px z-[60] w-[calc(100%+2px)] rounded-xl border border-border bg-popover p-2 text-left text-popover-foreground shadow-xl">
          <div className="space-y-1">
            {visibleModes.map((item) => {
              const Icon = MODE_ICONS[item.value]
              const theme = MODE_THEMES[item.value]
              const selected = item.value === mode
              return (
                <div
                  key={item.value}
                  className={cn(
                    "flex items-start gap-2.5 rounded-lg border border-transparent p-2.5",
                    selected && theme.selectedInfo
                  )}
                >
                  <span
                    className={cn(
                      "grid size-9 shrink-0 place-items-center rounded-xl",
                      theme.activeIcon
                    )}
                  >
                    <Icon className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">{item.label}</span>
                      <span
                        className={cn(
                          "rounded-full border px-1.5 py-0.5 text-[10px] leading-none",
                          theme.badge
                        )}
                      >
                        {item.badge}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] leading-4 text-foreground/80">
                      {item.description}
                    </p>
                    <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">
                      {item.detail}
                    </p>
                  </div>
                  {selected && (
                    <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-foreground text-background">
                      <Check className="size-3.5" />
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
      <div className="rounded-t-md border-b border-border bg-gradient-to-br from-muted/80 via-background to-emerald-50/60 px-3 py-2 dark:to-emerald-500/10">
        <div className="flex items-center gap-2">
          <span className="grid size-7 place-items-center rounded-lg bg-foreground text-background shadow-sm">
            <Route className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
              <span>执行模式</span>
              <button
                type="button"
                aria-label={`查看当前模式 ${activeMode.label} 的说明`}
                aria-expanded={infoOpen}
                onMouseEnter={() => setInfoOpen(true)}
                onMouseLeave={() => setInfoOpen(false)}
                className="grid size-4 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <CircleHelp className="size-3.5" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {locked && lockedReason && (
        <div className="mx-2 mt-2 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{lockedReason}</span>
        </div>
      )}

      <div className="px-5 pb-2 pt-2.5">
        <div className="mx-auto mb-1 flex w-full justify-between text-sm font-semibold text-muted-foreground">
          <span>Faster</span>
          <span>Smarter</span>
        </div>
        <div className="relative mx-auto h-9 w-full">
          <div className="absolute inset-y-[3px] left-0 right-0 rounded-full border border-black/[0.06] bg-[#edf0f2] shadow-inner dark:border-white/[0.08] dark:bg-white/[0.09]">
            <div
              aria-hidden="true"
              className={cn(
                "absolute inset-y-0 left-0 rounded-full",
                activeMode.value === "workflow"
                  ? "transition-none"
                  : "transition-[width] duration-300 ease-out",
                activeMode.value === "workflow" ? NEUTRAL_THEME.sliderFill : activeTheme.sliderFill
              )}
              style={{ width: sliderFillProgress }}
            />
            {activeMode.value === "workflow" && <WorkflowMosaicCanvas />}
            {sliderStopPositions.map((position, index) => {
              const stopMode = visibleModes[index]?.value
              const stopDisabled = Boolean(stopMode && disabledModes?.[stopMode])
              return (
                <span
                  key={position}
                  aria-hidden="true"
                  className={cn(
                    "absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full transition-transform duration-150 ease-out",
                    !stopDisabled && hoveredStopIndex === index && "scale-150",
                    !stopDisabled && pressedStopIndex === index && "scale-[1.8]",
                    stopDisabled
                      ? "bg-muted-foreground/15"
                      : activeIndex > 0 && index <= activeIndex
                        ? "bg-white/50"
                        : "bg-muted-foreground/35"
                  )}
                  style={{ left: position }}
                />
              )
            })}
          </div>
          <div
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute top-1/2 z-10 size-7 -translate-x-1/2 -translate-y-1/2 rounded-full border border-black/[0.09] bg-white shadow-[0_2px_5px_rgba(0,0,0,0.15)] transition-[left,transform] duration-300 ease-out dark:border-white/20 dark:bg-zinc-100",
              thumbHovered && "scale-110"
            )}
            style={{ left: sliderThumbPosition }}
          />
          <input
            type="range"
            min={0}
            max={visibleModes.length - 1}
            step={1}
            value={activeIndex}
            disabled={locked || selectableModeIndexes.length <= 1}
            aria-label="执行模式"
            aria-valuetext={activeMode.label}
            aria-describedby={disabledModesDescription ? disabledModesReasonId : undefined}
            onChange={(event) => handleSliderChange(Number(event.currentTarget.value))}
            onPointerMove={(event) => {
              const rect = event.currentTarget.getBoundingClientRect()
              const stopCenters = visibleModes.map(
                (_, index) => 15 + ((rect.width - 30) * index) / (visibleModes.length - 1)
              )
              const thumbCenterX = stopCenters[activeIndex] ?? stopCenters[0]
              const distanceX = event.clientX - rect.left - thumbCenterX
              const distanceY = event.clientY - rect.top - rect.height / 2
              setThumbHovered(distanceX * distanceX + distanceY * distanceY <= 16 * 16)
              const pointerX = event.clientX - rect.left
              const nearestStopIndex = stopCenters.reduce(
                (nearest, center, index) =>
                  Math.abs(pointerX - center) < Math.abs(pointerX - stopCenters[nearest])
                    ? index
                    : nearest,
                0
              )
              const nearestMode = visibleModes[nearestStopIndex]?.value
              setHoveredStopIndex(
                Math.abs(pointerX - stopCenters[nearestStopIndex]) <= 14 &&
                  Math.abs(distanceY) <= 14 &&
                  !disabledModes?.[nearestMode]
                  ? nearestStopIndex
                  : null
              )
            }}
            onPointerDown={() => setPressedStopIndex(hoveredStopIndex)}
            onPointerUp={() => setPressedStopIndex(null)}
            onPointerCancel={() => setPressedStopIndex(null)}
            onPointerLeave={() => {
              setThumbHovered(false)
              setHoveredStopIndex(null)
              setPressedStopIndex(null)
            }}
            className="absolute inset-0 z-20 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
          />
          {disabledModesDescription && (
            <span id={disabledModesReasonId} className="sr-only">
              不可用模式：{disabledModesDescription}
            </span>
          )}
        </div>
        <div className="relative mt-0.5 h-4">
          {visibleModes.map((item, index) => (
            <div
              key={item.value}
              aria-disabled={disabledModes?.[item.value] || undefined}
              title={disabledModes?.[item.value] ? disabledModeReasons?.[item.value] : undefined}
              className={cn(
                "absolute top-0 w-24 min-w-0 transition-colors",
                disabledModes?.[item.value]
                  ? "cursor-not-allowed text-muted-foreground/35"
                  : index === activeIndex
                    ? "text-foreground"
                    : "text-muted-foreground"
              )}
              style={{
                left:
                  index === 0
                    ? "0"
                    : index === visibleModes.length - 1
                      ? "100%"
                      : sliderStopPositions[index],
                textAlign:
                  index === 0 ? "left" : index === visibleModes.length - 1 ? "right" : "center",
                transform:
                  index === 0
                    ? undefined
                    : index === visibleModes.length - 1
                      ? "translateX(-100%)"
                      : "translateX(-50%)"
              }}
            >
              <div className="truncate text-xs font-normal">{item.shortLabel}</div>
            </div>
          ))}
        </div>
      </div>
    </PopoverContent>
  )

  if (locked) {
    return (
      <Popover
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen)
          if (!nextOpen) setInfoOpen(false)
        }}
      >
        <PopoverTrigger asChild>{modeButton}</PopoverTrigger>
        {popoverContent}
      </Popover>
    )
  }

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (!nextOpen) setInfoOpen(false)
      }}
    >
      <PopoverTrigger asChild>{modeButton}</PopoverTrigger>
      {popoverContent}
    </Popover>
  )
}
