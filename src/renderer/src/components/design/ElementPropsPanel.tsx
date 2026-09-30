import React, { useState } from "react"
import type { ElementStyles } from "./types"

function PNumInput({
  value,
  onChange,
  suffix,
  step = 1,
  min,
  max,
  readOnly,
}: {
  value: number
  onChange?: (v: number) => void
  suffix?: string
  step?: number
  min?: number
  max?: number
  readOnly?: boolean
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const displayValue = draft ?? String(value)

  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 1 }}>
      <input
        type="number"
        value={displayValue}
        readOnly={readOnly}
        step={step}
        min={min}
        max={max}
        onChange={(e) => {
          if (readOnly) return
          setDraft(e.target.value)
          const n = parseFloat(e.target.value)
          if (!isNaN(n)) onChange?.(n)
        }}
        onBlur={(e) => {
          if (readOnly) return
          const n = parseFloat(e.target.value)
          if (!isNaN(n)) onChange?.(n)
          setDraft(null)
        }}
        style={{
          background: "transparent",
          border: "none",
          outline: "none",
          fontSize: 12,
          fontWeight: 500,
          color: readOnly ? "#aaa" : "#1a1a1a",
          textAlign: "right",
          width: "60px",
          padding: 0,
          fontFamily: "inherit",
          cursor: readOnly ? "default" : "text",
        }}
      />
      {suffix && <span style={{ fontSize: 11, color: "#aaa", flexShrink: 0 }}>{suffix}</span>}
    </div>
  )
}

function PropLineRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        borderBottom: "1px solid #f0efeb",
        padding: "0 16px",
        height: 36,
        gap: 8,
      }}
    >
      <span style={{ fontSize: 12, color: "#8a8a8a", flexShrink: 0, minWidth: 60 }}>{label}</span>
      <div style={{ flex: 1, display: "flex", justifyContent: "flex-end", alignItems: "center" }}>
        {children}
      </div>
    </div>
  )
}

function PropPairRow({
  left,
  right,
}: {
  left: { label: string; children: React.ReactNode }
  right: { label: string; children: React.ReactNode }
}) {
  const half: React.CSSProperties = {
    flex: 1,
    display: "flex",
    alignItems: "center",
    padding: "0 12px",
    height: 36,
    gap: 6,
  }
  return (
    <div style={{ display: "flex", borderBottom: "1px solid #f0efeb" }}>
      <div style={{ ...half, borderRight: "1px solid #f0efeb" }}>
        <span style={{ fontSize: 12, color: "#8a8a8a", flexShrink: 0, minWidth: 40 }}>{left.label}</span>
        <div style={{ flex: 1, display: "flex", justifyContent: "flex-end" }}>{left.children}</div>
      </div>
      <div style={half}>
        <span style={{ fontSize: 12, color: "#8a8a8a", flexShrink: 0, minWidth: 40 }}>{right.label}</span>
        <div style={{ flex: 1, display: "flex", justifyContent: "flex-end" }}>{right.children}</div>
      </div>
    </div>
  )
}

function PropSectionHeader({ label }: { label: string }) {
  return (
    <div
      style={{
        padding: "10px 16px 6px",
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "0.1em",
        color: "#8a8a8a",
        textTransform: "uppercase",
        background: "#f8f7f5",
        borderBottom: "1px solid #f0efeb",
      }}
    >
      {label}
    </div>
  )
}

function CompoundRow({
  label,
  summary,
  expanded,
  onToggle,
  children,
}: {
  label: string
  summary: string
  expanded: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <>
      <div
        onClick={onToggle}
        style={{
          display: "flex",
          alignItems: "center",
          borderBottom: "1px solid #f0efeb",
          padding: "0 16px",
          height: 36,
          gap: 8,
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <span style={{ fontSize: 12, color: "#8a8a8a", flex: 1 }}>{label}</span>
        <span style={{ fontSize: 12, color: "#1a1a1a", fontWeight: 500 }}>{summary}</span>
        <span style={{ fontSize: 10, color: "#aaa", marginLeft: 4 }}>{expanded ? "^" : "v"}</span>
      </div>
      {expanded && <div style={{ background: "#f8f7f5" }}>{children}</div>}
    </>
  )
}

function TRBLRows({
  values,
  onChange,
}: {
  values: { t: number; r: number; b: number; l: number }
  onChange: (side: "t" | "r" | "b" | "l", v: number) => void
}) {
  return (
    <>
      <div style={{ display: "flex", borderBottom: "1px solid #f0efeb" }}>
        {(["t", "r"] as const).map((side) => (
          <div
            key={side}
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              padding: "0 12px",
              height: 32,
              borderRight: side === "t" ? "1px solid #f0efeb" : "none",
            }}
          >
            <span style={{ fontSize: 11, color: "#aaa", minWidth: 10 }}>{side.toUpperCase()}</span>
            <div style={{ flex: 1, display: "flex", justifyContent: "flex-end" }}>
              <PNumInput value={values[side]} suffix="px" onChange={(v) => onChange(side, v)} />
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", borderBottom: "1px solid #f0efeb" }}>
        {(["b", "l"] as const).map((side) => (
          <div
            key={side}
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              padding: "0 12px",
              height: 32,
              borderRight: side === "b" ? "1px solid #f0efeb" : "none",
            }}
          >
            <span style={{ fontSize: 11, color: "#aaa", minWidth: 10 }}>{side.toUpperCase()}</span>
            <div style={{ flex: 1, display: "flex", justifyContent: "flex-end" }}>
              <PNumInput value={values[side]} suffix="px" onChange={(v) => onChange(side, v)} />
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

export function ElementPropsPanel({
  selectedElement,
  onStyleChange,
}: {
  selectedElement: { edId: string; tagName: string; styles: ElementStyles } | null
  onStyleChange: (property: string, value: unknown) => void
}) {
  const s = selectedElement?.styles
  const [paddingOpen, setPaddingOpen] = useState(false)
  const [marginOpen, setMarginOpen] = useState(true)
  const [borderOpen, setBorderOpen] = useState(false)
  const ch = (prop: string) => (v: unknown) => onStyleChange(prop, v)

  const paddingSummary = s
    ? [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].every((v) => v === s.paddingTop)
      ? `${s.paddingTop} px`
      : `${s.paddingTop} ${s.paddingRight} ${s.paddingBottom} ${s.paddingLeft} px`
    : "0 px"

  const marginSummary = s
    ? [s.marginTop, s.marginRight, s.marginBottom, s.marginLeft].every((v) => v === s.marginTop)
      ? `${s.marginTop} px`
      : `${s.marginTop} ${s.marginRight} ${s.marginBottom} ${s.marginLeft} px`
    : "0 px"

  return (
    <div
      style={{
        width: 260,
        flexShrink: 0,
        background: "#ffffff",
        borderLeft: "1px solid #e8e6e0",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        fontFamily: "'Inter', -apple-system, sans-serif",
      }}
    >
      <div
        style={{
          padding: "0 16px",
          height: 44,
          borderBottom: "1px solid #e8e6e0",
          display: "flex",
          alignItems: "center",
          flexShrink: 0,
          background: "#ffffff",
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: "#1a1a1a" }}>
          {selectedElement ? `<${selectedElement.tagName}>` : "Properties"}
        </span>
      </div>

      {!s ? (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 24, background: "#f8f7f5" }}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" opacity={0.3}>
            <rect x="3" y="3" width="18" height="18" rx="2" stroke="#1a1a1a" strokeWidth="1.5" />
            <path d="M9 9l6 6M15 9l-6 6" stroke="#1a1a1a" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <p style={{ color: "#8a8a8a", fontSize: 12, textAlign: "center", lineHeight: 1.7, margin: 0 }}>
            点击设计中的任意元素<br />即可查看并编辑属性
          </p>
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: "auto", background: "#ffffff" }}>
          <PropSectionHeader label="Typography" />

          <PropLineRow label="Font">
            <input
              type="text"
              value={s.fontFamily}
              onChange={(e) => onStyleChange("fontFamily", e.target.value)}
              onBlur={(e) => onStyleChange("fontFamily", e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  onStyleChange("fontFamily", (e.target as HTMLInputElement).value)
                  ;(e.target as HTMLInputElement).blur()
                }
              }}
              style={{ background: "transparent", border: "none", outline: "none", fontSize: 12, fontWeight: 500, color: "#1a1a1a", textAlign: "right", fontFamily: "inherit", width: "140px" }}
            />
          </PropLineRow>

          <PropPairRow
            left={{ label: "Size", children: <PNumInput value={s.fontSize} suffix="px" step={0.5} onChange={ch("fontSize")} /> }}
            right={{ label: "Weight", children: <PNumInput value={parseInt(s.fontWeight) || 400} step={100} min={100} max={900} onChange={(v) => onStyleChange("fontWeight", String(v))} /> }}
          />

          <PropLineRow label="Color">
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="color"
                value={/^#[0-9a-fA-F]{6}$/.test(s.color) ? s.color : "#000000"}
                onChange={(e) => onStyleChange("color", e.target.value)}
                style={{ width: 20, height: 20, border: "1px solid #e0ded8", padding: 1, borderRadius: 4, cursor: "pointer", background: "none", flexShrink: 0 }}
              />
              <input
                type="text"
                value={s.color}
                onChange={(e) => onStyleChange("color", e.target.value)}
                style={{ background: "transparent", border: "none", outline: "none", fontSize: 12, fontWeight: 500, color: "#1a1a1a", textAlign: "right", fontFamily: "monospace", width: "72px" }}
              />
            </div>
          </PropLineRow>

          <PropLineRow label="Align">
            <div style={{ display: "flex", gap: 2 }}>
              {(["left", "center", "right", "justify"] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => onStyleChange("textAlign", v)}
                  style={{
                    width: 26,
                    height: 22,
                    fontSize: 10,
                    fontWeight: 600,
                    background: s.textAlign === v ? "#1a1a1a" : "#f0efeb",
                    border: "none",
                    borderRadius: 4,
                    cursor: "pointer",
                    color: s.textAlign === v ? "#fff" : "#6a6a6a",
                    fontFamily: "inherit",
                  }}
                >
                  {v.charAt(0).toUpperCase()}
                </button>
              ))}
            </div>
          </PropLineRow>

          <PropPairRow
            left={{ label: "Line", children: <PNumInput value={s.lineHeight} step={0.05} onChange={ch("lineHeight")} /> }}
            right={{ label: "Tracking", children: <PNumInput value={s.letterSpacing} suffix="px" step={0.5} onChange={ch("letterSpacing")} /> }}
          />

          <PropSectionHeader label="Size" />
          <PropPairRow
            left={{ label: "Width", children: <PNumInput value={s.width} suffix="px" readOnly /> }}
            right={{ label: "Height", children: <PNumInput value={s.height} suffix="px" readOnly /> }}
          />

          <PropSectionHeader label="Box" />
          <PropLineRow label="Opacity">
            <PNumInput value={s.opacity} step={0.05} min={0} max={1} onChange={ch("opacity")} />
          </PropLineRow>

          <CompoundRow label="Padding" summary={paddingSummary} expanded={paddingOpen} onToggle={() => setPaddingOpen((v) => !v)}>
            <TRBLRows
              values={{ t: s.paddingTop, r: s.paddingRight, b: s.paddingBottom, l: s.paddingLeft }}
              onChange={(side, v) => onStyleChange({ t: "paddingTop", r: "paddingRight", b: "paddingBottom", l: "paddingLeft" }[side], v)}
            />
          </CompoundRow>

          <CompoundRow label="Margin" summary={marginSummary} expanded={marginOpen} onToggle={() => setMarginOpen((v) => !v)}>
            <TRBLRows
              values={{ t: s.marginTop, r: s.marginRight, b: s.marginBottom, l: s.marginLeft }}
              onChange={(side, v) => onStyleChange({ t: "marginTop", r: "marginRight", b: "marginBottom", l: "marginLeft" }[side], v)}
            />
          </CompoundRow>

          <CompoundRow label="Border" summary={`${s.borderWidth} px`} expanded={borderOpen} onToggle={() => setBorderOpen((v) => !v)}>
            <PropLineRow label="Width">
              <PNumInput value={s.borderWidth} suffix="px" onChange={ch("borderWidth")} />
            </PropLineRow>
          </CompoundRow>

          <PropLineRow label="Radius">
            <PNumInput value={s.borderRadius} suffix="px" onChange={ch("borderRadius")} />
          </PropLineRow>
        </div>
      )}
    </div>
  )
}
