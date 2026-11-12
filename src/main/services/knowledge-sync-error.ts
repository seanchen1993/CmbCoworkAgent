import { stripVTControlCharacters } from "node:util"

const MESSAGES = {
  authentication: "仓库认证失败，请检查本机 Git 凭据是否有效，并确认账号具有仓库访问权限。",
  permission: "当前账号无权访问该仓库，请联系仓库管理员开通权限。",
  repository: "无法访问仓库，请确认仓库地址及访问权限。",
  branch: "配置的知识库分支不存在，请联系知识库维护人员检查分支配置。",
  timeout: "连接仓库超时，请检查网络或企业内网连接后重试。",
  network: "连接仓库失败，请检查网络或企业内网连接后重试。",
  dns: "无法解析仓库或代理地址，请检查网络、企业内网连接及代理配置。",
  disk: "本机磁盘空间不足，请释放空间后重试。",
  localAccess: "无法读写本地知识库目录，请检查目录权限或文件是否被其他程序占用。",
  unknown: "知识库更新失败，请稍后重试；持续失败时请联系维护人员。"
}

const ERROR_CODES: Record<string, string> = {
  ETIMEDOUT: MESSAGES.timeout,
  ESOCKETTIMEDOUT: MESSAGES.timeout,
  ECONNREFUSED: MESSAGES.network,
  ECONNRESET: MESSAGES.network,
  EHOSTUNREACH: MESSAGES.network,
  ENETUNREACH: MESSAGES.network,
  ENOTFOUND: MESSAGES.dns,
  EAI_AGAIN: MESSAGES.dns,
  ENOSPC: MESSAGES.disk,
  EACCES: MESSAGES.localAccess,
  EPERM: MESSAGES.localAccess,
  EBUSY: MESSAGES.localAccess
}

/** Report only the first failure, using process codes before Git's fixed error messages. */
export function formatKnowledgeSyncError(error: unknown): string {
  if (error instanceof AggregateError) return formatKnowledgeSyncError(error.errors[0])

  const details = error && typeof error === "object" ? (error as Record<string, unknown>) : {}
  const code = String(details.code ?? "")
  if (Object.hasOwn(ERROR_CODES, code)) return ERROR_CODES[code]
  const text = stripVTControlCharacters(
    typeof details.stderr === "string" && details.stderr.trim()
      ? details.stderr
      : error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : ""
  )

  // Git commonly uses exit code 128 for unrelated causes, so match specific diagnostics first.
  if (
    /remote branch .+ not found|could not find remote branch|couldn't find remote ref|远端分支不存在/i.test(
      text
    ) ||
    (code === "2" && typeof details.cmd === "string" && /ls-remote\b/.test(details.cmd))
  ) {
    return MESSAGES.branch
  }
  if (/repository[^\n]*not found|repository[^\n]*does not exist|\b404\b|仓库不存在/i.test(text)) {
    return MESSAGES.repository
  }
  if (
    /authentication failed|incorrect username or password|could not read (?:username|password)|terminal prompts disabled|invalid (?:username|password|credentials|access token)|error code:\s*git023\b|\b401\b|账号或密码不正确|密码过期/i.test(
      text
    )
  ) {
    return MESSAGES.authentication
  }
  if (
    /permission denied\s*\(publickey|no supported authentication methods|no more authentication methods/i.test(
      text
    )
  ) {
    return "仓库认证失败，请检查本机 SSH 密钥配置，并确认账号具有仓库访问权限。"
  }
  if (/no space left on device|磁盘空间不足/i.test(text)) return MESSAGES.disk
  if (
    /unable to create|cannot create|could not create work tree|unable to unlink|cannot rename|access is denied|拒绝访问/i.test(
      text
    )
  ) {
    return MESSAGES.localAccess
  }
  if (
    /\b403\b|forbidden|access (?:denied|deined)|permission denied|not allowed to (?:access|download)|权限不足|无权访问/i.test(
      text
    )
  ) {
    return MESSAGES.permission
  }
  if (/host key verification failed|remote host identification has changed/i.test(text)) {
    return "仓库服务器身份校验失败，请联系维护人员确认服务器信息和本机 SSH 配置。"
  }
  if (
    /ssl certificate|certificate verify failed|server certificate verification failed|unable to get local issuer|certificate has expired/i.test(
      text
    )
  ) {
    return "仓库服务器证书校验失败，请联系维护人员检查证书和本机信任配置。"
  }
  if (code === "ENOENT" && (details.syscall === "spawn git" || /spawn git\b/.test(text))) {
    return "未找到 Git，请确认本机已安装 Git 并可正常运行。"
  }
  if (details.killed === true || /timed? out|timeout|超时/i.test(text)) return MESSAGES.timeout
  if (/could not resolve (?:host|hostname|proxy)/i.test(text)) return MESSAGES.dns
  if (/could not read from remote repository/i.test(text)) return MESSAGES.repository
  if (
    /failed to connect|couldn't connect|connection (?:refused|reset|closed)|network is unreachable|remote end hung up|early EOF|RPC failed/i.test(
      text
    )
  ) {
    return MESSAGES.network
  }
  return MESSAGES.unknown
}
