/**
 * ACPX Runtime — 封装 acpx SDK，提供统一的外部 Agent 调度能力。
 *
 * 支持 codex / claude / cursor / gemini / copilot 等多种编码助手，
 * 通过 ACP 协议进行会话管理和消息通信。
 */

import {
  AcpxRuntime,
  createAgentRegistry,
  createFileSessionStore,
  type AcpRuntimeOptions,
  type AcpRuntimeHandle,
  type AcpRuntimeEvent,
  type AcpRuntimeEnsureInput,
  type AcpRuntimeTurnInput
} from "acpx/runtime"
import { join } from "path"
import { homedir } from "os"
import { mkdirSync } from "fs"

// ── State directory for acpx sessions ──
const ACPX_STATE_DIR = join(homedir(), ".cmbcoworkagent", "acpx-state")

let runtimeInstance: AcpxRuntime | null = null

// 自定义 Agent 命令覆盖表。
// key = agentId, value = 启动命令。
// 内置 devagent，其余可通过 registerCustomAgents() 动态注册。
let customAgentOverrides: Record<string, string> = {
  devagent: "devagent --acp"
}

function getStateDir(): string {
  mkdirSync(ACPX_STATE_DIR, { recursive: true })
  return ACPX_STATE_DIR
}

/**
 * 注册自定义 Agent 命令。
 * 调用后需要 destroyAcpxRuntime() 使其在下次使用时生效。
 *
 * @example
 *   registerCustomAgents({
 *     "my-agent": "node /path/to/my-acp-server.js",
 *     "internal-bot": "/usr/local/bin/internal-bot acp"
 *   })
 */
export function registerCustomAgents(overrides: Record<string, string>): void {
  customAgentOverrides = { ...customAgentOverrides, ...overrides }
  // 重新初始化 runtime 以应用新注册表
  runtimeInstance = null
}

/**
 * 获取或创建全局 AcpxRuntime 实例。
 * 使用懒初始化，首次调用时创建。
 */
export function getAcpxRuntime(cwd: string): AcpxRuntime {
  if (!runtimeInstance) {
    const options: AcpRuntimeOptions = {
      cwd,
      sessionStore: createFileSessionStore({ stateDir: getStateDir() }),
      agentRegistry: createAgentRegistry({
        overrides: Object.keys(customAgentOverrides).length > 0
          ? customAgentOverrides
          : undefined
      }),
      permissionMode: "approve-all",
      timeoutMs: 300_000 // 5 minutes
    }
    runtimeInstance = new AcpxRuntime(options)
  }
  return runtimeInstance
}

/**
 * 销毁全局运行时（应用退出时调用）。
 */
export function destroyAcpxRuntime(): void {
  runtimeInstance = null
}

/**
 * 检测 acpx 运行时是否可用（是否安装了对应 Agent CLI）。
 */
export async function probeAcpxAvailability(): Promise<{
  healthy: boolean
  message: string
}> {
  try {
    const rt = getAcpxRuntime(process.cwd())
    await rt.probeAvailability()
    return { healthy: rt.isHealthy(), message: "acpx runtime is healthy" }
  } catch (err) {
    return {
      healthy: false,
      message: err instanceof Error ? err.message : String(err)
    }
  }
}

// Re-export types for convenience
export type {
  AcpRuntimeHandle,
  AcpRuntimeEvent,
  AcpRuntimeEnsureInput,
  AcpRuntimeTurnInput
}
