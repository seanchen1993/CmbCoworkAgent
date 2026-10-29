import type { FunctionPluginStatus } from "../../../../shared/mods/v2/commands"
import { Button } from "@/components/ui/button"
import { FunctionUserConfig } from "./FunctionUserConfig"

/** The same native source review is used by installed settings and the delivery handoff. */
export function FunctionPluginApproval({
  mod,
  threadId,
  workspace,
  busy,
  onApprove,
  approvalRequired,
  approveLabel = "授权以上能力",
  showConfiguration = true
}: {
  mod: FunctionPluginStatus
  threadId: string
  workspace: string
  busy: boolean
  onApprove(): void
  approvalRequired?: boolean
  approveLabel?: string
  showConfiguration?: boolean
}) {
  const needsApproval = approvalRequired ?? mod.state === "needs-approval"
  return (
    <div className="space-y-3" data-native-function-approval={mod.pluginId}>
      {needsApproval && (
        <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
          <p>
            允许此版本读取项目、添加工具与界面、调用已配置的模型（会产生实际用量）。写文件与执行命令仍需批准最终参数。
          </p>
          <p className="break-all">授权范围：{workspace}，同目录聊天共用。</p>
        </div>
      )}
      <details className="rounded-lg bg-muted/30 px-3 py-2 text-xs">
        <summary className="cursor-pointer font-medium">权限与版本详情</summary>
        <p className="pt-2 leading-relaxed text-muted-foreground">
          允许注册命令和主助手的自定义工具、读取项目文件与会话标识、保存偏好、打开交互组件、调用或拦截工具及调用已配置的模型。
          写文件和执行命令仍需批准最终参数；即时查询命令不能执行写操作。
          模型调用自定义工具时可读取项目，不能借此自动执行写操作。
          模型请求会产生实际用量，限每插件每项目每分钟 30 次及 32768 个预留输出 Token。
        </p>
        <p className="font-mono break-all">版本摘要：{mod.digest ?? "无法读取"}</p>
        {mod.error && (
          <p role="alert" className="break-words text-destructive">
            {mod.error}
          </p>
        )}
      </details>
      {needsApproval && mod.digest && mod.state !== "invalid" && (
        <Button size="sm" disabled={busy} onClick={onApprove}>
          {busy ? "正在授权…" : approveLabel}
        </Button>
      )}
      {showConfiguration && !!mod.userConfigFieldCount && (
        <FunctionUserConfig
          threadId={threadId}
          pluginId={mod.pluginId}
          expectedWorkspace={workspace}
          expectedDigest={mod.digest}
        />
      )}
    </div>
  )
}
