/** Trusted turn policy, not an authorization grant or a filesystem sandbox. */
export interface PersonalContextPolicy {
  /** Shared tasks must not consume or maintain the desktop owner's personal memory/identity. */
  sharedTaskContext?: boolean
}

interface EmployeeIdentityFields {
  sapId?: string
  ystId?: string
  userName?: string
  originOrgId?: string
  orgName?: string
  ystCode?: string
}

export function isPersonalMemoryEnabled(policy: PersonalContextPolicy, enabled: boolean): boolean {
  return policy.sharedTaskContext !== true && enabled
}

/** Lazy read: shared tasks never read personal identity, not merely hide its rendering. */
export function buildPersonalIdentityPrompt(
  policy: PersonalContextPolicy,
  readIdentity: () => EmployeeIdentityFields | null
): string {
  if (policy.sharedTaskContext === true) return ""
  const userInfo = readIdentity()
  // Preserve the existing personal-runtime format and null behavior.
  return `## Current user's employee identity information
- sap编号、员工编号:${userInfo?.sapId}
- yst编号、一事通编号: ${userInfo?.ystId}
- userName、员工姓名: ${userInfo?.userName}
- originOrgId、员工机构号: ${userInfo?.originOrgId}
- orgName、员机构号名称: ${userInfo?.orgName}
- ystCode、一事通code: ${userInfo?.ystCode}`
}
