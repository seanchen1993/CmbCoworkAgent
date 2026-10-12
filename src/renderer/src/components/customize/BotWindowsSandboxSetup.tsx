import { useEffect, useRef, useState } from "react"
import { Check, CircleAlert, FolderOpen, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { createBotIpcClient } from "../../../../shared/bot-ipc-result"
import {
  botWindowsNativeSetupResult,
  botWindowsNativeSetupStatus,
  type BotWindowsNativeSetupAPI,
  type BotWindowsNativeSetupStatus
} from "../../../../shared/bot-windows-native-setup"
import { botErrorNotice } from "@/lib/bot-error-notice"
import {
  discardCorruptWindowsSetupPending,
  forgetWindowsSetupPending,
  readWindowsSetupPending,
  rememberWindowsSetupPending
} from "@/lib/bot-windows-setup-pending"
import type { BotShellResourcesAPI } from "../../../../shared/bot-shell-resources"
const api = createBotIpcClient<BotWindowsNativeSetupAPI>(() => window.api.botWindowsSandbox)
const resources = createBotIpcClient<BotShellResourcesAPI>(() => window.api.botShellResources)

export function BotWindowsSandboxSetup(): React.JSX.Element {
  const [status, setStatus] = useState<BotWindowsNativeSetupStatus | null>(null)
  const [pending, setPending] = useState(readWindowsSetupPending)
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const instance = useRef({ active: false, executing: false })
  useEffect(() => {
    const current = instance.current
    current.active = true
    let cancelled = false
    setChecking(true)
    setStatus(null)
    void api
      .status()
      .then((value) => {
        if (!cancelled) setStatus(botWindowsNativeSetupStatus.parse(value))
      })
      .catch((failure) => {
        if (!cancelled) setError(botErrorNotice(failure, "无法读取 Bot 沙箱状态").message)
      })
      .finally(() => {
        if (!cancelled) setChecking(false)
      })
    return () => {
      cancelled = true
      current.active = false
    }
  }, [reload])
  const initialize = async () => {
    const current = instance.current
    if (current.executing || checking || pending.corrupt || (!pending.request && !status?.scope))
      return
    current.executing = true
    setBusy(true)
    setError(null)
    const request = pending.request ?? { nonce: crypto.randomUUID(), scope: status!.scope! }
    try {
      rememberWindowsSetupPending(request)
      setPending(readWindowsSetupPending())
      const result = botWindowsNativeSetupResult.parse(await api.initialize(request))
      if (
        result.nonce !== request.nonce ||
        (result.status.scope && result.status.scope !== request.scope && !result.definitive)
      )
        throw new Error("初始化回执与本次请求不一致")
      if (result.definitive) forgetWindowsSetupPending(request)
      if (current.active) {
        setStatus(result.status)
        setPending(readWindowsSetupPending())
        if (result.definitive) setReload((value) => value + 1)
      }
    } catch (failure) {
      if (current.active) {
        setError(botErrorNotice(failure, "初始化结果待确认；可核对原请求").message)
        setPending(readWindowsSetupPending())
      }
    } finally {
      current.executing = false
      if (current.active) setBusy(false)
    }
  }
  const reveal = async () => {
    try {
      await resources.revealDiagnostics()
    } catch (failure) {
      if (instance.current.active) setError(botErrorNotice(failure, "无法打开命令现场").message)
    }
  }
  const initialized = status?.state === "initialized"
  return (
    <section
      className="flex max-w-2xl flex-col gap-4 rounded-2xl border border-border/70 bg-muted/20 p-5"
      aria-labelledby="bot-windows-sandbox-title"
    >
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-background">
          <ShieldCheck className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="bot-windows-sandbox-title" className="text-sm font-semibold">
            Bot 命令隔离环境
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            使用独立的 Windows 原生沙箱运行 Bot 命令，并核验文件权限和进程关闭状态。
          </p>
        </div>
        {initialized && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <Check className="size-3.5" />
            已初始化
          </span>
        )}
      </div>
      <p className="text-xs leading-5 text-muted-foreground" role="status">
        {busy
          ? "正在初始化。请在系统管理员提示中确认，完成前不要关闭应用。"
          : (status?.message ?? "正在检查初始化状态…")}
      </p>
      {(error || pending.corrupt || pending.request) && (
        <div className="flex items-start gap-2 rounded-xl border border-border/70 bg-background/70 p-3 text-xs leading-5">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <span>
            {error ??
              (pending.corrupt
                ? "本机初始化请求记录损坏，请先查看命令现场。清除记录不会确认命令已经停止。"
                : "保留了上次初始化请求。核对操作沿用原请求，不会重复已执行的初始化。")}
          </span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {(pending.request || status?.state === "setup_available") && (
          <Button
            size="sm"
            className="rounded-lg"
            disabled={busy || checking || pending.corrupt || !status}
            onClick={() => void initialize()}
          >
            {busy ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <ShieldCheck className="size-3.5" />
            )}
            {pending.request ? "核对本次初始化" : "管理员初始化"}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className="rounded-lg text-foreground transition-[background-color,border-color,opacity,box-shadow]"
          disabled={busy || checking}
          onClick={() => {
            setError(null)
            setReload((value) => value + 1)
          }}
        >
          <RefreshCw className="size-3.5" />
          重新检查
        </Button>
        {(pending.request || pending.corrupt || status?.state === "requires_review") && (
          <Button
            size="sm"
            variant="ghost"
            className="rounded-lg text-foreground transition-[background-color,border-color,opacity,box-shadow]"
            onClick={() => void reveal()}
          >
            <FolderOpen className="size-3.5" />
            查看命令现场
          </Button>
        )}
        {pending.corrupt && !busy && !checking && (
          <Button
            size="sm"
            variant="ghost"
            className="rounded-lg text-foreground transition-[background-color,border-color,opacity,box-shadow]"
            onClick={() => {
              try {
                discardCorruptWindowsSetupPending()
                setPending(readWindowsSetupPending())
                setReload((value) => value + 1)
              } catch (failure) {
                setError(botErrorNotice(failure, "无法清除损坏记录").message)
              }
            }}
          >
            清除损坏记录
          </Button>
        )}
      </div>
    </section>
  )
}
