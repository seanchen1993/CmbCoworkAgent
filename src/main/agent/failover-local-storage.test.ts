import { describe, expect, it } from "vitest"
import { LOCAL_CHECKPOINT_MESSAGE_RECOVERY_ERROR } from "../checkpointer/sqljs-saver"
import { extractErrorDetail } from "./failover"

describe("checkpoint recovery error detail", () => {
  it("reports an actionable local storage error instead of unknown", () => {
    const storageError = Object.assign(
      new Error("本地会话消息索引不完整，自动恢复失败；已保存的会话消息没有被删除。"),
      { code: LOCAL_CHECKPOINT_MESSAGE_RECOVERY_ERROR }
    )
    const error = new Error("graph execution failed", { cause: storageError })

    const detail = extractErrorDetail(error)

    expect(detail.code).toBe("local_storage_error")
    expect(detail.statusLabel).toBe("本地会话存储错误")
    expect(detail.hint).toContain("重启应用")
    expect(detail.reason).toContain("自动恢复失败")
  })
})
