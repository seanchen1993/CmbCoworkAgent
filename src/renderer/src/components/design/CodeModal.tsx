import { useState } from "react"

export type CodeFile = { filename: string; content: string }

export function CodeModal({
  initialFiles,
  onConfirm,
  onClose,
}: {
  initialFiles: CodeFile[]
  onConfirm: (files: CodeFile[]) => void
  onClose: () => void
}) {
  const [files, setFiles] = useState<CodeFile[]>(initialFiles)
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [uploading, setUploading] = useState(false)

  const selected = files[selectedIdx]

  const mergeCodeFiles = (incoming: CodeFile[]) => {
    setFiles((prev) => {
      const merged = [...prev]
      incoming.forEach((nf) => {
        const existing = merged.findIndex((f) => f.filename === nf.filename)
        if (existing >= 0) merged[existing] = nf
        else merged.push(nf)
      })
      return merged
    })
  }

  const handleUploadClick = async () => {
    const result = await window.api.file.selectCode()
    if (result.canceled || result.filePaths.length === 0) return
    setUploading(true)
    try {
      const results = await Promise.all(result.filePaths.map((fp) => window.api.file.readText(fp)))
      const loaded: CodeFile[] = results
        .filter((r): r is { success: true; filename: string; content: string } => r.success && !!r.filename)
        .map((r) => ({ filename: r.filename, content: r.content }))
      if (loaded.length > 0) mergeCodeFiles(loaded)
    } finally {
      setUploading(false)
    }
  }

  const readFileAsText = (file: File): Promise<CodeFile> =>
    new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = (e) => resolve({ filename: file.name, content: e.target?.result as string ?? "" })
      reader.readAsText(file)
    })

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (!e.dataTransfer.files.length) return
    const loaded = await Promise.all(Array.from(e.dataTransfer.files).map(readFileAsText))
    mergeCodeFiles(loaded)
  }

  const addBlankFile = () => {
    const name = `untitled-${files.length + 1}.ts`
    setFiles((prev) => [...prev, { filename: name, content: "" }])
    setSelectedIdx(files.length)
    setEditingName(true)
  }

  const removeFile = (idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx))
    setSelectedIdx((prev) => Math.max(0, prev >= idx ? prev - 1 : prev))
  }

  const updateContent = (content: string) => {
    setFiles((prev) => prev.map((f, i) => i === selectedIdx ? { ...f, content } : f))
  }

  const updateFilename = (filename: string) => {
    setFiles((prev) => prev.map((f, i) => i === selectedIdx ? { ...f, filename } : f))
  }

  const totalLines = files.reduce((acc, f) => acc + f.content.split("\n").length, 0)

  const extColor: Record<string, string> = {
    tsx: "#3178c6",
    ts: "#3178c6",
    jsx: "#f7a41d",
    js: "#f7a41d",
    css: "#264de4",
    scss: "#c6538c",
    py: "#3572a5",
    vue: "#41b883",
    html: "#e34c26",
    json: "#a0522d",
    md: "#555",
  }
  const getColor = (name: string) => extColor[name.split(".").pop() ?? ""] ?? "#888"
  const confirmedFiles = files.filter((f) => f.content.trim())

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}
      onClick={onClose}
      onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); handleDrop(e) }}
    >
      <div
        style={{ background: "#f8f7f4", borderRadius: 16, width: 820, height: 580, display: "flex", flexDirection: "column", boxShadow: "0 12px 48px rgba(0,0,0,0.22)", border: dragging ? "2px dashed #cc785c" : "2px solid transparent", overflow: "hidden" }}
        onClick={(e) => e.stopPropagation()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={(e) => { e.stopPropagation(); setDragging(false) }}
        onDrop={(e) => { e.stopPropagation(); handleDrop(e) }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderBottom: "1px solid #e8e6e0", background: "#fff" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 18 }}>🗂️</span>
            <span style={{ fontSize: 15, fontWeight: 600, color: "#1a1a1a" }}>关联代码</span>
            {files.length > 0 && <span style={{ fontSize: 12, color: "#8a8a8a", background: "#f0eee8", borderRadius: 4, padding: "2px 7px" }}>{files.length} 个文件 · {totalLines} 行</span>}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              onClick={handleUploadClick}
              disabled={uploading}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", borderRadius: 8, border: "1px solid #e0ded8", background: "#fff", fontSize: 13, cursor: uploading ? "default" : "pointer", fontFamily: "inherit", fontWeight: 500, color: "#1a1a1a", opacity: uploading ? 0.6 : 1 }}
            >
              {uploading ? "⏳ 读取中..." : "⬆ 上传文件"}
            </button>
            <button
              onClick={addBlankFile}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", borderRadius: 8, border: "none", background: "#1a1a1a", fontSize: 13, cursor: "pointer", fontFamily: "inherit", fontWeight: 500, color: "#fff" }}
            >
              ＋ 粘贴代码
            </button>
            <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#8a8a8a", lineHeight: 1, padding: "0 4px" }}>×</button>
          </div>
        </div>

        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
          <div style={{ width: 200, borderRight: "1px solid #e8e6e0", background: "#fff", display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
              {files.length === 0 ? (
                <div style={{ padding: "24px 16px", textAlign: "center", color: "#aaa", fontSize: 12, lineHeight: 1.6 }}>
                  上传文件或<br />点击「粘贴代码」
                </div>
              ) : files.map((f, i) => (
                <div
                  key={`${f.filename}-${i}`}
                  onClick={() => { setSelectedIdx(i); setEditingName(false) }}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", cursor: "pointer", background: i === selectedIdx ? "#f4f3ef" : "transparent", borderLeft: i === selectedIdx ? "3px solid #1a1a1a" : "3px solid transparent" }}
                >
                  <span style={{ fontSize: 10, fontWeight: 700, color: getColor(f.filename), background: getColor(f.filename) + "18", borderRadius: 3, padding: "1px 4px", flexShrink: 0, textTransform: "uppercase" }}>
                    {f.filename.split(".").pop()?.slice(0, 4) ?? "txt"}
                  </span>
                  <span style={{ fontSize: 12, color: "#1a1a1a", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={f.filename}>{f.filename}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); removeFile(i) }}
                    style={{ background: "none", border: "none", cursor: "pointer", color: "#bbb", fontSize: 14, lineHeight: 1, padding: 0, flexShrink: 0, opacity: 0, transition: "opacity 0.1s" }}
                    onMouseEnter={(e) => { e.currentTarget.style.opacity = "1" }}
                    onMouseLeave={(e) => { e.currentTarget.style.opacity = "0" }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>

          {selected ? (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", borderBottom: "1px solid #e8e6e0", background: "#faf9f6" }}>
                {editingName ? (
                  <input
                    autoFocus
                    value={selected.filename}
                    onChange={(e) => updateFilename(e.target.value)}
                    onBlur={() => setEditingName(false)}
                    onKeyDown={(e) => { if (e.key === "Enter") setEditingName(false) }}
                    style={{ flex: 1, border: "1px solid #cc785c", borderRadius: 6, padding: "4px 8px", fontSize: 13, fontFamily: "monospace", outline: "none", background: "#fff" }}
                  />
                ) : (
                  <span
                    onClick={() => setEditingName(true)}
                    title="点击重命名"
                    style={{ fontSize: 13, fontFamily: "monospace", color: "#1a1a1a", cursor: "text", padding: "4px 0", borderBottom: "1px dashed #ccc" }}
                  >
                    {selected.filename}
                  </span>
                )}
                <span style={{ fontSize: 11, color: "#aaa", marginLeft: "auto" }}>{selected.content.split("\n").length} 行</span>
              </div>
              <div style={{ flex: 1, display: "flex", overflow: "hidden", fontFamily: "monospace", fontSize: 12 }}>
                <div style={{ padding: "12px 8px 12px 12px", background: "#f4f3ef", color: "#bbb", textAlign: "right", userSelect: "none", lineHeight: "20px", overflowY: "hidden", minWidth: 40, fontSize: 11 }} aria-hidden>
                  {selected.content.split("\n").map((_, i) => (
                    <div key={i}>{i + 1}</div>
                  ))}
                </div>
                <textarea
                  value={selected.content}
                  onChange={(e) => updateContent(e.target.value)}
                  placeholder="在这里粘贴或编辑代码..."
                  spellCheck={false}
                  style={{ flex: 1, padding: "12px", border: "none", outline: "none", resize: "none", fontFamily: "monospace", fontSize: 12, lineHeight: "20px", background: "#fff", color: "#1a1a1a", overflowY: "auto" }}
                />
              </div>
            </div>
          ) : (
            <div
              style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, color: "#aaa" }}
              onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
              onDrop={handleDrop}
            >
              <span style={{ fontSize: 40 }}>⬆</span>
              <p style={{ margin: 0, fontSize: 14, color: "#888", textAlign: "center", lineHeight: 1.6 }}>将代码文件拖拽到此处<br /><span style={{ fontSize: 12 }}>或点击右上角「上传文件」</span></p>
            </div>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px", borderTop: "1px solid #e8e6e0", background: "#fff" }}>
          <span style={{ fontSize: 12, color: "#aaa" }}>支持 .ts .tsx .js .jsx .css .py .vue .html 等</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onClose} style={{ padding: "8px 18px", borderRadius: 8, border: "1px solid #e0ded8", background: "#fff", fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>取消</button>
            <button
              onClick={() => onConfirm(confirmedFiles)}
              disabled={confirmedFiles.length === 0}
              style={{ padding: "8px 20px", borderRadius: 8, border: "none", background: confirmedFiles.length > 0 ? "#1a1a1a" : "#ccc", color: "#fff", fontSize: 13, cursor: confirmedFiles.length > 0 ? "pointer" : "default", fontFamily: "inherit", fontWeight: 500 }}
            >
              确认关联 {confirmedFiles.length > 0 ? `(${confirmedFiles.length} 个文件)` : ""}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
