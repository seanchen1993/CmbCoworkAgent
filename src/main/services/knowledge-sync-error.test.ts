import { describe, expect, it } from "vitest"
import { formatKnowledgeSyncError } from "./knowledge-sync-error"

const auth = new Error(
  "remote: \u001b[31mIncorrect username or password (access token)\u001b[0m\nremote: Error Code: git023\nfatal: Authentication failed for 'https://example.test/repo/'"
)
const branch = new Error(
  "warning: Could not find remote branch master1 to clone.\nfatal: Remote branch master1 not found in upstream origin\nfatal: the remote end hung up unexpectedly\nGrpc Upload Pack error: rpc error: code = Internal"
)
const missing = new Error(
  "remote: \u001b[31m404 not found!\u001b[0m\nfatal: repository 'https://example.test/repo/' not found"
)
const denied404 = new Error(
  "Auth error: Access deined: \u001b[31m404 not found!\u001b[0m\nfatal: Could not read from remote repository.\nPlease make sure you have the correct access rights and the repository exists."
)

describe("friendly knowledge synchronization errors", () => {
  it("reports only the first authentication failure even when the fallback fails for another reason", () => {
    const error = new AggregateError([auth, branch], "知识库 HTTPS 克隆失败，SSH 兜底也失败")
    expect(formatKnowledgeSyncError(error)).toBe(
      "仓库认证失败，请检查本机 Git 凭据是否有效，并确认账号具有仓库访问权限。"
    )
  })

  it("merges both inaccessible-repository errors without assuming that a 404 proves missing permissions", () => {
    const error = new AggregateError([missing, denied404], "知识库 HTTPS 克隆失败，SSH 兜底也失败")
    expect(formatKnowledgeSyncError(error)).toBe("无法访问仓库，请确认仓库地址及访问权限。")
  })

  it.each([
    ["fatal: Authentication failed", "仓库认证失败"],
    ["remote: Error Code: git023", "仓库认证失败"],
    [branch.message, "配置的知识库分支不存在"],
    ["DevOps账号或密码不正确, 亦或是密码过期", "仓库认证失败"],
    ["fatal: could not read Username: terminal prompts disabled", "仓库认证失败"],
    ["remote: HTTP 403 Forbidden", "当前账号无权访问"],
    ["remote: Access deined", "当前账号无权访问"],
    ["git@example.test: Permission denied (publickey).", "仓库认证失败"],
    ["Host key verification failed", "仓库服务器身份校验失败"],
    ["SSL certificate problem: unable to get local issuer certificate", "证书校验失败"],
    ["Could not resolve host: example.test", "无法解析仓库"],
    ["Connection timed out", "连接仓库超时"],
    ["Failed to connect to example.test", "连接仓库失败"],
    ["RPC failed; early EOF", "连接仓库失败"],
    ["fatal: Could not read from remote repository.", "无法访问仓库"],
    ["No space left on device", "磁盘空间不足"],
    ["fatal: could not create work tree dir 'local': Permission denied", "本地知识库目录"],
    ["unknown failure with private local paths and secrets", "知识库更新失败，请稍后重试"]
  ])("converts %s to an actionable message", (text, expected) => {
    const result = formatKnowledgeSyncError(new Error(text))
    expect(result).toContain(expected)
    expect(result).not.toContain("example.test")
    expect(result).not.toContain("secrets")
  })

  it.each([
    [{ code: "ENOSPC" }, "磁盘空间不足"],
    [{ code: "EACCES" }, "本地知识库目录"],
    [{ code: "EPERM" }, "本地知识库目录"],
    [{ code: "EBUSY" }, "本地知识库目录"],
    [{ code: "ENOENT", syscall: "spawn git" }, "未找到 Git"],
    [{ killed: true, signal: "SIGTERM" }, "连接仓库超时"],
    [{ code: "ETIMEDOUT" }, "连接仓库超时"],
    [{ code: "ECONNRESET" }, "连接仓库失败"],
    [{ code: "ENOTFOUND" }, "无法解析仓库"],
    [
      { code: 2, cmd: "git ls-remote --exit-code --heads -- url refs/heads/main" },
      "配置的知识库分支不存在"
    ]
  ])("uses process error metadata: %j", (details, expected) => {
    expect(formatKnowledgeSyncError(Object.assign(new Error("Command failed"), details))).toContain(
      expected
    )
  })

  it("classifies stderr instead of a generic process failure", () => {
    expect(
      formatKnowledgeSyncError(Object.assign(new Error("Command failed"), { stderr: auth.message }))
    ).toContain("仓库认证失败")
  })

  it("uses the first error for nested aggregate failures", () => {
    expect(
      formatKnowledgeSyncError(
        new AggregateError([new AggregateError([auth, branch])], "replace failed at /private/path")
      )
    ).toBe("仓库认证失败，请检查本机 Git 凭据是否有效，并确认账号具有仓库访问权限。")
  })
})
