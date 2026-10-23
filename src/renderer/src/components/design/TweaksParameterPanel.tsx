import {
  effectiveTweaks,
  type DesignTweaksState,
  type TweakValues
} from "../../../../shared/design-tweaks"

export function TweaksParameterPanel({
  state,
  disabled,
  availableKeys,
  error,
  unsaved,
  onChange,
  onCommit,
  onCommand
}: {
  state: DesignTweaksState
  disabled?: boolean
  availableKeys?: Set<string>
  error: string
  unsaved: boolean
  onChange: (key: string, value: TweakValues[string]) => void
  onCommit: () => void
  onCommand: (operation: "reset" | "undo" | "redo", key?: string) => void
}) {
  const values = effectiveTweaks(state)
  const inputStyle = {
    width: "100%",
    minWidth: 0,
    border: "1px solid #dedede",
    borderRadius: 6,
    padding: "5px 7px",
    font: "inherit"
  }
  return (
    <aside
      aria-label="设计参数"
      data-testid="design-tweaks-panel"
      style={{
        width: 248,
        flexShrink: 0,
        background: "#fff",
        borderLeft: "1px solid #e5e5e5",
        padding: 16,
        overflowY: "auto",
        fontSize: 12
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16
        }}
      >
        <strong style={{ fontSize: 14 }}>微调</strong>
        <span style={{ color: error ? "#b42318" : "#777" }}>
          {error ? "未保存" : unsaved ? "保存中…" : "已保存"}
        </span>
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button disabled={disabled || !state.past.length} onClick={() => onCommand("undo")}>
          撤销
        </button>
        <button disabled={disabled || !state.future.length} onClick={() => onCommand("redo")}>
          重做
        </button>
        <button disabled={disabled} onClick={() => onCommand("reset")}>
          重置全部
        </button>
      </div>
      {Object.entries(state.declaration.schema).map(([key, schema]) => {
        const waiting = availableKeys && !availableKeys.has(key)
        const blocked = disabled || waiting
        return (
          <div key={key} style={{ marginBottom: 16 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 6
              }}
            >
              <label htmlFor={`tweak-${key}`}>
                {schema.label}
                {waiting ? " · 待生成" : ""}
              </label>
              {Object.hasOwn(state.overrides, key) && (
                <button
                  aria-label={`重置${schema.label}`}
                  disabled={blocked}
                  onClick={() => onCommand("reset", key)}
                  style={{ border: 0, background: "none", color: "#777", cursor: "pointer" }}
                >
                  重置
                </button>
              )}
            </div>
            {schema.type === "boolean" ? (
              <input
                id={`tweak-${key}`}
                type="checkbox"
                disabled={blocked}
                checked={!!values[key]}
                onChange={(e) => {
                  onChange(key, e.target.checked)
                  queueMicrotask(onCommit)
                }}
              />
            ) : schema.type === "select" ? (
              <select
                id={`tweak-${key}`}
                disabled={blocked}
                value={String(values[key])}
                style={inputStyle}
                onChange={(e) => {
                  onChange(key, e.target.value)
                  queueMicrotask(onCommit)
                }}
              >
                {schema.options?.map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            ) : schema.type === "number" ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  id={`tweak-${key}`}
                  disabled={blocked}
                  type="range"
                  min={schema.min ?? 0}
                  max={schema.max ?? 100}
                  step={schema.step ?? 1}
                  value={Number(values[key])}
                  style={{ width: "100%" }}
                  onChange={(e) => onChange(key, Number(e.target.value))}
                  onPointerUp={onCommit}
                  onKeyUp={onCommit}
                  onBlur={onCommit}
                />
                <output>{values[key]}</output>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 8 }}>
                {schema.type === "color" && (
                  <input
                    type="color"
                    aria-label={`选择${schema.label}`}
                    disabled={blocked}
                    value={
                      /^#[\da-f]{6}$/i.test(String(values[key])) ? String(values[key]) : "#000000"
                    }
                    onChange={(e) => onChange(key, e.target.value)}
                    onBlur={onCommit}
                    style={{ width: 32, height: 28, flexShrink: 0, border: 0, padding: 0 }}
                  />
                )}
                <input
                  id={`tweak-${key}`}
                  disabled={blocked}
                  type="text"
                  value={String(values[key])}
                  maxLength={schema.maxLength ?? (schema.type === "color" ? 128 : 4000)}
                  style={inputStyle}
                  onChange={(e) => onChange(key, e.target.value)}
                  onBlur={onCommit}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onCommit()
                  }}
                />
              </div>
            )}
          </div>
        )
      })}
      {!!Object.keys(state.orphaned).length && (
        <p style={{ color: "#8a6417" }}>部分旧参数已不适用于当前页面，已保留其值。</p>
      )}
      {!!error && (
        <div role="alert" style={{ color: "#b42318" }}>
          {error}
          <button onClick={onCommit}>重试保存</button>
        </div>
      )}
    </aside>
  )
}
