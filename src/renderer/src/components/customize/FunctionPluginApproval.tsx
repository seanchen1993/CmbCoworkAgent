import type { FunctionPluginStatus } from "../../../../shared/mods/v2/commands"
import { Button } from "@/components/ui/button"
import { FunctionUserConfig } from "./FunctionUserConfig"

/** The same native source review is used by installed settings and the delivery handoff. */
export function FunctionPluginApproval({
  mod,
  threadId,
  workspace,
  busy,
  onApprove
}: {
  mod: FunctionPluginStatus
  threadId: string
  workspace: string
  busy: boolean
  onApprove(): void
}) {
  return (
    <div className="space-y-3" data-native-function-approval={mod.pluginId}>
      <p className="text-xs leading-relaxed text-muted-foreground">
        可读取项目、扩展工具与界面、调用已配置的模型。模型调用产生实际用量；写文件与执行命令仍需批准最终参数。
      </p>
      <details className="rounded-lg bg-muted/30 px-3 py-2 text-xs">
        <summary className="cursor-pointer font-medium">查看完整能力与版本</summary>
        <p className="pt-2 leading-relaxed text-muted-foreground">
          允许注册命令和主助手的自定义工具、读取项目文件与会话标识、保存偏好、打开交互组件、调用或拦截工具及调用已配置的模型。
          写文件和执行命令仍需批准最终参数；即时查询命令不能执行写操作。
          模型调用自定义工具时可读取项目，不能借此自动执行写操作。
          模型请求会产生实际用量，限每插件每项目每分钟 30 次及 32768 个预留输出 Token。
        </p>
        <p className="font-mono break-all">版本摘要：{mod.digest ?? mod.error}</p>
      </details>
      {mod.state === "needs-approval" && mod.digest && (
        <Button size="sm" disabled={busy} onClick={onApprove}>
          授权以上能力
        </Button>
      )}
      {!!mod.userConfigFieldCount && (
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
