import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Bot,
  Bug,
  CircleAlert,
  Copy,
  FolderKanban,
  Loader2,
  MessageSquareText,
  RefreshCw,
  ShieldCheck,
  Unplug
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { isBuiltinRobotThreadRemoteAccessEligible } from "@/lib/builtin-robot-remote-access"
import { cn } from "@/lib/utils"
import type {
  BuiltinRobotConnectionState,
  BuiltinRobotGrantableFeature,
  BuiltinRobotRemoteAccessOverview,
  BuiltinRobotStatus,
  Thread
} from "@/types"

const CONNECTION_LABEL: Record<BuiltinRobotConnectionState, string> = {
  connecting: "连接中",
  online: "已连接",
  offline: "未连接",
  error: "连接异常"
}

interface BuiltinRobotDebugUserInfo {
  ystId?: string | null
}

const BUILTIN_ROBOT_DEBUG_YST_IDS = new Set(
  String(import.meta.env.VITE_BUILTIN_ROBOT_DEBUG_YST_IDS || "")
    .split(/[,;\s]+/)
    .map((id) => id.trim())
    .filter(Boolean)
)

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
  const [remoteAccess, setRemoteAccess] = useState<BuiltinRobotRemoteAccessOverview | null>(null)
  const [grantableFeatures, setGrantableFeatures] = useState<BuiltinRobotGrantableFeature[]>([])
  const [threads, setThreads] = useState<Thread[]>([])
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [gatewayUrlDraft, setGatewayUrlDraft] = useState("")
  const [canViewDebugInfo, setCanViewDebugInfo] = useState(false)
  const savedGatewayUrl = status?.settings.gatewayUrl
  const effectiveGatewayUrl = status?.diagnostics.gatewayUrl

  const load = useCallback(async () => {
    try {
      const [nextStatus, nextAccess, nextFeatures, nextThreads, userInfo] = await Promise.all([
        window.api.builtinRobot.getStatus(),
        window.api.builtinRobot.getRemoteAccess(),
        window.api.builtinRobot.listGrantableFeatures(),
        window.api.threads.list(),
        window.api.models.getUserInfo().catch(() => null)
      ])
      setStatus(nextStatus)
      setRemoteAccess(nextAccess)
      setGrantableFeatures(nextFeatures)
      setThreads(nextThreads)
      const ystId = String((userInfo as BuiltinRobotDebugUserInfo | null)?.ystId || "").trim()
      setCanViewDebugInfo(Boolean(ystId && BUILTIN_ROBOT_DEBUG_YST_IDS.has(ystId)))
    } catch (error) {
      toast.error(`读取统一机器人状态失败：${errorMessage(error)}`)
    }
  }, [])

  useEffect(() => {
    void load()
    return window.api.builtinRobot.onStatus(setStatus)
  }, [load])

  useEffect(() => {
    setGatewayUrlDraft(savedGatewayUrl ?? effectiveGatewayUrl ?? "")
  }, [savedGatewayUrl, effectiveGatewayUrl])

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

  const grantableThreads = useMemo(
    () =>
      threads
        .filter(isBuiltinRobotThreadRemoteAccessEligible)
        .sort((left, right) => right.updated_at.getTime() - left.updated_at.getTime()),
    [threads]
  )

  const performRemoteAccess = useCallback(
    async (
      key: string,
      operation: () => Promise<BuiltinRobotRemoteAccessOverview>,
      success: string
    ) => {
      setBusyAction(key)
      try {
        const next = await operation()
        setRemoteAccess(next)
        setGrantableFeatures(await window.api.builtinRobot.listGrantableFeatures())
        toast.success(success)
      } catch (error) {
        toast.error(errorMessage(error))
      } finally {
        setBusyAction(null)
      }
    },
    []
  )

  if (!status) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> 正在读取统一机器人状态…
      </div>
    )
  }

  const connected = status.connectionState === "online"
  const identityVerified = status.identityState === "verified"
  const saveGatewayUrl = (): Promise<void> =>
    perform(
      "gateway-url",
      () =>
        window.api.builtinRobot.saveSettings({
          gatewayUrl: gatewayUrlDraft.trim()
        }),
      "网关地址已保存并应用"
    )
  const copyDiagnostics = async (): Promise<void> => {
    const snapshot = {
      capturedAt: new Date().toISOString(),
      appVersion: status.diagnostics.appVersion,
      gatewayUrl: status.diagnostics.gatewayUrl,
      connectionState: status.connectionState,
      identityState: status.identityState,
      authenticationFailed: status.diagnostics.authenticationFailed,
      lastHandshakeStatus: status.diagnostics.lastHandshakeStatus,
      lastCloseCode: status.diagnostics.lastCloseCode,
      lastCloseReason: status.diagnostics.lastCloseReason,
      lastTransportError: status.diagnostics.lastTransportError,
      reconnectAttempt: status.diagnostics.reconnectAttempt,
      lastConnectedAt: status.lastConnectedAt,
      lastError: status.lastError,
      sessionId: status.sessionId ? shortId(status.sessionId) : null,
      principalId: status.principalId ? shortId(status.principalId) : null,
      routeCount: status.routes.length,
      pendingOutboxCount: status.pendingOutboxCount,
      eventCounts: status.eventCounts
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2))
      toast.success("联调信息已复制")
    } catch {
      toast.error("复制联调信息失败")
    }
  }

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
                登录后即可连接招乎，无需配置机器人凭据。
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
                  enabled ? "统一机器人已启用" : "远程连接已关闭"
                )
              }
            />
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>远程连接</CardTitle>
            <CardDescription>
              使用当前登录用户连接招乎；同一用户只保留一个活动桌面连接。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-md border bg-muted/20 p-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                {identityVerified ? (
                  <ShieldCheck className="size-4 text-emerald-500" />
                ) : (
                  <CircleAlert className="size-4 text-amber-500" />
                )}
                登录状态
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                {identityVerified
                  ? "已登录"
                  : status.identityState === "error"
                    ? "登录失效，请重新登录"
                    : status.identityState === "verifying"
                      ? "已登录，正在连接"
                      : "未登录"}
              </p>
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
                  void perform("disconnect", window.api.builtinRobot.disconnect, "远程连接已断开")
                }
              >
                <Unplug className="mr-1.5 size-4" /> 断开连接
              </Button>
            </div>
          </CardContent>
        </Card>

        {canViewDebugInfo && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Bug className="size-4" /> 联调信息
              </CardTitle>
              <CardDescription>
                用于核对 Desktop 与 Java 网关连接，不展示 Token 或消息正文。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2 rounded-md border bg-muted/20 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label htmlFor="builtin-robot-gateway-url" className="text-sm font-medium">
                    网关地址（联调）
                  </label>
                  <Badge variant="outline">
                    {status.settings.gatewayUrl
                      ? "App 配置"
                      : status.diagnostics.gatewayUrl
                        ? ".env 默认值"
                        : "未配置"}
                  </Badge>
                </div>
                <Input
                  id="builtin-robot-gateway-url"
                  spellCheck={false}
                  autoCapitalize="none"
                  autoCorrect="off"
                  className="font-mono text-xs"
                  value={gatewayUrlDraft}
                  placeholder="wss://gateway.example.com/ws/desktop"
                  disabled={busyAction !== null}
                  onChange={(event) => setGatewayUrlDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.nativeEvent.isComposing) return
                    event.preventDefault()
                    void saveGatewayUrl()
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  保存后立即重连。仅允许 WSS；本机联调可使用 ws://localhost。
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyAction !== null || !gatewayUrlDraft.trim()}
                    onClick={() => void saveGatewayUrl()}
                  >
                    {busyAction === "gateway-url" && <Loader2 className="size-4 animate-spin" />}
                    保存并重连
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busyAction !== null || status.settings.gatewayUrl === null}
                    onClick={() =>
                      void perform(
                        "gateway-url-reset",
                        () => window.api.builtinRobot.saveSettings({ gatewayUrl: null }),
                        "已恢复 .env 默认网关地址"
                      )
                    }
                  >
                    恢复默认
                  </Button>
                </div>
              </div>

              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground">实际网关地址</dt>
                  <dd className="mt-1 break-all font-mono text-xs">
                    {status.diagnostics.gatewayUrl ?? "未配置"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">握手状态</dt>
                  <dd className="mt-1 font-mono">
                    {status.diagnostics.lastHandshakeStatus ?? "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">自动重连次数</dt>
                  <dd className="mt-1 font-mono">{status.diagnostics.reconnectAttempt}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">App 版本</dt>
                  <dd className="mt-1 font-mono">{status.diagnostics.appVersion}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">最近关闭</dt>
                  <dd className="mt-1 font-mono">
                    {status.diagnostics.lastCloseCode ?? "—"}
                    {status.diagnostics.lastCloseReason
                      ? ` · ${status.diagnostics.lastCloseReason}`
                      : ""}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">网关路由数</dt>
                  <dd className="mt-1 font-mono">{status.routes.length}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Session</dt>
                  <dd className="mt-1 font-mono text-xs">
                    {status.sessionId ? shortId(status.sessionId) : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Principal</dt>
                  <dd className="mt-1 font-mono text-xs">
                    {status.principalId ? shortId(status.principalId) : "—"}
                  </dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground">最近传输错误</dt>
                  <dd className="mt-1 break-all font-mono text-xs">
                    {status.diagnostics.lastTransportError ?? "—"}
                  </dd>
                </div>
              </dl>
              <Button size="sm" variant="outline" onClick={() => void copyDiagnostics()}>
                <Copy className="size-4" /> 复制联调信息
              </Button>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>接入招乎</CardTitle>
            <CardDescription>
              已有桌面会话可逐条接入；Feature 开关只控制能否从招乎在该 Feature 下创建远程会话。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <section className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <MessageSquareText className="size-4" /> 已有桌面会话
              </div>
              {!remoteAccess?.routeAvailable && (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-muted-foreground">
                  {remoteAccess?.routeReason ?? "正在读取招乎路由…"}
                </div>
              )}
              {grantableThreads.length === 0 ? (
                <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                  暂无带有效工作区的可接入会话。普通会话和 Project Mode 会话均支持；
                  Coordinator、Workflow 和远程收件箱会话暂不开放。
                </p>
              ) : (
                <div className="max-h-64 space-y-2 overflow-auto pr-1">
                  {grantableThreads.map((thread) => {
                    const grant = remoteAccess?.threadGrants.find(
                      (candidate) => candidate.threadId === thread.thread_id
                    )
                    const enabled = grant?.state === "active"
                    const key = `thread-grant:${thread.thread_id}`
                    return (
                      <div
                        key={thread.thread_id}
                        className="flex items-center justify-between gap-3 rounded-md border p-3"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">
                            {thread.title?.trim() || `会话 ${shortId(thread.thread_id)}`}
                          </p>
                          <p className="mt-0.5 truncate text-xs text-muted-foreground">
                            {String(thread.metadata?.workspacePath ?? "")}
                          </p>
                        </div>
                        <Switch
                          aria-label={`允许招乎访问 ${thread.title ?? thread.thread_id}`}
                          checked={enabled}
                          disabled={
                            busyAction !== null || (!enabled && !remoteAccess?.routeAvailable)
                          }
                          onCheckedChange={(checked) =>
                            void performRemoteAccess(
                              key,
                              () =>
                                window.api.builtinRobot.setThreadRemoteAccess(
                                  thread.thread_id,
                                  checked
                                ),
                              checked ? "会话已接入招乎" : "会话远程授权已撤销"
                            )
                          }
                        />
                      </div>
                    )
                  })}
                </div>
              )}
            </section>

            <section className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <FolderKanban className="size-4" /> Feature 远程新建会话
              </div>
              {!remoteAccess?.principalAvailable && (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-muted-foreground">
                  {remoteAccess?.principalReason ?? "正在读取登录状态…"}
                </div>
              )}
              {grantableFeatures.length === 0 ? (
                <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                  暂无可开放远程新建会话的 Feature。
                </p>
              ) : (
                <div className="max-h-64 space-y-2 overflow-auto pr-1">
                  {grantableFeatures.map((feature) => {
                    const grant = remoteAccess?.featureGrants.find(
                      (candidate) =>
                        candidate.projectId === feature.projectId &&
                        candidate.featureSlug === feature.featureSlug
                    )
                    const enabled = grant?.state === "active"
                    const key = `feature-grant:${feature.projectId}:${feature.featureSlug}`
                    return (
                      <div
                        key={`${feature.projectId}:${feature.featureSlug}`}
                        className="flex items-center justify-between gap-3 rounded-md border p-3"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{feature.featureTitle}</p>
                          <p className="mt-0.5 truncate text-xs text-muted-foreground">
                            {feature.projectName} · {feature.featureStatus}
                          </p>
                        </div>
                        <Switch
                          aria-label={`允许从招乎在 ${feature.featureTitle} 下新建会话`}
                          checked={enabled}
                          disabled={
                            busyAction !== null || (!enabled && !remoteAccess?.principalAvailable)
                          }
                          onCheckedChange={(checked) =>
                            void performRemoteAccess(
                              key,
                              () =>
                                window.api.builtinRobot.setFeatureRemoteAccess(
                                  feature.projectId,
                                  feature.featureSlug,
                                  checked
                                ),
                              checked
                                ? "已允许从招乎在此 Feature 下新建会话"
                                : "已关闭此 Feature 的远程新建会话权限"
                            )
                          }
                        />
                      </div>
                    )
                  })}
                </div>
              )}
            </section>

            <p className="text-xs leading-5 text-muted-foreground">
              会话开关只开放这一条已有会话；Feature 开关只开放远程新建会话，两者互不继承。
              招乎只展示会话、项目与 Feature 名称；本地绝对路径、插件路径和工作区配置不会上传。
            </p>

            <div className="flex items-start justify-between gap-4 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
              <div>
                <p className="text-sm font-medium">允许从招乎批准工具调用</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  默认关闭。开启后仅支持工作区内文件写入和完整展示的命令，且每次只能批准一次； Git
                  提交、推送和永久授权仍必须回到桌面。Agent 的补充问题可直接使用招乎 `/回答`
                  指令处理，不受此开关影响。
                </p>
              </div>
              <Switch
                aria-label="允许从招乎批准工具调用"
                checked={status.settings.remoteApprovalEnabled}
                disabled={busyAction !== null}
                onCheckedChange={(enabled) =>
                  void perform(
                    "remote-approval",
                    () => window.api.builtinRobot.saveSettings({ remoteApprovalEnabled: enabled }),
                    enabled ? "招乎远程审批已开启" : "招乎远程审批已关闭"
                  )
                }
              />
            </div>
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
