import type { BotHostStatus } from "../../../shared/bot-api"
import type { BotComputerStatus } from "../../../shared/bot-computer"

const label = (value: string | undefined) =>
  value && /^[a-z\d._+-]{1,128}$/i.test(value) ? value : "未获取"
const platforms: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" }
const platform = (value: string | undefined) => platforms[value ?? ""] ?? "未获取"
const computerStates: Record<BotComputerStatus["state"], string> = {
  stopped: "尚未启动",
  starting: "正在启动",
  ready: "已就绪",
  stopping: "正在关闭",
  failed: "启动失败或连接已断开"
}

/** Explicit projection: never serialize a Host snapshot, source URL, raw error,
 * system environment, project path or task into a shareable diagnostic report. */
export function botDiagnosticInfo(input: {
  version?: string
  channel?: string | null
  platform?: string
  versions?: { electron?: string; chrome?: string; node?: string }
  host: BotHostStatus | null
  disconnected: boolean
}) {
  return {
    应用: "CMBDevClaw Bot",
    应用版本: label(input.version),
    发布通道:
      input.channel === "production" ? "正式" : input.channel === "selftest" ? "自测" : "未获取",
    桌面系统: platform(input.platform),
    Electron: label(input.versions?.electron),
    Chromium: label(input.versions?.chrome),
    "Node.js": label(input.versions?.node),
    后台连接: input.disconnected ? "已断开" : input.host ? "已连接" : "连接中",
    执行环境: platform(input.host?.platform),
    执行状态: input.disconnected
      ? "未确认"
      : input.host?.runtimeReady
        ? "可执行任务"
        : input.host
          ? "未就绪"
          : "未获取",
    后台构建: label(input.host?.buildId),
    通信协议: Number.isSafeInteger(input.host?.protocol) ? String(input.host!.protocol) : "未获取",
    ...(input.host?.computer
      ? {
          工作浏览器: label(input.host.computer.browser),
          浏览器版本: label(input.host.computer.version ?? undefined),
          浏览器状态: input.disconnected ? "未确认" : computerStates[input.host.computer.state],
          浏览器启动请求: label(input.host.computer.attemptId ?? undefined)
        }
      : {})
  }
}

export function botDiagnosticText(info: ReturnType<typeof botDiagnosticInfo>): string {
  return Object.entries(info)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n")
}
