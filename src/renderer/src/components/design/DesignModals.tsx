export function CreateDesignModal({
  open,
  loadingKind,
  workspacePath,
  workspaceLoading,
  onSelectWorkspace,
  onCreateBlank,
  onImportUrl,
  onImportHtml,
  onClose,
}: {
  open: boolean
  loadingKind: "url" | "html" | null
  workspacePath: string | null
  workspaceLoading: boolean
  onSelectWorkspace: () => void
  onCreateBlank: () => void
  onImportUrl: () => void
  onImportHtml: () => void
  onClose: () => void
}) {
  if (!open) return null
  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}
      onClick={onClose}
    >
      <div
        style={{ background: "#fff", borderRadius: 16, padding: 24, width: 520, display: "flex", flexDirection: "column", gap: 14, boxShadow: "0 8px 40px rgba(0,0,0,0.18)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "#1a1a1a" }}>选择新建设计方式</h3>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "#8a8a8a", lineHeight: 1 }}>×</button>
        </div>
        <p style={{ margin: 0, fontSize: 13, color: "#6a6a6a", lineHeight: 1.7 }}>
          新会话可以从空白需求开始，也可以直接导入已有页面。导入后会立即进入 design 的 Tweaks 编辑链路，并复用设计产物文件系统。
        </p>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "10px 12px",
            borderRadius: 12,
            background: workspacePath ? "#f8faf8" : "#fff7e6",
            border: `1px solid ${workspacePath ? "#d6e6d6" : "#e7bf7a"}`,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#1a1a1a", marginBottom: 2 }}>工作目录</div>
            <div
              style={{
                fontSize: 12,
                color: workspacePath ? "#4f5f4f" : "#9a5b00",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: 300,
              }}
            >
              {workspaceLoading
                ? "选择中..."
                : workspacePath
                  ? workspacePath
                  : "导入链接 / HTML 前需要先选择工作目录"}
            </div>
          </div>
          <button
            onClick={onSelectWorkspace}
            disabled={workspaceLoading}
            style={{
              padding: "7px 12px",
              borderRadius: 8,
              border: "none",
              background: "#1a1a1a",
              color: "#fff",
              fontSize: 12,
              fontWeight: 600,
              cursor: workspaceLoading ? "default" : "pointer",
              fontFamily: "inherit",
              flexShrink: 0,
              opacity: workspaceLoading ? 0.6 : 1,
            }}
          >
            {workspacePath ? "切换目录" : "选择目录"}
          </button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12 }}>
          <button
            onClick={onCreateBlank}
            style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 8, padding: "16px 14px", borderRadius: 14, border: "1px solid #e0ded8", background: "#faf9f6", cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}
          >
            <span style={{ fontSize: 20 }}>✦</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: "#1a1a1a" }}>从描述开始</span>
            <span style={{ fontSize: 12, color: "#8a8a8a", lineHeight: 1.6 }}>标准的新建设计流程，会先收集问题再生成。</span>
          </button>
          <button
            onClick={onImportUrl}
            disabled={loadingKind !== null}
            style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 8, padding: "16px 14px", borderRadius: 14, border: "1px solid #e0ded8", background: "#fff8ee", cursor: loadingKind ? "default" : "pointer", textAlign: "left", fontFamily: "inherit", opacity: loadingKind && loadingKind !== "url" ? 0.6 : 1 }}
          >
            <span style={{ fontSize: 20 }}>{loadingKind === "url" ? "⏳" : "🌐"}</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: "#1a1a1a" }}>通过链接还原</span>
            <span style={{ fontSize: 12, color: "#8a8a8a", lineHeight: 1.6 }}>抓取页面 HTML，直接变成当前 design 的可编辑画布。</span>
          </button>
          <button
            onClick={onImportHtml}
            disabled={loadingKind !== null}
            style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 8, padding: "16px 14px", borderRadius: 14, border: "1px solid #e0ded8", background: "#f3f7ff", cursor: loadingKind ? "default" : "pointer", textAlign: "left", fontFamily: "inherit", opacity: loadingKind && loadingKind !== "html" ? 0.6 : 1 }}
          >
            <span style={{ fontSize: 20 }}>{loadingKind === "html" ? "⏳" : "📄"}</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: "#1a1a1a" }}>导入 HTML</span>
            <span style={{ fontSize: 12, color: "#8a8a8a", lineHeight: 1.6 }}>读取本地 HTML，并尽量保留同级依赖与资源引用。</span>
          </button>
        </div>
      </div>
    </div>
  )
}

export function LinkModal({
  open,
  mode,
  url,
  loading,
  onUrlChange,
  onConfirm,
  onClose,
}: {
  open: boolean
  mode: "reference" | "import"
  url: string
  loading?: boolean
  onUrlChange: (v: string) => void
  onConfirm: () => void
  onClose: () => void
}) {
  if (!open) return null
  const isValid = (() => {
    try {
      const parsed = new URL(url)
      return parsed.protocol === "http:" || parsed.protocol === "https:"
    } catch {
      return false
    }
  })()
  const title = mode === "import" ? "🌐 通过链接还原页面" : "🔗 通过链接关联设计图"
  const description = mode === "import"
    ? "输入网页链接后，design 会先抓取页面 HTML，还原成当前会话里的可编辑设计。"
    : "输入 Figma、Sketch、设计图或参考页面的链接，模型将把它作为视觉参考。"
  const confirmLabel = mode === "import"
    ? (loading ? "导入中..." : "开始还原")
    : "确认关联"

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}
      onClick={onClose}
    >
      <div
        style={{ background: "#fff", borderRadius: 14, padding: 24, width: 480, display: "flex", flexDirection: "column", gap: 14, boxShadow: "0 8px 40px rgba(0,0,0,0.18)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "#1a1a1a" }}>{title}</h3>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "#8a8a8a", lineHeight: 1 }}>×</button>
        </div>
        <p style={{ margin: 0, fontSize: 13, color: "#6a6a6a" }}>{description}</p>
        <input
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
          placeholder={mode === "import" ? "https://example.com/page" : "https://www.figma.com/... 或其他参考链接"}
          autoFocus
          onKeyDown={(e) => { if (e.key === "Enter" && isValid && !loading) onConfirm() }}
          style={{ border: `1px solid ${isValid || !url ? "#e0ded8" : "#e8a0a0"}`, borderRadius: 8, padding: "10px 12px", fontSize: 13, fontFamily: "inherit", outline: "none" }}
        />
        {url && !isValid && <p style={{ margin: 0, fontSize: 12, color: "#c04040" }}>请输入有效的 URL（以 http:// 或 https:// 开头）</p>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={{ padding: "8px 18px", borderRadius: 8, border: "1px solid #e0ded8", background: "#fff", fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>取消</button>
          <button
            onClick={onConfirm}
            disabled={!isValid || loading}
            style={{ padding: "8px 18px", borderRadius: 8, border: "none", background: isValid && !loading ? "#1a1a1a" : "#ccc", color: "#fff", fontSize: 13, cursor: isValid && !loading ? "pointer" : "default", fontFamily: "inherit", fontWeight: 500 }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
