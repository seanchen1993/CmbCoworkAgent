import { useCallback, useEffect, useState, useRef } from "react"
import { Cpu, FolderOpen, Plus, Trash2, Pencil, Radio, Copy, Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import type { ChatXConfig, ChatXRobotConfig } from "@/types"

const selectClass =
  "w-full h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"

const IPV4_RE = /^((25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(25[0-5]|2[0-4]\d|[01]?\d\d?)$/

function emptyRobot(): ChatXRobotConfig {
  return {
    chatId: "",
    httpUrl: "",
    fromId: "",
    clientId: "",
    clientSecret: "",
    channel: "",
    toUserList: [],
    modelId: null,
    workDir: null
  }
}

// ── Robot Edit Dialog ────────────────────────────────────────────────────────

function RobotEditDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (robot: ChatXRobotConfig) => void
  editRobot: ChatXRobotConfig | null
  models: Array<{ id: string; name: string }>
  existingChatIds: string[]
}): React.JSX.Element {
  const { open, onOpenChange, onSave, editRobot, models, existingChatIds } = props
  const isEditing = !!editRobot
  const [form, setForm] = useState<ChatXRobotConfig>(emptyRobot())
  const [toUserListStr, setToUserListStr] = useState("")
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      const r = editRobot || emptyRobot()
      setForm(r)
      setToUserListStr(r.toUserList.join(", "))
      setError(null)
    }
  }, [open, editRobot])

  const update = (field: keyof ChatXRobotConfig, value: unknown): void => {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  const handleSelectWorkDir = async (): Promise<void> => {
    const result = await window.api.workspace.select()
    if (result) update("workDir", result)
  }

  const handleSubmit = (): void => {
    if (!form.chatId.trim()) {
      setError("会话 ID 不能为空")
      return
    }
    if (!isEditing && existingChatIds.includes(form.chatId.trim())) {
      setError("会话 ID 已存在，不能重复")
      return
    }
    if (!form.fromId.trim()) {
      setError("fromId 不能为空")
      return
    }
    if (!form.clientId.trim()) {
      setError("clientId 不能为空")
      return
    }
    if (!form.clientSecret.trim()) {
      setError("clientSecret 不能为空")
      return
    }
    if (!form.workDir) {
      setError("请选择工作目录")
      return
    }

    const users = toUserListStr
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (users.length === 0) {
      setError("toUserList 不能为空")
      return
    }

    setError(null)
    onSave({ ...form, toUserList: users })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editRobot ? "编辑机器人" : "添加机器人"}</DialogTitle>
          <DialogDescription>配置机器人的认证与工作参数。</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-sm font-medium">会话 ID</label>
            <Input
              value={form.chatId}
              onChange={(e) => update("chatId", e.target.value)}
              placeholder="机器人会话ID"
              className={cn("h-9", isEditing && "opacity-60 cursor-not-allowed")}
              readOnly={isEditing}
            />
            {isEditing && (
              <p className="text-[10px] text-muted-foreground">会话 ID 创建后不可修改</p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">fromId</label>
              <Input
                value={form.fromId}
                onChange={(e) => update("fromId", e.target.value)}
                className="h-9"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">clientId</label>
              <Input
                value={form.clientId}
                onChange={(e) => update("clientId", e.target.value)}
                className="h-9"
              />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">clientSecret</label>
            <Input
              value={form.clientSecret}
              onChange={(e) => update("clientSecret", e.target.value)}
              type="password"
              className="h-9"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">toUserList（逗号分隔）</label>
            <Input
              value={toUserListStr}
              onChange={(e) => setToUserListStr(e.target.value)}
              placeholder="user1, user2"
              className="h-9"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">模型</label>
            <select
              className={selectClass}
              value={form.modelId || ""}
              onChange={(e) => update("modelId", e.target.value || null)}
            >
              <option value="">默认模型</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">工作目录</label>
            <div className="flex gap-2">
              <Input
                value={form.workDir || ""}
                readOnly
                placeholder="请选择工作目录"
                className="flex-1 h-9"
              />
              <Button variant="outline" size="sm" onClick={handleSelectWorkDir}>
                <FolderOpen className="size-4 mr-1" />
                选择
              </Button>
            </div>
          </div>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleSubmit}>{editRobot ? "保存" : "添加"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Robot Detail View ────────────────────────────────────────────────────────

function CallbackUrlBuilder(props: { chatIds: string[]; userIp: string }): React.JSX.Element {
  const { chatIds, userIp } = props
  const [selectedChatId, setSelectedChatId] = useState("")
  const [copied, setCopied] = useState(false)

  const callbackBase = (import.meta.env.VITE_CHATX_CALLBACK_URL as string) || ""
  const ip = userIp

  const chatId = (selectedChatId && chatIds.includes(selectedChatId))
    ? selectedChatId
    : chatIds[0] || ""
  const callbackUrl = callbackBase && ip && chatId
    ? `${callbackBase}?ip=${encodeURIComponent(ip)}&chatId=${encodeURIComponent(chatId)}`
    : ""

  const handleCopy = (): void => {
    if (!callbackUrl) return
    navigator.clipboard.writeText(callbackUrl).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => {})
  }

  return (
    <div className="rounded-xl border border-border/60 bg-muted/30 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-foreground/70">回调地址</p>
        {chatIds.length > 1 && (
          <select
            className="h-7 rounded-md border border-input bg-transparent px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={chatId}
            onChange={(e) => setSelectedChatId(e.target.value)}
          >
            {chatIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        )}
      </div>
      <p className="text-[12px] text-muted-foreground">
        将以下地址配置到机器人后台，远端消息将转发到本机处理
      </p>
      {callbackUrl ? (
        <div className="flex items-start gap-2 rounded-lg bg-background/80 border border-border/40 p-2.5">
          <code className="flex-1 text-[12px] break-all select-all text-foreground/80 leading-relaxed">
            {callbackUrl}
          </code>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 shrink-0 text-xs gap-1"
            onClick={handleCopy}
          >
            {copied ? (
              <>
                <Check className="size-3 text-green-500" />
                已复制
              </>
            ) : (
              <>
                <Copy className="size-3" />
                复制
              </>
            )}
          </Button>
        </div>
      ) : (
        <div className="rounded-lg bg-background/80 border border-border/40 p-2.5">
          <p className="text-[12px] text-muted-foreground">
            {!callbackBase
              ? "回调地址未配置，请联系管理员"
              : !ip
                ? "请先开启服务以获取 IP"
                : "请先添加机器人"}
          </p>
        </div>
      )}
    </div>
  )
}

function RobotDetail(props: {
  robot: ChatXRobotConfig | null
  models: Array<{ id: string; name: string }>
  chatIds: string[]
  userIp: string
  onEdit: () => void
  onDelete: () => void
}): React.JSX.Element {
  const { robot, models, chatIds, userIp, onEdit, onDelete } = props

  if (!robot) {
    return (
      <div className="flex-1 flex items-center justify-center overflow-y-auto p-8">
        <div className="max-w-md space-y-6">
          <div className="text-center space-y-3">
            <div className="size-14 rounded-2xl bg-muted/60 flex items-center justify-center mx-auto">
              <Radio className="size-7 text-muted-foreground/60" />
            </div>
            <h3 className="text-lg font-semibold text-foreground/80">机器人管理</h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              接收远端消息并自动调用 AI
              处理后回复。支持配置多个独立的机器人，每个机器人拥有独立的会话、模型和工作目录。
            </p>
          </div>

          <div className="space-y-3">
            <div className="rounded-xl border border-border/60 bg-muted/30 p-4 space-y-3">
              <p className="text-sm font-medium text-foreground/70">快速开始</p>
              <ul className="text-[13px] text-muted-foreground space-y-2 leading-relaxed">
                <li className="flex gap-2">
                  <span className="text-foreground/40 shrink-0">1.</span>点击{" "}
                  <span className="font-medium text-foreground/60">+</span>{" "}
                  添加机器人，配置认证信息与工作目录
                </li>
                <li className="flex gap-2">
                  <span className="text-foreground/40 shrink-0">2.</span>开启服务，确认 IP
                  后自动连接
                </li>
                <li className="flex gap-2">
                  <span className="text-foreground/40 shrink-0">3.</span>
                  复制下方回调地址，配置到机器人后台
                </li>
                <li className="flex gap-2">
                  <span className="text-foreground/40 shrink-0">4.</span>收到远端消息后 AI
                  自动处理并回复
                </li>
              </ul>
            </div>

            <CallbackUrlBuilder chatIds={chatIds} userIp={userIp} />

            <div className="rounded-xl border border-border/60 bg-muted/30 p-4 space-y-3">
              <p className="text-sm font-medium text-foreground/70">适用场景</p>
              <p className="text-[13px] text-muted-foreground leading-relaxed">
                企业微信、飞书、钉钉等即时通讯平台的消息自动回复，客服机器人，远程任务执行与通知。每个机器人配置独立，互不影响。
              </p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const modelName = models.find((m) => m.id === robot.modelId)?.name || "默认模型"

  const fields: Array<{ label: string; value: string }> = [
    { label: "会话 ID", value: robot.chatId },
    { label: "fromId", value: robot.fromId },
    { label: "clientId", value: robot.clientId },
    { label: "clientSecret", value: "••••••••" },
    { label: "toUserList", value: robot.toUserList.join(", ") },
    { label: "模型", value: modelName },
    { label: "工作目录", value: robot.workDir || "未设置" }
  ]

  return (
    <div className="flex-1 overflow-auto">
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Cpu className="size-5 text-blue-400" />
            <h3 className="text-base font-semibold">{robot.chatId || "未命名机器人"}</h3>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={onEdit}>
              <Pencil className="size-4 mr-1" />
              编辑
            </Button>
            <Button variant="ghost" size="sm" onClick={onDelete}>
              <Trash2 className="size-4 mr-1 text-destructive" />
              删除
            </Button>
          </div>
        </div>

        <div className="rounded-md border border-border divide-y divide-border">
          {fields.map(({ label, value }) => (
            <div key={label} className="flex px-4 py-2.5 text-sm">
              <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
              <span className="flex-1 truncate">{value || "-"}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── IP Confirm Dialog ─────────────────────────────────────────────────────────

function IpConfirmDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (ip: string) => void
}): React.JSX.Element {
  const { open, onOpenChange, onConfirm } = props
  const [ip, setIp] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setIp("")
    setError(null)
    setLoading(true)
    window.electron.ipcRenderer
      .invoke("get-local-ip")
      .then((detectedIp: unknown) => {
        setIp(typeof detectedIp === "string" ? detectedIp : "")
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [open])

  const handleConfirm = (): void => {
    const trimmed = ip.trim()
    if (!trimmed) {
      setError("IP 不能为空")
      return
    }
    if (!IPV4_RE.test(trimmed)) {
      setError("IP 格式无效")
      return
    }
    onConfirm(trimmed)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>确认用户 IP</DialogTitle>
          <DialogDescription>
            启用前请确认本机 IP 地址，系统已自动检测，如不正确可手动修改。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Input
            value={ip}
            onChange={(e) => {
              setError(null)
              setIp(e.target.value)
            }}
            placeholder={loading ? "正在检测..." : "192.168.1.100"}
            disabled={loading}
            className={cn(
              "h-9 text-sm",
              error && "border-destructive focus-visible:ring-destructive"
            )}
          />
          {error && <p className="text-[11px] text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleConfirm} disabled={loading}>
            确认启用
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Main Panel ───────────────────────────────────────────────────────────────

type ChatXStatus = "disconnected" | "connecting" | "connected" | "reconnecting"

const statusLabel: Record<ChatXStatus, string> = {
  disconnected: "未连接",
  connecting: "连接中",
  connected: "已连接",
  reconnecting: "重连中"
}

const statusColor: Record<ChatXStatus, string> = {
  disconnected: "bg-muted-foreground/40",
  connecting: "bg-yellow-500",
  connected: "bg-green-500",
  reconnecting: "bg-yellow-500"
}

export function ChatXPanel(): React.JSX.Element {
  const [config, setConfig] = useState<ChatXConfig | null>(null)
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([])
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editIndex, setEditIndex] = useState<number | null>(null)
  const [ipConfirmOpen, setIpConfirmOpen] = useState(false)
  const [wsStatus, setWsStatus] = useState<ChatXStatus>("disconnected")
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    const { ipcRenderer } = window.electron
    const validStatuses = new Set<string>(["disconnected", "connecting", "connected", "reconnecting"])
    const removeListener = ipcRenderer.on("chatx:status", (status: unknown) => {
      if (mountedRef.current && typeof status === "string" && validStatuses.has(status)) {
        setWsStatus(status as ChatXStatus)
      }
    })
    // 挂载时主动查询一次当前状态
    ipcRenderer.invoke("chatx:get-status").then((status: unknown) => {
      if (mountedRef.current && typeof status === "string" && validStatuses.has(status)) {
        setWsStatus(status as ChatXStatus)
      }
    }).catch(() => {})
    return () => {
      mountedRef.current = false
      removeListener()
    }
  }, [])

  const loadAll = useCallback(async () => {
    try {
      const [cfg, modelConfigs] = await Promise.all([
        window.api.chatx.getConfig(),
        window.api.models.list()
      ])
      if (!mountedRef.current) return
      setConfig(cfg)
      setModels(modelConfigs.map((c) => ({ id: c.id, name: c.name })))
    } catch (e) {
      console.error("[ChatXPanel] load error:", e)
    }
  }, [])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  const saveConfig = useCallback(async (updates: Partial<ChatXConfig>) => {
    try {
      await window.api.chatx.saveConfig(updates)
    } catch (e) {
      console.error("[ChatXPanel] saveConfig error:", e)
    }
  }, [])

  const handleToggleEnabled = useCallback(async (enabled: boolean) => {
    if (!enabled && config?.enabled) {
      if (!window.confirm("禁用后将断开连接并中止所有运行中的机器人对话，确定禁用吗？")) {
        return
      }
      setConfig((prev) => prev ? { ...prev, enabled: false } : prev)
      setWsStatus("disconnected")
      await saveConfig({ enabled: false })
      try { await window.api.chatx.restart() } catch { /* ignore */ }
      return
    }
    if (enabled && config) {
      if (!import.meta.env.VITE_CHATX_WS_URL && !config.wsUrl?.trim()) {
        alert("服务地址未配置，请联系管理员检查配置")
        return
      }
      if (config.robots.length === 0) {
        alert("请先添加至少一个机器人")
        return
      }
      for (let i = 0; i < config.robots.length; i++) {
        const r = config.robots[i]
        if (!r.chatId || !r.fromId || !r.clientId || !r.clientSecret || !r.workDir || r.toUserList.length === 0) {
          alert(`机器人 ${i + 1}（${r.chatId || "未命名"}）配置不完整，请先补全所有字段`)
          return
        }
      }
      // 弹出 IP 确认弹窗
      setIpConfirmOpen(true)
    }
  }, [saveConfig, config])

  const handleIpConfirmed = useCallback(async (ip: string) => {
    setIpConfirmOpen(false)
    setConfig((prev) => prev ? { ...prev, userIp: ip, enabled: true } : prev)
    await saveConfig({ userIp: ip, enabled: true })
    try { await window.api.chatx.restart() } catch { /* ignore */ }
  }, [saveConfig])

  const handleAddRobot = useCallback(() => {
    setEditIndex(null)
    setDialogOpen(true)
  }, [])

  const handleEditRobot = useCallback(() => {
    if (selectedIndex !== null) {
      setEditIndex(selectedIndex)
      setDialogOpen(true)
    }
  }, [selectedIndex])

  const handleSaveRobot = useCallback(async (robot: ChatXRobotConfig) => {
    if (!config) return
    const robots = [...config.robots]
    if (editIndex !== null) {
      robots[editIndex] = robot
    } else {
      robots.push(robot)
      setSelectedIndex(robots.length - 1)
    }
    setConfig((prev) => prev ? { ...prev, robots } : prev)
    await saveConfig({ robots })
  }, [editIndex, saveConfig, config])

  const handleDeleteRobot = useCallback(async () => {
    if (selectedIndex === null || !config) return
    const robot = config.robots[selectedIndex]
    if (!robot) return

    const isLast = config.robots.length === 1
    const msg = config.enabled && isLast
      ? `确定删除机器人「${robot.chatId || "未命名"}」吗？\n\n这是最后一个机器人，删除后服务将自动关闭。`
      : config.enabled
        ? `确定删除机器人「${robot.chatId || "未命名"}」吗？\n\n该机器人当前处于启用状态，删除后将无法接收对应会话的消息。`
        : `确定删除机器人「${robot.chatId || "未命名"}」吗？`

    if (!window.confirm(msg)) return

    const robots = config.robots.filter((_, i) => i !== selectedIndex)
    setSelectedIndex(robots.length > 0 ? Math.min(selectedIndex, robots.length - 1) : null)
    if (robots.length === 0 && config.enabled) {
      setConfig((prev) => (prev ? { ...prev, robots, enabled: false } : prev))
      setWsStatus("disconnected")
      await saveConfig({ robots, enabled: false })
      try {
        await window.api.chatx.restart()
      } catch {
        /* ignore */
      }
    } else {
      setConfig((prev) => (prev ? { ...prev, robots } : prev))
      await saveConfig({ robots })
    }
  }, [selectedIndex, saveConfig, config])

  if (!config) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        加载中...
      </div>
    )
  }

  const selectedRobot = selectedIndex !== null ? (config.robots[selectedIndex] ?? null) : null

  return (
    <>
      {/* Left: list + global settings */}
      <div className="w-[330px] shrink-0 border-r border-border flex flex-col">
        <div className="p-3 border-b border-border space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold">机器人管理</h2>
              {config.enabled && (
                <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      statusColor[wsStatus],
                      (wsStatus === "connecting" || wsStatus === "reconnecting") && "animate-pulse"
                    )}
                  />
                  {statusLabel[wsStatus]}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <span className="text-xs text-muted-foreground">
                  {config.enabled ? "已启用" : "已禁用"}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={config.enabled}
                  className={cn(
                    "relative inline-flex h-4 w-7 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors",
                    config.enabled ? "bg-primary" : "bg-muted-foreground/30"
                  )}
                  onClick={() => handleToggleEnabled(!config.enabled)}
                >
                  <span
                    className={cn(
                      "pointer-events-none inline-block size-3 rounded-full bg-white shadow-sm transition-transform",
                      config.enabled ? "translate-x-3" : "translate-x-0"
                    )}
                  />
                </button>
              </label>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 shrink-0"
                onClick={handleAddRobot}
              >
                <Plus className="size-4" />
              </Button>
            </div>
          </div>
        </div>

        <ScrollArea className="flex-1">
          <div className="p-2 space-y-1">
            {config.robots.length === 0 ? (
              <p className="text-xs text-muted-foreground px-1 py-2">暂无机器人，点击 + 添加</p>
            ) : (
              config.robots.map((robot, i) => (
                <button
                  key={robot.chatId || i}
                  className={cn(
                    "w-full flex items-center gap-2 px-2 py-1.5 rounded-md border border-border/70 text-left transition-colors",
                    selectedIndex === i ? "bg-muted/70" : "hover:bg-muted/50"
                  )}
                  onClick={() => setSelectedIndex(i)}
                >
                  <Cpu className="size-3.5 shrink-0 text-blue-400" />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm truncate block">
                      {robot.chatId || `机器人 ${i + 1}`}
                    </span>
                    <span className="text-[10px] text-muted-foreground truncate block">
                      {robot.fromId || "未配置"}
                    </span>
                  </div>
                </button>
              ))
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Right: detail */}
      <RobotDetail
        robot={selectedRobot}
        models={models}
        chatIds={config.robots.map((r) => r.chatId).filter(Boolean)}
        userIp={config.userIp}
        onEdit={handleEditRobot}
        onDelete={handleDeleteRobot}
      />

      {/* Dialog */}
      <RobotEditDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSave={handleSaveRobot}
        editRobot={editIndex !== null ? (config.robots[editIndex] ?? null) : null}
        models={models}
        existingChatIds={config.robots.map((r) => r.chatId)}
      />

      {/* IP Confirm Dialog */}
      <IpConfirmDialog
        open={ipConfirmOpen}
        onOpenChange={setIpConfirmOpen}
        onConfirm={handleIpConfirmed}
      />
    </>
  )
}
