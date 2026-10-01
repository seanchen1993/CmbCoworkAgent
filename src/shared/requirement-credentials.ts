/** Deliberately no raw-credential read API. References are identifiers, not capabilities. */
export type RequirementSecurityCode =
  | "UNTRUSTED_CALLER"
  | "INVALID_INPUT"
  | "STORAGE_UNAVAILABLE"
  | "STORAGE_FAILURE"
  | "CORRUPT_CREDENTIAL"
  | "MIGRATION_FAILED"
  | "CREDENTIAL_MISSING"
  | "CREDENTIAL_INVALID"
  | "UNKNOWN_CREDENTIAL"
  | "GATEWAY_UNAVAILABLE"
  | "NETWORK_FAILURE"
  | "TIMEOUT"
  | "UPSTREAM_FAILURE"
  | "INVALID_RESPONSE"
  | "RESPONSE_TOO_LARGE"
  | "SECRET_ECHO"
  | "CAPABILITY_UNAVAILABLE"
  | "REQUIREMENT_UNAVAILABLE"
  | "PRD_UNAVAILABLE"
  | "AUTHORIZATION_EXPIRED"
  | "AUTHORIZATION_INVALID"
  | "INPUT_CHANGED"
  | "COMMAND_CONFLICT"
  | "OUTCOME_UNKNOWN"
  | "PUBLISH_REJECTED"

export type RequirementFailure = {
  success: false
  code: RequirementSecurityCode
  error: string
}
export type RequirementResult<T> = ({ success: true } & T) | RequirementFailure
export type RequirementCredentialStatus = RequirementResult<{
  configured: boolean
  available: boolean
  credentialRef: string | null
}>
export type LeanstarQuery =
  | { operation: "listDigitalProducts" }
  | { operation: "listProductRequirements"; domainId: string; domainType: string }
  | { operation: "getImplementationDetail"; code: string }
  | { operation: "getRequirementDetail"; code: string }
  | { operation: "getRequirementDocumentContent"; code: string }
  | { operation: "getNamespaceTree" }

export type PrepareRequirementPublish = { reqId: string; threadId: string }
export type PreparedRequirementPublish = {
  requestId: string
  credentialRef: string
  inputDigest: string
  reqId: string
  threadId: string
  expiresAt: number
}
export type ConfirmRequirementPublish = PreparedRequirementPublish & { commandId: string }
export type RequirementPublishResult = RequirementResult<{ published: true }>

export const REQUIREMENT_SECURITY_MESSAGES: Record<RequirementSecurityCode, string> = {
  UNTRUSTED_CALLER: "此调用来源不受信任",
  INVALID_INPUT: "请求参数无效",
  STORAGE_UNAVAILABLE: "系统安全凭据存储不可用",
  STORAGE_FAILURE: "无法保存系统安全凭据",
  CORRUPT_CREDENTIAL: "安全凭据无法读取，请重新配置",
  MIGRATION_FAILED: "旧凭据迁移失败，已保留原副本且禁止使用",
  CREDENTIAL_MISSING: "请先配置需求凭据",
  CREDENTIAL_INVALID: "凭据已被上游拒绝，请更新",
  UNKNOWN_CREDENTIAL: "凭据引用无效，请重新确认",
  GATEWAY_UNAVAILABLE: "未配置有效的 HTTPS 需求网关",
  NETWORK_FAILURE: "需求网关连接失败",
  TIMEOUT: "需求网关请求超时",
  UPSTREAM_FAILURE: "需求网关请求失败",
  INVALID_RESPONSE: "需求网关响应格式无效",
  RESPONSE_TOO_LARGE: "需求网关响应超过限制",
  SECRET_ECHO: "响应包含敏感凭据，已阻止返回",
  CAPABILITY_UNAVAILABLE: "发布连接器尚未配置，无法发布",
  REQUIREMENT_UNAVAILABLE: "需求不存在或会话未关联",
  PRD_UNAVAILABLE: "正式 PRD 不可用或文件路径不安全",
  AUTHORIZATION_EXPIRED: "发布批准已过期，请重新确认",
  AUTHORIZATION_INVALID: "发布批准无效，请重新确认",
  INPUT_CHANGED: "PRD 或需求输入已变化，请重新确认",
  COMMAND_CONFLICT: "命令编号已用于另一发布请求",
  OUTCOME_UNKNOWN: "发布结果未知，禁止自动重试，请人工核对",
  PUBLISH_REJECTED: "发布请求被连接器明确拒绝"
}

export function requirementFailure(code: RequirementSecurityCode): RequirementFailure {
  return { success: false, code, error: REQUIREMENT_SECURITY_MESSAGES[code] }
}
