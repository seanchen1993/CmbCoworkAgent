import React from "react"
import { Check, ChevronDown, Key, PenLine, Plus } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { S } from "./styles"
import type { DesignApprovalDecision, DesignApprovalRequest, ModelOption } from "./types"

export function EmptyState({
  onUploadScreenshot,
  onAttachCode,
  onAttachLink,
  onImportUrl,
  onImportHtml,
  onImportPrototypeZip
}: {
  onUploadScreenshot: () => void
  onAttachCode: () => void
  onAttachLink: () => void
  onImportUrl: () => void
  onImportHtml: () => void
  onImportPrototypeZip: () => void
}) {
  return (
    <div style={S.emptyState}>
      <h2 style={S.emptyTitle}>从上下文开始</h2>
      <p style={S.emptySubtitle}>可以先导入现有页面，也可以仅附加参考上下文后重新生成。</p>
      <div style={S.contextCards}>
        <ContextCard icon="🌐" label="通过链接还原页面" onClick={onImportUrl} />
        <ContextCard icon="📄" label="导入 HTML 文件" onClick={onImportHtml} />
        <ContextCard icon="📦" label="上传原型图压缩包" onClick={onImportPrototypeZip} />
        <ContextCard icon="🖼️" label="上传截图" onClick={onUploadScreenshot} />
        <ContextCard icon="🗂️" label="关联代码" onClick={onAttachCode} />
        <ContextCard icon="🔗" label="通过链接关联设计图" onClick={onAttachLink} />
      </div>
    </div>
  )
}

export function DesignApprovalBar({
  approval,
  onDecision
}: {
  approval: DesignApprovalRequest
  onDecision: (decision: DesignApprovalDecision) => void
}) {
  const operation = approval.operation || approval.tool_call?.name || "execute"
  const isFileApproval = operation === "write_file" || operation === "edit_file"
  const isCodeApproval =
    operation === "code_exec" ||
    operation === "prepare_save_code_exec_tool" ||
    operation === "save_code_exec_tool"
  const approvalTypes = approval._approvalTypes ?? [
    "approve",
    "approve_session",
    "approve_permanent",
    "reject"
  ]
  const args = approval.tool_call?.args ?? {}
  const detail = isFileApproval
    ? `${operation === "write_file" ? "写入" : "编辑"}: ${String(approval.filePath || args.filePath || "unknown")}`
    : approval.command
      ? approval.command
      : isCodeApproval
        ? String(approval.code || args.code || "")
        : String(args.command || "unknown command")

  return (
    <div
      style={{
        margin: "10px 12px 0",
        padding: 12,
        borderRadius: 10,
        border: `1px solid ${isFileApproval ? "#9bbcf0" : isCodeApproval ? "#9fd3b2" : "#efcf8b"}`,
        background: isFileApproval ? "#f2f7ff" : isCodeApproval ? "#f0faf4" : "#fff8e8"
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 14 }}>{isFileApproval ? "✎" : isCodeApproval ? "{}" : "!"}</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: "#1f2933" }}>
          {operation === "write_file"
            ? "写入文件需要审批"
            : operation === "edit_file"
              ? "编辑文件需要审批"
              : isCodeApproval
                ? "执行脚本需要审批"
                : "命令需要审批"}
        </span>
      </div>
      <pre
        style={{
          margin: 0,
          maxHeight: 120,
          overflow: "auto",
          padding: "8px 10px",
          borderRadius: 8,
          background: "rgba(255,255,255,0.72)",
          color: "#2f3437",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 12,
          lineHeight: 1.45,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word"
        }}
      >
        {detail}
      </pre>
      {(approval.reason || approval._retryReason) && (
        <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.45, color: "#6a5a2a" }}>
          {approval._retryReason || approval.reason}
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
        {approvalTypes.includes("approve") && (
          <button onClick={() => onDecision("approve")} style={{ ...S.approvalPrimaryBtn }}>
            {isFileApproval ? "允许" : isCodeApproval ? "执行" : "运行"}
          </button>
        )}
        {approvalTypes.includes("approve_session") && (
          <button onClick={() => onDecision("approve_session")} style={{ ...S.approvalSessionBtn }}>
            本会话允许
          </button>
        )}
        {approvalTypes.includes("approve_permanent") && (
          <button
            onClick={() => onDecision("approve_permanent")}
            style={{ ...S.approvalPermanentBtn }}
          >
            始终允许
          </button>
        )}
        {approvalTypes.includes("reject") && (
          <button onClick={() => onDecision("reject")} style={{ ...S.approvalRejectBtn }}>
            拒绝
          </button>
        )}
      </div>
    </div>
  )
}

export function RightTabBtn({
  label,
  active,
  onClick,
  closable
}: {
  label: string
  active: boolean
  onClick: () => void
  closable?: boolean
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "0 14px",
        height: 44,
        fontSize: 13,
        fontWeight: active ? 600 : 400,
        color: active ? "#1a1a1a" : "#6a6a6a",
        background: active ? "#ffffff" : "transparent",
        border: "1px solid",
        borderColor: active ? "#e0ded8" : "transparent",
        borderBottom: active ? "1px solid #ffffff" : "1px solid transparent",
        borderRadius: active ? "8px 8px 0 0" : 0,
        cursor: "pointer",
        fontFamily: "inherit",
        position: "relative",
        top: 1
      }}
    >
      {!active && closable && (
        <span
          style={{ width: 6, height: 6, borderRadius: "50%", background: "#cc785c", flexShrink: 0 }}
        />
      )}
      {label}
      {closable && active && <span style={{ fontSize: 12, color: "#aaa", marginLeft: 2 }}>×</span>}
    </button>
  )
}

function ContextCard({
  icon,
  label,
  hint,
  onClick
}: {
  icon: string
  label: string
  hint?: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 16px",
        background: "#ffffff",
        border: "1px solid #e8e6e0",
        borderRadius: 24,
        cursor: "pointer",
        fontFamily: "inherit",
        fontSize: 14,
        fontWeight: 500,
        color: "#1a1a1a",
        textAlign: "left",
        width: "100%"
      }}
    >
      <span style={{ fontSize: 16 }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      {hint && (
        <span
          style={{
            width: 18,
            height: 18,
            borderRadius: "50%",
            border: "1px solid #c0beb8",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 11,
            color: "#8a8a8a",
            flexShrink: 0
          }}
        >
          ?
        </span>
      )}
    </button>
  )
}

export function ContextPill({
  icon,
  label,
  badge,
  color,
  onRemove,
  onClick
}: {
  icon: string
  label: string
  badge?: string
  color: { bg: string; border: string; text: string; dot: string }
  onRemove?: () => void
  onClick?: () => void
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        background: color.bg,
        border: `1px solid ${color.border}`,
        borderRadius: 6,
        padding: "3px 6px 3px 8px",
        cursor: onClick ? "pointer" : "default"
      }}
      onClick={onClick}
    >
      <span style={{ fontSize: 12 }}>{icon}</span>
      <span style={{ fontSize: 12, fontWeight: 600, color: color.text }}>{label}</span>
      {badge && <span style={{ fontSize: 10, color: color.text, opacity: 0.6 }}>{badge}</span>}
      {onRemove && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          style={{
            width: 14,
            height: 14,
            borderRadius: "50%",
            background: color.dot,
            border: "none",
            color: "#fff",
            fontSize: 9,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            lineHeight: 1,
            fontFamily: "inherit",
            padding: 0,
            marginLeft: 2
          }}
        >
          ×
        </button>
      )}
    </div>
  )
}

export function ModelSelector({
  models,
  selectedId,
  onChange,
  onEdit,
  onAdd
}: {
  models: ModelOption[]
  selectedId: string | null
  onChange: (id: string) => void
  onEdit: (id?: string) => void
  onAdd: () => void
}) {
  const [open, setOpen] = React.useState(false)
  const selected = models.find((model) => model.id === selectedId) ?? null
  const selectedLabel = selected
    ? selected.name || selected.model
    : selectedId
      ? "模型不可用"
      : "选择模型"

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={selectedLabel}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            background: "#f4f3ef",
            border: "1px solid #e0ded8",
            borderRadius: 8,
            padding: "4px 7px 4px 8px",
            fontSize: 12,
            fontWeight: 500,
            color: "#4a4a4a",
            cursor: "pointer",
            fontFamily: "inherit",
            outline: "none",
            maxWidth: 170
          }}
        >
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: 130
            }}
          >
            {selectedLabel}
          </span>
          <ChevronDown size={12} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-[260px] p-2">
        <div className="max-h-56 space-y-0.5 overflow-y-auto">
          {models.length > 0 ? (
            models.map((model) => {
              const active = selectedId === model.id
              const available = model.available !== false
              return (
                <button
                  key={model.id}
                  type="button"
                  onClick={() => {
                    if (!available) return
                    onChange(model.id)
                    setOpen(false)
                  }}
                  disabled={!available}
                  title={available ? model.model : "请先在模型配置中填写 API 密钥"}
                  className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs font-mono transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    active
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                  }`}
                >
                  <Key className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">
                    {model.name || model.model}
                    {!available ? "（未配置密钥）" : ""}
                  </span>
                  {active && <Check className="size-3.5 shrink-0" />}
                </button>
              )
            })
          ) : (
            <div className="px-2 py-5 text-center text-xs text-muted-foreground">尚未配置模型</div>
          )}
        </div>
        <div className="mt-2 border-t border-border pt-2">
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              onEdit(selected?.id)
            }}
            disabled={!selected}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          >
            <Key className="size-3.5" />
            编辑当前模型
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              onAdd()
            }}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          >
            <Plus className="size-3.5" />
            新增模型
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function ToolbarIcon({
  children,
  title,
  onClick
}: {
  children: React.ReactNode
  title?: string
  onClick?: () => void
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: 30,
        height: 30,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "none",
        border: "none",
        borderRadius: 6,
        cursor: "pointer",
        fontSize: 15
      }}
    >
      {children}
    </button>
  )
}

export function TweaksBtn({
  label,
  icon,
  active,
  onClick
}: {
  label: string
  icon: React.ReactNode
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        padding: "5px 10px",
        height: 30,
        fontSize: 12,
        fontWeight: 500,
        color: active ? "#1a1a1a" : "#6a6a6a",
        background: active ? "#e8e6e0" : "transparent",
        border: active ? "1px solid #c8c6c0" : "1px solid transparent",
        borderRadius: 7,
        cursor: "pointer",
        fontFamily: "inherit",
        transition: "all 0.12s ease"
      }}
    >
      {icon}
      {label}
    </button>
  )
}

export function CommentIcon({ active }: { active: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path
        d="M2 2h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H5l-3 2V3a1 1 0 0 1 1-1z"
        stroke={active ? "#f59e0b" : "#6a6a6a"}
        strokeWidth="1.5"
        fill={active ? "rgba(245,158,11,0.12)" : "none"}
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function EditIcon({ active }: { active: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path
        d="M11 2l3 3-8 8H3v-3l8-8z"
        stroke={active ? "#3b82f6" : "#6a6a6a"}
        strokeWidth="1.5"
        fill={active ? "rgba(59,130,246,0.12)" : "none"}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function DrawIcon({ active }: { active: boolean }) {
  return <PenLine size={13} strokeWidth={1.8} color={active ? "#cc785c" : "#6a6a6a"} />
}
