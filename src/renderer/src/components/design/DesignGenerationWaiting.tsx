import { useEffect, useState } from "react"
import { ChevronLeft, ChevronRight, Lightbulb, Pause, Play, Square } from "lucide-react"
import type { DesignGenerationMetrics } from "../../../../shared/design-progressive"

const CARDS = [
  {
    label: "设计小贴士",
    title: "先看结构，再调细节",
    description: "首个框架出现后，页面会继续补齐内容与交互。好设计，从清晰的结构开始。",
    illustration: "layout"
  },
  {
    label: "修改小技巧",
    title: "把修改说到具体位置",
    description: "选中元素或添加批注，让每一次调整更聚焦，也让你的想法更准确地落在页面上。",
    illustration: "comment"
  },
  {
    label: "设计小贴士",
    title: "让页面保持一致",
    description: "使用 DESIGN.md，统一颜色、字体和组件风格，让每个页面都说同一种设计语言。",
    illustration: "system"
  },
  {
    label: "设计灵感",
    title: "给重要内容多一点空间",
    description: "适当的留白，让信息有主次，也让真正重要的内容更容易被看见。",
    illustration: "space"
  },
  {
    label: "设计者说",
    title: "好的设计，是尽可能少的设计。",
    description: "迪特·拉姆斯 · 设计师（译）",
    // Source: https://www.vitsoe.com/eu/about/good-design
    illustration: "quote"
  }
] as const

function DesignIllustration({ variant }: { variant: (typeof CARDS)[number]["illustration"] }) {
  return (
    <svg width="180" height="106" viewBox="0 0 180 106" fill="none" aria-hidden="true">
      <circle cx="107" cy="57" r="44" fill="#f7efe9" />
      <g stroke="#a99e94" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="28" y="17" width="126" height="78" rx="7" fill="#fffdfb" />
        <path d="M28 33h126" />
        <path d="M39 25h1m6 0h1m6 0h1" stroke="#cc785c" strokeWidth="3" />
        {variant === "layout" && (
          <>
            <rect x="39" y="44" width="29" height="40" rx="3" fill="#f3f0eb" stroke="none" />
            <path d="M79 47h37m-37 8h57" />
            <rect x="79" y="65" width="25" height="19" rx="3" fill="#eed5c8" stroke="none" />
            <rect x="111" y="65" width="25" height="19" rx="3" fill="#f3f0eb" stroke="none" />
          </>
        )}
        {variant === "comment" && (
          <>
            <path d="M41 47h43m-43 9h64m-64 9h52" />
            <rect
              x="38"
              y="40"
              width="72"
              height="34"
              rx="3"
              stroke="#cc785c"
              strokeDasharray="3 3"
            />
            <path d="m104 69 7 18 4-7 8-3-19-8Z" fill="#cc785c" stroke="#cc785c" />
            <path
              d="M123 38h28a5 5 0 0 1 5 5v13a5 5 0 0 1-5 5h-16l-8 6v-6h-4a5 5 0 0 1-5-5V43a5 5 0 0 1 5-5Z"
              fill="#eed5c8"
              stroke="#cc785c"
            />
            <path d="M127 47h20m-20 6h13" stroke="#cc785c" />
          </>
        )}
        {variant === "system" && (
          <>
            <circle cx="49" cy="51" r="9" fill="#cc785c" stroke="none" />
            <circle cx="74" cy="51" r="9" fill="#eed5c8" stroke="none" />
            <circle cx="99" cy="51" r="9" fill="#e9e6df" stroke="none" />
            <path d="M41 78h37m-37-7h54" />
            <rect x="105" y="64" width="34" height="18" rx="5" fill="#cc785c" stroke="none" />
            <path d="M115 73h14" stroke="#fffdfb" />
          </>
        )}
        {variant === "space" && (
          <>
            <path d="M60 54h62m-62 9h43" strokeWidth="2" />
            <path
              d="M40 42h8m-8 0v8m102-8h-8m8 0v8M40 84h8m-8 0v-8m102 8h-8m8 0v-8"
              stroke="#cc785c"
            />
            <rect x="60" y="74" width="27" height="6" rx="3" fill="#eed5c8" stroke="none" />
          </>
        )}
        {variant === "quote" && (
          <>
            <path
              d="M55 64c0-13 7-20 17-23v6c-6 3-9 7-9 12h10v15H55V64Zm32 0c0-13 7-20 17-23v6c-6 3-9 7-9 12h10v15H87V64Z"
              fill="#eed5c8"
              stroke="none"
            />
            <path d="M117 78h21" stroke="#cc785c" />
          </>
        )}
        <path d="m161 15 2 6 6 2-6 2-2 6-2-6-6-2 6-2 2-6Z" fill="#cc785c" stroke="none" />
        <path d="M17 68v8m-4-4h8" stroke="#cc785c" />
      </g>
    </svg>
  )
}

const waitingStyles = `
.design-waiting { position:absolute; inset:0; overflow:auto; display:flex; padding:32px 20px; box-sizing:border-box; background-image:radial-gradient(circle,#c8c6c0 1px,transparent 1px); background-size:24px 24px; color:#1a1a1a; container-type:inline-size; }
.design-waiting * { box-sizing:border-box; }
.design-waiting-inner { width:440px; max-width:100%; margin:auto; }
.design-waiting-card { padding:28px 30px 20px; border:1px solid #dedbd4; border-radius:22px; background:#fffdfb; box-shadow:0 12px 40px rgba(65,48,35,.045),0 2px 5px rgba(65,48,35,.025); }
.design-waiting-badge { display:inline-flex; align-items:center; gap:7px; padding:7px 10px; border-radius:7px; background:#f6e8df; color:#a9593e; font-size:12px; font-weight:600; }
.design-waiting-slides { display:grid; margin-top:23px; }
.design-waiting-slide { grid-area:1/1; min-width:0; opacity:0; visibility:hidden; transition:opacity .2s ease,visibility .2s; }
.design-waiting-slide[data-active="true"] { opacity:1; visibility:visible; }
.design-waiting-copy { min-height:119px; }
.design-waiting-title { margin:0 0 12px; max-width:340px; font-size:24px; line-height:1.45; letter-spacing:-.5px; font-weight:600; text-wrap:pretty; }
.design-waiting-description { margin:0; max-width:332px; color:#79736c; font-size:14px; line-height:1.85; }
.design-waiting-illustration { display:flex; justify-content:flex-end; margin:0 0 12px; }
.design-waiting-footer { display:flex; align-items:center; gap:12px; border-top:1px dashed #e3ded6; padding-top:16px; }
.design-waiting-count { font-size:12px; color:#9c938a; font-variant-numeric:tabular-nums; white-space:nowrap; }
.design-waiting-count strong { color:#74685e; font-size:16px; font-weight:500; }
.design-waiting-dots { display:flex; align-items:center; gap:2px; margin:0 auto; }
.design-waiting button { display:inline-flex; align-items:center; justify-content:center; padding:0; border:0; background:transparent; color:#8a8076; cursor:pointer; font-family:inherit; }
.design-waiting button:hover { color:#a9593e; background:#f6eee7; }
.design-waiting button:focus-visible { outline:2px solid #cc785c; outline-offset:3px; }
.design-waiting-dot { width:20px; height:28px; border-radius:5px; }
.design-waiting-dot span { width:5px; height:5px; border-radius:9px; background:#dcd5cd; transition:width .2s,background .2s; }
.design-waiting-dot[aria-current="true"] span { width:15px; background:#cc785c; }
.design-waiting-controls { display:flex; gap:3px; }
.design-waiting-control { width:28px; height:28px; border-radius:6px; }
.design-waiting-status { display:flex; align-items:center; justify-content:center; flex-wrap:wrap; gap:8px; margin-top:27px; font-size:13px; line-height:1.6; color:#6e675f; text-align:center; }
.design-waiting-live { display:inline-flex; align-items:center; gap:8px; }
.design-waiting-pulse { flex-shrink:0; width:6px; height:6px; border-radius:50%; background:#cc785c; animation:design-waiting-pulse 1.6s ease-in-out infinite; }
.design-waiting-time { color:#9c938a; font-size:12px; font-variant-numeric:tabular-nums; }
.design-waiting-note { margin:8px 0 0; color:#9c938a; font-size:12px; line-height:1.7; text-align:center; }
.design-waiting-cancel-row { display:flex; justify-content:center; margin-top:14px; }
.design-waiting .design-waiting-cancel { gap:5px; padding:5px 9px; border-radius:6px; font-size:12px; }
@keyframes design-waiting-pulse { 0%,100% { opacity:1; } 50% { opacity:.35; } }
@container (max-width:360px) { .design-waiting-card { padding:22px 20px 16px; border-radius:18px; } .design-waiting-title { font-size:21px; } .design-waiting-copy { min-height:142px; } .design-waiting-footer { gap:6px; } .design-waiting-controls { gap:0; } .design-waiting-dot { width:18px; } }
@container (max-width:280px) { .design-waiting-footer { flex-wrap:wrap; } .design-waiting-dots { order:3; width:100%; justify-content:center; } .design-waiting-controls { margin-left:auto; } .design-waiting-illustration svg { max-width:100%; } }
@media (prefers-reduced-motion:reduce) { .design-waiting-slide,.design-waiting-dot span { transition:none; } .design-waiting-pulse { animation:none; } }
`

export function DesignGenerationWaiting({
  metrics,
  pendingApproval = false,
  onCancel
}: {
  metrics?: DesignGenerationMetrics
  pendingApproval?: boolean
  onCancel: () => void
}) {
  const [mountedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [hidden, setHidden] = useState(() => document.hidden)
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)")
    const onMotionChange = () => setReducedMotion(media.matches)
    const onVisibilityChange = () => setHidden(document.hidden)
    media.addEventListener("change", onMotionChange)
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => {
      media.removeEventListener("change", onMotionChange)
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  }, [])

  useEffect(() => {
    if (hidden) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [hidden])

  useEffect(() => {
    if (paused || hovered || focused || hidden || reducedMotion) return
    const timer = window.setTimeout(() => setIndex((index + 1) % CARDS.length), 12000)
    return () => window.clearTimeout(timer)
  }, [paused, hovered, focused, hidden, reducedMotion, index])

  const elapsed = Math.max(0, Math.floor((now - (metrics?.startedAt ?? mountedAt)) / 1000))
  const time = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`
  const status = pendingApproval
    ? "等待确认操作后继续生成"
    : metrics?.validationStartedAt
      ? "正在检查首个页面"
      : metrics?.firstWriteAt
        ? "正在准备页面预览"
        : metrics?.firstModelChunkAt || metrics?.firstTokenAt
          ? "正在生成首个页面框架"
          : metrics?.runtimeReadyAt
            ? "正在构思页面布局"
            : "正在准备生成环境"

  return (
    <div className="design-waiting" data-testid="design-generation-waiting">
      <style>{waitingStyles}</style>
      <div className="design-waiting-inner">
        <section
          className="design-waiting-card"
          aria-label="设计灵感"
          aria-roledescription="轮播"
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onFocusCapture={() => setFocused(true)}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
          }}
        >
          <div className="design-waiting-badge">
            <Lightbulb size={14} aria-hidden="true" />
            {CARDS[index].label}
          </div>
          <div className="design-waiting-slides" aria-live="off">
            {CARDS.map((card, cardIndex) => (
              <div
                key={card.illustration}
                className="design-waiting-slide"
                data-active={cardIndex === index}
                aria-hidden={cardIndex !== index}
                role="group"
                aria-roledescription="幻灯片"
                aria-label={`${cardIndex + 1} / ${CARDS.length}`}
              >
                <div className="design-waiting-copy">
                  <h2 className="design-waiting-title">{card.title}</h2>
                  <p className="design-waiting-description">{card.description}</p>
                </div>
                <div className="design-waiting-illustration">
                  <DesignIllustration variant={card.illustration} />
                </div>
              </div>
            ))}
          </div>
          <div className="design-waiting-footer">
            <span className="design-waiting-count" aria-hidden="true">
              <strong>{String(index + 1).padStart(2, "0")}</strong> /{" "}
              {String(CARDS.length).padStart(2, "0")}
            </span>
            <div className="design-waiting-dots" aria-label="选择灵感卡片">
              {CARDS.map((card, cardIndex) => (
                <button
                  key={card.illustration}
                  type="button"
                  className="design-waiting-dot"
                  aria-label={`查看第 ${cardIndex + 1} 张灵感卡片`}
                  aria-current={cardIndex === index ? "true" : undefined}
                  onClick={() => setIndex(cardIndex)}
                >
                  <span />
                </button>
              ))}
            </div>
            <div className="design-waiting-controls">
              <button
                type="button"
                className="design-waiting-control"
                aria-label="上一张灵感卡片"
                onClick={() => setIndex((index + CARDS.length - 1) % CARDS.length)}
              >
                <ChevronLeft size={16} aria-hidden="true" />
              </button>
              {!reducedMotion && (
                <button
                  type="button"
                  className="design-waiting-control"
                  aria-label={paused ? "播放灵感卡片" : "暂停灵感卡片"}
                  onClick={() => setPaused(!paused)}
                >
                  {paused ? (
                    <Play size={12} aria-hidden="true" />
                  ) : (
                    <Pause size={12} aria-hidden="true" />
                  )}
                </button>
              )}
              <button
                type="button"
                className="design-waiting-control"
                aria-label="下一张灵感卡片"
                onClick={() => setIndex((index + 1) % CARDS.length)}
              >
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            </div>
          </div>
        </section>
        <div className="design-waiting-status">
          <span className="design-waiting-live" role="status">
            <span className="design-waiting-pulse" aria-hidden="true" />
            {status}
          </span>
          <span
            className="design-waiting-time"
            aria-label={`已等待 ${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`}
          >
            · 已等待 {time}
          </span>
        </div>
        <p className="design-waiting-note">首个框架完成后，会自动显示在这里</p>
        <div className="design-waiting-cancel-row">
          <button type="button" className="design-waiting-cancel" onClick={onCancel}>
            <Square size={10} aria-hidden="true" />
            停止生成
          </button>
        </div>
      </div>
    </div>
  )
}
