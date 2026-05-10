import { useState } from "react"
import type { SessionMeta } from "./types"

function getPathName(filePath: string | null): string {
  if (!filePath) return ""
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath
}

function getSessionKindLabel(kind: SessionMeta["kind"] | undefined): string {
  if (kind === "import_url") return "URL 导入"
  if (kind === "import_html") return "HTML 导入"
  return "Prompt"
}

export function DesignGallery({
  sessionIndex,
  onOpen,
  onNew,
  onDelete,
  workspacePath,
  workspaceLoading,
  onSelectWorkspace,
}: {
  sessionIndex: SessionMeta[]
  onOpen: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  workspacePath: string | null
  workspaceLoading: boolean
  onSelectWorkspace: () => void
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  function fmt(ts: number) {
    const d = new Date(ts)
    const now = new Date()
    const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000)
    if (diffDays === 0) return "今天 " + d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    if (diffDays === 1) return "昨天"
    if (diffDays < 7)  return `${diffDays} 天前`
    return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric" })
  }

  return (
    <div style={{
      display: "flex", flexDirection: "column", height: "100%",
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
      background: "#f0efeb",
    }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0 28px", height: 56, background: "#f0efeb", flexShrink: 0,
        borderBottom: "1px solid #e0ded8",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 30, height: 30, borderRadius: "50%",
            background: "#cc785c",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "#fff", fontSize: 15,
          }}>✦</div>
          <span style={{ fontSize: 17, fontWeight: 600, color: "#1a1a1a" }}>My Designs</span>
          {sessionIndex.length > 0 && (
            <span style={{
              fontSize: 12, color: "#8a8a8a",
              background: "#e8e6e0", borderRadius: 99,
              padding: "2px 8px", fontWeight: 500,
            }}>{sessionIndex.length}</span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button
            onClick={onSelectWorkspace}
            disabled={workspaceLoading}
            style={{
              display: "flex", alignItems: "center", gap: 6,
              maxWidth: 260,
              padding: "7px 12px",
              fontSize: 12, fontWeight: 600,
              background: workspacePath ? "#ffffff" : "#fff7e6",
              color: workspacePath ? "#1a1a1a" : "#9a5b00",
              border: `1px solid ${workspacePath ? "#d4d2cc" : "#e7bf7a"}`,
              borderRadius: 10, cursor: workspaceLoading ? "default" : "pointer",
              fontFamily: "inherit", opacity: workspaceLoading ? 0.7 : 1,
            }}
            title={workspacePath ? workspacePath : "选择工作目录"}
          >
            <span style={{ fontSize: 12 }}>📁</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {workspaceLoading ? "选择中..." : workspacePath ? getPathName(workspacePath) : "选择工作目录"}
            </span>
          </button>
          <button
            onClick={onNew}
            style={{
              display: "flex", alignItems: "center", gap: 7,
              padding: "8px 20px", fontSize: 14, fontWeight: 600,
              background: "#1a1a1a", color: "#fff",
              border: "none", borderRadius: 10, cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            <span style={{ fontSize: 16, lineHeight: 1 }}>+</span>
            新建设计
          </button>
        </div>
      </div>

      <div style={{
        flex: 1, overflowY: "auto", padding: "32px 28px",
      }}>
        {sessionIndex.length === 0 ? (
          <div style={{
            display: "flex", flexDirection: "column", alignItems: "center",
            justifyContent: "center", height: "100%", gap: 20,
            color: "#8a8a8a",
          }}>
            <div style={{
              width: 72, height: 72, borderRadius: 20,
              background: "#ffffff", border: "2px dashed #d4d2cc",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 28, color: "#c0beb8",
            }}>✦</div>
            <div style={{ textAlign: "center" }}>
              <p style={{ fontSize: 16, fontWeight: 600, color: "#4a4a4a", margin: "0 0 6px" }}>还没有设计记录</p>
              <p style={{ fontSize: 13, color: "#8a8a8a", margin: 0 }}>点击「新建设计」开始创作</p>
            </div>
            <button
              onClick={onNew}
              style={{
                padding: "10px 28px", fontSize: 14, fontWeight: 600,
                background: "#cc785c", color: "#fff",
                border: "none", borderRadius: 10, cursor: "pointer",
                fontFamily: "inherit",
              }}
            >新建设计</button>
          </div>
        ) : (
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
            gap: 18,
          }}>
            <button
              onClick={onNew}
              style={{
                aspectRatio: "4/3",
                display: "flex", flexDirection: "column",
                alignItems: "center", justifyContent: "center", gap: 10,
                background: "#ffffff", border: "2px dashed #d4d2cc",
                borderRadius: 16, cursor: "pointer", fontFamily: "inherit",
                transition: "border-color 0.15s, box-shadow 0.15s",
                color: "#8a8a8a",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = "#cc785c"
                e.currentTarget.style.boxShadow = "0 4px 20px rgba(204,120,92,0.12)"
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = "#d4d2cc"
                e.currentTarget.style.boxShadow = "none"
              }}
            >
              <span style={{
                width: 42, height: 42, borderRadius: "50%",
                background: "#f5f4f0", border: "1px solid #d4d2cc",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 22, color: "#8a8a8a",
              }}>+</span>
              <span style={{ fontSize: 13, fontWeight: 600 }}>新建设计</span>
            </button>

            {[...sessionIndex].sort((a, b) => b.updatedAt - a.updatedAt).map((meta) => (
              <div
                key={meta.id}
                onClick={() => onOpen(meta.id)}
                onMouseEnter={() => setHoveredId(meta.id)}
                onMouseLeave={() => setHoveredId(null)}
                style={{
                  aspectRatio: "4/3",
                  position: "relative",
                  background: "#ffffff",
                  borderRadius: 16,
                  border: "1px solid #e8e6e0",
                  cursor: "pointer",
                  overflow: "hidden",
                  boxShadow: hoveredId === meta.id
                    ? "0 8px 32px rgba(0,0,0,0.12)"
                    : "0 1px 4px rgba(0,0,0,0.06)",
                  transition: "box-shadow 0.15s",
                  display: "flex", flexDirection: "column",
                }}
              >
                <div style={{
                  flex: 1, background: "#f8f7f4",
                  backgroundImage: "radial-gradient(circle, #d4d2cc 1px, transparent 1px)",
                  backgroundSize: "18px 18px",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  <span style={{ fontSize: 28, opacity: 0.25 }}>✦</span>
                </div>

                <div style={{
                  padding: "10px 14px",
                  borderTop: "1px solid #f0eee8",
                  background: "#ffffff",
                }}>
                  {meta.kind && meta.kind !== "prompt" && (
                    <div style={{ marginBottom: 6 }}>
                      <span style={{
                        display: "inline-flex",
                        alignItems: "center",
                        padding: "2px 8px",
                        borderRadius: 999,
                        fontSize: 10,
                        fontWeight: 700,
                        color: meta.kind === "import_url" ? "#7a4300" : "#1d4f91",
                        background: meta.kind === "import_url" ? "#fff2df" : "#edf4ff",
                        border: `1px solid ${meta.kind === "import_url" ? "#f0d3a6" : "#cfe0ff"}`,
                      }}>
                        {getSessionKindLabel(meta.kind)}
                      </span>
                    </div>
                  )}
                  <div style={{
                    fontSize: 13, fontWeight: 600, color: "#1a1a1a",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    marginBottom: 3,
                  }} title={meta.title}>
                    {meta.title || "无标题设计"}
                  </div>
                  <div style={{ fontSize: 11, color: "#a0a0a0" }}>
                    {fmt(meta.updatedAt)}
                  </div>
                </div>

                {hoveredId === meta.id && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setConfirmDeleteId(meta.id)
                    }}
                    title="删除"
                    style={{
                      position: "absolute", top: 10, right: 10,
                      width: 28, height: 28, borderRadius: "50%",
                      background: "rgba(255,255,255,0.92)",
                      border: "1px solid #e0ded8",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      cursor: "pointer", fontSize: 14, color: "#6a6a6a",
                      boxShadow: "0 1px 4px rgba(0,0,0,0.1)",
                    }}
                  >🗑</button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {confirmDeleteId && (
        <div
          style={{
            position: "fixed", inset: 0,
            background: "rgba(0,0,0,0.35)",
            display: "flex", alignItems: "center", justifyContent: "center",
            zIndex: 9999,
          }}
          onClick={() => setConfirmDeleteId(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#ffffff", borderRadius: 16,
              padding: "28px 32px", width: 340,
              boxShadow: "0 12px 48px rgba(0,0,0,0.18)",
              fontFamily: "'Inter', -apple-system, sans-serif",
            }}
          >
            <h3 style={{ margin: "0 0 10px", fontSize: 16, fontWeight: 600, color: "#1a1a1a" }}>删除这个设计？</h3>
            <p style={{ margin: "0 0 24px", fontSize: 13, color: "#6a6a6a", lineHeight: 1.6 }}>
              删除后无法恢复。
            </p>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                onClick={() => setConfirmDeleteId(null)}
                style={{
                  padding: "8px 20px", fontSize: 13, fontWeight: 500,
                  background: "#f5f4f0", border: "none", borderRadius: 8,
                  cursor: "pointer", fontFamily: "inherit", color: "#4a4a4a",
                }}
              >取消</button>
              <button
                onClick={() => { onDelete(confirmDeleteId); setConfirmDeleteId(null) }}
                style={{
                  padding: "8px 20px", fontSize: 13, fontWeight: 600,
                  background: "#dc2626", color: "#fff",
                  border: "none", borderRadius: 8, cursor: "pointer", fontFamily: "inherit",
                }}
              >删除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
