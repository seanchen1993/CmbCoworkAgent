import { describe, expect, it, vi } from "vitest"
import * as iconv from "iconv-lite"
import { runHooks } from "./runner"
import { buildHookResultRecord } from "./log-record"
import type { HookConfig } from "./types"

vi.mock("../services/event-reporter", () => ({ trackEvent: vi.fn() }))
vi.mock("../storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../storage")>()),
  getHookLoggingConfig: () => ({ enabled: true, diagnostic: false })
}))

describe("command hook output encoding", () => {
  it("preserves UTF-8 protocol fields and legacy diagnostics through the log record", async () => {
    const reason = "中".repeat(1400) + "中文阻断原因：请先修复代码 ✅"
    const stdout = JSON.stringify({ decision: "block", reason })
    const stderr = "这是中文诊断日志，检查工作流节点失败，请检查配置后重试。".repeat(4)
    const stdoutBase64 = Buffer.from(stdout).toString("base64")
    const stderrBase64 = iconv
      .encode(stderr, process.platform === "win32" ? "gbk" : "utf8")
      .toString("base64")
    const script = [
      `process.stdout.write(Buffer.from('${stdoutBase64}', 'base64'))`,
      `process.stderr.write(Buffer.from('${stderrBase64}', 'base64'))`
    ].join(";")
    const hook: HookConfig = {
      id: "encoding-regression",
      event: "PreToolUse",
      type: "command",
      command: `"${process.execPath}" -e "${script}"`,
      enabled: true,
      timeout: 5_000,
      createdAt: "",
      updatedAt: ""
    }
    const onResult = vi.fn()

    const result = await runHooks([hook], "PreToolUse", {}, onResult)

    expect(result).toMatchObject({ decision: "block", reason })
    expect(onResult).toHaveBeenCalledOnce()
    const commandResult = onResult.mock.calls[0][2]
    expect(commandResult).toMatchObject({ exitCode: 0, rawStdout: stdout, stderr, reason })
    expect(buildHookResultRecord("PreToolUse", hook, commandResult)).toMatchObject({
      stdout,
      stderr,
      reason
    })
  })
})
