export const FEATURE_GATES = {
  projectMode: "projectMode"
} as const

export type KnownFeatureGate = (typeof FEATURE_GATES)[keyof typeof FEATURE_GATES]
export type FeatureGateKey = KnownFeatureGate | (string & {})

export interface FeatureGateConfig {
  enabled?: boolean
  whitelistUsers?: string[]
  blacklistUsers?: string[]
  whitelistOrgs?: string[]
  whitelistPaths?: string[]
  rolloutPercent?: number
  rolloutSeed?: string
  includeAnonymous?: boolean
  expireAt?: string
}

export type FeatureGatesConfig = Record<string, FeatureGateConfig>

export interface FeatureGateCheckOptions {
  refresh?: boolean
}

export interface FeatureGateCheckResult {
  enabled: boolean
  reason: string
}
