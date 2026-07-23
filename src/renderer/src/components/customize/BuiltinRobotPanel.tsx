import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Bot,
  CheckCircle2,
  CircleAlert,
  Laptop,
  Loader2,
  PlugZap,
  RefreshCw,
  ShieldCheck,
  Unplug,
  UsersRound
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import type {
  BuiltinRobotConnectionState,
  BuiltinRobotRouteStatus,
  BuiltinRobotStatus
} from "@/types"

const CONNECTION_LABEL: Record<BuiltinRobotConnectionState, string> = {
  connecting: "连接中",
  online: "已连接",
  offline: "未连接",
  error: "连接异常"
}

const EVENT_STATUS_ITEMS = [
  { state: "queued", label: "排队", variant: "info" },
  { state: "executing", label: "执行中", variant: "info" },
  { state: "waiting_desktop", label: "等待桌面", variant: "warning" },
  { state: "completed", label: "已完成", variant: "nominal" },
  { state: "cancelled", label: "已取消", variant: "outline" },
  { state: "failed", label: "失败", variant: "critical" },
  { state: "outcome_unknown", label: "结果未知", variant: "critical" }
] as const

function formatDate(value: string | null): string {
  if (!value) return "—"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString()
}

function shortId(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`
}

function connectionBadge(
  state: BuiltinRobotConnectionState
): "nominal" | "warning" | "critical" | "info" {
  if (state === "online") return "nominal"
  if (state === "connecting") return "info"
  if (state === "error") return "critical"
  return "warning"
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function BuiltinRobotPanel(): React.JSX.Element {
  const [status, setStatus] = useState<BuiltinRobotStatus | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setStatus(await window.api.builtinRobot.getStatus())
    } catch (error) {
      toast.error(`读取统一机器人状态失败：${errorMessage(error)}`)
    }
  }, [])

  useEffect(() => {
    void load()
    return window.api.builtinRobot.onStatus(setStatus)
  }, [load])

  const perform = useCallback(
    async (key: string, operation: () => Promise<BuiltinRobotStatus>, success: string) => {
      setBusyAction(key)
      try {
        const next = await operation()
        setStatus(next)
        toast.success(success)
      } catch (error) {
        toast.error(errorMessage(error))
      } finally {
        setBusyAction(null)
      }
    },
    []
  )

  const terminalCount = useMemo(() => {
    if (!status) return 0
    return ["completed", "cancelled", "failed", "rejected", "outcome_unknown"].reduce(
      (total, state) => total + (status.eventCounts[state] ?? 0),
      0
    )
  }, [status])

  const takeover = useCallback(
    async (route: BuiltinRobotRouteStatus, mode: "normal" | "force") => {
      if (
        mode === "force" &&
        !window.confirm(
          "强制接管会撤销旧设备正在执行的许可。已产生的文件或外部副作用可能无法确认，确定继续吗？"
        )
      ) {
        return
      }
      const key = `takeover:${route.conversationKey}:${mode}`
      setBusyAction(key)
      try {
        const result = await window.api.builtinRobot.takeover({
          conversationKey: route.conversationKey,
          expectedDeviceEpoch: route.deviceEpoch,
          mode
        })
        if (!result.success) throw new Error(result.message || result.reasonCode || "接管失败")
        await load()
        toast.success("远程会话已接管；新设备已创建独立收件箱，Feature 需要重新绑定。")
      } catch (error) {
        toast.error(errorMessage(error))
      } finally {
        setBusyAction(null)
      }
    },
    [load]
  )

  if (!status) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> 正在读取统一机器人状态…
      </div>
    )
  }

  const connected = status.connectionState === "online"
  const identityMapped = status.identityState === "mapped"

  return (
    <div className="flex-1 overflow-auto">
      <div className="mx-auto max-w-3xl space-y-5 p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Bot className="size-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">内置统一机器人</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                使用企业统一身份连接招乎，无需配置机器人凭据。
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Badge variant={connectionBadge(status.connectionState)}>
              {CONNECTION_LABEL[status.connectionState]}
            </Badge>
            <Switch
              aria-label="启用内置统一机器人"
              checked={status.settings.enabled}
              disabled={busyAction !== null}
              onCheckedChange={(enabled) =>
                void perform(
                  "enabled",
                  () => window.api.builtinRobot.saveSettings({ enabled }),
                  enabled ? "统一机器人已启用" : "本设备远程连接已关闭"
                )
              }
            />
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>连接与身份</CardTitle>
            <CardDescription>机器人会话固定到设备，除非你显式接管。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-md border bg-muted/20 p-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  {identityMapped ? (
                    <ShieldCheck className="size-4 text-emerald-500" />
                  ) : (
                    <CircleAlert className="size-4 text-amber-500" />
                  )}
                  企业身份
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  {identityMapped
                    ? "已完成企业身份映射"
                    : status.identityState === "error"
                      ? "身份信息异常，请重新登录"
                      : "尚未完成企业身份映射"}
                </p>
              </div>
              <div className="rounded-md border bg-muted/20 p-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Laptop className="size-4" /> 当前设备
                </div>
                <p className="mt-2 truncate text-sm">{status.deviceName}</p>
                <p
                  className="mt-0.5 font-mono text-xs text-muted-foreground"
                  title={status.deviceId}
                >
                  {shortId(status.deviceId)}
                </p>
              </div>
            </div>

            <div className="grid gap-2 text-sm sm:grid-cols-2">
              <p className="text-muted-foreground">
                最近连接：
                <span className="text-foreground">{formatDate(status.lastConnectedAt)}</span>
              </p>
              <p className="text-muted-foreground">
                回复待处理/未知：
                <span className="text-foreground">{status.pendingOutboxCount}</span>
              </p>
            </div>
            {status.lastError && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {status.lastError}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busyAction !== null || !status.settings.enabled}
                onClick={() =>
                  void perform(
                    "reconnect",
                    window.api.builtinRobot.reconnect,
                    "正在重新连接统一机器人"
                  )
                }
              >
                <RefreshCw
                  className={cn("mr-1.5 size-4", busyAction === "reconnect" && "animate-spin")}
                />
                重连
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busyAction !== null || !connected}
                onClick={() =>
                  void perform("disconnect", window.api.builtinRobot.disconnect, "本设备已断开")
                }
              >
                <Unplug className="mr-1.5 size-4" /> 断开本设备
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>远程访问范围</CardTitle>
            <CardDescription>收件箱始终是默认聊天路径；Feature 能力按需开放。</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            {[
              {
                value: "inbox-only" as const,
                title: "仅收件箱",
                detail: "问答、总结、规划和托管目录内产物。"
              },
              {
                value: "inbox-and-features" as const,
                title: "收件箱 + Feature",
                detail: "允许在招乎中查看并绑定本机 Project Mode Feature。"
              }
            ].map((option) => {
              const selected = status.settings.remoteAccess === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  disabled={busyAction !== null}
                  className={cn(
                    "rounded-md border p-3 text-left transition-colors disabled:opacity-50",
                    selected ? "border-primary bg-primary/5" : "hover:bg-muted/40"
                  )}
                  onClick={() =>
                    void perform(
                      `access:${option.value}`,
                      () => window.api.builtinRobot.saveSettings({ remoteAccess: option.value }),
                      `远程访问已切换为“${option.title}”`
                    )
                  }
                >
                  <div className="flex items-center justify-between gap-2 text-sm font-medium">
                    {option.title}
                    {selected && <CheckCircle2 className="size-4 text-primary" />}
                  </div>
                  <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{option.detail}</p>
                </button>
              )
            })}
            {status.settings.remoteAccess === "inbox-and-features" && (
              <div className="sm:col-span-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs leading-5 text-muted-foreground">
                项目与 Feature
                名称会在你本人的招乎单聊中显示；本地路径、插件路径和工作区配置不会上传。
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UsersRound className="size-4" /> 远程会话与设备接管
            </CardTitle>
            <CardDescription>
              已处理终态事件 {terminalCount} 条；接管会创建新收件箱，历史和 Feature 绑定不会迁移。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex flex-wrap gap-2 pb-1">
              {EVENT_STATUS_ITEMS.map((item) => (
                <Badge key={item.state} variant={item.variant}>
                  {item.label} {status.eventCounts[item.state] ?? 0}
                </Badge>
              ))}
            </div>
            {status.routes.length === 0 ? (
              <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                暂无已固定的远程会话
              </p>
            ) : (
              status.routes.map((route) => (
                <div
                  key={route.conversationKey}
                  className="flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      <span title={route.conversationKey}>{shortId(route.conversationKey)}</span>
                      <Badge variant={route.ownedByCurrentDevice ? "nominal" : "warning"}>
                        {route.ownedByCurrentDevice ? "当前设备" : "其他设备"}
                      </Badge>
                      <span className="text-xs font-normal text-muted-foreground">
                        epoch {route.deviceEpoch}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {route.deviceName || "未知设备"} · {route.state}
                    </p>
                  </div>
                  {!route.ownedByCurrentDevice && (
                    <div className="flex shrink-0 gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyAction !== null || !connected}
                        onClick={() => void takeover(route, "normal")}
                      >
                        <PlugZap className="mr-1.5 size-4" /> 接管
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busyAction !== null || !connected}
                        onClick={() => void takeover(route, "force")}
                      >
                        强制接管
                      </Button>
                    </div>
                  )}
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {status.legacyConfigDetected && (
          <Card className="border-amber-500/40">
            <CardHeader>
              <CardTitle>检测到旧版机器人凭据</CardTitle>
              <CardDescription>
                新版不会读取或迁移旧配置。确认后可删除本机旧明文凭据文件。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                size="sm"
                variant="outline"
                disabled={busyAction !== null}
                onClick={() => {
                  if (!window.confirm("确定删除旧版机器人明文凭据？此操作不可撤销。")) return
                  void perform(
                    "cleanup",
                    window.api.builtinRobot.cleanupLegacy,
                    "旧版机器人凭据已删除"
                  )
                }}
              >
                清理旧凭据
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
